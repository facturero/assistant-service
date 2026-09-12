/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. conversations — una por hilo de chat, siempre de un usuario dentro de
    //    una organización. El aislamiento por tenant se aplica en el repositorio.
    await queryInterface.createTable('conversations', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      user_id: { type: Sequelize.CHAR(36), allowNull: false },
      title: { type: Sequelize.STRING(200), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('conversations', ['organization_id', 'user_id', 'updated_at']);

    // 2. messages — el historial tal cual lo devuelve la API. `content` guarda
    //    los bloques completos (texto, tool_use, tool_result), no solo el texto:
    //    es lo que permite reanudar la conversación sin perder nada.
    await queryInterface.createTable('messages', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      conversation_id: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'conversations', key: 'id' },
        onDelete: 'CASCADE',
      },
      role: { type: Sequelize.ENUM('user', 'assistant'), allowNull: false },
      content: { type: Sequelize.JSON, allowNull: false },
      input_tokens: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      output_tokens: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      cache_read_tokens: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('messages', ['conversation_id', 'created_at']);

    // 3. pending_actions — toda escritura que el asistente quiere hacer para aquí
    //    hasta que una persona la confirme. `tool_use_id` es el identificador que
    //    dio la API: al reanudar hay que devolver el resultado con ese mismo id o
    //    la conversación queda inconsistente.
    await queryInterface.createTable('pending_actions', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      conversation_id: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'conversations', key: 'id' },
        onDelete: 'CASCADE',
      },
      tool_use_id: { type: Sequelize.STRING(100), allowNull: false },
      tool_name: { type: Sequelize.STRING(100), allowNull: false },
      input: { type: Sequelize.JSON, allowNull: false },
      summary: { type: Sequelize.TEXT, allowNull: false },
      status: {
        type: Sequelize.ENUM('proposed', 'executed', 'rejected', 'failed'),
        allowNull: false,
        defaultValue: 'proposed',
      },
      result: { type: Sequelize.JSON, allowNull: true },
      decided_by_user_id: { type: Sequelize.CHAR(36), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('pending_actions', ['conversation_id', 'status']);
    await queryInterface.addIndex('pending_actions', ['tool_use_id'], { unique: true });

    // 4. usage_counters — consumo por organización y ventana. Aunque el asistente
    //    vaya incluido en la plataforma, el coste es variable y por uso: sin esto
    //    no hay forma de saber a quién le sale caro hasta que llega la factura.
    await queryInterface.createTable('usage_counters', {
      organization_id: { type: Sequelize.CHAR(36), primaryKey: true },
      window: { type: Sequelize.STRING(7), primaryKey: true, comment: 'YYYY-MM' },
      input_tokens: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      output_tokens: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      requests: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('usage_counters');
    await queryInterface.dropTable('pending_actions');
    await queryInterface.dropTable('messages');
    await queryInterface.dropTable('conversations');
  },
};
