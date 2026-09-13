import { DataTypes, Model, Sequelize } from 'sequelize';

export class ConversationModel extends Model {}
export class MessageModel extends Model {}
export class PendingActionModel extends Model {}
export class UsageCounterModel extends Model {}

export function initModels(sequelize: Sequelize): void {
  ConversationModel.init(
    {
      id: { type: DataTypes.CHAR(36), primaryKey: true },
      organizationId: { type: DataTypes.CHAR(36), allowNull: false, field: 'organization_id' },
      userId: { type: DataTypes.CHAR(36), allowNull: false, field: 'user_id' },
      title: { type: DataTypes.STRING(200), allowNull: true },
      deletedAt: { type: DataTypes.DATE, allowNull: true, field: 'deleted_at' },
    },
    { sequelize, tableName: 'conversations', underscored: true, timestamps: true },
  );

  MessageModel.init(
    {
      id: { type: DataTypes.CHAR(36), primaryKey: true },
      // Orden del historial. Lo pone la base, nunca el código: es lo que
      // garantiza que un `tool_result` no adelante a su `tool_use`.
      seq: { type: DataTypes.BIGINT, autoIncrement: true, allowNull: false },
      conversationId: { type: DataTypes.CHAR(36), allowNull: false, field: 'conversation_id' },
      role: { type: DataTypes.ENUM('user', 'assistant'), allowNull: false },
      content: { type: DataTypes.JSON, allowNull: false },
      inputTokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'input_tokens' },
      outputTokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'output_tokens' },
      cacheReadTokens: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'cache_read_tokens',
      },
    },
    {
      sequelize,
      tableName: 'messages',
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    },
  );

  PendingActionModel.init(
    {
      id: { type: DataTypes.CHAR(36), primaryKey: true },
      conversationId: { type: DataTypes.CHAR(36), allowNull: false, field: 'conversation_id' },
      toolUseId: { type: DataTypes.STRING(100), allowNull: false, field: 'tool_use_id' },
      toolName: { type: DataTypes.STRING(100), allowNull: false, field: 'tool_name' },
      input: { type: DataTypes.JSON, allowNull: false },
      summary: { type: DataTypes.TEXT, allowNull: false },
      status: {
        type: DataTypes.ENUM('proposed', 'executed', 'rejected', 'failed'),
        allowNull: false,
        defaultValue: 'proposed',
      },
      result: { type: DataTypes.JSON, allowNull: true },
      decidedByUserId: { type: DataTypes.CHAR(36), allowNull: true, field: 'decided_by_user_id' },
    },
    { sequelize, tableName: 'pending_actions', underscored: true, timestamps: true },
  );

  UsageCounterModel.init(
    {
      organizationId: { type: DataTypes.CHAR(36), primaryKey: true, field: 'organization_id' },
      window: { type: DataTypes.STRING(7), primaryKey: true },
      inputTokens: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'input_tokens' },
      outputTokens: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'output_tokens' },
      requests: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    {
      sequelize,
      tableName: 'usage_counters',
      underscored: true,
      timestamps: true,
      createdAt: false,
      updatedAt: 'updated_at',
    },
  );
}
