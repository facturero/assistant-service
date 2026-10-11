import { beforeAll, describe, expect, it } from 'vitest';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { createApp } from '../interface/http/app.js';
import { DomainError } from '../domain/errors.js';

// Telemetría de assistant-service: ruta con plantilla, quién la hizo y, con un 500, la excepción; un 4xx de negocio no es error.
// Se prueba con el SDK real y una aplicación con dependencias de mentira: lo que importa es el cableado de app.ts.
const exporter = new InMemorySpanExporter();
const servidor = () => exporter.getFinishedSpans().filter((s) => s.kind === 1);

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).register();
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://colector:4318'; // lo que activa el middleware (como en producción)
  let llamadas = 0;
  const repos = {
    conversations: {
      listByUser: async () => {
        llamadas += 1;
        if (llamadas === 1) return [];
        if (llamadas === 2) throw new Error('falla interna');
        throw new DomainError('no existe', 'NOT_FOUND', 404);
      },
    },
  };
  app = createApp({ agent: {}, repos, crm: {}, corsOrigin: '' } as never);
});

const headers = { 'x-organization-id': 'org-1', 'x-user-id': 'user-1', authorization: 'Bearer token-de-prueba' };

describe('telemetría', () => {
  it('el span de servidor usa la plantilla de ruta y lleva organización y usuario (los pone el gateway, no el cliente)', async () => {
    exporter.reset();
    const res = await app.request('/assistant/conversations', { headers });
    expect(res.status).toBe(200);
    const spans = servidor();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toContain('/assistant/conversations');
    expect(spans[0].attributes['app.org_id']).toBe('org-1');
    expect(spans[0].attributes['app.user_id']).toBe('user-1');
  });

  it('un 500 deja UNA excepción con su pila y el span en error', async () => {
    exporter.reset();
    const res = await app.request('/assistant/conversations', { headers });
    expect(res.status).toBe(500);
    const [span] = servidor();
    expect(span.status.code).toBe(2);
    const excepciones = span.events.filter((e) => e.name === 'exception');
    expect(excepciones).toHaveLength(1);
    expect(excepciones[0].attributes?.['exception.stacktrace']).toBeTruthy();
  });

  it('un 4xx de negocio (DomainError) NO cuenta como error del servidor: es una respuesta normal y llenaría Exceptions', async () => {
    exporter.reset();
    const res = await app.request('/assistant/conversations', { headers });
    expect(res.status).toBe(404);
    const [span] = servidor();
    expect(span.events.some((e) => e.name === 'exception')).toBe(false);
    expect(span.status.code).not.toBe(2);
  });
});
