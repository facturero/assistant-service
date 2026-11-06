import { describe, expect, it } from 'vitest';
import { ProjectAssistant } from '../application/project-ai';
import { StructuredLlmPort } from '../application/ports';
import { UsageLimitReachedError } from '../domain/errors';
import { createApp } from '../interface/http/app';
import { createInMemoryRepositories, FakeCrmApi } from './helpers';

/** Un modelo de mentira que devuelve lo que se le dé y apunta qué se le pidió. */
class ScriptedJsonLlm implements StructuredLlmPort {
  readonly calls: Array<{ system: string; prompt: string; schema: Record<string, unknown> }> = [];
  constructor(private readonly reply: unknown) {}
  async generate(params: { system: string; prompt: string; schema: Record<string, unknown> }) {
    this.calls.push(params);
    return { data: this.reply, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 } };
  }
}

const ctx = { organizationId: 'org-1', userId: 'user-1', bearerToken: 'jwt-del-usuario', locale: 'es' };
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const ANA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LUIS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';

const people = [
  { id: ANA, fullName: 'Ana Pérez', email: 'ana@x.com' },
  { id: LUIS, fullName: null, email: 'luis@x.com' },
];

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    parentTaskId: null,
    kind: 'task',
    title: 'Conciliar bancos de octubre',
    description: 'Cruzar el extracto con los cobros.',
    assigneeUserId: ANA,
    dueOn: '2026-11-10',
    completedAt: null,
    estimatedMinutes: null,
    projects: [{ name: 'Cierre mensual', sectionName: 'En curso' }],
    subtasks: [],
    blockedBy: [],
    comments: [
      { authorUserId: LUIS, bodyText: 'Falta el extracto del Pichincha.', createdAt: '2026-11-03T10:00:00Z', deleted: false },
      { authorUserId: ANA, bodyText: 'Lo pido hoy.', createdAt: '2026-11-04T10:00:00Z', deleted: false },
      { authorUserId: ANA, bodyText: 'texto borrado', createdAt: '2026-11-04T11:00:00Z', deleted: true },
    ],
    activity: [{ actorUserId: ANA, kind: 'assigned', data: { to: ANA }, at: '2026-11-02T09:00:00Z' }],
    ...overrides,
  };
}

function crmWith(routes: Record<string, { ok?: boolean; status?: number; body: unknown }>) {
  return new FakeCrmApi((path) => {
    const hit = routes[path];
    if (!hit) return { ok: false, status: 404, body: { code: 'NOT_FOUND' } };
    return { ok: hit.ok ?? true, status: hit.status ?? 200, body: hit.body };
  });
}

const summary = { summary: 'Falta el extracto del banco; Ana lo pide hoy.', decisions: [], nextSteps: ['Ana: pedir el extracto'] };

describe('IA de Proyectos — resumir una tarea', () => {
  it('lee con el token de quien pregunta, pone los comentarios con nombre y deja fuera los borrados', async () => {
    const repos = createInMemoryRepositories();
    const crm = crmWith({ [`/projects/tasks/${TASK_ID}`]: { body: task() }, '/users/directory': { body: people } });
    const llm = new ScriptedJsonLlm(summary);

    const result = await new ProjectAssistant(repos, llm, crm, { monthlyTokenLimit: 0 }).summarizeTask(TASK_ID, ctx);

    expect(result).toEqual(summary);
    expect(crm.calls.every((c) => c.method === 'GET')).toBe(true);
    const prompt = llm.calls[0]!.prompt;
    expect(prompt).toContain('luis@x.com: Falta el extracto del Pichincha.');
    expect(prompt).toContain('Ana Pérez: Lo pido hoy.');
    expect(prompt).not.toContain('texto borrado');
    expect(prompt).not.toContain(ANA);
    expect(prompt).toContain('assigned {"to":"Ana Pérez"}');
    // El contenido de usuarios va entre etiquetas y el sistema dice que no son instrucciones.
    expect(prompt.startsWith('<datos>')).toBe(true);
    expect(prompt.trimEnd().endsWith('</datos>')).toBe(true);
    expect(llm.calls[0]!.system).toContain('no instrucciones');
    expect(await repos.usage.current('org-1')).toEqual({ inputTokens: 100, outputTokens: 20, requests: 1 });
  });

  it('una tarea que no se puede ver (403) contesta lo mismo que una que no existe, sin llamar al modelo', async () => {
    const crm = crmWith({ [`/projects/tasks/${TASK_ID}`]: { ok: false, status: 403, body: {} } });
    const llm = new ScriptedJsonLlm(summary);

    await expect(
      new ProjectAssistant(createInMemoryRepositories(), llm, crm, { monthlyTokenLimit: 0 }).summarizeTask(TASK_ID, ctx),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND', status: 404 });
    expect(llm.calls).toHaveLength(0);
  });

  it('con el tope del mes gastado no lee nada ni llama al modelo', async () => {
    const repos = createInMemoryRepositories();
    await repos.usage.add('org-1', { inputTokens: 900, outputTokens: 200, requests: 3 });
    const crm = crmWith({});
    const llm = new ScriptedJsonLlm(summary);

    await expect(
      new ProjectAssistant(repos, llm, crm, { monthlyTokenLimit: 1000 }).summarizeTask(TASK_ID, ctx),
    ).rejects.toBeInstanceOf(UsageLimitReachedError);
    expect(crm.calls).toHaveLength(0);
    expect(llm.calls).toHaveLength(0);
  });

  it('una respuesta con otra forma es un 503, pero el gasto se cuenta igual', async () => {
    const repos = createInMemoryRepositories();
    const crm = crmWith({ [`/projects/tasks/${TASK_ID}`]: { body: task() }, '/users/directory': { body: people } });

    await expect(
      new ProjectAssistant(repos, new ScriptedJsonLlm({ resumen: 'otra cosa' }), crm, { monthlyTokenLimit: 0 }).summarizeTask(TASK_ID, ctx),
    ).rejects.toMatchObject({ code: 'ASSISTANT_UNAVAILABLE', status: 503 });
    expect((await repos.usage.current('org-1')).requests).toBe(1);
  });

  it('con muchísimos comentarios recorta los más viejos y conserva los últimos', async () => {
    const comments = Array.from({ length: 200 }, (_, i) => ({
      authorUserId: ANA,
      bodyText: `comentario número ${i} ${'x'.repeat(150)}`,
      createdAt: `2026-10-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
      deleted: false,
    }));
    const crm = crmWith({ [`/projects/tasks/${TASK_ID}`]: { body: task({ comments }) }, '/users/directory': { body: people } });
    const llm = new ScriptedJsonLlm(summary);

    await new ProjectAssistant(createInMemoryRepositories(), llm, crm, { monthlyTokenLimit: 0 }).summarizeTask(TASK_ID, ctx);

    const prompt = llm.calls[0]!.prompt;
    expect(prompt.length).toBeLessThanOrEqual(12_000);
    expect(prompt).toContain('comentario número 199');
    expect(prompt).not.toContain('comentario número 0 ');
    expect(prompt).toContain('Tarea: Conciliar bancos de octubre');
    expect(prompt.trimEnd().endsWith('</datos>')).toBe(true);
  });

  it('recorta listas largas y textos desmedidos', async () => {
    const crm = crmWith({ [`/projects/tasks/${TASK_ID}`]: { body: task() }, '/users/directory': { body: people } });
    const llm = new ScriptedJsonLlm({ summary: 'a'.repeat(5000), decisions: Array(20).fill('d'), nextSteps: ['  ', 'x'] });

    const result = await new ProjectAssistant(createInMemoryRepositories(), llm, crm, { monthlyTokenLimit: 0 }).summarizeTask(TASK_ID, ctx);

    expect(result.summary).toHaveLength(800);
    expect(result.decisions).toHaveLength(6);
    expect(result.nextSteps).toEqual(['x']);
  });
});

describe('IA de Proyectos — proponer subtareas', () => {
  it('quita las que ya existen, se queda con 10 como mucho y descarta estimaciones absurdas', async () => {
    const crm = crmWith({
      [`/projects/tasks/${TASK_ID}`]: { body: task({ subtasks: [{ ...task(), id: 's1', title: 'Pedir el extracto', completedAt: null }] }) },
      '/users/directory': { body: people },
    });
    const llm = new ScriptedJsonLlm({
      subtasks: [
        { title: 'pedir el extracto', estimatedMinutes: 10 },
        { title: 'Cruzar cobros', estimatedMinutes: -3 },
        ...Array.from({ length: 12 }, (_, i) => ({ title: `Paso ${i}`, estimatedMinutes: 30 })),
      ],
    });

    const result = await new ProjectAssistant(createInMemoryRepositories(), llm, crm, { monthlyTokenLimit: 0 }).suggestSubtasks(TASK_ID, ctx);

    expect(result.subtasks.map((s) => s.title)).not.toContain('pedir el extracto');
    expect(result.subtasks[0]).toEqual({ title: 'Cruzar cobros', estimatedMinutes: null });
    expect(result.subtasks.length).toBeLessThanOrEqual(10);
    expect(llm.calls[0]!.prompt).toContain('- Pedir el extracto');
  });
});

describe('IA de Proyectos — borrador de estado', () => {
  const board = {
    project: { name: 'Cierre mensual', description: null },
    sections: [{ id: 'sec', name: 'En curso' }],
    tasks: [
      { ...task(), id: 't1', title: 'Conciliar bancos', dueOn: '2026-11-01', sectionId: 'sec' },
      { ...task(), id: 't2', title: 'Declarar IVA', dueOn: '2026-11-09', assigneeUserId: null, sectionId: 'sec' },
      { ...task(), id: 't3', title: 'Cerrar caja chica', completedAt: '2026-11-04T15:00:00Z', sectionId: 'sec' },
      { ...task(), id: 't4', title: 'Subtarea suelta', parentTaskId: 't1', dueOn: '2026-10-01', sectionId: 'sec' },
    ],
    dependencies: [{ taskId: 't2', dependsOnTaskId: 't1' }],
  };
  const dashboard = {
    today: '2026-11-06',
    totals: { total: 3, open: 2, completed: 1, overdue: 1, unassigned: 1, dueThisWeek: 1 },
    milestones: [{ title: 'Entrega al contador', dueOn: '2026-11-15', completed: false }],
    time: { estimatedMinutes: 0, actualMinutes: 0 },
  };

  it('arma los hechos de la semana (vencidas, próximas, bloqueos, hitos) sin contar subtareas', async () => {
    const crm = crmWith({
      [`/projects/${PROJECT_ID}/tasks`]: { body: board },
      [`/projects/${PROJECT_ID}/dashboard`]: { body: dashboard },
      [`/projects/${PROJECT_ID}/status-updates`]: { body: { items: [] } },
      '/users/directory': { body: people },
    });
    const draft = { status: 'at_risk', summary: 'Hay una vencida.', accomplished: ['Caja chica'], risks: ['Bancos'], nextSteps: ['IVA'] };
    const llm = new ScriptedJsonLlm(draft);

    const result = await new ProjectAssistant(createInMemoryRepositories(), llm, crm, { monthlyTokenLimit: 0 }).draftStatus(PROJECT_ID, ctx);

    expect(result).toEqual(draft);
    const prompt = llm.calls[0]!.prompt;
    expect(prompt).toContain('- Conciliar bancos — Ana Pérez, vencía 2026-11-01');
    expect(prompt).toContain('- Declarar IVA — sin responsable, vence 2026-11-09');
    expect(prompt).toContain('- Cerrar caja chica (2026-11-04)');
    expect(prompt).toContain('«Declarar IVA» espera a «Conciliar bancos»');
    expect(prompt).toContain('- Entrega al contador (2026-11-15)');
    expect(prompt).not.toContain('Subtarea suelta');
  });

  it('un estado fuera de la lista no se acepta', async () => {
    const crm = crmWith({
      [`/projects/${PROJECT_ID}/tasks`]: { body: board },
      [`/projects/${PROJECT_ID}/dashboard`]: { body: dashboard },
      '/users/directory': { body: people },
    });
    const llm = new ScriptedJsonLlm({ status: 'great', summary: 'x', accomplished: [], risks: [], nextSteps: [] });

    await expect(
      new ProjectAssistant(createInMemoryRepositories(), llm, crm, { monthlyTokenLimit: 0 }).draftStatus(PROJECT_ID, ctx),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe('IA de Proyectos — rutas', () => {
  it('un identificador que no es uuid se rechaza antes de leer nada', async () => {
    const crm = crmWith({});
    const llm = new ScriptedJsonLlm(summary);
    const repos = createInMemoryRepositories();
    const app = createApp({
      agent: {} as never,
      projects: new ProjectAssistant(repos, llm, crm, { monthlyTokenLimit: 0 }),
      repos,
      crm,
      corsOrigin: '',
    });

    const res = await app.request('/assistant/projects/tasks/no-es-un-id/summary', {
      method: 'POST',
      headers: { 'X-Organization-Id': 'org-1', 'X-User-Id': 'user-1', Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(400);
    expect(crm.calls).toHaveLength(0);
  });
});
