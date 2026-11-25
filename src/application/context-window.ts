import { ContentBlock } from '../domain/entities';
import { LlmMessage } from './ports';

/**
 * Que el historial quepa en la ventana del modelo.
 *
 * **El problema (2026-11-25).** Cada turno manda la conversación entera, con los resultados del CRM incluidos. vLLM corre con
 * `--max-model-len 16384` y hay que dejarle 4000 a la respuesta; el prompt del sistema y las 29 herramientas ya ocupan unos
 * 5800 (medido con el tokenizador de vLLM). Quedan ~6500 para el historial: dos o tres preguntas con listas. A partir de ahí
 * vLLM responde 400 y la conversación queda muerta para siempre, porque cada mensaje nuevo la hace más larga.
 *
 * **Por qué compactar y no bloquear.** Bloquear obliga a abrir otra conversación justo cuando la persona está a mitad de algo.
 * Casi todas las preguntas se sostienen solas, y lo que el modelo necesita de las anteriores es lo que se dijo, no las listas
 * crudas que leyó para decirlo. Así que se recorta en este orden, y solo lo necesario:
 *
 * 1. De los turnos anteriores al actual se quitan las llamadas a herramientas y sus resultados (lo más pesado). Queda la
 *    conversación: lo que preguntó la persona y lo que contestó el asistente. Si hace falta un dato de entonces, el modelo
 *    vuelve a consultarlo, y además fresco.
 * 2. Si aún no cabe, se olvidan los turnos más antiguos enteros. Esto sí se le dice a la persona (`dropped`).
 * 3. Si ni el turno actual solo cabe (una lista enorme, un texto pegado gigante), no se manda: se pide algo más acotado.
 *
 * El turno actual nunca se recorta: es el que está usando herramientas ahora mismo y el formato exige cada `tool_result` junto
 * a su `tool_use`.
 */

/**
 * Estimación de tokens sin tokenizador, a propósito por lo alto. Medido con el de Qwen (vLLM `/tokenize`, 2026-11-25): la
 * prosa en español sale a ~5,2 caracteres por token, el prompt y los esquemas a ~3,5, y el JSON del CRM (ids, cifras) a ~2.
 */
const CHARS_PER_TOKEN_TEXT = 3;
const CHARS_PER_TOKEN_DATA = 1.9;
/** Lo que añade la plantilla de chat por cada mensaje (rol, separadores). */
const MESSAGE_OVERHEAD = 8;

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_TEXT);
}

function blockTokens(block: ContentBlock): number {
  if (block.type === 'text') return estimateTextTokens(String(block.text ?? ''));
  if (block.type === 'tool_use') return Math.ceil(JSON.stringify(block.input ?? {}).length / CHARS_PER_TOKEN_DATA) + 10;
  if (block.type === 'tool_result') {
    const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? null);
    return Math.ceil(content.length / CHARS_PER_TOKEN_DATA) + 10;
  }
  return Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN_DATA);
}

export function estimateMessagesTokens(messages: LlmMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += MESSAGE_OVERHEAD;
    total += typeof m.content === 'string' ? estimateTextTokens(m.content) : m.content.reduce((s, b) => s + blockTokens(b), 0);
  }
  return total;
}

export type CompactionStage = 'none' | 'tools' | 'dropped';

export interface FittedHistory {
  messages: LlmMessage[];
  stage: CompactionStage;
}

/** Hay más historial del que cabe incluso dejando solo el turno actual. */
export class ContextOverflowError extends Error {}

const blocksOf = (m: LlmMessage): ContentBlock[] =>
  typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;

/** Lo que escribió la persona (texto), y no un mensaje de `tool_result` que el sistema pone con rol de usuario. */
function isUserInput(m: LlmMessage): boolean {
  return m.role === 'user' && blocksOf(m).some((b) => b.type === 'text');
}

/** Cada turno empieza en un mensaje escrito por la persona. Lo que haya antes del primero cuenta como un turno más. */
function splitTurns(messages: LlmMessage[]): LlmMessage[][] {
  const turns: LlmMessage[][] = [];
  for (const m of messages) {
    if (isUserInput(m) || turns.length === 0) turns.push([m]);
    else turns[turns.length - 1]!.push(m);
  }
  return turns;
}

/** Un turno ya cerrado, sin herramientas: la pregunta y la respuesta. */
function withoutTools(turn: LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const m of turn) {
    const kept = blocksOf(m).filter((b) => b.type === 'text' && String(b.text ?? '').trim() !== '');
    if (kept.length > 0) out.push({ role: m.role, content: kept });
  }
  return out;
}

/**
 * Dos mensajes seguidos del mismo rol se funden: aparecen al quitar herramientas (texto, `tool_use`, `tool_result`, texto) o al
 * cortar un turno que se quedó sin respuesta. Algunas plantillas de chat los rechazan y otras los leen mal.
 */
function mergeSameRole(messages: LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      out[out.length - 1] = { role: m.role, content: [...blocksOf(prev), ...blocksOf(m)] };
    } else {
      out.push(m);
    }
  }
  return out;
}

/**
 * El historial que se manda al modelo, recortado para que quepa en `budgetTokens`. No toca lo guardado: el historial completo
 * sigue en la base y la persona lo ve entero.
 */
export function fitHistory(messages: LlmMessage[], budgetTokens: number): FittedHistory {
  if (estimateMessagesTokens(messages) <= budgetTokens) return { messages, stage: 'none' };

  const turns = splitTurns(messages);
  const current = turns[turns.length - 1] ?? [];
  const older = turns.slice(0, -1).map(withoutTools).filter((t) => t.length > 0);

  const build = (kept: LlmMessage[][]) => mergeSameRole([...kept.flat(), ...current]);

  let candidate = build(older);
  if (estimateMessagesTokens(candidate) <= budgetTokens) return { messages: candidate, stage: 'tools' };

  // Se olvidan desde el principio. El primer mensaje sigue siendo de la persona: los turnos empiezan por ella.
  for (let drop = 1; drop <= older.length; drop++) {
    candidate = build(older.slice(drop));
    if (estimateMessagesTokens(candidate) <= budgetTokens) return { messages: candidate, stage: 'dropped' };
  }
  throw new ContextOverflowError(`el turno actual no cabe (${estimateMessagesTokens(current)} > ${budgetTokens} tokens)`);
}
