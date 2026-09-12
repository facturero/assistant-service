/** @type {import('sequelize-cli').Migration} */
module.exports = {
  /**
   * El historial es un registro que solo crece, y su orden **no es un detalle
   * de presentación**: la API exige que el resultado de una herramienta venga
   * justo después de la llamada que lo pidió. Ordenar por `created_at` no vale,
   * porque la columna era DATETIME con precisión de segundo: dos mensajes del
   * mismo segundo salían en orden indefinido, el modelo recibía un resultado
   * sin su llamada y contestaba basura. Se vio con un modelo local, pero pasaba
   * con cualquier proveedor.
   *
   * `seq` lo resuelve de raíz: MySQL garantiza que crece, no depende del reloj
   * y no hay empates posibles.
   */
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('messages', 'seq', {
      type: Sequelize.BIGINT,
      allowNull: false,
      autoIncrement: true,
      unique: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('messages', 'seq');
  },
};
