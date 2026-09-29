import express from "express";
import qrcode from "qrcode";
import pino from "pino";
import { GoogleGenAI } from "@google/genai";
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";

const app = express();
const PORT = process.env.PORT || 3000;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

let latestQR = null;
let connectionStatus = "menghubungkan...";
let botJid = null; // nomor bot sendiri, diisi setelah connect

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

async function askGemini(prompt, context) {
  const fullPrompt = context
    ? `Berikut adalah riwayat percakapan grup WhatsApp:\n\n${context}\n\n---\n\n${prompt}`
    : prompt;
  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: fullPrompt,
  });
  return response.text;
}

// Bersihkan teks dari tag @62812xxxx supaya nggak ikut dikirim ke Gemini
function stripMentions(text) {
  return text.replace(/@\d+/g, "").trim();
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
      botJid = sock.user.id.split(":")[0];
      console.log("Bot berhasil terhubung ke WhatsApp! JID:", botJid);
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

    if (isGroup) {
      addToHistory(from, sender, text);
    }

    const mentionedJids =
      msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const isMentioned = botJid && mentionedJids.some((jid) => jid.startsWith(botJid));

    const command = text.trim().toLowerCase();

    try {
      if (command === "/rangkum") {
        await sock.sendMessage(from, { text: "Sedang merangkum, tunggu sebentar..." });
        const context = formatHistory(from);
        if (!context) {
          await sock.sendMessage(from, { text: "Belum ada riwayat percakapan yang bisa dirangkum." });
          return;
        }
        const result = await askGemini(
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
        const result = await askGemini(
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
        const result = await askGemini(
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
            "/help - tampilkan menu ini\n\n" +
            "Atau tag/mention saya langsung diikuti pertanyaan apa saja, saya akan jawab seperti chat biasa.",
        });
      } else if (isGroup && isMentioned) {
        const question = stripMentions(text);
        if (!question) {
          await sock.sendMessage(from, { text: "Ya, ada yang bisa saya bantu? Tulis pertanyaannya setelah tag saya." });
          return;
        }
        const context = formatHistory(from);
        const result = await askGemini(question, context);
        await sock.sendMessage(from, { text: result });
      } else if (!isGroup) {
        const result = await askGemini(text, "");
        await sock.sendMessage(from, { text: result });
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
