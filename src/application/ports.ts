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
