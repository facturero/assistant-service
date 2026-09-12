import { describe, expect, it, vi, afterEach } from 'vitest';
import { OpenAiCompatibleLlm } from '../infrastructure/openai/compatible-llm';

/**
 * La traducción entre los dos formatos es el sitio perfecto para un fallo mudo:
 * si un `tool_use_id` no vuelve igual, el turno suspendido no se puede reanudar
 * y la acción pendiente se queda colgada para siempre. Aquí se fija.
 */
function responder(payload: unknown, captura?: (body: any) => void) {
  return vi.fn(async (_url: string, init: any) => {
    captura?.(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => payload } as unknown as Response;
  });
}

const llm = (fetchMock: any) => {
  vi.stubGlobal('fetch', fetchMock);
  return new OpenAiCompatibleLlm({
    baseURL: 'http://ollama:11434/v1',
    model: 'gemma4:12b',
    maxTokens: 4000,
    timeoutMs: 5000,
  });
};

afterEach(() => vi.unstubAllGlobals());

describe('OpenAiCompatibleLlm — de OpenAI a bloques del agente', () => {
  it('una llamada a herramienta se convierte en tool_use con su id', async () => {
    const turno = await llm(
      responder({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [
                { id: 'call_abc', function: { name: 'listar_roles', arguments: '{"limit":5}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 45, completion_tokens: 81 },
      }),
    ).complete({ system: 's', messages: [], tools: [] });

    expect(turno.content).toEqual([
      { type: 'tool_use', id: 'call_abc', name: 'listar_roles', input: { limit: 5 } },
    ]);
    expect(turno.stopReason).toBe('tool_use');
    expect(turno.usage).toEqual({ inputTokens: 45, outputTokens: 81, cacheReadTokens: 0 });
  });

  it('acepta argumentos ya parseados, que es lo que devuelve Ollama a veces', async () => {
    const turno = await llm(
      responder({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'x', arguments: { a: 1 } } }] },
          },
        ],
      }),
    ).complete({ system: 's', messages: [], tools: [] });
    expect(turno.content[0]).toMatchObject({ type: 'tool_use', input: { a: 1 } });
  });

  it('con JSON roto no ejecuta nada: lo convierte en texto', async () => {
    const turno = await llm(
      responder({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'crear_rol', arguments: '{rot' } }] },
          },
        ],
      }),
    ).complete({ system: 's', messages: [], tools: [] });

    expect(turno.content.some((b) => b.type === 'tool_use')).toBe(false);
    expect(String(turno.content[0]!.text)).toContain('crear_rol');
  });
});

describe('OpenAiCompatibleLlm — de bloques del agente a OpenAI', () => {
  it('un resultado de herramienta viaja como mensaje tool con su id', async () => {
    let enviado: any;
    await llm(responder({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }, (b) => (enviado = b)))
      .complete({
        system: 'prompt',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'crea el rol' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu-1', name: 'crear_rol', input: { name: 'Cajero' } }],
          },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: '{"id":"r1"}' }] },
        ],
        tools: [{ name: 'crear_rol', description: 'd', input_schema: { type: 'object' } }],
      });

    expect(enviado.messages[0]).toEqual({ role: 'system', content: 'prompt' });
    expect(enviado.messages[1]).toEqual({ role: 'user', content: 'crea el rol' });
    expect(enviado.messages[2]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'tu-1', type: 'function', function: { name: 'crear_rol', arguments: '{"name":"Cajero"}' } }],
    });
    // El id tiene que volver idéntico: de eso depende reanudar el turno.
    expect(enviado.messages[3]).toEqual({ role: 'tool', tool_call_id: 'tu-1', content: '{"id":"r1"}' });
  });

  it('las herramientas se declaran en el formato de funciones', async () => {
    let enviado: any;
    await llm(responder({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }, (b) => (enviado = b)))
      .complete({
        system: 's',
        messages: [],
        tools: [{ name: 'listar_roles', description: 'Lista', input_schema: { type: 'object' } }],
      });
    expect(enviado.tools).toEqual([
      { type: 'function', function: { name: 'listar_roles', description: 'Lista', parameters: { type: 'object' } } },
    ]);
  });
});
