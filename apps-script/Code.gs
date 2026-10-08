/**
 * Backend del portal de administración de los catálogos OPI.
 * Corre como Web App de Google Apps Script en la cuenta de Mauri.
 *
 * Propiedades del script (Configuración del proyecto → Propiedades del script):
 *   GITHUB_TOKEN  token "fine-grained" de GitHub con permiso Contents: Read and write
 *                 SOLO sobre MaUP8/catalogo-opi y MaUP8/catalogo-opi-interior.
 *   ADMIN_EMAIL   mail del administrador (Mauri).
 *   ADMIN_PIN     PIN inicial del administrador. Se guarda cifrado en el primer uso y se borra.
 *   PBI_TENANT_ID, PBI_CLIENT_ID, PBI_CLIENT_SECRET   app de Azure con acceso al modelo publicado.
 *   PBI_WORKSPACE_ID (opcional), PBI_DATASET_ID       modelo semántico PBG-BI publicado.
 *   PBI_COL_NOMBRE (opcional)  columna de PbiProductos con el nombre del producto, si la automática no acierta.
 * El script genera solo SECRET (firma de sesiones), USERS (usuarios con PIN cifrado), LOG y ULTIMA_ACT.
 *
 * Actualización automática: ejecutar una vez instalarActualizacion() desde el editor. Corre de lunes a
 * viernes entre las 8 y las 9 y entre las 12 y las 13 (hora de Montevideo).
 */

var REPOS = {
  profesionales: 'MaUP8/catalogo-opi',
  interior: 'MaUP8/catalogo-opi-interior'
};
var ARCHIVOS = ['data/config.json', 'data/ajustes.json'];
var SESION_HORAS = 12;
var MAX_INTENTOS = 5, BLOQUEO_MIN = 15;

function doPost(e) {
  var r;
  try {
    var q = JSON.parse(e.postData.contents || '{}');
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try { r = rutear_(q); } finally { lock.releaseLock(); }
  } catch (err) {
    r = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(r)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, servicio: 'portal catálogos OPI' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function rutear_(q) {
  inicializar_();
  if (q.accion === 'login') return login_(q.email, q.pin);
  var u = sesion_(q.token);
  if (!u) return { ok: false, error: 'sesion', mensaje: 'La sesión venció. Volvé a ingresar.' };
  switch (q.accion) {
    case 'yo': return { ok: true, email: u.email, rol: u.rol, nombre: u.nombre || '' };
    case 'leer': return leer_(q.catalogo);
    case 'guardar': return guardar_(u, q.catalogo, q.archivos, q.resumen);
    case 'historial': return { ok: true, log: log_(), ultima: JSON.parse(props_().getProperty('ULTIMA_ACT') || 'null') };
    case 'actualizar': return actualizarDesdePortal_(u);
    case 'sinPublicar': return sinPublicar_(u);
    case 'sistema': return sistema_(u);
    case 'publicar': return publicar_(u, q.producto);
    case 'descartar': return descartar_(u, q.sku, q.valor);
    case 'outletLeer': return { ok: true, outlet: outletCfg_() };
    case 'outletGuardar': return outletGuardar_(u, q.outlet);
    case 'cambiarFoto': return cambiarFoto_(u, q.sku, q.foto);
    case 'pin': return cambiarPin_(u, q.actual, q.nuevo);
    case 'usuarios': soloAdmin_(u); return { ok: true, usuarios: listarUsuarios_() };
    case 'usuarioGuardar': soloAdmin_(u); return guardarUsuario_(u, q.usuario);
    case 'usuarioBorrar': soloAdmin_(u); return borrarUsuario_(u, q.email);
  }
  return { ok: false, error: 'Acción desconocida' };
}

/* ---------- usuarios y sesiones ---------- */

function props_() { return PropertiesService.getScriptProperties(); }
function usuarios_() { return JSON.parse(props_().getProperty('USERS') || '{}'); }
function guardarUsuarios_(u) { props_().setProperty('USERS', JSON.stringify(u)); }
function norm_(e) { return String(e || '').trim().toLowerCase(); }

function inicializar_() {
  var p = props_();
  if (!p.getProperty('SECRET')) p.setProperty('SECRET', Utilities.getUuid() + Utilities.getUuid());
  var ae = norm_(p.getProperty('ADMIN_EMAIL')), ap = p.getProperty('ADMIN_PIN');
  if (ae && ap) {
    var us = usuarios_();
    var sal = Utilities.getUuid();
    us[ae] = { nombre: (us[ae] && us[ae].nombre) || '', rol: 'admin', sal: sal, hash: hashPin_(ap, sal) };
    guardarUsuarios_(us);
    p.deleteProperty('ADMIN_PIN');
  }
}

function hashPin_(pin, sal) {
  var h = sal + '|' + String(pin);
  for (var i = 0; i < 2000; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + sal));
  }
  return h;
}

function login_(email, pin) {
  email = norm_(email);
  var c = CacheService.getScriptCache(), k = 'fail_' + email;
  var fallas = +(c.get(k) || 0);
  if (fallas >= MAX_INTENTOS) return { ok: false, error: 'bloqueado', mensaje: 'Demasiados intentos. Probá de nuevo en ' + BLOQUEO_MIN + ' minutos.' };
  var u = usuarios_()[email];
  if (!u || !/^\d{4,8}$/.test(String(pin || '')) || hashPin_(pin, u.sal) !== u.hash) {
    c.put(k, String(fallas + 1), BLOQUEO_MIN * 60);
    Utilities.sleep(800);
    return { ok: false, error: 'credenciales', mensaje: 'Mail o PIN incorrectos.' };
  }
  c.remove(k);
  var exp = Date.now() + SESION_HORAS * 3600 * 1000;
  var cuerpo = Utilities.base64EncodeWebSafe(JSON.stringify({ e: email, x: exp }));
  return { ok: true, token: cuerpo + '.' + firma_(cuerpo), email: email, rol: u.rol, nombre: u.nombre || '' };
}

function firma_(s) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(s, props_().getProperty('SECRET')));
}

function sesion_(token) {
  if (!token || token.indexOf('.') < 0) return null;
  var partes = token.split('.');
  if (firma_(partes[0]) !== partes[1]) return null;
  var d = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(partes[0])).getDataAsString());
  if (!d.x || d.x < Date.now()) return null;
  var u = usuarios_()[d.e];
  if (!u) return null;
  return { email: d.e, rol: u.rol, nombre: u.nombre };
}

function soloAdmin_(u) { if (u.rol !== 'admin') throw new Error('Solo el administrador puede hacer esto.'); }

function listarUsuarios_() {
  var us = usuarios_();
  return Object.keys(us).sort().map(function (e) { return { email: e, nombre: us[e].nombre || '', rol: us[e].rol }; });
}

function guardarUsuario_(adm, x) {
  var email = norm_(x && x.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, mensaje: 'Mail inválido.' };
  var us = usuarios_(), nuevo = !us[email];
  if (nuevo && !x.pin) return { ok: false, mensaje: 'Para un usuario nuevo hay que poner un PIN.' };
  if (x.pin && !/^\d{4,8}$/.test(String(x.pin))) return { ok: false, mensaje: 'El PIN tiene que ser de 4 a 8 números.' };
  var rol = x.rol === 'admin' ? 'admin' : 'editor';
  if (email === adm.email && rol !== 'admin') return { ok: false, mensaje: 'No podés quitarte el rol de administrador.' };
  var u = us[email] || {};
  u.nombre = String(x.nombre || u.nombre || '').slice(0, 60);
  u.rol = rol;
  if (x.pin) { u.sal = Utilities.getUuid(); u.hash = hashPin_(x.pin, u.sal); }
  us[email] = u;
  guardarUsuarios_(us);
  registrar_(adm.email, (nuevo ? 'Alta' : 'Cambio') + ' de usuario ' + email + (x.pin ? ' (PIN nuevo)' : ''));
  return { ok: true, usuarios: listarUsuarios_() };
}

function borrarUsuario_(adm, email) {
  email = norm_(email);
  if (email === adm.email) return { ok: false, mensaje: 'No podés borrarte a vos mismo.' };
  var us = usuarios_();
  delete us[email];
  guardarUsuarios_(us);
  registrar_(adm.email, 'Baja de usuario ' + email);
  return { ok: true, usuarios: listarUsuarios_() };
}

function cambiarPin_(u, actual, nuevo) {
  var us = usuarios_(), x = us[u.email];
  if (hashPin_(actual, x.sal) !== x.hash) return { ok: false, mensaje: 'El PIN actual no es correcto.' };
  if (!/^\d{4,8}$/.test(String(nuevo || ''))) return { ok: false, mensaje: 'El PIN tiene que ser de 4 a 8 números.' };
  x.sal = Utilities.getUuid(); x.hash = hashPin_(nuevo, x.sal);
  guardarUsuarios_(us);
  registrar_(u.email, 'Cambió su PIN');
  return { ok: true };
}

/* ---------- archivos de los catálogos (GitHub) ---------- */

function gh_(metodo, ruta, cuerpo) {
  var tok = props_().getProperty('GITHUB_TOKEN');
  if (!tok) throw new Error('Falta GITHUB_TOKEN en las propiedades del script.');
  var op = {
    method: metodo, muteHttpExceptions: true, contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  };
  if (cuerpo) op.payload = JSON.stringify(cuerpo);
  var r = UrlFetchApp.fetch('https://api.github.com/repos/' + ruta, op);
  return { code: r.getResponseCode(), json: JSON.parse(r.getContentText() || '{}') };
}

function leer_(catalogo) {
  var repo = REPOS[catalogo];
  if (!repo) return { ok: false, mensaje: 'Catálogo desconocido.' };
  var out = {};
  ARCHIVOS.forEach(function (p) {
    var r = gh_('get', repo + '/contents/' + p + '?ref=main');
    if (r.code === 200) {
      out[p] = { sha: r.json.sha, contenido: JSON.parse(Utilities.newBlob(Utilities.base64Decode(r.json.content)).getDataAsString('UTF-8')) };
    } else if (r.code === 404) {
      out[p] = { sha: null, contenido: null };
    } else {
      throw new Error('GitHub respondió ' + r.code + ' al leer ' + p);
    }
  });
  return { ok: true, archivos: out };
}

function validar_(path, c) {
  if (path === 'data/config.json') {
    if (!c || !Array.isArray(c.telefonos) || !c.telefonos.length) throw new Error('Tiene que haber al menos un teléfono.');
    c.telefonos.forEach(function (t) {
      t.tel = String(t.tel || '').replace(/[^0-9]/g, '');
      if (!/^598\d{8}$/.test(t.tel)) throw new Error('Teléfono inválido: ' + t.tel + ' (formato 5989XXXXXXX).');
      t.nombre = String(t.nombre || '').slice(0, 40);
    });
    c.minimo = Math.round(+c.minimo);
    if (!(c.minimo >= 0 && c.minimo <= 1000000)) throw new Error('Mínimo inválido.');
    if (c.bajoMinimo !== 'bloquea' && c.bajoMinimo !== 'publico') throw new Error('Regla de mínimo inválida.');
    c.outlet = !!c.outlet;
    return { telefonos: c.telefonos, minimo: c.minimo, bajoMinimo: c.bajoMinimo, outlet: c.outlet };
  }
  if (path === 'data/ajustes.json') {
    var o = (c && c.ocultos || []).map(String).filter(function (k) { return /^[0-9A-Za-z.\-]+$/.test(k); });
    return { ocultos: o };
  }
  throw new Error('Archivo no permitido.');
}

function guardar_(u, catalogo, archivos, resumen) {
  var repo = REPOS[catalogo];
  if (!repo) return { ok: false, mensaje: 'Catálogo desconocido.' };
  var hechos = [];
  Object.keys(archivos || {}).forEach(function (p) {
    if (ARCHIVOS.indexOf(p) < 0) throw new Error('Archivo no permitido: ' + p);
    var limpio = validar_(p, archivos[p].contenido);
    var texto = JSON.stringify(limpio, null, 2) + '\n';
    var actual = gh_('get', repo + '/contents/' + p + '?ref=main');
    var sha = actual.code === 200 ? actual.json.sha : null;
    if (archivos[p].sha && sha && archivos[p].sha !== sha) {
      throw new Error('Alguien guardó cambios en ' + p + ' mientras editabas. Recargá y volvé a aplicar tus cambios.');
    }
    var cuerpo = {
      message: 'Portal: ' + (resumen || 'cambios en ' + p) + ' (' + u.email + ')',
      content: Utilities.base64Encode(texto, Utilities.Charset.UTF_8),
      branch: 'main',
      committer: { name: 'Portal catálogos OPI', email: 'prato.mauricio@gmail.com' }
    };
    if (sha) cuerpo.sha = sha;
    var r = gh_('put', repo + '/contents/' + p, cuerpo);
    if (r.code !== 200 && r.code !== 201) throw new Error('GitHub respondió ' + r.code + ' al guardar ' + p + ': ' + (r.json.message || ''));
    hechos.push(p);
  });
  registrar_(u.email, catalogo + ': ' + (resumen || hechos.join(', ')));
  return { ok: true, guardados: hechos, archivos: leer_(catalogo).archivos };
}

/* ---------- historial ---------- */

function log_() { return JSON.parse(props_().getProperty('LOG') || '[]'); }
function registrar_(email, texto) {
  var l = log_();
  l.unshift({ f: new Date().toISOString(), u: email, t: String(texto).slice(0, 300) });
  l = l.slice(0, 120);
  // Cada propiedad del script admite ~9 KB: se recortan las entradas más viejas hasta que entre.
  while (l.length > 1 && JSON.stringify(l).length > 8500) l.pop();
  props_().setProperty('LOG', JSON.stringify(l));
}

/* ---------- archivos en GitHub (lectura y escritura genérica) ---------- */

function leerArchivo_(repo, path) {
  var r = gh_('get', repo + '/contents/' + path + '?ref=main');
  if (r.code === 404) return { sha: null, texto: null };
  if (r.code !== 200) throw new Error('GitHub respondió ' + r.code + ' al leer ' + path);
  return { sha: r.json.sha, texto: Utilities.newBlob(Utilities.base64Decode(r.json.content)).getDataAsString('UTF-8') };
}

function shaDe_(repo, path) {
  var r = gh_('get', repo + '/contents/' + path + '?ref=main');
  return r.code === 200 ? r.json.sha : null;
}

function escribir_(repo, path, b64, mensaje, sha, autor) {
  var cuerpo = { message: mensaje, content: b64, branch: 'main', committer: autor || { name: 'Portal catálogos OPI', email: 'prato.mauricio@gmail.com' } };
  if (sha) cuerpo.sha = sha;
  var r = gh_('put', repo + '/contents/' + path, cuerpo);
  if (r.code !== 200 && r.code !== 201) throw new Error('GitHub respondió ' + r.code + ' al guardar ' + path + ': ' + (r.json.message || ''));
  return r.json.content && r.json.content.sha;
}
function b64_(texto) { return Utilities.base64Encode(texto, Utilities.Charset.UTF_8); }

/* ---------- Power BI (modelo publicado, app de Azure) ---------- */

function pbiToken_() {
  var c = CacheService.getScriptCache(), t = c.get('PBI_TOKEN');
  if (t) return t;
  var p = props_(), ten = p.getProperty('PBI_TENANT_ID'), id = p.getProperty('PBI_CLIENT_ID'), sec = p.getProperty('PBI_CLIENT_SECRET');
  if (!ten || !id || !sec) throw new Error('Faltan PBI_TENANT_ID, PBI_CLIENT_ID o PBI_CLIENT_SECRET en las propiedades del script.');
  var r = UrlFetchApp.fetch('https://login.microsoftonline.com/' + ten + '/oauth2/v2.0/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'client_credentials', client_id: id, client_secret: sec, scope: 'https://analysis.windows.net/powerbi/api/.default' }
  });
  var j = JSON.parse(r.getContentText() || '{}');
  if (!j.access_token) throw new Error('Azure no dio el token de Power BI: ' + String(j.error_description || j.error || r.getResponseCode()).slice(0, 200));
  c.put('PBI_TOKEN', j.access_token, Math.max(60, Math.min(21600, (j.expires_in || 3600) - 300)));
  return j.access_token;
}

// Ejecuta DAX y devuelve filas con las claves sin el nombre de tabla: "PbiProductos[Producto#]" -> "Producto#".
function dax_(q) {
  var p = props_(), ds = p.getProperty('PBI_DATASET_ID'), ws = p.getProperty('PBI_WORKSPACE_ID');
  if (!ds) throw new Error('Falta PBI_DATASET_ID en las propiedades del script.');
  var url = 'https://api.powerbi.com/v1.0/myorg/' + (ws ? 'groups/' + ws + '/' : '') + 'datasets/' + ds + '/executeQueries';
  var r = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + pbiToken_() },
    payload: JSON.stringify({ queries: [{ query: q }], serializerSettings: { includeNulls: true } })
  });
  var j = JSON.parse(r.getContentText() || '{}');
  var res = j.results && j.results[0];
  if (r.getResponseCode() !== 200 || j.error || !res || res.error) {
    throw new Error('Power BI respondió ' + r.getResponseCode() + ': ' + JSON.stringify(j.error || (res && res.error) || j).slice(0, 300));
  }
  return (res.tables[0].rows || []).map(function (o) {
    var n = {};
    Object.keys(o).forEach(function (k) { n[k.replace(/^[^\[]*\[/, '').replace(/\]$/, '')] = o[k]; });
    return n;
  });
}

var Q_PRODUCTOS = [
  'EVALUATE',
  'VAR hoy = TODAY()',
  'VAR opi = FILTER(ALL(LPCCOND), LPCCOND[LpCCod] = "O.P.I." && LPCCOND[LpCFVigDes] <= hoy)',
  'RETURN FILTER(',
  '  ADDCOLUMNS(FILTER(PbiProductos, PbiProductos[Marca] = "OPI"),',
  '    "st", [StockActual],',
  '    "pg", [Precio Lista Producto],',
  '    "po", VAR c = PbiProductos[Producto#] VAR r = FILTER(opi, LPCCOND[LpCProCod] = c) VAR f = MAXX(r, LPCCOND[LpCFVigDes]) RETURN MAXX(FILTER(r, LPCCOND[LpCFVigDes] = f), LPCCOND[LpCPreList])),',
  '  [st] > 1)'
].join('\n');

// Outlet por lote: entran los lotes con stock hoy (depósito 1, STF) cuyo primer saldo es anterior a la fecha de corte.
// Trae el saldo mensual de cada lote desde el cierre anterior al corte y fifoOutlet_ calcula cuánto queda de lo
// viejo: cada baja de saldo consume primero lo viejo y las reposiciones al mismo lote cuentan como nuevas.
function qOutlet_(corte) {
  var p = corte.split('-');
  return [
    'EVALUATE',
    'VAR corte = DATE(' + (+p[0]) + ',' + (+p[1]) + ',' + (+p[2]) + ')',
    'VAR L = {"NAIL LACQUER","INFINITE SHINE","GEL COLOR","NATURE STRONG"}',
    'VAR base = FILTER(ADDCOLUMNS(SALPLU, "lin", RELATED(PbiProductos[Linea])), [lin] IN L)',
    'VAR fin = MAXX(base, SALPLU[EMP04.Empfecfinp])',
    'VAR ini = MAXX(FILTER(base, SALPLU[EMP04.Empfecfinp] < corte), SALPLU[EMP04.Empfecfinp])',
    'VAR cur = GROUPBY(FILTER(base, SALPLU[EMP04.Empfecfinp] = fin && SALPLU[DepoCod] = 1 && SALPLU[EstCod] = "STF" && SALPLU[SPLUSaldo] > 0), SALPLU[ProCod], SALPLU[LoteNro], "u", SUMX(CURRENTGROUP(), SALPLU[SPLUSaldo]))',
    'VAR h = SUMMARIZE(FILTER(base, SALPLU[SPLUSaldo] > 0), SALPLU[ProCod], SALPLU[LoteNro], "f1", MIN(SALPLU[EMP04.Empfecfinp]))',
    'VAR old = FILTER(NATURALINNERJOIN(cur, h), [f1] < corte)',
    'VAR per = GROUPBY(FILTER(base, SALPLU[EMP04.Empfecfinp] >= ini), SALPLU[ProCod], SALPLU[LoteNro], SALPLU[EMP04.Empfecfinp], "s", SUMX(CURRENTGROUP(), SALPLU[SPLUSaldo]))',
    'RETURN SELECTCOLUMNS(NATURALINNERJOIN(per, old), "sku", SALPLU[ProCod] & "", "lote", SALPLU[LoteNro] & "", "f", FORMAT(SALPLU[EMP04.Empfecfinp], "yyyy-MM-dd"), "s", [s], "u", [u])'
  ].join('\n');
}

// Filas mensuales por lote -> [{sku, lote, viejo}]. Un mes sin fila para el lote cuenta como saldo 0.
function fifoOutlet_(rows) {
  var meses = {}, lotes = {};
  rows.forEach(function (r) {
    meses[r.f] = 1;
    var k = String(r.sku).trim() + '|' + String(r.lote).trim();
    lotes[k] = lotes[k] || { u: +r.u || 0, s: {} };
    lotes[k].s[r.f] = (lotes[k].s[r.f] || 0) + (+r.s || 0);
  });
  var M = Object.keys(meses).sort();
  return Object.keys(lotes).map(function (k) {
    var x = lotes[k], old = x.s[M[0]] || 0, prev = old;
    for (var i = 1; i < M.length; i++) {
      var v = x.s[M[i]] || 0;
      if (v < prev) old = Math.max(0, old - (prev - v));
      prev = v;
    }
    var p = k.split('|');
    return { sku: p[0], lote: p[1], viejo: Math.min(old, x.u) };
  });
}

// Ranking de lo más vendido (unidades vendidas sin bonificadas, últimos 12 meses) para las filas comerciales.
var Q_TOP = 'EVALUATE FILTER(ADDCOLUMNS(SUMMARIZE(FILTER(PbiProductos, PbiProductos[Marca] = "OPI"), PbiProductos[Producto#]), "u", [UnidV 12M]), [u] > 0)';
function rankingPBI_() {
  return dax_(Q_TOP).map(function (r) { return { k: String(r['Producto#']).trim(), u: +r.u || 0 }; })
    .sort(function (a, b) { return b.u - a.u; }).map(function (x) { return x.k; });
}

var OUTLET_DEF = { corte: '2022-01-01', manual: [], excluidos: [] };
function outletCfg_() {
  var c = JSON.parse(props_().getProperty('OUTLET_CFG') || 'null') || {};
  return { corte: c.corte || OUTLET_DEF.corte, manual: c.manual || [], excluidos: c.excluidos || [] };
}

function productosPBI_() {
  var vistos = {}, out = [];
  dax_(Q_PRODUCTOS).forEach(function (r) {
    var k = String(r['Producto#'] == null ? '' : r['Producto#']).trim();
    if (!k || vistos[k]) return;
    vistos[k] = 1; r.sku = k; out.push(r);
  });
  return out;
}

/* ---------- actualización de disponibles, precios y Outlet ---------- */

var IMESI = 1.115, IVA = 1.22, LINEAS_ESMALTE = { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1 };
var HORAS_AUTO = [8, 12];
var AUTOR_AUTO = { name: 'Mauricio Prato', email: 'prato.mauricio@gmail.com' };

function r2_(x) { return Number((+x).toFixed(2)); }
function ahora_(fmt) { return Utilities.formatDate(new Date(), 'America/Montevideo', fmt); }

// Mismo formato que json.dump(indent=0, sort_keys=True) de Python, para que los diffs del tope sean limpios.
function jsonIndent0_(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  var ks = Object.keys(o).sort();
  if (!ks.length) return '{}';
  return '{\n' + ks.map(function (k) { return JSON.stringify(k) + ': ' + jsonIndent0_(o[k]); }).join(',\n') + '\n}';
}

// Calcula disponibles.json y el tope del Outlet. Puro (sin E/S) para poder probarlo aparte.
// tope: unidades viejas por SKU y lote de corridas anteriores con la MISMA fecha de corte (o null si cambió).
// cfgOut: { manual: [sku], excluidos: [sku] }.
function calcular_(tonos, previoDisp, tope, prods, outletRows, cfgOut, ranking) {
  cfgOut = cfgOut || { manual: [], excluidos: [] };
  var linea = {};
  tonos.t.forEach(function (t) { linea[t[0]] = t[3]; });
  var previo = (previoDisp && previoDisp.d) || {};
  var stock = {}, orden = [];
  prods.forEach(function (r) {
    var pg = r.pg == null || r.pg === '' ? null : r2_(r.pg), po = r.po == null || r.po === '' ? null : r2_(r.po);
    stock[r.sku] = [pg, po, String(r.IMESI || '').trim().toUpperCase().charAt(0) === 'A', +r.st || 0];
    orden.push(r.sku);
  });
  var netos = {};
  orden.forEach(function (k) {
    var p = stock[k][0];
    if (!(k in linea) || !p) return;
    var L = linea[k]; netos[L] = netos[L] || { n: {}, ord: [] };
    if (!(p in netos[L].n)) { netos[L].n[p] = 0; netos[L].ord.push(p); }
    netos[L].n[p]++;
  });
  function masComun(L) {
    var x = netos[L]; if (!x) return null;
    var best = null; x.ord.forEach(function (p) { if (best === null || x.n[p] > x.n[best]) best = p; });
    return best;
  }
  var d = {}, pp = {}, sinPrecio = [];
  orden.forEach(function (k) {
    if (!(k in linea)) return;
    var p = stock[k][0], po = stock[k][1], aplica = stock[k][2], L = linea[k];
    if (LINEAS_ESMALTE[L]) { aplica = true; if (!p) p = masComun(L); }
    if (!p) { sinPrecio.push(k); return; }
    var f = (aplica ? IMESI : 1) * IVA;
    d[k] = r2_(p * f);
    if (po) pp[k] = r2_(po * f);
  });
  var o = {}, topeNuevo = null;
  if (outletRows) {
    // Con la misma fecha de corte solo cuentan los lotes que ya estaban y nunca suben; si cambió la fecha, se rearma.
    topeNuevo = {};
    outletRows.forEach(function (r) {
      var s = String(r.sku).trim(), l = String(r.lote).trim(), v = Math.trunc(+r.viejo || 0);
      if (tope) { if (!(tope[s] && tope[s][l] != null)) return; v = Math.min(v, tope[s][l]); }
      if (v > 0) { topeNuevo[s] = topeNuevo[s] || {}; topeNuevo[s][l] = v; }
    });
    Object.keys(topeNuevo).forEach(function (s) {
      if ((s in d) && LINEAS_ESMALTE[linea[s]]) {
        o[s] = Object.keys(topeNuevo[s]).reduce(function (a, l) { return a + topeNuevo[s][l]; }, 0);
      }
    });
  } else {
    var po2 = (previoDisp && previoDisp.o) || {};
    Object.keys(po2).forEach(function (k) { if (k in d) o[k] = po2[k]; });
  }
  // Ajustes a mano desde el portal: tonos que entran sin importar la fecha (con todo su stock) y tonos que no van.
  (cfgOut.manual || []).forEach(function (k) {
    if ((k in d) && LINEAS_ESMALTE[linea[k]] && stock[k]) o[k] = Math.max(o[k] || 0, Math.trunc(stock[k][3]));
  });
  (cfgOut.excluidos || []).forEach(function (k) { delete o[k]; });
  var D = {}, PP = {}, O = {};
  tonos.t.forEach(function (t) { var k = t[0]; if (k in d) { D[k] = d[k]; if (k in pp) PP[k] = pp[k]; if (k in o) O[k] = o[k]; } });
  // Orden de lo más vendido entre lo publicado (solo el orden, sin cantidades). Si no vino, se conserva el anterior.
  var TOP = (ranking || (previoDisp && previoDisp.top) || []).filter(function (k) { return k in D; });
  var altas = Object.keys(D).filter(function (k) { return !(k in previo); });
  var bajas = Object.keys(previo).filter(function (k) { return !(k in D); });
  var cambios = Object.keys(D).filter(function (k) { return (k in previo) && Math.abs(D[k] - previo[k]) > 0.005; });
  var nOut = Object.keys(O).length;
  return {
    disp: { d: D, pp: PP, o: O, top: TOP }, tope: topeNuevo,
    freno: Object.keys(previo).length > 0 && Object.keys(D).length < 0.6 * Object.keys(previo).length,
    resumen: 'Disponibles ' + Object.keys(D).length + ' (antes ' + Object.keys(previo).length + '): altas ' + altas.length +
      ', bajas ' + bajas.length + ', cambios de precio ' + cambios.length + ', sin precio ' + sinPrecio.length +
      ', con precio público ' + Object.keys(PP).length + ', Outlet ' + nOut + ' tonos.',
    cifras: { disponibles: Object.keys(D).length, altas: altas.length, bajas: bajas.length, precios: cambios.length, outlet: nOut },
    detalle: { altas: altas, bajas: bajas, cambios: cambios.map(function (k) { return [k, previo[k], D[k]]; }), sinPrecio: sinPrecio }
  };
}

// opciones.reporte: manda el resumen por mail al administrador (corridas automáticas y "Actualizar ahora").
function actualizar_(origen, opciones) {
  opciones = opciones || {};
  var P = REPOS.profesionales, I = REPOS.interior;
  var prods = productosPBI_(), outletRows = null, avisoOutlet = '';
  var oc = outletCfg_(), pr = props_(), ranking = null;
  try { ranking = rankingPBI_(); } catch (e) { /* sin ranking: se conserva el anterior */ }
  try { outletRows = fifoOutlet_(dax_(qOutlet_(oc.corte))); } catch (e) { avisoOutlet = ' Outlet sin actualizar (' + String(e.message).slice(0, 120) + ').'; }
  var fT = leerArchivo_(P, 'data/tonos.json'), fD = leerArchivo_(P, 'data/disponibles.json'), fO = leerArchivo_(P, 'tools/outlet_tope.json');
  var tonos = JSON.parse(fT.texto), previo = fD.texto ? JSON.parse(fD.texto) : null, tope = fO.texto ? JSON.parse(fO.texto) : {};
  var mismaFecha = (pr.getProperty('TOPE_CORTE') || OUTLET_DEF.corte) === oc.corte;
  var c = calcular_(tonos, previo, mismaFecha ? tope : null, prods, outletRows, oc, ranking);
  var hoy = ahora_('yyyy-MM-dd'), cuando = ahora_('yyyy-MM-dd HH:mm');
  if (c.freno) {
    var msj = 'Freno: los disponibles caen más de 40 %. No se publicó nada. ' + c.resumen;
    estado_(origen, false, msj); avisar_('Catálogos OPI: la actualización frenó', msj);
    return { ok: false, mensaje: msj };
  }
  var nuevo = { fecha: hoy, d: c.disp.d, pp: c.disp.pp, o: c.disp.o, top: c.disp.top };
  var cambio = !previo || previo.fecha !== hoy ||
    JSON.stringify({ d: previo.d, pp: previo.pp || {}, o: previo.o || {}, top: previo.top || [] }) !== JSON.stringify(c.disp);
  var msg = 'Actualización de disponibles y precios ' + cuando, publicados = [];
  if (cambio) {
    var texto = JSON.stringify(nuevo);
    escribir_(P, 'data/disponibles.json', b64_(texto), msg, fD.sha, AUTOR_AUTO);
    publicados.push('profesionales');
    if (c.tope && jsonIndent0_(c.tope) !== jsonIndent0_(tope)) escribir_(P, 'tools/outlet_tope.json', b64_(jsonIndent0_(c.tope)), msg, fO.sha, AUTOR_AUTO);
  }
  if (c.tope) pr.setProperty('TOPE_CORTE', oc.corte);
  // Interior: mismos disponibles y la misma lista de productos.
  var iD = leerArchivo_(I, 'data/disponibles.json'), iT = leerArchivo_(I, 'data/tonos.json'), txt = JSON.stringify(nuevo);
  if (iT.texto !== fT.texto) escribir_(I, 'data/tonos.json', b64_(fT.texto), msg, iT.sha, AUTOR_AUTO);
  if (iD.texto !== txt && (cambio || !iD.texto || JSON.parse(iD.texto).fecha !== hoy)) {
    escribir_(I, 'data/disponibles.json', b64_(txt), msg, iD.sha, AUTOR_AUTO);
    publicados.push('interior');
  }
  var res = c.resumen + avisoOutlet + (publicados.length ? ' Publicado en ' + publicados.join(' e ') + '.' : ' Sin cambios para publicar.');
  estado_(origen, true, res, c.cifras);
  if (opciones.reporte) reporte_(origen, c, tonos, publicados, avisoOutlet);
  if (avisoOutlet) avisar_('Catálogos OPI: Outlet sin actualizar', res);
  return { ok: true, mensaje: res, cifras: c.cifras, outlet: Object.keys(c.disp.o) };
}

function estado_(origen, ok, texto, cifras) {
  props_().setProperty('ULTIMA_ACT', JSON.stringify({ f: new Date().toISOString(), origen: origen, ok: ok, t: texto, c: cifras || null }));
  registrar_(origen === 'automática' ? 'sistema' : origen, (ok ? 'Actualización: ' : 'Actualización con problema: ') + texto);
}

function reporte_(origen, c, tonos, publicados, avisoOutlet) {
  try {
    var to = props_().getProperty('ADMIN_EMAIL');
    if (!to) return;
    var nom = {}; tonos.t.forEach(function (t) { nom[t[0]] = (t[1] ? t[1] + ' · ' : '') + t[2]; });
    var $ = function (v) { return '$ ' + Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'); };
    var esc = function (x) { return String(x).replace(/[&<>]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]; }); };
    var d = c.detalle, cf = c.cifras;
    function lista(titulo, items, fmt) {
      if (!items.length) return '';
      var max = 40, h = '<h3 style="font-size:14px;margin:18px 0 6px">' + titulo + ' (' + items.length + ')</h3><ul style="margin:0;padding-left:18px">';
      items.slice(0, max).forEach(function (x) { h += '<li>' + fmt(x) + '</li>'; });
      if (items.length > max) h += '<li>… y ' + (items.length - max) + ' más</li>';
      return h + '</ul>';
    }
    var cuando = ahora_('dd/MM HH:mm');
    var html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1d1522">' +
      '<p style="margin:0 0 10px"><b>Actualización ' + (origen === 'automática' ? 'automática' : 'manual (' + esc(origen) + ')') + ' · ' + cuando + '</b></p>' +
      '<p style="margin:0">Disponibles: <b>' + cf.disponibles + '</b> · Altas: ' + cf.altas + ' · Bajas: ' + cf.bajas +
      ' · Cambios de precio: ' + cf.precios + ' · Outlet: ' + cf.outlet + ' tonos</p>' +
      '<p style="margin:6px 0 0;color:#6f6475">' + (publicados.length ? 'Publicado en ' + publicados.join(' e ') + '.' : 'Sin cambios para publicar.') + esc(avisoOutlet) + '</p>' +
      lista('Altas', d.altas, function (k) { return esc(nom[k] || k) + ' <span style="color:#6f6475">(' + k + ')</span>'; }) +
      lista('Bajas', d.bajas, function (k) { return esc(nom[k] || k) + ' <span style="color:#6f6475">(' + k + ')</span>'; }) +
      lista('Cambios de precio profesional', d.cambios, function (x) { return esc(nom[x[0]] || x[0]) + ': ' + $(x[1]) + ' → <b>' + $(x[2]) + '</b>'; }) +
      lista('Con stock pero sin precio (no se muestran)', d.sinPrecio, function (k) { return esc(nom[k] || k) + ' <span style="color:#6f6475">(' + k + ')</span>'; }) +
      '<p style="margin:20px 0 0;font-size:13px"><a href="https://maup8.github.io/catalogo-opi/">Catálogo profesionales</a> · ' +
      '<a href="https://maup8.github.io/catalogo-opi-interior/">Catálogo interior</a> · <a href="https://maup8.github.io/catalogo-opi-admin/">Portal</a></p></div>';
    var asunto = 'Catálogos OPI · ' + cuando + ' · ' + cf.disponibles + ' disponibles' +
      (cf.altas || cf.bajas || cf.precios ? ' (' + [cf.altas ? '+' + cf.altas : '', cf.bajas ? '-' + cf.bajas : '', cf.precios ? cf.precios + ' precios' : ''].filter(String).join(', ') + ')' : ', sin cambios');
    MailApp.sendEmail({ to: to, subject: asunto, htmlBody: html, body: c.resumen, name: 'Catálogos OPI' });
  } catch (e) { /* el reporte es secundario */ }
}

function avisar_(asunto, texto) {
  try {
    var to = props_().getProperty('ADMIN_EMAIL');
    if (to) MailApp.sendEmail(to, asunto, texto + '\n\nPortal: https://maup8.github.io/catalogo-opi-admin/');
  } catch (e) { /* el aviso es secundario */ }
}

function actualizarDesdePortal_(u) {
  try { return actualizar_(u.email, { reporte: true }); }
  catch (e) { estado_(u.email, false, String(e.message)); return { ok: false, mensaje: String(e.message) }; }
}

// Disparador horario: solo actúa de lunes a viernes en HORAS_AUTO (Montevideo), una vez por franja.
function actualizacionProgramada() {
  var dia = +ahora_('u'), hora = +ahora_('H'), franja = ahora_('yyyy-MM-dd') + ' ' + hora;
  if (dia > 5 || HORAS_AUTO.indexOf(hora) < 0) return;
  var p = props_();
  if (p.getProperty('ULTIMA_FRANJA') === franja) return;
  var lock = LockService.getScriptLock();
  lock.waitLock(120000);
  try {
    p.setProperty('ULTIMA_FRANJA', franja);
    actualizar_('automática', { reporte: true });
  } catch (e) {
    estado_('automática', false, String(e.message));
    avisar_('Catálogos OPI: la actualización automática falló', String(e.message));
  } finally { lock.releaseLock(); }
}

function instalarActualizacion() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'actualizacionProgramada') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('actualizacionProgramada').timeBased().everyHours(1).create();
  Logger.log('Disparador instalado: lunes a viernes, franjas de las ' + HORAS_AUTO.join(' y ') + ' h (Montevideo).');
}

// Para correr desde el editor: calcula todo como la actualización real pero no publica nada.
function pruebaActualizacion() {
  var P = REPOS.profesionales, prods = productosPBI_(), oc = outletCfg_(), out = fifoOutlet_(dax_(qOutlet_(oc.corte)));
  var tonos = JSON.parse(leerArchivo_(P, 'data/tonos.json').texto), previo = JSON.parse(leerArchivo_(P, 'data/disponibles.json').texto);
  var tope = JSON.parse(leerArchivo_(P, 'tools/outlet_tope.json').texto || '{}');
  var misma = (props_().getProperty('TOPE_CORTE') || OUTLET_DEF.corte) === oc.corte;
  var c = calcular_(tonos, previo, misma ? tope : null, prods, out, oc);
  var sin = calcular_(tonos, previo, null, prods, out, oc), po = previo.o || {}, so = sin.disp.o;
  var u = function (o) { return Object.keys(o).reduce(function (a, k) { return a + o[k]; }, 0); };
  Logger.log('Outlet publicado: ' + Object.keys(po).length + ' tonos / ' + u(po) + ' u. Con el tope guardado: ' + Object.keys(c.disp.o).length + ' / ' + u(c.disp.o) +
    '. Recalculado desde cero (corte ' + oc.corte + '): ' + Object.keys(so).length + ' / ' + u(so));
  Logger.log('Solo en el recalculado: ' + Object.keys(so).filter(function (k) { return !(k in po); }).map(function (k) { return k + ':' + so[k]; }).join(' '));
  Logger.log('Solo en el publicado: ' + Object.keys(po).filter(function (k) { return !(k in so); }).map(function (k) { return k + ':' + po[k]; }).join(' '));
  Logger.log('Distinta cantidad: ' + Object.keys(so).filter(function (k) { return (k in po) && po[k] !== so[k]; }).map(function (k) { return k + ':' + po[k] + '→' + so[k]; }).join(' '));
  Logger.log(c.resumen + (c.freno ? ' FRENO' : ''));
  var im = {}; prods.forEach(function (r) { im[String(r.IMESI)] = (im[String(r.IMESI)] || 0) + 1; });
  Logger.log('Valores de IMESI: ' + JSON.stringify(im));
  var dif = Object.keys(c.disp.d).filter(function (k) { return previo.d[k] !== undefined && Math.abs(previo.d[k] - c.disp.d[k]) > 0.005; });
  Logger.log('Precios distintos a los publicados: ' + dif.slice(0, 15).map(function (k) { return k + ' ' + previo.d[k] + '→' + c.disp.d[k]; }).join(', '));
}

// Para correr desde el editor: muestra las columnas de PbiProductos y cuál se usa como nombre.
function diagnosticoPBI() {
  var prods = productosPBI_();
  Logger.log('Productos OPI con stock: ' + prods.length);
  if (prods[0]) {
    Logger.log('Columnas: ' + Object.keys(prods[0]).join(' | '));
    Logger.log('Columna de nombre: ' + colNombre_(prods[0]) + ' -> ' + prods[0][colNombre_(prods[0])]);
  }
  Logger.log('Outlet: ' + fifoOutlet_(dax_(qOutlet_(outletCfg_().corte))).length + ' lotes');
}

/* ---------- productos sin publicar y publicación ---------- */

var NO_NOMBRE = { 'Producto#': 1, sku: 1, st: 1, pg: 1, po: 1, IMESI: 1, Marca: 1, Linea: 1 };
function colNombre_(r) {
  var fija = props_().getProperty('PBI_COL_NOMBRE');
  if (fija && fija in r) return fija;
  var ks = Object.keys(r).filter(function (k) { return !NO_NOMBRE[k] && typeof r[k] === 'string'; });
  var pats = [/^descrip/i, /^nombre/i, /^producto$/i, /desc/i, /nom/i, /art/i];
  for (var i = 0; i < pats.length; i++) {
    for (var j = 0; j < ks.length; j++) if (pats[i].test(ks[j])) return ks[j];
  }
  return ks[0] || null;
}

// Mapa de la línea del sistema a la del catálogo (índices de tonos.json "lines").
function lineaSugerida_(lin, nombre) {
  var s = (String(lin || '') + ' ' + String(nombre || '')).toUpperCase();
  if (/DISPLAY|EXHIBIDOR/.test(s)) return 9;
  if (/GELEVATE/.test(s)) return 8;
  if (/NAIL LACQUER/.test(s)) return 0;
  if (/INFINITE/.test(s)) return 1;
  if (/GEL ?COLOR/.test(s)) return 2;
  if (/NATURE/.test(s)) return 3;
  if (/RAPIDRY|RAPI DRY/.test(s)) return 4;
  if (/BASE|TOP|ENVY|TRAT/.test(s)) return 5;
  if (/CUID|OIL|ACEITE|CREMA|LOCI|AVOJUICE|PRO SPA/.test(s)) return 6;
  if (/KIT|SET|TRIO|PACK|MINI/.test(s)) return 7;
  return 10;
}

// Precios finales (con IMESI si aplica, los tonos siempre, e IVA) y stock vendible desde el sistema.
// Las cantidades de stock solo van a administradores.
var LINEAS_PBI_ESMALTE = { 'NAIL LACQUER': 1, 'INFINITE SHINE': 1, 'GEL COLOR': 1, 'NATURE STRONG': 1, 'RAPIDRY': 1, 'RAPI DRY': 1 };
function preciosFinales_(r) {
  var aplica = String(r.IMESI || '').trim().toUpperCase().charAt(0) === 'A' || !!LINEAS_PBI_ESMALTE[String(r.Linea || '').toUpperCase()];
  var f = (aplica ? IMESI : 1) * IVA;
  return { prof: r.pg ? r2_(r2_(r.pg) * f) : null, pub: r.po ? r2_(r2_(r.po) * f) : null };
}
function sistema_(u) {
  var c = CacheService.getScriptCache(), raw = c.get('SISTEMA'), datos;
  if (raw) datos = JSON.parse(raw);
  else {
    datos = { f: new Date().toISOString(), p: {} };
    productosPBI_().forEach(function (r) { var x = preciosFinales_(r); datos.p[r.sku] = [x.prof, x.pub, Math.round(+r.st || 0)]; });
    try { c.put('SISTEMA', JSON.stringify(datos), 600); } catch (e) { /* muy grande para la caché: se recalcula */ }
  }
  var adm = u.rol === 'admin', out = {};
  Object.keys(datos.p).forEach(function (k) { var x = datos.p[k]; out[k] = adm ? x : [x[0], x[1]]; });
  return { ok: true, f: datos.f, stock: adm, p: out };
}

function sinPublicar_(u) {
  var prods = productosPBI_();
  var tonos = JSON.parse(leerArchivo_(REPOS.profesionales, 'data/tonos.json').texto), ya = {};
  tonos.t.forEach(function (t) { ya[t[0]] = 1; });
  var cn = prods[0] ? colNombre_(prods[0]) : null, desc = descartados_();
  var lista = prods.filter(function (r) { return !ya[r.sku]; }).map(function (r) {
    var nom = cn ? String(r[cn] || '').trim() : '', cod = '';
    // En el sistema el nombre viene como "FI641 - OPI FLEX ...": se separa el código corto.
    var m = /^([A-Z0-9]{2,12})\s+-\s+(.+)$/.exec(nom);
    if (m) { cod = m[1]; nom = m[2]; }
    var pf = preciosFinales_(r), o = { sku: r.sku, nombre: nom, codigo: cod, linea: String(r.Linea || ''), precio: !!r.pg, prof: pf.prof, pub: pf.pub, sugerida: lineaSugerida_(r.Linea, nom), desc: !!desc[r.sku] };
    if (u && u.rol === 'admin') o.st = Math.round(+r.st || 0);
    return o;
  });
  lista.sort(function (a, b) { return (a.linea + a.nombre).localeCompare(b.linea + b.nombre); });
  return { ok: true, productos: lista, lines: tonos.lines, fams: tonos.fams, cols: tonos.cols };
}

// Productos que se decidió no publicar (por ejemplo, colecciones que no van): no molestan en la lista.
function descartados_() { return JSON.parse(props_().getProperty('DESCARTADOS') || '{}'); }
function descartar_(u, sku, valor) {
  sku = String(sku || '').trim();
  if (!/^[0-9A-Za-z.\-]+$/.test(sku)) return { ok: false, mensaje: 'Código inválido.' };
  var d = descartados_();
  if (valor) d[sku] = 1; else delete d[sku];
  props_().setProperty('DESCARTADOS', JSON.stringify(d));
  registrar_(u.email, (valor ? 'Descartó ' : 'Volvió a la lista de sin publicar: ') + sku);
  return { ok: true };
}

function publicar_(u, x) {
  x = x || {};
  var sku = String(x.sku || '').trim();
  if (!/^[0-9A-Za-z.\-]+$/.test(sku)) return { ok: false, mensaje: 'Código de producto inválido.' };
  var nombre = String(x.nombre || '').trim().slice(0, 80), codigo = String(x.codigo || '').trim().slice(0, 20);
  if (!nombre) return { ok: false, mensaje: 'Falta el nombre.' };
  var foto = String(x.foto || '').replace(/^data:image\/jpeg;base64,/, '');
  if (foto.indexOf('/9j/') !== 0 || foto.length > 700000) return { ok: false, mensaje: 'La foto tiene que ser JPG de hasta 500 KB.' };
  var P = REPOS.profesionales, fT = leerArchivo_(P, 'data/tonos.json'), tonos = JSON.parse(fT.texto);
  var L = Math.round(+x.linea), fam = Math.round(+x.fam), col = Math.round(+x.col);
  if (!(L >= 0 && L < tonos.lines.length)) return { ok: false, mensaje: 'Línea inválida.' };
  if (!(fam >= -1 && fam < tonos.fams.length)) fam = -1;
  if (LINEAS_ESMALTE[L] && fam < 0) return { ok: false, mensaje: 'Para un tono hay que elegir la familia de color.' };
  if (!LINEAS_ESMALTE[L]) fam = -1;
  if (!(col >= -1 && col < tonos.cols.length)) col = -1;
  var hex = /^[0-9a-f]{6}$/i.test(String(x.hex || '')) ? String(x.hex).toLowerCase() : '';
  if (tonos.t.some(function (t) { return t[0] === sku; })) return { ok: false, mensaje: 'Ese producto ya está en el catálogo.' };
  var fila = [sku, codigo, nombre, L, fam, hex, col], pos = -1;
  tonos.t.forEach(function (t, i) { if (t[3] === L) pos = i; });
  if (pos < 0) tonos.t.push(fila); else tonos.t.splice(pos + 1, 0, fila);
  var msg = 'Portal: publica ' + nombre + ' (' + sku + ') (' + u.email + ')';
  escribir_(P, 'img/p/' + sku + '.jpg', foto, msg, shaDe_(P, 'img/p/' + sku + '.jpg'));
  escribir_(REPOS.interior, 'img/p/' + sku + '.jpg', foto, msg, shaDe_(REPOS.interior, 'img/p/' + sku + '.jpg'));
  escribir_(P, 'data/tonos.json', b64_(JSON.stringify(tonos, null, 0)), msg, fT.sha);
  registrar_(u.email, 'Publicó ' + nombre + ' (' + sku + ') en ' + tonos.lines[L]);
  var a;
  try { a = actualizar_(u.email); } catch (e) { a = { ok: false, mensaje: String(e.message) }; }
  return { ok: true, mensaje: 'Publicado. ' + (a.ok ? a.mensaje : 'La actualización de precios falló: ' + a.mensaje + ' Se verá en la próxima corrida automática.') };
}

/* ---------- configuración del Outlet y fotos ---------- */

function outletGuardar_(u, x) {
  x = x || {};
  var corte = String(x.corte || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(corte) || corte < '2015-01-01' || corte > ahora_('yyyy-MM-dd')) return { ok: false, mensaje: 'Fecha de corte inválida.' };
  var tonos = JSON.parse(leerArchivo_(REPOS.profesionales, 'data/tonos.json').texto), esTono = {};
  tonos.t.forEach(function (t) { if (LINEAS_ESMALTE[t[3]]) esTono[t[0]] = 1; });
  var limpiar = function (a) { var v = {}; return (a || []).map(String).filter(function (k) { if (!esTono[k] || v[k]) return false; v[k] = 1; return true; }); };
  var antes = outletCfg_(), cfg = { corte: corte, manual: limpiar(x.manual), excluidos: limpiar(x.excluidos) };
  cfg.excluidos = cfg.excluidos.filter(function (k) { return cfg.manual.indexOf(k) < 0; });
  props_().setProperty('OUTLET_CFG', JSON.stringify(cfg));
  var cam = [];
  if (antes.corte !== cfg.corte) cam.push('corte ' + antes.corte + ' → ' + cfg.corte);
  var dif = function (a, b) { return a.filter(function (k) { return b.indexOf(k) < 0; }).length; };
  if (dif(cfg.manual, antes.manual) || dif(antes.manual, cfg.manual)) cam.push(cfg.manual.length + ' tonos agregados a mano');
  if (dif(cfg.excluidos, antes.excluidos) || dif(antes.excluidos, cfg.excluidos)) cam.push(cfg.excluidos.length + ' tonos sacados');
  registrar_(u.email, 'Outlet: ' + (cam.join(', ') || 'sin cambios'));
  var a;
  try { a = actualizar_(u.email); } catch (e) { a = { ok: false, mensaje: String(e.message) }; }
  return { ok: true, outlet: cfg, enOutlet: a.ok ? a.outlet : null, mensaje: a.ok ? a.mensaje : 'Se guardó, pero la actualización falló: ' + a.mensaje };
}

function cambiarFoto_(u, sku, foto) {
  sku = String(sku || '').trim();
  foto = String(foto || '').replace(/^data:image\/jpeg;base64,/, '');
  if (foto.indexOf('/9j/') !== 0 || foto.length > 700000) return { ok: false, mensaje: 'La foto tiene que ser JPG de hasta 500 KB.' };
  var tonos = JSON.parse(leerArchivo_(REPOS.profesionales, 'data/tonos.json').texto), t = null;
  tonos.t.forEach(function (x) { if (x[0] === sku) t = x; });
  if (!t) return { ok: false, mensaje: 'Ese producto no está en el catálogo.' };
  var msg = 'Portal: nueva foto de ' + t[2] + ' (' + sku + ') (' + u.email + ')', path = 'img/p/' + sku + '.jpg';
  escribir_(REPOS.profesionales, path, foto, msg, shaDe_(REPOS.profesionales, path));
  escribir_(REPOS.interior, path, foto, msg, shaDe_(REPOS.interior, path));
  registrar_(u.email, 'Cambió la foto de ' + t[2] + ' (' + sku + ')');
  return { ok: true };
}

// Para correr desde el editor: lista medidas del modelo relacionadas con ventas (para "los más pedidos").
function explorarMedidas() {
  try {
    var r = dax_('EVALUATE SELECTCOLUMNS(FILTER(INFO.MEASURES(), SEARCH("vent", [Name], 1, 0) > 0 || SEARCH("unid", [Name], 1, 0) > 0 || SEARCH("cant", [Name], 1, 0) > 0 || SEARCH("factur", [Name], 1, 0) > 0), "n", [Name], "e", LEFT([Expression], 160))');
    r.forEach(function (x) { Logger.log(x.n + '  =  ' + String(x.e).replace(/\s+/g, ' ')); });
  } catch (e) { Logger.log('INFO.MEASURES no disponible: ' + e.message); }
  try {
    var t = dax_('EVALUATE SELECTCOLUMNS(INFO.TABLES(), "t", [Name])');
    Logger.log('Tablas: ' + t.map(function (x) { return x.t; }).join(' | '));
  } catch (e) { Logger.log('INFO.TABLES no disponible: ' + e.message); }
}
