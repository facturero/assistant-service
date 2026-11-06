import Anthropic from '@anthropic-ai/sdk';
import { LlmMessage, LlmPort, LlmTurn, StructuredLlmPort } from '../../application/ports';
import { parseJsonReply } from '../../application/json-reply';
import { AssistantUnavailableError } from '../../domain/errors';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClaudeOptions {
  apiKey: string;
  model: string;
  /**
   * Pasarela alternativa que hable el mismo protocolo (OpenCode Zen, por
   * ejemplo). `undefined` = la API de Anthropic. Va sin `/v1`.
   */
  baseURL?: string | undefined;
  /** Controla profundidad de razonamiento y, con ella, el gasto. */
  effort: Effort;
  maxTokens: number;
}

/**
 * Adaptador de Claude.
 *
 * Dos decisiones que conviene no deshacer sin querer:
 *
 * 1. **Se usa streaming aunque la respuesta se devuelva entera.** Un turno con
 *    varias herramientas encadenadas tarda, y sin streaming la petición se come
 *    el tiempo de espera del SDK. `finalMessage()` recompone el mensaje completo,
 *    así que el bucle del agente ni se entera.
 * 2. **El prompt de sistema se cachea.** Es la parte estable y se repite en cada
 *    vuelta del bucle y en cada mensaje de la conversación. Si
 *    `cache_read_input_tokens` sale cero en peticiones seguidas, es que algo del
 *    prefijo cambia en cada llamada: buscar ahí antes que en el modelo.
 *
 * Sirve igual para Anthropic y para una pasarela compatible: las dos exponen la
 * Messages API en `/v1/messages` y las dos leen la clave de `x-api-key`, así que
 * lo único que cambia es `baseURL`. Lo que **no** está garantizado fuera de
 * Anthropic es que se respeten los extras — la caché del prompt y el `effort` —;
 * si una pasarela los ignora, seguirá contestando, solo que más caro o con otra
 * profundidad. Se ve en `cache_read_input_tokens`.
 */
export class ClaudeLlm implements LlmPort, StructuredLlmPort {
  private readonly client: Anthropic;

  constructor(private readonly options: ClaudeOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      // `baseURL: undefined` deja la de Anthropic; el SDK le añade `/v1/messages`.
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  async complete(params: {
    system: string;
    messages: LlmMessage[];
    tools: Array<{ name: string; description: string; input_schema: unknown }>;
  }): Promise<LlmTurn> {
    try {
      const stream = this.client.messages.stream({
        model: this.options.model,
        max_tokens: this.options.maxTokens,
        system: [
          {
            type: 'text',
            text: params.system,
            cache_control: { type: 'ephemeral' },
          },
        ],
        output_config: { effort: this.options.effort },
        tools: params.tools as Anthropic.Tool[],
        messages: params.messages as Anthropic.MessageParam[],
      });

      const message = await stream.finalMessage();

      return {
        content: message.content as unknown as Record<string, unknown>[],
        stopReason: message.stop_reason ?? null,
        stopDetails: message.stop_details
          ? {
              category: message.stop_details.category ?? null,
              explanation: message.stop_details.explanation ?? null,
            }
          : null,
        usage: {
          inputTokens: message.usage.input_tokens ?? 0,
          outputTokens: message.usage.output_tokens ?? 0,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        },
      };
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Respuesta con forma fija (resúmenes y borradores de Proyectos). Esfuerzo `low` a propósito: resumir lo que ya está escrito no
   * pide razonamiento profundo, y cada botón que pulse alguien es una llamada. Sin caché del prompt: el de sistema de estas
   * peticiones es corto, por debajo del mínimo cacheable.
   */
  async generate(params: {
    system: string;
    prompt: string;
    schema: Record<string, unknown>;
  }): Promise<{ data: unknown; usage: LlmTurn['usage'] }> {
    try {
      const stream = this.client.messages.stream({
        model: this.options.model,
        max_tokens: this.options.maxTokens,
        system: params.system,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: params.schema } },
        messages: [{ role: 'user', content: params.prompt }],
      });
      const message = await stream.finalMessage();
      if (message.stop_reason === 'refusal') {
        throw new AssistantUnavailableError('el modelo no quiso responder a esta petición');
      }
      const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      return {
        data: parseJsonReply(text),
        usage: {
          inputTokens: message.usage.input_tokens ?? 0,
          outputTokens: message.usage.output_tokens ?? 0,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        },
      };
    } catch (error) {
      throw translateError(error);
    }
  }
}

/**
 * Errores tipados del SDK, de más concreto a más general. Nada de mirar el texto del mensaje: eso se rompe en cuanto cambia una
 * cadena. Lo que no es del SDK (un `AssistantUnavailableError` propio, un fallo de programación) sigue tal cual.
 */
function translateError(error: unknown): unknown {
  if (error instanceof Anthropic.RateLimitError) {
    return new AssistantUnavailableError('hay demasiadas peticiones ahora mismo, prueba en un minuto');
  }
  if (error instanceof Anthropic.AuthenticationError) {
    console.error('[assistant-service] credencial de Anthropic inválida');
    return new AssistantUnavailableError('la configuración del servicio no es válida');
  }
  if (error instanceof Anthropic.APIError) {
    console.error('[assistant-service] error de la API de Anthropic:', error.status, error.message);
    return new AssistantUnavailableError('el proveedor devolvió un error');
  }
  return error;
}
