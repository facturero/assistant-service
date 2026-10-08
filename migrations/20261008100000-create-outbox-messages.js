/** @type {import('sequelize-cli').Migration} */
module.exports = {
  /**
   * Outbox para la bitácora de auditoría. Lo que el asistente propone, lo que la persona confirma o rechaza y lo que
   * el CRM contesta quedaba solo en `pending_actions`, que ninguna otra parte del sistema lee: la bitácora central no
   * se enteraba. Mismo patrón que el resto de servicios (el relay publica estas filas a RabbitMQ).
   */
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('outbox_messages', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      aggregate_type: { type: Sequelize.STRING(50), allowNull: false },
      aggregate_id: { type: Sequelize.CHAR(36), allowNull: false },
      type: { type: Sequelize.STRING(100), allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: false },
      occurred_at: { type: Sequelize.DATE, allowNull: false },
      processed_at: { type: Sequelize.DATE, allowNull: true },
    });
    await queryInterface.addIndex('outbox_messages', ['processed_at']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('outbox_messages');
  },
};
