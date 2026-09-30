import express from "express";
import qrcode from "qrcode";
import pino from "pino";
import { GoogleGenAI } from "@google/genai";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";

const app = express();
const PORT = process.env.PORT || 3000;

const ai = new GoogleGenAI({
  vertexai: false,
  apiKey: process.env.GEMINI_API_KEY,
});

let latestQR = null;
let connectionStatus = "menghubungkan...";
let botJid = null;

// ======================================================
// RIWAYAT CHAT
// ======================================================

const groupHistory = new Map();
const MAX_HISTORY = 200;

function addToHistory(groupId, sender, text) {
  if (!groupHistory.has(groupId)) {
    groupHistory.set(groupId, []);
  }

  const history = groupHistory.get(groupId);

  history.push({
    sender,
    text,
    time: new Date().toISOString(),
  });

  if (history.length > MAX_HISTORY) {
    history.shift();
  }
}

function formatHistory(groupId) {
  const history = groupHistory.get(groupId) || [];

  return history
    .map((h) => `${h.sender}: ${h.text}`)
    .join("\n");
}

// ======================================================
// GEMINI
// ======================================================

async function askGemini(prompt, context, retries = 3) {
  const fullPrompt = context
    ? `Berikut adalah riwayat percakapan grup WhatsApp:

${context}

---

${prompt}`
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
        err?.status === 503 ||
        err?.message?.includes("UNAVAILABLE") ||
        err?.message?.includes("high demand");

      const isLastAttempt = attempt === retries - 1;

      if (!isRetryable || isLastAttempt) {
        throw err;
      }

      const waitMs = 2000 * (attempt + 1);

      console.log(
        `Gemini sibuk, coba lagi dalam ${
          waitMs / 1000
        }s (percobaan ${attempt + 1}/${retries})`
      );

      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

async function askGeminiWithImage(
  prompt,
  imageBase64,
  mimeType,
  retries = 3
) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              {
                text:
                  prompt ||
                  "Jelaskan dan analisis isi gambar ini.",
              },
              {
                inlineData: {
                  mimeType,
                  data: imageBase64,
                },
              },
            ],
          },
        ],
      });

      return response.text;
    } catch (err) {
      const isRetryable =
        err?.status === 503 ||
        err?.message?.includes("UNAVAILABLE") ||
        err?.message?.includes("high demand");

      const isLastAttempt = attempt === retries - 1;

      if (!isRetryable || isLastAttempt) {
        throw err;
      }

      const waitMs = 2000 * (attempt + 1);

      console.log(
        `Gemini gambar sibuk, retry dalam ${waitMs / 1000}s`
      );

      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

// ======================================================
// IDENTITAS BOT
// ======================================================

const BOT_NAME = "Marley";

/*
 * Trigger Marley dibuat fleksibel.
 *
 * Contoh yang akan terdeteksi:
 *
 * Marley
 * marley
 * MARLEY
 * Marley tolong bantu
 * @Marley tolong bantu
 * Marley, analisa data ini
 *
 * Tidak bergantung pada mentionedJids.
 */

const triggerPattern = new RegExp(
  `(^|[\\s@.,!?;:()\\[\\]{}'"-])${BOT_NAME}(?=$|[\\s@.,!?;:()\\[\\]{}'"-])`,
  "i"
);

function containsBotTrigger(text) {
  if (!text) return false;

  return triggerPattern.test(text);
}

// ======================================================
// MEMBERSIHKAN PESAN
// ======================================================

function stripMentions(text) {
  if (!text) return "";

  let cleaned = text;

  // Hapus @nomor
  cleaned = cleaned.replace(/@\d+/g, "");

  // Hapus nama Marley
  cleaned = cleaned.replace(
    new RegExp(`\\b${BOT_NAME}\\b`, "gi"),
    ""
  );

  // Bersihkan karakter awal
  cleaned = cleaned.replace(/^[\s,:.\-!?]+/, "");

  return cleaned.trim();
}

// ======================================================
// START BOT
// ======================================================

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState("auth_info_baileys");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
  });

  sock.ev.on("creds.update", saveCreds);

  // ====================================================
  // CONNECTION
  // ====================================================

  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      latestQR = qr;
      connectionStatus = "menunggu scan QR";
    }

    if (connection === "open") {
      connectionStatus = "terhubung";
      latestQR = null;

      /*
       * Simpan nomor bot sendiri.
       *
       * Contoh:
       * 62895379899997@s.whatsapp.net
       */

      botJid = sock.user?.id?.split(":")[0] || null;

      console.log(
        "Bot berhasil terhubung ke WhatsApp!"
      );

      console.log(
        "Bot JID:",
        botJid
      );

      console.log(
        `Nama bot: ${BOT_NAME}`
      );

      console.log(
        "Trigger grup: nama 'Marley' akan digunakan sebagai pemanggil."
      );
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;

      connectionStatus =
        "terputus, mencoba lagi...";

      console.log(
        "Koneksi terputus, reconnect:",
        shouldReconnect
      );

      if (shouldReconnect) {
        startBot();
      }
    }
  });

  // ====================================================
  // PESAN MASUK
  // ====================================================

  sock.ev.on(
    "messages.upsert",
    async ({ messages }) => {
      const msg = messages[0];

      if (!msg?.message) return;

      // Jangan proses pesan yang dikirim bot sendiri
      if (msg.key.fromMe) return;

      const from = msg.key.remoteJid;

      if (!from) return;

      const isGroup = from.endsWith("@g.us");

      const sender =
        msg.pushName ||
        msg.key.participant ||
        from;

      // ==================================================
      // AMBIL TEKS PESAN
      // ==================================================

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      // ==================================================
      // CEK MENTION RESMI WHATSAPP
      // ==================================================

      const mentionedJids =
        msg.message.extendedTextMessage?.contextInfo
          ?.mentionedJid || [];

      /*
       * Jangan jadikan mentionedJids sebagai syarat utama.
       *
       * Karena dari log kamu:
       *
       * mentionedJids: []
       *
       * padahal user mengetik:
       *
       * Marley
       *
       * Jadi Marley tetap diproses berdasarkan teks.
       */

      const textTrigger = containsBotTrigger(text);

      const officialMention =
        botJid &&
        mentionedJids.some((jid) =>
          jid.includes(botJid)
        );

      // Trigger final
      const isMentioned =
        isGroup &&
        (textTrigger || officialMention);

      // ==================================================
      // DEBUG
      // ==================================================

      if (isGroup) {
        console.log(
          "========================================"
        );

        console.log(
          "DEBUG PESAN GRUP"
        );

        console.log(
          "text:",
          JSON.stringify(text)
        );

        console.log(
          "botJid:",
          botJid
        );

        console.log(
          "mentionedJids:",
          mentionedJids
        );

        console.log(
          "textTrigger:",
          textTrigger
        );

        console.log(
          "officialMention:",
          officialMention
        );

        console.log(
          "isMentioned:",
          isMentioned
        );

        console.log(
          "========================================"
        );
      }

      // ==================================================
      // GAMBAR
      // ==================================================

      const imageMessage =
        msg.message.imageMessage;

      if (imageMessage) {
        const caption =
          imageMessage.caption || "";

        const imageTextTrigger =
          containsBotTrigger(caption);

        const imageOfficialMention =
          botJid &&
          (
            msg.message.imageMessage
              ?.contextInfo
              ?.mentionedJid || []
          ).some((jid) =>
            jid.includes(botJid)
          );

        const imageIsMentioned =
          isGroup &&
          (imageTextTrigger ||
            imageOfficialMention);

        /*
         * Di grup:
         * gambar hanya diproses jika Marley dipanggil.
         */

        if (
          isGroup &&
          !imageIsMentioned
        ) {
          return;
        }

        try {
          const buffer =
            await downloadMediaMessage(
              msg,
              "buffer",
              {}
            );

          const imageBase64 =
            buffer.toString("base64");

          const mimeType =
            imageMessage.mimetype ||
            "image/jpeg";

          const cleanCaption =
            isGroup
              ? stripMentions(caption)
              : caption;

          await sock.sendMessage(
            from,
            {
              text:
                "Sedang menganalisis gambar, tunggu sebentar...",
            }
          );

          const result =
            await askGeminiWithImage(
              cleanCaption,
              imageBase64,
              mimeType
            );

          await sock.sendMessage(
            from,
            {
              text: result,
            }
          );
        } catch (err) {
          console.error(
            "Error saat proses gambar:",
            err
          );

          await sock.sendMessage(
            from,
            {
              text:
                "Maaf, gagal menganalisis gambar ini. Coba lagi.",
            }
          );
        }

        return;
      }

      // ==================================================
      // PESAN TANPA TEKS
      // ==================================================

      if (!text) return;

      // ==================================================
      // SIMPAN HISTORY
      // ==================================================

      if (isGroup) {
        addToHistory(
          from,
          sender,
          text
        );
      }

      // ==================================================
      // COMMAND
      // ==================================================

      const command =
        text.trim().toLowerCase();

      try {
        // ================================================
        // RANGKUM
        // ================================================

        if (command === "/rangkum") {
          await sock.sendMessage(
            from,
            {
              text:
                "Sedang merangkum, tunggu sebentar...",
            }
          );

          const context =
            formatHistory(from);

          if (!context) {
            await sock.sendMessage(
              from,
              {
                text:
                  "Belum ada riwayat percakapan yang bisa dirangkum.",
              }
            );

            return;
          }

          const result =
            await askGemini(
              "Buat rangkuman singkat dan jelas dari diskusi di atas. Fokus pada poin-poin penting saja.",
              context
            );

          await sock.sendMessage(
            from,
            {
              text: result,
            }
          );

        // ================================================
        // ANALISA
        // ================================================

        } else if (
          command === "/analisa"
        ) {
          await sock.sendMessage(
            from,
            {
              text:
                "Sedang menganalisis, tunggu sebentar...",
            }
          );

          const context =
            formatHistory(from);

          if (!context) {
            await sock.sendMessage(
              from,
              {
                text:
                  "Belum ada riwayat percakapan yang bisa dianalisis.",
              }
            );

            return;
          }

          const result =
            await askGemini(
              "Analisis diskusi di atas: apa masalah utamanya, apa saja risikonya, dan berikan saran action plan yang konkret dan bisa langsung dijalankan.",
              context
            );

          await sock.sendMessage(
            from,
            {
              text: result,
            }
          );

        // ================================================
        // PROYEKSI
        // ================================================

        } else if (
          command === "/proyeksi"
        ) {
          await sock.sendMessage(
            from,
            {
              text:
                "Sedang menghitung proyeksi, tunggu sebentar...",
            }
          );

          const context =
            formatHistory(from);

          if (!context) {
            await sock.sendMessage(
              from,
              {
                text:
                  "Belum ada riwayat percakapan yang bisa dihitung.",
              }
            );

            return;
          }

          const result =
            await askGemini(
              "Berdasarkan angka-angka atau data yang disebutkan dalam diskusi di atas, buat proyeksi/perkiraan ke depan yang masuk akal. Jika datanya tidak cukup untuk proyeksi yang akurat, katakan dengan jelas data apa yang masih kurang.",
              context
            );

          await sock.sendMessage(
            from,
            {
              text: result,
            }
          );

        // ================================================
        // HELP
        // ================================================

        } else if (
          command === "/help" ||
          command === "/menu"
        ) {
          await sock.sendMessage(
            from,
            {
              text:
                "Perintah yang tersedia:\n\n" +
                "/rangkum - merangkum diskusi grup\n" +
                "/analisa - analisis masalah + saran action plan\n" +
                "/proyeksi - hitung proyeksi dari data di chat\n" +
                "/help - tampilkan menu ini\n\n" +
                'Atau sebut nama saya "Marley" di pesan kamu diikuti pertanyaan apa saja, saya akan jawab seperti chat biasa.',
            }
          );

        // ================================================
        // MARLEY DI GRUP
        // ================================================

        } else if (
          isGroup &&
          isMentioned
        ) {

          /*
           * Hapus kata Marley / @nomor
           * sebelum dikirim ke Gemini.
           */

          const question =
            stripMentions(text);

          console.log(
            "Marley dipanggil."
          );

          console.log(
            "Pertanyaan setelah dibersihkan:",
            JSON.stringify(question)
          );

          if (!question) {
            await sock.sendMessage(
              from,
              {
                text:
                  "Ya, ada yang bisa saya bantu? Tulis pertanyaannya setelah nama saya.",
              }
            );

            return;
          }

          const context =
            formatHistory(from);

          const result =
            await askGemini(
              question,
              context
            );

          await sock.sendMessage(
            from,
            {
              text: result,
            }
          );

        // ================================================
        // CHAT PRIBADI
        // ================================================

        } else if (!isGroup) {
          const result =
            await askGemini(
              text,
              ""
            );

          await sock.sendMessage(
            from,
            {
              text: result,
            }
          );
        }

      } catch (err) {
        console.error(
          "Error saat proses pesan:",
          err
        );

        const isBusy =
          err?.status === 503 ||
          err?.message?.includes("UNAVAILABLE") ||
          err?.message?.includes("high demand");

        const errorText =
          isBusy
            ? "Server AI sedang sibuk, sudah dicoba beberapa kali tapi masih gagal. Coba lagi sebentar lagi ya."
            : "Maaf, ada error saat memproses permintaan. Coba lagi.";

        await sock.sendMessage(
          from,
          {
            text: errorText,
          }
        );
      }
    }
  );
}

// ======================================================
// WEB STATUS / QR
// ======================================================

app.get("/", async (req, res) => {
  if (connectionStatus === "terhubung") {
    res.send(`
      <h2>Status: ${connectionStatus}</h2>
      <p>Bot Marley aktif dan siap menerima perintah di grup.</p>
    `);

    return;
  }

  if (!latestQR) {
    res.send(`
      <h2>Status: ${connectionStatus}</h2>
      <p>QR belum siap, refresh halaman ini beberapa detik lagi.</p>
    `);

    return;
  }

  const qrImage =
    await qrcode.toDataURL(latestQR);

  res.send(`
    <html>
      <body
        style="
          text-align:center;
          font-family:sans-serif;
        "
      >
        <h2>Scan QR ini dengan WhatsApp</h2>

        <img src="${qrImage}" />

        <p>Status: ${connectionStatus}</p>

        <script>
          setTimeout(
            () => location.reload(),
            5000
          );
        </script>
      </body>
    </html>
  `);
});

// ======================================================
// SERVER
// ======================================================

app.listen(
  PORT,
  () => {
    console.log(
      `Server jalan di port ${PORT}`
    );
  }
);

// ======================================================
// START
// ======================================================

startBot();
