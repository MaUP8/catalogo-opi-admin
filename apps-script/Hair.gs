/**
 * Catálogo Hair (Wella Professionals, Nioxin y Sebastian Professional) — backend del portal.
 * Va como segundo archivo del mismo proyecto de Apps Script que Code.gs y usa sus funciones
 * (sesiones, GitHub, Power BI, historial). Repo: MaUP8/catalogo-hair, servido en hair.catalogospbg.com.
 *
 * El token GITHUB_TOKEN tiene que incluir también el repo catalogo-hair (Contents: Read and write).
 *
 * Archivos del repo que toca:
 *   data/config.json      vendedores (link ?v=), pedido mínimo y Outlet  ← lo edita el portal
 *   data/ajustes.json     productos ocultos                             ← lo edita el portal
 *   data/disponibles.json precios, Outlet por vencimiento y ranking     ← lo recalcula actualizarHair_
 *   data/productos.json   estructura del catálogo                       ← publicarHair_ agrega productos
 *   img/p/<sku>.jpg       fotos 600×600 con fondo blanco
 */

var HAIR_REPO = 'MaUP8/catalogo-hair';
var HAIR_SITIO = 'https://hair.catalogospbg.com/';
var HAIR_MARCAS_PBI = '{"WELLA PROFESSIONALS","NIOXIN","NIOXIN RESTAGE","SEBASTIAN"}';
var HAIR_TIPO_ACCESORIO = 9;

/* ---------- validación de lo que guarda el portal ---------- */

function validarHair_(path, c) {
  if (path === 'data/config.json') {
    c = c || {};
    var vistos = {};
    var vend = (c.vendedores || []).map(function (v) {
      var id = String(v.id || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      if (!/^[a-z0-9-]{2,24}$/.test(id)) throw new Error('Código de link inválido: "' + v.id + '" (letras, números y guiones).');
      if (vistos[id]) throw new Error('El código de link "' + id + '" está repetido.');
      vistos[id] = 1;
      var tel = String(v.tel || '').replace(/[^0-9]/g, '');
      if (!/^598\d{8}$/.test(tel)) throw new Error('Celular inválido para ' + (v.nombre || id) + ' (formato 09X XXX XXX).');
      return { id: id, nombre: String(v.nombre || '').trim().slice(0, 40), tel: tel };
    });
    if (!vend.length) throw new Error('Tiene que haber al menos un vendedor con celular.');
    var min = Math.round(+c.minimo || 0);
    if (!(min >= 0 && min <= 1000000)) throw new Error('Mínimo inválido.');
    var o = c.outlet || {};
    var mec = o.mecanica === '1+1' ? '1+1' : 'descuento';
    var tramos = (o.tramos || []).map(function (t) { return { meses: Math.round(+t.meses), pct: Math.round(+t.pct) }; })
      .filter(function (t) { return t.meses >= 1 && t.meses <= 24 && t.pct >= 1 && t.pct <= 90; })
      .sort(function (a, b) { return a.meses - b.meses; }).slice(0, 4);
    if (mec === 'descuento' && !tramos.length) throw new Error('El Outlet con descuento necesita al menos un tramo (meses y %).');
    var meses = Math.round(+o.meses || 6);
    if (!(meses >= 1 && meses <= 24)) throw new Error('Plazo del Outlet 1+1 inválido (1 a 24 meses).');
    return { vendedores: vend, minimo: min, outlet: { activo: !!o.activo, mecanica: mec, tramos: tramos, meses: meses } };
  }
  if (path === 'data/ajustes.json') {
    return { ocultos: (c && c.ocultos || []).map(String).filter(function (k) { return /^[0-9A-Za-z.\-]+$/.test(k); }) };
  }
  throw new Error('Archivo no permitido.');
}

// Plazo del Outlet según la mecánica: el tramo más largo (descuento) o los meses del 1+1.
function horizonteHair_(cfg) {
  var o = (cfg && cfg.outlet) || {};
  if (o.mecanica === '1+1') return Math.max(1, +o.meses || 6);
  return Math.max.apply(null, [1].concat((o.tramos || []).map(function (t) { return +t.meses || 0; })));
}

/* ---------- Power BI ---------- */

var Q_HAIR = [
  'EVALUATE',
  'FILTER(',
  '  ADDCOLUMNS(FILTER(PbiProductos, PbiProductos[Marca] IN ' + HAIR_MARCAS_PBI + '),',
  '    "st", [StockActual], "pg", [Precio Lista Producto], "u12", [UnidV 12M]),',
  '  [st] > 1)'
].join('\n');

// Lotes vendibles (depósito 1, STF, último cierre) con su vencimiento.
var Q_HAIR_LOTES = [
  'EVALUATE',
  'VAR base = FILTER(ADDCOLUMNS(SALPLU, "m", RELATED(PbiProductos[Marca])), [m] IN ' + HAIR_MARCAS_PBI + ')',
  'VAR fin = MAXX(base, SALPLU[EMP04.Empfecfinp])',
  'RETURN SELECTCOLUMNS(',
  '  GROUPBY(FILTER(base, SALPLU[EMP04.Empfecfinp] = fin && SALPLU[DepoCod] = 1 && SALPLU[EstCod] = "STF" && SALPLU[SPLUSaldo] > 0),',
  '    SALPLU[ProCod], SALPLU[LoteNro], SALPLU[SPLULotVto], "u", SUMX(CURRENTGROUP(), SALPLU[SPLUSaldo])),',
  '  "sku", SALPLU[ProCod] & "", "vto", FORMAT(SALPLU[SPLULotVto], "yyyy-MM-dd"), "u", [u])'
].join('\n');

function hairPBI_() {
  var vistos = {}, out = [];
  dax_(Q_HAIR).forEach(function (r) {
    var k = String(r['Producto#'] == null ? '' : r['Producto#']).trim();
    if (!k || vistos[k]) return;
    vistos[k] = 1; r.sku = k; out.push(r);
  });
  return out;
}

function precioHair_(r) {
  var aplica = String(r.IMESI || '').trim().toUpperCase().charAt(0) === 'A';
  return r.pg ? r2_(r2_(r.pg) * (aplica ? IMESI : 1) * IVA) : null;
}

function mesesHasta_(vto, hoy) {
  return (+vto.slice(0, 4) - hoy.getFullYear()) * 12 + (+vto.slice(5, 7) - (hoy.getMonth() + 1));
}

/* ---------- cálculo de disponibles (puro, para poder probarlo) ---------- */

// prods: filas de Q_HAIR; lotes: filas de Q_HAIR_LOTES; estructura: data/productos.json; previo: disponibles anterior.
function calcularHair_(estructura, previo, prods, lotes, cfg, hoy) {
  var enCat = {}, acc = {};
  estructura.p.forEach(function (p) { enCat[p[0]] = 1; if (p[5] === HAIR_TIPO_ACCESORIO) acc[p[0]] = 1; });
  var d = {}, sinPrecio = [], top = [];
  prods.forEach(function (r) {
    if (!enCat[r.sku]) return;
    var p = precioHair_(r);
    if (!p) { sinPrecio.push(r.sku); return; }
    d[r.sku] = p;
    if (+r.u12 > 0) top.push([r.sku, +r.u12]);
  });
  top = top.sort(function (a, b) { return b[1] - a[1]; }).map(function (x) { return x[0]; });
  // Outlet: lotes que vencen dentro del plazo, sin los vencidos ni los del mes en curso; accesorios no entran.
  var H = horizonteHair_(cfg), o = {};
  (lotes || []).forEach(function (r) {
    var s = String(r.sku).trim(), v = String(r.vto || ''), u = Math.round(+r.u || 0);
    if (!(s in d) || acc[s] || !/^\d{4}-\d{2}/.test(v) || u <= 0) return;
    var m = mesesHasta_(v, hoy);
    if (m < 1 || m > H) return;
    var x = o[s] || (o[s] = [0, v.slice(0, 7)]);
    x[0] += u; if (v.slice(0, 7) < x[1]) x[1] = v.slice(0, 7);
  });
  var prev = (previo && previo.d) || {};
  var altas = Object.keys(d).filter(function (k) { return !(k in prev); });
  var bajas = Object.keys(prev).filter(function (k) { return !(k in d); });
  var cambios = Object.keys(d).filter(function (k) { return (k in prev) && Math.abs(d[k] - prev[k]) > 0.005; });
  var D = {}, O = {};
  Object.keys(d).sort().forEach(function (k) { D[k] = d[k]; });
  Object.keys(o).sort().forEach(function (k) { O[k] = o[k]; });
  return {
    disp: { d: D, o: O, top: top },
    freno: Object.keys(prev).length > 0 && Object.keys(D).length < 0.6 * Object.keys(prev).length,
    resumen: 'Hair: disponibles ' + Object.keys(D).length + ' (antes ' + Object.keys(prev).length + '), altas ' + altas.length +
      ', bajas ' + bajas.length + ', cambios de precio ' + cambios.length + ', sin precio ' + sinPrecio.length +
      ', por vencer en ' + H + ' meses ' + Object.keys(O).length + '.',
    cifras: { disponibles: Object.keys(D).length, altas: altas.length, bajas: bajas.length, precios: cambios.length, outlet: Object.keys(O).length }
  };
}

function actualizarHair_(origen) {
  var fE = leerArchivo_(HAIR_REPO, 'data/productos.json'), fD = leerArchivo_(HAIR_REPO, 'data/disponibles.json'), fC = leerArchivo_(HAIR_REPO, 'data/config.json');
  if (!fE.texto) throw new Error('El repo del catálogo Hair no tiene data/productos.json.');
  var est = JSON.parse(fE.texto), previo = fD.texto ? JSON.parse(fD.texto) : null, cfg = fC.texto ? JSON.parse(fC.texto) : {};
  var lotes = null, aviso = '';
  try { lotes = dax_(Q_HAIR_LOTES); } catch (e) { aviso = ' Outlet sin recalcular (' + String(e.message).slice(0, 120) + ').'; }
  var c = calcularHair_(est, previo, hairPBI_(), lotes, cfg, new Date());
  if (!lotes && previo) c.disp.o = previo.o || {};
  if (c.freno) {
    var msj = 'Hair: los disponibles caen más de 40 %. No se publicó nada. ' + c.resumen;
    avisar_('Catálogo Hair: la actualización frenó', msj);
    registrar_(origen, msj);
    return { ok: false, mensaje: msj };
  }
  var hoy = ahora_('yyyy-MM-dd'), nuevo = { fecha: hoy, d: c.disp.d, o: c.disp.o, top: c.disp.top };
  var cambio = !previo || previo.fecha !== hoy || JSON.stringify({ d: previo.d, o: previo.o || {}, top: previo.top || [] }) !== JSON.stringify(c.disp);
  if (cambio) escribir_(HAIR_REPO, 'data/disponibles.json', b64_(JSON.stringify(nuevo)), 'Actualización de disponibles y precios ' + ahora_('yyyy-MM-dd HH:mm'), fD.sha, AUTOR_AUTO);
  var res = c.resumen + aviso + (cambio ? ' Publicado.' : ' Sin cambios para publicar.');
  props_().setProperty('ULTIMA_ACT_HAIR', JSON.stringify({ f: new Date().toISOString(), origen: origen, ok: true, t: res, c: c.cifras }));
  registrar_(origen === 'automática' ? 'sistema' : origen, res);
  return { ok: true, mensaje: res, cifras: c.cifras };
}

/* ---------- datos para el portal ---------- */

function sistemaHair_(u) {
  var c = CacheService.getScriptCache(), raw = c.get('SISTEMA_HAIR'), datos;
  if (raw) datos = JSON.parse(raw);
  else {
    datos = { f: new Date().toISOString(), p: {} };
    hairPBI_().forEach(function (r) { datos.p[r.sku] = [precioHair_(r), null, Math.round(+r.st || 0)]; });
    try { c.put('SISTEMA_HAIR', JSON.stringify(datos), 600); } catch (e) { /* muy grande para la caché */ }
  }
  var adm = u.rol === 'admin', out = {};
  Object.keys(datos.p).forEach(function (k) { var x = datos.p[k]; out[k] = adm ? x : [x[0], x[1]]; });
  return { ok: true, f: datos.f, stock: adm, p: out };
}

// Lo que vence: por SKU, unidades y meses al primer vencimiento, para que el portal muestre quién entraría al Outlet.
function vencimientosHair_(u) {
  var hoy = new Date(), o = {};
  dax_(Q_HAIR_LOTES).forEach(function (r) {
    var s = String(r.sku).trim(), v = String(r.vto || '');
    if (!/^\d{4}-\d{2}/.test(v)) return;
    var m = mesesHasta_(v, hoy);
    if (m < 1 || m > 24) return;
    (o[s] = o[s] || []).push([v.slice(0, 7), u.rol === 'admin' ? Math.round(+r.u || 0) : null]);
  });
  return { ok: true, lotes: o };
}

function sinPublicarHair_(u) {
  var est = JSON.parse(leerArchivo_(HAIR_REPO, 'data/productos.json').texto), ya = {}, desc = descartados_();
  est.p.forEach(function (p) { ya[p[0]] = 1; });
  var prods = hairPBI_(), cn = prods[0] ? colNombre_(prods[0]) : null;
  var lista = prods.filter(function (r) { return !ya[r.sku]; }).map(function (r) {
    var nom = String(cn ? r[cn] : '').trim().replace(/^[*\s]+/, '');
    var o = { sku: r.sku, nombre: nom, marca: String(r.Marca || ''), linea: String(r.Linea || ''), precio: !!r.pg, prof: precioHair_(r), desc: !!desc['h:' + r.sku] };
    var t = /(\d{1,2})\s*\/\s*(\d{1,2})\b/.exec(nom);
    if (t) o.tono = t[1] + '/' + t[2];
    if (u && u.rol === 'admin') o.st = Math.round(+r.st || 0);
    return o;
  });
  lista.sort(function (a, b) { return (a.marca + a.linea + a.nombre).localeCompare(b.marca + b.linea + b.nombre); });
  return { ok: true, productos: lista, marcas: est.marcas, cats: est.cats, lines: est.lines, fams: est.fams, tipos: est.tipos };
}

function descartarHair_(u, sku, valor) {
  sku = String(sku || '').trim();
  if (!/^[0-9A-Za-z.\-]+$/.test(sku)) return { ok: false, mensaje: 'Código inválido.' };
  var d = descartados_();
  if (valor) d['h:' + sku] = 1; else delete d['h:' + sku];
  props_().setProperty('DESCARTADOS', JSON.stringify(d));
  registrar_(u.email, 'Hair: ' + (valor ? 'descartó ' : 'volvió a la lista de sin publicar: ') + sku);
  return { ok: true };
}

function fotoValida_(foto) {
  foto = String(foto || '').replace(/^data:image\/jpeg;base64,/, '');
  if (foto.indexOf('/9j/') !== 0 || foto.length > 700000) throw new Error('La foto tiene que ser JPG de hasta 500 KB.');
  return foto;
}

function publicarHair_(u, x) {
  x = x || {};
  var sku = String(x.sku || '').trim();
  if (!/^[0-9A-Za-z.\-]+$/.test(sku)) return { ok: false, mensaje: 'Código de producto inválido.' };
  var nombre = String(x.nombre || '').trim().slice(0, 80);
  if (!nombre) return { ok: false, mensaje: 'Falta el nombre.' };
  var foto = fotoValida_(x.foto);
  var fE = leerArchivo_(HAIR_REPO, 'data/productos.json'), est = JSON.parse(fE.texto);
  var L = Math.round(+x.linea);
  if (!(L >= 0 && L < est.lines.length)) return { ok: false, mensaje: 'Línea inválida.' };
  var esTono = !!est.lines[L][2], tono = '', fam = -1, tipo = -1;
  if (esTono) {
    tono = String(x.tono || '').replace(/\s+/g, '');
    if (!/^\d{1,2}\/\d{0,2}$/.test(tono)) return { ok: false, mensaje: 'Para la carta de tonos hay que poner el tono, por ejemplo 7/1.' };
    fam = Math.round(+x.fam); if (!(fam >= -1 && fam < est.fams.length)) fam = -1;
  } else {
    tipo = Math.round(+x.tipo); if (!(tipo >= 0 && tipo < est.tipos.length)) return { ok: false, mensaje: 'Elegí el tipo de producto.' };
  }
  if (est.p.some(function (p) { return p[0] === sku; })) return { ok: false, mensaje: 'Ese producto ya está en el catálogo.' };
  var fila = [sku, nombre, L, tono, fam, tipo, String(x.pres || '').trim().slice(0, 30)], pos = -1;
  est.p.forEach(function (p, i) { if (p[2] === L) pos = i; });
  if (pos < 0) est.p.push(fila); else est.p.splice(pos + 1, 0, fila);
  var msg = 'Portal: publica ' + nombre + ' (' + sku + ') (' + u.email + ')';
  escribir_(HAIR_REPO, 'img/p/' + sku + '.jpg', foto, msg, shaDe_(HAIR_REPO, 'img/p/' + sku + '.jpg'));
  escribir_(HAIR_REPO, 'data/productos.json', b64_(JSON.stringify(est)), msg, fE.sha);
  registrar_(u.email, 'Hair: publicó ' + nombre + ' (' + sku + ') en ' + est.lines[L][1]);
  var a;
  try { a = actualizarHair_(u.email); } catch (e) { a = { ok: false, mensaje: String(e.message) }; }
  return { ok: true, mensaje: 'Publicado. ' + (a.ok ? a.mensaje : 'La actualización de precios falló: ' + a.mensaje + ' Se verá en la próxima corrida automática.') };
}

function cambiarFotoHair_(u, sku, foto) {
  sku = String(sku || '').trim();
  foto = fotoValida_(foto);
  var est = JSON.parse(leerArchivo_(HAIR_REPO, 'data/productos.json').texto), p = null;
  est.p.forEach(function (x) { if (x[0] === sku) p = x; });
  if (!p) return { ok: false, mensaje: 'Ese producto no está en el catálogo.' };
  var path = 'img/p/' + sku + '.jpg';
  escribir_(HAIR_REPO, path, foto, 'Portal: nueva foto de ' + p[1] + ' (' + sku + ') (' + u.email + ')', shaDe_(HAIR_REPO, path));
  registrar_(u.email, 'Hair: cambió la foto de ' + (p[3] ? p[3] + ' ' : '') + p[1] + ' (' + sku + ')');
  return { ok: true };
}

/* ---------- para correr desde el editor ---------- */

// Calcula todo como la actualización real, sin publicar.
function pruebaHair() {
  var est = JSON.parse(leerArchivo_(HAIR_REPO, 'data/productos.json').texto);
  var fD = leerArchivo_(HAIR_REPO, 'data/disponibles.json'), fC = leerArchivo_(HAIR_REPO, 'data/config.json');
  var c = calcularHair_(est, fD.texto ? JSON.parse(fD.texto) : null, hairPBI_(), dax_(Q_HAIR_LOTES), fC.texto ? JSON.parse(fC.texto) : {}, new Date());
  Logger.log(c.resumen + (c.freno ? ' FRENO' : ''));
  Logger.log('Outlet: ' + JSON.stringify(c.disp.o));
}
