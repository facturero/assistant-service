/**
 * Tablas y gráficos solo cuando la persona los pide (decisión del dueño, 2026-11-24). El prompt ya lo dice, pero el modelo
 * no lo cumple siempre: con muchos datos tiende a responder con una tabla aunque nadie la pidiera (banco de modelos: 2 de 7
 * casos con la regla escrita en el prompt). Aquí se hace cumplir sin depender del modelo: si el último mensaje de la persona
 * no pide una tabla, las tablas de la respuesta se vuelven listas; si no pide un gráfico, el bloque `grafico` se vuelve una
 * lista con sus valores. No se pierde ningún dato, solo cambia la forma.
 */

/** ¿Pide una tabla o un gráfico? Mismo criterio literal que el prompt. */
export const asksForTable = (userText: string) => /tabla/i.test(userText);
export const asksForChart = (userText: string) => /gr[aá]f[ií]c/i.test(userText);

const ROW = /^\s*\|.*\|\s*$/;
const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const CHART_FENCE = /^```\s*(grafico|gráfico|chart)\s*$/i;

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

/** `| Cliente | Deuda |` + filas → `- Ferretería: Deuda 3,120.50`. La primera columna nombra el elemento. */
function tablesToLists(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (ROW.test(line) && i + 1 < lines.length && SEPARATOR.test(lines[i + 1]!)) {
      const head = cells(line);
      let j = i + 2;
      while (j < lines.length && ROW.test(lines[j]!)) {
        const row = cells(lines[j]!);
        const rest = head
          .slice(1)
          .map((h, k) => (row[k + 1] ? `${h.replace(/\*\*/g, '')} ${row[k + 1]}` : ''))
          .filter(Boolean)
          .join(', ');
        out.push(`- ${row[0] ?? ''}${rest ? `: ${rest}` : ''}`);
        j++;
      }
      i = j - 1;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Bloque ```grafico con JSON → lista `- etiqueta: valor unidad`. Si el JSON no se entiende, el bloque se quita entero. */
function chartsToLists(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (CHART_FENCE.test(line.trim())) {
      const end = lines.findIndex((l, j) => j > i && l.trim() === '```');
      if (end > i) {
        try {
          const spec = JSON.parse(lines.slice(i + 1, end).join('\n')) as { title?: string; labels?: unknown[]; values?: unknown[]; unit?: string };
          if (spec.title) out.push(`${spec.title}:`);
          (spec.labels ?? []).forEach((l, k) => out.push(`- ${String(l)}: ${String(spec.values?.[k] ?? '')}${spec.unit ? ` ${spec.unit}` : ''}`));
        } catch {
          // Un gráfico ilegible no aporta nada en texto.
        }
        i = end;
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

export function enforceRequestedFormat(reply: string, userText: string): string {
  let text = reply;
  if (!asksForChart(userText)) text = chartsToLists(text);
  if (!asksForTable(userText)) text = tablesToLists(text);
  return text;
}
