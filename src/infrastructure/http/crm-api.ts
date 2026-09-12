import { CrmApiPort } from '../../application/ports';

/**
 * Cliente de la API del CRM.
 *
 * Llama al **api-gateway**, no a los servicios por dentro, y lo hace con el
 * `Authorization` del usuario que está conversando. Eso es lo que hace que el
 * gateway aplique sus permisos, inyecte su organización y compruebe el plugin
 * activo, exactamente igual que si la petición viniera del navegador.
 *
 * No añadas aquí un token de servicio ni una cabecera de confianza: sería darle
 * al asistente permisos que su usuario no tiene.
 */
export class CrmApi implements CrmApiPort {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async call(params: {
    method: string;
    path: string;
    query?: Record<string, string>;
    body?: unknown;
    bearerToken: string;
  }): Promise<{ ok: boolean; status: number; body: unknown }> {
    const url = new URL(params.path, this.baseUrl);
    for (const [key, value] of Object.entries(params.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        method: params.method,
        headers: {
          Authorization: `Bearer ${params.bearerToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: params.body === undefined ? undefined : JSON.stringify(params.body),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // Respuesta que no es JSON: se devuelve el texto tal cual para que el
        // modelo pueda al menos explicar qué pasó.
      }

      return { ok: response.ok, status: response.status, body: parsed };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        status: aborted ? 504 : 502,
        body: {
          error: aborted
            ? 'La consulta tardó demasiado y se canceló.'
            : 'No se pudo contactar con el servicio.',
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
