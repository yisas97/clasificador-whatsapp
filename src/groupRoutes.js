const express = require("express");
const router = express.Router();
const fs = require("fs");
const axios = require("axios");
const FormData = require("form-data");
const WhatsAppGroupHandler = require("./groupHandlers");

module.exports = function (sock, store, messageStore) {
  console.log("Inicializando rutas con socket:", !!sock);

  if (!sock) {
    console.error("Socket no disponible al inicializar rutas");
    throw new Error("Socket es requerido para inicializar las rutas");
  }

  const handler = new WhatsAppGroupHandler(sock, store, messageStore);

  router.get("/list-groups", async (req, res) => {
    try {
      console.log("Solicitando lista de grupos");
      const groups = await handler.listGroups();
      res.json({ status: true, grupos: groups });
    } catch (error) {
      console.error("Error al listar grupos:", error);
      res.status(500).json({
        status: false,
        error: error.message,
      });
    }
  });

  router.get("/export-group-messages", async (req, res) => {
    try {
      const fileName = await handler.exportGroupMessages(req.query.groupId);
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
      const days = parseInt(req.query.days) || 30; // Parámetro nuevo para días
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
      console.log(`Usando método: ${method} para ${messageCount} mensajes`);

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

      let errorDetails;
      if (error.response?.data) {
        try {
          const errorText = Buffer.from(error.response.data).toString("utf8");
          errorDetails = JSON.parse(errorText);
        } catch {
          errorDetails = error.response.data.toString();
        }
      }

      res.status(500).json({
        status: false,
        error: error.message,
        details: errorDetails || "No hay detalles adicionales disponibles",
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

  /**
   * Monitorear los estados
   */
  router.get("/storage-stats", async (req, res) => {
    try {
      const stats = await handler.getStorageStats();
      res.json({ status: true, stats });
    } catch (error) {
      res.status(500).json({
        status: false,
        error: error.message,
      });
    }
  });

  return router;
};
