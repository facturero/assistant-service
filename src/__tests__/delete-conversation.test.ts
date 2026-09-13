import { describe, expect, it } from 'vitest';
import { Agent } from '../application/agent';
import { createApp } from '../interface/http/app';
import {
  createInMemoryRepositories,
  ctx,
  FakeCrmApi,
  ScriptedLlm,
  textBlock,
  toolUseBlock,
} from './helpers';

const options = { maxIterations: 5, monthlyTokenLimit: 0 };

function headers(organizationId = ctx.organizationId, userId = ctx.userId) {
  return {
    'X-Organization-Id': organizationId,
    'X-User-Id': userId,
    Authorization: `Bearer ${ctx.bearerToken}`,
  };
}

function setup(turns: ConstructorParameters<typeof ScriptedLlm>[0] = [{ content: [textBlock('hola')] }]) {
  const repos = createInMemoryRepositories();
  const crm = new FakeCrmApi();
  const agent = new Agent(repos, new ScriptedLlm(turns), crm, options);
  const app = createApp({ agent, repos, crm, corsOrigin: '' });
  return { repos, agent, app };
}

describe('Borrar conversaciones', () => {
  it('es virtual: deja de listarse y de abrirse, pero la fila y sus mensajes siguen', async () => {
    const { repos, agent, app } = setup();
    const { conversationId } = await agent.startOrContinue({ conversationId: null, text: 'hola', ctx });

    const res = await app.request(`/assistant/conversations/${conversationId}`, {
      method: 'DELETE',
      headers: headers(),
    });
    expect(res.status).toBe(204);

    const list = await app.request('/assistant/conversations', { headers: headers() });
    expect(await list.json()).toEqual([]);

    const detail = await app.request(`/assistant/conversations/${conversationId}`, { headers: headers() });
    expect(detail.status).toBe(404);

    // Nada se borró de verdad.
    expect(repos.__conversations.get(conversationId)?.deletedAt).toBeInstanceOf(Date);
    expect(repos.__messages.filter((m) => m.conversationId === conversationId)).not.toHaveLength(0);
  });

  it('una conversación borrada no se puede continuar', async () => {
    const { agent, app } = setup();
    const { conversationId } = await agent.startOrContinue({ conversationId: null, text: 'hola', ctx });
    await app.request(`/assistant/conversations/${conversationId}`, { method: 'DELETE', headers: headers() });

    await expect(
      agent.startOrContinue({ conversationId, text: 'sigo aquí', ctx }),
    ).rejects.toThrow(/no existe/i);
  });

  it('las acciones pendientes de un hilo borrado ya no se pueden decidir', async () => {
    const { agent, app } = setup([
      { content: [toolUseBlock('tu_1', 'crear_rol', { name: 'Cajero', permissions: [] })], stopReason: 'tool_use' },
    ]);
    const proposal = await agent.startOrContinue({ conversationId: null, text: 'crea un rol', ctx });
    await app.request(`/assistant/conversations/${proposal.conversationId}`, {
      method: 'DELETE',
      headers: headers(),
    });

    await expect(
      agent.decideAction({ actionId: proposal.pendingActions[0].id, approve: true, ctx }),
    ).rejects.toThrow(/no existe/i);
  });

  it('guardar el hilo después de borrarlo no lo resucita', async () => {
    const { repos, agent, app } = setup();
    const { conversationId } = await agent.startOrContinue({ conversationId: null, text: 'hola', ctx });
    // Un turno en marcha tiene su copia del hilo y la guarda al terminar.
    const stale = repos.__conversations.get(conversationId)!;

    await app.request(`/assistant/conversations/${conversationId}`, { method: 'DELETE', headers: headers() });
    await repos.conversations.save(stale);

    expect(await repos.conversations.findById(conversationId)).toBeNull();
  });

  it('la conversación de otro usuario no existe para ti, y no se borra', async () => {
    const { repos, agent, app } = setup();
    const { conversationId } = await agent.startOrContinue({ conversationId: null, text: 'hola', ctx });

    const res = await app.request(`/assistant/conversations/${conversationId}`, {
      method: 'DELETE',
      headers: headers('otra-empresa', 'otro-usuario'),
    });

    expect(res.status).toBe(404);
    expect(repos.__conversations.get(conversationId)?.isDeleted).toBe(false);
  });

  it('borrar dos veces da 404 la segunda', async () => {
    const { agent, app } = setup();
    const { conversationId } = await agent.startOrContinue({ conversationId: null, text: 'hola', ctx });
    const url = `/assistant/conversations/${conversationId}`;

    expect((await app.request(url, { method: 'DELETE', headers: headers() })).status).toBe(204);
    expect((await app.request(url, { method: 'DELETE', headers: headers() })).status).toBe(404);
  });
});
