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
   * Frase en primera persona que se le enseña al usuario antes de confirmar.
   * Se escribe aquí y no se le pide al modelo: lo que se confirma tiene que
   * describir lo que de verdad va a pasar, no lo que el modelo dice que pasará.
   */
  summarize?: (input: Record<string, unknown>) => string;

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

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });

export const TOOLS: ToolDefinition[] = [
  // ── Lectura ──────────────────────────────────────────────────────────────
  {
    name: 'listar_clientes',
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
    description: 'Lista los productos del catálogo. Admite búsqueda por texto y filtro por estado.',
    risk: 'read',
    method: 'GET',
    path: '/products',
    queryParams: ['search', 'status', 'limit'],
    inputSchema: {
      type: 'object',
      properties: {
        search: str('Texto a buscar en el nombre o el código del producto'),
        status: { type: 'string', enum: ['active', 'inactive'], description: 'Estado del producto' },
        limit: num('Máximo de resultados (por defecto 20)'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'listar_facturas',
    description:
      'Lista las facturas emitidas. Admite ventana de fechas y estado. Es la fuente para cualquier informe de ventas: pide los datos y haz tú las cuentas, no las inventes.',
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
    name: 'listar_empleados',
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
    description: 'Datos de la organización activa: razón social, identificación tributaria y país.',
    risk: 'read',
    method: 'GET',
    path: '/organizations/me',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'listar_establecimientos',
    description: 'Establecimientos de la organización y sus puntos de emisión.',
    risk: 'read',
    method: 'GET',
    path: '/establishments',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },

  // ── Escritura (siempre con confirmación humana) ───────────────────────────
  {
    name: 'crear_rol',
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
  },
  {
    name: 'invitar_empleado',
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
          description: 'Identificadores de los roles que se le asignan',
        },
      },
      required: ['email', 'roleIds'],
      additionalProperties: false,
    },
    summarize: (input) => {
      const roles = Array.isArray(input.roleIds) ? input.roleIds.length : 0;
      return `Invitar a ${input.email} con ${roles} rol(es) asignado(s)`;
    },
  },
  {
    name: 'crear_cliente',
    description:
      'Da de alta un cliente. Comprueba antes con listar_clientes que no exista ya uno con la misma identificación.',
    risk: 'write',
    method: 'POST',
    path: '/customers',
    inputSchema: {
      type: 'object',
      properties: {
        businessName: str('Nombre o razón social'),
        identification: str('Número de identificación (cédula, RUC, pasaporte)'),
        identificationTypeId: str('Tipo de identificación, de listar_tipos_identificacion'),
        email: str('Correo de contacto'),
        phone: str('Teléfono de contacto'),
      },
      required: ['businessName'],
      additionalProperties: false,
    },
    summarize: (input) =>
      `Crear el cliente "${input.businessName}"${input.identification ? ` con identificación ${input.identification}` : ''}`,
  },
  {
    name: 'crear_producto',
    description: 'Da de alta un producto en el catálogo.',
    risk: 'write',
    method: 'POST',
    path: '/products',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Nombre del producto'),
        description: str('Descripción del producto'),
        priceCents: num('Precio en centavos, sin decimales. 10 dólares son 1000'),
        type: { type: 'string', enum: ['product', 'service'], description: 'Producto o servicio' },
      },
      required: ['name', 'priceCents'],
      additionalProperties: false,
    },
    summarize: (input) => {
      const price = typeof input.priceCents === 'number' ? (input.priceCents / 100).toFixed(2) : '?';
      return `Crear el producto "${input.name}" con precio ${price}`;
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Lo que se manda a la API de Anthropic: solo nombre, descripción y esquema. */
export function toAnthropicTools(): Array<{
  name: string;
  description: string;
  input_schema: ToolDefinition['inputSchema'];
}> {
  return TOOLS.map((t) => ({
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
