const express = require("express");
const router = express.Router();
const fs = require("fs");
const WhatsAppGroupHandler = require("./groupHandlers"); // Asegúrate de que la ruta sea correcta

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
  return router;
};
