import { ContentBlock } from '../../domain/entities';
import { AssistantUnavailableError } from '../../domain/errors';
import { LlmMessage, LlmPort, LlmTurn } from '../../application/ports';

export interface OpenAiCompatibleOptions {
  /** Raíz de la API, sin `/chat/completions`. Ej: `http://ollama:11434/v1`. */
  baseURL: string;
  /** Vacío para un modelo local: no todos piden credencial. */
  apiKey?: string | undefined;
  model: string;
  maxTokens: number;
  /** Un modelo local puede tardar minutos. El de Anthropic, no. */
  timeoutMs: number;
}

/**
 * Adaptador para cualquier servicio que hable el formato de OpenAI: Ollama en
 * local, y las capas gratuitas de Groq, Gemini u OpenRouter.
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
export class OpenAiCompatibleLlm implements LlmPort {
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
      content: toAnthropicBlocks(eleccion.message ?? {}),
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
      throw new AssistantUnavailableError(motivo);
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
