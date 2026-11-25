import { describe, expect, it } from 'vitest';
import { ContextOverflowError, estimateMessagesTokens, fitHistory } from '../application/context-window';
import { LlmMessage } from '../application/ports';
import { Agent } from '../application/agent';
import { createInMemoryRepositories, ctx, FakeCrmApi, ScriptedLlm, textBlock, toolUseBlock } from './helpers';

/**
 * Que una conversación larga no muera con un 400 de vLLM (2026-11-25): primero se sueltan los resultados viejos del CRM,
 * luego los turnos más antiguos, y el turno actual nunca se toca.
 */
const LISTA = JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ id: `id-${i}-aaaaaaaa`, nombre: `Producto ${i}`, precio: '12.99' })));

function turnoConHerramienta(n: number): LlmMessage[] {
  return [
    { role: 'user', content: [textBlock(`Pregunta ${n}`)] },
    { role: 'assistant', content: [toolUseBlock(`tu_${n}`, 'listar_productos', {})] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${n}`, content: LISTA }] },
    { role: 'assistant', content: [textBlock(`Respuesta ${n}`)] },
  ];
}

const textos = (ms: LlmMessage[]) =>
  ms.flatMap((m) => (typeof m.content === 'string' ? [m.content] : m.content.filter((b) => b.type === 'text').map((b) => String(b.text))));

describe('fitHistory', () => {
  it('si cabe, no toca nada', () => {
    const historial = turnoConHerramienta(1);
    expect(fitHistory(historial, 100_000)).toEqual({ messages: historial, stage: 'none' });
  });

  it('primero quita herramientas de los turnos viejos y deja la conversación', () => {
    const historial = [...turnoConHerramienta(1), ...turnoConHerramienta(2), ...turnoConHerramienta(3)];
    const actual = turnoConHerramienta(3);
    const presupuesto = estimateMessagesTokens(actual) + 100;
    const r = fitHistory(historial, presupuesto);
    expect(r.stage).toBe('tools');
    expect(textos(r.messages)).toEqual(['Pregunta 1', 'Respuesta 1', 'Pregunta 2', 'Respuesta 2', 'Pregunta 3', 'Respuesta 3']);
    // El turno actual va entero, con su tool_use y su tool_result.
    expect(r.messages.slice(-4)).toEqual(actual);
    expect(estimateMessagesTokens(r.messages)).toBeLessThanOrEqual(presupuesto);
  });

  it('si aún no cabe, olvida los turnos más antiguos y empieza por un mensaje de la persona', () => {
    const historial = [...turnoConHerramienta(1), ...turnoConHerramienta(2), ...turnoConHerramienta(3)];
    const presupuesto = estimateMessagesTokens(turnoConHerramienta(3)) + 25;
    const r = fitHistory(historial, presupuesto);
    expect(r.stage).toBe('dropped');
    expect(r.messages[0]!.role).toBe('user');
    expect(textos(r.messages)).not.toContain('Pregunta 1');
    expect(textos(r.messages)).toContain('Pregunta 3');
  });

  it('no deja dos mensajes seguidos del mismo rol', () => {
    // Un turno viejo que falló a mitad: la persona preguntó, hubo herramientas y nunca llegó la respuesta.
    const roto: LlmMessage[] = [
      { role: 'user', content: [textBlock('Pregunta rota')] },
      { role: 'assistant', content: [toolUseBlock('tu_x', 'listar_productos', {})] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_x', content: LISTA }] },
    ];
    const r = fitHistory([...roto, ...turnoConHerramienta(2)], estimateMessagesTokens(turnoConHerramienta(2)) + 50);
    for (let i = 1; i < r.messages.length; i++) expect(r.messages[i]!.role).not.toBe(r.messages[i - 1]!.role);
  });

  it('si ni el turno actual cabe, lo dice en vez de mandar algo que el modelo rechazará', () => {
    expect(() => fitHistory(turnoConHerramienta(1), 50)).toThrow(ContextOverflowError);
  });
});

describe('agente con ventana limitada', () => {
  it('una conversación larga con listas sigue respondiendo; basta con soltar las listas viejas', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi();
    // Seis turnos con listas grandes: sin recorte serían ~20.000 tokens.
    const turnos = Array.from({ length: 6 }, (_, i) => [
      { content: [toolUseBlock(`tu_${i}`, 'listar_clientes', {})], stopReason: 'tool_use' },
      { content: [textBlock(`Respuesta ${i}`)] },
    ]).flat();
    const llm = new ScriptedLlm(turnos);
    const big = new FakeCrmApi(() => ({ ok: true, status: 200, body: JSON.parse(LISTA).concat(JSON.parse(LISTA)) }));
    const agent = new Agent(repos, llm, big, { maxIterations: 5, monthlyTokenLimit: 0, contextTokens: 16_384, maxOutputTokens: 4000 });
    let conversationId: string | null = null;
    let ultimo;
    for (let i = 0; i < 6; i++) {
      ultimo = await agent.startOrContinue({ conversationId, text: `Pregunta ${i}`, ctx });
      conversationId = ultimo.conversationId;
    }
    expect(ultimo!.reply).toBe('Respuesta 5');
    // Solo se soltaron los resultados viejos del CRM: no se olvidó nada de lo hablado, no hay que avisar.
    expect(ultimo!.contextTrimmed).toBe(false);
    const enviado = JSON.stringify(llm.calls[llm.calls.length - 1]!.messages);
    expect(enviado).toContain('Pregunta 5');
    expect(crm.calls).toHaveLength(0);
    // Se mandó menos de lo que cabe: la ventana menos la respuesta.
    expect(estimateMessagesTokens(llm.calls[llm.calls.length - 1]!.messages as LlmMessage[])).toBeLessThan(16_384 - 4000);
  });

  it('con mucha conversación olvida el principio y lo avisa', async () => {
    const parrafo = 'Este es un análisis largo de la cobranza del mes con detalle por cliente y recomendaciones. '.repeat(30);
    const llm = new ScriptedLlm(Array.from({ length: 12 }, () => ({ content: [textBlock(parrafo)] })));
    const agent = new Agent(createInMemoryRepositories(), llm, new FakeCrmApi(), { maxIterations: 5, monthlyTokenLimit: 0, contextTokens: 16_384, maxOutputTokens: 4000 });
    let conversationId: string | null = null;
    let ultimo;
    for (let i = 0; i < 12; i++) {
      ultimo = await agent.startOrContinue({ conversationId, text: `Pregunta ${i}`, ctx });
      conversationId = ultimo.conversationId;
    }
    expect(ultimo!.contextTrimmed).toBe(true);
    const enviado = JSON.stringify(llm.calls[llm.calls.length - 1]!.messages);
    expect(enviado).not.toContain('Pregunta 0"');
    expect(enviado).toContain('Pregunta 11');
  });

  it('una lista que no cabe ni sola da un error claro (422), no un 400 del modelo', async () => {
    const enorme = Array.from({ length: 3000 }, (_, i) => ({ id: `cliente-${i}-xxxxxxxxxxxx`, nombre: `Cliente ${i}` }));
    const crm = new FakeCrmApi(() => ({ ok: true, status: 200, body: enorme }));
    const llm = new ScriptedLlm([{ content: [toolUseBlock('tu_1', 'listar_clientes', {})], stopReason: 'tool_use' }]);
    const agent = new Agent(createInMemoryRepositories(), llm, crm, { maxIterations: 5, monthlyTokenLimit: 0, contextTokens: 16_384, maxOutputTokens: 4000 });
    await expect(agent.startOrContinue({ conversationId: null, text: 'Todos los clientes', ctx })).rejects.toMatchObject({
      code: 'ASSISTANT_CONTEXT_TOO_LONG',
      status: 422,
    });
  });
});
