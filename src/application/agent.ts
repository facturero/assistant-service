import { Conversation, ContentBlock, Message, PendingAction } from '../domain/entities';
import { Repositories } from '../domain/repositories';
import {
  ActionAlreadyDecidedError,
  ActionNotFoundError,
  ConversationNotFoundError,
  UnknownToolError,
  UsageLimitReachedError,
} from '../domain/errors';
import { summarizeAction, toAnthropicTools, TOOLS_BY_NAME, ToolDefinition } from '../domain/tools';
import { CrmApiPort, LlmMessage, LlmPort } from './ports';
import { buildSystemPrompt, OrganizationContext } from './prompt';

export interface TurnContext {
  organizationId: string;
  userId: string;
  bearerToken: string;
  locale: string;
  organization: OrganizationContext;
}

export interface TurnResult {
  conversationId: string;
  /** Lo que el asistente dice, ya en texto plano. */
  reply: string;
  /** Escrituras esperando a que alguien las confirme. */
  pendingActions: Array<{ id: string; toolName: string; summary: string; input: Record<string, unknown> }>;
  /** Se llegó al tope de vueltas sin que el modelo cerrara el turno. */
  truncated: boolean;
}

export interface AgentOptions {
  /** Tope de vueltas del bucle. Un agente que no cierra en 8 pasos está perdido. */
  maxIterations: number;
  /** Tokens al mes por organización. 0 = sin límite. */
  monthlyTokenLimit: number;
}

/**
 * El bucle del agente.
 *
 * Es un bucle manual y no el ayudante del SDK por una razón concreta: aquí el
 * turno **se suspende entre peticiones HTTP**. Cuando el modelo pide una
 * escritura, se guarda la propuesta, se corta, y la conversación se reanuda
 * minutos después, cuando una persona confirma desde el navegador. Un bucle en
 * memoria no sobrevive a esa espera.
 */
export class Agent {
  constructor(
    private readonly repos: Repositories,
    private readonly llm: LlmPort,
    private readonly crm: CrmApiPort,
    private readonly options: AgentOptions,
  ) {}

  async startOrContinue(params: {
    conversationId: string | null;
    text: string;
    ctx: TurnContext;
  }): Promise<TurnResult> {
    await this.assertWithinLimit(params.ctx.organizationId);

    const conversation = params.conversationId
      ? await this.loadConversation(params.conversationId, params.ctx)
      : Conversation.create({ organizationId: params.ctx.organizationId, userId: params.ctx.userId });

    conversation.titleFrom(params.text);
    conversation.touch();
    await this.repos.conversations.save(conversation);

    await this.repos.messages.save(
      Message.create({
        conversationId: conversation.id,
        role: 'user',
        content: [{ type: 'text', text: params.text }],
      }),
    );

    return this.run(conversation, params.ctx);
  }

  /**
   * Confirma o rechaza una escritura propuesta. Cuando ya no queda ninguna
   * pendiente en ese turno, la conversación continúa sola: el modelo ve el
   * resultado y contesta ("listo, creé el rol Cajero").
   */
  async decideAction(params: {
    actionId: string;
    approve: boolean;
    ctx: TurnContext;
  }): Promise<TurnResult> {
    const action = await this.repos.actions.findById(params.actionId);
    if (!action) throw new ActionNotFoundError();

    // La propiedad se comprueba ANTES que el estado, y el orden importa: al
    // revés, una acción de otra organización contestaba "ya está decidida" en
    // vez de "no existe", y esa diferencia de respuesta ya confirma que la
    // acción existe y en qué estado está. No se lee nada ni se ejecuta nada,
    // pero es un dato de otra empresa y aquí no se regala ninguno.
    const conversation = await this.loadConversation(action.conversationId, params.ctx);

    if (!action.isPending) throw new ActionAlreadyDecidedError();

    if (!params.approve) {
      action.markRejected(params.ctx.userId);
      await this.repos.actions.save(action);
    } else {
      const tool = TOOLS_BY_NAME.get(action.toolName);
      if (!tool) throw new UnknownToolError(action.toolName);
      const response = await this.callTool(tool, action.input, params.ctx);
      if (response.ok) {
        action.markExecuted(response.body, params.ctx.userId);
      } else {
        action.markFailed(response.body, params.ctx.userId);
      }
      await this.repos.actions.save(action);
    }

    const stillPending = (await this.repos.actions.listByConversation(conversation.id)).filter(
      (a) => a.isPending,
    );
    if (stillPending.length > 0) {
      // Quedan más propuestas del mismo turno: no se puede reanudar todavía,
      // porque la API exige devolver el resultado de TODAS las herramientas que
      // pidió el modelo en una sola respuesta.
      return {
        conversationId: conversation.id,
        reply: '',
        pendingActions: stillPending.map(describe),
        truncated: false,
      };
    }

    await this.resumeAfterDecisions(conversation, params.ctx);
    return this.run(conversation, params.ctx);
  }

  /**
   * Cierra el turno suspendido: por cada herramienta que pidió el modelo se
   * arma su resultado. Las escrituras traen el que quedó guardado al confirmar o
   * rechazar; las lecturas se ejecutan ahora, que además las devuelve frescas.
   */
  private async resumeAfterDecisions(conversation: Conversation, ctx: TurnContext): Promise<void> {
    const history = await this.repos.messages.listByConversation(conversation.id);
    const last = history[history.length - 1];
    if (!last || last.role !== 'assistant') return;

    const toolUses = last.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) return;

    const decided = await this.repos.actions.listByConversation(conversation.id);
    const byToolUseId = new Map(decided.map((a) => [a.toolUseId, a]));

    const results: ContentBlock[] = [];
    for (const block of toolUses) {
      const toolUseId = String(block.id);
      const name = String(block.name);
      const input = (block.input ?? {}) as Record<string, unknown>;

      const action = byToolUseId.get(toolUseId);
      if (action) {
        results.push(resultBlock(toolUseId, actionOutcome(action)));
        continue;
      }

      const tool = TOOLS_BY_NAME.get(name);
      if (!tool) {
        results.push(resultBlock(toolUseId, { error: `La herramienta ${name} no existe.` }, true));
        continue;
      }
      const response = await this.callTool(tool, input, ctx);
      results.push(resultBlock(toolUseId, response.body, !response.ok));
    }

    await this.repos.messages.save(
      Message.create({ conversationId: conversation.id, role: 'user', content: results }),
    );
  }

  /** El bucle propiamente dicho. */
  private async run(conversation: Conversation, ctx: TurnContext): Promise<TurnResult> {
    const system = buildSystemPrompt(ctx.organization);
    const tools = toAnthropicTools();

    for (let iteration = 0; iteration < this.options.maxIterations; iteration++) {
      const history = await this.repos.messages.listByConversation(conversation.id);
      const turn = await this.llm.complete({
        system,
        messages: history.map(toLlmMessage),
        tools,
      });

      await this.repos.usage.add(ctx.organizationId, {
        inputTokens: turn.usage.inputTokens,
        outputTokens: turn.usage.outputTokens,
        requests: 1,
      });

      const assistantMessage = Message.create({
        conversationId: conversation.id,
        role: 'assistant',
        content: turn.content,
        inputTokens: turn.usage.inputTokens,
        outputTokens: turn.usage.outputTokens,
        cacheReadTokens: turn.usage.cacheReadTokens,
      });
      await this.repos.messages.save(assistantMessage);
      conversation.touch();
      await this.repos.conversations.save(conversation);

      // El modelo puede declinar una petición por política. No es un error del
      // sistema: se le cuenta al usuario tal cual y se cierra el turno.
      if (turn.stopReason === 'refusal') {
        return {
          conversationId: conversation.id,
          reply:
            assistantMessage.text ||
            'No puedo ayudarte con eso. Si crees que es un error, reformúlalo o pídeselo a alguien de tu equipo.',
          pendingActions: [],
          truncated: false,
        };
      }

      const toolUses = turn.content.filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0) {
        return {
          conversationId: conversation.id,
          reply: assistantMessage.text,
          pendingActions: [],
          truncated: false,
        };
      }

      // Si en el turno hay una sola escritura, se suspende entero: se proponen
      // las escrituras y no se ejecuta nada más hasta que haya decisión humana.
      const writes = toolUses.filter((b) => TOOLS_BY_NAME.get(String(b.name))?.risk === 'write');
      if (writes.length > 0) {
        const proposed: PendingAction[] = [];
        for (const block of writes) {
          const tool = TOOLS_BY_NAME.get(String(block.name))!;
          const input = (block.input ?? {}) as Record<string, unknown>;
          const action = PendingAction.propose({
            conversationId: conversation.id,
            toolUseId: String(block.id),
            toolName: tool.name,
            input,
            summary: summarizeAction(tool, input),
          });
          await this.repos.actions.save(action);
          proposed.push(action);
        }
        return {
          conversationId: conversation.id,
          reply: assistantMessage.text,
          pendingActions: proposed.map(describe),
          truncated: false,
        };
      }

      // Solo lecturas: se ejecutan y el bucle sigue.
      const results: ContentBlock[] = [];
      for (const block of toolUses) {
        const name = String(block.name);
        const tool = TOOLS_BY_NAME.get(name);
        if (!tool) {
          results.push(resultBlock(String(block.id), { error: `La herramienta ${name} no existe.` }, true));
          continue;
        }
        const response = await this.callTool(tool, (block.input ?? {}) as Record<string, unknown>, ctx);
        results.push(resultBlock(String(block.id), response.body, !response.ok));
      }
      await this.repos.messages.save(
        Message.create({ conversationId: conversation.id, role: 'user', content: results }),
      );
    }

    return {
      conversationId: conversation.id,
      reply:
        'Me he quedado sin pasos para resolver esto. Prueba a pedírmelo por partes o con más detalle.',
      pendingActions: [],
      truncated: true,
    };
  }

  /** Traduce una herramienta a la llamada HTTP real, con el token del usuario. */
  private async callTool(
    tool: ToolDefinition,
    input: Record<string, unknown>,
    ctx: TurnContext,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    let path = tool.path;
    const body: Record<string, unknown> = {};
    const query: Record<string, string> = {};

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || value === null || value === '') continue;
      if (path.includes(`:${key}`)) {
        path = path.replace(`:${key}`, encodeURIComponent(String(value)));
        continue;
      }
      if (tool.queryParams?.includes(key)) {
        query[key] = String(value);
        continue;
      }
      body[key] = value;
    }

    const response = await this.crm.call({
      method: tool.method,
      path,
      query,
      body: tool.method === 'GET' ? undefined : body,
      bearerToken: ctx.bearerToken,
    });

    // El recorte va aquí, en el único sitio por el que pasan todas las llamadas:
    // así ninguna herramienta nueva se lo salta por olvido. Solo en las
    // respuestas buenas — un error se entrega tal cual.
    if (response.ok && tool.trim) {
      return { ...response, body: tool.trim(response.body) };
    }
    return response;
  }

  private async loadConversation(id: string, ctx: TurnContext): Promise<Conversation> {
    const conversation = await this.repos.conversations.findById(id);
    // Mismo mensaje para "no existe" y "no es tuya": decir cuál de las dos es
    // ya filtra información de otra organización.
    if (!conversation || !conversation.belongsTo(ctx.organizationId, ctx.userId)) {
      throw new ConversationNotFoundError();
    }
    return conversation;
  }

  private async assertWithinLimit(organizationId: string): Promise<void> {
    if (this.options.monthlyTokenLimit <= 0) return;
    const used = await this.repos.usage.current(organizationId);
    if (used.inputTokens + used.outputTokens >= this.options.monthlyTokenLimit) {
      throw new UsageLimitReachedError();
    }
  }
}

function toLlmMessage(message: Message): LlmMessage {
  return { role: message.role, content: message.content };
}

function resultBlock(toolUseId: string, content: unknown, isError = false): ContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: typeof content === 'string' ? content : JSON.stringify(content ?? null),
    ...(isError ? { is_error: true } : {}),
  };
}

function actionOutcome(action: PendingAction): unknown {
  if (action.status === 'executed') return { confirmado: true, resultado: action.result };
  if (action.status === 'rejected') {
    return { confirmado: false, motivo: 'La persona rechazó la acción. No la vuelvas a proponer salvo que te lo pida.' };
  }
  return { confirmado: false, error: action.result };
}

function describe(action: PendingAction): TurnResult['pendingActions'][number] {
  return {
    id: action.id,
    toolName: action.toolName,
    summary: action.summary,
    input: action.input,
  };
}
