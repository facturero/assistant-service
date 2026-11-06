import { AssistantUnavailableError } from '../domain/errors';

/**
 * Lee el JSON que devolvió el modelo. Con salida estructurada debería llegar limpio, pero un modelo local (o una pasarela que
 * ignore `response_format`) a veces lo envuelve en ```json … ``` o le pone una frase delante: se toma desde la primera `{` hasta
 * la última `}`. Si ni así se puede leer, es un fallo del proveedor, no de la persona: 503 como el resto.
 */
export function parseJsonReply(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new AssistantUnavailableError('el modelo devolvió una respuesta que no se pudo leer');
  }
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    throw new AssistantUnavailableError('el modelo devolvió una respuesta que no se pudo leer');
  }
}
