/**
 * Altas de clientas nuevas desde el catálogo OPI · Interior del país.
 *
 * Proyecto de Apps Script SEPARADO del portal (no comparte el token de GitHub), vinculado a la
 * planilla "Altas catálogo interior" de la cuenta de la empresa (info@pbgroup.com.uy).
 *
 * Puesta en marcha (una vez):
 *   1. Con la cuenta de la empresa, crear la planilla → Extensiones → Apps Script → pegar este archivo.
 *   2. Ejecutar preparar(): arma la hoja "Altas" y la carpeta privada "Cédulas · altas catálogo".
 *   3. Implementar → Nueva implementación → Aplicación web. Ejecutar como: Yo. Acceso: Cualquier persona.
 *      Copiar la URL /exec al catálogo (VAR.interior.altas en index.html de catalogo-opi).
 *   4. Opcional: propiedad AVISAR con mails separados por coma para recibir aviso de cada alta.
 *
 * Datos personales (Ley 18.331): la carpeta de cédulas es privada. No compartirla con link.
 * La clienta da su consentimiento en el catálogo antes de enviar los datos.
 */

var HOJA = 'Altas';
var COLUMNAS = ['Fecha', 'Ref. prospecto', 'Salón / comercio', 'Nombre y apellido', 'Cédula', 'RUT',
  'Dirección', 'Localidad', 'Departamento', 'Celular', 'Mail', 'Agencia de envío',
  'Pedido', 'Cédula frente', 'Cédula dorso', 'Consentimiento', 'Estado', 'N° cliente GCI', 'Notas'];
var MAX_FOTO_B64 = 4 * 1024 * 1024;   // ~3 MB de imagen; el catálogo las manda de ~250 KB

function preparar() {
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(HOJA) || ss.insertSheet(HOJA);
  if (sh.getLastRow() === 0) {
    sh.appendRow(COLUMNAS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, COLUMNAS.length).setFontWeight('bold').setBackground('#f3f3f3');
    var reglas = SpreadsheetApp.newDataValidation().requireValueInList(['Pendiente', 'Dada de alta en GCI', 'Rechazada'], true).build();
    sh.getRange(2, COLUMNAS.indexOf('Estado') + 1, 1000, 1).setDataValidation(reglas);
  }
  var p = PropertiesService.getScriptProperties();
  if (!p.getProperty('CARPETA')) p.setProperty('CARPETA', DriveApp.createFolder('Cédulas · altas catálogo').getId());
  Logger.log('Listo. Hoja "' + HOJA + '" y carpeta privada ' + p.getProperty('CARPETA'));
}

function doGet() { return out_({ ok: true, servicio: 'altas catálogo interior' }); }

function doPost(e) {
  try {
    var d = JSON.parse(e.postData.contents);
    if (d.web) return out_({ ok: true });                     // campo trampa: lo llenan solo los robots
    if (d.tipo === 'foto') return out_(foto_(d));
    if (d.tipo === 'alta') return out_(alta_(d));
    return out_({ ok: false, error: 'tipo desconocido' });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  }
}

function foto_(d) {
  var lado = d.lado === 'dorso' ? 'dorso' : 'frente';
  if (!d.img || d.img.length > MAX_FOTO_B64) throw new Error('foto vacía o demasiado grande');
  var bytes = Utilities.base64Decode(d.img);
  if ((bytes[0] & 0xff) !== 0xff || (bytes[1] & 0xff) !== 0xd8) throw new Error('la foto no es JPEG');
  var nombre = Utilities.formatDate(new Date(), 'America/Montevideo', 'yyyyMMdd-HHmmss') + '_' + limpio_(d.ref || 'sinref', 20) + '_' + lado + '.jpg';
  var f = carpeta_().createFile(Utilities.newBlob(bytes, 'image/jpeg', nombre));
  return { ok: true, id: f.getId() };
}

function alta_(d) {
  var a = d.datos || {};
  ['nombre', 'cedula', 'direccion', 'localidad', 'depto'].forEach(function (k) {
    if (!String(a[k] || '').trim()) throw new Error('falta ' + k);
  });
  if (!d.consentimiento) throw new Error('falta el consentimiento');
  var ci = String(a.cedula).replace(/\D/g, '');
  var fotos = d.fotos || {}, links = {};
  ['frente', 'dorso'].forEach(function (lado) {
    if (!fotos[lado]) return;
    try {
      var f = DriveApp.getFileById(fotos[lado]);
      if (f.getParents().next().getId() !== carpeta_().getId()) return;   // solo archivos de nuestra carpeta
      f.setName('CI_' + ci + '_' + lado + '_' + limpio_(a.nombre, 40) + '.jpg');
      links[lado] = '=HYPERLINK("' + f.getUrl() + '";"Ver ' + lado + '")';
    } catch (err) { links[lado] = 'no encontrada'; }
  });
  var fila = [new Date(), limpio_(d.ref, 20), limpio_(a.salon, 80), limpio_(a.nombre, 80), ci, limpio_(a.rut, 20),
    limpio_(a.direccion, 120), limpio_(a.localidad, 60), limpio_(a.depto, 30), limpio_(d.celular || a.celular, 20),
    limpio_(a.mail, 80), limpio_(a.agencia, 60), limpio_(d.pedido, 120),
    links.frente || 'por WhatsApp', links.dorso || 'por WhatsApp',
    'Sí · ' + Utilities.formatDate(new Date(), 'America/Montevideo', 'dd/MM/yyyy HH:mm'), 'Pendiente', '', ''];
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try { SpreadsheetApp.getActive().getSheetByName(HOJA).appendRow(fila); } finally { lock.releaseLock(); }
  avisar_(fila);
  return { ok: true };
}

function avisar_(fila) {
  var a = PropertiesService.getScriptProperties().getProperty('AVISAR');
  if (!a) return;
  MailApp.sendEmail(a, 'Nueva alta desde el catálogo interior: ' + (fila[2] || fila[3]) + ' (' + fila[7] + ')',
    'Entró un alta nueva.\n\n' + fila[3] + ' · ' + fila[2] + '\n' + fila[7] + ', ' + fila[8] +
    '\nPedido: ' + fila[12] + '\n\nPlanilla: ' + SpreadsheetApp.getActive().getUrl());
}

function carpeta_() { return DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('CARPETA')); }
// Texto plano y acotado; evita que algo que empiece con = + - @ se interprete como fórmula en la planilla.
function limpio_(v, max) { return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().replace(/^[=+\-@]+/, '').slice(0, max || 100); }
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
