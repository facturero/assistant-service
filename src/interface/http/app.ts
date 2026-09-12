import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { Agent, TurnContext } from '../../application/agent';
import { Repositories } from '../../domain/repositories';
import { DomainError } from '../../domain/errors';
import { CrmApiPort } from '../../application/ports';

interface Vars {
  Variables: {
    userId: string;
    organizationId: string;
    bearerToken: string;
    locale: string;
  };
}

const sendSchema = z.object({
  conversationId: z.string().uuid().nullish(),
  text: z.string().min(1, 'Escribe algo').max(4000, 'El mensaje es demasiado largo'),
});

const decideSchema = z.object({ approve: z.boolean() });

/**
 * Contexto de la petición. Igual que el resto de servicios, este no valida JWT:
 * confía en las cabeceras del gateway. La diferencia es que además **necesita el
 * Bearer original**, porque con él vuelve a llamar a la API en nombre del
 * usuario. Si el gateway dejara de reenviarlo, el asistente se queda sin manos.
 */
function requireContext() {
  return async (c: any, next: () => Promise<void>) => {
    const orgId = c.req.header('X-Organization-Id');
    const userId = c.req.header('X-User-Id');
    const auth = c.req.header('Authorization') ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';

    if (!orgId || !userId) {
      return c.json(
        { code: 'ORG_CONTEXT_REQUIRED', message: 'Falta el contexto de organización.' },
        400,
      );
    }
    if (!bearer) {
      return c.json(
        { code: 'TOKEN_REQUIRED', message: 'El asistente necesita tu sesión para actuar en tu nombre.' },
        401,
      );
    }

    c.set('organizationId', orgId);
    c.set('userId', userId);
    c.set('bearerToken', bearer);
    c.set('locale', (c.req.header('Accept-Language') ?? 'es').slice(0, 2));
    await next();
  };
}

export function createApp(opts: {
  agent: Agent;
  repos: Repositories;
  crm: CrmApiPort;
  corsOrigin: string;
}): Hono<Vars> {
  const app = new Hono<Vars>();

  if (opts.corsOrigin) {
    app.use(
      '*',
      cors({
        origin: opts.corsOrigin.split(',').map((o) => o.trim()).filter(Boolean),
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Accept-Language'],
        credentials: true,
      }),
    );
  }

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.use('/assistant/*', requireContext());

  /** Hilos del usuario, para la lista lateral del chat. */
  app.get('/assistant/conversations', async (c) => {
    const list = await opts.repos.conversations.listByUser(
      c.get('organizationId'),
      c.get('userId'),
      30,
    );
    return c.json(
      list.map((conv) => ({
        id: conv.id,
        title: conv.title,
        updatedAt: conv.updatedAt.toISOString(),
      })),
    );
  });

  /** Historial de un hilo, ya masticado para la interfaz. */
  app.get('/assistant/conversations/:id', async (c) => {
    const conversation = await opts.repos.conversations.findById(c.req.param('id'));
    if (!conversation || !conversation.belongsTo(c.get('organizationId'), c.get('userId'))) {
      return c.json({ code: 'CONVERSATION_NOT_FOUND', message: 'La conversación no existe.' }, 404);
    }
    const [messages, actions] = await Promise.all([
      opts.repos.messages.listByConversation(conversation.id),
      opts.repos.actions.listByConversation(conversation.id),
    ]);
    return c.json({
      id: conversation.id,
      title: conversation.title,
      // Los bloques internos (tool_use, tool_result) no se enseñan: son fontanería.
      messages: messages
        .map((m) => ({ role: m.role, text: m.text, createdAt: m.createdAt.toISOString() }))
        .filter((m) => m.text.length > 0),
      pendingActions: actions
        .filter((a) => a.isPending)
        .map((a) => ({ id: a.id, toolName: a.toolName, summary: a.summary, input: a.input })),
    });
  });

  /** Mandar un mensaje: arranca o continúa el hilo. */
  app.post('/assistant/messages', async (c) => {
    const parsed = sendSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json(
        { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Petición inválida.' },
        400,
      );
    }
    const result = await opts.agent.startOrContinue({
      conversationId: parsed.data.conversationId ?? null,
      text: parsed.data.text,
      ctx: await buildTurnContext(c, opts.crm),
    });
    return c.json(result);
  });

  /** Confirmar o rechazar una escritura propuesta. */
  app.post('/assistant/actions/:id/decide', async (c) => {
    const parsed = decideSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ code: 'VALIDATION_ERROR', message: 'Falta indicar si se aprueba.' }, 400);
    }
    const result = await opts.agent.decideAction({
      actionId: c.req.param('id'),
      approve: parsed.data.approve,
      ctx: await buildTurnContext(c, opts.crm),
    });
    return c.json(result);
  });

  app.onError((err, c) => {
    if (err instanceof DomainError) {
      return c.json({ code: err.code, message: err.message }, err.status as 400);
    }
    console.error('[assistant-service] error no controlado:', err);
    return c.json({ code: 'INTERNAL_ERROR', message: 'Error interno del servidor.' }, 500);
  });

  return app;
}

/**
 * El contexto de organización se consulta a la propia API, con el token del
 * usuario: así el prompt sabe de qué empresa habla sin que este servicio tenga
 * que mantener un read-model más ni escuchar eventos.
 *
 * Son dos llamadas y no una porque ningún endpoint tiene las dos mitades:
 * `/auth/me` sabe quién eres, `/organizations/me` sabe el país de la empresa —
 * y el país decide qué identificación vale y cómo se factura, así que no puede
 * faltar. Van en paralelo: es red interna, pero son dos viajes por mensaje.
 * Si alguna falla, el turno sigue con ese dato en blanco: quedarse sin nombre de
 * empresa es peor que quedarse sin asistente.
 */
async function buildTurnContext(c: any, crm: CrmApiPort): Promise<TurnContext> {
  const bearerToken = c.get('bearerToken') as string;
  const locale = c.get('locale') as string;

  const [me, org] = await Promise.all([
    crm.call({ method: 'GET', path: '/auth/me', bearerToken }),
    crm.call({ method: 'GET', path: '/organizations/me', bearerToken }),
  ]);
  const profile = (me.ok ? me.body : {}) as Record<string, unknown>;
  const company = (org.ok ? org.body : {}) as Record<string, unknown>;

  return {
    organizationId: c.get('organizationId'),
    userId: c.get('userId'),
    bearerToken,
    locale,
    organization: {
      // El nombre comercial es por el que la gente llama a su empresa; la razón
      // social es el de los papeles. Se prefiere el primero y se cae al segundo.
      organizationName:
        (company.tradeName as string) ??
        (company.legalName as string) ??
        (profile.orgName as string) ??
        null,
      countryCode: (company.countryCode as string) ?? null,
      userName: (profile.fullName as string) ?? (profile.email as string) ?? null,
      locale,
      today: new Date().toISOString().slice(0, 10),
    },
  };
}
