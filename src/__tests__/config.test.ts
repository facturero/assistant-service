import { describe, expect, it } from 'vitest';
import { Config, OPENCODE_BASE_URL, resolveProvider } from '../config';

/**
 * Elegir proveedor es la clase de cosa que se rompe en silencio: si la URL base
 * sale mal, el servicio arranca igual y solo se nota al primer mensaje. Por eso
 * se prueba aquí y no a mano.
 */
function config(over: Partial<Config> = {}): Config {
  return {
    PORT: 3014,
    CORS_ORIGIN: 'http://localhost:5173',
    DB_HOST: 'mysql',
    DB_PORT: 3306,
    DB_USER: 'root',
    DB_PASSWORD: 'root123',
    DB_NAME: 'assistant_db',
    ASSISTANT_PROVIDER: 'anthropic',
    ANTHROPIC_MODEL: 'claude-opus-5',
    ANTHROPIC_EFFORT: 'medium',
    ANTHROPIC_MAX_TOKENS: 16000,
    GATEWAY_URL: 'http://gateway:8080',
    CRM_API_TIMEOUT_MS: 20000,
    AGENT_MAX_ITERATIONS: 8,
    ASSISTANT_MONTHLY_TOKEN_LIMIT: 2_000_000,
    ...over,
  } as Config;
}

describe('resolveProvider', () => {
  it('con anthropic usa su clave y deja la URL por defecto del SDK', () => {
    const p = resolveProvider(config({ ANTHROPIC_API_KEY: 'sk-ant-xxx' }));
    expect(p).toEqual({ name: 'anthropic', apiKey: 'sk-ant-xxx', baseURL: undefined, model: 'claude-opus-5' });
  });

  it('con opencode usa su clave y apunta a la pasarela', () => {
    const p = resolveProvider(
      config({ ASSISTANT_PROVIDER: 'opencode', OPENCODE_API_KEY: 'oc-xxx' }),
    );
    expect(p).toEqual({ name: 'opencode', apiKey: 'oc-xxx', baseURL: OPENCODE_BASE_URL, model: 'claude-opus-5' });
  });

  it('la URL base va sin /v1: el SDK añade /v1/messages', () => {
    expect(OPENCODE_BASE_URL.endsWith('/v1')).toBe(false);
    expect(new URL('/v1/messages', OPENCODE_BASE_URL + '/').pathname).toBe('/v1/messages');
  });

  it('no acepta la clave del otro proveedor: son cuentas distintas', () => {
    expect(() =>
      resolveProvider(config({ ASSISTANT_PROVIDER: 'opencode', ANTHROPIC_API_KEY: 'sk-ant-xxx' })),
    ).toThrow(/OPENCODE_API_KEY/);
    expect(() => resolveProvider(config({ OPENCODE_API_KEY: 'oc-xxx' }))).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it('con openai-compat no exige clave: un Ollama de casa no pide ninguna', () => {
    const p = resolveProvider(
      config({
        ASSISTANT_PROVIDER: 'openai-compat',
        ASSISTANT_BASE_URL: 'http://host.docker.internal:11434/v1',
        ASSISTANT_MODEL: 'gemma4:12b',
      }),
    );
    expect(p).toEqual({
      name: 'openai-compat',
      apiKey: '',
      baseURL: 'http://host.docker.internal:11434/v1',
      model: 'gemma4:12b',
    });
  });

  it('openai-compat sin URL no arranca: no hay valor por defecto que valga', () => {
    expect(() => resolveProvider(config({ ASSISTANT_PROVIDER: 'openai-compat' }))).toThrow(
      /ASSISTANT_BASE_URL/,
    );
  });

  it('ASSISTANT_MODEL manda sobre ANTHROPIC_MODEL', () => {
    const p = resolveProvider(
      config({ ANTHROPIC_API_KEY: 'sk-ant-xxx', ASSISTANT_MODEL: 'claude-sonnet-5' }),
    );
    expect(p.model).toBe('claude-sonnet-5');
  });

  it('una pasarela propia gana a la de opencode', () => {
    const p = resolveProvider(
      config({
        ASSISTANT_PROVIDER: 'opencode',
        OPENCODE_API_KEY: 'oc-xxx',
        ASSISTANT_BASE_URL: 'https://mi-pasarela.example',
      }),
    );
    expect(p.baseURL).toBe('https://mi-pasarela.example');
  });
});
