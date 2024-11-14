const moment = require("moment");
const DatabaseHandler = require("./database");
const fs = require("fs");
const FormData = require("form-data");
const axios = require("axios");
const path = require("path");

class WhatsAppGroupHandler {
  constructor(sock, store) {
    if (!sock) {
      throw new Error("Socket es requerido");
    }

    this.sock = sock;
    this.store = store;
    this.db = new DatabaseHandler();
    this.setupMessageListener();
    this.isConnected = false;
    this.connectionRetries = 0;
    this.maxRetries = 3;
    this.retryDelay = 60000; 
  }

  async init() {
    await this.db.init();
    this.setupConnectionMonitor();
  }

  setupConnectionMonitor() {
    if (this.sock) {
      this.sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "open") {
          console.log("Conexión establecida en el handler");
          this.isConnected = true;
          this.connectionRetries = 0;
        } else if (connection === "close") {
          this.isConnected = false;
          if (
            lastDisconnect?.error?.output?.statusCode !==
            DisconnectReason.loggedOut
          ) {
            await this.handleReconnection();
          }
        }
      });
    }
  }

  async handleReconnection() {
    if (this.connectionRetries >= this.maxRetries) {
      console.log("Máximo número de intentos de reconexión alcanzado");
      return;
    }

    this.connectionRetries++;
    console.log(
      `Intento de reconexión ${this.connectionRetries} de ${this.maxRetries}`
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, this.retryDelay));
      await this.waitForConnection(30000);
    } catch (error) {
      console.error("Error en la reconexión:", error);
    }
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
    try {
      const messages = await this.db.getGroupMessages(groupId);
      return messages.length;
    } catch (error) {
      console.error(
        `Error obteniendo conteo de mensajes para grupo ${groupId}:`,
        error
      );
      return 0;
    }
  }

  async listGroups() {
    try {
      await this.waitForConnection();

      if (!this.isConnected) {
        throw new Error("No hay conexión activa con WhatsApp");
      }

      console.log("Obteniendo lista de grupos...");
      const groups = await this.sock.groupFetchAllParticipating();
      console.log("Grupos obtenidos:", Object.keys(groups).length);

      const gruposDetallados = await Promise.all(
        Object.entries(groups).map(async ([id, group]) => {
          try {
            let imageUrl = null;
            try {
              const ppUrl = await this.sock.profilePictureUrl(id, "image");
              imageUrl = ppUrl;
            } catch (error) {
              console.log(
                `No se pudo obtener la imagen para el grupo ${group.subject}`
              );
            }

            let inviteCode = null;
            try {
              inviteCode = await this.sock.groupInviteCode(id);
            } catch (error) {
              console.log(
                `No se pudo obtener el código de invitación para el grupo ${group.subject}`
              );
            }

            await this.db.saveGroup({
              id: id,
              subject: group.subject,
              desc: group.desc,
              owner: group.owner,
              creation: group.creation,
              participants: group.participants,
            });

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
          } catch (error) {
            console.error(`Error procesando grupo ${id}:`, error);
            return {
              id,
              nombre: group.subject,
              participantes: group.participants?.length || 0,
              creador: "No disponible",
              descripcion: "Error al cargar descripción",
              imagen: null,
              inviteCode: null,
              creacion: null,
              restrict: false,
              announce: false,
              mensajesAlmacenados: 0,
            };
          }
        })
      );

      return gruposDetallados.filter((group) => group !== null);
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
      if (this.isConnected) {
        console.log("Conexión ya establecida");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (!this.sock?.user) {
      throw new Error("Timeout esperando conexión");
    }

    this.isConnected = true;
    console.log("Conexión establecida correctamente");
  }

  async getTopics(groupId) {
    try {
      const messages = await this.getGroupMessagesAsString(groupId);

      const tempFile = `temp_chat_${Date.now()}.txt`;
      fs.writeFileSync(tempFile, messages);

      const formData = new FormData();
      formData.append("file", fs.createReadStream(tempFile));
      formData.append("method", "lda");

      const response = await axios.post(
        "http://localhost:8000/analyze",
        formData,
        {
          headers: formData.getHeaders(),
          responseType: "json",
        }
      );

      fs.unlinkSync(tempFile);

      if (response.data && response.data.topics) {
        return response.data.topics;
      }
      throw new Error("Error al analizar temas");
    } catch (error) {
      console.error("Error en getTopics:", error);
      throw error;
    }
  }

  async getTopicMessages(groupId, topicId) {
    try {
      const topics = await this.getTopics(groupId);
      return topics[topicId]?.messages || [];
    } catch (error) {
      console.error("Error en getTopicMessages:", error);
      throw error;
    }
  }
}

module.exports = WhatsAppGroupHandler;
