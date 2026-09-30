import express from "express";
import qrcode from "qrcode";
import pino from "pino";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
// MEMORY PERSISTENT MARLEY
// ======================================================

const MEMORY_DIR = path.join(__dirname, "memory");
const MEMORY_FILE = path.join(MEMORY_DIR, "memories.json");

const DEFAULT_MEMORIES = [
  {
    id: "core-001",
    category: "identity",
    text: "Marley adalah AI Assistant untuk membantu pekerjaan AM-BM Bangkalan.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "core-002",
    category: "terminology",
    text: "Dalam konteks Amartha, mitra berarti nasabah.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "core-003",
    category: "area",
    text: "Fokus utama Marley adalah monitoring dan analisis Area Bangkalan.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "core-004",
    category: "kpi",
    text: "Growth terdiri dari ETB dan NTB. Portofolio mencakup DPD 0, DPD 1-30, dan DPD 31-90.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

let memories = [];
let memoryWriteQueue = Promise.resolve();

async function initMemory() {
  try {
    await fs.mkdir(MEMORY_DIR, { recursive: true });

    try {
      const raw = await fs.readFile(MEMORY_FILE, "utf8");
      const parsed = JSON.parse(raw);
      memories = Array.isArray(parsed) ? parsed : [];
    } catch {
      memories = DEFAULT_MEMORIES;
      await saveMemories();
    }

    console.log(`Memory Marley siap: ${memories.length} memory.`);
  } catch (err) {
    console.error("Gagal menyiapkan memory Marley:", err);
    memories = DEFAULT_MEMORIES;
  }
}

function saveMemories() {
  const payload = JSON.stringify(memories, null, 2);

  memoryWriteQueue = memoryWriteQueue
    .catch(() => {})
    .then(() => fs.writeFile(MEMORY_FILE, payload, "utf8"));

  return memoryWriteQueue;
}

function makeMemoryId() {
  return `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function addMemory(text, category = "general") {
  const cleanText = String(text || "").trim();
  if (!cleanText) return null;

  const now = new Date().toISOString();
  const memory = {
    id: makeMemoryId(),
    category: String(category || "general").trim().toLowerCase(),
    text: cleanText,
    createdAt: now,
    updatedAt: now,
  };

  memories.push(memory);
  await saveMemories();
  return memory;
}

async function deleteMemoriesByIds(ids) {
  const idSet = new Set(ids);
  const before = memories.length;
  memories = memories.filter((m) => !idSet.has(m.id));
  const deleted = before - memories.length;

  if (deleted > 0) {
    await saveMemories();
  }

  return deleted;
}

function normalizeForSearch(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function getRelevantMemories(query, limit = 12) {
  if (!memories.length) return [];

  const q = normalizeForSearch(query);
  const tokens = q
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 3);

  const scored = memories.map((memory) => {
    const haystack = normalizeForSearch(
      `${memory.category} ${memory.text}`
    );

    let score = 0;

    if (q && haystack.includes(q)) score += 10;

    for (const token of tokens) {
      if (haystack.includes(token)) score += 1;
    }

    return { memory, score };
  });

  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.memory);
}

function formatMemoriesForPrompt(query) {
  const relevant = getRelevantMemories(query, 12);

  if (!relevant.length) return "";

  return relevant
    .map(
      (m, i) =>
        `${i + 1}. [${m.category}] ${m.text}`
    )
    .join("\n");
}

function formatAllMemories(limit = 30) {
  if (!memories.length) return "Belum ada memory tersimpan.";

  return memories
    .slice(-limit)
    .map(
      (m, i) =>
        `${i + 1}. [${m.category}] ${m.text}\n   ID: ${m.id}`
    )
    .join("\n");
}

function searchMemories(query, limit = 20) {
  const results = getRelevantMemories(query, limit);

  if (!results.length) {
    return "Tidak ditemukan memory yang relevan.";
  }

  return results
    .map(
      (m, i) =>
        `${i + 1}. [${m.category}] ${m.text}\n   ID: ${m.id}`
    )
    .join("\n");
}

async function forgetMemories(query) {
  const q = normalizeForSearch(query);

  if (!q) return 0;

  const candidates = memories.filter((m) => {
    const haystack = normalizeForSearch(
      `${m.category} ${m.text}`
    );
    return haystack.includes(q);
  });

  return deleteMemoriesByIds(
    candidates.map((m) => m.id)
  );
}

function parseRememberCommand(text) {
  const match = text.match(
    /^\s*(?:ingat|simpan memory|simpan|remember)\s*[:\-]?\s*(.+)$/i
  );

  if (!match) return null;

  let content = match[1].trim();
  let category = "general";

  const categoryMatch = content.match(
    /^\[([^\]]+)\]\s*(.+)$/
  );

  if (categoryMatch) {
    category = categoryMatch[1].trim().toLowerCase();
    content = categoryMatch[2].trim();
  }

  return { content, category };
}

function parseForgetCommand(text) {
  const match = text.match(
    /^\s*(?:lupakan|hapus memory|forget)\s*[:\-]?\s*(.+)$/i
  );

  return match ? match[1].trim() : null;
}

function isMemoryListCommand(text) {
  return /^\s*(?:memory|memori|lihat memory|lihat memori)\s*$/i.test(
    text
  );
}

function parseMemorySearchCommand(text) {
  const match = text.match(
    /^\s*(?:cari memory|cari memori|search memory|search memori)\s*[:\-]?\s*(.+)$/i
  );

  return match ? match[1].trim() : null;
}

// ======================================================
// RIWAYAT CHAT GRUP
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
  const memoryContext = formatMemoriesForPrompt(prompt);

  const memoryBlock = memoryContext
    ? `\n\nMEMORY MARLEY YANG RELEVAN:\n${memoryContext}\n`
    : "";

  const fullPrompt = `${
    memoryBlock
  }\n\n${
    context
      ? `Berikut adalah riwayat percakapan grup WhatsApp:\n\n${context}\n\n---\n\n`
      : ""
  }${prompt}`;

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
        `Gemini sibuk, coba lagi dalam ${waitMs / 1000}s (percobaan ${attempt + 1}/${retries})`
      );

      await new Promise((resolve) =>
        setTimeout(resolve, waitMs)
      );
    }
  }
}

async function askGeminiWithImage(
  prompt,
  imageBase64,
  mimeType,
  retries = 3
) {
  const memoryContext = formatMemoriesForPrompt(prompt);

  const memoryInstruction = memoryContext
    ? `Memory Marley yang relevan:\n${memoryContext}\n\n`
    : "";

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
                  `${memoryInstruction}${
                    prompt ||
                    "Jelaskan dan analisis isi gambar ini."
                  }`,
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

      await new Promise((resolve) =>
        setTimeout(resolve, waitMs)
      );
    }
  }
}

// ======================================================
// IDENTITAS BOT
// ======================================================

const BOT_NAME = "Marley";

const triggerPattern = new RegExp(
  `(^|[\\s@.,!?;:()\\[\\]{}'"-])${BOT_NAME}(?=$|[\\s@.,!?;:()\\[\\]{}'"-])`,
  "i"
);

function containsBotTrigger(text) {
  if (!text) return false;
  return triggerPattern.test(text);
}

function stripMentions(text) {
  if (!text) return "";

  let cleaned = text;

  cleaned = cleaned.replace(/@\d+/g, "");

  cleaned = cleaned.replace(
    new RegExp(`\\b${BOT_NAME}\\b`, "gi"),
    ""
  );

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

  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      latestQR = qr;
      connectionStatus = "menunggu scan QR";
    }

    if (connection === "open") {
      connectionStatus = "terhubung";
      latestQR = null;
      botJid = sock.user?.id?.split(":")[0] || null;

      console.log("Bot berhasil terhubung ke WhatsApp!");
      console.log("Bot JID:", botJid);
      console.log(`Nama bot: ${BOT_NAME}`);
      console.log(`Memory aktif: ${memories.length}`);
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;

      connectionStatus = "terputus, mencoba lagi...";

      console.log(
        "Koneksi terputus, reconnect:",
        shouldReconnect
      );

      if (shouldReconnect) {
        startBot();
      }
    }
  });

  sock.ev.on(
    "messages.upsert",
    async ({ messages }) => {
      const msg = messages[0];

      if (!msg?.message) return;
      if (msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      if (!from) return;

      const isGroup = from.endsWith("@g.us");

      const sender =
        msg.pushName ||
        msg.key.participant ||
        from;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      const mentionedJids =
        msg.message.extendedTextMessage?.contextInfo
          ?.mentionedJid || [];

      const textTrigger = containsBotTrigger(text);

      const officialMention =
        botJid &&
        mentionedJids.some((jid) =>
          jid.includes(botJid)
        );

      const isMentioned =
        isGroup &&
        (textTrigger || officialMention);

      if (isGroup) {
        console.log("========================================");
        console.log("DEBUG PESAN GRUP");
        console.log("text:", JSON.stringify(text));
        console.log("botJid:", botJid);
        console.log("mentionedJids:", mentionedJids);
        console.log("textTrigger:", textTrigger);
        console.log("officialMention:", officialMention);
        console.log("isMentioned:", isMentioned);
        console.log("========================================");
      }

      // ==================================================
      // GAMBAR
      // ==================================================

      const imageMessage =
        msg.message.imageMessage;

      if (imageMessage) {
        const caption = imageMessage.caption || "";

        const imageMentionedJids =
          imageMessage.contextInfo?.mentionedJid || [];

        const imageTextTrigger =
          containsBotTrigger(caption);

        const imageOfficialMention =
          botJid &&
          imageMentionedJids.some((jid) =>
            jid.includes(botJid)
          );

        const imageIsMentioned =
          isGroup &&
          (imageTextTrigger || imageOfficialMention);

        if (isGroup && !imageIsMentioned) {
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

          await sock.sendMessage(from, {
            text:
              "Sedang menganalisis gambar, tunggu sebentar...",
          });

          const result =
            await askGeminiWithImage(
              cleanCaption,
              imageBase64,
              mimeType
            );

          await sock.sendMessage(from, {
            text: result,
          });
        } catch (err) {
          console.error(
            "Error saat proses gambar:",
            err
          );

          await sock.sendMessage(from, {
            text:
              "Maaf, gagal menganalisis gambar ini. Coba lagi.",
          });
        }

        return;
      }

      if (!text) return;

      if (isGroup) {
        addToHistory(from, sender, text);
      }

      try {
        // ==================================================
        // MEMORY: SIMPAN
        // ==================================================

        const remember = parseRememberCommand(text);

        if (isGroup && isMentioned && remember) {
          if (!remember.content) {
            await sock.sendMessage(from, {
              text:
                "Format: Marley ingat: [kategori] isi memory",
            });
            return;
          }

          const saved = await addMemory(
            remember.content,
            remember.category
          );

          await sock.sendMessage(from, {
            text:
              `Siap, saya ingat.\n\n[${saved.category}] ${saved.text}`,
          });

          console.log(
            "Memory baru disimpan:",
            saved
          );

          return;
        }

        // ==================================================
        // MEMORY: LIHAT SEMUA
        // ==================================================

        if (isGroup && isMentioned && isMemoryListCommand(stripMentions(text))) {
          await sock.sendMessage(from, {
            text:
              `Memory Marley (${memories.length}):\n\n${formatAllMemories()}`,
          });
          return;
        }

        // ==================================================
        // MEMORY: CARI
        // ==================================================

        const memorySearch =
          parseMemorySearchCommand(
            stripMentions(text)
          );

        if (isGroup && isMentioned && memorySearch) {
          const result = searchMemories(memorySearch);

          await sock.sendMessage(from, {
            text:
              `Hasil pencarian memory untuk "${memorySearch}":\n\n${result}`,
          });

          return;
        }

        // ==================================================
        // MEMORY: LUPAKAN
        // ==================================================

        const forgetQuery =
          parseForgetCommand(
            stripMentions(text)
          );

        if (isGroup && isMentioned && forgetQuery) {
          const deleted =
            await forgetMemories(forgetQuery);

          await sock.sendMessage(from, {
            text:
              deleted > 0
                ? `Baik, ${deleted} memory yang cocok sudah saya lupakan.`
                : "Saya tidak menemukan memory yang cocok untuk dilupakan.",
          });

          return;
        }

        // ==================================================
        // COMMAND
        // ==================================================

        const command =
          text.trim().toLowerCase();

        if (command === "/rangkum") {
          await sock.sendMessage(from, {
            text:
              "Sedang merangkum, tunggu sebentar...",
          });

          const context =
            formatHistory(from);

          if (!context) {
            await sock.sendMessage(from, {
              text:
                "Belum ada riwayat percakapan yang bisa dirangkum.",
            });
            return;
          }

          const result =
            await askGemini(
              "Buat rangkuman singkat dan jelas dari diskusi di atas. Fokus pada poin-poin penting saja.",
              context
            );

          await sock.sendMessage(from, {
            text: result,
          });
        } else if (command === "/analisa") {
          await sock.sendMessage(from, {
            text:
              "Sedang menganalisis, tunggu sebentar...",
          });

          const context =
            formatHistory(from);

          if (!context) {
            await sock.sendMessage(from, {
              text:
                "Belum ada riwayat percakapan yang bisa dianalisis.",
            });
            return;
          }

          const result =
            await askGemini(
              "Analisis diskusi di atas: apa masalah utamanya, apa saja risikonya, dan berikan saran action plan yang konkret dan bisa langsung dijalankan.",
              context
            );

          await sock.sendMessage(from, {
            text: result,
          });
        } else if (command === "/proyeksi") {
          await sock.sendMessage(from, {
            text:
              "Sedang menghitung proyeksi, tunggu sebentar...",
          });

          const context =
            formatHistory(from);

          if (!context) {
            await sock.sendMessage(from, {
              text:
                "Belum ada riwayat percakapan yang bisa dihitung.",
            });
            return;
          }

          const result =
            await askGemini(
              "Berdasarkan angka-angka atau data yang disebutkan dalam diskusi di atas, buat proyeksi/perkiraan ke depan yang masuk akal. Jika datanya tidak cukup untuk proyeksi yang akurat, katakan dengan jelas data apa yang masih kurang.",
              context
            );

          await sock.sendMessage(from, {
            text: result,
          });
        } else if (
          command === "/help" ||
          command === "/menu"
        ) {
          await sock.sendMessage(from, {
            text:
              "Perintah yang tersedia:\n\n" +
              "/rangkum - merangkum diskusi grup\n" +
              "/analisa - analisis masalah + saran action plan\n" +
              "/proyeksi - hitung proyeksi dari data di chat\n" +
              "/help - tampilkan menu ini\n\n" +
              "Memory Marley:\n" +
              "Marley ingat: ... - simpan memory\n" +
              "Marley memory - lihat memory\n" +
              "Marley cari memory: ... - cari memory\n" +
              "Marley lupakan: ... - hapus memory\n\n" +
              'Atau sebut nama saya "Marley" diikuti pertanyaan apa saja.',
          });
        } else if (isGroup && isMentioned) {
          const question =
            stripMentions(text);

          console.log(
            "Marley dipanggil. Pertanyaan:",
            JSON.stringify(question)
          );

          if (!question) {
            await sock.sendMessage(from, {
              text:
                "Ya, ada yang bisa saya bantu? Tulis pertanyaannya setelah nama saya.",
            });
            return;
          }

          const context =
            formatHistory(from);

          const result =
            await askGemini(
              question,
              context
            );

          await sock.sendMessage(from, {
            text: result,
          });
        } else if (!isGroup) {
          const result =
            await askGemini(text, "");

          await sock.sendMessage(from, {
            text: result,
          });
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

        const errorText = isBusy
          ? "Server AI sedang sibuk, sudah dicoba beberapa kali tapi masih gagal. Coba lagi sebentar lagi ya."
          : "Maaf, ada error saat memproses permintaan. Coba lagi.";

        await sock.sendMessage(from, {
          text: errorText,
        });
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
      <p>Memory aktif: ${memories.length}</p>
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
      <body style="text-align:center; font-family:sans-serif;">
        <h2>Scan QR ini dengan WhatsApp</h2>
        <img src="${qrImage}" />
        <p>Status: ${connectionStatus}</p>
        <script>
          setTimeout(() => location.reload(), 5000)
        </script>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Server jalan di port ${PORT}`);
});

await initMemory();
await startBot();
