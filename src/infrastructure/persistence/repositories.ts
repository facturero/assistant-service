import { Sequelize } from 'sequelize';
import { Conversation, Message, PendingAction } from '../../domain/entities';
import {
  ConversationRepository,
  MessageRepository,
  PendingActionRepository,
  Repositories,
  UsageRepository,
  UsageSnapshot,
} from '../../domain/repositories';
import {
  ConversationModel,
  MessageModel,
  PendingActionModel,
  UsageCounterModel,
} from './models';

/** Ventana de consumo: mes natural. Cambia una vez al mes, no por petición. */
export function currentWindow(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

class SequelizeConversationRepository implements ConversationRepository {
  async save(conversation: Conversation): Promise<void> {
    const p = conversation.toJSON();
    await ConversationModel.upsert({
      id: p.id,
      organizationId: p.organizationId,
      userId: p.userId,
      title: p.title,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    });
  }

  async findById(id: string): Promise<Conversation | null> {
    const row = await ConversationModel.findByPk(id);
    return row ? toConversation(row) : null;
  }

  async listByUser(organizationId: string, userId: string, limit: number): Promise<Conversation[]> {
    const rows = await ConversationModel.findAll({
      where: { organizationId, userId },
      order: [['updated_at', 'DESC']],
      limit,
    });
    return rows.map(toConversation);
  }
}

class SequelizeMessageRepository implements MessageRepository {
  async save(message: Message): Promise<void> {
    const p = message.toJSON();
    await MessageModel.create({
      id: p.id,
      conversationId: p.conversationId,
      role: p.role,
      content: p.content,
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      cacheReadTokens: p.cacheReadTokens,
      createdAt: p.createdAt,
    });
  }

  async listByConversation(conversationId: string): Promise<Message[]> {
    const rows = await MessageModel.findAll({
      where: { conversationId },
      // Por `seq` y no por fecha: ver la migración de la secuencia. Con
      // `created_at` (precisión de segundo) el orden dentro de un mismo segundo
      // quedaba al azar y rompía la pareja llamada/resultado.
      order: [['seq', 'ASC']],
    });
    return rows.map((row) => {
      const v = row.get({ plain: true }) as Record<string, unknown>;
      return Message.fromPersistence({
        id: String(v.id),
        conversationId: String(v.conversationId),
        role: v.role as 'user' | 'assistant',
        content: (v.content ?? []) as Record<string, unknown>[],
        inputTokens: Number(v.inputTokens ?? 0),
        outputTokens: Number(v.outputTokens ?? 0),
        cacheReadTokens: Number(v.cacheReadTokens ?? 0),
        // Se lee `created_at` y no `createdAt`: con `underscored: true` y el
        // alias `createdAt: 'created_at'`, Sequelize expone la columna con el
        // nombre del campo físico, no el del atributo.
        createdAt: v.created_at as Date,
      });
    });
  }
}

class SequelizePendingActionRepository implements PendingActionRepository {
  async save(action: PendingAction): Promise<void> {
    const p = action.toJSON();
    await PendingActionModel.upsert({
      id: p.id,
      conversationId: p.conversationId,
      toolUseId: p.toolUseId,
      toolName: p.toolName,
      input: p.input,
      summary: p.summary,
      status: p.status,
      result: p.result,
      decidedByUserId: p.decidedByUserId,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    });
  }

  async findById(id: string): Promise<PendingAction | null> {
    const row = await PendingActionModel.findByPk(id);
    return row ? toAction(row) : null;
  }

  async listByConversation(conversationId: string): Promise<PendingAction[]> {
    const rows = await PendingActionModel.findAll({
      where: { conversationId },
      order: [['created_at', 'ASC']],
    });
    return rows.map(toAction);
  }
}

class SequelizeUsageRepository implements UsageRepository {
  constructor(private readonly sequelize: Sequelize) {}

  async current(organizationId: string): Promise<UsageSnapshot> {
    const row = await UsageCounterModel.findOne({
      where: { organizationId, window: currentWindow() },
    });
    if (!row) return { inputTokens: 0, outputTokens: 0, requests: 0 };
    const v = row.get({ plain: true }) as Record<string, unknown>;
    return {
      inputTokens: Number(v.inputTokens ?? 0),
      outputTokens: Number(v.outputTokens ?? 0),
      requests: Number(v.requests ?? 0),
    };
  }

  /**
   * Suma atómica en la base. Hacerlo con un `SELECT` y luego un `UPDATE` desde
   * Node perdería cuentas en cuanto dos conversaciones avancen a la vez.
   */
  async add(organizationId: string, delta: UsageSnapshot): Promise<void> {
    await this.sequelize.query(
      // `window` va entre comillas invertidas: desde MySQL 8 es palabra
      // reservada (funciones de ventana) y sin ellas la consulta ni compila.
      // Sequelize lo hace solo en las consultas que genera él, pero esta es a
      // mano. Se vio en cuanto un turno llegó vivo hasta aquí por primera vez.
      `INSERT INTO usage_counters
         (organization_id, \`window\`, input_tokens, output_tokens, requests, updated_at)
       VALUES (:organizationId, :window, :inputTokens, :outputTokens, :requests, NOW())
       ON DUPLICATE KEY UPDATE
         input_tokens = input_tokens + VALUES(input_tokens),
         output_tokens = output_tokens + VALUES(output_tokens),
         requests = requests + VALUES(requests),
         updated_at = NOW()`,
      {
        replacements: {
          organizationId,
          window: currentWindow(),
          inputTokens: delta.inputTokens,
          outputTokens: delta.outputTokens,
          requests: delta.requests,
        },
      },
    );
  }
}

function toConversation(row: ConversationModel): Conversation {
  const v = row.get({ plain: true }) as Record<string, unknown>;
  return Conversation.fromPersistence({
    id: String(v.id),
    organizationId: String(v.organizationId),
    userId: String(v.userId),
    title: (v.title as string | null) ?? null,
    createdAt: v.createdAt as Date,
    updatedAt: v.updatedAt as Date,
  });
}

function toAction(row: PendingActionModel): PendingAction {
  const v = row.get({ plain: true }) as Record<string, unknown>;
  return PendingAction.fromPersistence({
    id: String(v.id),
    conversationId: String(v.conversationId),
    toolUseId: String(v.toolUseId),
    toolName: String(v.toolName),
    input: (v.input ?? {}) as Record<string, unknown>,
    summary: String(v.summary ?? ''),
    status: v.status as 'proposed' | 'executed' | 'rejected' | 'failed',
    result: v.result ?? null,
    decidedByUserId: (v.decidedByUserId as string | null) ?? null,
    createdAt: v.createdAt as Date,
    updatedAt: v.updatedAt as Date,
  });
}

export function createRepositories(sequelize: Sequelize): Repositories {
  return {
    conversations: new SequelizeConversationRepository(),
    messages: new SequelizeMessageRepository(),
    actions: new SequelizePendingActionRepository(),
    usage: new SequelizeUsageRepository(sequelize),
  };
}
