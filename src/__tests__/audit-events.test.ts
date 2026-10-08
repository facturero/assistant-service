import { describe, expect, it } from 'vitest';
import { Agent } from '../application/agent';
import { createApp } from '../interface/http/app';
import { createInMemoryRepositories, ctx, FakeCrmApi, ScriptedLlm, textBlock, toolUseBlock } from './helpers';

const options = { maxIterations: 5, monthlyTokenLimit: 0 };

/** Un turno en el que el modelo propone crear un rol (una escritura que espera confirmación). */
function proponeCrearRol() {
  return [
    {
      content: [toolUseBlock('tu_1', 'crear_rol', { name: 'Cajero', permissions: ['invoice:create'] })],
      stopReason: 'tool_use' as const,
    },
    { content: [textBlock('Listo.')] },
  ];
}

// Lo que el asistente propone y lo que la persona confirma o rechaza se quedaba solo en `pending_actions`: la bitácora
// central no se enteraba de que alguien le pidió a la IA hacer cambios en la empresa.
describe('el asistente deja huella en la bitácora', () => {
  it('proponer una escritura publica assistant.action.proposed con la herramienta y el resumen', async () => {
    const repos = createInMemoryRepositories();
    const agent = new Agent(repos, new ScriptedLlm(proponeCrearRol()), new FakeCrmApi(), options);

    const turn = await agent.startOrContinue({ conversationId: null, text: 'crea el rol Cajero', ctx });

    const ev = repos.__events.find((e) => e.type === 'assistant.action.proposed');
    expect(ev?.aggregateId).toBe(turn.pendingActions[0].id);
    expect(ev?.payload).toMatchObject({
      targetId: turn.pendingActions[0].id,
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
      conversationId: turn.conversationId,
      toolName: 'crear_rol',
    });
    expect(String(ev?.payload.summary)).toBeTruthy();
  });

  it('una lectura NO publica nada: solo las escrituras son acciones', async () => {
    const repos = createInMemoryRepositories();
    const agent = new Agent(
      repos,
      new ScriptedLlm([
        { content: [toolUseBlock('tu_1', 'listar_clientes', {})], stopReason: 'tool_use' },
        { content: [textBlock('Nada.')] },
      ]),
      new FakeCrmApi(),
      options,
    );
    await agent.startOrContinue({ conversationId: null, text: 'mis clientes', ctx });
    expect(repos.__events).toHaveLength(0);
  });

  it('confirmar publica assistant.action.executed con el código HTTP, y jamás el cuerpo de la respuesta', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi(() => ({
      ok: true,
      status: 201,
      body: { id: 'rol-9', secretoDelCliente: 'dato-privado-xyz' },
    }));
    const agent = new Agent(repos, new ScriptedLlm(proponeCrearRol()), crm, options);
    const turn = await agent.startOrContinue({ conversationId: null, text: 'crea el rol Cajero', ctx });

    await agent.decideAction({ actionId: turn.pendingActions[0].id, approve: true, ctx });

    const ev = repos.__events.find((e) => e.type === 'assistant.action.executed');
    expect(ev?.payload).toMatchObject({ toolName: 'crear_rol', httpStatus: 201, actorId: ctx.userId });
    expect(JSON.stringify(repos.__events)).not.toContain('dato-privado-xyz');
  });

  it('si el CRM rechaza la acción confirmada, queda como assistant.action.failed', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi(() => ({ ok: false, status: 403, body: { code: 'PERMISSION_DENIED' } }));
    const agent = new Agent(repos, new ScriptedLlm(proponeCrearRol()), crm, options);
    const turn = await agent.startOrContinue({ conversationId: null, text: 'crea el rol Cajero', ctx });

    await agent.decideAction({ actionId: turn.pendingActions[0].id, approve: true, ctx });

    const ev = repos.__events.find((e) => e.type === 'assistant.action.failed');
    expect(ev?.payload).toMatchObject({ httpStatus: 403 });
    expect(repos.__events.some((e) => e.type === 'assistant.action.executed')).toBe(false);
  });

  it('rechazar publica assistant.action.rejected y no llama al CRM', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi();
    const agent = new Agent(repos, new ScriptedLlm(proponeCrearRol()), crm, options);
    const turn = await agent.startOrContinue({ conversationId: null, text: 'crea el rol Cajero', ctx });

    await agent.decideAction({ actionId: turn.pendingActions[0].id, approve: false, ctx });

    expect(repos.__events.some((e) => e.type === 'assistant.action.rejected')).toBe(true);
    expect(crm.calls).toHaveLength(0);
  });

  it('si la bitácora falla, la conversación sigue y la acción se ejecuta igual', async () => {
    const repos = createInMemoryRepositories();
    repos.outbox = {
      async add() {
        throw new Error('db caída');
      },
    };
    const crm = new FakeCrmApi();
    const agent = new Agent(repos, new ScriptedLlm(proponeCrearRol()), crm, options);

    const turn = await agent.startOrContinue({ conversationId: null, text: 'crea el rol Cajero', ctx });
    expect(turn.pendingActions).toHaveLength(1);

    await expect(agent.decideAction({ actionId: turn.pendingActions[0].id, approve: true, ctx })).resolves.toBeTruthy();
    expect(crm.calls).toHaveLength(1);
  });

  it('sin outbox configurado (RabbitMQ apagado) el asistente funciona igual', async () => {
    const repos = createInMemoryRepositories();
    delete repos.outbox;
    const agent = new Agent(repos, new ScriptedLlm(proponeCrearRol()), new FakeCrmApi(), options);
    const turn = await agent.startOrContinue({ conversationId: null, text: 'crea el rol Cajero', ctx });
    expect(turn.pendingActions).toHaveLength(1);
  });

  it('borrar una conversación publica assistant.conversation.deleted con quién lo hizo', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi();
    const agent = new Agent(repos, new ScriptedLlm([{ content: [textBlock('hola')] }]), crm, options);
    const app = createApp({ agent, repos, crm, corsOrigin: '' });
    const { conversationId } = await agent.startOrContinue({ conversationId: null, text: 'hola', ctx });

    const res = await app.request(`/assistant/conversations/${conversationId}`, {
      method: 'DELETE',
      headers: {
        'X-Organization-Id': ctx.organizationId,
        'X-User-Id': ctx.userId,
        Authorization: `Bearer ${ctx.bearerToken}`,
      },
    });

    expect(res.status).toBe(204);
    const ev = repos.__events.find((e) => e.type === 'assistant.conversation.deleted');
    expect(ev?.payload).toMatchObject({
      targetId: conversationId,
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
    });
  });

  it('los nombres usan el prefijo assistant. (el gateway no lo escucha) y ningún payload lleva userId', async () => {
    const repos = createInMemoryRepositories();
    const agent = new Agent(repos, new ScriptedLlm(proponeCrearRol()), new FakeCrmApi(), options);
    const turn = await agent.startOrContinue({ conversationId: null, text: 'crea el rol Cajero', ctx });
    await agent.decideAction({ actionId: turn.pendingActions[0].id, approve: true, ctx });

    for (const ev of repos.__events) {
      expect(ev.type.startsWith('assistant.')).toBe(true);
      expect(ev.payload).not.toHaveProperty('userId');
    }
  });
});
