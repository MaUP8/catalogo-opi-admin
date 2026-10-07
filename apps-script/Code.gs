/**
 * Backend del portal de administración de los catálogos OPI.
 * Corre como Web App de Google Apps Script en la cuenta de Mauri.
 *
 * Propiedades del script (Configuración del proyecto → Propiedades del script):
 *   GITHUB_TOKEN  token "fine-grained" de GitHub con permiso Contents: Read and write
 *                 SOLO sobre MaUP8/catalogo-opi y MaUP8/catalogo-opi-interior.
 *   ADMIN_EMAIL   mail del administrador (Mauri).
 *   ADMIN_PIN     PIN inicial del administrador. Se guarda cifrado en el primer uso y se borra.
 * El script genera solo SECRET (firma de sesiones), USERS (usuarios con PIN cifrado) y LOG.
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
    lock.waitLock(20000);
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
    case 'historial': return { ok: true, log: log_() };
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
