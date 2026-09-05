// ============================================================
//  MENU COMPARTIDO - La Cabaña
//  Este archivo es la unica fuente del menu: lo leen la pantalla
//  de caja y la pagina de pedidos en linea. Cambiar un precio aqui
//  lo cambia en las dos, no hay que tocar nada mas.
//
//  Banderas por categoria o por producto:
//    soloCaja: true     -> no aparece en la pagina de clientes
//    soloCliente: true  -> no aparece en caja
//
//  Los precios se muestran al cliente en linea; en caja los botones
//  solo llevan el nombre. Eso lo decide cada pantalla, no este archivo.
// ============================================================

(function (global) {

  // Cada pantalla pasa sus propias listas de indicaciones ("Sin queso",
  // etc.) porque no ofrecen exactamente las mismas.
  function construir(listas) {
    const { notasSandwiches } = listas;

    const menu = {

  "Aguas": {
    sabores: ["Horchata","Jamaica","Sandía","Melón","Papaya","Piña","Limón","Fresa","Guayaba","Avena"],
    tamaños: {
      "1/2 Litro": 20,
      "1 Litro": 35,
      "1.5 Litros": 50
    },
    extra: 4
  },

  "Bagels": {
    proteinas: [
      { nombre: "Jamón", precio: 45 },
      { nombre: "Choriqueso", precio: 45 },
      { nombre: "Salchicha", precio: 45 },
      { nombre: "Alambre", precio: 50 },
      { nombre: "Pollo", precio: 50 },
      { nombre: "Hamburguesa", precio: 55 },
      { nombre: "Pastor", precio: 50 },
      { nombre: "Bistec", precio: 50 },
      { nombre: "Arrachera", precio: 55 }
    ]
  },

  "Bebidas": {
    items: [
      { nombre: "Agua", precio: 0, agua: true },
      { nombre: "Coca Cola", precio: 25, sabores: ["Original 600ml", "Sin Azucar 600ml", {nombre: "Panzoncita", precio: 18}, {nombre: "Panzoncita Sin Azucar", precio: 18}, "Coca de Lata", {nombre: "Coca 3L", precio: 60}, "Coca Light"] },
      { nombre: "Refresco de Sabor", precio: 24, sabores: ["Fanta", "Sprite", "Fresca", "Sidral", "Delaware", "Squirt", "Orange", "Senzao", "Prisco", "Yoli", "Deliciosa", "Naranjada", "Toronjada", "Limonada", "Piñada", "Manzanada", "Mangada", "Fresada", "Topo Chico", "Peñafiel Mineral", "Twist", "Dr. Pepper", "Cream Soda", "Dr. Berry", "Dr. Cherry"] },
      { nombre: "Yakult", precio: 10 },
      { nombre: "Peñafielita", precio: 18, sabores: ["Limon", "Naranja", "Fresa", "Piña"] },
      { nombre: "Boing", precio: 20, sabores: ["Mango", "Guayaba", "Manzana", "Fresa", "Uva", "Naranja"] },
      { nombre: "Del Valle", precio: 24, sabores: ["Mango", "Durazno"] },
      { nombre: "Bonafont de Sabor", precio: 22, sabores: ["Naranja", "Guayaba", "Limon", "Frutos Rojos", "Piña Coco", "Pepino con Limon"] },
      { nombre: "Santa Clara", precio: 22, sabores: ["Fresa", "Chocolate", "Choco Menta", {nombre: "Hersheys", precio: 20}] },
      { nombre: "DanUp", precio: 20 },
      { nombre: "Fuze Tea", precio: 24, sabores: ["Té Negro", "Té Verde", "Durazno"] },
      { nombre: "Arizona", precio: 24, sabores: ["Mango", "Kiwi", "Sandia", "Te Verde"] },
      { nombre: "Jumex", precio: 24, sabores: ["Mango", "Manzana", "Durazno"] },
      { nombre: "Volt", precio: 30 },
      { nombre: "Electrolit", precio: 35, sabores: ["Mora", "Lima Limon", "Fresa", "Fresa Kiwi", "Horchata", "Uva"] },
      { nombre: "Gatorade", precio: 35, sabores: ["Naranja", "Mora", "Ponche"] },
      { nombre: "Monster", precio: 40 },
      { nombre: "Redbull", precio: 47 }
    ]
  },

  "Burguers": {
    items: [
      { nombre: "Ham. Sencilla", precio: 55 },
      { nombre: "Ham. Senc. c/Papas", precio: 73 },
      { nombre: "Ham. Hawaiana", precio: 65 },
      { nombre: "Ham. Hawaiana c/Papas", precio: 83 }
    ]
  },

  "Burritos": {
    precio: 52,
    proteinas: ["Pollo","Bistec","Pastor","Chorizo",{nombre:"Arrachera",precio:55},{nombre:"Campechanos",precio:55},{nombre:"Pechuga",precio:55}]
  },

  "Café": {
    items: [
      { nombre: "Café de Olla Chico", precio: 15 },
      { nombre: "Café de Olla Grande", precio: 18 },
      { nombre: "Café de Medio", precio: 25 },
      { nombre: "Café con Leche", precio: 20 },
      { nombre: "Café con Leche de Medio", precio: 30 },
      { nombre: "Capuccino Instantáneo", precio: 28, capuccino: true },
      { nombre: "Capuccino de Medio", precio: 40, capuccino: true },
      { nombre: "Espumoso Chocolate", precio: 25 },
      { nombre: "Té", precio: 18 },
      { nombre: "Agua Caliente", precio: 18 }
    ]
  },

  "Chilaquiles": {
    sencillo: 38,
    precio: 45,
    proteinas: [
      "Bistec",
      "Pollo",
      "Pastor",
      "Chorizo",
      "Huevo",
      { nombre: "Arrachera", precio: 48 },
      { nombre: "Pechuga", precio: 48 }
    ]
  },

  "Desayunos": {
    subcategorias: {
      "Paquete 1": {
        precio: 58,
        proteinas: ["Jamón","Chorizo","Champiñones","Salchicha","Nopales","A la Mexicana"],
        bebida: true
      },
      "Paquete 2": {
        directo: true,
        nombre: "Paquete 2 - Chilaquiles con Huevo",
        precio: 58,
        huevo: true,
        notas: ["Sin Queso", "Sin Crema"],
        bebida: true
      },
      "Paquete 3": {
        precio: 68,
        proteinas: ["Bistec","Pollo","Pastor","Arrachera"],
        notas: ["Sin Queso", "Sin Crema"],
        bebida: true
      },
      "Paquete 4": {
        directo: true,
        nombre: "Paquete 4 - Hot Cakes con Huevo",
        precio: 50,
        acompanamiento: ["Miel Maple", "Mermelada", "Lechera"],
        bebida: true
      },
      "Paquete 5": {
        directo: true,
        nombre: "Paquete 5 - Bisquet con Mermelada y Café con Leche",
        precio: 38,
        bebida: true
      },
      "Orden de Huevo": {
        precio: 45,
        proteinas: ["Jamón","Chorizo","Champiñones","Salchicha","Nopales","A la Mexicana"]
      },
      "HotCakes": {
        directo: true,
        nombre: "HotCakes",
        precio: 40,
        notas: ["Miel", "Lechera", "Mermelada"]
      },
      "Corn Flakes": {
        directo: true,
        nombre: "Corn Flakes",
        precio: 30
      },
      "Avocado Toast": {
        directo: true,
        nombre: "Avocado Toast",
        precio: 60,
        bebida: true
      }
    }
  },

  "Enchiladas": {
    precio: 60,
    proteinas: ["Verdes","Mole","Enfrijoladas"]
  },

  "Ensaladas": {
    items: [
      { nombre: "Pechuga Asada", precio: 58 },
      { nombre: "Pollo", precio: 58 },
      { nombre: "Pechuga Empanizada", precio: 58 },
      { nombre: "Atún", precio: 58 },
      { nombre: "Jamón con Queso", precio: 50 },
      { nombre: "Codito", precio: 35 },
      { nombre: "Verduras", precio: 35 },
      { nombre: "Económico", precio: 45, economico: true }
    ]
  },

  "Gringa": {
    directo: true,
    precio: 35,
    grupoCliente: "Gringas"
  },

  "Norteña": {
    directo: true,
    precio: 35,
    grupoCliente: "Gringas"
  },

  "Campecheña": {
    directo: true,
    precio: 38,
    soloCliente: true,
    grupoCliente: "Gringas"
  },

  "Arracheña": {
    directo: true,
    precio: 40,
    soloCliente: true,
    grupoCliente: "Gringas"
  },

  "Licuados": {
    precio: 32,
    sabores: ["Fresa","Chocolate","Plátano","Guayaba","Mamey","Avena"]
  },

  "Mollequiles": {
    sencillo: 37,
    precio: 43,
    proteinas: [
      "Pollo",
      "Bistec",
      "Pastor",
      "Chorizo",
      "Huevo",
      { nombre: "Mestizos", precio: 48 },
      { nombre: "Pechuga", precio: 48 },
      { nombre: "Campechanos", precio: 48 },
      { nombre: "Arrachera", precio: 48 }
    ]
  },

  "Molletes": {
    sencillo: 32,
    precio: 38,
    proteinas: [
      "Jamón",
      "Chorizo",
      "Combinados",
      { nombre: "Pollo", precio: 42 },
      { nombre: "Pastor", precio: 42 },
      { nombre: "Bistec", precio: 42 },
      { nombre: "Campechanos", precio: 42 },
      { nombre: "Arrachera", precio: 47 }
    ]
  },


  "Quesadillas": {
    precio: 28,
    proteinas: [
      "Tinga",
      "Pollo",
      "Chicharrón",
      "Picadillo",
      "Queso",
      "Choriqueso",
      "Champiñones con Queso",
      { nombre: "Bistec", precio: 33 }
    ]
  },

  "Sandwiches": {
    subcategorias: {
      "Sandwich": {
        proteinas: [
          { nombre: "Jamón", precio: 37 },
          { nombre: "Pierna", precio: 37 },
          { nombre: "Salchicha", precio: 37 },
          { nombre: "Huevo", precio: 37 },
          { nombre: "Pollo", precio: 40 },
          { nombre: "Atún", precio: 40 },
          { nombre: "Pechuga Empanizada", precio: 40 },
          { nombre: "Pechuga Asada", precio: 40 },
          { nombre: "Pollo c/ Mole", precio: 40 },
          { nombre: "Arrachera", precio: 45 }
        ]
      },
      "Cuernito": {
        proteinas: [
          { nombre: "Jamón", precio: 37 },
          { nombre: "Pierna", precio: 37 },
          { nombre: "Salchicha", precio: 37 },
          { nombre: "Huevo", precio: 37 },
          { nombre: "Pollo", precio: 40 },
          { nombre: "Atún", precio: 40 },
          { nombre: "Pechuga", precio: 40 },
          { nombre: "Pollo c/ Mole", precio: 40 }
        ]
      },
      "Hojaldra": {
        proteinas: [
          { nombre: "Jamón", precio: 37 },
          { nombre: "Pierna", precio: 37 },
          { nombre: "Salchicha", precio: 37 },
          { nombre: "Huevo", precio: 37 },
          { nombre: "Pollo", precio: 40 },
          { nombre: "Atún", precio: 40 },
          { nombre: "Pechuga", precio: 40 },
          { nombre: "Pollo c/ Mole", precio: 40 }
        ]
      },
      "Club Sandwich - $73": {
        directo: true,
        nombre: "Club Sandwich",
        precio: 73,
        notas: notasSandwiches
      }
    }
  },

  "Sincro": {
    items: [
      { nombre: "Jamón", precio: 50, precio1pza: 18 },
      { nombre: "Chorizo", precio: 50, precio1pza: 18 },
      { nombre: "Champiñones", precio: 50, precio1pza: 18 },
      { nombre: "Pastor", precio: 50, precio1pza: 18 },
      { nombre: "Bistec", precio: 50, precio1pza: 18 },
      { nombre: "Pollo", precio: 50, precio1pza: 18 },
      { nombre: "Hawaianas", precio: 50, precio1pza: 18 },
      { nombre: "Campechanas", precio: 55, precio1pza: 20 },
      { nombre: "Mestizas", precio: 55, precio1pza: 20 },
      { nombre: "Alambre", precio: 55, precio1pza: 20 },
      { nombre: "Arrachera", precio: 60, precio1pza: 22 },
      // En la página de clientes la arracheña ya sale en Gringas, aquí saldría repetida
      { nombre: "Arracheña", precio: 40, precio1pza: 20, soloCaja: true }
    ]
  },

  "Snacks": {
    items: [
      { nombre: "Hot Dog", precio: 17, hotdog: true, precioConPapas: 35 },
      { nombre: "2 Hot Dogs", precio: 34, hotdog: true, precioConPapas: 52 },
      { nombre: "Banderilla", precio: 27 },
      { nombre: "Banderilla con Papas", precio: 45 },
      { nombre: "Papas a la Francesa", precio: 40 },
      { nombre: "Nachos", precio: 42, nachos: true },
      { nombre: "Maruchan", precio: 25, maruchan: true },
      { nombre: "Paletas", precio: 20, paletas: true, soloCaja: true }
    ]
  },

  "Sopes": {
    sencillo: 50,
    precio: 55,
    proteinas: [
      "Chorizo",
      "Pollo",
      "Pastor",
      "Bistec",
      { nombre: "Campechanos", precio: 60 },
      { nombre: "Arrachera", precio: 60 }
    ]
  },

  "Tacos": {
    items: [
      { nombre: "Pastor", precio: 50, precioExtra: 25 },
      { nombre: "Bistec", precio: 50, precioExtra: 25 },
      { nombre: "Chuleta", precio: 50, precioExtra: 25 },
      { nombre: "Campechanos", precio: 55, precioExtra: 28 },
      { nombre: "Pechuga Empanizada", precio: 55, precioExtra: 28 },
      { nombre: "Pechuga Asada", precio: 55, precioExtra: 28 },
      { nombre: "Alambre", precio: 55, precioExtra: 28 },
      { nombre: "Tacos Dorados", precio: 55 },
      { nombre: "Arrachera", precio: 60, precioExtra: 30 }
    ]
  },

  "Tortas": {
    proteinas: [
      { nombre: "Jamón", precio: 48 },
      { nombre: "Pierna", precio: 48 },
      { nombre: "Salchicha", precio: 48 },
      { nombre: "Chorizo", precio: 48 },
      { nombre: "Chuleta", precio: 48 },
      { nombre: "Huevo", precio: 48 },

      { nombre: "Milanesa", precio: 50 },
      { nombre: "Bistec", precio: 50 },
      { nombre: "Alambre", precio: 50 },
      { nombre: "Hawaiana", precio: 50 },
      { nombre: "Enchiladas", precio: 50 },
      { nombre: "Chilaquiles", precio: 50 },
      { nombre: "Pechuga", precio: 50 },
      { nombre: "Pollo", precio: 50 },
      { nombre: "3 Quesos", precio: 50 },
      { nombre: "Vegetariana", precio: 50 },
      { nombre: "Pastor", precio: 50 },
      { nombre: "Pollo con Mole", precio: 50 },

      { nombre: "Arrachera", precio: 55 }
    ]
  },

  "Tostadas": {
    precio: 28,
    proteinas: [
      "Tinga de Pollo",
      "Picadillo",
      "Pollo"
    ]
  },

  "OTROS..": {
    soloCaja: true,
    items: [
      { nombre: "✏️ Personalizado", personalizado: true },
      { nombre: "Tupper $5", precio: 5, tupper: true },
      { nombre: "$5", precio: 5 },
      { nombre: "$7", precio: 7 },
      { nombre: "$8", precio: 8 },
      { nombre: "$9", precio: 9 },
      { nombre: "$10", precio: 10 },
      { nombre: "$12", precio: 12 },
      { nombre: "$13", precio: 13 },
      { nombre: "$15", precio: 15 },
      { nombre: "$18", precio: 18 },
      { nombre: "$20", precio: 20 },
      { nombre: "$22", precio: 22 },
      { nombre: "$24", precio: 24 },
      { nombre: "$25", precio: 25 },
      { nombre: "$28", precio: 28 },
      { nombre: "$30", precio: 30 },
      { nombre: "$100", precio: 100 },
      { nombre: "$110", precio: 110 }
    ]
  }

};

    return menu;
  }

  function visible(datos, pantalla) {
    if (datos && datos.soloCaja && pantalla !== "caja") return false;
    if (datos && datos.soloCliente && pantalla !== "cliente") return false;
    return true;
  }

  function filtrar(menu, pantalla) {
    const salida = {};
    Object.keys(menu).forEach(function (categoria) {
      const datos = menu[categoria];
      if (!visible(datos, pantalla)) return;

      // Tambien se pueden marcar productos sueltos dentro de una categoria
      if (Array.isArray(datos.items) && datos.items.some(function (i) { return i.soloCaja || i.soloCliente; })) {
        salida[categoria] = Object.assign({}, datos, {
          items: datos.items.filter(function (i) { return visible(i, pantalla); })
        });
        return;
      }

      salida[categoria] = datos;
    });
    return salida;
  }

  // ---- Precios editables desde la pagina de ventas ----
  // El servidor guarda solo los precios que se cambiaron, como
  // { "Café/items/Café de Medio/precio": 27 }. Aqui se aplican encima
  // del menu base, asi este archivo sigue siendo la estructura del menu
  // y los precios del dia viven en la base de datos.

  var preciosGuardados = {};

  var CLAVES_PRECIO = ["precio", "precioConPapas", "sencillo", "extra"];

  function esClavePrecio(clave) {
    return CLAVES_PRECIO.indexOf(clave) !== -1;
  }

  // Recorre cada precio del menu entregando su ruta (identificador estable),
  // una etiqueta legible, el valor actual y como cambiarlo.
  function recorrerPrecios(menu, fn) {
    function recorrer(nodo, ruta, partes) {
      if (Array.isArray(nodo)) {
        nodo.forEach(function (hijo, i) {
          if (hijo && typeof hijo === "object") {
            recorrer(hijo, ruta + "/" + (hijo.nombre || i), partes.concat(hijo.nombre || String(i + 1)));
          }
        });
        return;
      }
      if (!nodo || typeof nodo !== "object") return;

      Object.keys(nodo).forEach(function (clave) {
        var valor = nodo[clave];

        if (typeof valor === "number") {
          var enTamanos = /\/tamanos$/.test(ruta);
          if (!esClavePrecio(clave) && !enTamanos) return;
          var nombresClave = { precioConPapas: "con papas", sencillo: "sencillo", extra: "extra por sabor" };
          var etiqueta = partes.join(" · ");
          if (enTamanos) etiqueta += " · " + clave;
          else if (clave !== "precio") etiqueta += " · " + (nombresClave[clave] || clave);
          fn({
            ruta: ruta + "/" + clave,
            etiqueta: etiqueta,
            precio: valor,
            asignar: function (nuevo) { nodo[clave] = nuevo; }
          });
          return;
        }

        if (valor && typeof valor === "object") {
          var saltar = clave === "items" || clave === "proteinas" || clave === "subcategorias";
          recorrer(valor, ruta + "/" + clave, saltar ? partes : partes.concat(clave));
        }
      });
    }

    Object.keys(menu).forEach(function (categoria) {
      recorrer(menu[categoria], categoria, [categoria]);
    });
  }

  function aplicarPrecios(menu) {
    recorrerPrecios(menu, function (p) {
      if (Object.prototype.hasOwnProperty.call(preciosGuardados, p.ruta)) {
        p.asignar(preciosGuardados[p.ruta]);
      }
    });
    return menu;
  }

  // En caja conviene tener las gringas como categorias sueltas (un toque y
  // listo), pero al cliente se le muestran juntas bajo "Gringas". Las
  // categorias con grupoCliente se juntan en una sola con sus precios.
  function agrupar(menu) {
    const salida = {};
    const grupos = {};

    Object.keys(menu).forEach(function (categoria) {
      const datos = menu[categoria];
      if (!datos.grupoCliente) { salida[categoria] = datos; return; }

      if (!grupos[datos.grupoCliente]) {
        grupos[datos.grupoCliente] = { agrupada: true, items: [] };
        salida[datos.grupoCliente] = grupos[datos.grupoCliente];  // conserva el lugar del primero
      }
      grupos[datos.grupoCliente].items.push({ nombre: categoria, precio: datos.precio });
    });

    return salida;
  }

  global.MENU = {
    paraCaja: function (listas) { return filtrar(aplicarPrecios(construir(listas)), "caja"); },
    paraCliente: function (listas) { return agrupar(filtrar(aplicarPrecios(construir(listas)), "cliente")); },

    // El servidor inyecta aqui los precios guardados al servir este archivo
    usarPrecios: function (precios) { preciosGuardados = precios || {}; },

    // Para el editor de la pagina de ventas: todos los precios del menu
    // completo (caja y linea), ya con los cambios aplicados
    listarPrecios: function (listas) {
      var menu = aplicarPrecios(construir(listas));
      var lista = [];
      recorrerPrecios(menu, function (p) {
        lista.push({
          ruta: p.ruta,
          etiqueta: p.etiqueta,
          precio: p.precio,
          editado: Object.prototype.hasOwnProperty.call(preciosGuardados, p.ruta)
        });
      });
      return lista;
    }
  };

})(window);
