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
    this.MAX_MESSAGES_PER_CHAT = 5000; // Aumentado el límite de mensajes
    this.RETENTION_DAYS = 90; // Aumentado el período de retención
    this.SAVE_INTERVAL = 5 * 60 * 1000; // Guardar cada 5 minutos
    this.BACKUP_INTERVAL = 24 * 60 * 60 * 1000; // Backup diario

    // Inicializar el messageStore
    this.initializeMessageStore(messageStore);

    // Configurar intervalos de guardado y backup
    this.setupAutomaticSaving();
    this.setupMessageListener();

    // Manejar el cierre graceful
    this.setupGracefulShutdown();
  }

  getMessageStorePath() {
    return path.join(__dirname, "message_store.json");
  }

  getBackupPath() {
    const date = moment().format("YYYYMMDD_HHmmss");
    return path.join(__dirname, "backups", `message_store_${date}.json`);
  }

  setupAutomaticSaving() {
    // Guardar periódicamente
    this.saveInterval = setInterval(() => {
      this.saveMessageStore();
    }, this.SAVE_INTERVAL);

    // Hacer backup diario
    this.backupInterval = setInterval(() => {
      this.createBackup();
    }, this.BACKUP_INTERVAL);
  }

  setupMessageListener() {
    if (this.sock) {
      this.sock.ev.on("messages.upsert", (messageEvent) => {
        this.handleNewMessages(messageEvent);
      });
    }
  }

  handleNewMessages(messageEvent) {
    try {
      messageEvent.messages.forEach((msg) => {
        const chatId = msg.key.remoteJid;
        if (!chatId) return;

        // Inicializar array si no existe
        if (!this.messageStore[chatId]) {
          this.messageStore[chatId] = [];
        }

        // Verificar si el mensaje ya existe
        const messageExists = this.messageStore[chatId].some(
          (existingMsg) => existingMsg.key.id === msg.key.id
        );

        if (!messageExists) {
          this.messageStore[chatId].push(msg);
          // Mantener ordenados por timestamp
          this.messageStore[chatId].sort(
            (a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0)
          );

          // Limitar cantidad de mensajes
          if (this.messageStore[chatId].length > this.MAX_MESSAGES_PER_CHAT) {
            this.messageStore[chatId] = this.messageStore[chatId].slice(
              -this.MAX_MESSAGES_PER_CHAT
            );
          }
        }
      });
    } catch (error) {
      console.error("Error al manejar nuevos mensajes:", error);
    }
  }

  async getStorageStats() {
    let stats = {
      totalGroups: 0,
      totalMessages: 0,
      oldestMessage: null,
      newestMessage: null,
      averageMessagesPerGroup: 0,
      storageSize: 0,
    };

    try {
      stats.totalGroups = Object.keys(this.messageStore).length;

      for (const messages of Object.values(this.messageStore)) {
        stats.totalMessages += messages.length;

        if (messages.length > 0) {
          const timestamps = messages
            .map((msg) => msg.messageTimestamp)
            .filter((ts) => ts);

          const oldest = Math.min(...timestamps);
          const newest = Math.max(...timestamps);

          if (!stats.oldestMessage || oldest < stats.oldestMessage) {
            stats.oldestMessage = oldest;
          }
          if (!stats.newestMessage || newest > stats.newestMessage) {
            stats.newestMessage = newest;
          }
        }
      }

      stats.averageMessagesPerGroup =
        stats.totalGroups > 0
          ? Math.round(stats.totalMessages / stats.totalGroups)
          : 0;

      const storeSize = fs.statSync(this.getMessageStorePath()).size;
      stats.storageSize = Math.round((storeSize / (1024 * 1024)) * 100) / 100; // MB

      return stats;
    } catch (error) {
      console.error("Error al obtener estadísticas:", error);
      return stats;
    }
  }

  cleanAndSaveMessageStore() {
    try {
      const retentionTime = moment()
        .subtract(this.RETENTION_DAYS, "days")
        .unix();

      // Limpiar mensajes antiguos
      Object.keys(this.messageStore).forEach((chatId) => {
        const messages = this.messageStore[chatId];

        // Filtrar mensajes dentro del período de retención
        const filteredMessages = messages.filter(
          (msg) => (msg.messageTimestamp || 0) >= retentionTime
        );

        if (filteredMessages.length !== messages.length) {
          console.log(
            `Limpiando chat ${chatId}: ${
              messages.length - filteredMessages.length
            } mensajes antiguos eliminados`
          );
        }

        this.messageStore[chatId] = filteredMessages;
      });

      // Guardar en archivo
      this.saveMessageStore();
    } catch (error) {
      console.error("Error en limpieza de mensajes:", error);
    }
  }

  setupGracefulShutdown() {
    process.on("SIGINT", async () => {
      console.log("Cerrando aplicación, guardando mensajes...");
      await this.saveMessageStore();
      await this.createBackup();
      clearInterval(this.saveInterval);
      clearInterval(this.backupInterval);
      process.exit(0);
    });
  }

  async createBackup() {
    try {
      const backupDir = path.join(__dirname, "backups");
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir);
      }

      const backupPath = this.getBackupPath();
      fs.writeFileSync(backupPath, JSON.stringify(this.messageStore, null, 2));
      console.log(`Backup creado en: ${backupPath}`);

      // Mantener solo los últimos 7 backups
      const backups = fs
        .readdirSync(backupDir)
        .filter((file) => file.startsWith("message_store_"))
        .sort()
        .reverse();

      if (backups.length > 7) {
        backups.slice(7).forEach((file) => {
          fs.unlinkSync(path.join(backupDir, file));
        });
      }
    } catch (error) {
      console.error("Error al crear backup:", error);
    }
  }

  async recoverFromBackup() {
    try {
      const backupDir = path.join(__dirname, "backups");
      if (!fs.existsSync(backupDir)) return;

      const backups = fs
        .readdirSync(backupDir)
        .filter((file) => file.startsWith("message_store_"))
        .sort()
        .reverse();

      if (backups.length > 0) {
        const lastBackup = path.join(backupDir, backups[0]);
        const data = fs.readFileSync(lastBackup, "utf8");
        this.messageStore = JSON.parse(data);
        console.log(`Recuperado del backup: ${lastBackup}`);
      }
    } catch (error) {
      console.error("Error al recuperar del backup:", error);
      this.messageStore = {};
    }
  }

  async cleanAndVerifyStore() {
    const cutoffTime = moment().subtract(this.RETENTION_DAYS, "days").unix();
    let totalMessagesBefore = 0;
    let totalMessagesAfter = 0;

    for (const chatId of Object.keys(this.messageStore)) {
      if (!Array.isArray(this.messageStore[chatId])) {
        this.messageStore[chatId] = [];
        continue;
      }

      totalMessagesBefore += this.messageStore[chatId].length;

      // Filtrar mensajes válidos y dentro del período de retención
      this.messageStore[chatId] = this.messageStore[chatId]
        .filter((msg) => {
          return (
            msg &&
            msg.messageTimestamp &&
            msg.messageTimestamp > cutoffTime &&
            msg.key &&
            msg.key.remoteJid
          );
        })
        .sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));

      // Limitar cantidad de mensajes por chat
      if (this.messageStore[chatId].length > this.MAX_MESSAGES_PER_CHAT) {
        this.messageStore[chatId] = this.messageStore[chatId].slice(
          -this.MAX_MESSAGES_PER_CHAT
        );
      }

      totalMessagesAfter += this.messageStore[chatId].length;
    }

    console.log(
      `Limpieza completada: ${totalMessagesBefore} -> ${totalMessagesAfter} mensajes`
    );
  }

  async initializeMessageStore(initialMessageStore) {
    try {
      // Cargar mensajes del archivo principal
      await this.loadMessageStore();

      // Integrar mensajes iniciales si existen
      if (initialMessageStore && Object.keys(initialMessageStore).length > 0) {
        for (const [chatId, messages] of Object.entries(initialMessageStore)) {
          if (!this.messageStore[chatId]) {
            this.messageStore[chatId] = [];
          }
          this.messageStore[chatId].push(...messages);
        }
        await this.saveMessageStore();
      }

      console.log("Message store inicializado con éxito");
    } catch (error) {
      console.error("Error al inicializar message store:", error);
      throw error;
    }
  }

  async loadMessageStore() {
    const storePath = this.getMessageStorePath();
    try {
      if (fs.existsSync(storePath)) {
        const data = fs.readFileSync(storePath, "utf8");
        this.messageStore = JSON.parse(data);
        console.log(`Mensajes cargados de ${storePath}`);

        // Verificar integridad y limpiar mensajes antiguos
        await this.cleanAndVerifyStore();
      }
    } catch (error) {
      console.error("Error al cargar message store:", error);
      // Si hay error al cargar, intentar recuperar del último backup
      await this.recoverFromBackup();
    }
  }

  async saveMessageStore() {
    try {
      const storePath = this.getMessageStorePath();
      await this.cleanAndVerifyStore();
      fs.writeFileSync(storePath, JSON.stringify(this.messageStore, null, 2));
      console.log(`Message store guardado en: ${storePath}`);
    } catch (error) {
      console.error("Error al guardar message store:", error);
      // Intentar crear un backup en caso de error al guardar
      await this.createBackup();
    }
  }

  addMessage(chatId, message) {
    if (!this.messageStore[chatId]) {
      this.messageStore[chatId] = [];
    }
    this.messageStore[chatId].push(message);

    // Ordenar mensajes por timestamp
    this.messageStore[chatId].sort(
      (a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0)
    );

    // Si superamos el límite, eliminar los más antiguos
    if (this.messageStore[chatId].length > this.MAX_MESSAGES_PER_CHAT) {
      this.messageStore[chatId] = this.messageStore[chatId].slice(
        -this.MAX_MESSAGES_PER_CHAT
      );
    }
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

  async getGroupMessageCount(groupId) {
    return this.messageStore[groupId]?.length || 0;
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
            const ppUrl = await this.sock.profilePictureUrl(id, "image");
            imageUrl = ppUrl;
          } catch (error) {
            console.log(
              `No se pudo obtener la imagen para el grupo ${group.subject}:`,
              error
            );
            imageUrl = null;
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
    if (msg.message?.imageMessage) return "<Multimedia omitido>";
    if (msg.message?.videoMessage) return "<Multimedia omitido>";
    if (msg.message?.documentMessage) return "<Multimedia omitido>";
    if (msg.message?.audioMessage) return "<Multimedia omitido>";
    if (msg.message?.stickerMessage) return "<Multimedia omitido>";
    return "<Multimedia omitido>";
  }

  async getGroupMessagesAsString(groupId = null, days = 30) {
    await this.waitForConnection();

    const cutoffTime = moment().subtract(days, "days").unix();
    const groups = groupId
      ? [groupId]
      : Object.keys(await this.sock.groupFetchAllParticipating());

    let allMessages = "";

    for (const group of groups) {
      try {
        const metadata = await this.sock.groupMetadata(group);
        const messages = this.messageStore[group] || [];
        const filteredMessages = messages.filter(
          (msg) => msg.messageTimestamp >= cutoffTime
        );

        console.log(`Grupo ${metadata.subject}:`);
        console.log(`- Total mensajes: ${messages.length}`);
        console.log(
          `- Mensajes en período (${days} días): ${filteredMessages.length}`
        );

        for (const msg of filteredMessages) {
          if (msg.key.participant) {
            const date = moment(msg.messageTimestamp * 1000).format("DD/MM/YY");
            const time = moment(msg.messageTimestamp * 1000).format("HH:mm");
            const sender = msg.key.participant.split("@")[0];
            const content = this.getMessageContent(msg);

            if (content.trim()) {
              allMessages += `${date}, ${time} - ${sender}: ${content}\n`;
            }
          }
        }
      } catch (error) {
        console.error(`Error procesando grupo ${group}:`, error);
      }
    }

    if (!allMessages.trim()) {
      throw new Error("No se encontraron mensajes en el grupo");
    }

    // Log para debugging
    console.log("===== MUESTRA DE MENSAJES =====");
    console.log(allMessages.split("\n").slice(0, 5).join("\n"));
    console.log("===============================");

    return allMessages;
  }
}

module.exports = WhatsAppGroupHandler;
