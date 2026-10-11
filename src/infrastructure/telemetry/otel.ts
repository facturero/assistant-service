import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { MySQL2Instrumentation } from '@opentelemetry/instrumentation-mysql2';
import { SequelizeInstrumentation } from '@opentelemetry/instrumentation-sequelize';

// Debe ser lo PRIMERO que importa main.ts: las instrumentaciones parchean los módulos al cargarse, y los que se importaron
// antes ya no se parchean. Sin OTEL_EXPORTER_OTLP_ENDPOINT no hace nada (desarrollo local, pruebas).
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME ?? 'assistant-service',
      'service.version': process.env.OTEL_SERVICE_VERSION ?? '1.0.0',
      'deployment.environment': process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 30_000,
    }),
    instrumentations: [
      // El span de servidor lo crea `@hono/otel` (ver app.ts). Si HttpInstrumentation también lo hiciera, cada petición
      // tendría DOS spans de servidor (y se duplicaría su métrica de duración); aquí solo interesan las llamadas SALIENTES.
      // OJO: no usar `ignoreIncomingRequestHook`: suprime el contexto y desaparece también el span de `@hono/otel`.
      new HttpInstrumentation({ disableIncomingRequestInstrumentation: true }),
      // El asistente llama con `fetch` (undici) al modelo de lenguaje y a la API del CRM (a través del gateway): sin esto una respuesta lenta
      // del modelo o una acción que falla en otro servicio no se verían, y la traza del navegador se cortaría en el asistente.
      new UndiciInstrumentation(),
      new MySQL2Instrumentation(),
      new SequelizeInstrumentation(),
    ],
  });

  sdk.start();

  if (process.env.NODE_ENV !== 'test') {
    const shutdown = async (): Promise<void> => {
      try {
        await sdk.shutdown();
      } finally {
        process.exit(0);
      }
    };
    process.on('SIGTERM', () => {
      void shutdown();
    });
    process.on('SIGINT', () => {
      void shutdown();
    });
  }
}
