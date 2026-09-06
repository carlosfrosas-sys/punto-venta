require("dotenv").config();
const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");
const { MongoClient } = require("mongodb");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

// El menú se sirve con los precios editados ya aplicados, así las pantallas
// no tienen que pedirlos aparte. Va antes de express.static para ganarle
// al archivo tal cual está en disco.
app.get("/menu.js", (req, res) => {
  let base;
  try {
    base = fs.readFileSync(path.join(__dirname, "public", "menu.js"), "utf8");
  } catch (e) {
    return res.status(500).type("application/javascript").send("// menu.js no disponible");
  }
  const inyeccion = "\n// Precios editados desde la página de ventas\n" +
    "if (window.MENU && window.MENU.usarPrecios) window.MENU.usarPrecios(" +
    JSON.stringify(menuPrecios) + ");\n";
  res.set("Cache-Control", "no-store");
  res.type("application/javascript").send(base + inyeccion);
});

app.use(express.static(__dirname + "/public"));

// Mercado Pago - Online (cliente.html checkout)
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN_ONLINE || process.env.MERCADOPAGO_ACCESS_TOKEN || "" });
const MP_PUBLIC_KEY = process.env.MERCADOPAGO_PUBLIC_KEY_ONLINE || process.env.MERCADOPAGO_PUBLIC_KEY || "";
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
// Mercado Pago - Presencial (terminal Point Smart)
const MP_TOKEN_PRESENCIAL = process.env.MERCADOPAGO_ACCESS_TOKEN_PRESENCIAL || process.env.MERCADOPAGO_ACCESS_TOKEN || "";

// Cupones de descuento
const CUPONES = { "TESTCABA100": 100, "CABANA10": 10 };

// Cupones de un solo uso (10% descuento)
const CUPONES_1USO = {
  "CABANA-R7K2": 10,
  "CABANA-M4P8": 10,
  "CABANA-X9L3": 10,
  "CABANA-J6W1": 10,
  "CABANA-T2N5": 10,
  "CABANA-H8Q4": 10,
  "CABANA-F3V7": 10,
  "CABANA-D5B9": 10,
  "CABANA-Y1C6": 10,
  "CABANA-G7S2": 10
};
const cuponesUsados = new Set();
async function marcarCuponUsado(codigo) {
  cuponesUsados.add(codigo);
  if (db) {
    try { await db.collection("cupones_usados").insertOne({ codigo, fecha: new Date() }); } catch(e) {}
  }
}

// Código corto que el cliente muestra al recoger su pedido.
// Sin letras ni números que se confundan (0/O, 1/I) para dictarlo sin errores.
function generarCodigoPedido() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let codigo;
  do {
    codigo = "";
    for (let i = 0; i < 5; i++) codigo += chars[Math.floor(Math.random() * chars.length)];
  } while (pedidos.some(p => p.codigo === codigo));
  return codigo;
}

// Generar código de referido único
function generarCodigoReferido() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let codigo = "";
  for (let i = 0; i < 6; i++) codigo += chars[Math.floor(Math.random() * chars.length)];
  return codigo;
}

// Revisa si un teléfono puede usar un cupón de referido. La usan el aviso
// de la página del cliente (en cuanto escribe su número) y el cobro, así
// las dos dicen lo mismo y no hay sorpresas al pagar.
// Sin teléfono solo puede decir si el link sirve.
async function revisarReferido(codigo, telefono) {
  if (!db) return { existe: false };

  const ref = await db.collection("referidos").findOne({ codigo: String(codigo || "").toUpperCase() });
  if (!ref) return { existe: false };
  if (ref.usado) return { existe: true, ok: false, error: "Este link de referido ya fue usado" };

  const enviado = ref.enviado === true;
  if (!telefono) return { existe: true, ok: true, enviado };

  // creadoPor es el teléfono de quien lo generó; en los cupones viejos
  // ese dato vive en origen
  if ((ref.creadoPor || ref.origen) === telefono) {
    return { existe: true, ok: false, enviado, error: "Este cupón es para que lo compartas, no para usarlo tú" };
  }

  if (!enviado) {
    const yaUso = await db.collection("referidos_usados").findOne({ telefono });
    if (yaUso) {
      return { existe: true, ok: false, enviado, error: "Ya usaste un cupón de referido anteriormente" };
    }
  }

  return { existe: true, ok: true, enviado };
}

// Marca el cupón de referido como usado y devuelve el nuevo que el cliente
// podrá compartir. Queda a nombre de su teléfono para que no se lo aplique
// a sí mismo en el siguiente pedido.
async function canjearReferido(cuponUpper, telefono, enviadoPorNegocio) {
  if (!db) return null;
  try {
    await db.collection("referidos").updateOne(
      { codigo: cuponUpper.replace("REF-", "") },
      { $set: { usado: true, usadoPor: telefono, fechaUso: new Date() } }
    );

    // Solo los cupones que se pasan entre clientes gastan el turno del
    // teléfono; los que manda el negocio se pueden repetir cuando quiera
    if (!enviadoPorNegocio) {
      await db.collection("referidos_usados").insertOne({ telefono, fecha: new Date() });
    }

    let nuevo = generarCodigoReferido();
    while (await db.collection("referidos").findOne({ codigo: nuevo })) {
      nuevo = generarCodigoReferido();
    }
    await db.collection("referidos").insertOne({
      codigo: nuevo,
      origen: telefono,
      creadoPor: telefono,
      usado: false,
      fecha: new Date()
    });
    return nuevo;
  } catch (e) {
    console.error("Error canjeando referido:", e.message);
    return null;
  }
}

// MongoDB
let db;
let pedidos = [];
let idCounter = 1;
let pedidosEliminados = [];
let gastos = [];
let gastoIdCounter = 1;
let fondosCaja = [];
let retiros = [];
let retiroIdCounter = 1;
let ventasTarjeta = [];
let ventaTarjetaIdCounter = 1;
let agotados = [];

// Respaldo automático
const BACKUP_DIR = path.join(__dirname, "backups");
const BACKUP_PATH = path.join(BACKUP_DIR, "pedidos-backup.json");
const BACKUP_GASTOS_PATH = path.join(BACKUP_DIR, "gastos-backup.json");
const BACKUP_AGOTADOS_PATH = path.join(BACKUP_DIR, "agotados-backup.json");

function respaldarDatos() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
    fs.writeFileSync(BACKUP_PATH, JSON.stringify(pedidos, null, 2));
    fs.writeFileSync(BACKUP_GASTOS_PATH, JSON.stringify(gastos, null, 2));
  } catch(e) { console.error("Error respaldo:", e.message); }
}
setInterval(respaldarDatos, 5 * 60 * 1000);

// Pedidos pendientes (en memoria + MongoDB)
const pedidosPendientes = new Map();

let mongoClient;
async function conectarDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.log("MONGODB_URI no configurada, los pedidos no se guardarán permanentemente");
    return;
  }
  try {
    mongoClient = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await mongoClient.connect();
    db = mongoClient.db("pdv");
    console.log("Conectado a MongoDB");

    mongoClient.on("close", () => {
      console.log("MongoDB desconectado, reintentando...");
      db = null;
      setTimeout(conectarDB, 5000);
    });
  } catch (e) {
    console.error("Error conectando a MongoDB:", e.message);
    db = null;
    setTimeout(conectarDB, 5000);
  }
}

async function cargarPedidos() {
  if (db) {
    try {
      pedidos = await db.collection("pedidos").find().toArray();
      pedidos.forEach(p => delete p._id);
      idCounter = pedidos.length > 0 ? Math.max(...pedidos.map(p => p.id)) + 1 : 1;
      console.log("Pedidos cargados desde MongoDB:", pedidos.length);
    } catch (e) {
      console.error("Error cargando pedidos:", e.message);
    }
    try {
      pedidosEliminados = await db.collection("pedidos_eliminados").find().toArray();
      pedidosEliminados.forEach(p => delete p._id);
    } catch(e) {}
    try {
      gastos = await db.collection("gastos").find().toArray();
      gastos.forEach(g => delete g._id);
      gastoIdCounter = gastos.length > 0 ? Math.max(...gastos.map(g => g.id)) + 1 : 1;
    } catch(e) {}
    try {
      fondosCaja = await db.collection("fondos_caja").find().toArray();
      fondosCaja.forEach(f => delete f._id);
    } catch(e) {}
    try {
      retiros = await db.collection("retiros").find().toArray();
      retiros.forEach(r => delete r._id);
      retiroIdCounter = retiros.length > 0 ? Math.max(...retiros.map(r => r.id)) + 1 : 1;
    } catch(e) {}
    try {
      ventasTarjeta = await db.collection("ventas_tarjeta").find().toArray();
      ventasTarjeta.forEach(v => delete v._id);
      ventaTarjetaIdCounter = ventasTarjeta.length > 0 ? Math.max(...ventasTarjeta.map(v => v.id)) + 1 : 1;
    } catch(e) {}
    try {
      const usados = await db.collection("cupones_usados").find().toArray();
      usados.forEach(c => cuponesUsados.add(c.codigo));
      console.log("Cupones usados cargados:", cuponesUsados.size);
    } catch(e) {}
    for (const tipo of ["trabajadores", "deudores"]) {
      try {
        const fichas = await db.collection(tipo).find().toArray();
        fichas.forEach(f => { delete f._id; if (!Array.isArray(f.movimientos)) f.movimientos = []; });
        if (fichas.length > 0) {
          cuentas[tipo] = fichas;
          contadorCuenta[tipo] = Math.max(...fichas.map(f => f.id)) + 1;
        }
      } catch(e) {}
    }
    try {
      const dias = await db.collection("escaneos_qr").find().toArray();
      dias.forEach(d => { delete d._id; escaneos[d.fecha] = d; });
      console.log("Días con escaneos cargados:", dias.length);
    } catch(e) {}
    try {
      const doc = await db.collection("menu_precios").findOne({ _id: "precios" });
      if (doc && doc.valores) {
        menuPrecios = doc.valores;
        console.log("Precios editados cargados:", Object.keys(menuPrecios).length);
      }
    } catch(e) {}
    if (pedidos.length > 0) return;
  }
  // Fallback: cargar de backup
  try {
    if (fs.existsSync(BACKUP_PATH)) {
      pedidos = JSON.parse(fs.readFileSync(BACKUP_PATH, "utf8"));
      idCounter = pedidos.length > 0 ? Math.max(...pedidos.map(p => p.id)) + 1 : 1;
      console.log("Pedidos cargados desde backup:", pedidos.length);
    }
  } catch(e) { console.error("Error cargando backup:", e.message); }
  try {
    if (fs.existsSync(BACKUP_GASTOS_PATH)) {
      gastos = JSON.parse(fs.readFileSync(BACKUP_GASTOS_PATH, "utf8"));
      gastoIdCounter = gastos.length > 0 ? Math.max(...gastos.map(g => g.id)) + 1 : 1;
    }
  } catch(e) {}
  try {
    if (fs.existsSync(BACKUP_AGOTADOS_PATH)) {
      agotados = JSON.parse(fs.readFileSync(BACKUP_AGOTADOS_PATH, "utf8"));
    }
  } catch(e) {}
  try {
    if (Object.keys(escaneos).length === 0 && fs.existsSync(BACKUP_ESCANEOS_PATH)) {
      escaneos = JSON.parse(fs.readFileSync(BACKUP_ESCANEOS_PATH, "utf8"));
    }
  } catch(e) {}
  for (const tipo of ["trabajadores", "deudores"]) {
    try {
      const ruta = rutaBackupCuenta(tipo);
      if (cuentas[tipo].length === 0 && fs.existsSync(ruta)) {
        cuentas[tipo] = JSON.parse(fs.readFileSync(ruta, "utf8"));
        cuentas[tipo].forEach(f => { if (!Array.isArray(f.movimientos)) f.movimientos = []; });
        if (cuentas[tipo].length > 0) {
          contadorCuenta[tipo] = Math.max(...cuentas[tipo].map(f => f.id)) + 1;
        }
      }
    } catch(e) { console.error("Error cargando " + tipo + ":", e.message); }
  }
  cargarPreciosBackup();
}

function guardarAgotados() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
    fs.writeFileSync(BACKUP_AGOTADOS_PATH, JSON.stringify(agotados, null, 2));
  } catch(e) { console.error("Error guardando agotados:", e.message); }
}

// ---- Precios editados desde la página de ventas ----
// Solo se guardan los precios que se cambiaron; la estructura del menú
// sigue viviendo en public/menu.js
const BACKUP_PRECIOS_PATH = path.join(BACKUP_DIR, "precios-backup.json");
let menuPrecios = {};

function cargarPreciosBackup() {
  try {
    if (fs.existsSync(BACKUP_PRECIOS_PATH)) {
      menuPrecios = JSON.parse(fs.readFileSync(BACKUP_PRECIOS_PATH, "utf8"));
    }
  } catch(e) { console.error("Error cargando precios:", e.message); }
}

async function guardarPrecios() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
    fs.writeFileSync(BACKUP_PRECIOS_PATH, JSON.stringify(menuPrecios, null, 2));
  } catch(e) { console.error("Error guardando precios en disco:", e.message); }

  if (db) {
    try {
      await db.collection("menu_precios").updateOne(
        { _id: "precios" },
        { $set: { valores: menuPrecios, actualizado: new Date() } },
        { upsert: true }
      );
    } catch (e) { console.error("Error guardando precios en MongoDB:", e.message); }
  }
}

async function guardarPedido(pedido) {
  if (db) {
    try {
      // replaceOne y no $set: si un pedido regresa a pendiente y se le quita
      // la hora de entrega, con $set el campo viejo seguiría en la base
      await db.collection("pedidos").replaceOne(
        { id: pedido.id },
        pedido,
        { upsert: true }
      );
    } catch (e) {
      console.error("Error guardando pedido:", e.message);
    }
  }
}

async function guardarPedidoPendiente(ref, datos) {
  pedidosPendientes.set(ref, datos);
  if (db) {
    try {
      await db.collection("pedidos_pendientes").updateOne(
        { ref },
        { $set: { ref, ...datos } },
        { upsert: true }
      );
    } catch (e) {
      console.error("Error guardando pedido pendiente:", e.message);
    }
  }
}

async function obtenerPedidoPendiente(ref) {
  let datos = pedidosPendientes.get(ref);
  if (!datos && db) {
    try {
      const doc = await db.collection("pedidos_pendientes").findOne({ ref });
      if (doc) {
        delete doc._id;
        delete doc.ref;
        datos = doc;
        pedidosPendientes.set(ref, datos);
      }
    } catch (e) {
      console.error("Error obteniendo pedido pendiente:", e.message);
    }
  }
  return datos;
}

async function eliminarPedidoPendiente(ref) {
  pedidosPendientes.delete(ref);
  if (db) {
    try {
      await db.collection("pedidos_pendientes").deleteOne({ ref });
    } catch (e) {
      console.error("Error eliminando pedido pendiente:", e.message);
    }
  }
}

// ---- Escaneos del QR ----
// Se guarda un resumen por día (no visitas sueltas): cuántas veces se abrió
// el menú y desde cuántos celulares distintos, más el desglose por hora.
let escaneos = {};
const BACKUP_ESCANEOS_PATH = path.join(BACKUP_DIR, "escaneos-backup.json");

// El archivo se escribe de forma síncrona, así que se agrupa: con varios
// escaneos seguidos no se bloquea el servidor una vez por cada uno
let guardadoEscaneosPendiente = null;

function guardarEscaneos(fecha) {
  if (!guardadoEscaneosPendiente) {
    guardadoEscaneosPendiente = setTimeout(() => {
      guardadoEscaneosPendiente = null;
      try {
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
        fs.writeFileSync(BACKUP_ESCANEOS_PATH, JSON.stringify(escaneos, null, 2));
      } catch (e) { console.error("Error guardando escaneos:", e.message); }
    }, 5000);
    guardadoEscaneosPendiente.unref && guardadoEscaneosPendiente.unref();
  }

  if (db && escaneos[fecha]) {
    db.collection("escaneos_qr")
      .updateOne({ fecha }, { $set: escaneos[fecha] }, { upsert: true })
      .catch(e => console.error("Error guardando escaneos en MongoDB:", e.message));
  }
}

function registrarEscaneo(req, res) {
  const fecha = fechaHoy();
  const ahora = fechaMXAhora();
  const hora = String(ahora.getHours()).padStart(2, "0");

  if (!escaneos[fecha]) escaneos[fecha] = { fecha, total: 0, unicos: 0, desdeQR: 0, porHora: {} };
  const dia = escaneos[fecha];

  dia.total++;
  dia.porHora[hora] = (dia.porHora[hora] || 0) + 1;
  if (req.query.via === "qr") dia.desdeQR++;

  // La cookie trae la fecha: un celular que ya abrió el menú hoy suma visita
  // pero no cuenta como persona nueva, y mañana vuelve a contar
  const marca = fecha.replace(/\//g, "-");
  const yaVinoHoy = (req.headers.cookie || "")
    .split(";")
    .some(c => c.trim() === "qr_visita=" + marca);

  if (!yaVinoHoy) {
    dia.unicos++;
    res.cookie("qr_visita", marca, { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, sameSite: "lax" });
  }

  guardarEscaneos(fecha);
}

// Rutas de páginas
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});
app.get("/caja", (req, res) => {
  res.sendFile(__dirname + "/public/caja.html");
});

app.get("/cocina", (req, res) => {
  res.sendFile(__dirname + "/public/cocina.html");
});

app.get("/barra", (req, res) => {
  res.sendFile(__dirname + "/public/barra.html");
});

app.get("/entrega", (req, res) => {
  res.sendFile(__dirname + "/public/entrega.html");
});

app.get("/ventas", (req, res) => {
  res.sendFile(__dirname + "/public/ventas.html");
});

// El QR lleva a esta página, así que cada vez que se abre se cuenta un
// escaneo. /qr existe para poder reimprimir el código con un link más corto
// y saber cuáles vienen del cartel y cuáles de alguien que ya lo tenía.
app.get("/qr", (req, res) => {
  res.redirect("/cliente?via=qr");
});

app.get("/cliente", (req, res) => {
  registrarEscaneo(req, res);
  // Sin caché: si el navegador guarda la página, el escaneo no se registra
  res.set("Cache-Control", "no-store");
  res.sendFile(__dirname + "/public/cliente.html");
});

// Validar código de referido. Con ?telefono=... revisa además si esa
// persona en particular lo puede usar (no es suyo, no gastó su turno).
app.get("/validar-ref/:codigo", async (req, res) => {
  const codigo = req.params.codigo.toUpperCase();
  const tel = typeof req.query.telefono === "string" ? req.query.telefono.trim() : "";
  try {
    const r = await revisarReferido(codigo, /^\d{10}$/.test(tel) ? tel : "");
    if (!r.existe) return res.json({ valido: false });
    if (!r.ok) return res.json({ valido: false, mensaje: r.error });
    return res.json({ valido: true, descuento: 10 });
  } catch(e) {
    return res.json({ valido: false });
  }
});

// Crear un código de referido (10% de un solo uso). Lo usa el botón de
// cupón de la página de ventas; va con contraseña porque si no, cualquiera
// podría generarse descuentos.
app.post("/crear-referido-inicial", soloAdmin, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Sin base de datos" });
  try {
    let codigo = generarCodigoReferido();
    while (await db.collection("referidos").findOne({ codigo })) {
      codigo = generarCodigoReferido();
    }
    // Para quién se creó, así en la pestaña de referidos se sabe a quién se le mandó.
    // enviado: true lo distingue de los que generan los clientes al pedir; estos
    // se pueden usar aunque el teléfono ya haya usado otro cupón antes.
    const para = typeof req.body?.para === "string" ? req.body.para.slice(0, 80).trim() : "";
    await db.collection("referidos").insertOne({ codigo, origen: para || "admin", enviado: true, usado: false, fecha: new Date() });
    return res.json({ codigo, link: "/cliente?ref=" + codigo });
  } catch(e) {
    return res.status(500).json({ error: "Error creando referido" });
  }
});

// Consultar estado de referidos
app.get("/referidos-status", soloAdmin, async (req, res) => {
  if (!db) return res.json({ referidos: [] });
  try {
    const referidos = await db.collection("referidos").find().sort({ fecha: -1 }).toArray();
    referidos.forEach(r => delete r._id);
    return res.json({ referidos });
  } catch(e) {
    return res.json({ referidos: [] });
  }
});

// Eliminar cupón de referido
app.delete("/eliminar-referido/:codigo", soloAdmin, async (req, res) => {
  const codigo = req.params.codigo.toUpperCase();
  if (!db) return res.status(500).json({ error: "Sin base de datos" });
  try {
    const result = await db.collection("referidos").deleteOne({ codigo });
    if (result.deletedCount > 0) {
      return res.json({ ok: true });
    }
    return res.status(404).json({ error: "Cupón no encontrado" });
  } catch(e) {
    return res.status(500).json({ error: "Error al eliminar" });
  }
});

// ---- Horario de pedidos en línea ----
// Minutos desde medianoche, en hora de la Ciudad de México.
// El domingo no se toman pedidos en línea (día sin horario).
const HORARIO_ONLINE = {
  0: null,                                        // domingo
  1: { abre: 7 * 60 + 30, cierra: 21 * 60 },      // lunes
  2: { abre: 7 * 60 + 30, cierra: 21 * 60 },      // martes
  3: { abre: 7 * 60 + 30, cierra: 21 * 60 },      // miércoles
  4: { abre: 7 * 60 + 30, cierra: 21 * 60 },      // jueves
  5: { abre: 7 * 60 + 30, cierra: 21 * 60 },      // viernes
  6: { abre: 7 * 60 + 30, cierra: 13 * 60 + 30 }  // sábado
};

const DIAS_SEMANA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const HORARIO_TEXTO = "Lunes a viernes 7:30 a.m. a 9:00 p.m. · Sábado 7:30 a.m. a 1:30 p.m. · Domingo cerrado";

function horaLegible(minutos) {
  const h24 = Math.floor(minutos / 60);
  const m = minutos % 60;
  const sufijo = h24 >= 12 ? "p.m." : "a.m.";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return h12 + ":" + String(m).padStart(2, "0") + " " + sufijo;
}

function estadoPedidosOnline() {
  const ahora = fechaMXAhora();
  const dia = ahora.getDay();
  const minutos = ahora.getHours() * 60 + ahora.getMinutes();
  const hoy = HORARIO_ONLINE[dia];

  if (hoy && minutos >= hoy.abre && minutos < hoy.cierra) {
    return {
      abierto: true,
      cierra: horaLegible(hoy.cierra),
      mensaje: "Pedidos en línea abiertos hasta las " + horaLegible(hoy.cierra),
      horario: HORARIO_TEXTO
    };
  }

  // Todavía no abre hoy
  if (hoy && minutos < hoy.abre) {
    return {
      abierto: false,
      mensaje: "Los pedidos en línea abren hoy a las " + horaLegible(hoy.abre),
      horario: HORARIO_TEXTO
    };
  }

  // Ya cerró (o es domingo): buscar el siguiente día con horario
  for (let i = 1; i <= 7; i++) {
    const d = (dia + i) % 7;
    const h = HORARIO_ONLINE[d];
    if (!h) continue;
    const cuando = i === 1 ? "mañana" : "el " + DIAS_SEMANA[d];
    return {
      abierto: false,
      mensaje: "Los pedidos en línea abren " + cuando + " a las " + horaLegible(h.abre),
      horario: HORARIO_TEXTO
    };
  }

  return { abierto: false, mensaje: "Los pedidos en línea están cerrados", horario: HORARIO_TEXTO };
}

app.get("/horario-online", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(estadoPedidosOnline());
});

// Mercado Pago: crear preferencia de pago
app.post("/crear-preferencia", async (req, res) => {
  const { cliente, telefono, productos: prods, total: monto, nota, cupon, paraLlevar } = req.body;

  // El horario se revisa aquí, no solo en la página: así no entra un pedido
  // por una pestaña que quedó abierta desde antes de cerrar.
  const horario = estadoPedidosOnline();
  if (!horario.abierto) {
    return res.status(403).json({ error: horario.mensaje, cerrado: true, horario: horario.horario });
  }

  if (!cliente || !telefono || !prods || prods.length === 0 || !monto) {
    return res.status(400).json({ error: "Datos incompletos" });
  }

  // Validar cupón
  const cuponUpper = cupon ? cupon.trim().toUpperCase() : "";
  let descuento = CUPONES[cuponUpper] || 0;

  // Cupones de un solo uso
  if (!descuento && CUPONES_1USO[cuponUpper]) {
    if (cuponesUsados.has(cuponUpper)) {
      return res.status(400).json({ error: "Este cupón ya fue utilizado" });
    }
    descuento = CUPONES_1USO[cuponUpper];
  }

  // Cupón de referido (link único). Hay dos clases y no se tratan igual:
  //   - los que manda el negocio desde la página de ventas (enviado: true):
  //     se pueden usar aunque el teléfono ya haya usado otro antes, para
  //     poder reactivar a un cliente cada tantos meses
  //   - los que genera un cliente al pedir, para pasarlos a sus conocidos:
  //     siguen siendo uno por teléfono, y quien lo generó no puede usarlo
  let esReferido = false;
  let referidoEnviado = false;
  if (!descuento && cuponUpper.startsWith("REF-") && db) {
    try {
      const r = await revisarReferido(cuponUpper.replace("REF-", ""), telefono);
      if (r.existe) {
        if (!r.ok) return res.status(400).json({ error: r.error });
        descuento = 10;
        esReferido = true;
        referidoEnviado = r.enviado;
      }
    } catch(e) {}
  }

  // Cupón 100%: crear pedido directo sin Mercado Pago
  if (descuento === 100) {
    try {
      const notaFinal = nota
        ? "[CUPON " + cuponUpper + " -100%] " + nota
        : "[CUPON " + cuponUpper + " -100%]";

      const pedido = {
        id: idCounter++,
        cliente: cliente + " (Tel: " + telefono + ")",
        productos: prods,
        total: 0,
        nota: notaFinal,
        paraLlevar: paraLlevar || false,
        origen: "cliente",
        estado: "pendiente",
        codigo: generarCodigoPedido(),
        creadoEn: Date.now(),
        fecha: fechaHoy(),
        horaEnvio: horaMXAhora()
      };

      pedidos.push(pedido);
      await guardarPedido(pedido);
      if (CUPONES_1USO[cuponUpper]) await marcarCuponUsado(cuponUpper);

      const nuevoCodigoRef = esReferido ? await canjearReferido(cuponUpper, telefono, referidoEnviado) : null;
      io.emit("nuevoPedido", pedido);

      return res.json({ directo: true, nuevoRef: nuevoCodigoRef, codigo: pedido.codigo });
    } catch (e) {
      console.error("Error creando pedido directo:", e.message);
      return res.status(500).json({ error: "Error al crear el pedido" });
    }
  }

  // Monto con descuento parcial. Se calcula antes de las dos ramas porque
  // el cupón tiene que valer igual con o sin Mercado Pago.
  let montoFinal = monto;
  let notaConCupon = nota || "";
  if (descuento > 0) {
    montoFinal = Math.round(monto * (1 - descuento / 100) * 100) / 100;
    notaConCupon = "[CUPON " + cuponUpper + " -" + descuento + "%] " + notaConCupon;
  }

  if (!process.env.MERCADOPAGO_ACCESS_TOKEN_ONLINE && !process.env.MERCADOPAGO_ACCESS_TOKEN) {
    // Sin Mercado Pago: crear pedido directo
    try {
      const pedido = {
        id: idCounter++,
        cliente: cliente + " (Tel: " + telefono + ")",
        productos: prods,
        total: montoFinal,
        nota: notaConCupon,
        paraLlevar: paraLlevar || false,
        origen: "cliente",
        estado: "pendiente",
        codigo: generarCodigoPedido(),
        creadoEn: Date.now(),
        fecha: fechaHoy(),
        horaEnvio: horaMXAhora()
      };
      pedidos.push(pedido);
      await guardarPedido(pedido);

      const nuevoCodigoRef2 = esReferido ? await canjearReferido(cuponUpper, telefono, referidoEnviado) : null;
      io.emit("nuevoPedido", pedido);
      return res.json({ directo: true, nuevoRef: nuevoCodigoRef2, codigo: pedido.codigo });
    } catch (e) {
      return res.status(500).json({ error: "Error al crear el pedido" });
    }
  }

  const ref = "pedido_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

  try {
    const preference = new Preference(mpClient);
    const result = await preference.create({
      body: {
        items: [{
          title: "Pedido de " + cliente,
          quantity: 1,
          unit_price: montoFinal,
          currency_id: "MXN"
        }],
        external_reference: ref,
        back_urls: {
          success: BASE_URL + "/pago-exitoso",
          failure: BASE_URL + "/pago-fallido",
          pending: BASE_URL + "/pago-pendiente"
        },
        auto_return: "approved"
      }
    });

    await guardarPedidoPendiente(ref, { cliente, telefono, productos: prods, total: montoFinal, nota: notaConCupon, paraLlevar: paraLlevar || false, cupon: cuponUpper, esReferido, referidoEnviado });

    res.json({
      preference_id: result.id,
      public_key: MP_PUBLIC_KEY,
      external_reference: ref,
      init_point: result.init_point  // fallback por si Bricks falla
    });
  } catch (e) {
    console.error("Error creando preferencia MP:", e.message);
    res.status(500).json({ error: "Error al crear el pago" });
  }
});

// Buscar payment_id por external_reference (Bricks no siempre lo devuelve directo)
async function buscarPaymentPorReferencia(external_reference) {
  try {
    const url = "https://api.mercadopago.com/v1/payments/search?external_reference=" +
                encodeURIComponent(external_reference) +
                "&sort=date_created&criteria=desc&limit=5";
    const token = process.env.MERCADOPAGO_ACCESS_TOKEN_ONLINE || process.env.MERCADOPAGO_ACCESS_TOKEN || "";
    const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    const data = await r.json();
    if (!data.results || data.results.length === 0) return null;
    // Preferir aprobado
    const aprobado = data.results.find(p => p.status === "approved");
    return aprobado || data.results[0];
  } catch (e) {
    console.error("Error buscando pago por referencia:", e.message);
    return null;
  }
}

// Lógica compartida: confirma pago MP y crea pedido real
async function confirmarPagoOnline(external_reference, payment_id) {
  if (!external_reference) {
    return { ok: false, error: "datos_faltantes" };
  }

  let paymentData;
  const payment = new Payment(mpClient);
  if (payment_id) {
    paymentData = await payment.get({ id: payment_id });
  } else {
    paymentData = await buscarPaymentPorReferencia(external_reference);
    if (!paymentData) {
      return { ok: false, error: "pago_no_encontrado" };
    }
  }

  if (paymentData.status !== "approved") {
    return { ok: false, error: "pago_no_aprobado", status: paymentData.status };
  }

  const pendiente = await obtenerPedidoPendiente(external_reference);
  if (!pendiente) {
    return { ok: false, error: "pedido_pendiente_no_encontrado" };
  }

  const notaFinal = pendiente.nota
    ? "[PAGO ONLINE] " + pendiente.nota
    : "[PAGO ONLINE]";

  const pedido = {
    id: idCounter++,
    cliente: pendiente.cliente + " (Tel: " + pendiente.telefono + ")",
    productos: pendiente.productos,
    total: pendiente.total,
    nota: notaFinal,
    paraLlevar: pendiente.paraLlevar || false,
    origen: "cliente",
    estado: "pendiente",
    codigo: generarCodigoPedido(),
    creadoEn: Date.now(),
    folioPago: paymentData.id ? String(paymentData.id) : "",
    fecha: fechaHoy(),
    horaEnvio: horaMXAhora()
  };

  pedidos.push(pedido);
  await guardarPedido(pedido);
  if (pendiente.cupon && CUPONES_1USO[pendiente.cupon]) await marcarCuponUsado(pendiente.cupon);

  const nuevoRefMP = (pendiente.esReferido && pendiente.cupon)
    ? await canjearReferido(pendiente.cupon, pendiente.telefono, pendiente.referidoEnviado)
    : null;
  io.emit("nuevoPedido", pedido);
  await eliminarPedidoPendiente(external_reference);

  return { ok: true, pedidoId: pedido.id, nuevoRef: nuevoRefMP, codigo: pedido.codigo };
}

// Bricks con tarjeta: el brick solo tokeniza, el cobro se crea aquí.
// (Con saldo/cuenta de Mercado Pago el cobro lo hace MP y se confirma
// por /confirmar-pago-online, que solo busca el pago ya existente.)
app.post("/procesar-pago-tarjeta", async (req, res) => {
  const { external_reference, formData } = req.body || {};

  if (!external_reference || !formData || !formData.token) {
    return res.status(400).json({ ok: false, error: "datos_faltantes" });
  }

  try {
    // El monto sale del pedido guardado en el servidor, nunca del navegador
    const pendiente = await obtenerPedidoPendiente(external_reference);
    if (!pendiente) {
      return res.status(400).json({ ok: false, error: "pedido_pendiente_no_encontrado" });
    }

    const payment = new Payment(mpClient);
    const cobro = await payment.create({
      body: {
        transaction_amount: Number(pendiente.total),
        token: formData.token,
        description: "Pedido de " + pendiente.cliente,
        installments: Number(formData.installments) || 1,
        payment_method_id: formData.payment_method_id,
        issuer_id: formData.issuer_id,
        payer: formData.payer,
        external_reference
      },
      // La llave incluye el token de la tarjeta: si el cliente da doble clic
      // no se cobra dos veces, pero si reintenta con otra tarjeta (token
      // nuevo) sí se procesa el intento nuevo.
      requestOptions: { idempotencyKey: external_reference + ":" + formData.token }
    });

    if (cobro.status !== "approved") {
      return res.json({
        ok: false,
        error: "pago_no_aprobado",
        status: cobro.status,
        detalle: cobro.status_detail
      });
    }

    const confirmado = await confirmarPagoOnline(external_reference, cobro.id);
    if (!confirmado.ok) return res.status(400).json(confirmado);

    res.json({ ok: true, status: "approved", ...confirmado });
  } catch (e) {
    console.error("Error procesando pago con tarjeta:", e.message);
    res.status(500).json({ ok: false, error: "server_error", detalle: e.message });
  }
});

// Bricks: confirma pago desde el frontend (POST con JSON)
app.post("/confirmar-pago-online", async (req, res) => {
  const { external_reference, payment_id } = req.body;
  try {
    const result = await confirmarPagoOnline(external_reference, payment_id);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    console.error("Error confirmando pago online:", e.message);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Mercado Pago: pago exitoso (Checkout Pro / fallback)
app.get("/pago-exitoso", async (req, res) => {
  const { external_reference, payment_id } = req.query;
  try {
    const result = await confirmarPagoOnline(external_reference, payment_id);
    if (!result.ok) return res.redirect("/cliente-error.html");
    res.redirect("/cliente-confirmado.html" + (result.nuevoRef ? "?ref=" + result.nuevoRef : ""));
  } catch (e) {
    console.error("Error verificando pago:", e.message);
    res.redirect("/cliente-error.html");
  }
});

// Mercado Pago: pago fallido
app.get("/pago-fallido", (req, res) => {
  res.redirect("/cliente-error.html");
});

// Mercado Pago: pago pendiente
app.get("/pago-pendiente", (req, res) => {
  res.redirect("/cliente-error.html");
});

function fechaHoy() {
  return new Date().toLocaleDateString("es-MX", { timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit" });
}

function horaMXAhora() {
  return new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" });
}

// Las horas se guardan como "10:59 p.m.". Para los reportes hace falta el
// número de 0 a 23: si no, las 10 de la mañana y las 10 de la noche caen
// en la misma columna de la gráfica.
function hora24(texto) {
  const partes = String(texto || "").match(/(\d{1,2}):(\d{2})/);
  if (!partes) return null;

  let h = parseInt(partes[1], 10);
  if (!isFinite(h) || h < 0 || h > 23) return null;

  const t = String(texto).toLowerCase();
  if (/p\.?\s*m\.?/.test(t) && h < 12) h += 12;
  if (/a\.?\s*m\.?/.test(t) && h === 12) h = 0;
  return h;
}

// Pedidos por hora del día, con todas las horas de servicio aunque no haya
// habido ventas: así se ve el hueco, no una gráfica que se salta horas.
const HORA_APERTURA = 7;
const HORA_CIERRE = 23;

function pedidosPorHora(lista) {
  const cuenta = {};

  lista.forEach(p => {
    const h = hora24(p.horaEnvio);
    if (h === null) return;
    if (!cuenta[h]) cuenta[h] = { pedidos: 0, total: 0 };
    cuenta[h].pedidos++;
    cuenta[h].total += p.total || 0;
  });

  const horas = new Set(Object.keys(cuenta).map(Number));
  for (let h = HORA_APERTURA; h <= HORA_CIERRE; h++) horas.add(h);

  return [...horas].sort((a, b) => a - b).map(h => ({
    hora: String(h).padStart(2, "0") + ":00",
    h24: h,
    etiqueta: etiquetaHora(h, true),
    etiquetaLarga: etiquetaHora(h, false),
    pedidos: cuenta[h] ? cuenta[h].pedidos : 0,
    total: cuenta[h] ? cuenta[h].total : 0
  }));
}

// corta: "7a" / "12p", para que quepan 17 columnas en la gráfica
// larga: "7 am" / "12 pm", para el resumen y el globo de ayuda
function etiquetaHora(h, corta) {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  if (corta) return h12 + (h >= 12 ? "p" : "a");
  return h12 + (h >= 12 ? " pm" : " am");
}

app.post("/pedido", soloAdmin, async (req, res) => {
  const pedido = {
    id: idCounter++,
    cliente: req.body.cliente,
    productos: req.body.productos,
    total: req.body.total,
    nota: req.body.nota || "",
    paraLlevar: req.body.paraLlevar || false,
    metodoPago: req.body.metodoPago || "efectivo",
    estado: "pendiente",
    fecha: fechaHoy(),
    horaEnvio: horaMXAhora()
  };

  pedidos.push(pedido);
  await guardarPedido(pedido);

  io.emit("nuevoPedido", pedido);

  res.json(pedido);
});

app.get("/pedidos", soloAdmin, (req, res) => {
  res.json(pedidos);
});

// Comprobante del cliente: se consulta con el código del pedido, que solo
// tiene quien lo hizo. No devuelve el teléfono ni datos de pago del cliente.
app.get("/comprobante/:codigo", (req, res) => {
  const codigo = String(req.params.codigo || "").toUpperCase();
  const pedido = pedidos.find(p => p.codigo === codigo);

  if (!pedido) return res.status(404).json({ error: "no_encontrado" });

  // El nombre viene como "Nombre (Tel: 55...)": se recorta el teléfono
  const nombre = pedido.cliente.replace(/\s*\(Tel:.*$/, "");

  res.json({
    codigo: pedido.codigo,
    numero: pedido.id,
    cliente: nombre,
    productos: pedido.productos,
    total: pedido.total,
    paraLlevar: pedido.paraLlevar || false,
    // Se quitan las marcas internas ([PAGO ONLINE], [CUPON ...]) que no le
    // dicen nada al cliente; solo queda su indicación
    nota: (pedido.nota || "").replace(/^\[PAGO ONLINE\]\s*/, "").replace(/^\[CUPON[^\]]*\]\s*/, "").trim(),
    estado: pedido.estado,
    fecha: pedido.fecha,
    horaEnvio: pedido.horaEnvio,
    creadoEn: pedido.creadoEn || null,
    folioPago: pedido.folioPago || "",
    entregado: pedido.estado === "Entregado",
    horaEntrega: pedido.horaEntrega || ""
  });
});

// Solo los pedidos activos (cocina, barra y entrega).
// Evita mandar el historial completo en cada sincronización.
app.get("/pedidos/activos", (req, res) => {
  res.json(pedidos.filter(p => p.estado === "pendiente" || p.estado === "Listo"));
});

// Pedidos entregados del día (panel de entregados en entrega.html)
app.get("/pedidos/entregados-hoy", (req, res) => {
  const hoy = fechaHoy();
  res.json(pedidos.filter(p => p.estado === "Entregado" && p.fecha === hoy));
});

app.get("/agotados", (req, res) => {
  res.json(agotados);
});

app.post("/agotados", soloAdmin, (req, res) => {
  if (!Array.isArray(req.body && req.body.agotados)) {
    return res.status(400).json({ error: "agotados debe ser un array" });
  }
  agotados = req.body.agotados
    .map(a => String(a).toLowerCase().trim())
    .filter(Boolean);
  guardarAgotados();
  io.emit("agotadosActualizados", agotados);
  res.json({ ok: true, agotados });
});

// ---- Clientes frecuentes (para mandarles cupones por WhatsApp) ----
app.get("/clientes-frecuentes", soloAdmin, (req, res) => {
  const porTelefono = {};

  pedidos.forEach(p => {
    const match = (p.cliente || "").match(/^(.+?)\s*\(Tel:\s*(\d+)\)/);
    if (!match) return;                       // pedidos de caja, sin teléfono
    if (p.estado !== "Entregado") return;     // solo pedidos que sí se cobraron

    const nombre = match[1].trim();
    const telefono = match[2];

    if (!porTelefono[telefono]) {
      porTelefono[telefono] = { telefono, nombre, pedidos: 0, total: 0, ultimo: 0, ultimaFecha: p.fecha || "" };
    }
    const c = porTelefono[telefono];
    c.pedidos += 1;
    c.total += p.total || 0;
    c.nombre = nombre;  // el nombre más reciente

    const cuando = p.entregadoEn || p.creadoEn || 0;
    if (cuando >= c.ultimo) {
      c.ultimo = cuando;
      c.ultimaFecha = p.fecha || c.ultimaFecha;
    }
  });

  const clientes = Object.values(porTelefono)
    .sort((a, b) => b.pedidos - a.pedidos || b.total - a.total)
    .slice(0, 300);

  res.json({ clientes });
});

// ---- Cuentas: trabajadores y clientes que deben ----
// Las dos listas llevan lo mismo: una ficha con movimientos que suman
// (cargo: lo que debe) o restan (abono: lo que ya pagó o se le descontó).
// Los trabajadores además guardan puesto y salario.
const cuentas = { trabajadores: [], deudores: [] };
const contadorCuenta = { trabajadores: 1, deudores: 1 };

const CONFIG_CUENTAS = {
  trabajadores: { backup: "trabajadores-backup.json", salario: true },
  deudores:     { backup: "deudores-backup.json",     salario: false }
};

function rutaBackupCuenta(tipo) {
  return path.join(BACKUP_DIR, CONFIG_CUENTAS[tipo].backup);
}

function guardarCuentaEnDisco(tipo) {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
    fs.writeFileSync(rutaBackupCuenta(tipo), JSON.stringify(cuentas[tipo], null, 2));
  } catch (e) { console.error("Error guardando " + tipo + ":", e.message); }
}

async function guardarFicha(tipo, ficha) {
  guardarCuentaEnDisco(tipo);
  if (db) {
    try {
      // replaceOne y no $set: si se borra un movimiento, con $set el arreglo
      // viejo se quedaría en la base
      await db.collection(tipo).replaceOne({ id: ficha.id }, ficha, { upsert: true });
    } catch (e) { console.error("Error guardando " + tipo + " en MongoDB:", e.message); }
  }
}

async function borrarFicha(tipo, id) {
  guardarCuentaEnDisco(tipo);
  if (db) {
    try { await db.collection(tipo).deleteOne({ id }); }
    catch (e) { console.error("Error borrando " + tipo + " en MongoDB:", e.message); }
  }
}

// Lo que debe: los cargos suman, los abonos restan
function saldoCuenta(ficha) {
  const saldo = (ficha.movimientos || [])
    .reduce((acc, m) => acc + (m.tipo === "abono" ? -m.monto : m.monto), 0);
  return Math.round(saldo * 100) / 100;
}

function fichaConSaldo(tipo, ficha) {
  const debe = saldoCuenta(ficha);
  const salida = { ...ficha, debe };
  if (CONFIG_CUENTAS[tipo].salario) {
    salida.neto = Math.round(((ficha.salario || 0) - debe) * 100) / 100;
  }
  return salida;
}

function textoLimpio(valor, max) {
  return typeof valor === "string" ? valor.trim().slice(0, max) : "";
}

// Devuelve el monto redondeado a centavos, o null si no sirve
function montoValido(valor, permitirCero) {
  const n = Number(valor);
  if (!isFinite(n) || n > 1000000) return null;
  if (permitirCero ? n < 0 : n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function registrarRutasCuenta(tipo) {
  const base = "/" + tipo;
  const conSalario = CONFIG_CUENTAS[tipo].salario;

  app.get(base, soloAdmin, (req, res) => {
    const lista = cuentas[tipo].map(f => fichaConSaldo(tipo, f));
    res.json({
      lista,
      totalDebe: Math.round(lista.reduce((a, f) => a + f.debe, 0) * 100) / 100,
      totalSalarios: conSalario
        ? Math.round(lista.reduce((a, f) => a + (f.salario || 0), 0) * 100) / 100
        : 0
    });
  });

  app.post(base, soloAdmin, async (req, res) => {
    const nombre = textoLimpio(req.body && req.body.nombre, 60);
    if (!nombre) return res.status(400).json({ error: "Falta el nombre" });

    const ficha = {
      id: contadorCuenta[tipo]++,
      nombre,
      movimientos: [],
      creado: fechaHoy()
    };

    if (conSalario) {
      ficha.puesto = textoLimpio(req.body.puesto, 40);
      const salario = montoValido(req.body.salario, true);
      if (req.body.salario !== undefined && salario === null) {
        return res.status(400).json({ error: "Salario inválido" });
      }
      ficha.salario = salario || 0;
    } else {
      ficha.telefono = String(req.body.telefono || "").replace(/\D/g, "").slice(0, 10);
    }

    cuentas[tipo].push(ficha);
    await guardarFicha(tipo, ficha);
    res.json(fichaConSaldo(tipo, ficha));
  });

  app.put(base + "/:id", soloAdmin, async (req, res) => {
    const ficha = cuentas[tipo].find(f => f.id === parseInt(req.params.id));
    if (!ficha) return res.status(404).json({ error: "No encontrado" });

    if (req.body.nombre !== undefined) {
      const nombre = textoLimpio(req.body.nombre, 60);
      if (!nombre) return res.status(400).json({ error: "Falta el nombre" });
      ficha.nombre = nombre;
    }

    if (conSalario) {
      if (req.body.puesto !== undefined) ficha.puesto = textoLimpio(req.body.puesto, 40);
      if (req.body.salario !== undefined) {
        const salario = montoValido(req.body.salario, true);
        if (salario === null) return res.status(400).json({ error: "Salario inválido" });
        ficha.salario = salario;
      }
    } else if (req.body.telefono !== undefined) {
      ficha.telefono = String(req.body.telefono).replace(/\D/g, "").slice(0, 10);
    }

    await guardarFicha(tipo, ficha);
    res.json(fichaConSaldo(tipo, ficha));
  });

  app.delete(base + "/:id", soloAdmin, async (req, res) => {
    if (req.body.password !== PASS_ELIMINAR) {
      return res.status(401).json({ error: "Contraseña incorrecta" });
    }
    const id = parseInt(req.params.id);
    const idx = cuentas[tipo].findIndex(f => f.id === id);
    if (idx === -1) return res.status(404).json({ error: "No encontrado" });

    cuentas[tipo].splice(idx, 1);
    await borrarFicha(tipo, id);
    res.json({ ok: true });
  });

  app.post(base + "/:id/movimiento", soloAdmin, async (req, res) => {
    const ficha = cuentas[tipo].find(f => f.id === parseInt(req.params.id));
    if (!ficha) return res.status(404).json({ error: "No encontrado" });

    const monto = montoValido(req.body && req.body.monto);
    if (monto === null) return res.status(400).json({ error: "Monto inválido" });

    const ahora = fechaMXAhora();
    const movimiento = {
      id: (ficha.movimientos.reduce((a, m) => Math.max(a, m.id), 0) || 0) + 1,
      tipo: req.body.tipo === "abono" ? "abono" : "cargo",
      concepto: textoLimpio(req.body.concepto, 80) || (req.body.tipo === "abono" ? "Abono" : "Cargo"),
      monto,
      fecha: ahora.toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric" }),
      hora: ahora.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })
    };

    ficha.movimientos.push(movimiento);
    await guardarFicha(tipo, ficha);
    res.json(fichaConSaldo(tipo, ficha));
  });

  app.delete(base + "/:id/movimiento/:movId", soloAdmin, async (req, res) => {
    if (req.body.password !== PASS_ELIMINAR) {
      return res.status(401).json({ error: "Contraseña incorrecta" });
    }
    const ficha = cuentas[tipo].find(f => f.id === parseInt(req.params.id));
    if (!ficha) return res.status(404).json({ error: "No encontrado" });

    const idx = ficha.movimientos.findIndex(m => m.id === parseInt(req.params.movId));
    if (idx === -1) return res.status(404).json({ error: "Movimiento no encontrado" });

    ficha.movimientos.splice(idx, 1);
    await guardarFicha(tipo, ficha);
    res.json(fichaConSaldo(tipo, ficha));
  });
}

registrarRutasCuenta("trabajadores");
registrarRutasCuenta("deudores");

// ---- Historial de un cliente (se abre desde la lista de clientes) ----
app.get("/cliente-historial/:telefono", soloAdmin, (req, res) => {
  const telefono = String(req.params.telefono || "").replace(/\D/g, "");
  if (!/^\d{10}$/.test(telefono)) {
    return res.status(400).json({ error: "Teléfono inválido" });
  }

  const suyos = pedidos.filter(p => {
    const m = (p.cliente || "").match(/\(Tel:\s*(\d+)\)/);
    return m && m[1] === telefono;
  });

  // Del más reciente al más viejo. La fecha y la hora son texto, así que se
  // ordenan por su valor real, no alfabéticamente.
  const cuando = p => {
    const f = p.fecha ? parseFechaMX(p.fecha).getTime() : 0;
    const h = hora24(p.horaEnvio);
    return f + (h === null ? 0 : h * 3600000);
  };
  suyos.sort((a, b) => cuando(b) - cuando(a) || b.id - a.id);

  const historial = suyos.map(p => {
    const cupon = (p.nota || "").match(/\[CUPON\s+([^\s\]]+)/);
    return {
      id: p.id,
      codigo: p.codigo || "",
      fecha: p.fecha || "",
      hora: p.horaEnvio || "",
      horaEntrega: p.horaEntrega || "",
      estado: p.estado,
      total: p.total || 0,
      paraLlevar: p.paraLlevar || false,
      enLinea: p.origen === "cliente",
      metodoPago: p.metodoPago || "",
      cupon: cupon ? cupon[1] : "",
      productos: (p.productos || []).map(pr => ({
        nombre: pr.nombre,
        cantidad: pr.cantidad || 1,
        nota: pr.nota || ""
      })),
      // Las marcas de pago son para la caja, aquí solo estorban
      nota: (p.nota || "")
        .replace(/^\[PAGO ONLINE\]\s*/, "")
        .replace(/^\[CUPON[^\]]*\]\s*/, "")
        .trim()
    };
  });

  // Lo que más pide, para saber qué ofrecerle
  const cuenta = {};
  historial.forEach(p => {
    if (p.estado !== "Entregado") return;
    p.productos.forEach(pr => {
      cuenta[pr.nombre] = (cuenta[pr.nombre] || 0) + pr.cantidad;
    });
  });
  const favoritos = Object.entries(cuenta)
    .map(([nombre, cantidad]) => ({ nombre, cantidad }))
    .sort((a, b) => b.cantidad - a.cantidad)
    .slice(0, 5);

  const entregados = historial.filter(p => p.estado === "Entregado");

  res.json({
    telefono,
    pedidos: historial,
    entregados: entregados.length,
    total: entregados.reduce((a, p) => a + p.total, 0),
    primera: historial.length ? historial[historial.length - 1].fecha : "",
    ultima: historial.length ? historial[0].fecha : "",
    favoritos
  });
});

// ---- Escaneos del QR (panel de la página de ventas) ----
app.get("/escaneos", soloAdmin, (req, res) => {
  // Pedidos en línea por día, para ver cuántos escaneos acabaron en pedido
  const pedidosPorDia = {};
  pedidos.forEach(p => {
    if (p.origen !== "cliente" || !p.fecha) return;
    pedidosPorDia[p.fecha] = (pedidosPorDia[p.fecha] || 0) + 1;
  });

  const dias = Object.values(escaneos)
    .map(d => ({ ...d, pedidos: pedidosPorDia[d.fecha] || 0 }))
    .sort((a, b) => parseFechaMX(b.fecha) - parseFechaMX(a.fecha))
    .slice(0, 60);

  const hoy = fechaHoy();
  const totalEscaneos = dias.reduce((acc, d) => acc + d.total, 0);
  const totalPedidos = dias.reduce((acc, d) => acc + d.pedidos, 0);

  res.json({
    hoy: dias.find(d => d.fecha === hoy) || { fecha: hoy, total: 0, unicos: 0, desdeQR: 0, porHora: {}, pedidos: 0 },
    dias,
    totalEscaneos,
    totalPedidos,
    linkQR: (process.env.BASE_URL || "") + "/qr"
  });
});

// ---- Precios del menú (editor de la página de ventas) ----
app.get("/menu/precios", soloAdmin, (req, res) => {
  res.json({ precios: menuPrecios });
});

// Guardar o restaurar un precio. precio: null restaura el original de menu.js
app.post("/menu/precios", soloAdmin, async (req, res) => {
  const { ruta, precio } = req.body || {};

  if (!ruta || typeof ruta !== "string") {
    return res.status(400).json({ error: "falta la ruta del precio" });
  }

  if (precio === null) {
    delete menuPrecios[ruta];
  } else {
    const valor = Number(precio);
    if (!isFinite(valor) || valor < 0 || valor > 100000) {
      return res.status(400).json({ error: "precio inválido" });
    }
    menuPrecios[ruta] = Math.round(valor * 100) / 100;
  }

  await guardarPrecios();
  io.emit("preciosActualizados");
  res.json({ ok: true, precios: menuPrecios });
});

app.put("/pedido/:id", soloAdmin, async (req, res) => {
  const pedido = pedidos.find(p => p.id == req.params.id);
  if (pedido) {
    pedido.estado = req.body.estado;
    // La hora de entrega se guarda venga de donde venga el cambio de estado
    if (pedido.estado === "Entregado" && !pedido.horaEntrega) {
      pedido.horaEntrega = horaMXAhora();
      pedido.entregadoEn = Date.now();
    }
    await guardarPedido(pedido);
    io.emit("actualizarPedido", pedido);
    res.json(pedido);
  } else {
    res.status(404).send("No encontrado");
  }
});

// Mercado Pago Point: cobrar con terminal (API v1/orders)
const MP_DEVICE_ID = process.env.MP_DEVICE_ID || "NEWLAND_N950__N950NCCB05482252";

let lastOrderId = null;

app.post("/cobrar-terminal", soloAdmin, async (req, res) => {
  const { amount, reference } = req.body;
  if (!amount || amount < 5) return res.status(400).json({ error: "Monto mínimo $5" });
  if (!MP_TOKEN_PRESENCIAL) return res.status(500).json({ error: "Mercado Pago presencial no configurado" });
  try {
    // Cancelar orden anterior si existe
    if (lastOrderId) {
      try {
        await fetch(`https://api.mercadopago.com/v1/orders/${lastOrderId}/cancel`, {
          method: "POST",
          headers: { "Authorization": "Bearer " + MP_TOKEN_PRESENCIAL, "X-Idempotency-Key": "cancel-" + lastOrderId + "-" + Date.now() }
        });
      } catch (e) {}
      lastOrderId = null;
    }
    const resp = await fetch("https://api.mercadopago.com/v1/orders", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + MP_TOKEN_PRESENCIAL,
        "Content-Type": "application/json",
        "X-Idempotency-Key": (reference || "caja") + "-" + Date.now()
      },
      body: JSON.stringify({
        type: "point",
        external_reference: reference || "caja-" + Date.now(),
        transactions: { payments: [{ amount: amount.toFixed(2) }] },
        config: {
          point: { terminal_id: MP_DEVICE_ID, print_on_terminal: "no_ticket" },
          payment_method: { default_type: "credit_card" }
        }
      })
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);
    lastOrderId = data.id;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/cobrar-terminal/:orderId", soloAdmin, async (req, res) => {
  if (!MP_TOKEN_PRESENCIAL) return res.status(500).json({ error: "No configurado" });
  try {
    const resp = await fetch(`https://api.mercadopago.com/v1/orders/${req.params.orderId}`, {
      headers: { "Authorization": "Bearer " + MP_TOKEN_PRESENCIAL }
    });
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/cobrar-terminal/:orderId", soloAdmin, async (req, res) => {
  if (!MP_TOKEN_PRESENCIAL) return res.status(500).json({ error: "No configurado" });
  try {
    const resp = await fetch(`https://api.mercadopago.com/v1/orders/${req.params.orderId}/cancel`, {
      method: "POST",
      headers: { "Authorization": "Bearer " + MP_TOKEN_PRESENCIAL, "X-Idempotency-Key": "cancel-" + req.params.orderId + "-" + Date.now() }
    });
    if (!resp.ok) return res.status(resp.status).json(await resp.json());
    lastOrderId = null;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Login para caja y ventas
const crypto = require("crypto");
const USUARIO_ADMIN = process.env.USUARIO_ADMIN || "admin";
const PASS_ADMIN = process.env.PASS_ADMIN || "1234";
// Token derivado de la contraseña: sobrevive a los reinicios del servidor
// (si fuera aleatorio, cada deploy cerraría la sesión de caja y ventas)
const TOKEN_ADMIN = crypto.createHash("sha256").update("pdv:" + USUARIO_ADMIN + ":" + PASS_ADMIN).digest("hex");

// Token solo para descargar reportes. Va en la URL (window.open y correo
// no permiten mandar encabezados) y rota cada semana, así un enlace
// reenviado por correo deja de servir y no da acceso a nada más.
function tokenExport(semanasAtras) {
  const semana = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000)) - (semanasAtras || 0);
  return crypto.createHash("sha256").update("export:" + PASS_ADMIN + ":" + semana).digest("hex").slice(0, 24);
}

function soloAdmin(req, res, next) {
  if (req.get("X-Token") === TOKEN_ADMIN) return next();
  res.status(401).json({ error: "No autorizado" });
}

function soloAdminOExport(req, res, next) {
  if (req.get("X-Token") === TOKEN_ADMIN) return next();
  const t = req.query.t;
  if (t && (t === tokenExport(0) || t === tokenExport(1))) return next();
  res.status(401).send("No autorizado");
}

// Retraso ante intentos fallidos seguidos desde la misma IP
const intentosLogin = new Map();

app.post("/login", (req, res) => {
  const { usuario, password } = req.body || {};
  const ip = req.ip;
  const fallos = intentosLogin.get(ip) || 0;

  if (fallos >= 5) {
    return res.status(429).json({ error: "Demasiados intentos, espera un momento" });
  }

  if (typeof usuario === "string" && typeof password === "string" &&
      usuario.normalize("NFC") === USUARIO_ADMIN.normalize("NFC") && password === PASS_ADMIN) {
    intentosLogin.delete(ip);
    res.json({ token: TOKEN_ADMIN, tokenExport: tokenExport(0) });
  } else {
    intentosLogin.set(ip, fallos + 1);
    setTimeout(() => {
      const n = (intentosLogin.get(ip) || 1) - 1;
      if (n > 0) intentosLogin.set(ip, n); else intentosLogin.delete(ip);
    }, 60000);
    res.status(401).json({ error: "Usuario o contraseña incorrectos" });
  }
});

app.post("/verificar-token", (req, res) => {
  if (req.body && req.body.token === TOKEN_ADMIN) {
    res.json({ ok: true, tokenExport: tokenExport(0) });
  } else {
    res.status(401).json({ error: "Token inválido" });
  }
});

const PASS_ELIMINAR = process.env.PASS_ELIMINAR || "1234";

app.delete("/pedido/:id", soloAdmin, async (req, res) => {
  if (req.body.password !== PASS_ELIMINAR) {
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }
  const id = parseInt(req.params.id);
  const idx = pedidos.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).send("No encontrado");

  // Guardar en historial de eliminados
  const eliminado = { ...pedidos[idx], eliminadoEn: new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" }) };
  pedidosEliminados.push(eliminado);
  if (db) {
    try { await db.collection("pedidos_eliminados").insertOne({ ...eliminado }); } catch(e) {}
  }

  pedidos.splice(idx, 1);
  if (db) {
    try {
      await db.collection("pedidos").deleteOne({ id });
    } catch (e) {
      console.error("Error eliminando pedido:", e.message);
    }
  }
  io.emit("pedidoEliminado", id);
  res.json({ ok: true });
});

app.get("/ventas/fechas", soloAdmin, (req, res) => {
  const fechas = [...new Set(pedidos.filter(p => p.estado === "Entregado" && p.fecha).map(p => p.fecha))];
  res.json(fechas);
});

app.get("/ventas/fecha/:fecha", soloAdmin, (req, res) => {
  const entregados = pedidos.filter(p => p.estado === "Entregado" && p.fecha === req.params.fecha);
  const total = entregados.reduce((acc, p) => acc + p.total, 0);

  // Categorías
  const cats = {};
  entregados.forEach(p => {
    p.productos.forEach(pr => {
      const cat = detectarCategoria(pr.nombre);
      const cant = pr.cantidad || 1;
      if (!cats[cat]) cats[cat] = { nombre: cat, cantidad: 0, total: 0 };
      cats[cat].cantidad += cant;
      cats[cat].total += pr.precio || 0;
    });
  });
  const categorias = Object.values(cats).sort((a, b) => b.cantidad - a.cantidad);

  const porHora = pedidosPorHora(entregados);

  // Por método de pago
  const totalEfectivo = entregados.filter(p => p.metodoPago !== "tarjeta").reduce((acc, p) => acc + p.total, 0);
  const totalTarjeta = entregados.filter(p => p.metodoPago === "tarjeta").reduce((acc, p) => acc + p.total, 0);

  // Comparativo: día anterior
  const [d, m, y] = req.params.fecha.split("/");
  const dateObj = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
  dateObj.setDate(dateObj.getDate() - 1);
  const fechaAnt = dateObj.getDate().toString().padStart(2, "0") + "/" + (dateObj.getMonth() + 1).toString().padStart(2, "0") + "/" + dateObj.getFullYear();
  const totalAnterior = pedidos.filter(p => p.estado === "Entregado" && p.fecha === fechaAnt).reduce((acc, p) => acc + p.total, 0);

  // Producto estrella
  const prods = {};
  entregados.forEach(p => p.productos.forEach(pr => {
    const n = pr.nombre;
    const c = pr.cantidad || 1;
    if (!prods[n]) prods[n] = { nombre: n, cantidad: 0 };
    prods[n].cantidad += c;
  }));
  const productoEstrella = Object.values(prods).sort((a, b) => b.cantidad - a.cantidad)[0] || null;

  res.json({ pedidos: entregados, total, categorias, porHora, totalEfectivo, totalTarjeta, totalAnterior, productoEstrella });
});

app.get("/total", soloAdmin, (req, res) => {
  const total = pedidos
    .filter(p => p.estado === "Entregado")
    .reduce((acc, p) => acc + p.total, 0);

  res.json({ total });
});

app.post("/pedido/listo/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const pedido = pedidos.find(p => p.id === id);

  if (!pedido) return res.status(404).send("No encontrado");

  pedido.estado = "Listo";
  await guardarPedido(pedido);
  io.emit("pedidoListo", pedido);
  res.json(pedido);
});

// Mapa de categorías por palabra clave en nombre del producto
function detectarCategoria(nombre) {
  // Sin acentos: caja escribe "Café" y la página de clientes "Cafe",
  // y ambos deben caer en la misma categoría del reporte
  const n = (nombre || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (n.includes("paquete") || n.includes("hot cakes") || n.includes("hotcakes") || n.includes("orden de huevo") || n.includes("bisquet") || n.includes("corn flakes") || n.includes("avocado")) return "Desayunos";
  if (n.includes("chilaquil")) return "Chilaquiles";
  if (n.includes("mollete") && !n.includes("mollequil")) return "Molletes";
  if (n.includes("mollequil")) return "Mollequiles";
  if (n.includes("burrito")) return "Burritos";
  if (n.includes("enchilada") || n.includes("enmolada") || n.includes("enfrijolada")) return "Enchiladas";
  if (n.includes("torta")) return "Tortas";
  if (n.includes("sope")) return "Sopes";
  if (n.includes("quesadilla")) return "Quesadillas";
  if (n.includes("tostada")) return "Tostadas";
  if (n.includes("sandwich") || n.includes("cuernito") || n.includes("hojaldra") || n.includes("club sandwich")) return "Sandwiches";
  if (n.includes("ham.") || n.includes("hamburguesa")) return "Hamburguesas";
  if (n.includes("bagel")) return "Bagels";
  if (n.includes("taco")) return "Tacos";
  if (n.includes("gringa")) return "Gringas";
  if (n.includes("nortena")) return "Norteñas";
  if (n.includes("sincronizada")) return "Sincronizadas";
  if (n.includes("ensalada")) return "Ensaladas";
  if (n.includes("hot dog")) return "Snacks";
  if (n.includes("banderilla")) return "Snacks";
  if (n.includes("papas")) return "Snacks";
  if (n.includes("nachos")) return "Snacks";
  if (n.includes("maruchan")) return "Snacks";
  if (n.includes("agua de") || n.includes("agua ")) return "Aguas";
  if (n.includes("licuado")) return "Licuados";
  if (n.includes("cafe") || n.includes("capuccino") || n.includes("espumoso") || n.includes("agua caliente")) return "Café";
  if (n.includes("coca") || n.includes("boing") || n.includes("fuze") || n.includes("jumex") || n.includes("gatorade") || n.includes("monster") || n.includes("redbull") || n.includes("volt") || n.includes("electrolit") || n.includes("yakult") || n.includes("panzoncita") || n.includes("penafielita") || n.includes("del valle") || n.includes("refresco") || n.includes("santa clara") || n.includes("arizona") || n.includes("bonafont")) return "Bebidas";
  return "Otros";
}

app.get("/ventas/productos-vendidos", soloAdmin, (req, res) => {
  const periodo = req.query.periodo || "dia";
  const fecha = req.query.fecha;
  const ahora = fechaMXAhora();

  let entregados;

  if (periodo === "dia") {
    const fechaFiltro = fecha || fechaHoy();
    entregados = pedidos.filter(p => p.estado === "Entregado" && p.fecha === fechaFiltro);
  } else if (periodo === "semana") {
    const hace7dias = new Date(ahora);
    hace7dias.setDate(hace7dias.getDate() - 6);
    hace7dias.setHours(0, 0, 0, 0);
    entregados = pedidos.filter(p => {
      if (p.estado !== "Entregado" || !p.fecha) return false;
      return parseFechaMX(p.fecha) >= hace7dias;
    });
  } else if (periodo === "mes") {
    const mesActual = (ahora.getMonth() + 1).toString().padStart(2, "0");
    const anioActual = ahora.getFullYear().toString();
    entregados = pedidos.filter(p => {
      if (p.estado !== "Entregado" || !p.fecha) return false;
      const partes = p.fecha.split("/");
      return partes[1] === mesActual && partes[2] === anioActual;
    });
  } else {
    return res.status(400).send("Periodo inválido");
  }

  // Productos individuales
  const productos = {};
  // Por categoría
  const categorias = {};
  // Por día
  const porDia = {};

  entregados.forEach(p => {
    const dia = p.fecha || "Sin fecha";

    if (!porDia[dia]) porDia[dia] = { fecha: dia, productos: {}, categorias: {} };

    p.productos.forEach(pr => {
      const nombre = pr.nombre;
      const cant = pr.cantidad || 1;
      const precio = pr.precio || 0;
      const cat = detectarCategoria(nombre);

      // Global productos
      if (!productos[nombre]) productos[nombre] = { nombre, cantidad: 0, total: 0 };
      productos[nombre].cantidad += cant;
      productos[nombre].total += precio;

      // Global categorías
      if (!categorias[cat]) categorias[cat] = { nombre: cat, cantidad: 0, total: 0 };
      categorias[cat].cantidad += cant;
      categorias[cat].total += precio;

      // Por día - productos
      if (!porDia[dia].productos[nombre]) porDia[dia].productos[nombre] = { nombre, cantidad: 0, total: 0 };
      porDia[dia].productos[nombre].cantidad += cant;
      porDia[dia].productos[nombre].total += precio;

      // Por día - categorías
      if (!porDia[dia].categorias[cat]) porDia[dia].categorias[cat] = { nombre: cat, cantidad: 0, total: 0 };
      porDia[dia].categorias[cat].cantidad += cant;
      porDia[dia].categorias[cat].total += precio;
    });
  });

  // Formatear porDia
  const diasArr = Object.values(porDia).map(d => ({
    fecha: d.fecha,
    productos: Object.values(d.productos).sort((a, b) => b.cantidad - a.cantidad),
    categorias: Object.values(d.categorias).sort((a, b) => b.cantidad - a.cantidad)
  })).sort((a, b) => {
    const pa = a.fecha.split("/"); const pb = b.fecha.split("/");
    return new Date(pb[2], pb[1]-1, pb[0]) - new Date(pa[2], pa[1]-1, pa[0]);
  });

  res.json({
    productos: Object.values(productos).sort((a, b) => b.cantidad - a.cantidad),
    categorias: Object.values(categorias).sort((a, b) => b.cantidad - a.cantidad),
    porDia: diasArr
  });
});

app.post("/pedido/:id/producto/:index", async (req, res) => {
  const id = parseInt(req.params.id);
  const index = parseInt(req.params.index);
  const pedido = pedidos.find(p => p.id === id);

  if (!pedido) return res.status(404).send("No encontrado");
  if (index < 0 || index >= pedido.productos.length) return res.status(400).send("Índice inválido");

  if (!pedido.productosEntregados) pedido.productosEntregados = [];
  if (!pedido.productosEntregados.includes(index)) {
    pedido.productosEntregados.push(index);
  }

  await guardarPedido(pedido);
  io.emit("productoEntregado", { pedidoId: id, index });

  // Si todos los productos están entregados, marcar pedido como Entregado
  if (pedido.productosEntregados.length >= pedido.productos.length) {
    pedido.estado = "Entregado";
    pedido.horaEntrega = horaMXAhora();
    pedido.entregadoEn = Date.now();
    await guardarPedido(pedido);
    io.emit("pedidoEliminado", id);
  }

  res.json({ ok: true });
});

app.post("/pedido/entregado/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const pedido = pedidos.find(p => p.id === id);

  if (pedido) {
    pedido.estado = "Entregado";
    pedido.horaEntrega = horaMXAhora();
    pedido.entregadoEn = Date.now();
    await guardarPedido(pedido);
    io.emit("pedidoEliminado", id);
  }

  res.sendStatus(200);
});

// Regresar producto individual a cocina (quitar de productosEntregados)
app.post("/pedido/:id/producto/:index/regresar", async (req, res) => {
  const id = parseInt(req.params.id);
  const index = parseInt(req.params.index);
  const pedido = pedidos.find(p => p.id === id);

  if (!pedido) return res.status(404).send("No encontrado");
  if (!pedido.productosEntregados) return res.status(400).send("Sin productos entregados");

  const idx = pedido.productosEntregados.indexOf(index);
  if (idx >= 0) {
    pedido.productosEntregados.splice(idx, 1);
    // Si estaba entregado, regresar a pendiente
    if (pedido.estado === "Entregado") {
      pedido.estado = "pendiente";
      delete pedido.horaEntrega;
      delete pedido.entregadoEn;
    }
    await guardarPedido(pedido);
    io.emit("productoRegresado", { pedidoId: id, index });
  }

  res.json({ ok: true });
});

// Regresar pedido entregado a entrega (pendiente)
app.post("/pedido/:id/regresar", async (req, res) => {
  const id = parseInt(req.params.id);
  const pedido = pedidos.find(p => p.id === id);

  if (!pedido) return res.status(404).send("No encontrado");

  pedido.estado = "pendiente";
  delete pedido.horaEntrega;
  delete pedido.entregadoEn;
  await guardarPedido(pedido);
  io.emit("pedidoRegresado", pedido);

  res.json({ ok: true });
});

// Helpers de fechas para filtros
function parseFechaMX(fechaStr) {
  // Formato dd/mm/yyyy
  const [d, m, y] = fechaStr.split("/");
  return new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
}

function fechaMXAhora() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
}

app.get("/ventas/semanal", soloAdmin, async (req, res) => {
  const ahora = fechaMXAhora();
  const hace7dias = new Date(ahora);
  hace7dias.setDate(hace7dias.getDate() - 6);
  hace7dias.setHours(0, 0, 0, 0);

  let entregados;

  if (db) {
    try {
      const fechasValidas = [];
      for (let d = new Date(hace7dias); d <= ahora; d.setDate(d.getDate() + 1)) {
        const dd = d.getDate().toString().padStart(2, "0");
        const mm = (d.getMonth() + 1).toString().padStart(2, "0");
        const yyyy = d.getFullYear();
        fechasValidas.push(dd + "/" + mm + "/" + yyyy);
      }
      entregados = await db.collection("pedidos").find({ estado: "Entregado", fecha: { $in: fechasValidas } }).toArray();
      entregados.forEach(p => delete p._id);
    } catch (e) {
      console.error("Error query semanal MongoDB:", e.message);
      entregados = null;
    }
  }

  if (!entregados) {
    entregados = pedidos.filter(p => {
      if (p.estado !== "Entregado" || !p.fecha) return false;
      return parseFechaMX(p.fecha) >= hace7dias;
    });
  }

  const total = entregados.reduce((acc, p) => acc + p.total, 0);

  const porDia = {};
  entregados.forEach(p => {
    if (!porDia[p.fecha]) porDia[p.fecha] = { pedidos: [], total: 0 };
    porDia[p.fecha].pedidos.push(p);
    porDia[p.fecha].total += p.total;
  });

  const totalEfectivo = entregados.filter(p => p.metodoPago !== "tarjeta").reduce((acc, p) => acc + p.total, 0);
  const totalTarjeta = entregados.filter(p => p.metodoPago === "tarjeta").reduce((acc, p) => acc + p.total, 0);

  // Comparativo: semana anterior
  const hace14dias = new Date(ahora);
  hace14dias.setDate(hace14dias.getDate() - 13);
  hace14dias.setHours(0, 0, 0, 0);
  const entregadosAnt = pedidos.filter(p => {
    if (p.estado !== "Entregado" || !p.fecha) return false;
    const f = parseFechaMX(p.fecha);
    return f >= hace14dias && f < hace7dias;
  });
  const totalAnterior = entregadosAnt.reduce((acc, p) => acc + p.total, 0);

  res.json({ pedidos: entregados, total, porDia, totalEfectivo, totalTarjeta, totalAnterior });
});

app.get("/ventas/mensual", soloAdmin, async (req, res) => {
  const ahora = fechaMXAhora();
  const mesActual = (ahora.getMonth() + 1).toString().padStart(2, "0");
  const anioActual = ahora.getFullYear().toString();

  let entregados;

  if (db) {
    try {
      entregados = await db.collection("pedidos").find({ estado: "Entregado", fecha: { $regex: "\\/" + mesActual + "\\/" + anioActual + "$" } }).toArray();
      entregados.forEach(p => delete p._id);
    } catch (e) {
      console.error("Error query mensual MongoDB:", e.message);
      entregados = null;
    }
  }

  if (!entregados) {
    entregados = pedidos.filter(p => {
      if (p.estado !== "Entregado" || !p.fecha) return false;
      const partes = p.fecha.split("/");
      return partes[1] === mesActual && partes[2] === anioActual;
    });
  }

  const total = entregados.reduce((acc, p) => acc + p.total, 0);

  const porDia = {};
  entregados.forEach(p => {
    if (!porDia[p.fecha]) porDia[p.fecha] = { pedidos: [], total: 0 };
    porDia[p.fecha].pedidos.push(p);
    porDia[p.fecha].total += p.total;
  });

  const totalEfectivo = entregados.filter(p => p.metodoPago !== "tarjeta").reduce((acc, p) => acc + p.total, 0);
  const totalTarjeta = entregados.filter(p => p.metodoPago === "tarjeta").reduce((acc, p) => acc + p.total, 0);

  // Comparativo: mes anterior
  let mesAnt = parseInt(mesActual) - 1;
  let anioAnt = parseInt(anioActual);
  if (mesAnt === 0) { mesAnt = 12; anioAnt--; }
  const mesAntStr = mesAnt.toString().padStart(2, "0");
  const anioAntStr = anioAnt.toString();
  const entregadosAnt = pedidos.filter(p => {
    if (p.estado !== "Entregado" || !p.fecha) return false;
    const partes = p.fecha.split("/");
    return partes[1] === mesAntStr && partes[2] === anioAntStr;
  });
  const totalAnterior = entregadosAnt.reduce((acc, p) => acc + p.total, 0);

  res.json({ pedidos: entregados, total, porDia, totalEfectivo, totalTarjeta, totalAnterior });
});

// Historial de eliminados
app.get("/ventas/eliminados/:fecha", soloAdmin, (req, res) => {
  const elim = pedidosEliminados.filter(p => p.fecha === req.params.fecha);
  res.json(elim);
});

// Gastos
app.post("/gasto", soloAdmin, async (req, res) => {
  const { concepto, monto } = req.body;
  if (!concepto || !monto) return res.status(400).json({ error: "Faltan datos" });
  const ahora = fechaMXAhora();
  const gasto = {
    id: gastoIdCounter++,
    concepto,
    monto: parseFloat(monto),
    fecha: ahora.toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric" }),
    hora: ahora.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })
  };
  gastos.push(gasto);
  if (db) {
    try { await db.collection("gastos").insertOne({ ...gasto }); } catch(e) {}
  }
  res.json(gasto);
});

app.get("/gastos/:fecha", soloAdmin, (req, res) => {
  const del_dia = gastos.filter(g => g.fecha === req.params.fecha);
  const totalGastos = del_dia.reduce((acc, g) => acc + g.monto, 0);
  res.json({ gastos: del_dia, totalGastos });
});

app.delete("/gasto/:id", soloAdmin, async (req, res) => {
  if (req.body.password !== PASS_ELIMINAR) {
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }
  const id = parseInt(req.params.id);
  const idx = gastos.findIndex(g => g.id === id);
  if (idx === -1) return res.status(404).send("No encontrado");
  gastos.splice(idx, 1);
  if (db) {
    try { await db.collection("gastos").deleteOne({ id }); } catch(e) {}
  }
  res.json({ ok: true });
});

// Fondo de caja
app.post("/fondo-caja", soloAdmin, async (req, res) => {
  const { monto } = req.body;
  if (monto === undefined) return res.status(400).json({ error: "Falta monto" });
  const ahora = fechaMXAhora();
  const fecha = ahora.toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric" });
  const idx = fondosCaja.findIndex(f => f.fecha === fecha);
  if (idx >= 0) {
    fondosCaja[idx].monto = parseFloat(monto);
    if (db) { try { await db.collection("fondos_caja").updateOne({ fecha }, { $set: { monto: parseFloat(monto) } }); } catch(e) {} }
  } else {
    const fondo = { fecha, monto: parseFloat(monto) };
    fondosCaja.push(fondo);
    if (db) { try { await db.collection("fondos_caja").insertOne({ ...fondo }); } catch(e) {} }
  }
  res.json({ ok: true });
});

app.get("/fondo-caja/:fecha", soloAdmin, (req, res) => {
  const fondo = fondosCaja.find(f => f.fecha === req.params.fecha);
  res.json({ monto: fondo ? fondo.monto : 0 });
});

// Retiros de dinero
app.post("/retiro", soloAdmin, async (req, res) => {
  const { concepto, monto } = req.body;
  if (!monto) return res.status(400).json({ error: "Falta monto" });
  const ahora = fechaMXAhora();
  const retiro = {
    id: retiroIdCounter++,
    concepto: concepto || "Retiro",
    monto: parseFloat(monto),
    fecha: ahora.toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric" }),
    hora: ahora.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })
  };
  retiros.push(retiro);
  if (db) { try { await db.collection("retiros").insertOne({ ...retiro }); } catch(e) {} }
  res.json(retiro);
});

app.get("/retiros/:fecha", soloAdmin, (req, res) => {
  const del_dia = retiros.filter(r => r.fecha === req.params.fecha);
  const totalRetiros = del_dia.reduce((acc, r) => acc + r.monto, 0);
  res.json({ retiros: del_dia, totalRetiros });
});

app.delete("/retiro/:id", soloAdmin, async (req, res) => {
  if (req.body.password !== PASS_ELIMINAR) {
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }
  const id = parseInt(req.params.id);
  const idx = retiros.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).send("No encontrado");
  retiros.splice(idx, 1);
  if (db) { try { await db.collection("retiros").deleteOne({ id }); } catch(e) {} }
  res.json({ ok: true });
});

// Ventas tarjeta manuales
app.post("/venta-tarjeta", soloAdmin, async (req, res) => {
  const { concepto, monto } = req.body;
  if (!monto) return res.status(400).json({ error: "Falta monto" });
  const ahora = fechaMXAhora();
  const venta = {
    id: ventaTarjetaIdCounter++,
    concepto: concepto || "Tarjeta",
    monto: parseFloat(monto),
    fecha: ahora.toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric" }),
    hora: ahora.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })
  };
  ventasTarjeta.push(venta);
  if (db) { try { await db.collection("ventas_tarjeta").insertOne({ ...venta }); } catch(e) {} }
  res.json(venta);
});

app.get("/ventas-tarjeta/:fecha", soloAdmin, (req, res) => {
  const del_dia = ventasTarjeta.filter(v => v.fecha === req.params.fecha);
  const totalVentasTarjeta = del_dia.reduce((acc, v) => acc + v.monto, 0);
  res.json({ ventas: del_dia, totalVentasTarjeta });
});

app.delete("/venta-tarjeta/:id", soloAdmin, async (req, res) => {
  if (req.body.password !== PASS_ELIMINAR) {
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }
  const id = parseInt(req.params.id);
  const idx = ventasTarjeta.findIndex(v => v.id === id);
  if (idx === -1) return res.status(404).send("No encontrado");
  ventasTarjeta.splice(idx, 1);
  if (db) { try { await db.collection("ventas_tarjeta").deleteOne({ id }); } catch(e) {} }
  res.json({ ok: true });
});

// Exportar corte de caja como CSV (Excel)
app.get("/corte/exportar/:fecha", soloAdminOExport, (req, res) => {
  const fecha = req.params.fecha;
  const entregados = pedidos.filter(p => p.estado === "Entregado" && p.fecha === fecha);
  const totalVentas = entregados.reduce((a, p) => a + p.total, 0);
  const totalEfectivo = entregados.filter(p => p.metodoPago !== "tarjeta").reduce((a, p) => a + p.total, 0);
  const totalTarjeta = entregados.filter(p => p.metodoPago === "tarjeta").reduce((a, p) => a + p.total, 0);
  const vtManual = ventasTarjeta.filter(v => v.fecha === fecha);
  const totalTarjetaManual = vtManual.reduce((a, v) => a + v.monto, 0);
  const totalVentasFinal = totalVentas + totalTarjetaManual;
  const gastosDelDia = gastos.filter(g => g.fecha === fecha);
  const totalGastos = gastosDelDia.reduce((a, g) => a + g.monto, 0);
  const retirosDelDia = retiros.filter(r => r.fecha === fecha);
  const totalRetiros = retirosDelDia.reduce((a, r) => a + r.monto, 0);
  const fondo = fondosCaja.find(f => f.fecha === fecha);
  const fondoCaja = fondo ? fondo.monto : 0;
  const utilidad = totalVentasFinal - totalGastos + totalRetiros;
  const efectivoEnCaja = fondoCaja + totalEfectivo - totalGastos - totalRetiros;
  const eliminados = pedidosEliminados.filter(p => p.fecha === fecha);
  const totalElim = eliminados.reduce((a, p) => a + (p.total || 0), 0);

  let csv = "\uFEFF";
  csv += "CORTE DE CAJA - " + fecha + "\r\n\r\n";
  csv += "CONCEPTO,MONTO\r\n";
  csv += "Fondo de Caja,$" + fondoCaja + "\r\n\r\n";
  csv += "VENTAS\r\n";
  csv += "Total Ventas,$" + totalVentasFinal + "\r\n";
  csv += "Efectivo,$" + totalEfectivo + "\r\n";
  csv += "Tarjeta (sistema),$" + totalTarjeta + "\r\n";
  csv += "Tarjeta (manual),$" + totalTarjetaManual + "\r\n";
  csv += "Total Tarjeta,$" + (totalTarjeta + totalTarjetaManual) + "\r\n";
  csv += "Pedidos," + entregados.length + "\r\n\r\n";
  csv += "GASTOS\r\n";
  if (gastosDelDia.length > 0) {
    gastosDelDia.forEach(g => { csv += g.concepto + ",-$" + g.monto + "\r\n"; });
  }
  csv += "Total Gastos,-$" + totalGastos + "\r\n\r\n";
  csv += "RETIROS\r\n";
  if (retirosDelDia.length > 0) {
    retirosDelDia.forEach(r => { csv += r.concepto + ",-$" + r.monto + "\r\n"; });
  }
  csv += "Total Retiros,-$" + totalRetiros + "\r\n\r\n";
  csv += "RESUMEN\r\n";
  csv += "Utilidad Neta,$" + utilidad + "\r\n";
  csv += "Efectivo en Caja,$" + efectivoEnCaja + "\r\n";
  csv += "Efectivo en Caja,$" + efectivoEnCaja + "\r\n\r\n";
  if (eliminados.length > 0) {
    csv += "PEDIDOS ELIMINADOS\r\n";
    eliminados.forEach(p => {
      const prods = p.productos ? p.productos.map(pr => pr.nombre).join(" + ") : "";
      csv += (p.cliente || "Sin nombre") + "," + prods + ",$" + (p.total || 0) + "\r\n";
    });
    csv += "Total Eliminado,,$" + totalElim + "\r\n";
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=corte-" + fecha.replace(/\//g, "-") + ".csv");
  res.send(csv);
});

app.get("/ventas/exportar/:tipo", soloAdminOExport, (req, res) => {
  const tipo = req.params.tipo;
  let entregados = [];

  if (tipo === "dia") {
    const fecha = req.query.fecha;
    if (!fecha) return res.status(400).send("Falta parámetro fecha");
    entregados = pedidos.filter(p => p.estado === "Entregado" && p.fecha === fecha);
  } else if (tipo === "semana") {
    const ahora = fechaMXAhora();
    const hace7dias = new Date(ahora);
    hace7dias.setDate(hace7dias.getDate() - 6);
    hace7dias.setHours(0, 0, 0, 0);
    entregados = pedidos.filter(p => {
      if (p.estado !== "Entregado" || !p.fecha) return false;
      return parseFechaMX(p.fecha) >= hace7dias;
    });
  } else if (tipo === "mes") {
    const ahora = fechaMXAhora();
    const mesActual = (ahora.getMonth() + 1).toString().padStart(2, "0");
    const anioActual = ahora.getFullYear().toString();
    entregados = pedidos.filter(p => {
      if (p.estado !== "Entregado" || !p.fecha) return false;
      const partes = p.fecha.split("/");
      return partes[1] === mesActual && partes[2] === anioActual;
    });
  } else {
    return res.status(400).send("Tipo inválido");
  }

  // Generar CSV
  const lineas = ["Fecha,Hora,Cliente,Productos,Nota,Total"];
  entregados.forEach(p => {
    const prods = p.productos.map(pr => {
      let txt = pr.nombre;
      if (pr.cantidad > 1) txt = pr.cantidad + "x " + txt;
      if (pr.nota) txt += " (" + pr.nota + ")";
      return txt;
    }).join(" | ");
    const nota = (p.nota || "").replace(/"/g, '""');
    const cliente = (p.cliente || "").replace(/"/g, '""');
    const prodsEsc = prods.replace(/"/g, '""');
    lineas.push(`"${p.fecha}","${p.horaEntrega || ""}","${cliente}","${prodsEsc}","${nota}","$${p.total}"`);
  });

  const totalGeneral = entregados.reduce((acc, p) => acc + p.total, 0);
  lineas.push(`"","","","","TOTAL","$${totalGeneral}"`);

  const csv = "\uFEFF" + lineas.join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="ventas-${tipo}.csv"`);
  res.send(csv);
});

const PORT = process.env.PORT || 3000;

// Iniciar servidor después de conectar a MongoDB
conectarDB().then(() => cargarPedidos()).then(() => {
  server.listen(PORT, () => {
    console.log("Servidor corriendo en puerto " + PORT);
  });
});
