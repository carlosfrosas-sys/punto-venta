const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { MongoClient } = require("mongodb");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(__dirname + "/public"));

// MongoDB
let db;
let pedidos = [];
let idCounter = 1;

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
    estado: "pendiente",
    fecha: fechaHoy()
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
