const moment = require("moment");
const fs = require("fs");
const path = require("path");

class WhatsAppGroupHandler {
  constructor(sock, store, messageStore) {
    console.log(
      "Inicializando WhatsAppGroupHandler con socket, store y messageStore:",
      !!sock,
      !!store,
      !!messageStore
    );

    if (!sock) {
      console.error("Socket no disponible al crear WhatsAppGroupHandler");
      throw new Error("Socket es requerido");
    }
    if (!store) {
      console.error("Store no disponible al crear WhatsAppGroupHandler");
      throw new Error("Store es requerido");
    }
    if (!messageStore) {
      console.error("messageStore no disponible al crear WhatsAppGroupHandler");
      throw new Error("messageStore es requerido");
    }

    this.sock = sock;
    this.store = store;
    this.messageStore = this.loadMessageStore(messageStore);

    // Configurar guardado automático cada 5 minutos
    this.autoSaveInterval = setInterval(() => {
      this.saveMessageStore();
    }, 5 * 60 * 1000);

    // Guardar mensajes antes de cerrar el programa
    process.on("SIGINT", () => {
      this.saveMessageStore();
      clearInterval(this.autoSaveInterval);
      process.exit();
    });
  }

  getMessageStorePath() {
    return path.join(__dirname, "message_store.json");
  }

  loadMessageStore(initialMessageStore) {
    const storePath = this.getMessageStorePath();
    try {
      if (fs.existsSync(storePath)) {
        const storedData = JSON.parse(fs.readFileSync(storePath, "utf8"));
        console.log(
          "Mensajes cargados del archivo:",
          Object.keys(storedData).length,
          "chats"
        );
        return { ...storedData, ...initialMessageStore };
      }
    } catch (error) {
      console.error("Error al cargar el message store:", error);
    }
    return initialMessageStore;
  }

  saveMessageStore() {
    const storePath = this.getMessageStorePath();
    try {
      fs.writeFileSync(storePath, JSON.stringify(this.messageStore, null, 2));
      console.log("Message store guardado en:", storePath);
    } catch (error) {
      console.error("Error al guardar el message store:", error);
    }
  }

  addMessage(chatId, message) {
    if (!this.messageStore[chatId]) {
      this.messageStore[chatId] = [];
    }
    this.messageStore[chatId].push(message);

    // Limitar el número de mensajes almacenados por chat (últimas 24 horas)
    const oneDayAgo = moment().subtract(24, "hours").unix();
    this.messageStore[chatId] = this.messageStore[chatId].filter(
      (msg) => msg.messageTimestamp >= oneDayAgo
    );
  }

  async waitForConnection(timeout = 30000) {
    console.log("Esperando conexión...");
    const startTime = Date.now();

    while (!this.sock?.user && Date.now() - startTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      console.log(
        "Verificando conexión... Usuario disponible:",
        !!this.sock?.user
      );
    }

    if (!this.sock?.user) {
      console.error("Timeout esperando conexión");
      throw new Error("Timeout esperando conexión");
    }

    console.log("Conexión establecida correctamente");
  }

  async listGroups() {
    await this.waitForConnection();
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      console.log(groups);

      const gruposDetallados = await Promise.all(
        Object.entries(groups).map(async ([id, group]) => {
          let imageUrl = null;
          try {
            // Intentar obtener la imagen del grupo
            const ppUrl = await this.sock.profilePictureUrl(id, "image");
            imageUrl = ppUrl;
          } catch (error) {
            console.log(
              `No se pudo obtener la imagen para el grupo ${group.subject}:`,
              error
            );
            // Si no hay imagen, usar null
            imageUrl = null;
          }

          let inviteCode = null;
          try {
            // Intentar obtener el código de invitación
            inviteCode = await this.sock.groupInviteCode(id);
          } catch (error) {
            console.log(
              `No se pudo obtener el código de invitación para el grupo ${group.subject}:`,
              error
            );
          }

          return {
            id,
            nombre: group.subject,
            participantes: group.participants.length,
            creador: group.owner || "No disponible",
            descripcion: group.desc || "Sin descripción",
            imagen: imageUrl,
            inviteCode: inviteCode,
            creacion: group.creation || null,
            restrict: group.restrict || false,
            announce: group.announce || false,
          };
        })
      );

      /**
      return Object.entries(groups).map(([id, group]) => ({
        id,
        nombre: group.subject,
        participantes: group.participants.length,
        creador: group.owner || "No disponible",
        descripcion: group.desc || "Sin descripción",
      }));
      **/
      console.log("Grupos procesados con detalles:", gruposDetallados);
      return gruposDetallados;
    } catch (error) {
      console.error("Error al listar grupos:", error);
      throw error;
    }
  }

  async exportGroupMessages(groupId = null) {
    await this.waitForConnection();

    const tenHoursAgo = moment().subtract(10, "hours").unix();
    const groups = groupId
      ? [groupId]
      : Object.keys(await this.sock.groupFetchAllParticipating());

    let allMessages = "";

    for (const group of groups) {
      try {
        const metadata = await this.sock.groupMetadata(group);
        allMessages += `\nGrupo: ${metadata.subject}\n`;
        allMessages += `Exportado: ${moment().format("DD/MM/YY HH:mm:ss")}\n\n`;

        const messages = this.messageStore[group] || [];
        const recentMessages = messages.filter(
          (msg) => msg.messageTimestamp >= tenHoursAgo
        );

        for (const msg of recentMessages) {
          if (msg.key.participant) {
            allMessages += this.formatMessage(msg, msg.key.participant);
          }
        }

        allMessages += "\n-------------------\n";
      } catch (error) {
        console.error(`Error procesando grupo ${group}:`, error);
      }
    }

    const fileName = `chat_export_${moment().format("YYYYMMDD_HHmmss")}.txt`;
    fs.writeFileSync(fileName, allMessages);

    console.log(`Archivo creado: ${fileName} con contenido:\n`, allMessages);
    return fileName;
  }

  formatMessage(msg, participant) {
    const date = moment(msg.messageTimestamp * 1000).format(
      "DD/MM/YY HH:mm:ss"
    );
    const sender = participant.split("@")[0];
    let content = this.getMessageContent(msg);
    return `[${date}] ${sender}: ${content}\n`;
  }

  getMessageContent(msg) {
    if (msg.message?.conversation) return msg.message.conversation;
    if (msg.message?.extendedTextMessage?.text)
      return msg.message.extendedTextMessage.text;
    if (msg.message?.imageMessage?.caption)
      return `<imagen: ${msg.message.imageMessage.caption}>`;
    if (msg.message?.videoMessage?.caption)
      return `<video: ${msg.message.videoMessage.caption}>`;
    if (msg.message?.documentMessage)
      return `<documento: ${msg.message.documentMessage.fileName}>`;
    if (msg.message?.audioMessage) return "<audio>";
    return "<mensaje multimedia>";
  }
}

module.exports = WhatsAppGroupHandler;
