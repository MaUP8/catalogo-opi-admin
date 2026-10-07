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
    case 'sinPublicar': return sinPublicar_();
    case 'publicar': return publicar_(u, q.producto);
    case 'descartar': return descartar_(u, q.sku, q.valor);
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

var Q_OUTLET = [
  'EVALUATE',
  'VAR L = {"NAIL LACQUER","INFINITE SHINE","GEL COLOR","NATURE STRONG"}',
  'VAR base = FILTER(ADDCOLUMNS(SALPLU, "lin", RELATED(PbiProductos[Linea])), [lin] IN L)',
  'VAR fin = MAXX(base, SALPLU[EMP04.Empfecfinp])',
  'VAR cur = GROUPBY(FILTER(base, SALPLU[EMP04.Empfecfinp] = fin && SALPLU[DepoCod] = 1 && SALPLU[EstCod] = "STF" && SALPLU[SPLUSaldo] > 0), SALPLU[ProCod], SALPLU[LoteNro], "u", SUMX(CURRENTGROUP(), SALPLU[SPLUSaldo]))',
  'VAR h = SUMMARIZE(FILTER(base, SALPLU[SPLUSaldo] > 0), SALPLU[ProCod], SALPLU[LoteNro], "f1", MIN(SALPLU[EMP04.Empfecfinp]))',
  'VAR old = SELECTCOLUMNS(FILTER(NATURALINNERJOIN(cur, h), [f1] < DATE(2022,1,1)), "p", SALPLU[ProCod], "lu", SALPLU[LoteNro] & ":" & [u])',
  'RETURN ADDCOLUMNS(DISTINCT(SELECTCOLUMNS(old, "sku", [p])), "lotes", VAR s = [sku] RETURN CONCATENATEX(FILTER(old, [p] = s), [lu], ";"))'
].join('\n');

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
function calcular_(tonos, previoDisp, tope, prods, outletRows) {
  var linea = {};
  tonos.t.forEach(function (t) { linea[t[0]] = t[3]; });
  var previo = (previoDisp && previoDisp.d) || {};
  var stock = {}, orden = [];
  prods.forEach(function (r) {
    var pg = r.pg == null || r.pg === '' ? null : r2_(r.pg), po = r.po == null || r.po === '' ? null : r2_(r.po);
    stock[r.sku] = [pg, po, String(r.IMESI || '').trim().toUpperCase().charAt(0) === 'A'];
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
    var hoy = {};
    outletRows.forEach(function (r) {
      var s = String(r.sku).trim(); hoy[s] = {};
      String(r.lotes || '').split(';').forEach(function (l) {
        var i = l.lastIndexOf(':'); if (i < 0) return;
        hoy[s][l.slice(0, i)] = parseFloat(l.slice(i + 1));
      });
    });
    topeNuevo = {};
    Object.keys(tope).forEach(function (s) {
      Object.keys(tope[s]).forEach(function (l) {
        var t = Math.min(tope[s][l], (hoy[s] && hoy[s][l]) || 0);
        if (t > 0) { topeNuevo[s] = topeNuevo[s] || {}; topeNuevo[s][l] = Math.trunc(t); }
      });
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
  var D = {}, PP = {}, O = {};
  tonos.t.forEach(function (t) { var k = t[0]; if (k in d) { D[k] = d[k]; if (k in pp) PP[k] = pp[k]; if (k in o) O[k] = o[k]; } });
  var altas = Object.keys(D).filter(function (k) { return !(k in previo); });
  var bajas = Object.keys(previo).filter(function (k) { return !(k in D); });
  var cambios = Object.keys(D).filter(function (k) { return (k in previo) && Math.abs(D[k] - previo[k]) > 0.005; });
  var nOut = Object.keys(O).length, uOut = Object.keys(O).reduce(function (a, k) { return a + O[k]; }, 0);
  return {
    disp: { d: D, pp: PP, o: O }, tope: topeNuevo,
    freno: Object.keys(previo).length > 0 && Object.keys(D).length < 0.6 * Object.keys(previo).length,
    resumen: 'Disponibles ' + Object.keys(D).length + ' (antes ' + Object.keys(previo).length + '): altas ' + altas.length +
      ', bajas ' + bajas.length + ', cambios de precio ' + cambios.length + ', sin precio ' + sinPrecio.length +
      ', con precio público ' + Object.keys(PP).length + ', Outlet ' + nOut + ' tonos.',
    cifras: { disponibles: Object.keys(D).length, altas: altas.length, bajas: bajas.length, precios: cambios.length, outlet: nOut, outletUnid: uOut }
  };
}

function actualizar_(origen) {
  var P = REPOS.profesionales, I = REPOS.interior;
  var prods = productosPBI_(), outletRows = null, avisoOutlet = '';
  try { outletRows = dax_(Q_OUTLET); } catch (e) { avisoOutlet = ' Outlet sin actualizar (' + String(e.message).slice(0, 120) + ').'; }
  var fT = leerArchivo_(P, 'data/tonos.json'), fD = leerArchivo_(P, 'data/disponibles.json'), fO = leerArchivo_(P, 'tools/outlet_tope.json');
  var tonos = JSON.parse(fT.texto), previo = fD.texto ? JSON.parse(fD.texto) : null, tope = fO.texto ? JSON.parse(fO.texto) : {};
  var c = calcular_(tonos, previo, tope, prods, outletRows);
  var hoy = ahora_('yyyy-MM-dd'), cuando = ahora_('yyyy-MM-dd HH:mm');
  if (c.freno) {
    var msj = 'Freno: los disponibles caen más de 40 %. No se publicó nada. ' + c.resumen;
    estado_(origen, false, msj); avisar_('Catálogos OPI: la actualización frenó', msj);
    return { ok: false, mensaje: msj };
  }
  var nuevo = { fecha: hoy, d: c.disp.d, pp: c.disp.pp, o: c.disp.o };
  var cambio = !previo || previo.fecha !== hoy ||
    JSON.stringify({ d: previo.d, pp: previo.pp || {}, o: previo.o || {} }) !== JSON.stringify(c.disp);
  var msg = 'Actualización de disponibles y precios ' + cuando, publicados = [];
  if (cambio) {
    var texto = JSON.stringify(nuevo);
    escribir_(P, 'data/disponibles.json', b64_(texto), msg, fD.sha, AUTOR_AUTO);
    publicados.push('profesionales');
    if (c.tope && jsonIndent0_(c.tope) !== jsonIndent0_(tope)) escribir_(P, 'tools/outlet_tope.json', b64_(jsonIndent0_(c.tope)), msg, fO.sha, AUTOR_AUTO);
  }
  // Interior: mismos disponibles y la misma lista de productos.
  var iD = leerArchivo_(I, 'data/disponibles.json'), iT = leerArchivo_(I, 'data/tonos.json'), txt = JSON.stringify(nuevo);
  if (iT.texto !== fT.texto) escribir_(I, 'data/tonos.json', b64_(fT.texto), msg, iT.sha, AUTOR_AUTO);
  if (iD.texto !== txt && (cambio || !iD.texto || JSON.parse(iD.texto).fecha !== hoy)) {
    escribir_(I, 'data/disponibles.json', b64_(txt), msg, iD.sha, AUTOR_AUTO);
    publicados.push('interior');
  }
  var res = c.resumen + avisoOutlet + (publicados.length ? ' Publicado en ' + publicados.join(' e ') + '.' : ' Sin cambios para publicar.');
  estado_(origen, true, res, c.cifras);
  if (avisoOutlet) avisar_('Catálogos OPI: Outlet sin actualizar', res);
  return { ok: true, mensaje: res, cifras: c.cifras };
}

function estado_(origen, ok, texto, cifras) {
  props_().setProperty('ULTIMA_ACT', JSON.stringify({ f: new Date().toISOString(), origen: origen, ok: ok, t: texto, c: cifras || null }));
  registrar_(origen === 'automática' ? 'sistema' : origen, (ok ? 'Actualización: ' : 'Actualización con problema: ') + texto);
}

function avisar_(asunto, texto) {
  try {
    var to = props_().getProperty('ADMIN_EMAIL');
    if (to) MailApp.sendEmail(to, asunto, texto + '\n\nPortal: https://maup8.github.io/catalogo-opi-admin/');
  } catch (e) { /* el aviso es secundario */ }
}

function actualizarDesdePortal_(u) {
  try { return actualizar_(u.email); }
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
    actualizar_('automática');
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

// Para correr desde el editor: muestra las columnas de PbiProductos y cuál se usa como nombre.
function diagnosticoPBI() {
  var prods = productosPBI_();
  Logger.log('Productos OPI con stock: ' + prods.length);
  if (prods[0]) {
    Logger.log('Columnas: ' + Object.keys(prods[0]).join(' | '));
    Logger.log('Columna de nombre: ' + colNombre_(prods[0]) + ' -> ' + prods[0][colNombre_(prods[0])]);
  }
  Logger.log('Outlet: ' + dax_(Q_OUTLET).length + ' tonos');
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

function sinPublicar_() {
  var prods = productosPBI_();
  var tonos = JSON.parse(leerArchivo_(REPOS.profesionales, 'data/tonos.json').texto), ya = {};
  tonos.t.forEach(function (t) { ya[t[0]] = 1; });
  var cn = prods[0] ? colNombre_(prods[0]) : null, desc = descartados_();
  var lista = prods.filter(function (r) { return !ya[r.sku]; }).map(function (r) {
    var nom = cn ? String(r[cn] || '').trim() : '';
    return { sku: r.sku, nombre: nom, linea: String(r.Linea || ''), precio: !!r.pg, sugerida: lineaSugerida_(r.Linea, nom), desc: !!desc[r.sku] };
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
