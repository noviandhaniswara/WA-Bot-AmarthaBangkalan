import express from "express";
import qrcode from "qrcode";
import pino from "pino";
import Anthropic from "@anthropic-ai/sdk";
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

let latestQR = null;
let connectionStatus = "menghubungkan...";

// Menyimpan riwayat pesan per grup, maksimal 200 pesan terakhir
const groupHistory = new Map();
const MAX_HISTORY = 200;

function addToHistory(groupId, sender, text) {
  if (!groupHistory.has(groupId)) groupHistory.set(groupId, []);
  const history = groupHistory.get(groupId);
  history.push({ sender, text, time: new Date().toISOString() });
  if (history.length > MAX_HISTORY) history.shift();
}

function formatHistory(groupId) {
  const history = groupHistory.get(groupId) || [];
  return history.map((h) => `${h.sender}: ${h.text}`).join("\n");
}

async function askClaude(prompt, context) {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `Berikut adalah riwayat percakapan grup WhatsApp:\n\n${context}\n\n---\n\n${prompt}`,
      },
    ],
  });
  return message.content[0].text;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      latestQR = qr;
      connectionStatus = "menunggu scan QR";
    }

    if (connection === "open") {
      connectionStatus = "terhubung";
      latestQR = null;
      console.log("Bot berhasil terhubung ke WhatsApp!");
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      connectionStatus = "terputus, mencoba lagi...";
      console.log("Koneksi terputus, reconnect:", shouldReconnect);
      if (shouldReconnect) startBot();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith("@g.us");
    const sender = msg.pushName || msg.key.participant || from;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    if (!text) return;

    // Simpan ke riwayat kalau ini pesan grup
    if (isGroup) {
      addToHistory(from, sender, text);
    }

    const command = text.trim().toLowerCase();

    try {
      if (command === "/rangkum") {
        await sock.sendMessage(from, { text: "Sedang merangkum, tunggu sebentar..." });
        const context = formatHistory(from);
        if (!context) {
          await sock.sendMessage(from, { text: "Belum ada riwayat percakapan yang bisa dirangkum." });
          return;
        }
        const result = await askClaude(
          "Buat rangkuman singkat dan jelas dari diskusi di atas. Fokus pada poin-poin penting saja.",
          context
        );
        await sock.sendMessage(from, { text: result });
      } else if (command === "/analisa") {
        await sock.sendMessage(from, { text: "Sedang menganalisis, tunggu sebentar..." });
        const context = formatHistory(from);
        if (!context) {
          await sock.sendMessage(from, { text: "Belum ada riwayat percakapan yang bisa dianalisis." });
          return;
        }
        const result = await askClaude(
          "Analisis diskusi di atas: apa masalah utamanya, apa saja risikonya, dan berikan saran action plan yang konkret dan bisa langsung dijalankan.",
          context
        );
        await sock.sendMessage(from, { text: result });
      } else if (command === "/proyeksi") {
        await sock.sendMessage(from, { text: "Sedang menghitung proyeksi, tunggu sebentar..." });
        const context = formatHistory(from);
        if (!context) {
          await sock.sendMessage(from, { text: "Belum ada riwayat percakapan yang bisa dihitung." });
          return;
        }
        const result = await askClaude(
          "Berdasarkan angka-angka atau data yang disebutkan dalam diskusi di atas, buat proyeksi/perkiraan ke depan yang masuk akal. Jika datanya tidak cukup untuk proyeksi yang akurat, katakan dengan jelas data apa yang masih kurang.",
          context
        );
        await sock.sendMessage(from, { text: result });
      } else if (command === "/help" || command === "/menu") {
        await sock.sendMessage(from, {
          text:
            "Perintah yang tersedia:\n\n" +
            "/rangkum - merangkum diskusi grup\n" +
            "/analisa - analisis masalah + saran action plan\n" +
            "/proyeksi - hitung proyeksi dari data di chat\n" +
            "/help - tampilkan menu ini",
        });
      } else if (!isGroup) {
        await sock.sendMessage(from, { text: "halo, ketik /help untuk lihat perintah yang tersedia" });
      }
    } catch (err) {
      console.error("Error saat proses pesan:", err);
      await sock.sendMessage(from, { text: "Maaf, ada error saat memproses permintaan. Coba lagi." });
    }
  });
}

app.get("/", async (req, res) => {
  if (connectionStatus === "terhubung") {
    res.send(`<h2>Status: ${connectionStatus}</h2><p>Bot aktif dan siap menerima perintah di grup.</p>`);
    return;
  }

  if (!latestQR) {
    res.send(`<h2>Status: ${connectionStatus}</h2><p>QR belum siap, refresh halaman ini beberapa detik lagi.</p>`);
    return;
  }

  const qrImage = await qrcode.toDataURL(latestQR);
  res.send(`
    <html>
      <body style="text-align:center; font-family:sans-serif;">
        <h2>Scan QR ini dengan WhatsApp</h2>
        <img src="${qrImage}" />
        <p>Status: ${connectionStatus}</p>
        <script>setTimeout(() => location.reload(), 5000)</script>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Server jalan di port ${PORT}`);
});

startBot();
