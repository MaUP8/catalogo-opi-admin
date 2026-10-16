/**
 * Mudanza del backend entre cuentas de Google (una sola vez).
 *
 * En el proyecto VIEJO (cuenta de Mauri):
 *   1. Pegar este archivo como Migracion.gs.
 *   2. Ejecutar exportarPropiedades(). Crea en el Drive un archivo con todas las propiedades
 *      del script (usuarios, Outlet, descartados, historial, credenciales de Power BI),
 *      SIN el token de GitHub, y lo comparte solo con la cuenta nueva. El registro muestra su ID.
 *
 * En el proyecto NUEVO (cuenta de la empresa):
 *   3. Pegar Code.gs, Hair.gs y este archivo.
 *   4. Poner el ID en ID_EXPORTACION y ejecutar importarPropiedades().
 *   5. Cargar a mano GITHUB_TOKEN (el token nuevo de la organización).
 *
 * Al terminar: borrar el archivo del Drive viejo (lleva secretos) y vaciar ID_EXPORTACION.
 */

var CUENTA_NUEVA = 'info@pbgroup.com.uy';
var ID_EXPORTACION = '';   // ← pegar acá el ID que da exportarPropiedades()
var NO_MIGRAR = ['GITHUB_TOKEN', 'ADMIN_PIN'];

function exportarPropiedades() {
  var todo = PropertiesService.getScriptProperties().getProperties();
  NO_MIGRAR.forEach(function (k) { delete todo[k]; });
  var f = DriveApp.createFile('migracion-portal-catalogos.json', JSON.stringify(todo), 'application/json');
  f.addViewer(CUENTA_NUEVA);
  Logger.log('Exportadas ' + Object.keys(todo).length + ' propiedades: ' + Object.keys(todo).sort().join(', '));
  Logger.log('ID del archivo (copiarlo al proyecto nuevo): ' + f.getId());
}

function importarPropiedades() {
  if (!ID_EXPORTACION) throw new Error('Falta pegar el ID en ID_EXPORTACION.');
  var datos = JSON.parse(DriveApp.getFileById(ID_EXPORTACION).getBlob().getDataAsString());
  var p = PropertiesService.getScriptProperties();
  var previas = p.getKeys();
  p.setProperties(datos, false);   // false: no borra las que ya estén cargadas (ej. GITHUB_TOKEN)
  Logger.log('Importadas ' + Object.keys(datos).length + ' propiedades. Ya había: ' + (previas.join(', ') || 'ninguna'));
  Logger.log(p.getProperty('GITHUB_TOKEN') ? 'GITHUB_TOKEN cargado.' : 'FALTA cargar GITHUB_TOKEN a mano.');
}
