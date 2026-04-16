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
app.use(express.static(__dirname + "/public"));

// Mercado Pago - Online (cliente.html checkout)
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN_ONLINE || process.env.MERCADOPAGO_ACCESS_TOKEN || "" });
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

// Generar código de referido único
function generarCodigoReferido() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let codigo = "";
  for (let i = 0; i < 6; i++) codigo += chars[Math.floor(Math.random() * chars.length)];
  return codigo;
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

// Respaldo automático
const BACKUP_DIR = path.join(__dirname, "backups");
const BACKUP_PATH = path.join(BACKUP_DIR, "pedidos-backup.json");
const BACKUP_GASTOS_PATH = path.join(BACKUP_DIR, "gastos-backup.json");

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
}

async function guardarPedido(pedido) {
  if (db) {
    try {
      await db.collection("pedidos").updateOne(
        { id: pedido.id },
        { $set: pedido },
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

// Rutas de páginas
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/caja.html");
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

app.get("/cliente", (req, res) => {
  res.sendFile(__dirname + "/public/cliente.html");
});

// Validar código de referido
app.get("/validar-ref/:codigo", async (req, res) => {
  const codigo = req.params.codigo.toUpperCase();
  if (!db) return res.json({ valido: false });
  try {
    const ref = await db.collection("referidos").findOne({ codigo });
    if (!ref) return res.json({ valido: false });
    if (ref.usado) return res.json({ valido: false, mensaje: "Este link ya fue usado" });
    return res.json({ valido: true, descuento: 10 });
  } catch(e) {
    return res.json({ valido: false });
  }
});

// Crear código de referido inicial (el tuyo para compartir)
app.post("/crear-referido-inicial", async (req, res) => {
  if (!db) return res.status(500).json({ error: "Sin base de datos" });
  try {
    let codigo = generarCodigoReferido();
    while (await db.collection("referidos").findOne({ codigo })) {
      codigo = generarCodigoReferido();
    }
    await db.collection("referidos").insertOne({ codigo, origen: "admin", usado: false, fecha: new Date() });
    return res.json({ codigo, link: "/cliente?ref=" + codigo });
  } catch(e) {
    return res.status(500).json({ error: "Error creando referido" });
  }
});

// Consultar estado de referidos
app.get("/referidos-status", async (req, res) => {
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
app.delete("/eliminar-referido/:codigo", async (req, res) => {
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

// Mercado Pago: crear preferencia de pago
app.post("/crear-preferencia", async (req, res) => {
  const { cliente, telefono, productos: prods, total: monto, nota, cupon, paraLlevar } = req.body;

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

  // Cupón de referido (link único + validación por teléfono)
  let esReferido = false;
  if (!descuento && cuponUpper.startsWith("REF-") && db) {
    try {
      // Verificar si este teléfono ya usó un referido antes
      const yaUso = await db.collection("referidos_usados").findOne({ telefono });
      if (yaUso) {
        return res.status(400).json({ error: "Ya usaste un cupón de referido anteriormente" });
      }
      const ref = await db.collection("referidos").findOne({ codigo: cuponUpper.replace("REF-", "") });
      if (ref && !ref.usado) {
        descuento = 10;
        esReferido = true;
      } else if (ref && ref.usado) {
        return res.status(400).json({ error: "Este link de referido ya fue usado" });
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
        fecha: fechaHoy(),
        horaEnvio: new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" })
      };

      pedidos.push(pedido);
      await guardarPedido(pedido);
      if (CUPONES_1USO[cuponUpper]) await marcarCuponUsado(cuponUpper);

      // Referido: marcar como usado, guardar teléfono y generar nuevo código
      let nuevoCodigoRef = null;
      if (esReferido && db) {
        try {
          const codigoUsado = cuponUpper.replace("REF-", "");
          await db.collection("referidos").updateOne({ codigo: codigoUsado }, { $set: { usado: true, usadoPor: telefono, fechaUso: new Date() } });
          await db.collection("referidos_usados").insertOne({ telefono, fecha: new Date() });
          nuevoCodigoRef = generarCodigoReferido();
          while (await db.collection("referidos").findOne({ codigo: nuevoCodigoRef })) {
            nuevoCodigoRef = generarCodigoReferido();
          }
          await db.collection("referidos").insertOne({ codigo: nuevoCodigoRef, origen: telefono, usado: false, fecha: new Date() });
        } catch(e) {}
      }
      io.emit("nuevoPedido", pedido);

      return res.json({ directo: true, nuevoRef: nuevoCodigoRef });
    } catch (e) {
      console.error("Error creando pedido directo:", e.message);
      return res.status(500).json({ error: "Error al crear el pedido" });
    }
  }

  if (!process.env.MERCADOPAGO_ACCESS_TOKEN_ONLINE && !process.env.MERCADOPAGO_ACCESS_TOKEN) {
    // Sin Mercado Pago: crear pedido directo
    try {
      const pedido = {
        id: idCounter++,
        cliente: cliente + " (Tel: " + telefono + ")",
        productos: prods,
        total: monto,
        nota: nota || "",
        paraLlevar: paraLlevar || false,
        origen: "cliente",
        estado: "pendiente",
        fecha: fechaHoy(),
        horaEnvio: new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" })
      };
      pedidos.push(pedido);
      await guardarPedido(pedido);

      let nuevoCodigoRef2 = null;
      if (esReferido && db) {
        try {
          const codigoUsado = cuponUpper.replace("REF-", "");
          await db.collection("referidos").updateOne({ codigo: codigoUsado }, { $set: { usado: true, usadoPor: telefono, fechaUso: new Date() } });
          await db.collection("referidos_usados").insertOne({ telefono, fecha: new Date() });
          nuevoCodigoRef2 = generarCodigoReferido();
          while (await db.collection("referidos").findOne({ codigo: nuevoCodigoRef2 })) {
            nuevoCodigoRef2 = generarCodigoReferido();
          }
          await db.collection("referidos").insertOne({ codigo: nuevoCodigoRef2, origen: telefono, usado: false, fecha: new Date() });
        } catch(e) {}
      }
      io.emit("nuevoPedido", pedido);
      return res.json({ directo: true, nuevoRef: nuevoCodigoRef2 });
    } catch (e) {
      return res.status(500).json({ error: "Error al crear el pedido" });
    }
  }

  // Calcular monto con descuento parcial
  let montoFinal = monto;
  let notaConCupon = nota || "";
  if (descuento > 0) {
    montoFinal = monto * (1 - descuento / 100);
    notaConCupon = "[CUPON " + cuponUpper + " -" + descuento + "%] " + notaConCupon;
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

    await guardarPedidoPendiente(ref, { cliente, telefono, productos: prods, total: montoFinal, nota: notaConCupon, paraLlevar: paraLlevar || false, cupon: cuponUpper, esReferido });

    res.json({ init_point: result.init_point });
  } catch (e) {
    console.error("Error creando preferencia MP:", e.message);
    res.status(500).json({ error: "Error al crear el pago" });
  }
});

// Mercado Pago: pago exitoso
app.get("/pago-exitoso", async (req, res) => {
  const { external_reference, payment_id } = req.query;

  if (!external_reference) {
    return res.redirect("/cliente-error.html");
  }

  try {
    // Verificar pago con API de MP
    const payment = new Payment(mpClient);
    const paymentData = await payment.get({ id: payment_id });

    if (paymentData.status !== "approved") {
      return res.redirect("/cliente-error.html");
    }

    const pendiente = await obtenerPedidoPendiente(external_reference);
    if (!pendiente) {
      return res.redirect("/cliente-error.html");
    }

    // Crear pedido real
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
      fecha: fechaHoy(),
      horaEnvio: new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" })
    };

    pedidos.push(pedido);
    await guardarPedido(pedido);
    if (pendiente.cupon && CUPONES_1USO[pendiente.cupon]) await marcarCuponUsado(pendiente.cupon);

    // Referido con Mercado Pago: marcar usado y generar nuevo
    let nuevoRefMP = null;
    if (pendiente.esReferido && pendiente.cupon && db) {
      try {
        const codigoUsado = pendiente.cupon.replace("REF-", "");
        await db.collection("referidos").updateOne({ codigo: codigoUsado }, { $set: { usado: true, usadoPor: pendiente.telefono, fechaUso: new Date() } });
        await db.collection("referidos_usados").insertOne({ telefono: pendiente.telefono, fecha: new Date() });
        nuevoRefMP = generarCodigoReferido();
        while (await db.collection("referidos").findOne({ codigo: nuevoRefMP })) {
          nuevoRefMP = generarCodigoReferido();
        }
        await db.collection("referidos").insertOne({ codigo: nuevoRefMP, origen: pendiente.telefono, usado: false, fecha: new Date() });
      } catch(e) {}
    }
    io.emit("nuevoPedido", pedido);

    await eliminarPedidoPendiente(external_reference);

    res.redirect("/cliente-confirmado.html" + (nuevoRefMP ? "?ref=" + nuevoRefMP : ""));
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

app.post("/pedido", async (req, res) => {
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
    horaEnvio: new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" })
  };

  pedidos.push(pedido);
  await guardarPedido(pedido);

  io.emit("nuevoPedido", pedido);

  res.json(pedido);
});

app.get("/pedidos", (req, res) => {
  res.json(pedidos);
});

app.put("/pedido/:id", async (req, res) => {
  const pedido = pedidos.find(p => p.id == req.params.id);
  if (pedido) {
    pedido.estado = req.body.estado;
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

app.post("/cobrar-terminal", async (req, res) => {
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

app.get("/cobrar-terminal/:orderId", async (req, res) => {
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

app.delete("/cobrar-terminal/:orderId", async (req, res) => {
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
const USUARIO_ADMIN = process.env.USUARIO_ADMIN || "admin";
const PASS_ADMIN = process.env.PASS_ADMIN || "1234";
const TOKEN_ADMIN = require("crypto").randomBytes(32).toString("hex");

app.post("/login", (req, res) => {
  const { usuario, password } = req.body;
  if (usuario.normalize("NFC") === USUARIO_ADMIN.normalize("NFC") && password === PASS_ADMIN) {
    res.json({ token: TOKEN_ADMIN });
  } else {
    res.status(401).json({ error: "Usuario o contraseña incorrectos" });
  }
});

app.post("/verificar-token", (req, res) => {
  if (req.body.token === TOKEN_ADMIN) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: "Token inválido" });
  }
});

const PASS_ELIMINAR = process.env.PASS_ELIMINAR || "1234";

app.delete("/pedido/:id", async (req, res) => {
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

app.get("/ventas/fechas", (req, res) => {
  const fechas = [...new Set(pedidos.filter(p => p.estado === "Entregado" && p.fecha).map(p => p.fecha))];
  res.json(fechas);
});

app.get("/ventas/fecha/:fecha", (req, res) => {
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

  // Por hora
  const horas = {};
  entregados.forEach(p => {
    const h = (p.horaEnvio || "").split(":")[0];
    if (!h) return;
    if (!horas[h]) horas[h] = { hora: h + ":00", pedidos: 0, total: 0 };
    horas[h].pedidos++;
    horas[h].total += p.total;
  });
  const porHora = Object.values(horas).sort((a, b) => a.hora.localeCompare(b.hora));

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

app.get("/total", (req, res) => {
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
  const n = nombre.toLowerCase();
  if (n.includes("paquete") || n.includes("hot cakes") || n.includes("hotcakes") || n.includes("orden de huevo") || n.includes("bisquet") || n.includes("corn flakes")) return "Desayunos";
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
  if (n.includes("norteña")) return "Norteñas";
  if (n.includes("sincronizada")) return "Sincronizadas";
  if (n.includes("ensalada")) return "Ensaladas";
  if (n.includes("hot dog")) return "Snacks";
  if (n.includes("banderilla")) return "Snacks";
  if (n.includes("papas")) return "Snacks";
  if (n.includes("nachos")) return "Snacks";
  if (n.includes("maruchan")) return "Snacks";
  if (n.includes("agua de") || n.includes("agua ")) return "Aguas";
  if (n.includes("licuado")) return "Licuados";
  if (n.includes("café") || n.includes("capuccino") || n.includes("espumoso") || n.includes("agua caliente")) return "Café";
  if (n.includes("coca") || n.includes("boing") || n.includes("fuze") || n.includes("jumex") || n.includes("gatorade") || n.includes("monster") || n.includes("redbull") || n.includes("volt") || n.includes("electrolit") || n.includes("yakult") || n.includes("panzoncita") || n.includes("peñafielita") || n.includes("del valle") || n.includes("refresco") || n.includes("santa clara") || n.includes("arizona") || n.includes("bonafont")) return "Bebidas";
  return "Otros";
}

app.get("/ventas/productos-vendidos", (req, res) => {
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
    pedido.horaEntrega = new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" });
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
    pedido.horaEntrega = new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" });
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

app.get("/ventas/semanal", async (req, res) => {
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

app.get("/ventas/mensual", async (req, res) => {
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
app.get("/ventas/eliminados/:fecha", (req, res) => {
  const elim = pedidosEliminados.filter(p => p.fecha === req.params.fecha);
  res.json(elim);
});

// Gastos
app.post("/gasto", async (req, res) => {
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

app.get("/gastos/:fecha", (req, res) => {
  const del_dia = gastos.filter(g => g.fecha === req.params.fecha);
  const totalGastos = del_dia.reduce((acc, g) => acc + g.monto, 0);
  res.json({ gastos: del_dia, totalGastos });
});

app.delete("/gasto/:id", async (req, res) => {
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
app.post("/fondo-caja", async (req, res) => {
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

app.get("/fondo-caja/:fecha", (req, res) => {
  const fondo = fondosCaja.find(f => f.fecha === req.params.fecha);
  res.json({ monto: fondo ? fondo.monto : 0 });
});

// Retiros de dinero
app.post("/retiro", async (req, res) => {
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

app.get("/retiros/:fecha", (req, res) => {
  const del_dia = retiros.filter(r => r.fecha === req.params.fecha);
  const totalRetiros = del_dia.reduce((acc, r) => acc + r.monto, 0);
  res.json({ retiros: del_dia, totalRetiros });
});

app.delete("/retiro/:id", async (req, res) => {
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
app.post("/venta-tarjeta", async (req, res) => {
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

app.get("/ventas-tarjeta/:fecha", (req, res) => {
  const del_dia = ventasTarjeta.filter(v => v.fecha === req.params.fecha);
  const totalVentasTarjeta = del_dia.reduce((acc, v) => acc + v.monto, 0);
  res.json({ ventas: del_dia, totalVentasTarjeta });
});

app.delete("/venta-tarjeta/:id", async (req, res) => {
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
app.get("/corte/exportar/:fecha", (req, res) => {
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

app.get("/ventas/exportar/:tipo", (req, res) => {
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
