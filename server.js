const express = require("express");
const http = require("http");
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

// MongoDB
let db;
let pedidos = [];
let idCounter = 1;

// Pedidos pendientes (en memoria + MongoDB)
const pedidosPendientes = new Map();

async function conectarDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.log("MONGODB_URI no configurada, los pedidos no se guardarán permanentemente");
    return;
  }
  try {
    const client = new MongoClient(uri);
    await client.connect();
    db = client.db("pdv");
    console.log("Conectado a MongoDB");
  } catch (e) {
    console.error("Error conectando a MongoDB:", e.message);
  }
}

async function cargarPedidos() {
  if (db) {
    try {
      pedidos = await db.collection("pedidos").find().toArray();
      pedidos.forEach(p => delete p._id);
      idCounter = pedidos.length > 0 ? Math.max(...pedidos.map(p => p.id)) + 1 : 1;
      console.log("Pedidos cargados desde MongoDB:", pedidos.length);
      return;
    } catch (e) {
      console.error("Error cargando pedidos:", e.message);
    }
  }
  pedidos = [];
  idCounter = 1;
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

app.get("/entrega", (req, res) => {
  res.sendFile(__dirname + "/public/entrega.html");
});

app.get("/ventas", (req, res) => {
  res.sendFile(__dirname + "/public/ventas.html");
});

app.get("/cliente", (req, res) => {
  res.sendFile(__dirname + "/public/cliente.html");
});

// Mercado Pago: crear preferencia de pago
app.post("/crear-preferencia", async (req, res) => {
  const { cliente, telefono, productos: prods, total: monto, nota, cupon, paraLlevar } = req.body;

  if (!cliente || !telefono || !prods || prods.length === 0 || !monto) {
    return res.status(400).json({ error: "Datos incompletos" });
  }

  // Validar cupón
  const cuponUpper = cupon ? cupon.trim().toUpperCase() : "";
  const descuento = CUPONES[cuponUpper] || 0;

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
      io.emit("nuevoPedido", pedido);

      return res.json({ directo: true });
    } catch (e) {
      console.error("Error creando pedido directo:", e.message);
      return res.status(500).json({ error: "Error al crear el pedido" });
    }
  }

  if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
    return res.status(500).json({ error: "Mercado Pago no configurado" });
  }

  // Calcular monto con descuento parcial
  let montoFinal = monto;
  let notaConCupon = nota || "";
  if (descuento > 0) {
    montoFinal = Math.round(monto * (1 - descuento / 100) * 100) / 100;
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

    await guardarPedidoPendiente(ref, { cliente, telefono, productos: prods, total: montoFinal, nota: notaConCupon, paraLlevar: paraLlevar || false });

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
    io.emit("nuevoPedido", pedido);

    await eliminarPedidoPendiente(external_reference);

    res.redirect("/cliente-confirmado.html");
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
const MP_DEVICE_ID = process.env.MP_DEVICE_ID || "NEWLAND_N950__N950NCCB05293066";

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

  res.json({ pedidos: entregados, total, categorias, porHora, totalEfectivo, totalTarjeta });
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
  if (n.includes("paquete") || n.includes("hot cakes") || n.includes("hotcakes") || n.includes("orden de huevo") || n.includes("bisquet")) return "Desayunos";
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
  if (n.includes("coca") || n.includes("boing") || n.includes("fuze") || n.includes("jumex") || n.includes("gatorade") || n.includes("monster") || n.includes("redbull") || n.includes("volt") || n.includes("electrolit") || n.includes("yakult") || n.includes("panzoncita") || n.includes("peñafielita") || n.includes("del valle") || n.includes("refresco") || n.includes("lechita")) return "Bebidas";
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
    await guardarPedido(pedido);
    io.emit("pedidoEliminado", id);
  }

  res.sendStatus(200);
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
  res.json({ pedidos: entregados, total, porDia, totalEfectivo, totalTarjeta });
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
  res.json({ pedidos: entregados, total, porDia, totalEfectivo, totalTarjeta });
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
