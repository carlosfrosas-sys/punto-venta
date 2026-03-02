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

const PORT = process.env.PORT || 3000;

// Iniciar servidor después de conectar a MongoDB
conectarDB().then(() => cargarPedidos()).then(() => {
  server.listen(PORT, () => {
    console.log("Servidor corriendo en puerto " + PORT);
  });
});
