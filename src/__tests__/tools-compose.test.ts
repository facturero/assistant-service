import { describe, expect, it } from 'vitest';
import { TOOLS_BY_NAME, ToolApi, ToolResponse } from '../domain/tools';
import { Agent } from '../application/agent';
import { createInMemoryRepositories, FakeCrmApi, ScriptedLlm, toolUseBlock, ctx } from './helpers';

/** Una API de mentira por ruta, que apunta cada llamada. */
function fakeApi(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; query?: Record<string, string>; body?: unknown }> = [];
  const api: ToolApi = {
    async call(method, path, options = {}): Promise<ToolResponse> {
      calls.push({ method, path, query: options.query, body: options.body });
      const key = `${method} ${path}`;
      return key in routes ? { ok: true, status: 200, body: routes[key] } : { ok: false, status: 404, body: { code: 'NOT_FOUND' } };
    },
  };
  return { api, calls };
}

const PRODUCTOS = [
  { id: 'p1', name: 'Jugo natural 1 L', priceCents: 1299, status: 'inactive', type: 'good' },
  { id: 'p2', name: 'Producto Test NC', priceCents: 1000, status: 'active', type: 'good' },
  { id: 'p3', name: 'Pan integral', priceCents: 85, status: 'inactive', type: 'good' },
  { id: 'p4', name: 'SYNC Prod Uno', priceCents: 1249, status: 'inactive', type: 'good' },
];

describe('listar_productos — el orden lo pone el servidor', () => {
  const tool = TOOLS_BY_NAME.get('listar_productos')!;

  it('precio_desc con límite: los más caros, sin saltarse ninguno', async () => {
    const { api } = fakeApi({ 'GET /products': PRODUCTOS });
    const r = await tool.execute!({ orden: 'precio_desc', limit: 3 }, api);
    const trimmed = tool.trim!(r.body) as any;
    expect(trimmed.items.map((p: any) => [p.nombre, p.precio])).toEqual([
      ['Jugo natural 1 L', '12.99'],
      ['SYNC Prod Uno', '12.49'],
      ['Producto Test NC', '10.00'],
    ]);
    expect(trimmed.total).toBe(4);
  });

  it('pasa búsqueda y estado a la API', async () => {
    const { api, calls } = fakeApi({ 'GET /products': [] });
    await tool.execute!({ search: 'jugo', status: 'active' }, api);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/products', query: { search: 'jugo', status: 'active' } });
  });
});

describe('stock_por_producto — dos llamadas y la suma la hace el servidor', () => {
  const tool = TOOLS_BY_NAME.get('stock_por_producto')!;

  it('junta el nombre y suma las bodegas de cada producto', async () => {
    const { api, calls } = fakeApi({
      'GET /stock': {
        data: [
          { productId: 'p1', warehouseCode: 'MATRIZ', quantityOnHand: '40.0000', quantityReserved: '6.0000', quantityAvailable: '34.0000' },
          { productId: 'p1', warehouseCode: 'NORTE', quantityOnHand: '18.0000', quantityReserved: '0.0000', quantityAvailable: '18.0000' },
          { productId: 'p2', warehouseCode: 'MATRIZ', quantityOnHand: '3.5000', quantityReserved: '1.0000', quantityAvailable: '2.5000' },
        ],
        total: 3,
      },
      'GET /products': PRODUCTOS,
    });
    const r = await tool.execute!({ lowStock: true }, api);
    expect((r.body as any).items).toEqual([
      { producto: 'Jugo natural 1 L', disponible: 52, reservado: 6, total: 58, bodegas: 2 },
      { producto: 'Producto Test NC', disponible: 2.5, reservado: 1, total: 3.5, bodegas: 1 },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.query).toMatchObject({ lowStock: 'true', pageSize: '200' });
  });
});

describe('crear_producto — el cuerpo que exige product-service', () => {
  const tool = TOOLS_BY_NAME.get('crear_producto')!;

  it('precio en texto con dos decimales, moneda, tipo y todos los establecimientos activos', async () => {
    const { api, calls } = fakeApi({
      'GET /establishments': [
        { id: 'e1', status: 'active' },
        { id: 'e2', status: 'inactive' },
        { id: 'e3' },
      ],
      'POST /products': { id: 'nuevo' },
    });
    const r = await tool.execute!({ name: 'Mantenimiento mensual', priceCents: 2550, type: 'service' }, api);
    expect(r.ok).toBe(true);
    expect(calls[1]).toEqual({
      method: 'POST',
      path: '/products',
      query: undefined,
      body: { name: 'Mantenimiento mensual', type: 'service', price: '25.50', currencyCode: 'USD', establishmentIds: ['e1', 'e3'] },
    });
  });

  it('sin establecimientos activos no intenta crear', async () => {
    const { api, calls } = fakeApi({ 'GET /establishments': [] });
    const r = await tool.execute!({ name: 'X', priceCents: 100, type: 'good' }, api);
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(calls).toHaveLength(1);
  });

  it('crear_cliente exige el tipo, que customer-service no deja omitir', () => {
    expect(TOOLS_BY_NAME.get('crear_cliente')!.inputSchema.required).toEqual(['businessName', 'type']);
  });
});

describe('agente — una compuesta aprobada pasa por execute con el token del usuario', () => {
  it('confirmar crear_producto manda el cuerpo correcto a la API', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi((path) =>
      path === '/establishments' ? { ok: true, status: 200, body: [{ id: 'e1', status: 'active' }] } : { ok: true, status: 201, body: { id: 'nuevo' } },
    );
    const llm = new ScriptedLlm([
      { content: [toolUseBlock('tu_1', 'crear_producto', { name: 'Martillo', priceCents: 1250, type: 'good' })], stopReason: 'tool_use' },
      { content: [{ type: 'text', text: 'Listo.' }] },
    ]);
    const agent = new Agent(repos, llm, crm, { maxIterations: 8, monthlyTokenLimit: 0 });
    const first = await agent.startOrContinue({ conversationId: null, text: 'Crea el producto Martillo a 12,50', ctx });
    expect(first.pendingActions[0]?.summary).toBe('Crear el producto "Martillo" con precio 12.50, en todos los establecimientos');
    await agent.decideAction({ actionId: first.pendingActions[0]!.id, approve: true, ctx });
    const post = crm.calls.find((c) => c.method === 'POST' && c.path === '/products');
    expect(post?.body).toEqual({ name: 'Martillo', type: 'good', price: '12.50', currencyCode: 'USD', establishmentIds: ['e1'] });
  });
});

describe('revisión de escrituras antes de la tarjeta (prepare)', () => {
  const ROLES = [{ id: 'r-vend', name: 'Vendedor' }, { id: 'r-bod', name: 'Bodeguero' }];
  const invitar = TOOLS_BY_NAME.get('invitar_empleado')!;

  it('invitar_empleado: la tarjeta dice el nombre del rol', async () => {
    const { api } = fakeApi({ 'GET /roles': ROLES });
    expect(await invitar.prepare!({ email: 'ana@x.ec', roleIds: ['r-vend'] }, api)).toEqual({
      input: { email: 'ana@x.ec', roleIds: ['r-vend'] },
      summary: 'Invitar a ana@x.ec con el rol Vendedor',
    });
    expect(await invitar.prepare!({ email: 'ana@x.ec', roleIds: ['r-vend', 'r-bod'] }, api)).toMatchObject({
      summary: 'Invitar a ana@x.ec con los roles Vendedor, Bodeguero',
    });
  });

  it('invitar_empleado: acepta el rol por su nombre y lo pasa a id', async () => {
    const { api } = fakeApi({ 'GET /roles': ROLES });
    expect(await invitar.prepare!({ email: 'ana@x.ec', roleIds: ['vendedor'] }, api)).toMatchObject({ input: { roleIds: ['r-vend'] } });
  });

  it('invitar_empleado: un rol inventado es un error con la lista de roles, no una tarjeta', async () => {
    const { api } = fakeApi({ 'GET /roles': ROLES });
    const r = (await invitar.prepare!({ email: 'ana@x.ec', roleIds: ['vendor'] }, api)) as { error: string };
    expect(r.error).toContain('«vendor»');
    expect(r.error).toContain('Vendedor (id r-vend)');
  });

  it('crear_rol: un permiso que no está en el catálogo es un error', async () => {
    const { api } = fakeApi({ 'GET /permissions': [{ code: 'customer:read' }, { code: 'product:read' }] });
    const tool = TOOLS_BY_NAME.get('crear_rol')!;
    expect(await tool.prepare!({ name: 'Cajero', permissions: ['customer:read'] }, api)).toEqual({ input: { name: 'Cajero', permissions: ['customer:read'] } });
    expect(await tool.prepare!({ name: 'Cajero', permissions: ['customers:view'] }, api)).toEqual({
      error: 'Estos permisos no existen: customers:view. Usa solo códigos tal como los devuelve listar_permisos.',
    });
  });

  it('crear_cliente: con la misma identificación ya registrada, no hay tarjeta', async () => {
    const tool = TOOLS_BY_NAME.get('crear_cliente')!;
    const { api, calls } = fakeApi({ 'GET /customers': { items: [{ businessName: 'Ferretería El Clavo S.A.', identification: '1790012345001' }], total: 1 } });
    expect(await tool.prepare!({ businessName: 'Ferretería El Clavo', type: 'company', identification: '1790012345001' }, api)).toEqual({
      error: 'Ya existe el cliente «Ferretería El Clavo S.A.» con la identificación 1790012345001. No lo crees de nuevo: díselo a la persona.',
    });
    expect(calls[0]!.query).toEqual({ search: '1790012345001' });
    // Un número que solo contiene al buscado (LIKE) no es el mismo cliente.
    const otro = fakeApi({ 'GET /customers': { items: [{ businessName: 'Otro', identification: '17900123450019' }], total: 1 } });
    expect(await tool.prepare!({ businessName: 'X', type: 'company', identification: '1790012345001' }, otro.api)).toBeNull();
    // Sin identificación no se comprueba: dos personas pueden llamarse igual.
    expect(await tool.prepare!({ businessName: 'Juan Pérez', type: 'person' }, otro.api)).toBeNull();
  });

  it('agente: si no puede leer los roles, propone con el resumen simple', async () => {
    const crm = new FakeCrmApi(() => ({ ok: false, status: 403, body: { code: 'FORBIDDEN' } }));
    const llm = new ScriptedLlm([
      { content: [toolUseBlock('tu_1', 'invitar_empleado', { email: 'ana@x.ec', roleIds: ['r-vend'] })], stopReason: 'tool_use' },
    ]);
    const r = await new Agent(createInMemoryRepositories(), llm, crm, { maxIterations: 4, monthlyTokenLimit: 0 }).startOrContinue({ conversationId: null, text: 'Invita a ana@x.ec', ctx });
    expect(r.pendingActions[0]?.summary).toBe('Invitar a ana@x.ec con 1 rol(es) asignado(s)');
  });

  it('agente: un rol inventado vuelve al modelo, que corrige, y la tarjeta sale con el rol bueno', async () => {
    const crm = new FakeCrmApi((path) => (path === '/roles' ? { ok: true, status: 200, body: ROLES } : { ok: true, status: 200, body: {} }));
    const llm = new ScriptedLlm([
      { content: [toolUseBlock('tu_1', 'invitar_empleado', { email: 'ana@x.ec', roleIds: ['vendor'] })], stopReason: 'tool_use' },
      { content: [toolUseBlock('tu_2', 'invitar_empleado', { email: 'ana@x.ec', roleIds: ['r-vend'] })], stopReason: 'tool_use' },
    ]);
    const r = await new Agent(createInMemoryRepositories(), llm, crm, { maxIterations: 4, monthlyTokenLimit: 0 }).startOrContinue({ conversationId: null, text: 'Invita a ana@x.ec como vendedor', ctx });
    expect(r.pendingActions).toHaveLength(1);
    expect(r.pendingActions[0]).toMatchObject({ summary: 'Invitar a ana@x.ec con el rol Vendedor', input: { roleIds: ['r-vend'] } });
    expect(JSON.stringify(llm.calls[1]!.messages)).toContain('No existe ningún rol');
    expect(crm.calls.every((c) => c.method === 'GET')).toBe(true);
  });
});
