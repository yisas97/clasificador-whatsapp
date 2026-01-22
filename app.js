const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const log = pino;
const { session } = { session: "session_auth_info" };
const { Boom } = require("@hapi/boom");
const express = require("express");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const bodyParser = require("body-parser");
const app = require("express")();

const fs = require("fs");
const moment = require("moment");

// enable files upload
app.use(
  fileUpload({
    createParentPath: true,
  })
);

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
const server = require("http").createServer(app);
const io = require("socket.io")(server);
const port = process.env.PORT || 3000;
const qrcode = require("qrcode");
const messageStore = {};

app.use("/assets", express.static(__dirname + "/client/assets"));

/**
 * Pantalla de Scaneo
 */
app.get("/scan", (req, res) => {
  res.sendFile("./client/index.html", {
    root: __dirname,
  });
});

/**
 * Pantalla de Grupos
 */
app.get("/groups", (req, res) => {
  res.sendFile("./client/groups.html", {
    root: __dirname,
  });
});

app.get("/", (req, res) => {
  res.send("server working");
});

let sock;
let qrDinamic;
let soket;
let isFirstConnection = true;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("session_auth_info");

  sock = makeWASocket({
    auth: state,
    logger: log({ level: "silent" }),
  });

  console.log("Socket creado:", !!sock);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    console.log("Update recibido:", { connection, qr: !!qr });
    qrDinamic = qr;
    if (qr) {
      console.log("QR generado, emitiendo a cliente");
      updateQR("qr");
    }
    if (connection === "close") {
      console.log("Conexión cerrada.");
      console.log("lastDisconnect completo:", JSON.stringify(lastDisconnect, null, 2));

      if (!lastDisconnect?.error) {
        console.log("Conexión cerrada sin error");
        return;
      }

      // Mostrar el error completo
      console.log("Error completo:", lastDisconnect.error);
      console.log("Error data:", lastDisconnect.error.data);

      let reason = new Boom(lastDisconnect.error).output.statusCode;
      console.log("Razón de desconexión (statusCode):", reason);

      // No hacer nada si es la primera conexión y aún no se ha autenticado
      // Esto evita el loop de reconexión que interrumpe la generación del QR
      if (isFirstConnection && !sock?.user) {
        console.log("Primera conexión cerrada, esperando autenticación o QR...");
        return;
      }

      if (reason === DisconnectReason.badSession) {
        console.log(
          `Bad Session File, Please Delete ${session} and Scan Again`
        );
        sock.logout();
      } else if (reason === DisconnectReason.connectionClosed) {
        console.log("Conexión cerrada, reconectando....");
        await connectToWhatsApp();
      } else if (reason === DisconnectReason.connectionLost) {
        console.log("Conexión perdida del servidor, reconectando...");
        await connectToWhatsApp();
      } else if (reason === DisconnectReason.connectionReplaced) {
        console.log(
          "Conexión reemplazada, otra nueva sesión abierta, cierre la sesión actual primero"
        );
        sock.logout();
      } else if (reason === DisconnectReason.loggedOut) {
        console.log(
          `Dispositivo cerrado, elimínelo ${session} y escanear de nuevo.`
        );
        sock.logout();
      } else if (reason === DisconnectReason.restartRequired) {
        console.log("Se requiere reinicio, reiniciando...");
        await connectToWhatsApp();
      } else if (reason === DisconnectReason.timedOut) {
        console.log("Se agotó el tiempo de conexión, conectando...");
        await connectToWhatsApp();
      } else {
        console.log(`Motivo de desconexión: ${reason}`);
      }
    } else if (connection === "open") {
      console.log("Conexión abierta");
      isFirstConnection = false;

      try {
        const WhatsAppGroupHandler = require("./src/groupHandlers");
        // Crear una nueva instancia
        const handler = new WhatsAppGroupHandler(sock);
        // Inicializar la conexión a la BD
        await handler.init();

        // Configurar las rutas con el handler inicializado
        const groupRouter = require("./src/groupRoutes")(sock, handler);
        app.use("/api/groups", groupRouter);
        console.log(
          "Router de grupos y base de datos configurados correctamente"
        );
      } catch (error) {
        console.error(
          "Error al inicializar el handler o la base de datos:",
          error
        );
      }
    }
  });

  sock.ev.on("messages.upsert", (messageEvent) => {
    console.log("Mensaje recibido:", messageEvent.messages);
  });

  sock.ev.on("creds.update", saveCreds);

  return sock;
}

const isConnected = () => {
  return !!sock?.user;
};

app.get("/send-message", async (req, res) => {
  const tempMessage = req.query.message;
  const number = req.query.number;

  let numberWA;
  try {
    if (!number) {
      res.status(500).json({
        status: false,
        response: "El numero no existe",
      });
    } else {
      numberWA = "591" + number + "@s.whatsapp.net";

      if (isConnected()) {
        const exist = await sock.onWhatsApp(numberWA);

        if (exist?.jid || (exist && exist[0]?.jid)) {
          sock
            .sendMessage(exist.jid || exist[0].jid, {
              text: tempMessage,
            })
            .then((result) => {
              res.status(200).json({
                status: true,
                response: result,
              });
            })
            .catch((err) => {
              res.status(500).json({
                status: false,
                response: err,
              });
            });
        }
      } else {
        res.status(500).json({
          status: false,
          response: "Aun no estas conectado",
        });
      }
    }
  } catch (err) {
    res.status(500).send(err);
  }
});

io.on("connection", async (socket) => {
  console.log("Cliente conectado a socket.io");
  soket = socket;
  console.log("isConnected:", isConnected(), "qrDinamic:", !!qrDinamic);
  if (isConnected()) {
    updateQR("connected");
  } else if (qrDinamic) {
    updateQR("qr");
  }

  socket.on("requestUser", () => {
    if (sock?.user) {
      const { id, name } = sock.user;
      socket.emit("user", `${id} ${name}`);
    }
  });
});

const updateQR = (data) => {
  console.log("updateQR llamado con:", data, "soket conectado:", !!soket);
  switch (data) {
    case "qr":
      if (!qrDinamic) {
        console.log("No hay QR dinámico disponible");
        return;
      }
      qrcode.toDataURL(qrDinamic, (err, url) => {
        if (err) {
          console.error("Error generando QR URL:", err);
          return;
        }
        console.log("QR convertido a URL exitosamente, emitiendo...");
        if (soket) {
          soket.emit("qr", url);
          soket.emit("log", "QR recibido , scan");
          console.log("QR emitido al cliente");
        } else {
          console.log("No hay cliente conectado para emitir el QR");
        }
      });
      break;
    case "connected":
      soket?.emit("qrstatus", "./assets/check.svg");
      soket?.emit("log", " usaario conectado");
      const { id, name } = sock?.user;
      const userinfo = id + " " + name;
      soket?.emit("user", userinfo);
      break;
    case "loading":
      soket?.emit("qrstatus", "./assets/loader.gif");
      soket?.emit("log", "Cargando ....");
      break;
    default:
      break;
  }
};

connectToWhatsApp()
  .then(() => {
    console.log("Conexión WhatsApp iniciada");
  })
  .catch((err) => console.log("Error de conexión:", err));

server.listen(port, () => {
  console.log("Server Run Port : " + port);
});
