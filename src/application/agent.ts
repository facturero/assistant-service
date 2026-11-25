import { Conversation, ContentBlock, Message, PendingAction } from '../domain/entities';
import { Repositories } from '../domain/repositories';
import {
  ActionAlreadyDecidedError,
  ActionNotFoundError,
  ContextTooLongError,
  ConversationNotFoundError,
  UnknownToolError,
  UsageLimitReachedError,
} from '../domain/errors';
import { availableTools, isBillingWrite, summarizeAction, toAnthropicTools, TOOLS_BY_NAME, ToolDefinition } from '../domain/tools';
import { CrmApiPort, LlmMessage, LlmPort } from './ports';
import { buildSystemPrompt, OrganizationContext } from './prompt';
import { enforceRequestedFormat } from './reply-format';
import { CompactionStage, ContextOverflowError, estimateTextTokens, fitHistory } from './context-window';

export interface TurnContext {
  organizationId: string;
  userId: string;
  bearerToken: string;
  locale: string;
  organization: OrganizationContext;
  /** Permisos del rol (cabecera `X-Permissions` del gateway). `null` = no se sabe y no se filtra por permiso. */
  permissions?: string[] | null;
  /** Módulos activos de la empresa. `null` = no se sabe y no se filtra por módulo. */
  plugins?: Set<string> | null;
}

export interface TurnResult {
  conversationId: string;
  /** Lo que el asistente dice, ya en texto plano. */
  reply: string;
  /** Escrituras esperando a que alguien las confirme. */
  pendingActions: Array<{ id: string; toolName: string; summary: string; input: Record<string, unknown> }>;
  /** Se llegó al tope de vueltas sin que el modelo cerrara el turno. */
  truncated: boolean;
  /**
   * Para que quepa en la ventana del modelo se dejaron fuera los turnos más antiguos: el asistente ya no los recuerda. El
   * chat lo avisa y sugiere empezar otra conversación. Quitar solo los resultados viejos del CRM no cuenta: no se pierde nada
   * de lo que se habló.
   */
  contextTrimmed: boolean;
}

export interface AgentOptions {
  /** Tope de vueltas del bucle. Un agente que no cierra en 8 pasos está perdido. */
  maxIterations: number;
  /** Tokens al mes por organización. 0 = sin límite. */
  monthlyTokenLimit: number;
  /** Ventana del modelo (prompt + respuesta). Sin poner, el historial se manda entero (los tests, que no tienen modelo). */
  contextTokens?: number;
  /** Lo que se reserva para la respuesta: el `max_tokens` que se le pide al modelo. */
  maxOutputTokens?: number;
}

/** Holgura sobre la estimación: la plantilla de herramientas de cada modelo añade texto que aquí no se ve. */
const CONTEXT_SAFETY_TOKENS = 300;

/**
 * Reintentos de la red de seguridad para escrituras "anunciadas en texto".
 * Un modelo pequeño a veces escribe "Voy a invitar a X" sin emitir la llamada;
 * antes dábamos el turno por cerrado y la acción por hecha. Ahora se le da otra
 * vuelta con una corrección, pero acotada: a la tercera caída se cierra con lo
 * que dijo, porque tampoco se puede girar en un bucle infinito pagando tokens.
 */
const MAX_WRITE_RETRIES = 2;

/** Rastros de que el modelo prometió una escritura en prosa, sin tool_use. */
const WRITE_ANNOUNCEMENT_RE =
  /\b(?:voy\s+a|vamos\s+a|me dispongo\s+a|procederé\s+a|te voy\s+a)\s+(?:a\s+)?(?:invitar|crear|dar\s+de\s+alta|actualizar)\b/i;

/**
 * La otra cara del mismo fallo: pedir permiso en prosa («¿Confirmas que cree el rol…?», «¿Deseas que proceda con la
 * invitación?»). gemma4:12b sin razonamiento lo hacía en todas las escrituras (banco de modelos, 2026-11-24): elegía bien
 * los datos, pero no emitía la llamada y la persona se quedaba sin el botón de confirmar. Solo cuenta si la pregunta lleva
 * un verbo de escritura: «¿Quieres que busque al cliente?» es una pregunta legítima y no debe disparar nada.
 */
const WRITE_CONFIRMATION_RE =
  /¿[^?]{0,40}\b(?:confirmas|confirma|deseas|desea|quieres|quiere|procedo|te parece)\b[^?]{0,80}\b(?:cree|crear|creo|invite|invitar|invito|registre|registrar|d[eé]\s+de\s+alta|dar\s+de\s+alta|proceda|proceder)\b[^?]*\?/i;

const WRITE_PROMPT_AGAIN =
  'Corrección: anunciaste o pediste permiso en texto para una acción, pero no llamaste a ninguna herramienta. ' +
  'No pidas confirmación en texto: el sistema ya se la pide a la persona con un botón antes de ejecutar nada. ' +
  'Si la petición requiere hacer algo (invitar, crear, dar de alta), llama a la herramienta ' +
  'correspondiente en este mismo turno. No lo anuncies solo en texto. Si no tienes ninguna ' +
  'herramienta para eso (por ejemplo, emitir una factura), no la inventes: di que no puedes hacerlo. ' +
  // Sin estas dos frases, Qwen abría la respuesta con «Tienes razón.» (le hablaba a la corrección, no a la persona) y, si
  // le faltaba un dato, se ponía a razonar hasta gastar todos los tokens y devolvía vacío (banco, 2026-11-25).
  'Si te falta un dato obligatorio, pregúntaselo a la persona en una frase. ' +
  'Responde directamente a la persona: no menciones esta corrección ni le des la razón.';

/**
 * Lo que se le dice a la persona si el modelo cierra sin texto (p. ej. se le fueron todos los tokens razonando). Mejor una
 * frase que una burbuja vacía tras un minuto de espera.
 */
const EMPTY_REPLY = 'No pude terminar la respuesta. Prueba a preguntarlo de otra forma o con más detalle.';

function announcesWrite(text: string): boolean {
  return WRITE_ANNOUNCEMENT_RE.test(text) || WRITE_CONFIRMATION_RE.test(text);
}

/**
 * ¿Pidió la persona hacer algo? La red de seguridad solo tiene sentido entonces. Si solo preguntó («¿cuántos sacos de
 * cemento quedan?») y el modelo ofrece crear lo que falta («¿quieres que lo registre?»), la oferta es legítima: corregirla
 * empujaba al modelo a crear un producto que nadie pidió (banco, 2026-11-25).
 */
const WRITE_REQUEST_RE =
  /\b(?:invit\w*|cre[aáe]\w*|registr\w*|d[aá]\s+de\s+alta|dar\s+de\s+alta|agreg\w*|añad\w*|anad\w*|alta\s+(?:a|de)|nuev[oa]s?)\b/i;

function asksForWrite(userText: string): boolean {
  return WRITE_REQUEST_RE.test(userText);
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
/**
 * Tipos de evento de auditoría del asistente. Prefijo `assistant.`: el gateway no lo escucha, así que no mueve
 * permisos ni campanas. Los payloads llevan qué herramienta y el resumen que la persona leyó, no el resultado del CRM
 * (puede traer datos de clientes) ni las respuestas del modelo.
 */
export type AssistantAuditType =
  | 'assistant.action.proposed'
  | 'assistant.action.executed'
  | 'assistant.action.failed'
  | 'assistant.action.rejected';

export class Agent {
  constructor(
    private readonly repos: Repositories,
    private readonly llm: LlmPort,
    private readonly crm: CrmApiPort,
    private readonly options: AgentOptions,
  ) {}

  /**
   * Deja constancia en la bitácora. Un fallo aquí NO debe romper la conversación (la persona ya pidió o confirmó algo):
   * se anota en el log y el turno sigue.
   */
  private async audit(
    type: AssistantAuditType,
    ctx: TurnContext,
    action: PendingAction,
    conversationId: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.repos.outbox) return;
    try {
      await this.repos.outbox.add({
        type,
        aggregateType: 'assistant_action',
        aggregateId: action.id,
        payload: {
          targetId: action.id,
          organizationId: ctx.organizationId,
          actorId: ctx.userId,
          conversationId,
          toolName: action.toolName,
          summary: action.summary,
          ...extra,
        },
        occurredAt: new Date(),
      });
    } catch (err) {
      console.error(`[assistant] no se pudo registrar ${type} en la bitácora:`, err);
    }
  }

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
      await this.audit('assistant.action.rejected', params.ctx, action, conversation.id);
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
      await this.audit(
        response.ok ? 'assistant.action.executed' : 'assistant.action.failed',
        params.ctx,
        action,
        conversation.id,
        // Solo el código HTTP del CRM; el cuerpo de la respuesta puede traer datos de la empresa.
        { httpStatus: response.status },
      );
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
        contextTrimmed: false,
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
    const tools = toAnthropicTools(availableTools(ctx.permissions ?? null, ctx.plugins ?? null));

    // La corrección se inyecta a la llamada siguiente y se reemplaza cada vuelta.
    // No viaja en el historial: es un empujón a la iteración, no un mensaje del
    // usuario que luego se reenvíe para siempre.
    let correction: string | null = null;
    let corrections = 0;
    // El último texto que el modelo escribió en este turno: si tras una corrección cierra sin texto, se devuelve este.
    let lastText = '';

    // Lo que queda para el historial: la ventana menos la respuesta, el prompt y las herramientas, que viajan siempre.
    const budget =
      this.options.contextTokens === undefined
        ? Number.POSITIVE_INFINITY
        : this.options.contextTokens -
          // Un `max_tokens` de 16000 (el valor por defecto, pensado para Anthropic) con Ollama a 8192 dejaría el presupuesto en
          // negativo y ningún turno cabría: la reserva nunca pasa de un tercio de la ventana.
          Math.min(this.options.maxOutputTokens ?? 0, Math.floor(this.options.contextTokens / 3)) -
          estimateTextTokens(system) -
          estimateTextTokens(JSON.stringify(tools)) -
          CONTEXT_SAFETY_TOKENS;
    let stage: CompactionStage = 'none';

    for (let iteration = 0; iteration < this.options.maxIterations; iteration++) {
      const history = await this.repos.messages.listByConversation(conversation.id);
      // La corrección se suma DESPUÉS de recortar: es texto de usuario y, metida antes, contaría como el turno actual y
      // dejaría sin herramientas al turno de verdad.
      let fitted;
      try {
        fitted = fitHistory(history.map(toLlmMessage), budget - (correction ? estimateTextTokens(correction) + 8 : 0));
      } catch (error) {
        if (error instanceof ContextOverflowError) throw new ContextTooLongError();
        throw error;
      }
      if (fitted.stage === 'dropped' || (fitted.stage === 'tools' && stage === 'none')) stage = fitted.stage;
      const messages = fitted.messages;
      if (correction) {
        messages.push({ role: 'user', content: [{ type: 'text', text: correction }] });
        correction = null;
      }
      const turn = await this.llm.complete({
        system,
        messages,
        tools,
      });

      await this.repos.usage.add(ctx.organizationId, {
        inputTokens: turn.usage.inputTokens,
        outputTokens: turn.usage.outputTokens,
        requests: 1,
      });

      // Tablas y gráficos solo si la persona los pidió en su último mensaje (ver reply-format.ts): se aplica al texto antes de
      // guardarlo, así el historial y lo que ve la persona coinciden.
      const lastUserText = lastUserMessageText(history);
      const content = turn.content.map((b) =>
        b.type === 'text' && typeof b.text === 'string' ? { ...b, text: enforceRequestedFormat(b.text, lastUserText) } : b,
      );
      const assistantMessage = Message.create({
        conversationId: conversation.id,
        role: 'assistant',
        content,
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
          contextTrimmed: stage === 'dropped',
        };
      }

      const toolUses = turn.content.filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0) {
        // El modelo a veces anuncia una escritura en prosa ("Voy a invitar a X")
        // sin emitir la llamada. Para una respuesta normal es el fin del turno,
        // pero si el texto promete una escritura, se da otra vuelta con la
        // corrección en vez de dar la acción por hecha.
        if (corrections < MAX_WRITE_RETRIES && announcesWrite(assistantMessage.text) && asksForWrite(lastUserText)) {
          correction = WRITE_PROMPT_AGAIN;
          corrections += 1;
          lastText = assistantMessage.text;
          continue;
        }
        return {
          conversationId: conversation.id,
          reply: assistantMessage.text.trim() ? assistantMessage.text : lastText || EMPTY_REPLY,
          pendingActions: [],
          truncated: false,
          contextTrimmed: stage === 'dropped',
        };
      }

      // Si en el turno hay una sola escritura, se suspende entero: se proponen
      // las escrituras y no se ejecuta nada más hasta que haya decisión humana.
      const writes = toolUses.filter((b) => TOOLS_BY_NAME.get(String(b.name))?.risk === 'write');
      if (writes.length > 0) {
        // Cada escritura se revisa contra el CRM antes de enseñar la tarjeta (`prepare`). Si alguna no puede salir bien, no
        // se propone ninguna: el error vuelve al modelo y corrige en la vuelta siguiente, sin que la persona vea una tarjeta
        // condenada a fallar.
        const prepared: Array<{ block: ContentBlock; tool: ToolDefinition; input: Record<string, unknown>; summary: string }> = [];
        const rejected = new Map<string, string>();
        for (const block of writes) {
          const tool = TOOLS_BY_NAME.get(String(block.name))!;
          const p = await this.prepareAction(tool, (block.input ?? {}) as Record<string, unknown>, ctx);
          if ('error' in p) rejected.set(String(block.id), p.error);
          else prepared.push({ block, tool, ...p });
        }
        if (rejected.size > 0) {
          const results: ContentBlock[] = [];
          for (const block of toolUses) {
            const id = String(block.id);
            const tool = TOOLS_BY_NAME.get(String(block.name));
            if (rejected.has(id)) results.push(resultBlock(id, { error: rejected.get(id) }, true));
            else if (!tool) results.push(resultBlock(id, { error: `La herramienta ${String(block.name)} no existe.` }, true));
            else if (tool.risk === 'write') {
              results.push(resultBlock(id, { error: 'No se propuso porque otra acción de este turno tenía un error. Corrígela y vuelve a proponer las dos.' }, true));
            } else {
              const response = await this.callTool(tool, (block.input ?? {}) as Record<string, unknown>, ctx);
              results.push(resultBlock(id, response.body, !response.ok));
            }
          }
          await this.repos.messages.save(Message.create({ conversationId: conversation.id, role: 'user', content: results }));
          continue;
        }

        const proposed: PendingAction[] = [];
        for (const { block, tool, input, summary } of prepared) {
          const action = PendingAction.propose({
            conversationId: conversation.id,
            toolUseId: String(block.id),
            toolName: tool.name,
            input,
            summary,
          });
          await this.repos.actions.save(action);
          await this.audit('assistant.action.proposed', ctx, action, conversation.id);
          proposed.push(action);
        }
        return {
          conversationId: conversation.id,
          reply: assistantMessage.text,
          pendingActions: proposed.map(describe),
          truncated: false,
          contextTrimmed: stage === 'dropped',
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
      contextTrimmed: stage === 'dropped',
    };
  }

  /**
   * Revisa una escritura antes de proponerla (ver `prepare` en tools.ts): solo lecturas, con el token del usuario. Si la
   * revisión no se puede hacer o revienta, se propone tal cual con el resumen simple: una tarjeta menos clara es mejor que
   * dejar a la persona sin poder hacer lo que pidió.
   */
  private async prepareAction(
    tool: ToolDefinition,
    input: Record<string, unknown>,
    ctx: TurnContext,
  ): Promise<{ input: Record<string, unknown>; summary: string } | { error: string }> {
    if (tool.prepare) {
      try {
        const p = await tool.prepare(input, {
          call: (method, path, options = {}) =>
            method === 'GET'
              ? this.crm.call({ method, path, query: options.query ?? {}, bearerToken: ctx.bearerToken })
              : Promise.resolve({ ok: false, status: 405, body: { code: 'READ_ONLY' } }),
        });
        if (p && 'error' in p) return p;
        if (p) return { input: p.input, summary: p.summary ?? summarizeAction(tool, p.input) };
      } catch (err) {
        console.error(`[assistant] no se pudo revisar ${tool.name}; se propone tal cual:`, err);
      }
    }
    return { input, summary: summarizeAction(tool, input) };
  }

  /** Traduce una herramienta a la llamada HTTP real, con el token del usuario. */
  private async callTool(
    tool: ToolDefinition,
    input: Record<string, unknown>,
    ctx: TurnContext,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    // Segunda barrera tras el catálogo: el asistente no factura. Ni siquiera con
    // confirmación humana, así que no llega a la API.
    if (isBillingWrite(tool.method, tool.path)) {
      return {
        ok: false,
        status: 403,
        body: {
          code: 'ASSISTANT_CANNOT_INVOICE',
          message: 'El asistente no puede emitir ni modificar facturas. Se hace desde [facturación](/invoices/new).',
        },
      };
    }

    if (tool.execute) {
      const api = {
        call: (method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, options: { query?: Record<string, string>; body?: unknown } = {}) => {
          // Una compuesta tampoco puede escribir en facturación: la barrera de arriba mira la ruta de cada llamada real.
          if (isBillingWrite(method, path)) {
            return Promise.resolve({ ok: false, status: 403, body: { code: 'ASSISTANT_CANNOT_INVOICE' } });
          }
          return this.crm.call({ method, path, query: options.query ?? {}, body: options.body, bearerToken: ctx.bearerToken });
        },
      };
      const response = await tool.execute(input, api);
      return response.ok && tool.trim ? { ...response, body: tool.trim(response.body) } : response;
    }

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

/** Lo último que escribió la persona: el mensaje de usuario más reciente con texto (los de `tool_result` no cuentan). */
function lastUserMessageText(history: Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== 'user') continue;
    const text = m.content.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('\n').trim();
    if (text) return text;
  }
  return '';
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
    // Un dato, no una instrucción redactada: con una frase para el modelo («No la vuelvas a proponer…») Qwen la copiaba
    // tal cual en la respuesta (2026-11-25). La regla de no reproponerla vive en el prompt.
    return { confirmado: false, rechazada: true };
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
