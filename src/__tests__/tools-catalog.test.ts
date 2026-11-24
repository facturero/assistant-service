import { describe, expect, it } from 'vitest';
import { agingTrim, availableTools, mapList, statementTrim, TOOLS, TOOLS_BY_NAME, usd } from '../domain/tools';

const names = (tools: { name: string }[]) => tools.map((t) => t.name);

describe('catálogo de herramientas — qué se le ofrece al modelo', () => {
  it('sin datos de permisos ni módulos se ofrecen todas (como antes de filtrar)', () => {
    expect(availableTools(null, null)).toHaveLength(TOOLS.length);
  });

  it('solo las de los módulos activos y los permisos del rol', () => {
    const ofrecidas = names(availableTools(['customer:read'], new Set(['crm.contacts'])));
    expect(ofrecidas).toEqual(expect.arrayContaining(['listar_clientes', 'ver_cliente', 'listar_tipos_identificacion', 'ver_organizacion', 'listar_permisos']));
    // Sin el módulo de facturación ni el de cobranza:
    expect(ofrecidas).not.toContain('listar_facturas');
    expect(ofrecidas).not.toContain('cuentas_por_cobrar');
    // Con el módulo pero sin el permiso de crear:
    expect(ofrecidas).not.toContain('crear_cliente');
  });

  it("el permiso '*' abre todos los permisos, pero no los módulos que la empresa no tiene", () => {
    const ofrecidas = names(availableTools(['*'], new Set(['finance.accounts_receivable_payable'])));
    expect(ofrecidas).toContain('antiguedad_cobranza');
    expect(ofrecidas).toContain('crear_rol');
    expect(ofrecidas).not.toContain('stock_producto');
  });

  it('cada herramienta de un módulo del catálogo declara su módulo: si no, se ofrecería a quien no lo tiene', () => {
    const conModulo = ['/customers', '/products', '/invoices', '/establishments', '/treasury', '/stock', '/warehouses', '/purchasing', '/projects', '/accounting', '/identification-types'];
    for (const t of TOOLS) {
      if (conModulo.some((p) => t.path.startsWith(p))) expect(t.plugin, t.name).toBeTruthy();
    }
  });

  it('crear_cliente remite a una herramienta que existe', () => {
    expect(TOOLS_BY_NAME.has('listar_tipos_identificacion')).toBe(true);
  });
});

describe('recortes — el dinero llega en dólares y las listas acotadas', () => {
  it('centavos a dólares con dos decimales', () => {
    expect(usd(169245)).toBe('1692.45');
    expect(usd('-500')).toBe('-5.00');
    expect(usd(null)).toBe(null);
  });

  it('una lista larga se corta y avisa cuántas hay', () => {
    const r = mapList({ items: Array.from({ length: 80 }, (_, i) => ({ i })), total: 80 }, (x) => x) as any;
    expect(r.items).toHaveLength(50);
    expect(r.aviso).toContain('80');
  });

  it('la antigüedad trae totales y tramos ya sumados, en dólares', () => {
    const r = agingTrim(
      {
        asOf: '2026-11-24',
        totals: { currentCents: 1000, days1To30Cents: 0, days31To60Cents: 0, days61To90Cents: 0, daysOver90Cents: 250000, totalCents: 251000 },
        customers: [{ customerId: 'c-1', customerName: 'Ferretería El Clavo', daysOver90Cents: 250000, totalCents: 250000 }],
      },
      'customers',
      'customerName',
      'customerId',
    ) as any;
    expect(r.totales.total).toBe('2510.00');
    expect(r.detalle[0]).toMatchObject({ nombre: 'Ferretería El Clavo', mas_90: '2500.00', total: '2500.00' });
  });

  it('el estado de resultados deja las secciones con total y quita las cuentas en cero', () => {
    const r = statementTrim({
      from: '2026-10-01',
      to: '2026-10-31',
      totals: { netIncomeCents: 50000 },
      sections: [{ key: 'income', totalCents: 150000, rows: [{ code: '4.1', name: 'Ventas', level: 2, amountCents: 150000 }, { code: '4.2', name: 'Otros', level: 2, amountCents: 0 }] }],
    }) as any;
    expect(r.totales.netIncome).toBe('500.00');
    expect(r.secciones[0].cuentas).toEqual([{ codigo: '4.1', cuenta: 'Ventas', nivel: 2, importe: '1500.00' }]);
  });
});
