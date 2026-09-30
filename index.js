import express from "express";
import qrcode from "qrcode";
import pino from "pino";
import { GoogleGenAI } from "@google/genai";
import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from "@whiskeysockets/baileys";

const app = express();
const PORT = process.env.PORT || 3000;

const ai = new GoogleGenAI({
  vertexai: false,
  apiKey: process.env.GEMINI_API_KEY,
});

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

async function askGemini(prompt, context, retries = 3) {
  const fullPrompt = context
    ? `Berikut adalah riwayat percakapan grup WhatsApp:\n\n${context}\n\n---\n\n${prompt}`
    : prompt;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash-lite",
        contents: fullPrompt,
      });
      return response.text;
    } catch (err) {
      const isRetryable =
        err?.status === 503 || err?.message?.includes("UNAVAILABLE") || err?.message?.includes("high demand");
      const isLastAttempt = attempt === retries - 1;

      if (!isRetryable || isLastAttempt) {
        throw err;
      }

      const waitMs = 2000 * (attempt + 1); // 2s, 4s, 6s
      console.log(`Gemini sibuk, coba lagi dalam ${waitMs / 1000}s (percobaan ${attempt + 1}/${retries})`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

async function askGeminiWithImage(prompt, imageBase64, mimeType, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt || "Jelaskan dan analisis isi gambar ini." },
              { inlineData: { mimeType, data: imageBase64 } },
            ],
          },
        ],
      });
      return response.text;
    } catch (err) {
      const isRetryable =
        err?.status === 503 || err?.message?.includes("UNAVAILABLE") || err?.message?.includes("high demand");
      const isLastAttempt = attempt === retries - 1;

      if (!isRetryable || isLastAttempt) {
        throw err;
      }

      const waitMs = 2000 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

// Nama panggilan bot ini. Ketik nama ini di mana saja dalam pesan (di grup)
// untuk memanggil bot, tidak perlu tag/mention resmi WA (karena sistem ID
// mention WA sekarang kadang tidak bisa dicocokkan dengan reliable).
const BOT_NAME = "Marley";
const triggerPattern = new RegExp(`\\b${BOT_NAME}\\b`, "i");

function containsBotTrigger(text) {
  return triggerPattern.test(text);
}

// Bersihkan teks dari kata panggil "Marley" (dan tanda baca setelahnya)
// serta tag @nomor lama, supaya tidak ikut dikirim ke Gemini
function stripMentions(text) {
  let cleaned = text.replace(/@\d+/g, "");
  cleaned = cleaned.replace(triggerPattern, "");
  cleaned = cleaned.replace(/^[\s,:.\-]+/, "");
  return cleaned.trim();
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

    // Cek kalau pesan ini gambar (dengan atau tanpa caption)
    const imageMessage = msg.message.imageMessage;
    if (imageMessage) {
      const caption = imageMessage.caption || "";

      // Di grup, foto diproses kalau caption-nya menyebut nama bot ("Marley")
      const imageIsMentioned = isGroup && containsBotTrigger(caption);

      // Di grup: cuma proses kalau bot di-mention di caption-nya
      // Di chat pribadi: selalu proses
      if (isGroup && !imageIsMentioned) {
        return;
      }

      try {
        const buffer = await downloadMediaMessage(msg, "buffer", {});
        const imageBase64 = buffer.toString("base64");
        const mimeType = imageMessage.mimetype || "image/jpeg";
        const cleanCaption = isGroup ? stripMentions(caption) : caption;

        await sock.sendMessage(from, { text: "Sedang menganalisis gambar, tunggu sebentar..." });
        const result = await askGeminiWithImage(cleanCaption, imageBase64, mimeType);
        await sock.sendMessage(from, { text: result });
      } catch (err) {
        console.error("Error saat proses gambar:", err);
        await sock.sendMessage(from, { text: "Maaf, gagal menganalisis gambar ini. Coba lagi." });
      }
      return;
    }

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    if (!text) return;

    if (isGroup) {
      addToHistory(from, sender, text);
    }

    // Bot dipanggil kalau namanya ("Marley") disebut di pesan grup
    const isMentioned = isGroup && containsBotTrigger(text);

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
            "Atau sebut nama saya \"Marley\" di pesan kamu diikuti pertanyaan apa saja, saya akan jawab seperti chat biasa.",
        });
      } else if (isGroup && isMentioned) {
        const question = stripMentions(text);
        if (!question) {
          await sock.sendMessage(from, { text: "Ya, ada yang bisa saya bantu? Tulis pertanyaannya setelah nama saya." });
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
      const isBusy = err?.status === 503 || err?.message?.includes("UNAVAILABLE") || err?.message?.includes("high demand");
      const errorText = isBusy
        ? "Server AI sedang sibuk, sudah dicoba beberapa kali tapi masih gagal. Coba lagi sebentar lagi ya."
        : "Maaf, ada error saat memproses permintaan. Coba lagi.";
      await sock.sendMessage(from, { text: errorText });
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
