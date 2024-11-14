const { Pool } = require("pg");

class DatabaseHandler {
  constructor() {
    this.pool = new Pool({
      user: "whatsapp_user",
      host: "localhost",
      database: "whatsapp_messages",
      password: "whatsapp_password",
      port: 5432,
    });
  }

  async init() {
    try {
      await this.pool.query("SELECT NOW()");
      console.log("Database connection established successfully");
    } catch (error) {
      console.error("Error connecting to database:", error);
      throw error;
    }
  }

  async saveGroup(group) {
    const query = `
            INSERT INTO groups (id, name, description, owner_jid, creation_time, participant_count)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                description = EXCLUDED.description,
                owner_jid = EXCLUDED.owner_jid,
                participant_count = EXCLUDED.participant_count
            RETURNING id`;

    const values = [
      group.id,
      group.subject,
      group.desc || null,
      group.owner || null,
      group.creation ? new Date(group.creation * 1000) : null,
      group.participants?.length || 0,
    ];

    try {
      const result = await this.pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      console.error("Error saving group:", error);
      throw error;
    }
  }

  async saveMessage(message) {
    const query = `
            INSERT INTO messages (id, group_id, sender_jid, message_type, content, timestamp, raw_data)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (id) DO NOTHING
            RETURNING id`;

    let content = "";
    let messageType = "text";

    if (message.message?.conversation) {
      content = message.message.conversation;
    } else if (message.message?.extendedTextMessage?.text) {
      content = message.message.extendedTextMessage.text;
    } else if (message.message?.imageMessage) {
      messageType = "image";
      content = message.message.imageMessage.caption || "";
    } else if (message.message?.videoMessage) {
      messageType = "video";
      content = message.message.videoMessage.caption || "";
    }

    const values = [
      message.key.id,
      message.key.remoteJid,
      message.key.participant || message.key.remoteJid,
      messageType,
      content,
      message.messageTimestamp,
      message,
    ];

    try {
      const result = await this.pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      console.error("Error saving message:", error);
      throw error;
    }
  }

  async getGroupMessages(groupId, days = 30) {
    const query = `
            SELECT m.*, g.name as group_name
            FROM messages m
            JOIN groups g ON m.group_id = g.id
            WHERE m.group_id = $1
                AND m.timestamp >= $2
            ORDER BY m.timestamp ASC`;

    const cutoffTimestamp = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;

    try {
      const result = await this.pool.query(query, [groupId, cutoffTimestamp]);
      return result.rows;
    } catch (error) {
      console.error("Error getting group messages:", error);
      throw error;
    }
  }

  async getStorageStats() {
    const queries = {
      totalGroups: "SELECT COUNT(*) FROM groups",
      totalMessages: "SELECT COUNT(*) FROM messages",
      oldestMessage: "SELECT MIN(timestamp) FROM messages",
      newestMessage: "SELECT MAX(timestamp) FROM messages",
      averageMessagesPerGroup: `
                SELECT AVG(message_count)
                FROM (
                    SELECT group_id, COUNT(*) as message_count
                    FROM messages
                    GROUP BY group_id
                ) counts`,
    };

    try {
      const stats = {};
      for (const [key, query] of Object.entries(queries)) {
        const result = await this.pool.query(query);
        stats[key] = result.rows[0][Object.keys(result.rows[0])[0]];
      }

      return stats;
    } catch (error) {
      console.error("Error getting storage stats:", error);
      throw error;
    }
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = DatabaseHandler;
