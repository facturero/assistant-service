import { ContentBlock } from '../../domain/entities';
import { AssistantUnavailableError } from '../../domain/errors';
import { LlmMessage, LlmPort, LlmTurn, StructuredLlmPort } from '../../application/ports';
import { parseJsonReply } from '../../application/json-reply';

export interface OpenAiCompatibleOptions {
  /** Raíz de la API, sin `/chat/completions`. Ej: `http://ollama:11434/v1`. */
  baseURL: string;
  /** Vacío para un modelo local: no todos piden credencial. */
  apiKey?: string | undefined;
  model: string;
  maxTokens: number;
  /** Un modelo local puede tardar minutos. El de Anthropic, no. */
  timeoutMs: number;
  /**
   * Qué servidor hay detrás. El protocolo es el mismo, pero cada uno apaga el razonamiento a su manera y el otro modo le
   * sienta mal: vLLM valida `reasoning_effort` contra `low|medium|high` y responde 400 a `'none'`. Por defecto, Ollama.
   */
  server?: OpenAiCompatibleServer | undefined;
  /**
   * Razonamiento en los turnos del chat del agente (las respuestas JSON lo llevan siempre apagado). Sin poner, no se manda
   * nada y el modelo hace lo suyo. Importa más de lo que parece: medido el 2026-11-24 en la 4070 SUPER, gemma4:12b y
   * qwen3.5:9b suman mal cinco importes con el razonamiento apagado (1.592,45 y 1.612,45 en vez de 1.692,45) y bien con él.
   */
  chatReasoning?: ChatReasoning | undefined;
}

export type ChatReasoning = 'none' | 'low' | 'medium' | 'high';

/**
 * El servidor del modelo no está (apagado, sin red, colgado o devolviendo 5xx). Es la única falla en la que tiene sentido
 * probar con otro servidor: un 400 o un 401 son de la petición o de la configuración y fallarían igual en el otro.
 */
export class LlmEndpointDownError extends AssistantUnavailableError {}

export type OpenAiCompatibleServer = 'ollama' | 'vllm';

/**
 * Adaptador para cualquier servicio que hable el formato de OpenAI: vLLM u
 * Ollama en local, y las capas gratuitas de Groq, Gemini u OpenRouter.
 *
 * **Por qué existe traducción aquí y no en el resto del servicio.** El agente
 * guarda el historial en bloques con forma de Anthropic (`tool_use`,
 * `tool_result`) y de ahí dependen cosas que no se pueden mover: las acciones
 * pendientes se reanudan buscando por `tool_use_id`, y esos identificadores
 * están en la base de datos. Traducir aquí, en el borde, deja intacto todo lo
 * demás y permite cambiar de proveedor sin migrar una sola fila.
 *
 * Lo que este formato **no** tiene, y por eso cuesta más por token de lo que
 * parece: no hay caché de prompt. El prefijo entero se paga en cada llamada.
 * En un modelo local da igual porque no se paga nada; en uno de pago, no.
 */
export class OpenAiCompatibleLlm implements LlmPort, StructuredLlmPort {
  constructor(private readonly options: OpenAiCompatibleOptions) {}

  async complete(params: {
    system: string;
    messages: LlmMessage[];
    tools: Array<{ name: string; description: string; input_schema: unknown }>;
  }): Promise<LlmTurn> {
    const body = {
      model: this.options.model,
      max_tokens: this.options.maxTokens,
      temperature: 0,
      ...this.razonamientoChat(),
      messages: [
        { role: 'system', content: params.system },
        ...params.messages.flatMap(toOpenAiMessages),
      ],
      tools: params.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      })),
    };

    const respuesta = await this.post(body);
    const eleccion = respuesta?.choices?.[0];
    if (!eleccion) {
      throw new AssistantUnavailableError('el proveedor devolvió una respuesta vacía');
    }

    return {
      content: toAnthropicBlocks(rescatarRespuesta(eleccion)),
      stopReason: toStopReason(eleccion.finish_reason),
      stopDetails: null,
      usage: {
        inputTokens: Number(respuesta.usage?.prompt_tokens ?? 0),
        outputTokens: Number(respuesta.usage?.completion_tokens ?? 0),
        // Este formato no tiene caché de prompt. Cero es el dato honesto.
        cacheReadTokens: 0,
      },
    };
  }

  /**
   * Respuesta con forma fija. `response_format` con `json_schema` lo entienden Ollama (≥ 0.5), Groq, Gemini y OpenRouter; uno
   * que lo ignore devuelve texto libre y `parseJsonReply` intenta rescatar el JSON igualmente.
   */
  async generate(params: {
    system: string;
    prompt: string;
    schema: Record<string, unknown>;
  }): Promise<{ data: unknown; usage: LlmTurn['usage'] }> {
    const pedir = () =>
      this.post({
        model: this.options.model,
        // Un resumen o una lista de subtareas caben de sobra en 2.000 tokens. El tope importa más que el ahorro: si el modelo se
        // desboca, corta en segundos y no en minutos.
        max_tokens: Math.min(this.options.maxTokens, 2000),
        // Sin razonamiento. gemma4 en Ollama «pensaba» hasta llenar su ventana de 4.096 tokens (finish_reason `length`) y
        // devolvía `content` vacío tras 80 s; resumir texto ya escrito no lo necesita. Medido el 2026-11-06 con Ollama 0.32:
        // `reasoning_effort: 'none'` lo apaga (21 tokens de salida); `think: false` no surte efecto por esta ruta.
        ...this.sinRazonamiento(),
        temperature: 0,
        messages: [
          { role: 'system', content: params.system },
          { role: 'user', content: params.prompt },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'respuesta', strict: true, schema: params.schema } },
      });
    const contenido = (r: any) => r?.choices?.[0]?.message?.content;
    const vacio = (t: unknown) => typeof t !== 'string' || !t.trim();

    let respuesta = await pedir();
    // Red de seguridad para un `content` vacío suelto (un proveedor que ignore `reasoning_effort`, por ejemplo). Un reintento lo
    // cubre; dos vacíos seguidos ya son un fallo de verdad.
    if (vacio(contenido(respuesta))) respuesta = await pedir();
    const texto = contenido(respuesta);
    if (vacio(texto)) {
      throw new AssistantUnavailableError('el proveedor devolvió una respuesta vacía');
    }
    return {
      data: parseJsonReply(texto),
      usage: {
        inputTokens: Number(respuesta.usage?.prompt_tokens ?? 0),
        outputTokens: Number(respuesta.usage?.completion_tokens ?? 0),
        cacheReadTokens: 0,
      },
    };
  }

  /**
   * vLLM no entiende `reasoning_effort: 'none'` (400). Ahí el razonamiento se apaga en la plantilla de chat del modelo:
   * `enable_thinking` es la variable que leen las plantillas que piensan (Qwen3 y otras); las que no la usan la ignoran, así
   * que mandarla siempre es inocuo.
   */
  private sinRazonamiento(): Record<string, unknown> {
    return this.options.server === 'vllm'
      ? { chat_template_kwargs: { enable_thinking: false } }
      : { reasoning_effort: 'none' };
  }

  private razonamientoChat(): Record<string, unknown> {
    const nivel = this.options.chatReasoning;
    if (!nivel) return {};
    if (nivel === 'none') return this.sinRazonamiento();
    // vLLM solo entiende `reasoning_effort` en algunos modelos (gpt-oss); en el resto, pensar o no se decide en la plantilla.
    return this.options.server === 'vllm' ? { chat_template_kwargs: { enable_thinking: true } } : { reasoning_effort: nivel };
  }

  private async post(body: unknown): Promise<any> {
    const corte = AbortSignal.timeout(this.options.timeoutMs);
    let r: Response;
    try {
      r = await fetch(`${this.options.baseURL.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        signal: corte,
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const motivo = corte.aborted ? 'el modelo tardó demasiado' : 'no se pudo conectar con el modelo';
      console.error('[assistant-service] fallo al llamar al proveedor:', error);
      throw new LlmEndpointDownError(motivo);
    }

    if (!r.ok) {
      const detalle = await r.text().catch(() => '');
      console.error('[assistant-service] el proveedor devolvió', r.status, detalle.slice(0, 500));
      if (r.status === 401 || r.status === 403) {
        throw new AssistantUnavailableError('la configuración del servicio no es válida');
      }
      if (r.status === 429) {
        throw new AssistantUnavailableError('hay demasiadas peticiones ahora mismo, prueba en un minuto');
      }
      if (r.status >= 500) throw new LlmEndpointDownError('el proveedor devolvió un error');
      throw new AssistantUnavailableError('el proveedor devolvió un error');
    }
    return r.json();
  }
}

/** Un turno del historial, traducido a lo que espera el formato de OpenAI. */
function toOpenAiMessages(message: LlmMessage): Array<Record<string, unknown>> {
  const bloques: ContentBlock[] =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content;

  // Los resultados de herramienta no son mensajes de usuario aquí: cada uno es
  // su propio mensaje con rol 'tool', atado a la llamada por su identificador.
  const resultados = bloques.filter((b) => b.type === 'tool_result');
  if (resultados.length > 0) {
    return resultados.map((b) => ({
      role: 'tool',
      tool_call_id: String(b.tool_use_id),
      content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? null),
    }));
  }

  const texto = bloques
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('\n')
    .trim();

  if (message.role === 'assistant') {
    const llamadas = bloques.filter((b) => b.type === 'tool_use');
    return [
      {
        role: 'assistant',
        content: texto || null,
        ...(llamadas.length > 0
          ? {
              tool_calls: llamadas.map((b) => ({
                id: String(b.id),
                type: 'function',
                function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
              })),
            }
          : {}),
      },
    ];
  }

  return [{ role: 'user', content: texto }];
}

/**
 * qwen3.5 razonando, tras el resultado de una herramienta, contesta sin cerrar su bloque de razonamiento, y Ollama (0.32 y
 * 0.40.18, comprobado el 2026-11-24) le pone la respuesta entera en `reasoning` con `content` vacío. Sin esto la persona
 * recibía un mensaje en blanco aunque el modelo hubiera contestado bien. Solo se rescata cuando el turno terminó de verdad
 * (`stop`), sin texto y sin llamadas: en cualquier otro caso `reasoning` es razonamiento y no se enseña.
 */
function rescatarRespuesta(eleccion: Record<string, any>): Record<string, any> {
  const message = eleccion.message ?? {};
  const sinTexto = typeof message.content !== 'string' || !message.content.trim();
  const sinLlamadas = !Array.isArray(message.tool_calls) || message.tool_calls.length === 0;
  const razonamiento = message.reasoning ?? message.reasoning_content;
  if (eleccion.finish_reason === 'stop' && sinTexto && sinLlamadas && typeof razonamiento === 'string' && razonamiento.trim()) {
    return { ...message, content: razonamiento };
  }
  return message;
}

/** La respuesta del modelo, traducida a los bloques que guarda el agente. */
function toAnthropicBlocks(message: Record<string, any>): ContentBlock[] {
  const bloques: ContentBlock[] = [];

  const texto = typeof message.content === 'string' ? message.content.trim() : '';
  if (texto) bloques.push({ type: 'text', text: texto });

  for (const llamada of message.tool_calls ?? []) {
    const crudo = llamada?.function?.arguments;
    let input: unknown;
    try {
      // Ollama a veces devuelve el objeto ya parseado; el estándar, una cadena.
      input = typeof crudo === 'string' ? JSON.parse(crudo || '{}') : (crudo ?? {});
    } catch {
      // Un modelo pequeño puede escribir JSON roto. Ejecutar la herramienta con
      // argumentos inventados sería peor que no ejecutarla: se convierte en
      // texto para que la persona lo vea y lo vuelva a pedir.
      bloques.push({
        type: 'text',
        text: `Intenté usar ${String(llamada?.function?.name)} pero generé argumentos inválidos. Pídemelo otra vez, más concreto.`,
      });
      continue;
    }
    bloques.push({
      type: 'tool_use',
      id: String(llamada.id ?? `call_${Math.random().toString(36).slice(2, 10)}`),
      name: String(llamada?.function?.name ?? ''),
      input,
    });
  }

  return bloques;
}

function toStopReason(finishReason: unknown): string | null {
  switch (finishReason) {
    case 'tool_calls':
      return 'tool_use';
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return finishReason ? String(finishReason) : null;
  }
}
