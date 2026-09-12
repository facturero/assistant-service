import { z } from 'zod';

/**
 * Una variable puesta a cadena vacía es una variable **sin poner**. Docker
 * Compose y Kubernetes la escriben así cuando el valor no existe
 * (`${FOO:-}`), y sin esto una `ASSISTANT_BASE_URL` vacía tumbaría el arranque
 * por "url inválida" en vez de caer en el valor por defecto.
 */
const vacioEsAusente = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema);

const envSchema = z.object({
  PORT: z.coerce.number().default(3014),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  DB_HOST: z.string().default('mysql'),
  DB_PORT: z.coerce.number().default(3306),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default('root123'),
  DB_NAME: z.string().default('assistant_db'),

  /**
   * De dónde sale el modelo. Los dos hablan el **mismo protocolo** (la Messages
   * API de Anthropic) y aceptan la misma cabecera `x-api-key`, así que cambiar
   * de proveedor es cambiar la URL base y la clave — no hay un cliente distinto
   * ni un formato de mensajes distinto.
   *
   *   - 'anthropic' → la API de Anthropic directamente.
   *   - 'opencode'  → la pasarela OpenCode Zen, que sirve los mismos modelos
   *                   `claude-*` y algunos de otras casas por el mismo camino.
   *
   * El tercero sí es otro protocolo, el de OpenAI, y lleva su propio adaptador:
   *   - 'openai-compat' → Ollama en local, o las capas gratuitas de Groq,
   *                       Gemini y OpenRouter. Exige `ASSISTANT_BASE_URL`.
   */
  ASSISTANT_PROVIDER: z.enum(['anthropic', 'opencode', 'openai-compat']).default('anthropic'),

  /** Las claves viven aquí y solo aquí. Nunca salen hacia el navegador. */
  ANTHROPIC_API_KEY: vacioEsAusente(z.string().optional()),
  OPENCODE_API_KEY: vacioEsAusente(z.string().optional()),
  /** Solo si el servicio compatible pide credencial. Ollama en local, no. */
  OPENAI_COMPAT_API_KEY: vacioEsAusente(z.string().optional()),

  /**
   * Solo para apuntar a otra pasarela que hable el protocolo de Anthropic. Se
   * escribe **sin** `/v1`: el SDK añade `/v1/messages` él solo.
   */
  ASSISTANT_BASE_URL: vacioEsAusente(z.string().url().optional()),

  /**
   * Modelo a usar. `ANTHROPIC_MODEL` se mantiene por compatibilidad, pero con un
   * proveedor que no es Anthropic el nombre engañaba: `ASSISTANT_MODEL` manda.
   */
  ASSISTANT_MODEL: vacioEsAusente(z.string().optional()),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),
  /**
   * Profundidad de razonamiento: low | medium | high | xhigh | max.
   * 'medium' es el punto sensato para un asistente que consulta y crea cosas en
   * un CRM; subirlo cuesta dinero y solo se nota en problemas difíciles.
   */
  ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().default(16000),
  /**
   * Tope de espera por turno. Un modelo local en una GPU de casa tarda segundos
   * o minutos, no milisegundos; el de Anthropic responde mucho antes y no le
   * estorba que el margen sea amplio.
   */
  ASSISTANT_LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(180_000),

  /** El asistente llama a la API por el gateway, con el token del usuario. */
  GATEWAY_URL: z.string().default('http://api-gateway-node:8080'),
  CRM_API_TIMEOUT_MS: z.coerce.number().default(20000),

  /** Tope de vueltas del bucle antes de rendirse. */
  AGENT_MAX_ITERATIONS: z.coerce.number().int().min(1).max(20).default(8),
  /**
   * Tokens al mes por organización. Va incluido en la plataforma, así que el
   * coste lo paga la casa: el límite evita que una organización se lleve por
   * delante el margen de todas. 0 = sin límite.
   */
  ASSISTANT_MONTHLY_TOKEN_LIMIT: z.coerce.number().int().min(0).default(2_000_000),
});

export type Config = z.infer<typeof envSchema>;

/** Dónde y con qué credencial se habla con el modelo. */
export interface ProviderSettings {
  name: Config['ASSISTANT_PROVIDER'];
  apiKey: string;
  /** `undefined` = la URL por defecto del SDK (la de Anthropic). */
  baseURL: string | undefined;
  model: string;
}

/** La pasarela de opencode, sin `/v1`: el SDK añade `/v1/messages`. */
export const OPENCODE_BASE_URL = 'https://opencode.ai/zen';

/**
 * Traduce la configuración a "a quién llamo y con qué clave".
 *
 * Cada proveedor exige **su** clave y no acepta la del otro: son cuentas
 * distintas y facturas distintas. Por eso el error dice cuál falta en vez de un
 * "credencial no válida" genérico a las dos de la mañana.
 */
export function resolveProvider(config: Config): ProviderSettings {
  const model = config.ASSISTANT_MODEL ?? config.ANTHROPIC_MODEL;

  if (config.ASSISTANT_PROVIDER === 'openai-compat') {
    if (!config.ASSISTANT_BASE_URL) {
      throw new Error(
        'ASSISTANT_PROVIDER=openai-compat necesita ASSISTANT_BASE_URL (ej: http://host.docker.internal:11434/v1).',
      );
    }
    // Sin clave a propósito: un Ollama en la red de casa no pide ninguna, y
    // exigirla impediría justo el caso que hace falta para una prueba.
    return {
      name: 'openai-compat',
      apiKey: config.OPENAI_COMPAT_API_KEY ?? '',
      baseURL: config.ASSISTANT_BASE_URL,
      model,
    };
  }

  if (config.ASSISTANT_PROVIDER === 'opencode') {
    if (!config.OPENCODE_API_KEY) {
      throw new Error(
        'ASSISTANT_PROVIDER=opencode necesita OPENCODE_API_KEY (se saca de opencode.ai/auth).',
      );
    }
    return {
      name: 'opencode',
      apiKey: config.OPENCODE_API_KEY,
      baseURL: config.ASSISTANT_BASE_URL ?? OPENCODE_BASE_URL,
      model,
    };
  }

  if (!config.ANTHROPIC_API_KEY) {
    throw new Error(
      'ASSISTANT_PROVIDER=anthropic necesita ANTHROPIC_API_KEY (se saca de console.anthropic.com).',
    );
  }
  return {
    name: 'anthropic',
    apiKey: config.ANTHROPIC_API_KEY,
    baseURL: config.ASSISTANT_BASE_URL,
    model,
  };
}

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('[assistant-service] variables de entorno inválidas:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  _config = parsed.data;
  return _config;
}
