const moment = require("moment");
const DatabaseHandler = require("./database");

class WhatsAppGroupHandler {
  constructor(sock, store) {
    if (!sock) {
      throw new Error("Socket es requerido");
    }

    this.sock = sock;
    this.store = store;
    this.db = new DatabaseHandler();
    this.setupMessageListener();
  }

  async init() {
    await this.db.init();
  }

  setupMessageListener() {
    if (this.sock) {
      this.sock.ev.on("messages.upsert", (messageEvent) => {
        this.handleNewMessages(messageEvent);
      });
    }
  }

  async handleNewMessages(messageEvent) {
    try {
      for (const msg of messageEvent.messages) {
        const chatId = msg.key.remoteJid;
        if (chatId?.endsWith("@g.us")) {
          await this.db.saveMessage(msg);
        }
      }
    } catch (error) {
      console.error("Error al manejar nuevos mensajes:", error);
    }
  }

  async getGroupMessageCount(groupId) {
    const messages = await this.db.getGroupMessages(groupId);
    return messages.length;
  }

  async listGroups() {
    await this.waitForConnection();
    try {
      const groups = await this.sock.groupFetchAllParticipating();

      const gruposDetallados = await Promise.all(
        Object.entries(groups).map(async ([id, group]) => {
          let imageUrl = null;
          try {
            const ppUrl = await this.sock.profilePictureUrl(id, "image");
            imageUrl = ppUrl;
          } catch (error) {
            console.log(
              `No se pudo obtener la imagen para el grupo ${group.subject}:`,
              error
            );
          }

          let inviteCode = null;
          try {
            inviteCode = await this.sock.groupInviteCode(id);
          } catch (error) {
            console.log(
              `No se pudo obtener el código de invitación para el grupo ${group.subject}:`,
              error
            );
          }

          // Guardar grupo en la base de datos
          await this.db.saveGroup(group);

          const messageCount = await this.getGroupMessageCount(id);

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
            mensajesAlmacenados: messageCount,
          };
        })
      );
      return gruposDetallados;
    } catch (error) {
      console.error("Error al listar grupos:", error);
      throw error;
    }
  }

  async exportGroupMessages(groupId = null) {
    await this.waitForConnection();

    const groups = groupId
      ? [groupId]
      : Object.keys(await this.sock.groupFetchAllParticipating());

    let allMessages = "";

    for (const group of groups) {
      try {
        const metadata = await this.sock.groupMetadata(group);
        allMessages += `\nGrupo: ${metadata.subject}\n`;
        allMessages += `Exportado: ${moment().format("DD/MM/YY HH:mm:ss")}\n\n`;

        const messages = await this.db.getGroupMessages(group, 10); // últimas 10 horas

        for (const msg of messages) {
          allMessages += this.formatMessage(msg);
        }

        allMessages += "\n-------------------\n";
      } catch (error) {
        console.error(`Error procesando grupo ${group}:`, error);
      }
    }

    return allMessages;
  }

  formatMessage(msg) {
    const date = moment(msg.timestamp * 1000).format("DD/MM/YY HH:mm:ss");
    const sender = msg.sender_jid.split("@")[0];
    return `[${date}] ${sender}: ${msg.content}\n`;
  }

  async getGroupMessagesAsString(groupId = null, days = 30) {
    await this.waitForConnection();

    const groups = groupId
      ? [groupId]
      : Object.keys(await this.sock.groupFetchAllParticipating());

    let allMessages = "";

    for (const group of groups) {
      try {
        const metadata = await this.sock.groupMetadata(group);
        const messages = await this.db.getGroupMessages(group, days);

        console.log(`Grupo ${metadata.subject}:`);
        console.log(`- Total mensajes: ${messages.length}`);

        for (const msg of messages) {
          const date = moment(msg.timestamp * 1000).format("DD/MM/YY");
          const time = moment(msg.timestamp * 1000).format("HH:mm");
          const sender = msg.sender_jid.split("@")[0];

          if (msg.content.trim()) {
            allMessages += `${date}, ${time} - ${sender}: ${msg.content}\n`;
          }
        }
      } catch (error) {
        console.error(`Error procesando grupo ${group}:`, error);
      }
    }

    if (!allMessages.trim()) {
      throw new Error("No se encontraron mensajes en el grupo");
    }

    return allMessages;
  }

  async waitForConnection(timeout = 30000) {
    console.log("Esperando conexión...");
    const startTime = Date.now();

    while (!this.sock?.user && Date.now() - startTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (!this.sock?.user) {
      throw new Error("Timeout esperando conexión");
    }

    console.log("Conexión establecida correctamente");
  }
}

module.exports = WhatsAppGroupHandler;
