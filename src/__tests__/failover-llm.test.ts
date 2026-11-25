import { describe, expect, it } from 'vitest';
import { FailoverLlm } from '../infrastructure/openai/failover-llm';
import { LlmEndpointDownError } from '../infrastructure/openai/compatible-llm';
import { AssistantUnavailableError } from '../domain/errors';
import { LlmTurn } from '../application/ports';

/**
 * La 5070 primero y la 4070 de respaldo. Lo que no puede pasar: que una caída del primero deje a la persona sin respuesta,
 * que un error de la petición (400) se reintente en el otro como si fuera una caída, o que el primero no recupere su sitio.
 */
class FakeLlm {
  calls = 0;
  constructor(
    private readonly name: string,
    public behave: 'ok' | 'down' | 'bad-request' = 'ok',
  ) {}
  private async act(): Promise<void> {
    this.calls++;
    if (this.behave === 'down') throw new LlmEndpointDownError('no se pudo conectar con el modelo');
    if (this.behave === 'bad-request') throw new AssistantUnavailableError('el proveedor devolvió un error');
  }
  async complete(): Promise<LlmTurn> {
    await this.act();
    return { content: [{ type: 'text', text: this.name }], stopReason: 'end_turn', stopDetails: null, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } };
  }
  async generate() {
    await this.act();
    return { data: { de: this.name }, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } };
  }
}

const turno = { system: 's', messages: [{ role: 'user' as const, content: 'hola' }], tools: [] };
const texto = (t: LlmTurn) => (t.content[0] as { text: string }).text;

function montar(salud: Record<string, boolean> = {}) {
  const r5070 = new FakeLlm('5070');
  const r4070 = new FakeLlm('4070');
  const fetchFn = (async (url: string) => {
    if (salud[url] === undefined) throw new Error('sin red');
    return { ok: salud[url] } as Response;
  }) as typeof fetch;
  const llm = new FailoverLlm(
    [
      { name: '5070', llm: r5070 as never, healthUrl: 'http://vllm/models' },
      { name: '4070', llm: r4070 as never, healthUrl: 'http://vllm-4070/models' },
    ],
    { probeIntervalMs: 0, probeTimeoutMs: 100, fetchFn, log: () => {} },
  );
  return { llm, r5070, r4070, salud };
}

describe('FailoverLlm', () => {
  it('con los dos vivos atiende el primero', async () => {
    const { llm, r4070 } = montar();
    expect(texto(await llm.complete(turno))).toBe('5070');
    expect(r4070.calls).toBe(0);
  });

  it('si el primero se cae, la misma petición la responde el respaldo, y las siguientes ya no lo intentan', async () => {
    const { llm, r5070 } = montar();
    r5070.behave = 'down';
    expect(texto(await llm.complete(turno))).toBe('4070');
    expect((await llm.generate({ system: 's', prompt: 'p', schema: {} })).data).toEqual({ de: '4070' });
    // La segunda petición fue directa al respaldo: el primero quedó marcado como caído.
    expect(r5070.calls).toBe(1);
    expect(llm.current()).toBe('4070');
  });

  it('el sondeo devuelve el sitio al primero cuando vuelve a responder', async () => {
    const { llm, r5070, salud } = montar({ 'http://vllm/models': false, 'http://vllm-4070/models': true });
    await llm.probeAll();
    expect(llm.current()).toBe('4070');

    salud['http://vllm/models'] = true;
    r5070.behave = 'ok';
    await llm.probeAll();
    expect(llm.current()).toBe('5070');
    expect(texto(await llm.complete(turno))).toBe('5070');
  });

  it('un error de la petición no se reintenta en el otro: fallaría igual', async () => {
    const { llm, r5070, r4070 } = montar();
    r5070.behave = 'bad-request';
    await expect(llm.complete(turno)).rejects.toBeInstanceOf(AssistantUnavailableError);
    expect(r4070.calls).toBe(0);
  });

  it('con los dos caídos devuelve el error de la caída', async () => {
    const { llm, r5070, r4070 } = montar();
    r5070.behave = 'down';
    r4070.behave = 'down';
    await expect(llm.complete(turno)).rejects.toBeInstanceOf(LlmEndpointDownError);
  });

  it('un servidor que no contesta al sondeo se marca caído', async () => {
    const { llm } = montar({ 'http://vllm-4070/models': true });
    await llm.probeAll();
    expect(llm.current()).toBe('4070');
  });
});

describe('FailoverLlm.status — lo que el chat usa para dejar o no escribir', () => {
  it('antes del primer sondeo se da por disponible: no cerrar el chat por no saber', () => {
    expect(montar().llm.status()).toEqual({ available: true, servers: 2, healthy: 2, checkedAt: null });
  });

  it('con la 5070 caída sigue disponible: atiende la 4070', async () => {
    const { llm } = montar({ 'http://vllm/models': false, 'http://vllm-4070/models': true });
    await llm.probeAll();
    expect(llm.status()).toMatchObject({ available: true, servers: 2, healthy: 1 });
    expect(llm.status().checkedAt).not.toBeNull();
  });

  it('con las dos caídas no está disponible, y vuelve en cuanto una responde', async () => {
    const { llm, salud } = montar({ 'http://vllm/models': false, 'http://vllm-4070/models': false });
    await llm.probeAll();
    expect(llm.status()).toMatchObject({ available: false, healthy: 0 });
    salud['http://vllm-4070/models'] = true;
    await llm.probeAll();
    expect(llm.status()).toMatchObject({ available: true, healthy: 1 });
  });

  it('una petición que encuentra los dos caídos también lo marca, sin esperar al sondeo', async () => {
    const { llm, r5070, r4070 } = montar();
    r5070.behave = 'down';
    r4070.behave = 'down';
    await expect(llm.complete(turno)).rejects.toBeInstanceOf(LlmEndpointDownError);
    expect(llm.status().available).toBe(false);
  });
});
