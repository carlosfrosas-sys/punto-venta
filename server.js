const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(__dirname + "/public"));
app.get("/caja", (req, res) => {
  res.sendFile(__dirname + "/public/caja.html");
});

app.get("/cocina", (req, res) => {
  res.sendFile(__dirname + "/public/cocina.html");
});

app.get("/entrega", (req, res) => {
  res.sendFile(__dirname + "/public/entrega.html");
});
let pedidos = [];
let idCounter = 1;

app.post("/pedido", (req, res) => {
  const pedido = {
    id: idCounter++,
    cliente: req.body.cliente,
    productos: req.body.productos,
    total: req.body.total,
    estado: "pendiente"
  };

  pedidos.push(pedido);

  io.emit("nuevoPedido", pedido);   // 👈 ESTA LÍNEA ES CLAVE

  res.json(pedido);
});

app.get("/pedidos", (req, res) => {
  res.json(pedidos);
});

app.put("/pedido/:id", (req, res) => {
  const pedido = pedidos.find(p => p.id == req.params.id);
  if (pedido) {
    pedido.estado = req.body.estado;
    io.emit("actualizarPedido", pedido);
    res.json(pedido);
  } else {
    res.status(404).send("No encontrado");
  }
});

app.get("/total", (req, res) => {
  const total = pedidos
    .filter(p => p.estado === "Entregado")
    .reduce((acc, p) => acc + p.total, 0);

  res.json({ total });
});

app.post("/pedido/entregado/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const pedido = pedidos.find(p => p.id === id);

  if (pedido) {
    pedido.estado = "Entregado";
    io.emit("pedidoEliminado", id);  // 👈 ESTA LÍNEA FALTABA
  }

  res.sendStatus(200);
});

server.listen(3000, () => {
  console.log("Servidor corriendo en puerto 3000");
});