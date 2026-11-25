import { describe, expect, it } from 'vitest';
import { Agent } from '../application/agent';
import { UsageLimitReachedError } from '../domain/errors';
import {
  createInMemoryRepositories,
  ctx,
  FakeCrmApi,
  ScriptedLlm,
  textBlock,
  toolUseBlock,
} from './helpers';

const options = { maxIterations: 5, monthlyTokenLimit: 0 };

describe('Agent — lecturas', () => {
  it('ejecuta una lectura sola y devuelve la respuesta, sin pedir permiso a nadie', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi(() => ({ ok: true, status: 200, body: { items: [{ id: 'c1' }] } }));
    const llm = new ScriptedLlm([
      { content: [toolUseBlock('tu_1', 'listar_clientes', { search: 'ana' })], stopReason: 'tool_use' },
      { content: [textBlock('Tienes un cliente que coincide con "ana".')] },
    ]);

    const result = await new Agent(repos, llm, crm, options).startOrContinue({
      conversationId: null,
      text: '¿tengo algún cliente que se llame ana?',
      ctx,
    });

    expect(result.pendingActions).toHaveLength(0);
    expect(result.reply).toContain('ana');
    expect(crm.calls).toHaveLength(1);
    expect(crm.calls[0]).toMatchObject({ method: 'GET', path: '/customers' });
  });

  it('los filtros de una lectura viajan como query, no en el cuerpo', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi();
    const llm = new ScriptedLlm([
      { content: [toolUseBlock('tu_1', 'listar_facturas', { from: '2026-03-01', to: '2026-03-31' })], stopReason: 'tool_use' },
      { content: [textBlock('Listo.')] },
    ]);

    await new Agent(repos, llm, crm, options).startOrContinue({
      conversationId: null,
      text: 'ventas de marzo',
      ctx,
    });

    expect(crm.calls[0].query).toEqual({ from: '2026-03-01', to: '2026-03-31' });
    expect(crm.calls[0].body).toBeUndefined();
  });

  it('un id en la ruta se sustituye en vez de mandarse como parámetro', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi();
    const llm = new ScriptedLlm([
      { content: [toolUseBlock('tu_1', 'ver_cliente', { id: 'abc-123' })], stopReason: 'tool_use' },
      { content: [textBlock('Ahí lo tienes.')] },
    ]);

    await new Agent(repos, llm, crm, options).startOrContinue({
      conversationId: null,
      text: 'dame el cliente abc-123',
      ctx,
    });

    expect(crm.calls[0].path).toBe('/customers/abc-123');
  });

  it('un error de la API llega al modelo como resultado, no revienta el turno', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi(() => ({ ok: false, status: 403, body: { code: 'PERMISSION_DENIED' } }));
    const llm = new ScriptedLlm([
      { content: [toolUseBlock('tu_1', 'listar_empleados', {})], stopReason: 'tool_use' },
      { content: [textBlock('No tienes permiso para ver los empleados.')] },
    ]);

    const result = await new Agent(repos, llm, crm, options).startOrContinue({
      conversationId: null,
      text: 'lista los empleados',
      ctx,
    });

    expect(result.reply).toContain('permiso');
    const lastUserMessage = repos.__messages.filter((m) => m.role === 'user').at(-1)!;
    expect(lastUserMessage.content[0]).toMatchObject({ type: 'tool_result', is_error: true });
  });

  it('recorta el resultado antes de que entre en la conversación', async () => {
    const repos = createInMemoryRepositories();
    // Lo que devuelve el CRM de verdad: uuid, recurso, acción y descripción.
    const crm = new FakeCrmApi(() => ({
      ok: true,
      status: 200,
      body: [
        { id: 'uuid-1', code: 'user:read', resource: 'user', action: 'read', description: null },
        { id: 'uuid-2', code: 'user:invite', resource: 'user', action: 'invite', description: null },
      ],
    }));
    const agent = new Agent(
      repos,
      new ScriptedLlm([
        { content: [toolUseBlock('tu-1', 'listar_permisos', {})] },
        { content: [textBlock('hay dos permisos')] },
      ]),
      crm,
      options,
    );

    const turno = await agent.startOrContinue({ conversationId: null, text: '¿qué permisos hay?', ctx });
    const historial = await repos.messages.listByConversation(turno.conversationId);
    const resultado = historial
      .flatMap((m) => m.content)
      .find((b) => b.type === 'tool_result');

    // Llegan los códigos y nada más: ni uuids, ni recurso, ni descripciones.
    expect(JSON.parse(String(resultado!.content))).toEqual(['user:read', 'user:invite']);
    expect(String(resultado!.content)).not.toContain('uuid-1');
  });

  it('un error no se recorta: ahí los detalles son justo lo que hace falta', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi(() => ({
      ok: false,
      status: 403,
      body: { code: 'PLUGIN_NOT_ACTIVE', detalle: 'modulo inactivo' },
    }));
    const agent = new Agent(
      repos,
      new ScriptedLlm([
        { content: [toolUseBlock('tu-1', 'listar_permisos', {})] },
        { content: [textBlock('no pude')] },
      ]),
      crm,
      options,
    );

    const turno = await agent.startOrContinue({ conversationId: null, text: '¿qué permisos hay?', ctx });
    const historial = await repos.messages.listByConversation(turno.conversationId);
    const resultado = historial
      .flatMap((m) => m.content)
      .find((b) => b.type === 'tool_result');

    expect(String(resultado!.content)).toContain('PLUGIN_NOT_ACTIVE');
    expect(String(resultado!.content)).toContain('modulo inactivo');
  });
});

describe('Agent — escrituras con confirmación', () => {
  it('si el modelo anuncia una escritura en prosa sin tool_use, se corrige y propone', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi();
    const llm = new ScriptedLlm([
      // Turno 1: anuncia con texto, sin llamada. El loop debe darse cuenta e
      // inyectar la corrección; el turno 2 es la respuesta corregida.
      { content: [textBlock('Voy a invitar a mariamagdalena@gmail.com con el rol de Administrador.')] },
      {
        content: [toolUseBlock('tu_2', 'invitar_empleado', { email: 'mariamagdalena@gmail.com', roleIds: ['r1'] })],
        stopReason: 'tool_use',
      },
    ]);

    const result = await new Agent(repos, llm, crm, options).startOrContinue({
      conversationId: null,
      text: 'invita a mariamagdalena@gmail.com con rol admin',
      ctx,
    });

    expect(llm.calls).toHaveLength(2);
    // Nada escrito. Leer /roles sí: la tarjeta pone el nombre del rol en vez de su id.
    expect(crm.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
    expect(result.pendingActions).toHaveLength(1);
    // La corrección viajó en la llamada intermedia, no en el historial.
    expect(JSON.stringify(llm.calls[1].messages)).toContain('Corrección');
    expect(JSON.stringify(repos.__messages)).not.toContain('Corrección');
  });

  it('la corrección se reintenta hasta MAX_WRITE_RETRIES y luego cierra', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi();
    // Tres turnos textuales: el total de llamadas al modelo = 1 + MAX_WRITE_RETRIES.
    const llm = new ScriptedLlm([
      { content: [textBlock('Voy a crear ese rol.')] },
      { content: [textBlock('Voy a crear ese rol.')] },
      { content: [textBlock('Voy a crear ese rol.')] },
    ]);

    const result = await new Agent(repos, llm, crm, options).startOrContinue({
      conversationId: null,
      text: 'crea un rol',
      ctx,
    });

    expect(llm.calls).toHaveLength(3);
    expect(result.pendingActions).toHaveLength(0);
    expect(result.reply).toContain('Voy a crear');
  });

  it('pedir confirmación en texto también se corrige: el botón lo pone el sistema', async () => {
    // Así respondía gemma4:12b sin razonamiento en el banco de modelos: datos bien elegidos, ninguna llamada.
    for (const pregunta of [
      '¿Confirmas que cree el rol Cajero con estos permisos?',
      '¿Deseas que proceda con la invitación?',
      'He verificado que no existe. ¿Deseas que lo cree con un precio de 2550 centavos?',
    ]) {
      const llm = new ScriptedLlm([
        { content: [textBlock(pregunta)] },
        { content: [toolUseBlock('tu_2', 'crear_rol', { name: 'Cajero', permissions: ['customer:read'] })], stopReason: 'tool_use' },
      ]);
      const result = await new Agent(createInMemoryRepositories(), llm, new FakeCrmApi(), options).startOrContinue({
        conversationId: null,
        text: 'crea un rol Cajero',
        ctx,
      });
      expect(llm.calls, pregunta).toHaveLength(2);
      expect(result.pendingActions, pregunta).toHaveLength(1);
    }
  });

  it('una pregunta sin verbo de escritura no se corrige', async () => {
    const llm = new ScriptedLlm([{ content: [textBlock('No puedo emitir facturas. ¿Quieres que busque al cliente primero?')] }]);
    await new Agent(createInMemoryRepositories(), llm, new FakeCrmApi(), options).startOrContinue({
      conversationId: null,
      text: 'factura a Juan',
      ctx,
    });
    expect(llm.calls).toHaveLength(1);
  });

  it('una respuesta que no anuncia escrituras no dispara correccion', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi();
    const llm = new ScriptedLlm([{ content: [textBlock('Puedo generar reportes de facturacion.')] }]);

    await new Agent(repos, llm, crm, options).startOrContinue({
      conversationId: null,
      text: 'puedes hacer reportes?',
      ctx,
    });

    expect(llm.calls).toHaveLength(1);
  });

  it('si la persona solo preguntó, ofrecer crear lo que falta no dispara la corrección', async () => {
    // Banco, 2026-11-25: «No lo encontré, ¿quieres que lo registre?» disparaba la corrección y el modelo acababa pidiendo el
    // precio de un producto que nadie había pedido crear.
    const pregunta = 'No encontré el Cemento Holcim en el catálogo. ¿Quieres que lo registre como producto nuevo?';
    const llm = new ScriptedLlm([{ content: [textBlock(pregunta)] }]);
    const r = await new Agent(createInMemoryRepositories(), llm, new FakeCrmApi(), options).startOrContinue({
      conversationId: null,
      text: '¿Cuántos sacos de Cemento Holcim nos quedan?',
      ctx,
    });
    expect(r.reply).toBe(pregunta);
    expect(llm.calls).toHaveLength(1);
  });

  it('si tras la corrección el modelo cierra sin texto, se devuelve lo que había dicho (no una burbuja vacía)', async () => {
    // Qwen razonaba hasta gastar los tokens y devolvía vacío tras un minuto (banco, 2026-11-25).
    const pregunta = '¿Quieres que registre el Cemento Holcim como producto nuevo?';
    const llm = new ScriptedLlm([{ content: [textBlock(pregunta)] }, { content: [] }]);
    const r = await new Agent(createInMemoryRepositories(), llm, new FakeCrmApi(), options).startOrContinue({
      conversationId: null,
      text: 'Registra el Cemento Holcim como producto',
      ctx,
    });
    expect(r.reply).toBe(pregunta);
    expect(JSON.stringify(llm.calls[1]!.messages)).toContain('no menciones esta corrección');
  });

  it('si el modelo cierra sin texto y no hay nada anterior, se dice que no pudo terminar', async () => {
    const llm = new ScriptedLlm([{ content: [] }]);
    const r = await new Agent(createInMemoryRepositories(), llm, new FakeCrmApi(), options).startOrContinue({
      conversationId: null,
      text: 'hola',
      ctx,
    });
    expect(r.reply).toMatch(/No pude terminar/);
  });

  it('no ejecuta una escritura: la propone y para', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi();
    const llm = new ScriptedLlm([
      {
        content: [
          textBlock('Voy a crear ese rol.'),
          toolUseBlock('tu_1', 'crear_rol', { name: 'Cajero', permissions: ['invoice:create'] }),
        ],
        stopReason: 'tool_use',
      },
    ]);

    const result = await new Agent(repos, llm, crm, options).startOrContinue({
      conversationId: null,
      text: 'crea un rol de cajero que solo facture',
      ctx,
    });

    expect(result.pendingActions).toHaveLength(1);
    expect(result.pendingActions[0].summary).toContain('Cajero');
    expect(result.pendingActions[0].summary).toContain('invoice:create');
    // Lo importante: NADA se llamó contra la API.
    // Escrituras: ninguna. Las lecturas de la revisión previa (roles, permisos) no cuentan.
    expect(crm.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('al confirmar, ejecuta la llamada real y deja que el modelo cierre el turno', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi(() => ({ ok: true, status: 201, body: { id: 'rol-9' } }));
    const llm = new ScriptedLlm([
      {
        content: [toolUseBlock('tu_1', 'crear_rol', { name: 'Cajero', permissions: ['invoice:create'] })],
        stopReason: 'tool_use',
      },
      { content: [textBlock('Listo, creé el rol Cajero.')] },
    ]);
    const agent = new Agent(repos, llm, crm, options);

    const proposal = await agent.startOrContinue({
      conversationId: null,
      text: 'crea un rol de cajero',
      ctx,
    });
    const result = await agent.decideAction({
      actionId: proposal.pendingActions[0].id,
      approve: true,
      ctx,
    });

    expect(crm.calls.filter((c) => c.method !== 'GET')).toHaveLength(1);
    expect(crm.calls.filter((c) => c.method !== 'GET')[0]).toMatchObject({ method: 'POST', path: '/roles' });
    expect(crm.calls.filter((c) => c.method !== 'GET')[0].body).toMatchObject({ name: 'Cajero' });
    expect(result.reply).toContain('Cajero');
    expect(result.pendingActions).toHaveLength(0);
  });

  it('al rechazar, no llama a nada y se lo dice al modelo', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi();
    const llm = new ScriptedLlm([
      { content: [toolUseBlock('tu_1', 'crear_rol', { name: 'Cajero', permissions: [] })], stopReason: 'tool_use' },
      { content: [textBlock('De acuerdo, no lo creo.')] },
    ]);
    const agent = new Agent(repos, llm, crm, options);

    const proposal = await agent.startOrContinue({ conversationId: null, text: 'crea un rol', ctx });
    const result = await agent.decideAction({
      actionId: proposal.pendingActions[0].id,
      approve: false,
      ctx,
    });

    expect(crm.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
    expect(result.reply).toContain('no lo creo');
    const resumeMessage = repos.__messages.filter((m) => m.role === 'user').at(-1)!;
    expect(JSON.stringify(resumeMessage.content)).toContain('rechaz');
    // Un dato, no una frase: el modelo copiaba la frase en su respuesta.
    expect(JSON.stringify(resumeMessage.content)).not.toContain('No la vuelvas');
  });

  it('con dos escrituras en un turno, no reanuda hasta que se deciden las dos', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi();
    const llm = new ScriptedLlm([
      {
        content: [
          toolUseBlock('tu_1', 'crear_rol', { name: 'Cajero', permissions: [] }),
          toolUseBlock('tu_2', 'invitar_empleado', { email: 'a@b.c', roleIds: ['r1'] }),
        ],
        stopReason: 'tool_use',
      },
      { content: [textBlock('Hecho todo.')] },
    ]);
    const agent = new Agent(repos, llm, crm, options);

    const proposal = await agent.startOrContinue({ conversationId: null, text: 'crea un rol e invita a alguien', ctx });
    expect(proposal.pendingActions).toHaveLength(2);

    const afterFirst = await agent.decideAction({
      actionId: proposal.pendingActions[0].id,
      approve: true,
      ctx,
    });
    // Todavía queda una: el turno sigue suspendido y el modelo no se ha llamado.
    expect(afterFirst.reply).toBe('');
    expect(afterFirst.pendingActions).toHaveLength(1);

    const afterSecond = await agent.decideAction({
      actionId: afterFirst.pendingActions[0].id,
      approve: true,
      ctx,
    });
    expect(afterSecond.reply).toBe('Hecho todo.');
    // Las escrituras, en orden (las lecturas de la tarjeta de invitar no cuentan).
    expect(crm.calls.filter((c) => c.method !== 'GET').map((c) => c.path)).toEqual(['/roles', '/users/invite']);
  });

  it('una escritura decidida dos veces se rechaza', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi();
    const llm = new ScriptedLlm([
      { content: [toolUseBlock('tu_1', 'crear_rol', { name: 'X', permissions: [] })], stopReason: 'tool_use' },
      { content: [textBlock('ok')] },
    ]);
    const agent = new Agent(repos, llm, crm, options);
    const proposal = await agent.startOrContinue({ conversationId: null, text: 'crea un rol', ctx });
    await agent.decideAction({ actionId: proposal.pendingActions[0].id, approve: true, ctx });

    await expect(
      agent.decideAction({ actionId: proposal.pendingActions[0].id, approve: true, ctx }),
    ).rejects.toThrow(/ya se decidió/i);
  });
});

describe('Agent — límites y bordes', () => {
  it('una conversación de otro usuario no existe para ti', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi();
    const agent = new Agent(repos, new ScriptedLlm([{ content: [textBlock('hola')] }]), crm, options);
    const mine = await agent.startOrContinue({ conversationId: null, text: 'hola', ctx });

    const otherAgent = new Agent(repos, new ScriptedLlm([{ content: [textBlock('hola')] }]), crm, options);
    await expect(
      otherAgent.startOrContinue({
        conversationId: mine.conversationId,
        text: 'enséñame esto',
        ctx: { ...ctx, userId: 'otro-usuario' },
      }),
    ).rejects.toThrow(/no existe/i);
  });

  it('una acción de otra organización no existe, aunque ya esté decidida', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi();
    const agent = new Agent(
      repos,
      new ScriptedLlm([
        { content: [toolUseBlock('tu-1', 'crear_cliente', { businessName: 'Acme' })] },
        { content: [textBlock('hecho')] },
      ]),
      crm,
      options,
    );

    const turno = await agent.startOrContinue({ conversationId: null, text: 'crea a Acme', ctx });
    const accion = turno.pendingActions[0]!;
    await agent.decideAction({ actionId: accion.id, approve: true, ctx });

    // Ya está ejecutada. Otra organización tiene que ver "no existe" y NO "ya
    // fue decidida": la diferencia entre las dos respuestas es, por sí sola, un
    // dato sobre la empresa de al lado.
    const ajeno = { ...ctx, organizationId: 'otra-empresa', userId: 'otro-usuario' };
    await expect(
      agent.decideAction({ actionId: accion.id, approve: true, ctx: ajeno }),
    ).rejects.toThrow(/no existe/i);
  });

  it('corta el bucle al llegar al tope de vueltas en vez de girar para siempre', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi();
    const turns = Array.from({ length: 3 }, () => ({
      content: [toolUseBlock(`tu_${Math.random()}`, 'listar_clientes', {})],
      stopReason: 'tool_use',
    }));
    const agent = new Agent(repos, new ScriptedLlm(turns), crm, {
      maxIterations: 3,
      monthlyTokenLimit: 0,
    });

    const result = await agent.startOrContinue({ conversationId: null, text: 'da vueltas', ctx });

    expect(result.truncated).toBe(true);
    expect(result.pendingActions).toHaveLength(0);
  });

  it('con el límite de tokens agotado no se llama al modelo', async () => {
    const repos = createInMemoryRepositories();
    await repos.usage.add('org-1', { inputTokens: 900, outputTokens: 200, requests: 1 });
    const llm = new ScriptedLlm([{ content: [textBlock('no debería llegar aquí')] }]);
    const agent = new Agent(repos, llm, new FakeCrmApi(), {
      maxIterations: 5,
      monthlyTokenLimit: 1000,
    });

    await expect(
      agent.startOrContinue({ conversationId: null, text: 'hola', ctx }),
    ).rejects.toBeInstanceOf(UsageLimitReachedError);
    expect(llm.calls).toHaveLength(0);
  });

  it('cuenta el consumo por organización', async () => {
    const repos = createInMemoryRepositories();
    const llm = new ScriptedLlm([
      { content: [textBlock('hola')], usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 } },
    ]);
    await new Agent(repos, llm, new FakeCrmApi(), options).startOrContinue({
      conversationId: null,
      text: 'hola',
      ctx,
    });

    expect(await repos.usage.current('org-1')).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      requests: 1,
    });
  });

  it('si el modelo declina, se cierra el turno con una explicación en vez de un error', async () => {
    const repos = createInMemoryRepositories();
    const llm = new ScriptedLlm([
      {
        content: [textBlock('No puedo ayudarte con eso.')],
        stopReason: 'refusal',
        stopDetails: { category: 'cyber', explanation: null },
      },
    ]);

    const result = await new Agent(repos, llm, new FakeCrmApi(), options).startOrContinue({
      conversationId: null,
      text: 'algo que se rechaza',
      ctx,
    });

    expect(result.reply).toContain('No puedo ayudarte');
    expect(result.truncated).toBe(false);
  });

  it('el título del hilo sale de lo primero que escribió la persona', async () => {
    const repos = createInMemoryRepositories();
    const agent = new Agent(repos, new ScriptedLlm([{ content: [textBlock('ok')] }]), new FakeCrmApi(), options);
    const result = await agent.startOrContinue({
      conversationId: null,
      text: '  ¿cuánto   facturé en marzo? ',
      ctx,
    });

    const conversation = repos.__conversations.get(result.conversationId)!;
    expect(conversation.title).toBe('¿cuánto facturé en marzo?');
  });
});
