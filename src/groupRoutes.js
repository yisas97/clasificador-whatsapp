const express = require("express");
const router = express.Router();
const fs = require("fs");
const axios = require("axios");
const FormData = require("form-data");

module.exports = function (sock, store, handler) {
  console.log("Inicializando rutas con socket y handler:", !!sock, !!handler);

  if (!sock) {
    console.error("Socket no disponible al inicializar rutas");
    throw new Error("Socket es requerido para inicializar las rutas");
  }

  if (!handler) {
    console.error("Handler no disponible al inicializar rutas");
    throw new Error("Handler es requerido");
  }

  router.get("/chat", (req, res) => {
    res.sendFile("chat.html", {
      root: "./client",
      headers: {
        "Content-Type": "text/html",
      },
    });
  });

  // Obtener mensajes de un grupo
  router.get("/get-messages", async (req, res) => {
    try {
      const groupId = req.query.groupId;
      const days = parseInt(req.query.days) || 7; // Por defecto 7 días

      const messages = await handler.db.getGroupMessages(groupId, days);
      res.json({ status: true, messages });
    } catch (error) {
      console.error("Error obteniendo mensajes:", error);
      res.status(500).json({
        status: false,
        error: error.message,
      });
    }
  });

  // Enviar mensaje a un grupo
  router.post("/send-message", async (req, res) => {
    try {
      const { groupId, message } = req.body;

      if (!groupId || !message) {
        throw new Error("GroupId y mensaje son requeridos");
      }

      const result = await sock.sendMessage(groupId, { text: message });
      res.json({ status: true, result });
    } catch (error) {
      console.error("Error enviando mensaje:", error);
      res.status(500).json({
        status: false,
        error: error.message,
      });
    }
  });

  router.get("/list-groups", async (req, res) => {
    try {
      console.log("Solicitando lista de grupos");

      // Intentar reconectar
      if (!handler.isConnected) {
        await handler.waitForConnection();
      }

      const groups = await handler.listGroups();
      res.json({ status: true, grupos: groups });
    } catch (error) {
      console.error("Error al listar grupos:", error);
      if (
        error.message.includes("Connection Closed") ||
        error.message.includes("No hay conexión")
      ) {
        try {
          await handler.handleReconnection();
          const groups = await handler.listGroups();
          res.json({ status: true, grupos: groups });
        } catch (retryError) {
          res.status(503).json({
            status: false,
            error: "Error de conexión. Por favor, refresque la página.",
            details: retryError.message,
          });
        }
      } else {
        res.status(500).json({
          status: false,
          error: error.message,
        });
      }
    }
  });

  router.get("/export-group-messages", async (req, res) => {
    try {
      const messages = await handler.exportGroupMessages(req.query.groupId);
      const fileName = `chat_export_${Date.now()}.txt`;
      fs.writeFileSync(fileName, messages);

      res.download(fileName, (err) => {
        if (err) console.error("Error enviando archivo:", err);
        fs.unlinkSync(fileName);
      });
    } catch (error) {
      res.status(500).json({
        status: false,
        error: error.message,
      });
    }
  });

  router.get("/export-and-analyze-group", async (req, res) => {
    let tempFileName = null;

    try {
      const days = parseInt(req.query.days) || 30;
      const messages = await handler.getGroupMessagesAsString(
        req.query.groupId,
        days
      );

      console.log(
        `Total de mensajes encontrados: ${messages.split("\n").length}`
      );
      console.log(`Período analizado: ${days} días`);

      tempFileName = `temp_chat_${Date.now()}.txt`;
      fs.writeFileSync(tempFileName, messages, "utf8");

      const formData = new FormData();
      formData.append("file", fs.createReadStream(tempFileName));

      const messageCount = messages.split("\n").length;
      const method = messageCount < 10 ? "kmeans" : req.query.method || "lda";

      formData.append("method", method);
      formData.append("generate_summary", req.query.generate_summary || "true");

      const analysisResponse = await axios.post(
        "http://localhost:8000/analyze",
        formData,
        {
          headers: {
            ...formData.getHeaders(),
          },
          responseType: "arraybuffer",
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        }
      );

      res.set({
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename=analisis_chat_${Date.now()}.zip`,
      });
      res.send(Buffer.from(analysisResponse.data));
    } catch (error) {
      console.error("Error completo:", error);
      res.status(500).json({
        status: false,
        error: error.message,
        details: error.response?.data
          ? error.response.data.toString()
          : "No hay detalles adicionales",
      });
    } finally {
      if (tempFileName && fs.existsSync(tempFileName)) {
        try {
          fs.unlinkSync(tempFileName);
          console.log(`Archivo temporal eliminado: ${tempFileName}`);
        } catch (err) {
          console.error(`Error al eliminar archivo temporal: ${err.message}`);
        }
      }
    }
  });

  router.get("/analyze-topics", async (req, res) => {
    try {
      const groupId = req.query.groupId;
      if (!groupId) {
        throw new Error("GroupId es requerido");
      }

      // Obtener los mensajes del grupo
      const messages = await handler.getGroupMessagesAsString(groupId);

      // Crear un archivo temporal con los mensajes
      const tempFile = `temp_chat_${Date.now()}.txt`;
      fs.writeFileSync(tempFile, messages);

      // Llamar al servicio de Python
      const formData = new FormData();
      formData.append("file", fs.createReadStream(tempFile));
      formData.append("method", "lda");

      const response = await axios.post(
        "http://localhost:8000/analyze",
        formData,
        {
          headers: {
            ...formData.getHeaders(),
          },
          responseType: "json",
        }
      );

      // Procesar la respuesta
      if (response.data && response.data.topics) {
        res.json({
          status: true,
          topics: response.data.topics,
        });
      } else {
        throw new Error("Error en el análisis de temas");
      }
    } catch (error) {
      console.error("Error analizando temas:", error);
      res.status(500).json({
        status: false,
        error: error.message,
      });
    }
  });

  router.get("/storage-stats", async (req, res) => {
    try {
      const stats = await handler.db.getStorageStats();
      res.json({ status: true, stats });
    } catch (error) {
      res.status(500).json({
        status: false,
        error: error.message,
      });
    }
  });

  router.get("/current-user", (req, res) => {
    try {
      if (sock?.user) {
        res.json({
          status: true,
          user: {
            id: sock.user.id.split(":")[0],
            name: sock.user.name,
          },
        });
      } else {
        throw new Error("Usuario no encontrado");
      }
    } catch (error) {
      res.status(500).json({
        status: false,
        error: error.message,
      });
    }
  });

  router.get("/topics", (req, res) => {
    res.sendFile("topics.html", { root: "./client" });
  });

  router.get("/topic-info", async (req, res) => {
    try {
      const { groupId, topic } = req.query;
      const topics = await handler.getTopics(groupId);

      if (topics && topics[topic]) {
        const groupInfo = await handler.getGroupInfo(groupId);
        res.json({
          status: true,
          groupName: groupInfo.subject,
          topic: topics[topic],
        });
      } else {
        throw new Error("Tema no encontrado");
      }
    } catch (error) {
      res.status(500).json({
        status: false,
        error: error.message,
      });
    }
  });

  router.get("/topic-messages", async (req, res) => {
    try {
      const { groupId, topic } = req.query;
      const messages = await handler.getTopicMessages(groupId, topic);

      res.json({
        status: true,
        messages,
      });
    } catch (error) {
      res.status(500).json({
        status: false,
        error: error.message,
      });
    }
  });

  return router;
};
