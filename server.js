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

// Mercado Pago
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN || "" });
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

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
  const { cliente, telefono, productos: prods, total: monto, nota } = req.body;

  if (!cliente || !telefono || !prods || prods.length === 0 || !monto) {
    return res.status(400).json({ error: "Datos incompletos" });
  }

  if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
    return res.status(500).json({ error: "Mercado Pago no configurado" });
  }

  const ref = "pedido_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

  try {
    const preference = new Preference(mpClient);
    const result = await preference.create({
      body: {
        items: [{
          title: "Pedido de " + cliente,
          quantity: 1,
          unit_price: monto,
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

    await guardarPedidoPendiente(ref, { cliente, telefono, productos: prods, total: monto, nota });

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
  res.json({ pedidos: entregados, total });
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

  const productos = {};
  entregados.forEach(p => {
    p.productos.forEach(pr => {
      const nombre = pr.nombre;
      if (!productos[nombre]) productos[nombre] = { nombre, cantidad: 0, total: 0 };
      productos[nombre].cantidad += pr.cantidad || 1;
      productos[nombre].total += (pr.precio || 0) * (pr.cantidad || 1);
    });
  });

  const resultado = Object.values(productos).sort((a, b) => b.cantidad - a.cantidad);
  res.json(resultado);
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

app.get("/ventas/semanal", (req, res) => {
  const ahora = fechaMXAhora();
  const hace7dias = new Date(ahora);
  hace7dias.setDate(hace7dias.getDate() - 6);
  hace7dias.setHours(0, 0, 0, 0);

  const entregados = pedidos.filter(p => {
    if (p.estado !== "Entregado" || !p.fecha) return false;
    const fechaPedido = parseFechaMX(p.fecha);
    return fechaPedido >= hace7dias;
  });

  const total = entregados.reduce((acc, p) => acc + p.total, 0);

  // Agrupar por fecha
  const porDia = {};
  entregados.forEach(p => {
    if (!porDia[p.fecha]) porDia[p.fecha] = { pedidos: [], total: 0 };
    porDia[p.fecha].pedidos.push(p);
    porDia[p.fecha].total += p.total;
  });

  res.json({ pedidos: entregados, total, porDia });
});

app.get("/ventas/mensual", (req, res) => {
  const ahora = fechaMXAhora();
  const mesActual = (ahora.getMonth() + 1).toString().padStart(2, "0");
  const anioActual = ahora.getFullYear().toString();

  const entregados = pedidos.filter(p => {
    if (p.estado !== "Entregado" || !p.fecha) return false;
    // fecha formato dd/mm/yyyy
    const partes = p.fecha.split("/");
    return partes[1] === mesActual && partes[2] === anioActual;
  });

  const total = entregados.reduce((acc, p) => acc + p.total, 0);

  // Agrupar por fecha
  const porDia = {};
  entregados.forEach(p => {
    if (!porDia[p.fecha]) porDia[p.fecha] = { pedidos: [], total: 0 };
    porDia[p.fecha].pedidos.push(p);
    porDia[p.fecha].total += p.total;
  });

  res.json({ pedidos: entregados, total, porDia });
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
