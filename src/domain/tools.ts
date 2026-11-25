/**
 * Catálogo de herramientas del asistente.
 *
 * Cada herramienta es **un endpoint que ya existe** en la API del CRM, llamado a
 * través del api-gateway con el JWT del usuario que está conversando. De esa
 * decisión salen gratis los permisos, el aislamiento por organización, la
 * validación, los eventos de outbox y la auditoría: el asistente no puede hacer
 * nada que el usuario no pudiera hacer pulsando botones.
 *
 * El día que alguien le dé un token de servicio "para simplificar", las cinco
 * cosas se caen a la vez. No lo hagas.
 *
 * `risk` decide qué pasa cuando el modelo la pide:
 *   - 'read'  → se ejecuta sola.
 *   - 'write' → se propone y se para hasta que una persona confirme.
 * Lo que no está en este catálogo sencillamente no existe para el asistente:
 * borrar la organización o desactivar usuarios no se ofrecen a propósito.
 */

export type ToolRisk = 'read' | 'write';

/**
 * El asistente **no factura**: puede consultar facturas para responder
 * preguntas, pero nunca emitir, anular ni modificar una, ni tocar la parte
 * fiscal (documentos electrónicos, certificados de firma). Una factura tiene
 * efectos tributarios que no se deshacen con un clic, y es decisión de producto
 * que eso lo haga siempre una persona desde la pantalla de facturación.
 *
 * Estas son las rutas de la API donde vive eso. Cualquier llamada que no sea
 * GET a una de ellas se bloquea en `callTool`, y hay un test que falla si
 * alguien añade al catálogo una herramienta de escritura que apunte aquí.
 */
export const BILLING_PATH_PREFIXES = ['/invoices', '/fiscal-invoices', '/certificates'];

export function isBillingWrite(method: string, path: string): boolean {
  if (method.toUpperCase() === 'GET') return false;
  return BILLING_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export interface ToolResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

/** La API del CRM tal como la ve una herramienta compuesta: el token del usuario ya va puesto. */
export interface ToolApi {
  call(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, options?: { query?: Record<string, string>; body?: unknown }): Promise<ToolResponse>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  risk: ToolRisk;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  /** Plantilla de ruta con `:param` sustituible por el input. */
  path: string;
  /** Esquema JSON de los argumentos, tal cual lo espera la API de Anthropic. */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  /** Campos que viajan en el query string (GET) en vez de en el cuerpo. */
  queryParams?: string[];
  /**
   * Módulo del catálogo que el gateway exige para esta ruta (`requiresPlugin`) y permiso que exige el servicio. Solo se le
   * ofrece al modelo lo que esta persona puede usar: cada herramienta ocupa ~120 tokens del contexto, y una que siempre
   * responde 403 solo sirve para que el modelo la intente. No es la barrera de seguridad —esa sigue siendo la API con el
   * JWT del usuario—, es no ofrecer lo que fallará.
   */
  plugin?: string;
  permission?: string;
  /**
   * Herramienta compuesta: en vez de mandar el input tal cual a `method path`, arma la respuesta con una o varias llamadas a
   * la API, siempre con el token del usuario (`api.call`). Sirve para lo que el modelo hacía mal o lento: ordenar (los
   * «más caros»), juntar dos consultas en una (stock con el nombre del producto, antes una llamada por producto) o adaptar
   * el cuerpo a lo que la API exige (precio en texto, moneda, establecimientos). Lo que devuelve pasa luego por `trim`.
   */
  execute?: (input: Record<string, unknown>, api: ToolApi) => Promise<ToolResponse>;
  /**
   * Frase en primera persona que se le enseña al usuario antes de confirmar.
   * Se escribe aquí y no se le pide al modelo: lo que se confirma tiene que
   * describir lo que de verdad va a pasar, no lo que el modelo dice que pasará.
   */
  summarize?: (input: Record<string, unknown>) => string;
  /**
   * Revisa una escritura contra el CRM ANTES de enseñar la tarjeta, con lecturas (GET). Devuelve:
   * - `{ input, summary }`: el input ya corregido (un rol por su nombre pasa a su id) y la frase de la tarjeta con nombres,
   *   no ids: quien confirma tiene que saber a qué dice que sí.
   * - `{ error }`: la escritura no puede salir bien (un rol que no existe). No se enseña tarjeta: el error vuelve al modelo
   *   como resultado de la herramienta y corrige en la misma conversación. Pasó en el banco del 2026-11-25: Qwen inventó
   *   el id `vendor` sin consultar los roles, y la tarjeta («con 1 rol(es)») no dejaba verlo.
   * - `null`: no se pudo comprobar (sin permiso de lectura, por ejemplo). Se propone tal cual, con `summarize`.
   */
  prepare?: (
    input: Record<string, unknown>,
    api: ToolApi,
  ) => Promise<{ input: Record<string, unknown>; summary?: string } | { error: string } | null>;

  /**
   * Recorta la respuesta de la API antes de que entre en la conversación.
   *
   * Esto no es un adorno, es la partida de gasto más grande del servicio. Un
   * resultado de herramienta **no se paga una vez**: se queda en el historial y
   * se reenvía entero en cada vuelta del bucle y en cada mensaje posterior del
   * hilo. Mandar un campo que el modelo no mira se paga tantas veces como
   * llamadas queden por delante.
   *
   * Solo se aplica cuando la llamada sale bien. Los errores llegan enteros: lo
   * que sobra en un listado es justo lo que hace falta para entender un fallo.
   */
  trim?: (body: unknown) => unknown;
}

/**
 * Las filas de una respuesta de lista (arreglo o página con `items`/`data`). `null` si la llamada falló, si no es una lista o
 * si viene vacía: ninguna empresa tiene cero roles ni un catálogo de permisos vacío, así que eso no prueba que el rol no
 * exista, solo que no se pudo comprobar.
 */
function listRows(r: ToolResponse): Array<Record<string, any>> | null {
  if (!r.ok) return null;
  const b = r.body as Record<string, any>;
  const rows = Array.isArray(b) ? b : Array.isArray(b?.items) ? b.items : Array.isArray(b?.data) ? b.data : null;
  return rows && rows.length > 0 ? rows : null;
}

const normalizeName = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });

// ── Recortes ───────────────────────────────────────────────────────────────
// Cada resultado de herramienta se reenvía entero en cada vuelta del bucle (ver `trim`). Estas piezas dejan solo lo que el
// modelo usa y pasan el dinero a dólares: dividir centavos entre 100 es justo la cuenta que un modelo pequeño falla.

/** Centavos (entero) → "1234.56". Lo que no es número pasa tal cual. */
export const usd = (cents: unknown): unknown =>
  typeof cents === 'number' || (typeof cents === 'string' && /^-?\d+$/.test(cents)) ? (Number(cents) / 100).toFixed(2) : cents;

export function pick(obj: unknown, keys: string[]): Record<string, unknown> {
  const o = (obj ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
  return out;
}

/**
 * Aplica `fn` a cada elemento de una lista, venga como arreglo o como página (`items`, `data`). Corta en 50: más filas no
 * caben en el contexto con utilidad y el modelo debería filtrar en vez de pedir todo. Si había más, lo dice.
 */
export function mapList(body: unknown, fn: (row: Record<string, any>) => unknown, max = 50): unknown {
  const b = body as Record<string, any>;
  const rows: Record<string, any>[] = Array.isArray(body) ? body : Array.isArray(b?.items) ? b.items : Array.isArray(b?.data) ? b.data : [];
  if (!Array.isArray(body) && !Array.isArray(b?.items) && !Array.isArray(b?.data)) return body;
  const total = typeof b?.total === 'number' ? b.total : rows.length;
  const out: Record<string, unknown> = { items: rows.slice(0, max).map(fn), total };
  if (total > Math.min(rows.length, max)) out.aviso = `Hay ${total} en total y aquí van ${Math.min(rows.length, max)}: filtra para ver el resto.`;
  return out;
}

const TRAMOS: Array<[string, string]> = [
  ['currentCents', 'corriente'],
  ['days1To30Cents', 'd1_30'],
  ['days31To60Cents', 'd31_60'],
  ['days61To90Cents', 'd61_90'],
  ['daysOver90Cents', 'mas_90'],
  ['totalCents', 'total'],
];
const tramos = (b: Record<string, any>) => Object.fromEntries(TRAMOS.map(([k, n]) => [n, usd(b?.[k])]));

/** Antigüedad de saldos: totales y las 30 partes que más deben, con los tramos en dólares. */
export function agingTrim(body: unknown, listKey: string, nameKey: string, idKey: string): unknown {
  const b = (body ?? {}) as Record<string, any>;
  const parts: Record<string, any>[] = Array.isArray(b[listKey]) ? b[listKey] : [];
  return {
    fecha: b.asOf,
    totales: tramos(b.totals),
    detalle: parts.slice(0, 30).map((p) => ({ nombre: p[nameKey], id: p[idKey], ...tramos(p) })),
    ...(parts.length > 30 ? { aviso: `Hay ${parts.length}; aquí van las 30 con más saldo.` } : {}),
  };
}

/** Estado de resultados o balance: por sección, su total y las cuentas con importe, en dólares. */
export function statementTrim(body: unknown): unknown {
  const b = (body ?? {}) as Record<string, any>;
  const sections: Record<string, any>[] = Array.isArray(b.sections) ? b.sections : [];
  // El balance trae `totals` ({ assetsCents, liabilitiesAndEquityCents, differenceCents }); el estado de resultados trae sus
  // totales en el primer nivel (`grossProfitCents`, `netResultCents`). Se juntan los dos, sin las comparaciones vacías: sin
  // esto la utilidad no llegaba al modelo y contestaba «0,00» con gastos de 10 (prueba en producción, 2026-11-24).
  const topLevel = Object.fromEntries(Object.entries(b).filter(([k, v]) => /Cents$/.test(k) && typeof v === 'number'));
  const nested = b.totals && typeof b.totals === 'object' ? b.totals : {};
  const totals = Object.fromEntries(Object.entries({ ...topLevel, ...nested }).filter(([, v]) => v !== null && v !== undefined));
  return {
    desde: b.from,
    hasta: b.to,
    fecha: b.asOf,
    totales: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k.replace(/Cents$/, ''), usd(v)])),
    secciones: sections.map((s) => ({
      seccion: s.key,
      total: usd(s.totalCents),
      cuentas: (Array.isArray(s.rows) ? s.rows : [])
        .filter((r: any) => Number(r.amountCents) !== 0)
        .slice(0, 25)
        .map((r: any) => ({ codigo: r.code, cuenta: r.name, nivel: r.level, importe: usd(r.amountCents) })),
    })),
  };
}

export const TOOLS: ToolDefinition[] = [
  // ── Lectura ──────────────────────────────────────────────────────────────
  {
    name: 'listar_clientes',
    plugin: 'crm.contacts',
    permission: 'customer:read',
    description:
      'Lista los clientes de la organización. Admite búsqueda por texto y filtro por estado. Úsalo antes de crear un cliente para comprobar si ya existe.',
    risk: 'read',
    method: 'GET',
    path: '/customers',
    queryParams: ['search', 'status', 'limit'],
    inputSchema: {
      type: 'object',
      properties: {
        search: str('Texto a buscar en nombre, razón social o identificación'),
        status: { type: 'string', enum: ['active', 'inactive'], description: 'Estado del cliente' },
        limit: num('Máximo de resultados (por defecto 20)'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ver_cliente',
    plugin: 'crm.contacts',
    permission: 'customer:read',
    description: 'Detalle de un cliente con sus contactos, direcciones y etiquetas.',
    risk: 'read',
    method: 'GET',
    path: '/customers/:id',
    inputSchema: {
      type: 'object',
      properties: { id: str('Identificador del cliente') },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'listar_productos',
    plugin: 'infra.catalog_products',
    permission: 'product:read',
    description:
      'Lista los productos del catálogo con su precio. Admite búsqueda, estado y orden. Para «los más caros» o «los más baratos» usa orden precio_desc o precio_asc: vienen ya ordenados, no los ordenes tú.',
    risk: 'read',
    method: 'GET',
    path: '/products',
    inputSchema: {
      type: 'object',
      properties: {
        search: str('Texto a buscar en el nombre o el código del producto'),
        status: { type: 'string', enum: ['active', 'inactive'], description: 'Estado del producto' },
        orden: { type: 'string', enum: ['precio_desc', 'precio_asc', 'nombre'], description: 'Orden de la lista (por defecto nombre)' },
        limit: num('Máximo de resultados (por defecto 50)'),
      },
      additionalProperties: false,
    },
    // La API devuelve el catálogo entero y sin orden. Ordenar lo hace el servidor: el modelo se saltó un producto al
    // elegir «los 6 más caros» él mismo (prueba en producción, 2026-11-25).
    execute: async (input, api) => {
      const query: Record<string, string> = {};
      if (typeof input.search === 'string' && input.search) query.search = input.search;
      if (input.status === 'active' || input.status === 'inactive') query.status = input.status;
      const r = await api.call('GET', '/products', { query });
      if (!r.ok || !Array.isArray(r.body)) return r;
      const cents = (p: Record<string, any>) => Number(p.priceCents ?? 0);
      const rows = [...(r.body as Record<string, any>[])];
      if (input.orden === 'precio_desc') rows.sort((a, b) => cents(b) - cents(a));
      else if (input.orden === 'precio_asc') rows.sort((a, b) => cents(a) - cents(b));
      else rows.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'es'));
      const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : 50;
      return { ...r, body: { items: rows.slice(0, limit), total: rows.length } };
    },
    trim: (body) =>
      mapList(body, (p) => ({ id: p.id, nombre: p.name, codigo: p.sku, tipo: p.type, estado: p.status, precio: usd(p.priceCents) })),
  },
  {
    name: 'listar_facturas',
    plugin: 'finance.electronic_invoicing',
    permission: 'invoice:read',
    description:
      'Lista facturas emitidas una por una (número, cliente, fecha, estado). Para totales o rankings de ventas usa resumen_ventas: aquí no vienen todas y no hay que sumarlas a mano.',
    risk: 'read',
    method: 'GET',
    path: '/invoices',
    queryParams: ['from', 'to', 'status', 'customerId', 'limit'],
    inputSchema: {
      type: 'object',
      properties: {
        from: str('Fecha inicial en formato YYYY-MM-DD'),
        to: str('Fecha final en formato YYYY-MM-DD'),
        status: str('Estado de la factura, por ejemplo issued o draft'),
        customerId: str('Filtrar por un cliente concreto'),
        limit: num('Máximo de resultados (por defecto 100 para poder sumar)'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'resumen_ventas',
    plugin: 'finance.electronic_invoicing',
    permission: 'invoice:read',
    description:
      'Ventas de un periodo YA SUMADAS por la base de datos: total, o agrupadas por producto (lo más vendido), cliente (quién compra más), día o mes. Las notas de crédito ya restan y las anuladas no cuentan. Úsala para cualquier cifra de ventas; no sumes facturas a mano.',
    risk: 'read',
    method: 'GET',
    path: '/reporting/sales/summary',
    queryParams: ['from', 'to', 'groupBy', 'limit'],
    inputSchema: {
      type: 'object',
      properties: {
        from: str('Fecha inicial YYYY-MM-DD'),
        to: str('Fecha final YYYY-MM-DD'),
        groupBy: { type: 'string', enum: ['total', 'product', 'customer', 'day', 'month'], description: 'Cómo agrupar (por defecto total)' },
        limit: num('Máximo de filas (por defecto 20)'),
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    trim: (body) => {
      const b = (body ?? {}) as Record<string, any>;
      const t = b.totals ?? {};
      return {
        desde: b.from,
        hasta: b.to,
        totales: { sin_iva: usd(t.netCents), con_iva: usd(t.totalCents), comprobantes: t.documents, notas_credito: t.creditNotes },
        filas: (Array.isArray(b.rows) ? b.rows : []).map((r: any) => ({
          nombre: r.label ?? r.key,
          ...(r.code ? { codigo: r.code } : {}),
          ...(r.quantity !== null && r.quantity !== undefined ? { cantidad: r.quantity } : {}),
          sin_iva: usd(r.netCents),
          ...(r.totalCents !== null && r.totalCents !== undefined ? { con_iva: usd(r.totalCents) } : {}),
          comprobantes: r.documents,
        })),
      };
    },
  },
  {
    name: 'listar_empleados',
    permission: 'user:read',
    description: 'Lista los usuarios de la organización con sus roles y su estado.',
    risk: 'read',
    method: 'GET',
    path: '/users',
    queryParams: ['search', 'limit'],
    inputSchema: {
      type: 'object',
      properties: {
        search: str('Texto a buscar en nombre o correo'),
        limit: num('Máximo de resultados'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'listar_roles',
    permission: 'user:read',
    description: 'Lista los roles de la organización con los permisos que tiene cada uno.',
    risk: 'read',
    method: 'GET',
    path: '/roles',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'listar_permisos',
    description:
      'Catálogo completo de permisos del sistema. Consúltalo SIEMPRE antes de crear o modificar un rol: los permisos hay que escribirlos con su código exacto y no se pueden adivinar.',
    risk: 'read',
    method: 'GET',
    path: '/permissions',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    // El endpoint devuelve por cada permiso un uuid, el recurso, la acción y una
    // descripción casi siempre vacía. De todo eso el modelo solo usa el código:
    // es lo único que `crear_rol` acepta. Medido en este CRM, quitar lo demás
    // deja el catálogo en la novena parte.
    trim: (body) =>
      Array.isArray(body)
        ? body.map((p) => (p as Record<string, unknown>)?.code).filter(Boolean)
        : body,
  },
  {
    name: 'ver_organizacion',
    // organization-service exige `organization:read` en GET /organizations/me: sin declararlo se le ofrecía a todos y quien no
    // lo tiene recibía un 403 (visto en producción el 2026-11-25 con un rol de solo clientes y productos).
    permission: 'organization:read',
    description: 'Datos de la organización activa: razón social, identificación tributaria y país.',
    risk: 'read',
    method: 'GET',
    path: '/organizations/me',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'listar_establecimientos',
    plugin: 'org.establishments',
    permission: 'establishment:read',
    description: 'Establecimientos de la organización y sus puntos de emisión.',
    risk: 'read',
    method: 'GET',
    path: '/establishments',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },

  {
    name: 'listar_tipos_identificacion',
    plugin: 'crm.contacts',
    // customer-service exige `customer:read` en GET /identification-types.
    permission: 'customer:read',
    description:
      'Tipos de identificación válidos en el país de la empresa (cédula, RUC, pasaporte…), con su id. Úsalo para elegir identificationTypeId antes de crear un cliente.',
    risk: 'read',
    method: 'GET',
    path: '/identification-types',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    trim: (body) => mapList(body, (t) => pick(t, ['id', 'code', 'name'])),
  },

  // ── Cobranza y pagos (tesorería) ─────────────────────────────────────────
  // Los importes salen en dólares con dos decimales, no en centavos: así el modelo no tiene que dividir, que es justo donde
  // los modelos pequeños se equivocan (banco de modelos, 2026-11-24).
  {
    name: 'cuentas_por_cobrar',
    plugin: 'finance.accounts_receivable_payable',
    permission: 'receivable:read',
    description:
      'Facturas pendientes de cobro, con saldo y vencimiento. Filtra por cliente, solo vencidas o por texto. Para saber quién debe más, usa mejor antiguedad_cobranza.',
    risk: 'read',
    method: 'GET',
    path: '/treasury/receivables',
    queryParams: ['customerId', 'overdueOnly', 'q', 'pageSize'],
    inputSchema: {
      type: 'object',
      properties: {
        customerId: str('Id del cliente (de listar_clientes)'),
        overdueOnly: { type: 'boolean', description: 'Solo las vencidas' },
        q: str('Texto a buscar: cliente o número de factura'),
        pageSize: num('Máximo de resultados (por defecto 20)'),
      },
      additionalProperties: false,
    },
    trim: (body) =>
      mapList(body, (r) => ({
        cliente: r.customerName,
        customerId: r.customerId,
        factura: r.documentNumber,
        emision: r.issueDate,
        vence: r.dueDate,
        original: usd(r.originalCents),
        saldo: usd(r.balanceCents),
        estado: r.status,
      })),
  },
  {
    name: 'antiguedad_cobranza',
    plugin: 'finance.accounts_receivable_payable',
    permission: 'receivable:read',
    description:
      'Cuánto debe cada cliente, repartido por tramos de atraso (corriente, 1-30, 31-60, 61-90, más de 90 días), de mayor a menor. Los totales ya vienen sumados.',
    risk: 'read',
    method: 'GET',
    path: '/treasury/receivables/aging',
    queryParams: ['asOf'],
    inputSchema: {
      type: 'object',
      properties: { asOf: str('Fecha de corte YYYY-MM-DD (por defecto hoy)') },
      additionalProperties: false,
    },
    trim: (body) => agingTrim(body, 'customers', 'customerName', 'customerId'),
  },
  {
    name: 'estado_cuenta_cliente',
    plugin: 'finance.accounts_receivable_payable',
    permission: 'receivable:read',
    description: 'Estado de cuenta de un cliente: lo que debe, sus anticipos y el neto. Pide antes el id con listar_clientes.',
    risk: 'read',
    method: 'GET',
    path: '/treasury/customers/:id/statement',
    queryParams: ['asOf'],
    inputSchema: {
      type: 'object',
      properties: { id: str('Id del cliente'), asOf: str('Fecha de corte YYYY-MM-DD (por defecto hoy)') },
      required: ['id'],
      additionalProperties: false,
    },
    trim: (body) => {
      const b = (body ?? {}) as Record<string, any>;
      return {
        fecha: b.asOf,
        debe: usd(b.receivableCents),
        anticipos: usd(b.advanceCents),
        neto: usd(b.netCents),
        facturas: (Array.isArray(b.receivables) ? b.receivables : [])
          .filter((r: any) => Number(r.balanceCents) !== 0)
          .slice(0, 30)
          .map((r: any) => ({ factura: r.documentNumber, vence: r.dueDate, saldo: usd(r.balanceCents), estado: r.status })),
      };
    },
  },
  {
    name: 'cuentas_por_pagar',
    plugin: 'finance.accounts_receivable_payable',
    permission: 'payable:read',
    description: 'Lo que la empresa debe a proveedores, con saldo y vencimiento. Filtra por proveedor, solo vencidas o por vencer pronto.',
    risk: 'read',
    method: 'GET',
    path: '/treasury/payables',
    queryParams: ['supplierId', 'overdueOnly', 'dueSoon', 'q', 'pageSize'],
    inputSchema: {
      type: 'object',
      properties: {
        supplierId: str('Id del proveedor (de listar_proveedores)'),
        overdueOnly: { type: 'boolean', description: 'Solo las vencidas' },
        dueSoon: { type: 'boolean', description: 'Solo las que vencen pronto' },
        q: str('Texto a buscar: proveedor o número'),
        pageSize: num('Máximo de resultados (por defecto 20)'),
      },
      additionalProperties: false,
    },
    trim: (body) =>
      mapList(body, (r) => ({
        proveedor: r.supplierName,
        documento: r.documentNumber,
        vence: r.dueDate,
        original: usd(r.originalCents),
        saldo: usd(r.balanceCents),
        estado: r.status,
      })),
  },
  {
    name: 'antiguedad_pagos',
    plugin: 'finance.accounts_receivable_payable',
    permission: 'payable:read',
    description: 'Cuánto se debe a cada proveedor por tramos de vencimiento, de mayor a menor. Los totales ya vienen sumados.',
    risk: 'read',
    method: 'GET',
    path: '/treasury/payables/aging',
    queryParams: ['asOf'],
    inputSchema: {
      type: 'object',
      properties: { asOf: str('Fecha de corte YYYY-MM-DD (por defecto hoy)') },
      additionalProperties: false,
    },
    trim: (body) => agingTrim(body, 'suppliers', 'supplierName', 'supplierId'),
  },

  // ── Inventario ───────────────────────────────────────────────────────────
  {
    name: 'stock_producto',
    plugin: 'inventory.kardex',
    permission: 'inventory:read',
    description: 'Existencias de un producto en todas las bodegas (disponible, reservado, total). Pide antes el id con listar_productos.',
    risk: 'read',
    method: 'GET',
    path: '/stock/products/:productId',
    inputSchema: {
      type: 'object',
      properties: { productId: str('Id del producto') },
      required: ['productId'],
      additionalProperties: false,
    },
    trim: (body) => {
      const b = (body ?? {}) as Record<string, any>;
      return {
        total: b.totalOnHand,
        reservado: b.totalReserved,
        disponible: b.totalAvailable,
        bodegas: (Array.isArray(b.positions) ? b.positions : []).map((p: any) =>
          pick(p, ['warehouseCode', 'warehouseName', 'quantityOnHand', 'quantityReserved', 'quantityAvailable']),
        ),
      };
    },
  },
  {
    name: 'stock_por_producto',
    plugin: 'inventory.kardex',
    permission: 'inventory:read',
    description:
      'Existencias de TODOS los productos en una sola consulta: por producto, con su nombre y sumando todas las bodegas. Filtra por poco stock o agotados. Para el detalle por bodega de un producto concreto usa stock_producto.',
    risk: 'read',
    method: 'GET',
    path: '/stock',
    inputSchema: {
      type: 'object',
      properties: {
        lowStock: { type: 'boolean', description: 'Solo los que están bajo su mínimo' },
        stockState: { type: 'string', enum: ['with_stock', 'without_stock'], description: 'without_stock = agotados' },
        warehouseId: str('Id de la bodega (de listar_bodegas), para una sola bodega'),
      },
      additionalProperties: false,
    },
    // Dos llamadas en vez de una por producto: «¿cuánto stock tengo de cada producto?» tardaba 22 s con 12 productos
    // (prueba en producción, 2026-11-25). Las cantidades se suman aquí, no en el modelo.
    execute: async (input, api) => {
      const query: Record<string, string> = { pageSize: '200' };
      if (input.lowStock === true) query.lowStock = 'true';
      if (input.stockState === 'with_stock' || input.stockState === 'without_stock') query.stockState = input.stockState;
      if (typeof input.warehouseId === 'string' && input.warehouseId) query.warehouseId = input.warehouseId;
      const [stock, products] = await Promise.all([api.call('GET', '/stock', { query }), api.call('GET', '/products')]);
      if (!stock.ok) return stock;
      const positions: Record<string, any>[] = Array.isArray((stock.body as any)?.data) ? (stock.body as any).data : [];
      const names = new Map(
        (products.ok && Array.isArray(products.body) ? (products.body as Record<string, any>[]) : []).map((p) => [String(p.id), String(p.name)]),
      );
      const byProduct = new Map<string, { producto: string; disponible: number; reservado: number; total: number; bodegas: number }>();
      for (const p of positions) {
        const id = String(p.productId);
        const row = byProduct.get(id) ?? { producto: names.get(id) ?? id, disponible: 0, reservado: 0, total: 0, bodegas: 0 };
        row.disponible += Number(p.quantityAvailable ?? 0);
        row.reservado += Number(p.quantityReserved ?? 0);
        row.total += Number(p.quantityOnHand ?? 0);
        row.bodegas += 1;
        byProduct.set(id, row);
      }
      const round = (n: number) => Math.round(n * 10_000) / 10_000;
      const items = [...byProduct.values()]
        .map((r) => ({ ...r, disponible: round(r.disponible), reservado: round(r.reservado), total: round(r.total) }))
        .sort((a, b) => a.producto.localeCompare(b.producto, 'es'));
      const total = Number((stock.body as any)?.total ?? positions.length);
      return {
        ok: true,
        status: 200,
        body: {
          items,
          total: items.length,
          ...(total > positions.length ? { aviso: `Hay ${total} posiciones de stock y aquí van ${positions.length}: filtra por bodega o por estado.` } : {}),
        },
      };
    },
  },
  {
    name: 'listar_bodegas',
    plugin: 'inventory.warehouses',
    permission: 'inventory:read',
    description: 'Bodegas de la empresa.',
    risk: 'read',
    method: 'GET',
    path: '/warehouses',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    trim: (body) => mapList(body, (w) => pick(w, ['id', 'code', 'name', 'isDefault', 'status'])),
  },

  // ── Compras ──────────────────────────────────────────────────────────────
  {
    name: 'listar_proveedores',
    plugin: 'inventory.suppliers',
    permission: 'supplier:read',
    description: 'Proveedores de la empresa. Admite búsqueda por texto.',
    risk: 'read',
    method: 'GET',
    path: '/purchasing/suppliers',
    queryParams: ['q', 'status', 'pageSize'],
    inputSchema: {
      type: 'object',
      properties: {
        q: str('Texto a buscar: nombre o identificación'),
        status: { type: 'string', enum: ['active', 'inactive'], description: 'Estado del proveedor' },
        pageSize: num('Máximo de resultados (por defecto 20)'),
      },
      additionalProperties: false,
    },
    trim: (body) => mapList(body, (p) => pick(p, ['id', 'name', 'legalName', 'tradeName', 'identification', 'email', 'phone', 'status'])),
  },
  {
    name: 'listar_ordenes_compra',
    plugin: 'purchasing.purchase_orders',
    permission: 'purchase:read',
    description:
      'Órdenes de compra. Estados: pending_approval (por aprobar), approved (por recibir), partially_received, received, closed, draft, cancelled, rejected.',
    risk: 'read',
    method: 'GET',
    path: '/purchasing/orders',
    queryParams: ['status', 'supplierId', 'from', 'to', 'q', 'pageSize'],
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['draft', 'pending_approval', 'approved', 'partially_received', 'received', 'closed', 'cancelled', 'rejected'],
          description: 'Estado de la orden',
        },
        supplierId: str('Id del proveedor'),
        from: str('Fecha inicial YYYY-MM-DD'),
        to: str('Fecha final YYYY-MM-DD'),
        q: str('Texto a buscar'),
        pageSize: num('Máximo de resultados (por defecto 20)'),
      },
      additionalProperties: false,
    },
    trim: (body) =>
      mapList(body, (o) => ({
        numero: o.number,
        proveedor: o.supplier?.name ?? o.supplier?.legalName ?? o.supplierId,
        estado: o.status,
        fecha: o.orderDate,
        esperada: o.expectedDate,
        total: usd(o.totalCents),
        lineas: o.lineCount,
      })),
  },
  {
    name: 'listar_facturas_compra',
    plugin: 'purchasing.purchase_orders',
    permission: 'purchase_bill:read',
    description: 'Facturas de proveedores registradas. Filtra por proveedor, estado (draft, posted, blocked, voided) y fechas.',
    risk: 'read',
    method: 'GET',
    path: '/purchasing/bills',
    queryParams: ['status', 'supplierId', 'from', 'to', 'q', 'pageSize'],
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['draft', 'posted', 'blocked', 'voided'], description: 'Estado de la factura' },
        supplierId: str('Id del proveedor'),
        from: str('Fecha inicial YYYY-MM-DD'),
        to: str('Fecha final YYYY-MM-DD'),
        q: str('Texto a buscar'),
        pageSize: num('Máximo de resultados (por defecto 20)'),
      },
      additionalProperties: false,
    },
    trim: (body) =>
      mapList(body, (b) => ({
        numero: [b.establishment, b.emissionPoint, b.sequential].filter(Boolean).join('-') || b.internalNumber,
        proveedor: b.supplier?.name ?? b.supplier?.legalName ?? b.supplierId,
        emision: b.issueDate,
        vence: b.dueDate,
        total: usd(b.totalCents),
        estado: b.status,
        conciliacion: b.matchStatus,
      })),
  },

  // ── Proyectos ────────────────────────────────────────────────────────────
  {
    name: 'mis_tareas',
    plugin: 'projects.tasks_kanban',
    permission: 'project:read',
    description: 'Las tareas asignadas a la persona con la que hablas (y sus tareas personales), con fecha de entrega y proyecto.',
    risk: 'read',
    method: 'GET',
    path: '/projects/my-tasks',
    queryParams: ['includeCompleted'],
    inputSchema: {
      type: 'object',
      properties: { includeCompleted: { type: 'boolean', description: 'Incluir también las terminadas' } },
      additionalProperties: false,
    },
    trim: (body) =>
      mapList(body, (t) => ({
        tarea: t.title,
        entrega: t.dueOn,
        terminada: Boolean(t.completedAt),
        proyecto: Array.isArray(t.projects) ? t.projects.map((p: any) => p.name).join(', ') : undefined,
        subtareas: t.subtasks,
      })),
  },

  // ── Contabilidad ─────────────────────────────────────────────────────────
  {
    name: 'estado_resultados',
    plugin: 'finance.general_ledger',
    permission: 'ledger:read',
    description: 'Estado de resultados (ingresos, costos, gastos y utilidad) entre dos fechas, con totales ya calculados.',
    risk: 'read',
    method: 'GET',
    path: '/accounting/reports/income-statement',
    queryParams: ['from', 'to', 'maxLevel'],
    inputSchema: {
      type: 'object',
      properties: {
        from: str('Fecha inicial YYYY-MM-DD'),
        to: str('Fecha final YYYY-MM-DD'),
        maxLevel: num('Nivel de detalle del plan de cuentas (por defecto 2)'),
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    trim: statementTrim,
  },
  {
    name: 'balance_general',
    plugin: 'finance.general_ledger',
    permission: 'ledger:read',
    description: 'Balance general (activos, pasivos y patrimonio) a una fecha, con totales ya calculados.',
    risk: 'read',
    method: 'GET',
    path: '/accounting/reports/balance-sheet',
    queryParams: ['asOf', 'maxLevel'],
    inputSchema: {
      type: 'object',
      properties: {
        asOf: str('Fecha de corte YYYY-MM-DD'),
        maxLevel: num('Nivel de detalle del plan de cuentas (por defecto 2)'),
      },
      required: ['asOf'],
      additionalProperties: false,
    },
    trim: statementTrim,
  },

  // ── Bitácora ─────────────────────────────────────────────────────────────
  {
    name: 'buscar_bitacora',
    permission: 'audit:read',
    description:
      'Bitácora de auditoría: quién hizo qué y cuándo. Filtra por el id de lo afectado (targetId), por persona (userId), por texto o por fechas.',
    risk: 'read',
    method: 'GET',
    path: '/audit-logs',
    queryParams: ['targetId', 'userId', 'search', 'from', 'to', 'limit'],
    inputSchema: {
      type: 'object',
      properties: {
        targetId: str('Id del registro afectado (cliente, factura, rol…)'),
        userId: str('Id de la persona que actuó'),
        search: str('Texto a buscar'),
        from: str('Fecha inicial YYYY-MM-DD'),
        to: str('Fecha final YYYY-MM-DD'),
        limit: num('Máximo de resultados (por defecto 20)'),
      },
      additionalProperties: false,
    },
    trim: (body) => mapList(body, (e) => pick(e, ['occurredAt', 'userEmail', 'event', 'summary', 'via'])),
  },

  // ── Escritura (siempre con confirmación humana) ───────────────────────────
  {
    name: 'crear_rol',
    permission: 'user:assign_role',
    description:
      'Crea un rol nuevo con un conjunto de permisos. Antes de llamarla, consulta el catálogo de permisos y elige solo los que hagan falta: un rol con permisos de más es un agujero de seguridad.',
    risk: 'write',
    method: 'POST',
    path: '/roles',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Nombre del rol, por ejemplo Cajero'),
        description: str('Para qué sirve el rol'),
        permissions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Códigos exactos de permiso, tal como los devuelve listar_permisos',
        },
      },
      required: ['name', 'permissions'],
      additionalProperties: false,
    },
    summarize: (input) => {
      const perms = Array.isArray(input.permissions) ? input.permissions : [];
      return `Crear el rol "${input.name}" con ${perms.length} permiso(s): ${perms.join(', ')}`;
    },
    // Un código inventado (`customers:view`) haría fallar la creación o, peor, crearía un rol que no sirve para nada.
    prepare: async (input, api) => {
      const rows = listRows(await api.call('GET', '/permissions'));
      if (!rows) return null;
      const catalog = new Set(rows.map((r) => String(r.code)));
      const perms = Array.isArray(input.permissions) ? input.permissions.map(String) : [];
      const unknown = perms.filter((p) => !catalog.has(p));
      if (unknown.length > 0) {
        return { error: `Estos permisos no existen: ${unknown.join(', ')}. Usa solo códigos tal como los devuelve listar_permisos.` };
      }
      return { input };
    },
  },
  {
    name: 'invitar_empleado',
    permission: 'user:invite',
    description:
      'Invita a una persona a la organización por correo. Recibe un enlace para activar su cuenta. Comprueba antes con listar_roles que el rol que vas a asignar existe.',
    risk: 'write',
    method: 'POST',
    path: '/users/invite',
    inputSchema: {
      type: 'object',
      properties: {
        email: str('Correo de la persona a invitar'),
        roleIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ids de los roles que se le asignan, de listar_roles (también vale el nombre exacto del rol)',
        },
      },
      required: ['email', 'roleIds'],
      additionalProperties: false,
    },
    summarize: (input) => {
      const roles = Array.isArray(input.roleIds) ? input.roleIds.length : 0;
      return `Invitar a ${input.email} con ${roles} rol(es) asignado(s)`;
    },
    prepare: async (input, api) => {
      const rows = listRows(await api.call('GET', '/roles'));
      if (!rows) return null;
      const wanted = Array.isArray(input.roleIds) ? input.roleIds.map(String) : [];
      const catalog = rows.map((r) => `${r.name} (id ${r.id})`).join(', ');
      if (wanted.length === 0) return { error: `Falta el rol. Roles de la empresa: ${catalog}.` };
      const found: Array<Record<string, any>> = [];
      const unknown: string[] = [];
      for (const w of wanted) {
        // Por id, o por nombre sin importar mayúsculas ni tildes: «vendedor» es el rol Vendedor.
        const hit = rows.find((r) => String(r.id) === w) ?? rows.find((r) => normalizeName(String(r.name ?? '')) === normalizeName(w));
        if (hit) found.push(hit);
        else unknown.push(w);
      }
      if (unknown.length > 0) {
        return { error: `No existe ningún rol «${unknown.join('», «')}». Roles de la empresa: ${catalog}. Usa el id exacto de uno de ellos.` };
      }
      const names = found.map((r) => String(r.name));
      return {
        input: { ...input, roleIds: found.map((r) => String(r.id)) },
        summary: `Invitar a ${input.email} con ${names.length > 1 ? 'los roles' : 'el rol'} ${names.join(', ')}`,
      };
    },
  },
  {
    name: 'crear_cliente',
    plugin: 'crm.contacts',
    permission: 'customer:create',
    description:
      'Da de alta un cliente. Comprueba antes con listar_clientes que no exista ya uno con la misma identificación. type es company para una empresa (RUC de sociedad) y person para una persona.',
    risk: 'write',
    method: 'POST',
    path: '/customers',
    inputSchema: {
      type: 'object',
      properties: {
        businessName: str('Nombre o razón social'),
        type: { type: 'string', enum: ['person', 'company'], description: 'person = persona; company = empresa' },
        identification: str('Número de identificación (cédula, RUC, pasaporte)'),
        identificationTypeId: str('Tipo de identificación, de listar_tipos_identificacion'),
        email: str('Correo de contacto'),
        phone: str('Teléfono de contacto'),
      },
      // `type` lo exige customer-service: sin él, confirmar daba siempre 422 (revisado contra su validador, 2026-11-25).
      required: ['businessName', 'type'],
      additionalProperties: false,
    },
    // La descripción ya pide buscar antes, pero Qwen a veces no lo hace (banco del 2026-11-25, `cliente-duplicado`): la
    // comprobación va aquí, donde no depende del modelo. Solo con identificación: dos «Juan Pérez» pueden ser personas distintas.
    prepare: async (input, api) => {
      const id = typeof input.identification === 'string' ? input.identification.trim() : '';
      if (!id) return null;
      const rows = listRows(await api.call('GET', '/customers', { query: { search: id } }));
      const same = rows?.find((r) => String(r.identification ?? '').trim() === id);
      if (same) {
        return { error: `Ya existe el cliente «${same.businessName}» con la identificación ${id}. No lo crees de nuevo: díselo a la persona.` };
      }
      return null;
    },
    summarize: (input) =>
      `Crear el cliente "${input.businessName}" (${input.type === 'company' ? 'empresa' : 'persona'})${input.identification ? ` con identificación ${input.identification}` : ''}`,
  },
  {
    name: 'crear_producto',
    plugin: 'infra.catalog_products',
    permission: 'product:create',
    description:
      'Da de alta un producto en el catálogo, disponible en todos los establecimientos. type es good para un bien físico y service para un servicio. El precio va en centavos.',
    risk: 'write',
    method: 'POST',
    path: '/products',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Nombre del producto'),
        description: str('Descripción del producto'),
        priceCents: num('Precio en centavos, sin decimales. 10 dólares son 1000'),
        type: { type: 'string', enum: ['good', 'service'], description: 'good = bien físico; service = servicio' },
      },
      required: ['name', 'priceCents', 'type'],
      additionalProperties: false,
    },
    // product-service exige `price` en texto con dos decimales, `currencyCode` y al menos un establecimiento; el input
    // directo (priceCents, sin moneda ni establecimientos) daba siempre 422 al confirmar (revisado contra su validador,
    // 2026-11-25). El modelo sigue dando el precio en centavos (sin decimales que confundir) y la conversión se hace aquí.
    execute: async (input, api) => {
      const est = await api.call('GET', '/establishments');
      if (!est.ok) return est;
      const list = Array.isArray(est.body) ? (est.body as Record<string, any>[]) : Array.isArray((est.body as any)?.items) ? (est.body as any).items : [];
      const establishmentIds = list.filter((e: Record<string, any>) => e.status !== 'inactive').map((e: Record<string, any>) => String(e.id));
      if (establishmentIds.length === 0) {
        return { ok: false, status: 422, body: { code: 'NO_ESTABLISHMENTS', message: 'La empresa no tiene establecimientos activos donde ofrecer el producto.' } };
      }
      return api.call('POST', '/products', {
        body: {
          name: input.name,
          type: input.type === 'service' ? 'service' : 'good',
          price: (Number(input.priceCents) / 100).toFixed(2),
          currencyCode: 'USD',
          establishmentIds,
          ...(typeof input.description === 'string' && input.description ? { description: input.description } : {}),
        },
      });
    },
    summarize: (input) => {
      const price = typeof input.priceCents === 'number' ? (input.priceCents / 100).toFixed(2) : '?';
      return `Crear el ${input.type === 'service' ? 'servicio' : 'producto'} "${input.name}" con precio ${price}, en todos los establecimientos`;
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * Las herramientas que esta persona puede usar: las de los módulos activos de su empresa y los permisos de su rol. `null`
 * en cualquiera de los dos = no se sabe (falló la consulta, o un banco de pruebas) y no se filtra por ese lado: el modelo
 * verá un 403 o un PLUGIN_NOT_ACTIVE y el prompt ya le dice cómo contarlo.
 */
export function availableTools(permissions: string[] | null, plugins: Set<string> | null): ToolDefinition[] {
  const all = permissions?.includes('*') ?? false;
  return TOOLS.filter(
    (t) =>
      (!t.plugin || plugins === null || plugins.has(t.plugin)) &&
      (!t.permission || permissions === null || all || permissions.includes(t.permission)),
  );
}

/** Lo que se manda al modelo: solo nombre, descripción y esquema. */
export function toAnthropicTools(tools: ToolDefinition[] = TOOLS): Array<{
  name: string;
  description: string;
  input_schema: ToolDefinition['inputSchema'];
}> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

/** Frase que verá el usuario antes de confirmar una escritura. */
export function summarizeAction(tool: ToolDefinition, input: Record<string, unknown>): string {
  if (tool.summarize) return tool.summarize(input);
  return `Ejecutar ${tool.name}`;
}
