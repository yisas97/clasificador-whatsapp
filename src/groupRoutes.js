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
      // 1. Obtener los mensajes y verificar el contenido
      const messages = await handler.getGroupMessagesAsString(
        req.query.groupId
      );

      console.log("===== CONTENIDO DEL MENSAJE =====");
      console.log(messages);
      console.log("=================================");

      if (!messages || messages.trim().length === 0) {
        throw new Error("No se encontraron mensajes en el grupo");
      }

      // 2. Formatear los mensajes al formato esperado por la API de Python
      const formattedMessages = messages
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          // Asumiendo que cada línea tiene el formato: "DD/MM/YY HH:mm - Usuario: Mensaje"
          const match = line.match(
            /(\d{2}\/\d{2}\/\d{2}), (\d{1,2}:\d{2}(?:\s?[ap]\.?\s?m\.?)?)\s-\s([^:]+):\s(.+)/i
          );
          if (match) {
            const [_, date, time, user, message] = match;
            return `${date}, ${time} - ${user}: ${message}`;
          }
          return line;
        })
        .join("\n");

      console.log("===== MENSAJE FORMATEADO =====");
      console.log(formattedMessages);
      console.log("==============================");

      // 3. Crear archivo temporal
      tempFileName = `temp_chat_${Date.now()}.txt`;
      fs.writeFileSync(tempFileName, formattedMessages, "utf8");

      // 4. Verificar el archivo creado
      const fileContent = fs.readFileSync(tempFileName, "utf8");
      console.log("===== CONTENIDO DEL ARCHIVO =====");
      console.log(fileContent);
      console.log("================================");
      console.log(
        "Tamaño del archivo:",
        fs.statSync(tempFileName).size,
        "bytes"
      );

      // 5. Crear FormData
      const formData = new FormData();
      formData.append("file", fs.createReadStream(tempFileName));
      formData.append("method", req.query.method || "lda");
      formData.append("generate_summary", req.query.generate_summary || "true");

      // 6. Enviar a la API de Python
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
      console.error("Mensaje del error:", error.message);

      let errorDetails = "No hay detalles adicionales disponibles";
      if (error.response?.data) {
        // Si la respuesta es un buffer, convertirlo a string
        if (Buffer.isBuffer(error.response.data)) {
          errorDetails = error.response.data.toString();
        } else {
          errorDetails = error.response.data;
        }
      }

      res.status(500).json({
        status: false,
        error: error.message,
        details: errorDetails,
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

  return router;
};
