import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guardia de la bitácora de auditoría. La bitácora no se entera de lo que un servicio NO publica, así que cada vez que
 * alguien añade una acción que escribe en la base de datos sin dejar un evento, esa acción queda invisible sin que
 * nadie lo note (nos pasó con las IPs de confianza, los certificados, las bodegas y los temas del POS).
 *
 * Esta prueba mira el código fuente: un archivo de `application/` que escribe a través de un repositorio o una unidad
 * de trabajo, o un controlador de `interface/` que escribe directo en un modelo, tiene que mencionar el outbox (o la
 * auditoría). Si de verdad no debe publicar, se añade a EXENTOS con el motivo; la exención se revisa en la revisión de
 * código, y esta prueba falla si una exención deja de hacer falta.
 *
 * Es una revisión por heurística, no una prueba de comportamiento: no sustituye los tests del caso de uso.
 */
const EXENTOS: Record<string, string> = {};

const ESCRITURA_APLICACION =
  /\b(?:\w*[Rr]epo\w*|uow|repos)(?:\.\w+)*\.(?:save|create|delete|remove|destroy|upsert|bulkCreate|update|add)\(/;
const ESCRITURA_DIRECTA = /\b\w+Model\.(?:create|update|destroy|bulkCreate|upsert)\(/;
// Solo cuenta el CÓDIGO (sin comentarios ni imports): una palabra en un comentario no publica nada.
const MENCIONA_AUDITORIA = /outbox|recordAuditEvent|\baudit\??\.record\(/i;

function leerCodigo(ruta: string): string {
  return readFileSync(ruta, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/^\s*import .*$/gm, '');
}

function archivos(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const ruta = join(dir, e.name);
    return e.isDirectory() ? archivos(ruta) : [ruta];
  });
}

const fuentes = (carpeta: string) =>
  archivos(join(process.cwd(), 'src', carpeta)).filter((f) => f.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(f));

const nombre = (ruta: string) => (ruta.split(/[\\/]/).pop() ?? ruta).replace(/\.ts$/, '');

function escribenSinEvento(): string[] {
  return fuentes('application')
    .filter((f) => {
      const texto = leerCodigo(f);
      return ESCRITURA_APLICACION.test(texto) && !MENCIONA_AUDITORIA.test(texto);
    })
    .map(nombre);
}

describe('toda acción que escribe deja huella en la bitácora', () => {
  it('los casos de uso que escriben publican un evento (o están exentos con motivo)', () => {
    const sinEvento = escribenSinEvento().filter((n) => !(n in EXENTOS));
    expect(sinEvento, 'escriben en la base sin publicar al outbox: ' + sinEvento.join(', ')).toEqual([]);
  });

  it('los controladores no escriben directo en la base sin registrar el evento', () => {
    const sinEvento = fuentes('interface')
      .filter((f) => {
        const texto = leerCodigo(f);
        return ESCRITURA_DIRECTA.test(texto) && !MENCIONA_AUDITORIA.test(texto);
      })
      .map(nombre);
    expect(sinEvento, 'escriben directo en un modelo sin evento: ' + sinEvento.join(', ')).toEqual([]);
  });

  it('cada exención sigue haciendo falta (si el archivo ya publica o ya no existe, quítala)', () => {
    const vigentes = new Set(escribenSinEvento());
    const sobran = Object.keys(EXENTOS).filter((n) => !vigentes.has(n));
    expect(sobran, 'exenciones que ya no hacen falta: ' + sobran.join(', ')).toEqual([]);
  });
});
