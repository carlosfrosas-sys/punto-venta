require("dotenv").config();
const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { Server } = require("socket.io");
const { MongoClient } = require("mongodb");
const QRCode = require("qrcode");
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

// Los referidos empezaron de cero en esta fecha: lo que alguien pidió o el
// cupón de referido que usó antes no cuenta, así quien ya era cliente puede
// estrenar el programa con el cupón que le pase un conocido.
const INICIO_REFERIDOS = new Date("2026-10-27T14:00:00-06:00");

// Revisa si un teléfono puede usar un cupón de referido. La usan el aviso
// de la página del cliente (en cuanto escribe su número) y el cobro, así
// las dos dicen lo mismo y no hay sorpresas al pagar.
// Sin teléfono solo puede decir si el link sirve.
async function revisarReferido(codigo, telefono, dispositivo) {
  if (!db) return { existe: false };

  const ref = await db.collection("referidos").findOne({ codigo: String(codigo || "").toUpperCase() });
  if (!ref) return { existe: false };
  if (ref.usado) return { existe: true, ok: false, error: "Este link de referido ya fue usado" };

  const enviado = ref.enviado === true;

  // El celular donde se le dio el cupón no lo puede usar, aunque escriban
  // otro número: así no se lo aplica uno mismo inventando un teléfono
  if (dispositivo && Array.isArray(ref.dispositivos) && ref.dispositivos.includes(dispositivo)) {
    return { existe: true, ok: false, enviado, error: "Este cupón es para que lo compartas, no para usarlo tú" };
  }

  if (!telefono) return { existe: true, ok: true, enviado };

  // creadoPor es el teléfono de quien lo generó; en los cupones viejos
  // ese dato vive en origen
  if ((ref.creadoPor || ref.origen) === telefono) {
    return { existe: true, ok: false, enviado, error: "Este cupón es para que lo compartas, no para usarlo tú" };
  }

  // Los cupones entre clientes son para traer gente nueva; los que manda
  // el negocio sí son para quien ya es cliente
  if (!enviado && await yaEsCliente(telefono)) {
    return { existe: true, ok: false, enviado, error: "Este cupón es solo para clientes nuevos" };
  }

  if (!enviado) {
    const yaUso = await db.collection("referidos_usados").findOne({ telefono, fecha: { $gte: INICIO_REFERIDOS } });
    if (yaUso) {
      return { existe: true, ok: false, enviado, error: "Ya usaste un cupón de referido anteriormente" };
    }
  }

  return { existe: true, ok: true, enviado };
}

// Un teléfono ya es cliente si pidió en línea desde que empezaron los
// referidos: o tiene su cupón para compartir, o aparece en un pedido
// ("Nombre (Tel: 5512345678)")
async function yaEsCliente(telefono) {
  // Un teléfono mal escrito no se puede revisar: se trata como cliente
  if (!/^\d{10}$/.test(String(telefono || ""))) return true;
  const desde = INICIO_REFERIDOS.getTime();
  if (pedidos.some(p => typeof p.cliente === "string" && p.cliente.includes("(Tel: " + telefono + ")") && (p.creadoEn || 0) >= desde)) return true;
  if (await db.collection("referidos").findOne({ creadoPor: telefono, fecha: { $gte: INICIO_REFERIDOS } })) return true;
  return !!(await db.collection("pedidos").findOne({ cliente: { $regex: "\\(Tel: " + telefono + "\\)" }, creadoEn: { $gte: desde } }));
}

// Identificador que la página del cliente guarda en su celular. Llega del
// navegador, así que se limpia antes de guardarlo.
function limpiarDispositivo(valor) {
  return typeof valor === "string" ? valor.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64) : "";
}

// Cupón que el cliente puede pasarle a sus conocidos. Cada teléfono tiene
// uno solo a la vez: si el que tiene no se ha usado se le vuelve a dar el
// mismo, y cuando alguien lo usa se le hace otro en su siguiente pedido.
// Queda a nombre de su teléfono para que no se lo aplique a sí mismo.
async function cuponParaCompartir(telefono, dispositivo) {
  if (!db || !telefono) return null;
  try {
    const activo = await db.collection("referidos").findOne({ creadoPor: telefono, usado: false });
    if (activo) {
      if (dispositivo) {
        await db.collection("referidos").updateOne({ codigo: activo.codigo }, { $addToSet: { dispositivos: dispositivo } });
      }
      return activo.codigo;
    }

    let nuevo = generarCodigoReferido();
    while (await db.collection("referidos").findOne({ codigo: nuevo })) {
      nuevo = generarCodigoReferido();
    }
    await db.collection("referidos").insertOne({
      codigo: nuevo,
      origen: telefono,
      creadoPor: telefono,
      dispositivos: dispositivo ? [dispositivo] : [],
      usado: false,
      fecha: new Date()
    });
    return nuevo;
  } catch (e) {
    console.error("Error creando cupón para compartir:", e.message);
    return null;
  }
}

// Marca el cupón de referido como usado y devuelve el que el cliente
// podrá compartir
async function canjearReferido(cuponUpper, telefono, enviadoPorNegocio, dispositivo) {
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
  } catch (e) {
    console.error("Error canjeando referido:", e.message);
  }
  return cuponParaCompartir(telefono, dispositivo);
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

// El respaldo en disco es la red por si MongoDB no responde, y el disco de
// Render se borra en cada deploy. Guardar el historial completo cada cinco
// minutos iba a ir pesando más y más, así que solo se respaldan los últimos
// días: es lo que haría falta recuperar a mano. El historial vive en Mongo.
const DIAS_RESPALDO = 15;

function pedidosRecientes() {
  const limite = Date.now() - DIAS_RESPALDO * 24 * 60 * 60 * 1000;
  return pedidos.filter(p => {
    if (p.creadoEn) return p.creadoEn >= limite;
    if (!p.fecha) return true;
    const f = parseFechaMX(p.fecha);
    return isNaN(f) ? true : f.getTime() >= limite;
  });
}

function respaldarDatos() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
    fs.writeFileSync(BACKUP_PATH, JSON.stringify(pedidosRecientes()));
    fs.writeFileSync(BACKUP_GASTOS_PATH, JSON.stringify(gastos));
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

    await crearIndices();

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

// Los pedidos en línea de antes no guardaban método de pago, así que el
// corte los contaba como efectivo y esperaba dinero que nunca estuvo en el
// cajón. Se cobran por Mercado Pago, o sea tarjeta.
async function marcarEnLineaComoTarjeta() {
  const viejos = pedidos.filter(p => p.origen === "cliente" && !p.metodoPago);
  if (viejos.length === 0) return;

  viejos.forEach(p => { p.metodoPago = "tarjeta"; });

  if (db) {
    try {
      await db.collection("pedidos").updateMany(
        { origen: "cliente", metodoPago: { $exists: false } },
        { $set: { metodoPago: "tarjeta" } }
      );
    } catch (e) { console.error("Error marcando pedidos en línea:", e.message); }
  }

  console.log("Pedidos en línea marcados como tarjeta:", viejos.length);
}

// ---- Qué vive en memoria y qué se le pregunta a MongoDB ----
// En memoria van los últimos días más todo lo que esté sin entregar: es lo
// que usan cocina, barra, entrega y la caja. Los reportes preguntan a la
// base, así que el historial completo nunca se carga de golpe y el arranque
// no se va haciendo más lento con los años.
const DIAS_EN_MEMORIA = 90;

// Las fechas se guardan como "dd/mm/yyyy", que no se puede comparar por
// rango, así que se arma la lista de días y se busca por coincidencia.
function fechasDeLosUltimos(dias) {
  const lista = [];
  const d = fechaMXAhora();
  for (let i = 0; i < dias; i++) {
    lista.push(d.toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric" }));
    d.setDate(d.getDate() - 1);
  }
  return lista;
}

// Los extremos se llevan a medianoche: si no, la hora del día recorta el
// rango y el último día se queda fuera.
function fechasEntre(desde, hasta) {
  const d = new Date(desde);
  d.setHours(0, 0, 0, 0);
  const fin = new Date(hasta);
  fin.setHours(0, 0, 0, 0);

  const lista = [];
  while (d <= fin) {
    lista.push(d.toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric" }));
    d.setDate(d.getDate() + 1);
  }
  return lista;
}

// Busca en la base; si no hay base, en lo que haya en memoria
async function consultarPedidos(filtroMongo, filtroMemoria, proyeccion) {
  if (db) {
    try {
      const cursor = db.collection("pedidos").find(filtroMongo);
      if (proyeccion) cursor.project(proyeccion);
      const docs = await cursor.toArray();
      docs.forEach(d => delete d._id);
      return docs;
    } catch (e) {
      console.error("Error consultando pedidos:", e.message);
    }
  }
  return pedidos.filter(filtroMemoria);
}

function entregadosDe(fecha) {
  return consultarPedidos(
    { estado: "Entregado", fecha },
    p => p.estado === "Entregado" && p.fecha === fecha
  );
}

function entregadosEnFechas(fechas) {
  return consultarPedidos(
    { estado: "Entregado", fecha: { $in: fechas } },
    p => p.estado === "Entregado" && fechas.indexOf(p.fecha) !== -1
  );
}

// Un pedido que ya no está en memoria por viejo: se busca en la base
async function buscarPedidoPorId(id) {
  const enMemoria = pedidos.find(p => p.id === id);
  if (enMemoria) return enMemoria;

  if (db) {
    try {
      const doc = await db.collection("pedidos").findOne({ id });
      if (doc) { delete doc._id; return doc; }
    } catch (e) { console.error("Error buscando pedido:", e.message); }
  }
  return null;
}

// Sin índices, cada búsqueda recorre toda la colección. Hoy no se nota;
// con un año de ventas encima sí. Crearlos es idempotente: si ya están,
// MongoDB no hace nada.
async function crearIndices() {
  const indices = [
    ["pedidos", { id: 1 }],
    ["pedidos", { estado: 1, fecha: 1 }],
    ["pedidos", { origen: 1, fecha: 1 }],
    ["pedidos", { codigo: 1 }],
    ["pedidos", { cliente: 1 }],
    ["pedidos_pendientes", { ref: 1 }],
    ["pedidos_eliminados", { fecha: 1 }],
    ["referidos", { codigo: 1 }],
    ["referidos", { creadoPor: 1, usado: 1 }],
    ["cupones_kiosko", { codigo: 1 }],
    ["referidos_usados", { telefono: 1 }],
    ["cupones_usados", { codigo: 1 }],
    ["escaneos_qr", { fecha: 1 }],
    ["gastos", { fecha: 1 }],
    ["retiros", { fecha: 1 }],
    ["ventas_tarjeta", { fecha: 1 }],
    ["fondos_caja", { fecha: 1 }],
    ["trabajadores", { id: 1 }],
    ["deudores", { id: 1 }]
  ];

  for (const [coleccion, llave] of indices) {
    try {
      await db.collection(coleccion).createIndex(llave);
    } catch (e) {
      console.error("Error creando índice en " + coleccion + ":", e.message);
    }
  }
  console.log("Índices de MongoDB listos");
}

async function cargarPedidos() {
  if (db) {
    try {
      // Los últimos días más todo lo que esté sin entregar, sin importar
      // de cuándo sea: un pedido activo nunca se puede quedar fuera
      const recientes = fechasDeLosUltimos(DIAS_EN_MEMORIA);
      pedidos = await db.collection("pedidos").find({
        $or: [
          { fecha: { $in: recientes } },
          { estado: { $in: ["pendiente", "Listo"] } }
        ]
      }).toArray();
      pedidos.forEach(p => delete p._id);

      // El id sigue del último de todos, no del último que se cargó
      const ultimo = await db.collection("pedidos").find().sort({ id: -1 }).limit(1).toArray();
      idCounter = ultimo.length > 0 ? ultimo[0].id + 1 : 1;

      console.log("Pedidos en memoria:", pedidos.length, "(últimos " + DIAS_EN_MEMORIA + " días y los activos)");
      await marcarEnLineaComoTarjeta();
    } catch (e) {
      console.error("Error cargando pedidos:", e.message);
    }
    try {
      const recientes = fechasDeLosUltimos(DIAS_EN_MEMORIA);
      pedidosEliminados = await db.collection("pedidos_eliminados").find({ fecha: { $in: recientes } }).toArray();
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
        fichas.forEach(f => { delete f._id; normalizarFicha(tipo, f); });
        if (fichas.length > 0) {
          cuentas[tipo] = fichas;
          contadorCuenta[tipo] = Math.max(...fichas.map(f => f.id)) + 1;
        }
      } catch(e) {}
    }
    try {
      const doc = await db.collection("config").findOne({ _id: "kiosko" });
      if (doc && typeof doc.activo === "boolean") kioskoActivo = doc.activo;
    } catch(e) {}
    try {
      const doc = await db.collection("config").findOne({ _id: "agotados" });
      if (doc && Array.isArray(doc.lista)) {
        agotados = doc.lista;
        console.log("Agotados cargados:", agotados.length);
      }
    } catch(e) {}
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
  try {
    if (fs.existsSync(BACKUP_KIOSKO_PATH)) {
      const guardado = JSON.parse(fs.readFileSync(BACKUP_KIOSKO_PATH, "utf8"));
      if (typeof guardado.activo === "boolean") kioskoActivo = guardado.activo;
    }
  } catch(e) {}
  for (const tipo of ["trabajadores", "deudores"]) {
    try {
      const ruta = rutaBackupCuenta(tipo);
      if (cuentas[tipo].length === 0 && fs.existsSync(ruta)) {
        cuentas[tipo] = JSON.parse(fs.readFileSync(ruta, "utf8"));
        cuentas[tipo].forEach(f => normalizarFicha(tipo, f));
        if (cuentas[tipo].length > 0) {
          contadorCuenta[tipo] = Math.max(...cuentas[tipo].map(f => f.id)) + 1;
        }
      }
    } catch(e) { console.error("Error cargando " + tipo + ":", e.message); }
  }
  cargarPreciosBackup();
}

// Los agotados viven en MongoDB: el disco de Render se borra en cada
// deploy, y antes la lista se perdía hasta que alguien abría caja.
function guardarAgotados() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
    fs.writeFileSync(BACKUP_AGOTADOS_PATH, JSON.stringify(agotados, null, 2));
  } catch(e) { console.error("Error guardando agotados:", e.message); }

  if (db) {
    db.collection("config").updateOne(
      { _id: "agotados" },
      { $set: { lista: agotados, actualizado: new Date() } },
      { upsert: true }
    ).catch(e => console.error("Error guardando agotados en MongoDB:", e.message));
  }
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
  // creadoEn sirve para el barrido que recupera pagos sin pedido
  const conFecha = { creadoEn: Date.now(), ...datos };
  pedidosPendientes.set(ref, conFecha);
  if (db) {
    try {
      await db.collection("pedidos_pendientes").updateOne(
        { ref },
        { $set: { ref, ...conFecha } },
        { upsert: true }
      );
    } catch (e) {
      console.error("Error guardando pedido pendiente:", e.message);
    }
  }
}

// Todos los pendientes, de la base si hay y si no de memoria
async function listarPedidosPendientes() {
  if (db) {
    try {
      const docs = await db.collection("pedidos_pendientes").find().toArray();
      return docs.map(d => {
        const { _id, ...resto } = d;
        return resto;
      });
    } catch (e) {
      console.error("Error listando pedidos pendientes:", e.message);
    }
  }
  return [...pedidosPendientes.entries()].map(([ref, datos]) => ({ ref, ...datos }));
}

// Los refs viejos no traen creadoEn, pero lo llevan en el nombre:
// "pedido_1757000000000_ab12cd"
function cuandoSeCreo(pendiente) {
  if (pendiente.creadoEn) return pendiente.creadoEn;
  const m = String(pendiente.ref || "").match(/^pedido_(\d{13})_/);
  return m ? parseInt(m[1], 10) : 0;
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

// ---- Interruptor del kiosko ----
// Se apaga desde caja cuando no hay quien atienda la terminal o se cierra
// antes. Queda guardado para que un reinicio no lo vuelva a encender solo.
let kioskoActivo = true;
const BACKUP_KIOSKO_PATH = path.join(BACKUP_DIR, "kiosko-backup.json");

function guardarEstadoKiosko() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
    fs.writeFileSync(BACKUP_KIOSKO_PATH, JSON.stringify({ activo: kioskoActivo }));
  } catch (e) { console.error("Error guardando estado del kiosko:", e.message); }

  if (db) {
    db.collection("config").updateOne(
      { _id: "kiosko" },
      { $set: { activo: kioskoActivo, actualizado: new Date() } },
      { upsert: true }
    ).catch(e => console.error("Error guardando kiosko en MongoDB:", e.message));
  }
}

// La pantalla del kiosko lo consulta, así que va sin contraseña
app.get("/kiosko/estado", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ activo: kioskoActivo });
});

function cambiarEstadoKiosko(activo) {
  kioskoActivo = activo;
  guardarEstadoKiosko();
  io.emit("kioskoActivo", kioskoActivo);
}

app.post("/kiosko/estado", soloAdmin, (req, res) => {
  cambiarEstadoKiosko(!!(req.body && req.body.activo));
  res.json({ activo: kioskoActivo });
});

// Horario automático: lunes a viernes se prende a las 7:00 a.m. y se apaga
// a las 9:00 p.m.; el sábado se apaga a la 1:30 p.m. y el domingo no se
// prende (a las 7:00 a.m. se confirma apagado por si alguien lo dejó prendido).
// Solo actúa en esos minutos, así que si caja lo apaga o lo prende a mano
// durante el día, se respeta hasta el siguiente cambio de horario. Si ya
// estaba como debía quedar, no se toca.
const ENTRE_SEMANA_KIOSKO = [
  { minuto: 7 * 60, activo: true },   // 7:00 a.m.
  { minuto: 21 * 60, activo: false }  // 9:00 p.m.
];
const HORARIO_KIOSKO = {
  0: [{ minuto: 7 * 60, activo: false }],  // domingo
  1: ENTRE_SEMANA_KIOSKO,
  2: ENTRE_SEMANA_KIOSKO,
  3: ENTRE_SEMANA_KIOSKO,
  4: ENTRE_SEMANA_KIOSKO,
  5: ENTRE_SEMANA_KIOSKO,
  6: [
    { minuto: 7 * 60, activo: true },          // 7:00 a.m.
    { minuto: 13 * 60 + 30, activo: false }    // 1:30 p.m.
  ]
};
// Margen por si el chequeo se retrasa o el servidor reinicia justo en la hora
const MARGEN_HORARIO_KIOSKO = 5;
let ultimoCambioHorarioKiosko = null;

function revisarHorarioKiosko() {
  const ahora = fechaMXAhora();
  const minutos = ahora.getHours() * 60 + ahora.getMinutes();
  const hoy = ahora.getFullYear() + "-" + (ahora.getMonth() + 1) + "-" + ahora.getDate();
  for (const cambio of HORARIO_KIOSKO[ahora.getDay()]) {
    if (minutos < cambio.minuto || minutos >= cambio.minuto + MARGEN_HORARIO_KIOSKO) continue;
    const clave = hoy + "@" + cambio.minuto;
    if (ultimoCambioHorarioKiosko === clave) return;
    ultimoCambioHorarioKiosko = clave;
    if (kioskoActivo !== cambio.activo) {
      cambiarEstadoKiosko(cambio.activo);
      console.log("Kiosko " + (cambio.activo ? "encendido" : "apagado") + " por horario");
    }
    return;
  }
}
setInterval(revisarHorarioKiosko, 30 * 1000);

// ---- Cupones del kiosko ----
// Cada pedido del kiosko deja un cupón para la próxima visita: lo puede usar
// la misma persona o regalarlo. Como el kiosko no sabe quién pide, no se
// cuida quién lo usa sino cuánto cuesta: un solo uso, vence en 2 días, pide
// compra mínima y un pedido que usó cupón no genera otro.
const CUPON_KIOSKO = { descuento: 10, minimo: 55, horas: 48 };
// Sin MongoDB los cupones viven en memoria
const cuponesKioskoMem = new Map();

async function buscarCuponKiosko(codigo) {
  codigo = String(codigo || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(codigo)) return null;
  if (db) return db.collection("cupones_kiosko").findOne({ codigo });
  return cuponesKioskoMem.get(codigo) || null;
}

async function crearCuponKiosko(pedidoId) {
  let codigo = generarCodigoReferido();
  while (await buscarCuponKiosko(codigo)) codigo = generarCodigoReferido();
  const cupon = {
    codigo,
    descuento: CUPON_KIOSKO.descuento,
    minimo: CUPON_KIOSKO.minimo,
    creado: new Date(),
    vence: new Date(Date.now() + CUPON_KIOSKO.horas * 60 * 60 * 1000),
    pedidoOrigen: pedidoId,
    usado: false
  };
  if (db) await db.collection("cupones_kiosko").insertOne({ ...cupon });
  else cuponesKioskoMem.set(codigo, cupon);
  return cupon;
}

async function revisarCuponKiosko(codigo, total) {
  const cupon = await buscarCuponKiosko(codigo);
  if (!cupon) return { ok: false, error: "Ese cupón no existe" };
  if (cupon.usado) return { ok: false, error: "Ese cupón ya se usó" };
  if (new Date(cupon.vence).getTime() < Date.now()) return { ok: false, error: "Ese cupón ya venció" };
  if (!(Number(total) >= cupon.minimo)) {
    return { ok: false, error: "Este cupón es para compras de $" + cupon.minimo + " o más" };
  }
  return { ok: true, codigo: cupon.codigo, descuento: cupon.descuento, minimo: cupon.minimo, vence: cupon.vence };
}

// Se marca usado solo si nadie lo usó antes (dos kioskos al mismo tiempo)
async function canjearCuponKiosko(codigo, pedidoId) {
  const filtro = { codigo, usado: false };
  const cambio = { usado: true, usadoEn: new Date(), pedidoUso: pedidoId };
  if (db) {
    const r = await db.collection("cupones_kiosko").updateOne(filtro, { $set: cambio });
    return r.modifiedCount === 1;
  }
  const cupon = cuponesKioskoMem.get(codigo);
  if (!cupon || cupon.usado) return false;
  Object.assign(cupon, cambio);
  return true;
}

// Lo que la pantalla final necesita para enseñar el cupón
async function datosCuponKiosko(codigo) {
  const c = await buscarCuponKiosko(codigo);
  return c ? { codigo: c.codigo, descuento: c.descuento, minimo: c.minimo, vence: c.vence } : null;
}

app.get("/kiosko/cupon/:codigo", soloAdmin, async (req, res) => {
  try {
    res.json(await revisarCuponKiosko(req.params.codigo, req.query.total));
  } catch (e) {
    res.status(500).json({ ok: false, error: "No se pudo revisar el cupón" });
  }
});

// La página que abre el QR: solo enseña el cupón para guardarlo o mandarlo
app.get("/cupon-kiosko/:codigo", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const cupon = await buscarCuponKiosko(req.params.codigo).catch(() => null);
  if (!cupon) return res.status(404).json({ error: "no_encontrado" });
  res.json({ codigo: cupon.codigo, descuento: cupon.descuento, minimo: cupon.minimo, vence: cupon.vence, usado: !!cupon.usado });
});

// QR del cupón para la pantalla final del kiosko
app.get("/cupon-kiosko/:codigo/qr.svg", async (req, res) => {
  const cupon = await buscarCuponKiosko(req.params.codigo).catch(() => null);
  if (!cupon) return res.status(404).end();
  // En Render la app va detrás de un proxy: el https real viene en el encabezado
  const base = process.env.BASE_URL || ((req.get("x-forwarded-proto") || req.protocol) + "://" + req.get("host"));
  const url = base + "/cupon.html?c=" + cupon.codigo;
  QRCode.toString(url, { type: "svg", margin: 1 }, (err, svg) => {
    if (err) return res.status(500).end();
    res.type("image/svg+xml").send(svg);
  });
});

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

// Kiosko de autocobro: el cliente arma su pedido y paga con tarjeta en su
// propia terminal. Sin caché, para que la tablet siempre traiga la última
// versión del menú y de la página.
app.get("/kiosko", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(__dirname + "/public/kiosko.html");
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
  const dispositivo = limpiarDispositivo(req.query.dispositivo);
  try {
    const r = await revisarReferido(codigo, /^\d{10}$/.test(tel) ? tel : "", dispositivo);
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
// Lo que manda la página pública se pinta después en cocina, barra, entrega
// y caja como HTML. Se le quitan los caracteres con los que alguien podría
// meter código en esas pantallas (que guardan la contraseña del sistema).
function textoSeguro(valor) {
  return typeof valor === "string" ? valor.replace(/[<>"'`]/g, "").slice(0, 300) : valor;
}

// ---- Revisión de precios de los pedidos en línea ----
// El precio de cada producto lo arma la página del cliente, así que alguien
// con conocimientos podría mandarlo más barato. No se rechaza el pedido (si
// la revisión se equivoca se perdería una venta): se marca para que en
// entrega lo revisen. Se compara contra el precio mínimo que el menú le da a
// ese producto; los extras solo suben el precio, así que nunca cuentan en contra.
const PALABRAS_VACIAS = new Set(["de", "con", "la", "el", "los", "las", "y", "a", "al", "en", "del"]);

function sinAcentosMin(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Cada palabra se corta a su raíz para que "Licuado" y "Licuados" coincidan
function raicesDe(texto) {
  return sinAcentosMin(texto).replace(/[^a-z0-9.\/ ]/g, " ").split(/\s+/)
    .filter(w => w && !PALABRAS_VACIAS.has(w))
    .map(w => w.length > 4 ? w.slice(0, Math.max(4, w.length - 2)) : w);
}

// El menú tal como lo ve el cliente en línea (con el recargo y los precios
// editados), leído del mismo menu.js que usan las pantallas
let referenciaPrecios = { clave: null, hojas: [] };

function hojasDelMenuEnLinea() {
  const clave = JSON.stringify(menuPrecios);
  if (referenciaPrecios.clave === clave) return referenciaPrecios.hojas;

  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "public", "menu.js"), "utf8"), ctx);
  ctx.window.MENU.usarPrecios(menuPrecios);
  const menu = ctx.window.MENU.paraCliente({ notasSandwiches: [] });

  // Cada hoja es algo con precio: req son las palabras que tiene que traer
  // el nombre del producto y cat las de su categoría, que suman si están
  const hojas = [];
  let categoriaActual = "";
  const agregar = (req, cat, precio, extra) => {
    if (typeof precio !== "number" || precio <= 0) return;
    const r = [...new Set(req.flatMap(raicesDe))];
    const c = [...new Set(cat.flatMap(raicesDe))].filter(x => !r.includes(x));
    hojas.push({ req: r, cat: c, precio, categoria: categoriaActual, ...extra });
  };
  function recorrer(nombre, d, catPadre) {
    if (!d || typeof d !== "object") return;
    const cat = [...catPadre, nombre, d.etiqueta].filter(Boolean);
    // El paquete del día se vende como "Economico con ..."
    if (d.economico) agregar(["economico"], [], d.precio);
    if (d.directo || (d.precio && !d.proteinas && !d.items && !d.sabores && !d.subcategorias)) agregar([d.nombre || nombre], catPadre, d.precio);
    if (d.sencillo) agregar([nombre, "sencill"], catPadre, d.sencillo, { sencillo: true });
    if (Array.isArray(d.proteinas)) d.proteinas.forEach(p => typeof p === "object" ? agregar([p.nombre], cat, p.precio) : agregar([p], cat, d.precio));
    if (Array.isArray(d.items)) d.items.forEach(it => {
      agregar([it.nombre], cat, it.precio, it.precio1pza ? { pieza: it.precio1pza } : {});
      if (Array.isArray(it.sabores)) it.sabores.forEach(sb => typeof sb === "object" && agregar([it.nombre, sb.nombre], cat, sb.precio));
      if (it.dobles) agregar([it.nombre], cat, it.dobles.precio);
    });
    if (d.sabores && d.precio) agregar([nombre], catPadre, d.precio);
    if (d.tamaños) Object.keys(d.tamaños).forEach(t => agregar([nombre, t], catPadre, d.tamaños[t]));
    if (d.subcategorias) Object.keys(d.subcategorias).forEach(sub => recorrer(sub, d.subcategorias[sub], cat));
    [].concat(d.hotdogs || [], d.banderillas || []).forEach(h => agregar([h.nombre], cat, h.precio));
  }
  Object.keys(menu).forEach(c => { categoriaActual = c; recorrer(c, menu[c], []); });

  // Una palabra suelta que sale en varias categorías ("Pollo", "Jamón") es
  // ambigua: para esas se pide además el nombre de la categoría
  const categoriasDe = {};
  hojas.forEach(h => h.req.forEach(r => { (categoriasDe[r] = categoriasDe[r] || new Set()).add(h.categoria); }));
  hojas.forEach(h => {
    if (h.req.length === 1 && categoriasDe[h.req[0]].size > 1 && h.cat.length) {
      h.req = h.req.concat(h.cat);
      h.cat = [];
    }
  });

  referenciaPrecios = { clave, hojas };
  return hojas;
}

function coincideRaiz(raicesProducto, r) {
  return raicesProducto.some(w => w === r || (r.length >= 4 && w.length >= 4 && (w.startsWith(r) || r.startsWith(w))));
}

// Precio mínimo que el menú le da a un producto, o null si no se reconoce
// (entonces no se avisa nada)
function precioMinimoDelMenu(nombre, hojas) {
  const n = sinAcentosMin(nombre);
  // El agua natural tiene sus tamaños aparte en la página: no se revisa
  if (/^agua (\d|1\/2)/.test(n)) return null;
  const pieza = /^1pza de /.test(n);
  const rp = raicesDe(n.replace(/^1pza de /, ""));
  let mejor = null, mejorPuntos = -1;
  for (const h of hojas) {
    if (!h.req.length || !h.req.every(r => coincideRaiz(rp, r))) continue;
    const puntos = h.req.length + h.cat.filter(r => coincideRaiz(rp, r)).length;
    if (puntos > mejorPuntos || (puntos === mejorPuntos && h.precio < mejor.precio)) { mejor = h; mejorPuntos = puntos; }
  }
  if (!mejor) return null;
  // "Sencillos" siempre es más barato: si no se reconoció como sencillo, no se adivina
  if (/sencill/.test(n) && !mejor.sencillo) return null;
  return pieza ? (mejor.pieza || Math.round(mejor.precio / 2) + 2) : mejor.precio;
}

// Productos que llegaron más baratos de lo que marca el menú
function revisarPreciosEnLinea(productos) {
  try {
    const hojas = hojasDelMenuEnLinea();
    const alertas = [];
    for (const p of productos) {
      const cantidad = Number(p.cantidad) > 0 ? Number(p.cantidad) : 1;
      const unitario = Number(p.precio) / cantidad;
      const minimo = precioMinimoDelMenu(p.nombre, hojas);
      if (minimo !== null && unitario < minimo - 0.01) {
        alertas.push({ nombre: p.nombre, pagado: Math.round(unitario * 100) / 100, menu: minimo });
      }
    }
    if (alertas.length) console.error("Pedido en línea con precio más bajo que el menú:", JSON.stringify(alertas));
    return alertas;
  } catch (e) {
    console.error("No se pudieron revisar los precios:", e.message);
    return [];
  }
}

function limpiarProfundo(valor, nivel = 0) {
  if (nivel > 5) return undefined;
  if (typeof valor === "string") return textoSeguro(valor);
  if (Array.isArray(valor)) return valor.slice(0, 100).map(v => limpiarProfundo(v, nivel + 1));
  if (valor && typeof valor === "object") {
    const limpio = {};
    for (const k of Object.keys(valor)) limpio[textoSeguro(k)] = limpiarProfundo(valor[k], nivel + 1);
    return limpio;
  }
  return valor;
}

app.post("/crear-preferencia", async (req, res) => {
  const { cupon } = req.body;
  const paraLlevar = !!req.body.paraLlevar;
  const cliente = textoSeguro(req.body.cliente);
  const telefono = textoSeguro(req.body.telefono);
  const nota = textoSeguro(req.body.nota);
  const prods = nombresDeProductos(limpiarProfundo(req.body.productos));
  // El total se saca de los productos y no del que manda el celular: así no
  // se puede pagar menos cambiando solo el total. Para llevar son $10.
  const montoCliente = Number(req.body.total);
  const sumaProductos = Array.isArray(prods)
    ? prods.reduce((acc, p) => acc + (Number(p && p.precio) || 0), 0)
    : 0;
  const monto = Math.round((sumaProductos + (paraLlevar ? 10 : 0)) * 100) / 100;
  if (Math.abs(monto - montoCliente) > 0.01) {
    console.error("Total del pedido en línea no cuadra con sus productos:", montoCliente, "vs", monto);
  }
  const dispositivo = limpiarDispositivo(req.body.dispositivo);

  // El horario se revisa aquí, no solo en la página: así no entra un pedido
  // por una pestaña que quedó abierta desde antes de cerrar.
  const horario = estadoPedidosOnline();
  if (!horario.abierto) {
    return res.status(403).json({ error: horario.mensaje, cerrado: true, horario: horario.horario });
  }

  const preciosValidos = Array.isArray(prods) && prods.every(p => p && isFinite(Number(p.precio)) && Number(p.precio) >= 0);
  if (!cliente || !telefono || !Array.isArray(prods) || prods.length === 0 || !preciosValidos || !(monto > 0) || !isFinite(monto)) {
    return res.status(400).json({ error: "Datos incompletos" });
  }

  const alertaPrecio = revisarPreciosEnLinea(prods);

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
      const r = await revisarReferido(cuponUpper.replace("REF-", ""), telefono, dispositivo);
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
        metodoPago: "tarjeta",
        estado: "pendiente",
        codigo: generarCodigoPedido(),
        creadoEn: Date.now(),
        fecha: fechaHoy(),
        horaEnvio: horaMXAhora()
      };

      if (alertaPrecio && alertaPrecio.length) pedido.alertaPrecio = alertaPrecio;
      pedidos.push(pedido);
      await guardarPedido(pedido);
      if (CUPONES_1USO[cuponUpper]) await marcarCuponUsado(cuponUpper);

      const nuevoCodigoRef = esReferido ? await canjearReferido(cuponUpper, telefono, referidoEnviado, dispositivo) : await cuponParaCompartir(telefono, dispositivo);
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
        metodoPago: "tarjeta",
        estado: "pendiente",
        codigo: generarCodigoPedido(),
        creadoEn: Date.now(),
        fecha: fechaHoy(),
        horaEnvio: horaMXAhora()
      };
      if (alertaPrecio && alertaPrecio.length) pedido.alertaPrecio = alertaPrecio;
      pedidos.push(pedido);
      await guardarPedido(pedido);

      const nuevoCodigoRef2 = esReferido ? await canjearReferido(cuponUpper, telefono, referidoEnviado, dispositivo) : await cuponParaCompartir(telefono, dispositivo);
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
        // Con esto Mercado Pago avisa aunque el cliente cierre la página
        notification_url: BASE_URL + "/webhook-mp",
        back_urls: {
          success: BASE_URL + "/pago-exitoso",
          failure: BASE_URL + "/pago-fallido",
          pending: BASE_URL + "/pago-pendiente"
        },
        auto_return: "approved"
      }
    });

    await guardarPedidoPendiente(ref, { cliente, telefono, productos: prods, total: montoFinal, nota: notaConCupon, paraLlevar: paraLlevar || false, cupon: cuponUpper, esReferido, referidoEnviado, dispositivo, alertaPrecio });

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
// El mismo pago puede llegar por varios lados a la vez: el navegador del
// cliente, el aviso de Mercado Pago y el barrido. Esta llave evita que dos
// de ellos creen el pedido al mismo tiempo.
const confirmacionesEnCurso = new Set();

async function confirmarPagoOnline(external_reference, payment_id, opciones) {
  if (!external_reference) {
    return { ok: false, error: "datos_faltantes" };
  }

  if (confirmacionesEnCurso.has(external_reference)) {
    return { ok: false, error: "confirmacion_en_curso" };
  }
  confirmacionesEnCurso.add(external_reference);

  try {
    return await confirmarPagoOnlineInterno(external_reference, payment_id, opciones || {});
  } finally {
    confirmacionesEnCurso.delete(external_reference);
  }
}

async function confirmarPagoOnlineInterno(external_reference, payment_id, opciones) {
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

  // Si el pedido de este cobro ya entró, no se crea otro
  const folio = paymentData.id ? String(paymentData.id) : "";
  const yaEntro = folio && pedidos.find(p => p.folioPago === folio);
  if (yaEntro) {
    await eliminarPedidoPendiente(external_reference);
    // El cupón para compartir se generó cuando entró; se vuelve a dar porque
    // muchas veces el aviso de Mercado Pago gana y quien llega aquí es la
    // página del cliente, que es la que se lo tiene que enseñar
    return { ok: true, pedidoId: yaEntro.id, codigo: yaEntro.codigo, nuevoRef: yaEntro.nuevoRef || null, repetido: true };
  }

  const pendiente = await obtenerPedidoPendiente(external_reference);
  if (!pendiente) {
    return { ok: false, error: "pedido_pendiente_no_encontrado" };
  }

  const notaFinal = pendiente.nota
    ? "[PAGO ONLINE] " + pendiente.nota
    : "[PAGO ONLINE]";

  // Al registrar un pago atorado el pedido se anota en el día en que el
  // cliente pagó, no en el que se descubrió, para que el corte cuadre
  const cuando = opciones.comoVenta ? (cuandoSeCreo(pendiente) || Date.now()) : Date.now();
  const fechaPedido = new Date(cuando).toLocaleDateString("es-MX", { timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit" });
  const horaPedido = new Date(cuando).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" });

  const pedido = {
    id: idCounter++,
    cliente: pendiente.cliente + " (Tel: " + pendiente.telefono + ")",
    productos: pendiente.productos,
    total: pendiente.total,
    nota: notaFinal,
    paraLlevar: pendiente.paraLlevar || false,
    origen: "cliente",
    metodoPago: "tarjeta",
    estado: "pendiente",
    codigo: generarCodigoPedido(),
    creadoEn: cuando,
    folioPago: paymentData.id ? String(paymentData.id) : "",
    fecha: fechaPedido,
    horaEnvio: horaPedido
  };

  // El dinero ya entró: se registra como venta sin pasar por cocina
  if (opciones.comoVenta) {
    pedido.estado = "Entregado";
    pedido.horaEntrega = horaPedido;
    pedido.entregadoEn = cuando;
  }

  // Se canjea antes de guardar para que el pedido se quede con el cupón
  // nuevo y se le pueda volver a mostrar si confirma por segunda vez
  const nuevoRefMP = (pendiente.esReferido && pendiente.cupon)
    ? await canjearReferido(pendiente.cupon, pendiente.telefono, pendiente.referidoEnviado, pendiente.dispositivo)
    : await cuponParaCompartir(pendiente.telefono, pendiente.dispositivo);
  if (nuevoRefMP) pedido.nuevoRef = nuevoRefMP;

  if (pendiente.alertaPrecio && pendiente.alertaPrecio.length) pedido.alertaPrecio = pendiente.alertaPrecio;
  pedidos.push(pedido);
  await guardarPedido(pedido);
  if (pendiente.cupon && CUPONES_1USO[pendiente.cupon]) await marcarCuponUsado(pendiente.cupon);

  io.emit("nuevoPedido", pedido);
  await eliminarPedidoPendiente(external_reference);

  return { ok: true, pedidoId: pedido.id, nuevoRef: nuevoRefMP, codigo: pedido.codigo };
}

// ---- Red de seguridad de los pagos en línea ----
// El pedido se creaba solo si el navegador del cliente alcanzaba a avisar.
// Si se cerraba la página, se iba la señal o se bloqueaba el celular,
// Mercado Pago cobraba y el pedido nunca entraba a cocina. Ahora hay dos
// caminos más: el aviso que manda Mercado Pago y un barrido cada minuto.

// Aviso de Mercado Pago. Se responde de inmediato y se trabaja después:
// si tarda, Mercado Pago lo da por fallido y lo reintenta de más.
// Del aviso solo se toma el número de pago; todo lo demás se le pregunta
// a Mercado Pago, así que un aviso inventado no crea ningún pedido.
app.post("/webhook-mp", (req, res) => {
  res.sendStatus(200);

  const tipo = (req.body && req.body.type) || req.query.type;
  const id = (req.body && req.body.data && req.body.data.id) || req.query["data.id"];
  if (tipo !== "payment" || !id) return;

  (async () => {
    try {
      const pago = await new Payment(mpClient).get({ id });
      if (!pago || pago.status !== "approved" || !pago.external_reference) return;

      const r = await confirmarPagoOnline(pago.external_reference, id);
      if (r.ok && !r.repetido) {
        console.log("Pedido recuperado por aviso de Mercado Pago:", r.codigo);
      }
    } catch (e) {
      console.error("Error atendiendo aviso de Mercado Pago:", e.message);
    }
  })();
});

// Un pago que se cobró hace poco y no tiene pedido casi siempre es alguien
// esperando su comida en el mostrador: ese se recupera solo. Uno de hace
// horas ya no se manda a cocina, se reporta para hablarle al cliente.
const MINUTOS_RECUPERACION = 30;

// Los atorados quedan guardados aquí para que las pantallas los pinten sin
// preguntarle a Mercado Pago en cada refresco
let pagosAtorados = [];
let ultimaRevisionViejos = 0;

async function recuperarPagosSinPedido() {
  if (!mpClient || (!process.env.MERCADOPAGO_ACCESS_TOKEN_ONLINE && !process.env.MERCADOPAGO_ACCESS_TOKEN)) return;

  try {
    const ahora = Date.now();
    // Los viejos se revisan cada 5 minutos: no cambian de un momento a otro
    // y cada uno es una consulta a Mercado Pago
    const tocaRevisarViejos = ahora - ultimaRevisionViejos > 5 * 60 * 1000;
    const atorados = [];
    const pendientes = await listarPedidosPendientes();

    for (const p of pendientes) {
      const edad = ahora - cuandoSeCreo(p);

      // Menos de dos minutos: el cliente todavía puede estar pagando
      if (edad < 2 * 60 * 1000) continue;

      const esViejo = edad > MINUTOS_RECUPERACION * 60 * 1000;

      if (esViejo) {
        if (edad > 7 * 24 * 60 * 60 * 1000) { await eliminarPedidoPendiente(p.ref); continue; }
        if (!tocaRevisarViejos) continue;
      }

      const pago = await buscarPaymentPorReferencia(p.ref);
      if (!pago || pago.status !== "approved") continue;

      if (esViejo) {
        // Ya no se manda solo a cocina: el cliente probablemente ya se fue
        atorados.push({
          ref: p.ref,
          cliente: p.cliente,
          telefono: p.telefono,
          total: p.total,
          productos: p.productos || [],
          folioPago: String(pago.id),
          creadoEn: cuandoSeCreo(p),
          cuando: new Date(cuandoSeCreo(p)).toLocaleString("es-MX", { timeZone: "America/Mexico_City" }),
          minutos: Math.round(edad / 60000)
        });
        continue;
      }

      const r = await confirmarPagoOnline(p.ref, pago.id);
      if (r.ok && !r.repetido) {
        console.log("Pedido recuperado por el barrido:", r.codigo, "-", p.cliente);
      }
    }

    if (tocaRevisarViejos) {
      ultimaRevisionViejos = ahora;
      pagosAtorados = atorados;
      if (atorados.length) console.log("Pagos cobrados sin pedido:", atorados.length);
    }
  } catch (e) {
    console.error("Error recuperando pagos sin pedido:", e.message);
  }
}

setInterval(recuperarPagosSinPedido, 60 * 1000);
// Tras un reinicio o un deploy puede haber quedado alguno a medias
setTimeout(recuperarPagosSinPedido, 15 * 1000);
// Ganchos para poder probar la recuperación sin esperar los intervalos
global.__barrido = recuperarPagosSinPedido;
global.__forzarViejos = () => { ultimaRevisionViejos = 0; };

// Pagos cobrados que nunca se volvieron pedido y ya son muy viejos para
// mandarlos a cocina. Con el teléfono a la mano para hablarle al cliente.
app.get("/pagos-sin-pedido", soloAdmin, async (req, res) => {
  try {
    // Al abrir el reporte se vuelve a preguntar, para no ver datos de hace rato
    ultimaRevisionViejos = 0;
    await recuperarPagosSinPedido();
    res.json({ pagos: pagosAtorados });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pedidos en línea del día para la pantalla de entrega, del más nuevo al
// más viejo. Va sin contraseña como el resto de esa pantalla, así que los
// pagos atorados salen sin teléfono: ahí solo importa saber que existen.
app.get("/pedidos/online-hoy", (req, res) => {
  const hoy = fechaHoy();

  const enLinea = pedidos
    .filter(p => p.origen === "cliente" && p.fecha === hoy)
    .sort((a, b) => (b.creadoEn || b.id) - (a.creadoEn || a.id));

  res.json({
    pedidos: enLinea,
    atorados: pagosAtorados.map(p => ({
      ref: p.ref,
      cliente: p.cliente,
      total: p.total,
      productos: p.productos,
      cuando: p.cuando,
      minutos: p.minutos
    }))
  });
});

// Cerrar un pago atorado. El dinero ya entró, así que no se tira: se anota
// como venta entregada, en el día en que el cliente pagó, y deja de salir
// en las pantallas. Si hubo que devolver el dinero, esa venta se borra
// desde la página de ventas, que ahí sí pide contraseña.
// Va sin contraseña porque se usa desde entrega, que no tiene login.
app.delete("/pagos-sin-pedido/:ref", async (req, res) => {
  try {
    const r = await confirmarPagoOnline(req.params.ref, null, { comoVenta: true });
    pagosAtorados = pagosAtorados.filter(p => p.ref !== req.params.ref);

    // Si el cobro ya no se puede confirmar con Mercado Pago, al menos se
    // deja de reclamar; el dato del cobro sigue en la cuenta
    if (!r.ok) {
      await eliminarPedidoPendiente(req.params.ref);
      return res.json({ ok: true, registrado: false, motivo: r.error });
    }

    res.json({ ok: true, registrado: true, pedidoId: r.pedidoId, codigo: r.codigo });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mandar a cocina un pago que se quedó atorado, para el cliente que sigue
// esperando. También se usa desde entrega, así que va sin contraseña.
app.post("/pagos-sin-pedido/:ref/enviar", async (req, res) => {
  try {
    const r = await confirmarPagoOnline(req.params.ref, null);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
        external_reference,
        notification_url: BASE_URL + "/webhook-mp"
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

    // El cobro ya se hizo. Si el pedido no se pudo crear en este momento,
    // NO se le dice que falló: lo volvería a pagar. El barrido lo mete a
    // cocina en menos de dos minutos.
    if (!confirmado.ok) {
      console.error("Cobro aprobado sin pedido (lo recupera el barrido):", external_reference, confirmado.error);
      return res.json({ ok: true, status: "approved", pendienteDeRegistro: true });
    }

    res.json({ ok: true, status: "approved", ...confirmado });
  } catch (e) {
    console.error("Error procesando pago con tarjeta:", e.message);
    res.status(500).json({ ok: false, error: "server_error", detalle: e.message });
  }
});

// El formulario de pago del cliente avisa aquí sus errores, para que queden
// en el registro y se pueda saber por qué a alguien no le cargó el pago
app.post("/log-error-pago", (req, res) => {
  const b = req.body || {};
  const corto = v => String(v == null ? "" : v).slice(0, 300);
  console.error("Error en formulario de pago (cliente):", corto(b.tipo), corto(b.causa), corto(b.mensaje), "|", corto(b.navegador));
  res.status(204).end();
});

// Bricks: confirma pago desde el frontend (POST con JSON)
app.post("/confirmar-pago-online", async (req, res) => {
  const { external_reference, payment_id } = req.body;
  try {
    let result = await confirmarPagoOnline(external_reference, payment_id);

    // Si el aviso de Mercado Pago o el barrido lo están metiendo en este
    // mismo momento, se espera tantito y se vuelve a ver
    if (result.error === "confirmacion_en_curso") {
      await new Promise(r => setTimeout(r, 1500));
      result = await confirmarPagoOnline(external_reference, payment_id);
    }

    if (result.ok) return res.json(result);

    // El dinero sí se cobró: decirle que falló haría que pagara otra vez.
    // El barrido mete el pedido en menos de dos minutos.
    if (result.error === "pedido_pendiente_no_encontrado" || result.error === "confirmacion_en_curso") {
      console.error("Pago aprobado sin pedido (lo recupera el barrido):", external_reference, result.error);
      return res.json({ ok: true, status: "approved", pendienteDeRegistro: true });
    }

    return res.status(400).json(result);
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

// A todo lo campechano se le quita el "de" ("Mollequiles Campechanos"),
// igual que en menu.js; aquí por si algún pedido llega con el nombre largo
function nombreProducto(nombre) {
  return typeof nombre === "string" ? nombre.replace(/\s+de\s+(campechan[oa]s?)\b/gi, " $1") : nombre;
}

function nombresDeProductos(productos) {
  return Array.isArray(productos) ? productos.map(p => (p && typeof p === "object") ? { ...p, nombre: nombreProducto(p.nombre) } : p) : productos;
}

app.post("/pedido", soloAdmin, async (req, res) => {
  const esKiosko = req.body.origen === "kiosko";

  // El kiosko reintenta si no le llega la respuesta. Si el pedido de ese
  // cobro ya entró, se le devuelve el mismo en lugar de crear otro.
  const idCobro = typeof req.body.idCobro === "string" ? req.body.idCobro.slice(0, 100) : "";
  if (idCobro) {
    const yaEntro = pedidos.find(p => p.idCobro === idCobro);
    if (yaEntro) {
      return res.json(yaEntro.cuponGenerado
        ? { ...yaEntro, cuponNuevo: await datosCuponKiosko(yaEntro.cuponGenerado) }
        : yaEntro);
    }
  }

  // Un cobro ya hecho sí se registra; lo que se frena es empezar uno nuevo
  // con el kiosko apagado
  if (esKiosko && !kioskoActivo && req.body.metodoPago !== "tarjeta") {
    return res.status(403).json({ error: "El kiosko está apagado" });
  }

  const pedido = {
    id: idCounter++,
    cliente: req.body.cliente,
    productos: nombresDeProductos(req.body.productos),
    total: req.body.total,
    nota: req.body.nota || "",
    paraLlevar: req.body.paraLlevar || false,
    metodoPago: req.body.metodoPago || "efectivo",
    estado: "pendiente",
    fecha: fechaHoy(),
    horaEnvio: horaMXAhora()
  };

  // El del kiosko se lleva su código: nadie le toma el nombre, se le llama
  // por el código que le aparece en pantalla
  if (esKiosko) {
    pedido.origen = "kiosko";
    pedido.codigo = generarCodigoPedido();
    pedido.creadoEn = Date.now();
    if (idCobro) pedido.idCobro = idCobro;
  }

  // El cobro ya se hizo con el descuento: si el cupón se acaba de usar en
  // otro lado igual entra el pedido, solo queda anotado
  let cuponNuevo = null;
  if (esKiosko) {
    try {
      const usado = req.body.cuponKiosko ? String(req.body.cuponKiosko).toUpperCase() : "";
      if (usado) {
        pedido.cuponKiosko = usado;
        if (!(await canjearCuponKiosko(usado, pedido.id))) {
          console.error("Cupón del kiosko ya usado o inexistente al registrar el pedido:", usado, pedido.id);
        }
      } else {
        cuponNuevo = await crearCuponKiosko(pedido.id);
        pedido.cuponGenerado = cuponNuevo.codigo;
      }
    } catch (e) {
      console.error("Error con el cupón del kiosko:", e.message);
    }
  }

  pedidos.push(pedido);
  await guardarPedido(pedido);

  io.emit("nuevoPedido", pedido);

  res.json(cuponNuevo
    ? { ...pedido, cuponNuevo: { codigo: cuponNuevo.codigo, descuento: cuponNuevo.descuento, minimo: cuponNuevo.minimo, vence: cuponNuevo.vence } }
    : pedido);
});

app.get("/pedidos", soloAdmin, (req, res) => {
  res.json(pedidos);
});

// Comprobante del cliente: se consulta con el código del pedido, que solo
// tiene quien lo hizo. No devuelve el teléfono ni datos de pago del cliente.
app.get("/comprobante/:codigo", async (req, res) => {
  const codigo = String(req.params.codigo || "").toUpperCase();
  let pedido = pedidos.find(p => p.codigo === codigo);

  // El cliente puede volver a su comprobante semanas después, cuando el
  // pedido ya no está en memoria
  if (!pedido && db) {
    try {
      const doc = await db.collection("pedidos").findOne({ codigo });
      if (doc) { delete doc._id; pedido = doc; }
    } catch (e) { console.error("Error buscando comprobante:", e.message); }
  }

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
app.get("/clientes-frecuentes", soloAdmin, async (req, res) => {
  const porTelefono = {};

  // Hace falta el historial completo, pero no los productos: se piden solo
  // los campos que se usan, que es una fracción del peso
  const entregados = await consultarPedidos(
    { estado: "Entregado" },
    p => p.estado === "Entregado",
    { cliente: 1, total: 1, fecha: 1, entregadoEn: 1, creadoEn: 1, estado: 1 }
  );

  entregados.forEach(p => {
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

// Turnos de la semana: de lunes a viernes hay dos, el sábado uno solo.
// El salario sale de aquí: pago por turno × turnos que cubre cada quien.
const DIAS_TURNO = [
  { clave: "lun", nombre: "Lun", turnos: 2 },
  { clave: "mar", nombre: "Mar", turnos: 2 },
  { clave: "mie", nombre: "Mié", turnos: 2 },
  { clave: "jue", nombre: "Jue", turnos: 2 },
  { clave: "vie", nombre: "Vie", turnos: 2 },
  { clave: "sab", nombre: "Sáb", turnos: 1 }
];

const TURNOS_VALIDOS = new Set(
  DIAS_TURNO.flatMap(d => Array.from({ length: d.turnos }, (_, i) => d.clave + "-" + (i + 1)))
);

// Deja solo los turnos que existen y sin repetir
function turnosLimpios(valor) {
  if (!Array.isArray(valor)) return [];
  return [...new Set(valor.filter(t => TURNOS_VALIDOS.has(t)))];
}

// Las faltas guardan cuándo se marcaron. Al volver a mandar la lista se
// conserva la fecha de las que ya estaban y solo se sella la nueva.
function faltasLimpias(nuevas, previas) {
  const antes = new Map((previas || []).map(f => [f.turno, f]));
  const ahora = fechaMXAhora();

  return turnosLimpios(nuevas).map(turno => antes.get(turno) || {
    turno,
    fecha: ahora.toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric" }),
    hora: ahora.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })
  });
}

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

// Pone al día una ficha guardada antes. El salario dejó de guardarse suelto:
// ahora sale del pago por turno, así que una ficha vieja se queda esperando
// que se le capture el pago y los turnos.
function normalizarFicha(tipo, ficha) {
  if (!Array.isArray(ficha.movimientos)) ficha.movimientos = [];

  if (CONFIG_CUENTAS[tipo].salario) {
    if (ficha.pagoTurno === undefined) ficha.pagoTurno = 0;
    if (!Array.isArray(ficha.turnos)) ficha.turnos = [];
    if (!Array.isArray(ficha.faltas)) ficha.faltas = [];
    delete ficha.salario;
  }

  return ficha;
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
    // El salario no se guarda: se calcula, así no puede quedar peleado con
    // los turnos que cubre
    const turnos = turnosLimpios(ficha.turnos);
    const pago = ficha.pagoTurno || 0;

    // Una falta en un turno que ya no cubre no se cobra
    const faltas = (ficha.faltas || []).filter(f => turnos.includes(f.turno));

    salida.turnos = turnos;
    salida.faltas = faltas;
    salida.salario = Math.round(pago * turnos.length * 100) / 100;
    salida.descuentoFaltas = Math.round(pago * faltas.length * 100) / 100;
    salida.neto = Math.round((salida.salario - salida.descuentoFaltas - debe) * 100) / 100;
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
      // La rejilla de turnos la arma el navegador con esto, así el horario
      // se cambia en un solo lugar
      dias: conSalario ? DIAS_TURNO : undefined,
      totalDebe: Math.round(lista.reduce((a, f) => a + f.debe, 0) * 100) / 100,
      totalSalarios: conSalario
        ? Math.round(lista.reduce((a, f) => a + (f.salario || 0), 0) * 100) / 100
        : 0,
      totalFaltas: conSalario
        ? Math.round(lista.reduce((a, f) => a + (f.descuentoFaltas || 0), 0) * 100) / 100
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
      const pago = montoValido(req.body.pagoTurno, true);
      if (req.body.pagoTurno !== undefined && pago === null) {
        return res.status(400).json({ error: "Pago por turno inválido" });
      }
      ficha.pagoTurno = pago || 0;
      ficha.turnos = turnosLimpios(req.body.turnos);
      ficha.faltas = [];
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
      if (req.body.pagoTurno !== undefined) {
        const pago = montoValido(req.body.pagoTurno, true);
        if (pago === null) return res.status(400).json({ error: "Pago por turno inválido" });
        ficha.pagoTurno = pago;
      }
      if (req.body.turnos !== undefined) ficha.turnos = turnosLimpios(req.body.turnos);
      if (req.body.faltas !== undefined) ficha.faltas = faltasLimpias(req.body.faltas, ficha.faltas);
      // Si se le quitó un turno, su falta ya no tiene sentido
      ficha.faltas = (ficha.faltas || []).filter(f => (ficha.turnos || []).includes(f.turno));
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
app.get("/cliente-historial/:telefono", soloAdmin, async (req, res) => {
  const telefono = String(req.params.telefono || "").replace(/\D/g, "");
  if (!/^\d{10}$/.test(telefono)) {
    return res.status(400).json({ error: "Teléfono inválido" });
  }

  // El teléfono va dentro del nombre, como "Maria (Tel: 5511223344)"
  const suyos = await consultarPedidos(
    { cliente: { $regex: "\\(Tel: *" + telefono + "\\)" } },
    p => {
      const m = (p.cliente || "").match(/\(Tel:\s*(\d+)\)/);
      return m && m[1] === telefono;
    }
  );

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
// Cada pantalla tiene su terminal y su propia orden pendiente: si la
// compartieran, cobrar en el kiosko cancelaría el cobro de la caja.
const TERMINALES = {
  caja:   { device: process.env.MP_DEVICE_ID || "NEWLAND_N950__N950NCCB05482252", ultimaOrden: null },
  kiosko: { device: process.env.MP_DEVICE_ID_KIOSKO || "", ultimaOrden: null }
};

function terminalDe(valor) {
  return TERMINALES[valor === "kiosko" ? "kiosko" : "caja"];
}

app.post("/cobrar-terminal", soloAdmin, async (req, res) => {
  const { amount, reference, terminal } = req.body;
  if (!amount || amount < 5) return res.status(400).json({ error: "Monto mínimo $5" });
  if (!MP_TOKEN_PRESENCIAL) return res.status(500).json({ error: "Mercado Pago presencial no configurado" });

  if (terminal === "kiosko" && !kioskoActivo) {
    return res.status(403).json({ error: "El kiosko está apagado", apagado: true });
  }

  const term = terminalDe(terminal);
  if (!term.device) {
    return res.status(500).json({ error: "Falta configurar la terminal del kiosko (MP_DEVICE_ID_KIOSKO)" });
  }

  try {
    // Cancelar la orden anterior de ESTA terminal si quedó colgada
    if (term.ultimaOrden) {
      try {
        await fetch(`https://api.mercadopago.com/v1/orders/${term.ultimaOrden}/cancel`, {
          method: "POST",
          headers: { "Authorization": "Bearer " + MP_TOKEN_PRESENCIAL, "X-Idempotency-Key": "cancel-" + term.ultimaOrden + "-" + Date.now() }
        });
      } catch (e) {}
      term.ultimaOrden = null;
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
          point: { terminal_id: term.device, print_on_terminal: "no_ticket" },
          payment_method: { default_type: "credit_card" }
        }
      })
    });
    const data = await resp.json();
    // Mercado Pago no deja mandar un cobro si la terminal ya tiene otro
    // esperando (409, "already_queued_order..."), por ejemplo uno que alguien
    // dejó a medias. Se avisa aparte para que la pantalla diga qué hacer.
    if (resp.status === 409 && /queued/i.test(JSON.stringify(data))) {
      return res.status(409).json({ error: "La terminal tiene un pago pendiente", pendienteEnTerminal: true });
    }
    if (!resp.ok) return res.status(resp.status).json(data);
    term.ultimaOrden = data.id;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lista las terminales de la cuenta con su ID, que es lo que hay que poner
// en MP_DEVICE_ID_KIOSKO. Se consulta desde aquí porque el token de Point
// vive en el servidor, no en la máquina de nadie.
app.get("/terminales", soloAdmin, async (req, res) => {
  if (!MP_TOKEN_PRESENCIAL) {
    return res.status(500).json({ error: "Mercado Pago presencial no configurado" });
  }
  try {
    const resp = await fetch("https://api.mercadopago.com/point/integration-api/devices", {
      headers: { Authorization: "Bearer " + MP_TOKEN_PRESENCIAL }
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);

    res.json({
      terminales: (data.devices || []).map(d => ({
        id: d.id,
        modo: d.operating_mode || "",
        // Para saber cuál ya está en uso y cuál queda libre
        usadaEn: Object.keys(TERMINALES).filter(k => TERMINALES[k].device === d.id)
      })),
      configuradas: { caja: TERMINALES.caja.device, kiosko: TERMINALES.kiosko.device }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cambiar el modo de una terminal. En PDV recibe los cobros que le manda
// el sistema; en STANDALONE cobra sola con el monto tecleado y no atiende
// a la API. Se hace desde aquí para no depender de los menús de la app,
// que cambian con cada versión.
app.post("/terminales/:deviceId/modo", soloAdmin, async (req, res) => {
  if (!MP_TOKEN_PRESENCIAL) {
    return res.status(500).json({ error: "Mercado Pago presencial no configurado" });
  }

  const modo = req.body && req.body.modo === "STANDALONE" ? "STANDALONE" : "PDV";

  try {
    const resp = await fetch(
      "https://api.mercadopago.com/point/integration-api/devices/" + encodeURIComponent(req.params.deviceId),
      {
        method: "PATCH",
        headers: {
          "Authorization": "Bearer " + MP_TOKEN_PRESENCIAL,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ operating_mode: modo })
      }
    );

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return res.status(resp.status).json(data);

    res.json({ ok: true, modo, terminal: req.params.deviceId });
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
    // Limpiar la orden en la terminal a la que pertenezca
    Object.values(TERMINALES).forEach(t => {
      if (t.ultimaOrden === req.params.orderId) t.ultimaOrden = null;
    });
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

  // Puede ser un pedido viejo que ya no está en memoria: se borra igual
  const pedido = await buscarPedidoPorId(id);
  if (!pedido) return res.status(404).send("No encontrado");

  const idx = pedidos.findIndex(p => p.id === id);

  // Guardar en historial de eliminados
  const eliminado = { ...pedido, eliminadoEn: new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" }) };
  pedidosEliminados.push(eliminado);
  if (db) {
    try { await db.collection("pedidos_eliminados").insertOne({ ...eliminado }); } catch(e) {}
  }

  if (idx !== -1) pedidos.splice(idx, 1);
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

// El árbol de fechas de la página de ventas: todas las fechas con ventas,
// que puede ser el historial entero. Se le pregunta a la base.
app.get("/ventas/fechas", soloAdmin, async (req, res) => {
  if (db) {
    try {
      const fechas = await db.collection("pedidos").distinct("fecha", { estado: "Entregado", fecha: { $ne: null } });
      return res.json(fechas.filter(Boolean));
    } catch (e) {
      console.error("Error consultando fechas:", e.message);
    }
  }
  res.json([...new Set(pedidos.filter(p => p.estado === "Entregado" && p.fecha).map(p => p.fecha))]);
});

app.get("/ventas/fecha/:fecha", soloAdmin, async (req, res) => {
  const entregados = await entregadosDe(req.params.fecha);
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
  const totalAnterior = (await entregadosDe(fechaAnt)).reduce((acc, p) => acc + p.total, 0);

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

// Suma de todo lo vendido en la historia. La hace MongoDB: traer los
// pedidos para sumarlos aquí sería cargar el historial completo.
app.get("/total", soloAdmin, async (req, res) => {
  if (db) {
    try {
      const r = await db.collection("pedidos").aggregate([
        { $match: { estado: "Entregado" } },
        { $group: { _id: null, total: { $sum: "$total" } } }
      ]).toArray();
      return res.json({ total: r.length > 0 ? r[0].total : 0 });
    } catch (e) {
      console.error("Error sumando total:", e.message);
    }
  }

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
  // El paquete del día se vende como "Economico con ...": es de ensaladas
  if (n.includes("ensalada") || n.includes("economico")) return "Ensaladas";
  if (n.includes("hot dog")) return "Snacks";
  if (n.includes("banderilla")) return "Snacks";
  if (n.includes("papas")) return "Snacks";
  if (n.includes("nachos")) return "Snacks";
  if (n.includes("maruchan")) return "Snacks";
  if (n.includes("agua de") || n.includes("agua ")) return "Aguas";
  if (n.includes("licuado") || n.includes("cafe frio")) return "Licuados";
  if (n.includes("cafe") || n.includes("capuccino") || n.includes("espumoso") || n.includes("agua caliente")) return "Café";
  if (n.includes("coca") || n.includes("boing") || n.includes("fuze") || n.includes("jumex") || n.includes("gatorade") || n.includes("monster") || n.includes("redbull") || n.includes("volt") || n.includes("electrolit") || n.includes("yakult") || n.includes("panzoncita") || n.includes("penafielita") || n.includes("del valle") || n.includes("refresco") || n.includes("santa clara") || n.includes("arizona") || n.includes("bonafont")) return "Bebidas";
  return "Otros";
}

app.get("/ventas/productos-vendidos", soloAdmin, async (req, res) => {
  const periodo = req.query.periodo || "dia";
  const fecha = req.query.fecha;
  const ahora = fechaMXAhora();

  let entregados;

  if (periodo === "dia") {
    entregados = await entregadosDe(fecha || fechaHoy());
  } else if (periodo === "semana") {
    const hace7dias = new Date(ahora);
    hace7dias.setDate(hace7dias.getDate() - 6);
    entregados = await entregadosEnFechas(fechasEntre(hace7dias, ahora));
  } else if (periodo === "mes") {
    const primero = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
    entregados = await entregadosEnFechas(fechasEntre(primero, ahora));
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

  const entregados = await entregadosEnFechas(fechasEntre(hace7dias, ahora));
  const total = entregados.reduce((acc, p) => acc + p.total, 0);

  const porDia = {};
  entregados.forEach(p => {
    if (!porDia[p.fecha]) porDia[p.fecha] = { pedidos: [], total: 0 };
    porDia[p.fecha].pedidos.push(p);
    porDia[p.fecha].total += p.total;
  });

  const totalEfectivo = entregados.filter(p => p.metodoPago !== "tarjeta").reduce((acc, p) => acc + p.total, 0);
  const totalTarjeta = entregados.filter(p => p.metodoPago === "tarjeta").reduce((acc, p) => acc + p.total, 0);

  // Comparativo: la semana de antes, los 7 días que terminan antes de esta
  const hace14dias = new Date(ahora);
  hace14dias.setDate(hace14dias.getDate() - 13);
  const finAnterior = new Date(hace7dias);
  finAnterior.setDate(finAnterior.getDate() - 1);
  const entregadosAnt = await entregadosEnFechas(fechasEntre(hace14dias, finAnterior));
  const totalAnterior = entregadosAnt.reduce((acc, p) => acc + p.total, 0);

  res.json({ pedidos: entregados, total, porDia, totalEfectivo, totalTarjeta, totalAnterior });
});

app.get("/ventas/mensual", soloAdmin, async (req, res) => {
  const ahora = fechaMXAhora();
  const mesActual = (ahora.getMonth() + 1).toString().padStart(2, "0");
  const anioActual = ahora.getFullYear().toString();

  const primeroDelMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
  const entregados = await entregadosEnFechas(fechasEntre(primeroDelMes, ahora));
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
  const primeroAnterior = new Date(anioAnt, mesAnt - 1, 1);
  const ultimoAnterior = new Date(anioAnt, mesAnt, 0);
  const entregadosAnt = await entregadosEnFechas(fechasEntre(primeroAnterior, ultimoAnterior));
  const totalAnterior = entregadosAnt.reduce((acc, p) => acc + p.total, 0);

  res.json({ pedidos: entregados, total, porDia, totalEfectivo, totalTarjeta, totalAnterior });
});

// Historial de eliminados
async function eliminadosDe(fecha) {
  if (db) {
    try {
      const docs = await db.collection("pedidos_eliminados").find({ fecha }).toArray();
      docs.forEach(d => delete d._id);
      return docs;
    } catch (e) { console.error("Error consultando eliminados:", e.message); }
  }
  return pedidosEliminados.filter(p => p.fecha === fecha);
}

app.get("/ventas/eliminados/:fecha", soloAdmin, async (req, res) => {
  res.json(await eliminadosDe(req.params.fecha));
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
app.get("/corte/exportar/:fecha", soloAdminOExport, async (req, res) => {
  const fecha = req.params.fecha;
  const entregados = await entregadosDe(fecha);
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
  const eliminados = await eliminadosDe(fecha);
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

app.get("/ventas/exportar/:tipo", soloAdminOExport, async (req, res) => {
  const tipo = req.params.tipo;
  const ahora = fechaMXAhora();
  let entregados = [];

  if (tipo === "dia") {
    const fecha = req.query.fecha;
    if (!fecha) return res.status(400).send("Falta parámetro fecha");
    entregados = await entregadosDe(fecha);
  } else if (tipo === "semana") {
    const hace7dias = new Date(ahora);
    hace7dias.setDate(hace7dias.getDate() - 6);
    entregados = await entregadosEnFechas(fechasEntre(hace7dias, ahora));
  } else if (tipo === "mes") {
    const primero = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
    entregados = await entregadosEnFechas(fechasEntre(primero, ahora));
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
