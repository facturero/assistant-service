import { Conversation, ContentBlock, Message, PendingAction } from '../domain/entities';
import { Repositories, UsageSnapshot } from '../domain/repositories';
import { CrmApiPort, LlmPort, LlmTurn } from '../application/ports';

export function createInMemoryRepositories(): Repositories & {
  __conversations: Map<string, Conversation>;
  __messages: Message[];
  __actions: Map<string, PendingAction>;
} {
  const conversations = new Map<string, Conversation>();
  const messages: Message[] = [];
  const actions = new Map<string, PendingAction>();
  const usage = new Map<string, UsageSnapshot>();

  return {
    __conversations: conversations,
    __messages: messages,
    __actions: actions,
    conversations: {
      async save(conversation) {
        // Igual que el upsert real: guardar no toca `deletedAt`.
        const existing = conversations.get(conversation.id);
        conversations.set(
          conversation.id,
          existing?.isDeleted
            ? Conversation.fromPersistence({ ...conversation.toJSON(), deletedAt: existing.deletedAt })
            : conversation,
        );
      },
      async findById(id) {
        const conversation = conversations.get(id);
        return conversation && !conversation.isDeleted ? conversation : null;
      },
      async listByUser(organizationId, userId, limit) {
        return [...conversations.values()]
          .filter((c) => c.belongsTo(organizationId, userId) && !c.isDeleted)
          .slice(0, limit);
      },
      async softDelete(id) {
        const conversation = conversations.get(id);
        if (!conversation || conversation.isDeleted) return;
        conversations.set(id, Conversation.fromPersistence({ ...conversation.toJSON(), deletedAt: new Date() }));
      },
    },
    messages: {
      async save(message) {
        messages.push(message);
      },
      async listByConversation(conversationId) {
        return messages.filter((m) => m.conversationId === conversationId);
      },
    },
    actions: {
      async save(action) {
        actions.set(action.id, action);
      },
      async findById(id) {
        return actions.get(id) ?? null;
      },
      async listByConversation(conversationId) {
        return [...actions.values()].filter((a) => a.conversationId === conversationId);
      },
    },
    usage: {
      async current(organizationId) {
        return usage.get(organizationId) ?? { inputTokens: 0, outputTokens: 0, requests: 0 };
      },
      async add(organizationId, delta) {
        const prev = usage.get(organizationId) ?? { inputTokens: 0, outputTokens: 0, requests: 0 };
        usage.set(organizationId, {
          inputTokens: prev.inputTokens + delta.inputTokens,
          outputTokens: prev.outputTokens + delta.outputTokens,
          requests: prev.requests + delta.requests,
        });
      },
    },
  };
}

/** Un modelo de mentira que devuelve los turnos que se le den, en orden. */
export class ScriptedLlm implements LlmPort {
  readonly calls: Array<{ system: string; messages: unknown[] }> = [];

  constructor(private readonly turns: Array<Partial<LlmTurn>>) {}

  async complete(params: { system: string; messages: unknown[] }): Promise<LlmTurn> {
    this.calls.push({ system: params.system, messages: params.messages });
    const turn = this.turns.shift();
    if (!turn) throw new Error('El test pidió más turnos de los que preparó');
    return {
      content: turn.content ?? [],
      stopReason: turn.stopReason ?? 'end_turn',
      stopDetails: turn.stopDetails ?? null,
      usage: turn.usage ?? { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
    };
  }
}

/** Una API del CRM de mentira que apunta lo que le piden. */
export class FakeCrmApi implements CrmApiPort {
  readonly calls: Array<{ method: string; path: string; body?: unknown; query?: unknown }> = [];

  constructor(private readonly responder: (path: string) => { ok: boolean; status: number; body: unknown } = () => ({
    ok: true,
    status: 200,
    body: { ok: true },
  })) {}

  async call(params: { method: string; path: string; query?: Record<string, string>; body?: unknown }) {
    this.calls.push({ method: params.method, path: params.path, body: params.body, query: params.query });
    return this.responder(params.path);
  }
}

export function textBlock(text: string): ContentBlock {
  return { type: 'text', text };
}

export function toolUseBlock(id: string, name: string, input: Record<string, unknown>): ContentBlock {
  return { type: 'tool_use', id, name, input };
}

export const ctx = {
  organizationId: 'org-1',
  userId: 'user-1',
  bearerToken: 'jwt-del-usuario',
  locale: 'es',
  organization: {
    organizationName: 'Farmacia Ejemplo',
    countryCode: 'EC',
    userName: 'Ana',
    locale: 'es',
    today: '2026-09-09',
  },
};
