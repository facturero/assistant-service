/** @type {import('sequelize-cli').Migration} */
module.exports = {
  /**
   * Borrar una conversación es virtual: se marca `deleted_at` y deja de salir
   * en la lista y de poder abrirse o continuarse, pero la fila, sus mensajes y
   * sus acciones siguen en la base. Las acciones que el asistente ejecutó de
   * verdad en el CRM no se deshacen por borrar el chat, y su rastro tampoco
   * debería desaparecer.
   */
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('conversations', 'deleted_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('conversations', 'deleted_at');
  },
};
