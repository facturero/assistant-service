import { LlmMessage, LlmPort, LlmTurn, StructuredLlmPort } from '../../application/ports';
import { LlmEndpointDownError } from './compatible-llm';

/**
 * Dos (o más) servidores del modelo, en orden de preferencia: hoy la RTX 5070 primero y la 4070 SUPER de respaldo. Si el
 * primero no está, la petición va al siguiente sin que la persona note nada más que, quizá, otro estilo de respuesta.
 *
 * **Por qué se puede cambiar de servidor a mitad de una conversación.** El historial viaja entero en cada petición y en el
 * formato de OpenAI, con los `tool_call_id` que guarda el agente: ningún servidor tiene estado propio de la conversación.
 *
 * **Por qué hay sondeo y no solo «probar y caer».** Un equipo apagado con IP fija no siempre rechaza la conexión: a veces
 * no contesta y la llamada espera hasta el tope (minutos). El sondeo marca el servidor caído en segundos y las peticiones
 * siguientes ya ni lo intentan; cuando vuelve a responder, vuelve a ser el preferido solo.
 */
export interface FailoverEndpoint {
  name: string;
  llm: LlmPort & StructuredLlmPort;
  /** URL barata que responde 200 si el servidor está vivo: `<base>/models` en vLLM y Ollama. */
  healthUrl: string;
}

export interface FailoverOptions {
  probeIntervalMs: number;
  probeTimeoutMs: number;
  /** Se inyecta en los tests; en producción, el `fetch` global. */
  fetchFn?: typeof fetch;
  log?: (message: string) => void;
}

export class FailoverLlm implements LlmPort, StructuredLlmPort {
  /** `true` hasta que algo diga lo contrario: al arrancar no se sabe y lo sensato es intentar con el preferido. */
  private readonly healthy: boolean[];
  private timer: NodeJS.Timeout | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly log: (message: string) => void;

  constructor(
    private readonly endpoints: FailoverEndpoint[],
    private readonly options: FailoverOptions,
  ) {
    if (endpoints.length === 0) throw new Error('FailoverLlm necesita al menos un servidor');
    this.healthy = endpoints.map(() => true);
    this.fetchFn = options.fetchFn ?? fetch;
    this.log = options.log ?? ((m) => console.warn(`[assistant-service] ${m}`));
  }

  /** Arranca el sondeo periódico. El temporizador no retiene el proceso (`unref`). */
  start(): this {
    if (!this.timer && this.options.probeIntervalMs > 0) {
      void this.probeAll();
      this.timer = setInterval(() => void this.probeAll(), this.options.probeIntervalMs);
      this.timer.unref();
    }
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Quién atendería ahora mismo. Para los logs y los tests. */
  current(): string {
    return this.endpoints[this.order()[0]!]!.name;
  }

  complete(params: {
    system: string;
    messages: LlmMessage[];
    tools: Array<{ name: string; description: string; input_schema: unknown }>;
  }): Promise<LlmTurn> {
    return this.run((llm) => llm.complete(params));
  }

  generate(params: { system: string; prompt: string; schema: Record<string, unknown> }) {
    return this.run((llm) => llm.generate(params));
  }

  async probeAll(): Promise<void> {
    await Promise.all(this.endpoints.map((e, i) => this.probe(e, i)));
  }

  /** Los sanos primero, en su orden; detrás, los caídos, por si el sondeo se equivocó o todos están caídos. */
  private order(): number[] {
    const all = this.endpoints.map((_, i) => i);
    return [...all.filter((i) => this.healthy[i]), ...all.filter((i) => !this.healthy[i])];
  }

  private async run<T>(call: (llm: LlmPort & StructuredLlmPort) => Promise<T>): Promise<T> {
    let last: unknown;
    for (const i of this.order()) {
      try {
        const result = await call(this.endpoints[i]!.llm);
        this.mark(i, true);
        return result;
      } catch (error) {
        // Solo una caída del servidor justifica probar con otro. Un 400 o un 401 fallarían igual allí.
        if (!(error instanceof LlmEndpointDownError)) throw error;
        this.mark(i, false);
        last = error;
      }
    }
    throw last;
  }

  private async probe(endpoint: FailoverEndpoint, i: number): Promise<void> {
    try {
      const r = await this.fetchFn(endpoint.healthUrl, { signal: AbortSignal.timeout(this.options.probeTimeoutMs) });
      this.mark(i, r.ok);
    } catch {
      this.mark(i, false);
    }
  }

  private mark(i: number, ok: boolean): void {
    if (this.healthy[i] === ok) return;
    this.healthy[i] = ok;
    this.log(`modelo «${this.endpoints[i]!.name}» ${ok ? 'vuelve a responder' : 'no responde'}; atiende «${this.current()}»`);
  }
}
