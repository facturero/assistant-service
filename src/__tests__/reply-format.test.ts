import { describe, expect, it } from 'vitest';
import { enforceRequestedFormat } from '../application/reply-format';
import { Agent } from '../application/agent';
import { createInMemoryRepositories, FakeCrmApi, ScriptedLlm, textBlock, ctx } from './helpers';

const TABLA = 'Te deben:\n| Cliente | Deuda (>90 días) |\n|---|---|\n| **Ferretería El Clavo** | $3,120.50 |\n| Juan Pérez | $1,195.00 |\nTotal: $4,315.50';
const GRAFICO = 'Ventas:\n```grafico\n{"type":"bar","title":"Octubre","labels":["Clavo","Sana"],"values":[1315,230.5],"unit":"USD"}\n```\nEl Clavo compra más.';

describe('tablas y gráficos solo si se piden', () => {
  it('sin pedir tabla, la tabla se vuelve lista y no se pierde ningún dato', () => {
    expect(enforceRequestedFormat(TABLA, '¿Quién me debe más de 90 días?')).toBe(
      'Te deben:\n- **Ferretería El Clavo**: Deuda (>90 días) $3,120.50\n- Juan Pérez: Deuda (>90 días) $1,195.00\nTotal: $4,315.50',
    );
  });

  it('si la pidió, la tabla se queda', () => {
    expect(enforceRequestedFormat(TABLA, 'Dámelo en una tabla')).toBe(TABLA);
  });

  it('sin pedir gráfico, el bloque se vuelve lista con sus valores', () => {
    expect(enforceRequestedFormat(GRAFICO, 'Ventas por cliente de octubre')).toBe(
      'Ventas:\nOctubre:\n- Clavo: 1315 USD\n- Sana: 230.5 USD\nEl Clavo compra más.',
    );
  });

  it('si lo pidió (gráfico, grafícame), el bloque se queda', () => {
    expect(enforceRequestedFormat(GRAFICO, 'Hazme un gráfico de ventas')).toBe(GRAFICO);
    expect(enforceRequestedFormat(GRAFICO, 'grafícame las ventas')).toBe(GRAFICO);
  });

  it('quita los ids internos: columnas de solo ids, «(ID: …)» y el id que encabeza un elemento; no los de los enlaces', () => {
    const id = '54817d92-3272-458b-afa5-fd98c4ffd122';
    const tabla = `| ID | Nombre | Estado |\n|---|---|---|\n| ${id} | PRUEBA Proveedor | activo |`;
    expect(enforceRequestedFormat(tabla, 'Dame una tabla de proveedores')).toBe('| Nombre | Estado |\n|---|---|\n| PRUEBA Proveedor | activo |');
    expect(enforceRequestedFormat(`- ${id}: Nombre PRUEBA Proveedor, Estado activo`, 'proveedores')).toBe('- Nombre PRUEBA Proveedor, Estado activo');
    expect(enforceRequestedFormat(`- PRUEBA Proveedor (ID: ${id}), activo`, 'proveedores')).toBe('- PRUEBA Proveedor, activo');
    expect(enforceRequestedFormat(`Mira su [ficha](/customers/${id}).`, 'cliente')).toBe(`Mira su [ficha](/customers/${id}).`);
  });

  it('el agente lo aplica con el último mensaje de la persona, antes de guardar y devolver', async () => {
    const repos = createInMemoryRepositories();
    const llm = new ScriptedLlm([{ content: [textBlock(TABLA)] }]);
    const result = await new Agent(repos, llm, new FakeCrmApi(), { maxIterations: 8, monthlyTokenLimit: 0 }).startOrContinue({
      conversationId: null,
      text: '¿Quién me debe más de 90 días?',
      ctx,
    });
    expect(result.reply).not.toContain('|');
    expect(result.reply).toContain('- Juan Pérez: Deuda (>90 días) $1,195.00');
    // Lo guardado es lo mismo que se devolvió: al reabrir la conversación no reaparece la tabla.
    expect(JSON.stringify(repos.__messages.at(-1)?.content)).not.toContain('|---|');
  });
});
