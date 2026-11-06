import { ContentBlock } from '../domain/entities';

/**
 * El modelo vive detrás de este puerto a propósito: el bucle del agente no sabe
 * de qué proveedor viene la respuesta, y cambiar de modelo es configuración, no
 * una reescritura. La única implementación hoy es Claude (infrastructure/anthropic).
 */
export interface LlmTurn {
  content: ContentBlock[];
  stopReason: string | null;
  /** Solo viene relleno cuando `stopReason` es 'refusal'. */
  stopDetails: { category?: string | null; explanation?: string | null } | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[] | string;
}

export interface LlmPort {
  /**
   * Un turno: se le manda el historial y devuelve lo que el modelo produjo, que
   * puede ser texto, llamadas a herramientas, o ambas cosas.
   */
  complete(params: {
    system: string;
    messages: LlmMessage[];
    tools: Array<{ name: string; description: string; input_schema: unknown }>;
  }): Promise<LlmTurn>;
}

/**
 * Una sola respuesta con forma fija (JSON que cumple `schema`), sin conversación ni herramientas: resumir una tarea, redactar
 * el estado de un proyecto, proponer subtareas. Es otro puerto y no un modo de `complete` porque no comparte nada con el bucle
 * del agente: no hay historial que guardar, ni turno que suspender, ni herramientas que ejecutar.
 *
 * Cada proveedor usa su mecanismo nativo (`output_config.format` en Anthropic, `response_format` en el formato de OpenAI) y no
 * una herramienta forzada: los modelos nuevos de Anthropic rechazan `tool_choice` forzado con un 400.
 */
export interface StructuredLlmPort {
  generate(params: {
    system: string;
    prompt: string;
    /** JSON Schema de la respuesta. Todos los objetos con `additionalProperties: false` y todas sus claves en `required`. */
    schema: Record<string, unknown>;
  }): Promise<{ data: unknown; usage: LlmTurn['usage'] }>;
}

/**
 * La API del CRM vista desde el asistente. La implementación llama al gateway
 * con el JWT del usuario, que es lo que hace que los permisos y el aislamiento
 * por organización se apliquen solos.
 */
export interface CrmApiPort {
  call(params: {
    method: string;
    path: string;
    query?: Record<string, string>;
    body?: unknown;
    bearerToken: string;
  }): Promise<{ ok: boolean; status: number; body: unknown }>;
}
