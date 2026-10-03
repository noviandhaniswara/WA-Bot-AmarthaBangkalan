import express from "express";
import qrcode from "qrcode";
import pino from "pino";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import * as XLSX from "xlsx";
import sharp from "sharp";
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

const MARLEY_CONVERSATION_INSTRUCTION = `
KAMU ADALAH MARLEY, AI ASSISTANT UNTUK TIM AMARTHA BANGKALAN.

Kamu sedang berbicara langsung dengan manusia di WhatsApp. Prioritasmu adalah menjadi teman kerja/asisten yang natural, singkat, relevan, dan nyambung dengan konteks.

ATURAN PERCAKAPAN:
- Jika user mengajak ngobrol atau bercanda, BALAS LANGSUNG seperti percakapan biasa.
- Jangan merangkum percakapan kecuali user secara eksplisit meminta rangkuman.
- Jangan mengatakan "dari riwayat percakapan tersebut", "berdasarkan percakapan", atau menjelaskan proses internalmu kecuali memang diminta.
- Riwayat chat yang diberikan hanyalah KONTEKS untuk memahami siapa, apa, dan maksud pembicaraan; riwayat tersebut BUKAN tugas untuk dirangkum.
- Jika user mengoreksi sesuatu, akui dan sesuaikan jawaban. Contoh: jika dipanggil "Bos", ikuti panggilan tersebut secara natural.
- Jika tersedia informasi "ORANG YANG DI-TAG PADA PESAN INI", gunakan informasi itu untuk memahami siapa yang sedang disebut/dituju. Jangan mengarang nama dari tanda @.
- Gunakan Bahasa Indonesia yang natural dan santai, sesuai gaya grup kerja.
- Untuk pertanyaan sederhana, jawab sederhana. Jangan membuat jawaban panjang tanpa alasan.
- Boleh bercanda ringan jika konteksnya santai, tetapi tetap sopan.
- Jika user meminta analisis, strategi, proyeksi, atau penjelasan mendalam, barulah gunakan gaya analitis.
- Jika pertanyaan menyangkut data spreadsheet/KPI dan sudah ditangani oleh engine data, jangan mengarang angka. Gunakan angka yang diberikan engine.
- Jangan mengaku melakukan sesuatu yang tidak benar-benar kamu lakukan.
`;

async function askGemini(prompt, context, retries = 3) {
  const memoryContext = formatMemoriesForPrompt(prompt);

  const memoryBlock = memoryContext
    ? `\n\nMEMORY MARLEY YANG RELEVAN:\n${memoryContext}\n`
    : "";

  const contextBlock = context
    ? `\n\nKONTEKS CHAT SEBELUMNYA (gunakan hanya untuk memahami konteks, JANGAN dirangkum kecuali diminta):\n${context}\n\n---\n`
    : "";

  const fullPrompt = `${MARLEY_CONVERSATION_INSTRUCTION}${memoryBlock}${contextBlock}\nPESAN USER:\n${prompt}`;

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
// SMART DAILY REPORT TRACKER MARLEY V3
// ======================================================

const REPORT_DATA_DIR = path.join(__dirname, "data");
const REPORT_DATA_FILE = path.join(REPORT_DATA_DIR, "daily_reports.json");
const REPORT_POINTS = String(
  process.env.REPORT_POINTS || "Sepulu,Kwanyar,Arosbaya,Blega,Kamal,Burneh"
)
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

let dailyReports = {};
let reportWriteQueue = Promise.resolve();

function normalizePointName(value) {
  const raw = String(value || "")
    .replace(/[\*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const key = normalizeForSearch(raw);
  const aliases = {
    sepulu: "Sepulu",
    kwanyar: "Kwanyar",
    arosbaya: "Arosbaya",
    blega: "Blega",
    kamal: "Kamal",
    burneh: "Burneh",
  };

  return aliases[key] || raw.replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseReportDate(text) {
  const clean = String(text || "").replace(/\*/g, "");
  const match = clean.match(
    /\b(\d{1,2})\s+(Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)\s+(\d{4})\b/i
  );

  if (!match) {
    const numeric = clean.match(/\b(\d{1,2})[\s/-]+(\d{1,2})[\s/-]+(\d{4})\b/);
    if (!numeric) return null;
    const day = numeric[1].padStart(2, "0");
    const month = numeric[2].padStart(2, "0");
    return `${numeric[3]}-${month}-${day}`;
  }

  const months = {
    januari: "01", februari: "02", maret: "03", april: "04",
    mei: "05", juni: "06", juli: "07", agustus: "08",
    september: "09", oktober: "10", november: "11", desember: "12",
  };

  const day = match[1].padStart(2, "0");
  const month = months[match[2].toLowerCase()];
  return `${match[3]}-${month}-${day}`;
}

function parseFlexibleNumber(value) {
  if (value === undefined || value === null) return null;

  let raw = String(value)
    .trim()
    .replace(/[\*_`]/g, "")
    .replace(/\s+/g, "");

  if (!raw || raw === "-" || raw === "/") return null;

  const lower = raw.toLowerCase();
  let multiplier = 1;
  if (lower.endsWith("jt")) {
    multiplier = 1_000_000;
    raw = raw.slice(0, -2);
  } else if (lower.endsWith("juta")) {
    multiplier = 1_000_000;
    raw = raw.slice(0, -4);
  } else if (lower.endsWith("rb")) {
    multiplier = 1_000;
    raw = raw.slice(0, -2);
  }

  raw = raw.replace(/rp/gi, "");
  if (!raw) return null;

  if (raw.includes(".") && raw.includes(",")) {
    raw = raw.replace(/\./g, "").replace(",", ".");
  } else if (raw.includes(",")) {
    const commaParts = raw.split(",");
    if (commaParts.length === 2 && commaParts[1].length <= 2) {
      raw = commaParts[0].replace(/\./g, "") + "." + commaParts[1];
    } else {
      raw = raw.replace(/,/g, "");
    }
  } else if (raw.includes(".")) {
    const dotParts = raw.split(".");
    const looksLikeThousands = dotParts.length > 1 && dotParts.slice(1).every((x) => x.length === 3);
    if (looksLikeThousands) raw = raw.replace(/\./g, "");
  }

  const n = Number(raw);
  return Number.isFinite(n) ? n * multiplier : null;
}

function parseCountAmount(value) {
  let raw = String(value || "")
    .replace(/[\*_`]/g, "")
    .trim();

  if (!raw || raw === "-" || raw === "/") {
    return { count: null, amount: null };
  }

  raw = raw.replace(/^:\s*/, "");
  const slash = raw.indexOf("/");

  if (slash >= 0) {
    const left = raw.slice(0, slash).trim();
    const right = raw.slice(slash + 1).trim();
    return {
      count: parseFlexibleNumber(left),
      amount: parseFlexibleNumber(right),
    };
  }

  return {
    count: null,
    amount: parseFlexibleNumber(raw),
  };
}

function findReportValue(text, labels) {
  const lines = String(text || "").split(/\r?\n/);
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`^\\s*${escaped}\\s*:?\\s*(.*?)\\s*$`, "i");
    const line = lines.find((x) => regex.test(x.replace(/[\*_]/g, "")));
    if (line) {
      const cleaned = line.replace(/[\*_]/g, "");
      const match = cleaned.match(regex);
      return match ? match[1].trim() : "";
    }
  }
  return "";
}

function parseDailyReport(text) {
  const raw = String(text || "");
  if (!/REPORT\s+CLOSING\s+HARIAN/i.test(raw)) return null;

  const pointMatch = raw.match(/(?:Point|Nama point)\s+([^\r\n*]+)/i);
  if (!pointMatch) return null;

  const point = normalizePointName(pointMatch[1]);
  const date = parseReportDate(raw);
  if (!date) return null;

  const flow0 = parseCountAmount(findReportValue(raw, ["Flow 0+"]));
  const flow30 = parseCountAmount(findReportValue(raw, ["Flow 30+"]));
  const flow60 = parseCountAmount(findReportValue(raw, ["Flow 60+"]));
  const flow90 = parseCountAmount(findReportValue(raw, ["Flow 90+"]));

  const rf130 = parseCountAmount(findReportValue(raw, ["1-30"]));
  const rf3060 = parseCountAmount(findReportValue(raw, ["30-60"]));
  const rf6090 = parseCountAmount(findReportValue(raw, ["60-90"]));
  const rf90 = parseCountAmount(findReportValue(raw, ["90+"]));
  const btc = parseCountAmount(findReportValue(raw, ["BTC"]));

  const approval = parseCountAmount(findReportValue(raw, ["Total Apprval", "Total Approval"]));
  const sosBaru = parseFlexibleNumber(findReportValue(raw, ["Sos baru"]));
  const fupSos = parseFlexibleNumber(findReportValue(raw, ["FUP SOS by wa", "FUP SOS by WA"]));
  const totalMajelis = parseFlexibleNumber(findReportValue(raw, ["Total majelis"]));
  const ppob = parseFlexibleNumber(findReportValue(raw, ["PPOB"]));
  const celengan = parseFlexibleNumber(findReportValue(raw, ["Celengan"]));
  const rebutan = parseFlexibleNumber(findReportValue(raw, ["Rebutan"]));

  return {
    point,
    date,
    receivedAt: new Date().toISOString(),
    collection: { flow0, flow30, flow60, flow90 },
    rf: { btc, oneTo30: rf130, thirtyTo60: rf3060, sixtyTo90: rf6090, ninetyPlus: rf90 },
    disburse: { approval, sosBaru, fupSos },
    pemilihanKM: { totalMajelis },
    crossSelling: { ppob, celengan, rebutan },
  };
}

async function initDailyReports() {
  try {
    await fs.mkdir(REPORT_DATA_DIR, { recursive: true });
    try {
      const raw = await fs.readFile(REPORT_DATA_FILE, "utf8");
      const parsed = JSON.parse(raw);
      dailyReports = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      dailyReports = {};
      await saveDailyReports();
    }
    console.log(`Daily Report Tracker siap: ${Object.keys(dailyReports).length} tanggal.`);
  } catch (err) {
    console.error("Gagal menyiapkan Daily Report Tracker:", err);
    dailyReports = {};
  }
}

function saveDailyReports() {
  const payload = JSON.stringify(dailyReports, null, 2);
  reportWriteQueue = reportWriteQueue
    .catch(() => {})
    .then(() => fs.writeFile(REPORT_DATA_FILE, payload, "utf8"));
  return reportWriteQueue;
}

function addDailyReport(report) {
  if (!dailyReports[report.date]) dailyReports[report.date] = {};
  dailyReports[report.date][report.point] = report;
  return saveDailyReports();
}

function getReportsForDate(date) {
  return dailyReports[date] || {};
}

function getReportProgress(date) {
  const reports = getReportsForDate(date);
  const completed = REPORT_POINTS.filter((point) => reports[point]);
  return {
    completed,
    missing: REPORT_POINTS.filter((point) => !reports[point]),
    total: REPORT_POINTS.length,
  };
}

function formatDisplayDate(dateKey) {
  const [year, month, day] = String(dateKey || "").split("-");
  if (!year || !month || !day) return dateKey;
  const months = [
    "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember",
  ];
  const monthName = months[Number(month) - 1];
  return monthName ? `${Number(day)} ${monthName} ${year}` : dateKey;
}

function formatNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "";
  return Number(value).toLocaleString("id-ID", { maximumFractionDigits: 2 });
}

function sumMetric(reports, getter) {
  let total = 0;
  let hasValue = false;
  for (const report of Object.values(reports)) {
    const value = getter(report);
    if (value !== null && value !== undefined && Number.isFinite(Number(value))) {
      total += Number(value);
      hasValue = true;
    }
  }
  return hasValue ? total : null;
}

function aggregateDailyReports(date) {
  const reports = getReportsForDate(date);
  const points = Object.values(reports);
  if (!points.length) return null;

  const aggregate = {
    collection: {},
    rf: {},
    disburse: {},
    pemilihanKM: {},
    crossSelling: {},
  };

  for (const key of ["flow0", "flow30", "flow60", "flow90"]) {
    aggregate.collection[key] = {
      count: sumMetric(reports, (r) => r.collection[key].count),
      amount: sumMetric(reports, (r) => r.collection[key].amount),
    };
  }

  for (const key of ["btc", "oneTo30", "thirtyTo60", "sixtyTo90", "ninetyPlus"]) {
    aggregate.rf[key] = {
      count: sumMetric(reports, (r) => r.rf[key].count),
      amount: sumMetric(reports, (r) => r.rf[key].amount),
    };
  }

  aggregate.disburse.approval = {
    count: sumMetric(reports, (r) => r.disburse.approval.count),
    amount: sumMetric(reports, (r) => r.disburse.approval.amount),
  };
  aggregate.disburse.sosBaru = sumMetric(reports, (r) => r.disburse.sosBaru);
  aggregate.disburse.fupSos = sumMetric(reports, (r) => r.disburse.fupSos);
  aggregate.pemilihanKM.totalMajelis = sumMetric(reports, (r) => r.pemilihanKM.totalMajelis);
  aggregate.crossSelling.ppob = sumMetric(reports, (r) => r.crossSelling.ppob);
  aggregate.crossSelling.celengan = sumMetric(reports, (r) => r.crossSelling.celengan);
  aggregate.crossSelling.rebutan = sumMetric(reports, (r) => r.crossSelling.rebutan);

  return aggregate;
}

function formatCountAmount(metric) {
  if (!metric) return "";
  if (metric.count !== null && metric.amount !== null) {
    return `${formatNumber(metric.count)} / ${formatNumber(metric.amount)}`;
  }
  if (metric.count !== null) return formatNumber(metric.count);
  if (metric.amount !== null) return formatNumber(metric.amount);
  return "";
}

function formatDailyAreaReport(date) {
  const progress = getReportProgress(date);
  const aggregate = aggregateDailyReports(date);
  if (!aggregate) return "Belum ada report untuk tanggal tersebut.";

  const a = aggregate;
  return (
    `*REPORT CLOSING HARIAN*\n` +
    `*AREA BANGKALAN*\n` +
    `${formatDisplayDate(date)}\n\n` +
    `Collection\n` +
    `Flow 0+    : ${formatCountAmount(a.collection.flow0)}\n` +
    `Flow 30+ : ${formatCountAmount(a.collection.flow30)}\n` +
    `Flow 60+ : ${formatCountAmount(a.collection.flow60)}\n` +
    `Flow 90+ : ${formatCountAmount(a.collection.flow90)}\n\n\n` +
    `RF Amcoll (1x angsuran)\n` +
    `BTC = ${formatCountAmount(a.rf.btc)}\n` +
    `1-30   : ${formatCountAmount(a.rf.oneTo30)}\n` +
    `30-60 : ${formatCountAmount(a.rf.thirtyTo60)}\n` +
    `60-90 : ${formatCountAmount(a.rf.sixtyTo90)}\n` +
    `90+    : ${formatCountAmount(a.rf.ninetyPlus)}\n\n` +
    `Disburse\n` +
    `Total Apprval: ${formatCountAmount(a.disburse.approval)}\n` +
    `Sos baru : ${formatNumber(a.disburse.sosBaru)}\n` +
    `FUP SOS by wa : ${formatNumber(a.disburse.fupSos)}\n\n` +
    `Pemilihan KM\n` +
    `Total majelis : ${formatNumber(a.pemilihanKM.totalMajelis)}\n\n` +
    `Cross Selling\n` +
    `PPOB : ${formatNumber(a.crossSelling.ppob)}\n` +
    `Celengan : ${formatNumber(a.crossSelling.celengan)}\n` +
    `Rebutan: ${formatNumber(a.crossSelling.rebutan)}\n\n` +
    `Progress report: ${progress.completed.length}/${progress.total} point`
  );
}

function formatReportStatus(date) {
  const progress = getReportProgress(date);
  const lines = REPORT_POINTS.map((point) =>
    progress.completed.includes(point) ? `✅ ${point}` : `❌ ${point}`
  );
  return (
    `📊 *STATUS REPORT CLOSING*\n` +
    `${formatDisplayDate(date)}\n\n` +
    lines.join("\n") +
    `\n\nProgress: ${progress.completed.length}/${progress.total}`
  );
}

async function processIncomingDailyReport(sock, from, sender, text) {
  const report = parseDailyReport(text);
  if (!report) return false;

  report.sender = sender || "unknown";
  await addDailyReport(report);

  const progress = getReportProgress(report.date);
  await sock.sendMessage(from, {
    text:
      `✅ Report Closing diterima\n\n` +
      `Point: ${report.point}\n` +
      `Tanggal: ${report.date}\n` +
      `Progress: ${progress.completed.length}/${progress.total}`,
  });

  if (progress.missing.length) {
    console.log(`Report ${report.point} diterima dari ${sender}. Missing: ${progress.missing.join(", ")}`);
  }

  if (progress.missing.length === 0) {
    const key = `closing-complete:${report.date}:${from}`;
    if (!sentClosingKeys.has(key)) {
      sentClosingKeys.add(key);
      await sock.sendMessage(from, {
        text:
          `🎯 *REPORT AREA LENGKAP*\n\n` +
          `Semua ${progress.total} point sudah mengirim Report Closing ${report.date}.\n\n` +
          formatDailyAreaReport(report.date),
      });
    }
  }

  return true;
}



// ======================================================
// PORTFOLIO DATABASE V1 — PERSISTENT RAILWAY VOLUME
// Source utama: Ops Report Penagihan (CSV/XLSX).
// Database tidak menghapus record lama hanya karena tidak muncul
// pada report terbaru. Record yang tidak muncul diberi status
// MISSING_FROM_LATEST_REPORT agar tidak salah dianggap lunas.
// ======================================================
const PORTFOLIO_DATA_DIR = process.env.PORTFOLIO_DATA_DIR || path.join(__dirname, "data");
const LOAN_MEMORY_FILE = path.join(PORTFOLIO_DATA_DIR, "loan_memory.json");
const LOAN_HISTORY_FILE = path.join(PORTFOLIO_DATA_DIR, "loan_sync_history.json");

let loanMemory = { version: 1, updatedAt: null, customers: {}, loans: {} };
let loanHistory = [];
let loanDbWriteQueue = Promise.resolve();

async function initPortfolioDatabase() {
  await fs.mkdir(PORTFOLIO_DATA_DIR, { recursive: true });
  try {
    loanMemory = JSON.parse(await fs.readFile(LOAN_MEMORY_FILE, "utf8"));
    if (!loanMemory || typeof loanMemory !== "object" || !loanMemory.loans) throw new Error("invalid loan_memory");
  } catch {
    loanMemory = { version: 1, updatedAt: null, customers: {}, loans: {} };
    await savePortfolioDatabase();
  }
  try {
    const parsed = JSON.parse(await fs.readFile(LOAN_HISTORY_FILE, "utf8"));
    loanHistory = Array.isArray(parsed) ? parsed : [];
  } catch {
    loanHistory = [];
    await saveLoanHistory();
  }
  console.log(`Portfolio Database siap: ${Object.keys(loanMemory.loans).length} loan.`);
}

function savePortfolioDatabase() {
  loanMemory.updatedAt = new Date().toISOString();
  const payload = JSON.stringify(loanMemory, null, 2);
  loanDbWriteQueue = loanDbWriteQueue.catch(() => {}).then(() => fs.writeFile(LOAN_MEMORY_FILE, payload, "utf8"));
  return loanDbWriteQueue;
}

function saveLoanHistory() {
  const payload = JSON.stringify(loanHistory.slice(-2000), null, 2);
  loanDbWriteQueue = loanDbWriteQueue.catch(() => {}).then(() => fs.writeFile(LOAN_HISTORY_FILE, payload, "utf8"));
  return loanDbWriteQueue;
}

function normalizeDbKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

function cleanDbValue(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value.trim() : value;
}

function detectPortfolioColumns(columns) {
  const find = (cands) => findColumn(columns, cands);
  return {
    area: find(["area_name", "area"]),
    point: find(["branch_name", "point", "point_name", "branch"]),
    bp: find(["agent_fullname", "bp_username", "bp_name", "bp"]),
    customerNumber: find(["customer_number", "customer_no", "customer_number_id"]),
    customerName: find(["customer_name", "nama_mitra", "mitra_name"]),
    loanId: find(["loan_id", "loanid", "id_loan"]),
    dpdOld: find(["dpd_old"]),
    dpdNew: find(["dpd_new"]),
    osOld: find(["os_old"]),
    osNew: find(["os_new"]),
    totalTunggakan: find(["total_tunggakan", "arrears", "tunggakan"]),
    totalPayment: find(["total_payment", "payment"]),
    totalPaymentMin1x: find(["total_payment_min_1x"]),
    paymentMin1x: find(["payment_min_1x"]),
    restructured: find(["is_loan_restructured"]),
    movement: find(["movement_label"]),
  };
}

function isOpsPortfolioSourceName(name) {
  const s = String(name || "").toLowerCase();
  return /ops\s*report|ops_report|penagihan|portfolio|portofolio/.test(s);
}

function portfolioAreaIsBangkalan(value) {
  return normalizeArea(value) === "bangkalan";
}

function rowToPlainObject(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) out[k] = cleanDbValue(v);
  return out;
}

function portfolioRecordFromRow(row, d, sourceName, sourceDate) {
  const loanId = cleanDbValue(row[d.loanId]);
  const customerNumber = cleanDbValue(row[d.customerNumber]);
  const key = normalizeDbKey(loanId || `${customerNumber || "unknown"}|${row[d.customerName] || ""}`);
  return {
    key,
    loanId,
    customerNumber,
    customerName: cleanDbValue(row[d.customerName]),
    area: cleanDbValue(row[d.area]),
    point: cleanDbValue(row[d.point]),
    bp: cleanDbValue(row[d.bp]),
    dpdOld: toNumber(row[d.dpdOld]),
    dpdNew: toNumber(row[d.dpdNew]),
    osOld: toNumber(row[d.osOld]),
    osNew: toNumber(row[d.osNew]),
    totalTunggakan: toNumber(row[d.totalTunggakan]),
    totalPayment: toNumber(row[d.totalPayment]),
    totalPaymentMin1x: toNumber(row[d.totalPaymentMin1x]),
    paymentMin1x: row[d.paymentMin1x] == null ? null : String(row[d.paymentMin1x]).trim(),
    isLoanRestructured: row[d.restructured] == null ? null : String(row[d.restructured]).trim(),
    movementLabel: cleanDbValue(row[d.movement]),
    sourceName,
    sourceDate,
    lastSeenAt: new Date().toISOString(),
    status: "ACTIVE",
  };
}

function makePortfolioFingerprint(sourceName, rows, sourceDate) {
  const first = rows[0] || {};
  const last = rows[rows.length - 1] || {};
  return [sourceName, sourceDate || "", rows.length, JSON.stringify(first), JSON.stringify(last)].join("|");
}

async function syncOpsReportToPortfolioDatabase(buffer, sourceName) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true, raw: true });
  const sheets = workbook.SheetNames || [];
  let totalRows = 0, bangkalanRows = 0, added = 0, updated = 0, skipped = 0;
  const seenKeys = new Set();
  let detected = null;
  let sourceDate = new Date().toISOString().slice(0, 10);

  for (const sheetName of sheets) {
    const ws = workbook.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
    if (!raw.length) continue;
    const headers = raw[0].map(normalizeHeader);
    const rows = normalizeRows(raw);
    const d = detectPortfolioColumns(headers);
    if (!d.loanId && !d.customerNumber) continue;
    if (!d.area) continue;
    detected = d;
    totalRows += rows.length;

    for (const row of rows) {
      if (!portfolioAreaIsBangkalan(row[d.area])) continue;
      bangkalanRows++;
      const record = portfolioRecordFromRow(row, d, sourceName, sourceDate);
      if (!record.key || record.key === "unknown|") { skipped++; continue; }
      seenKeys.add(record.key);
      const previous = loanMemory.loans[record.key];
      if (previous) {
        loanMemory.loans[record.key] = { ...previous, ...record, status: "ACTIVE", updatedAt: new Date().toISOString() };
        updated++;
      } else {
        loanMemory.loans[record.key] = { ...record, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        added++;
      }

      if (record.customerNumber) {
        const ck = normalizeDbKey(record.customerNumber);
        loanMemory.customers[ck] = {
          ...(loanMemory.customers[ck] || {}),
          customerNumber: record.customerNumber,
          customerName: record.customerName,
          point: record.point,
          bp: record.bp,
          area: record.area,
          loanIds: Array.from(new Set([...(loanMemory.customers[ck]?.loanIds || []), record.loanId].filter(Boolean))),
          updatedAt: new Date().toISOString(),
        };
      }
    }
  }

  if (!detected) throw new Error("Kolom Loan ID/Customer Number dan Area tidak ditemukan. File tidak disimpan sebagai Ops Report.");

  // Jangan menganggap record yang hilang sebagai lunas. Tandai saja sebagai missing.
  for (const [key, loan] of Object.entries(loanMemory.loans)) {
    if (loan.area && portfolioAreaIsBangkalan(loan.area) && !seenKeys.has(key)) {
      if (loan.status !== "PAID") loan.status = "MISSING_FROM_LATEST_REPORT";
    }
  }

  const fingerprint = makePortfolioFingerprint(sourceName, Object.values(loanMemory.loans).slice(-Math.min(bangkalanRows, 20)), sourceDate);
  const already = loanHistory.find((x) => x.fingerprint === fingerprint);
  if (!already) {
    loanHistory.push({
      syncedAt: new Date().toISOString(),
      sourceName,
      sourceDate,
      totalRows,
      bangkalanRows,
      added,
      updated,
      skipped,
      fingerprint,
    });
  }

  await savePortfolioDatabase();
  await saveLoanHistory();

  return { totalRows, bangkalanRows, added, updated, skipped, totalLoans: Object.keys(loanMemory.loans).length, customers: Object.keys(loanMemory.customers).length, sourceDate };
}

function portfolioDatabaseStatus() {
  const loans = Object.values(loanMemory.loans);
  const active = loans.filter(x => x.status === "ACTIVE").length;
  const missing = loans.filter(x => x.status === "MISSING_FROM_LATEST_REPORT").length;
  const points = new Set(loans.filter(x => portfolioAreaIsBangkalan(x.area)).map(x => x.point).filter(Boolean));
  return `🗄️ *PORTFOLIO DATABASE MARLEY*\n\nLoan tersimpan: ${loans.length.toLocaleString("id-ID")}\nCustomer: ${Object.keys(loanMemory.customers).length.toLocaleString("id-ID")}\nAktif di report terakhir: ${active.toLocaleString("id-ID")}\nTidak muncul di report terakhir: ${missing.toLocaleString("id-ID")}\nPoint: ${points.size}\nUpdate terakhir: ${loanMemory.updatedAt || "belum ada"}`;
}

function portfolioDatabaseFind(query) {
  const q = normalizeDbKey(query);
  if (!q) return [];
  const out = [];
  for (const loan of Object.values(loanMemory.loans)) {
    const hay = [loan.loanId, loan.customerNumber, loan.customerName, loan.point, loan.bp].map(normalizeDbKey).join(" | ");
    if (hay.includes(q)) out.push(loan);
  }
  return out.slice(0, 20);
}

function formatPortfolioLoan(loan) {
  return `Loan: ${loan.loanId || "-"}\nMitra: ${loan.customerName || "-"}\nCustomer No: ${loan.customerNumber || "-"}\nPoint: ${loan.point || "-"}\nBP: ${loan.bp || "-"}\nDPD: ${loan.dpdOld ?? "-"} → ${loan.dpdNew ?? "-"}\nOS: ${formatMoney(loan.osNew)}\nPayment ≥1x: ${loan.paymentMin1x || "-"}\nStatus DB: ${loan.status || "-"}`;
}

async function processOpsReportUpload(sock, from, msg, filename) {
  try {
    await sock.sendMessage(from, { text: `🗄️ Marley menyimpan *${filename}* ke Portfolio Database...` });
    const buffer = await downloadMediaMessage(msg, "buffer", {});
    const result = await syncOpsReportToPortfolioDatabase(buffer, filename);
    await sock.sendMessage(from, { text: `✅ *OPS REPORT TERSIMPAN*\n\nBangkalan: ${result.bangkalanRows.toLocaleString("id-ID")} baris\n➕ Baru: ${result.added.toLocaleString("id-ID")}\n🔄 Diperbarui: ${result.updated.toLocaleString("id-ID")}\n⚠️ Dilewati: ${result.skipped.toLocaleString("id-ID")}\n\nTotal loan di database: ${result.totalLoans.toLocaleString("id-ID")}\nCustomer: ${result.customers.toLocaleString("id-ID")}\n\nRecord yang tidak muncul pada report terbaru *tidak dianggap lunas*.` });
    return true;
  } catch (err) {
    console.error("Ops Report DB sync error:", err);
    await sock.sendMessage(from, { text: `❌ Gagal menyimpan Ops Report ke database.\n${err.message}` });
    return true;
  }
}

// ======================================================
// EXCEL / CSV / GOOGLE SHEETS ENGINE V4.1
// Deterministic operational analytics first; Gemini only for
// questions that require interpretation beyond the calculated data.
// ======================================================

const spreadsheetSessions = new Map();
const kpDailySessions = new Map();
const SPREADSHEET_DIR = path.join(__dirname, "data", "spreadsheet_cache");

async function ensureSpreadsheetDir() {
  await fs.mkdir(SPREADSHEET_DIR, { recursive: true });
}

function normalizeHeader(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeRows(rawRows) {
  if (!Array.isArray(rawRows) || !rawRows.length) return [];
  const headerRow = rawRows[0].map((v) => normalizeHeader(v));
  return rawRows.slice(1).map((row) => {
    const obj = {};
    headerRow.forEach((key, i) => {
      if (key) obj[key] = row[i] ?? null;
    });
    return obj;
  }).filter(row => Object.values(row).some(v => v !== null && v !== ""));
}

function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim().replace(/\s/g, "");
  if (!s) return null;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    const n = Number(s.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function findColumn(columns, candidates) {
  const normalized = columns.map((c) => normalizeHeader(c));
  for (const candidate of candidates) {
    const idx = normalized.indexOf(normalizeHeader(candidate));
    if (idx >= 0) return normalized[idx];
  }
  return null;
}

function detectDatasetColumns(columns) {
  return {
    point: findColumn(columns, ["branch_name", "point", "point_name", "branch"]),
    bp: findColumn(columns, ["bp_username", "agent_fullname", "bp_name", "bp"]),
    customer: findColumn(columns, ["customer_name", "customer", "mitra_name"]),
    dpdOld: findColumn(columns, ["dpd_old"]),
    dpdNew: findColumn(columns, ["dpd_new"]),
    osOld: findColumn(columns, ["os_old"]),
    osNew: findColumn(columns, ["os_new"]),
    installment: findColumn(columns, ["installment_amount"]),
    payment: findColumn(columns, ["total_payment"]),
    paymentMin1x: findColumn(columns, ["payment_min_1x", "total_payment_min_1x"]),
    arrears: findColumn(columns, ["total_tunggakan"]),
    movement: findColumn(columns, ["movement_label"]),
    loanState: findColumn(columns, ["loan_state"]),
    loanKind: findColumn(columns, ["loan_kind"]),
    group: findColumn(columns, ["group_name"]),
  };
}

function detectKpDailyColumns(columns) {
  return {
    area: findColumn(columns, ["area", "area_name", "regional_area", "region_area", "nama_area"]),
    point: findColumn(columns, ["branch_name", "point", "point_name", "branch", "nama_point"]),
    bp: findColumn(columns, ["bp_username", "bp_name", "agent_fullname", "agent_name", "bp"]),
    amount: findColumn(columns, ["approval_amount", "approved_amount", "approval_nominal", "nominal_approval", "nominal_disbursement", "disbursement_amount", "disb_amount", "uk_disbursement", "loan_amount", "amount"]),
    kind: findColumn(columns, ["loan_kind", "customer_type", "mitra_type", "disbursement_type", "loan_type", "jenis_mitra", "tipe_mitra", "jenis_loan"]),
    status: findColumn(columns, ["approval_status", "status_approval", "status", "approval_result", "decision"]),
    date: findColumn(columns, ["approval_date", "approved_date", "tanggal_approval", "tanggal_approve", "date", "tanggal"]),
  };
}

function buildDatasetFromWorkbook(workbook, sourceName) {
  const sheets = workbook.SheetNames.map((name) => {
    const ws = workbook.Sheets[name];
    const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
    const rows = normalizeRows(matrix);
    const columns = rows.length ? Object.keys(rows[0]) : (matrix[0] || []).map(normalizeHeader).filter(Boolean);
    return {
      name,
      rows,
      columns,
      rowCount: rows.length,
      columnsCount: columns.length,
      detected: detectDatasetColumns(columns),
    };
  });
  return { sourceName, loadedAt: Date.now(), sheets };
}

function activeSheetFor(session, preferredName = null) {
  if (!session) return null;
  if (preferredName) {
    const exact = session.sheets.find((s) => s.name.toLowerCase() === preferredName.toLowerCase());
    if (exact) return exact;
  }
  return session.sheets[0] || null;
}

function formatCompactNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 }).format(value);
}

function formatPct(value) {
  if (!Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(2)}%`;
}

function formatMoney(value) {
  return `Rp ${formatCompactNumber(value)}`;
}

function isYes(value) {
  return /^(yes|ya|y|1|true)$/i.test(String(value ?? "").trim());
}

function isNo(value) {
  return /^(no|tidak|n|0|false)$/i.test(String(value ?? "").trim());
}

function uniqueValues(sheet, column) {
  if (!column) return [];
  return [...new Set(sheet.rows.map(r => String(r[column] ?? "").trim()).filter(Boolean))];
}

function detectPointFromQuestion(question, sheet) {
  const q = String(question).toLowerCase();
  const points = uniqueValues(sheet, sheet.detected.point)
    .sort((a,b)=>b.length-a.length);
  return points.find(p => q.includes(p.toLowerCase())) || null;
}

function filterRows(sheet, point = null) {
  if (!point || !sheet.detected.point) return sheet.rows;
  return sheet.rows.filter(r => String(r[sheet.detected.point] ?? "").trim().toLowerCase() === point.toLowerCase());
}

function repaymentSummary(sheet, pointFilter = null) {
  const d = sheet.detected;
  if (!d.dpdOld || !d.paymentMin1x) return null;
  const rows = filterRows(sheet, pointFilter);
  let current = 0, paid = 0, paidAmount = 0, os = 0, arrears = 0;
  for (const r of rows) {
    const old = toNumber(r[d.dpdOld]);
    if (old === 0) {
      current += 1;
      if (isYes(r[d.paymentMin1x])) paid += 1;
      paidAmount += d.payment ? (toNumber(r[d.payment]) || 0) : 0;
      os += d.osNew ? (toNumber(r[d.osNew]) || 0) : 0;
      arrears += d.arrears ? (toNumber(r[d.arrears]) || 0) : 0;
    }
  }
  return { rows: rows.length, current, paid, unpaid: current-paid, repayment: current ? paid/current : null, paidAmount, os, arrears };
}

function aggregateSheet(sheet, point = null) {
  const rows = filterRows(sheet, point);
  const d = sheet.detected;
  let payment=0, arrears=0, os=0, installment=0;
  const dpdOld = new Map(), dpdNew = new Map(), movement = new Map(), paymentFlag = new Map();
  for (const r of rows) {
    payment += d.payment ? (toNumber(r[d.payment]) || 0) : 0;
    arrears += d.arrears ? (toNumber(r[d.arrears]) || 0) : 0;
    os += d.osNew ? (toNumber(r[d.osNew]) || 0) : 0;
    installment += d.installment ? (toNumber(r[d.installment]) || 0) : 0;
    if (d.dpdOld) { const v=String(r[d.dpdOld]); dpdOld.set(v,(dpdOld.get(v)||0)+1); }
    if (d.dpdNew) { const v=String(r[d.dpdNew]); dpdNew.set(v,(dpdNew.get(v)||0)+1); }
    if (d.movement) { const v=String(r[d.movement]||"(blank)"); movement.set(v,(movement.get(v)||0)+1); }
    if (d.paymentMin1x) { const v=isYes(r[d.paymentMin1x])?"Yes":isNo(r[d.paymentMin1x])?"No":String(r[d.paymentMin1x]); paymentFlag.set(v,(paymentFlag.get(v)||0)+1); }
  }
  return { rows: rows.length, payment, arrears, os, installment,
    dpdOld:[...dpdOld.entries()].sort((a,b)=>Number(a[0])-Number(b[0])),
    dpdNew:[...dpdNew.entries()].sort((a,b)=>Number(a[0])-Number(b[0])),
    movement:[...movement.entries()].sort((a,b)=>b[1]-a[1]),
    paymentFlag:[...paymentFlag.entries()].sort((a,b)=>b[1]-a[1]) };
}

function summarizeSheet(sheet) {
  const d = sheet.detected;
  const points = uniqueValues(sheet, d.point);
  const agg = aggregateSheet(sheet);
  return { rows: sheet.rowCount, columns: sheet.columnsCount, points: points.length, pointSample: points.slice(0,30), detected:d, aggregate:agg };
}

function topPointsByMetric(sheet, metric = "payment", ascending = false) {
  const d = sheet.detected;
  if (!d.point) return [];
  const points = uniqueValues(sheet, d.point);
  const out = [];
  for (const point of points) {
    const rows = filterRows(sheet, point);
    if (metric === "repayment") {
      const r = repaymentSummary(sheet, point);
      if (r && r.current) out.push([point, r.repayment, r]);
    } else {
      const a = aggregateSheet(sheet, point);
      const value = metric === "payment" ? a.payment : metric === "arrears" ? a.arrears : metric === "os" ? a.os : a.rows;
      out.push([point, value, a]);
    }
  }
  out.sort((a,b)=>ascending ? a[1]-b[1] : b[1]-a[1]);
  return out;
}

function makeChartSvg(title, labels, values, unit = "") {
  const width = 1100, height = 620, left = 100, right = 40, top = 85, bottom = 150;
  const chartW = width-left-right, chartH = height-top-bottom;
  const max = Math.max(...values.map(v=>Math.abs(v)), 1);
  const gap = chartW / Math.max(labels.length, 1);
  const barW = Math.max(20, gap * 0.62);
  const bars = labels.map((label, i) => {
    const h = (Math.abs(values[i]) / max) * (chartH - 30);
    const x = left + i*gap + (gap-barW)/2;
    const y = top + chartH - h;
    const safeLabel = String(label).slice(0, 18).replace(/&/g,"&amp;").replace(/</g,"&lt;");
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="8"/><text x="${(x+barW/2).toFixed(1)}" y="${(y-10).toFixed(1)}" text-anchor="middle" font-size="15">${formatCompactNumber(values[i])}${unit}</text><text x="${(x+barW/2).toFixed(1)}" y="${height-85}" text-anchor="middle" font-size="14" transform="rotate(-35 ${(x+barW/2).toFixed(1)} ${height-85})">${safeLabel}</text>`;
  }).join("");
  const safeTitle = String(title).replace(/&/g,"&amp;").replace(/</g,"&lt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/><text x="${width/2}" y="42" text-anchor="middle" font-size="26" font-weight="700">${safeTitle}</text><line x1="${left}" y1="${top+chartH}" x2="${width-right}" y2="${top+chartH}" stroke="#555"/>${bars}</svg>`;
}

async function makeChartBuffer(title, labels, values, unit = "") {
  return sharp(Buffer.from(makeChartSvg(title, labels, values, unit))).png().toBuffer();
}

function listSpreadsheetStatus(session) {
  if (!session) return "Belum ada spreadsheet yang dimuat. Kirim Excel/CSV atau link Google Sheets terlebih dahulu.";
  const lines = session.sheets.map((s, i) => `${i+1}. ${s.name} — ${s.rowCount.toLocaleString("id-ID")} baris × ${s.columnsCount} kolom`);
  const s=activeSheetFor(session), d=s?.detected||{};
  const points=s&&d.point?uniqueValues(s,d.point):[];
  return `📊 *SPREADSHEET MARLEY*\nSumber: ${session.sourceName}\n\n${lines.join("\n")}\n\nPoint terdeteksi: ${points.length}${points.length?` (${points.slice(0,12).join(", ")}${points.length>12?", ...":""})`:""}`;
}

async function loadSpreadsheetBuffer(buffer, sourceName) {
  await ensureSpreadsheetDir();
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true, raw: true });
  return buildDatasetFromWorkbook(workbook, sourceName);
}

function extractGoogleSheetInfo(url) {
  const match = String(url).match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) return null;
  const gidMatch = String(url).match(/[?#&]gid=(\d+)/);
  return { id: match[1], gid: gidMatch ? gidMatch[1] : null };
}

async function loadPublicGoogleSheet(url) {
  const info = extractGoogleSheetInfo(url);
  if (!info) throw new Error("Link Google Sheets tidak dikenali.");
  const exportUrl = `https://docs.google.com/spreadsheets/d/${info.id}/export?format=xlsx${info.gid ? `&gid=${info.gid}` : ""}`;
  const response = await fetch(exportUrl, { redirect: "follow" });
  if (!response.ok) throw new Error(`Google Sheets mengembalikan HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type") || "";
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!contentType.includes("spreadsheet") && buffer.slice(0, 20).toString().includes("<")) throw new Error("Spreadsheet tidak bisa diakses publik. Ubah akses Google Sheets menjadi Anyone with the link / Viewer.");
  return loadSpreadsheetBuffer(buffer, `Google Sheets (${info.id})`);
}

async function processSpreadsheetUpload(sock, from, msg, caption = "") {
  const document = msg.message?.documentMessage || msg.message?.documentWithCaptionMessage?.message?.documentMessage;
  if (!document) return false;
  const isGroup = from.endsWith("@g.us");
  const allowedCaption = !isGroup || containsBotTrigger(caption) || /^\s*\/excel\b/i.test(caption);
  if (!allowedCaption) return false;
  const filename = document.fileName || "spreadsheet";
  const mime = document.mimetype || "application/octet-stream";
  if (!/\.(xlsx|xls|csv)$/i.test(filename) && !/spreadsheet|excel|csv/i.test(mime)) return false;
  if (isKpDailySourceName(filename) || /kp\s*daily/i.test(caption)) return processKpDailyUpload(sock, from, msg, caption);
  try {
    await sock.sendMessage(from, { text: `📊 Marley sedang membaca *${filename}*...` });
    const buffer = await downloadMediaMessage(msg, "buffer", {});
    const session = await loadSpreadsheetBuffer(buffer, filename);
    spreadsheetSessions.set(from, session);
    await sock.sendMessage(from, { text: `✅ Spreadsheet berhasil dibaca.\n\n${listSpreadsheetStatus(session)}\n\nMarley siap menganalisa *file ini saja*.\nContoh: *Marley, analisa repayment*` });
  } catch (err) {
    console.error("Spreadsheet upload error:", err);
    await sock.sendMessage(from, { text: `❌ Marley gagal membaca spreadsheet.\n${err.message}` });
  }
  return true;
}

function answerDataQuestion(sheet, question) {
  const q = String(question).toLowerCase();
  const point = detectPointFromQuestion(question, sheet);
  const all = aggregateSheet(sheet, point);
  const rep = repaymentSummary(sheet, point);
  const d=sheet.detected;

  if (q.includes("repayment")) {
    if (!rep) return "Kolom repayment yang dibutuhkan belum ditemukan. Marley membutuhkan DPD Old dan Payment Min 1x (Yes/No).";
    return `📈 *ANALISA REPAYMENT*\n${point?`Point: ${point}`:"Area/File: seluruh data"}\n\nLoan DPD 0: ${formatCompactNumber(rep.current)}\nPayment ≥1x: ${formatCompactNumber(rep.paid)}\nBelum Payment: ${formatCompactNumber(rep.unpaid)}\nRepayment: ${formatPct(rep.repayment)}\nTotal Payment DPD 0: ${formatMoney(rep.paidAmount)}\nOS New DPD 0: ${formatMoney(rep.os)}`;
  }

  if (/total\s+(payment|pembayaran)|payment\s+total|jumlah\s+payment/.test(q)) return `💰 *TOTAL PAYMENT*\n${point?`Point: ${point}`:"Seluruh data"}\nTotal Payment: ${formatMoney(all.payment)}`;
  if (/tunggakan|arrears/.test(q)) return `⚠️ *TOTAL TUNGGAKAN*\n${point?`Point: ${point}`:"Seluruh data"}\nTotal Tunggakan: ${formatMoney(all.arrears)}`;
  if (/\bos\b|outstanding/.test(q)) return `📦 *OUTSTANDING*\n${point?`Point: ${point}`:"Seluruh data"}\nOS New: ${formatMoney(all.os)}`;
  if (/berapa.*(loan|akun|mitra)|jumlah.*(loan|akun|mitra)|jumlah data/.test(q)) return `🔢 *JUMLAH DATA*\n${point?`Point: ${point}`:"Seluruh data"}\nJumlah baris/loan: ${formatCompactNumber(all.rows)}`;

  if (/point mana|per point|ranking/.test(q)) {
    const wantsRep = q.includes("repayment");
    const wantsLowest = /terendah|paling rendah|terburuk|terkecil|lowest/.test(q);
    const metric = wantsRep ? "repayment" : q.includes("tunggakan")||q.includes("arrears") ? "arrears" : q.includes("os") ? "os" : q.includes("jumlah")||q.includes("loan") ? "rows" : "payment";
    const top=topPointsByMetric(sheet,metric,wantsLowest).slice(0,10);
    if (!top.length) return "Belum ditemukan data point yang sesuai.";
    const lines=top.map(([p,v,r],i)=>`${i+1}. ${p}: ${metric==="repayment"?formatPct(v):metric==="rows"?formatCompactNumber(v)+" loan":formatMoney(v)}`);
    return `🏆 *RANKING PER POINT — ${metric.toUpperCase()}*\n\n${lines.join("\n")}`;
  }

  if (q.includes("dpd") && d.dpdOld) {
    const old=all.dpdOld.map(([k,v])=>`${k}: ${formatCompactNumber(v)}`).join(" | ");
    const neu=all.dpdNew.map(([k,v])=>`${k}: ${formatCompactNumber(v)}`).join(" | ");
    return `📌 *DISTRIBUSI DPD*\n${point?`Point: ${point}`:"Seluruh data"}\nDPD Old: ${old||"-"}\nDPD New: ${neu||"-"}`;
  }

  return null;
}

async function answerSpreadsheetQuestion(sock, from, question) {
  const session = spreadsheetSessions.get(from);
  if (!session) { await sock.sendMessage(from, { text: "Belum ada spreadsheet yang dimuat di percakapan ini. Kirim Excel/CSV atau link Google Sheets terlebih dahulu." }); return; }
  const sheet = activeSheetFor(session);
  const q=String(question).trim();
  const kpiAnswer=answerKpiQuestion(sheet,q);
  if(kpiAnswer){await sock.sendMessage(from,{text:kpiAnswer});return;}
  if (/^(sheet|sheets|data|excel|spreadsheet)\b/i.test(q) || /isi file|struktur file|kolom apa/i.test(q)) {
    const s=summarizeSheet(sheet), d=s.detected;
    await sock.sendMessage(from,{text:`${listSpreadsheetStatus(session)}\n\n*Kolom penting:*\n${Object.entries(d).filter(([,v])=>v).map(([k,v])=>`• ${k}: ${v}`).join("\n")}\n\n*Distribusi payment min 1x:* ${(s.aggregate.paymentFlag||[]).map(([k,v])=>`${k}=${v}`).join(" | ")}`});
    return;
  }
  const deterministic=answerDataQuestion(sheet,q);
  if (deterministic) { await sock.sendMessage(from,{text:deterministic}); return; }

  // Gemini is used only after deterministic aggregation, so it never has to infer totals from 80 sample rows.
  const a=aggregateSheet(sheet);
  const points=sheet.detected.point?uniqueValues(sheet,sheet.detected.point):[];
  const rep=repaymentSummary(sheet);
  const pointRep=topPointsByMetric(sheet,"repayment").map(([p,v])=>({point:p,repayment:v}));
  const context = `Spreadsheet: ${session.sourceName}\nSheet: ${sheet.name}\nRows: ${sheet.rowCount}\nColumns: ${sheet.columns.join(", ")}\nPoints (${points.length}): ${points.join(", ")}\nAggregate: ${JSON.stringify(a)}\nRepayment overall: ${JSON.stringify(rep)}\nRepayment by point: ${JSON.stringify(pointRep)}\nQuestion: ${q}`;
  const prompt=`Kamu adalah Marley, analis data operasional Amartha. Jawab HANYA berdasarkan agregasi spreadsheet yang diberikan. Jangan menghitung ulang dari sampel dan jangan mengarang angka. Jika pertanyaan meminta angka yang tidak tersedia, jelaskan field apa yang diperlukan. Bedakan Total Payment dengan Repayment Rate. Repayment Rate untuk dataset ini menggunakan loan DPD Old=0 yang Payment Min 1x=Yes dibagi seluruh loan DPD Old=0.\n\n${context}`;
  const result=await askGemini(prompt,"Gunakan hanya data spreadsheet yang sedang dimuat.");
  await sock.sendMessage(from,{text:result});
}

async function processSpreadsheetLink(sock, from, text) {
  const urlMatch=String(text).match(/https?:\/\/docs\.google\.com\/spreadsheets\/d\/[^\s>]+/i);
  if(!urlMatch)return false;
  const isGroup=from.endsWith("@g.us");
  if(isGroup&&!containsBotTrigger(text))return false;
  try{await sock.sendMessage(from,{text:"🔗 Marley sedang membaca Google Sheets..."});const session=await loadPublicGoogleSheet(urlMatch[0]);spreadsheetSessions.set(from,session);await sock.sendMessage(from,{text:`✅ Google Sheets berhasil dimuat.\n\n${listSpreadsheetStatus(session)}\n\nMarley siap menganalisa *sheet ini saja*.`});}
  catch(err){await sock.sendMessage(from,{text:`❌ Tidak bisa membaca Google Sheets.\n${err.message}\n\nJika sheet private, upload Excel-nya ke WhatsApp atau buat akses Viewer via link.`});}
  return true;
}

async function processSpreadsheetCommand(sock, from, command) {
  const session=spreadsheetSessions.get(from);
  if(command==="/data"||command==="/sheet"){await sock.sendMessage(from,{text:listSpreadsheetStatus(session)});return true;}
  if(command==="/kpi"||command==="/kpiranking"||command.startsWith("/kpi ")){const kpSession=kpDailySessions.get(from);if(!session&&!kpSession){await sock.sendMessage(from,{text:"Belum ada file KPI/Portfolio atau KP Daily yang dimuat."});return true;}const sheet=session?activeSheetFor(session):null,q=command==="/kpiranking"?"ranking kpi per point":command.slice(4).trim()||"kpi";await sock.sendMessage(from,{text:answerKpiQuestion(sheet,q,kpSession)||"Belum ada data KPI yang dapat dihitung."});return true;}
  if(command==="/grafik"||command.startsWith("/grafik ")){
    if(!session){await sock.sendMessage(from,{text:"Belum ada spreadsheet yang dimuat."});return true;}
    const sheet=activeSheetFor(session), arg=command.slice(7).trim().toLowerCase();
    const metric=arg.includes("repayment")?"repayment":arg.includes("tunggakan")?"arrears":arg.includes("os")?"os":"payment";
    const lowest=/terendah|rendah|lowest/.test(arg);
    const top=topPointsByMetric(sheet,metric,lowest).slice(0,10);
    if(!top.length){await sock.sendMessage(from,{text:"Data untuk grafik tidak ditemukan."});return true;}
    const image=await makeChartBuffer(`Point — ${metric.toUpperCase()}${lowest?" (Terendah)":""}`,top.map(x=>x[0]),top.map(x=>metric==="repayment"?x[1]*100:x[1]),metric==="repayment"?"%":"");
    await sock.sendMessage(from,{image,caption:`📊 Grafik ${metric} per point dari *${session.sourceName}*.`});
    return true;
  }
  return false;
}



// ======================================================
// KPI INTELLIGENCE MARLEY V5
// Repayment: Portfolio/loan file.
// NTB & ETB: KP Daily (daily approval process) ONLY.
// KP Daily is regional; Marley filters Area = Bangkalan only.
// ======================================================
const KPI_CONFIG={dpd0:{target:.98,weight:.35},dpd1_30:{target:.55,weight:.10},dpd31_90:{target:.13,weight:.10},ntbPerBp:Number(process.env.KPI_NTB_PER_BP||100000000),etbPerBp:Number(process.env.KPI_ETB_PER_BP||175000000),ntbWeight:.25,etbWeight:.20};
function scoreKpiDpd0(r){if(!Number.isFinite(r))return null;if(r<.90)return 0;if(r<.93)return .25;if(r<.94)return .50;if(r<.95)return .60;if(r<.96)return .70;if(r<.97)return .80;if(r<=.98)return 1;return 1.20;}
function scoreKpiDpd1_30(r){if(!Number.isFinite(r))return null;if(r<=KPI_CONFIG.dpd1_30.target)return r/KPI_CONFIG.dpd1_30.target;if(r<=.65)return 1.20;return 1.30;}
function scoreKpiDpd31_90(r){if(!Number.isFinite(r))return null;if(r<=KPI_CONFIG.dpd31_90.target)return r/KPI_CONFIG.dpd31_90.target;if(r<=.20)return 1.20;return 1.30;}

function kpiRepaymentBucket(sheet,pointFilter,minDpd,maxDpd){const d=sheet.detected;if(!d.dpdOld||!d.paymentMin1x)return null;const rows=filterRows(sheet,pointFilter);let total=0,paid=0,paymentAmount=0,os=0,arrears=0;for(const r of rows){const dpd=toNumber(r[d.dpdOld]);if(dpd===null||dpd<minDpd||dpd>maxDpd)continue;total++;if(isYes(r[d.paymentMin1x]))paid++;if(d.payment)paymentAmount+=toNumber(r[d.payment])||0;if(d.osNew)os+=toNumber(r[d.osNew])||0;if(d.arrears)arrears+=toNumber(r[d.arrears])||0;}return{total,paid,unpaid:total-paid,repayment:total?paid/total:null,paymentAmount,os,arrears};}

function isKpDailySourceName(name){return /kp\s*daily|kp_daily|kpdaily/i.test(String(name||""));}
function isApprovalStatus(value){const s=String(value??"").trim().toLowerCase();if(!s)return true;return /approve|approved|approval|disetujui|setuju|lolos|approved\s*\/\s*approve/i.test(s);}
function normalizeArea(value){return String(value??"").trim().toLowerCase().replace(/\s+/g," ");}
function kpDailyRowsBangkalan(sheet){const d=sheet.kpDetected||detectKpDailyColumns(sheet.columns||[]);if(!d.area)return{rows:[],error:"Kolom Area pada KP Daily belum ditemukan. Karena file bersifat regional, Marley tidak akan mencampur 4 area tanpa filter Area Bangkalan."};const rows=sheet.rows.filter(r=>normalizeArea(r[d.area])==="bangkalan");return{rows,error:null};}
function classifyDisbursementKind(v){const s=String(v??"").trim().toLowerCase();if(/\bntb\b|mitra\s*baru|baru|new/.test(s))return"NTB";if(/\betb\b|mitra\s*lanjutan|lanjutan|existing|repeat/.test(s))return"ETB";return null;}
function kpiKpDailySummary(session){if(!session)return{available:false,error:"File KP Daily belum dimuat."};const sheet=activeSheetFor(session);const d=sheet.kpDetected||detectKpDailyColumns(sheet.columns||[]);const filtered=kpDailyRowsBangkalan(sheet);if(filtered.error)return{available:false,error:filtered.error,columns:d};const rows=filtered.rows;if(!d.amount||!d.kind)return{available:false,error:"Kolom nominal approval atau klasifikasi NTB/ETB pada KP Daily belum ditemukan.",columns:d,bangkalanRows:rows.length};let ntb=0,etb=0,ntbCount=0,etbCount=0;const bps=new Set();for(const r of rows){if(d.status&&!isApprovalStatus(r[d.status]))continue;const a=toNumber(r[d.amount]);const k=classifyDisbursementKind(r[d.kind]);if(d.bp&&String(r[d.bp]??"").trim())bps.add(String(r[d.bp]).trim());if(a===null||!k)continue;if(k==="NTB"){ntb+=a;ntbCount++;}else{etb+=a;etbCount++;}}const bpCount=bps.size;const ntbTarget=KPI_CONFIG.ntbPerBp*bpCount;const etbTarget=KPI_CONFIG.etbPerBp*bpCount;return{available:true,source:session.sourceName,area:"Bangkalan",rowCount:rows.length,bpCount,ntb:{actual:ntb,count:ntbCount,target:ntbTarget,achievement:ntbTarget?ntb/ntbTarget:null,score:ntbTarget?Math.min(ntb/ntbTarget,1.5):null},etb:{actual:etb,count:etbCount,target:etbTarget,achievement:etbTarget?etb/etbTarget:null,score:etbTarget?Math.min(etb/etbTarget,1.5):null},detected:d};}

function buildKpiSnapshot(sheet,pointFilter=null,kpSession=null){const b0=kpiRepaymentBucket(sheet,pointFilter,0,0),b1=kpiRepaymentBucket(sheet,pointFilter,1,30),b31=kpiRepaymentBucket(sheet,pointFilter,31,90),di=kpiKpDailySummary(kpSession);const m=[{key:"dpd0",label:"Repayment DPD 0",target:KPI_CONFIG.dpd0.target,weight:.35,actual:b0?.repayment??null,score:scoreKpiDpd0(b0?.repayment??null)},{key:"dpd1_30",label:"Repayment DPD 1-30",target:.55,weight:.10,actual:b1?.repayment??null,score:scoreKpiDpd1_30(b1?.repayment??null)},{key:"dpd31_90",label:"Repayment DPD 31-90",target:.13,weight:.10,actual:b31?.repayment??null,score:scoreKpiDpd31_90(b31?.repayment??null)},{key:"ntb",label:"Disbursement NTB",target:di?.ntb?.target??null,weight:.25,actual:di?.ntb?.actual??null,score:di?.ntb?.score??null},{key:"etb",label:"Disbursement ETB",target:di?.etb?.target??null,weight:.20,actual:di?.etb?.actual??null,score:di?.etb?.score??null}];const av=m.filter(x=>Number.isFinite(x.score)),weighted=av.reduce((s,x)=>s+x.score*x.weight,0),wa=av.reduce((s,x)=>s+x.weight,0);return{point:pointFilter,metrics:m,weightedScore:weighted,availableWeight:wa,complete:av.length===m.length,buckets:{dpd0:b0,dpd1_30:b1,dpd31_90:b31},disbursement:di};}
function formatKpiMetricLine(m){const money=m.key==="ntb"||m.key==="etb",t=money?(m.target===null?"N/A":formatMoney(m.target)):formatPct(m.target),a=money?(m.actual===null?"-":formatMoney(m.actual)):formatPct(m.actual),s=Number.isFinite(m.score)?formatPct(m.score):"N/A";return`• ${m.label}: actual ${a} | target ${t} | score ${s} | bobot ${formatPct(m.weight)}`;}
function answerKpiQuestion(sheet,question,kpSession=null){const q=String(question||"").toLowerCase(),point=sheet?detectPointFromQuestion(question,sheet):null;if(/ranking|per point|point mana|point tertinggi|point terendah/.test(q)&&sheet?.detected?.point){const arr=uniqueValues(sheet,sheet.detected.point).map(p=>({p,k:buildKpiSnapshot(sheet,p,kpSession)})).filter(x=>x.k.availableWeight>0).sort((a,b)=>b.k.weightedScore-a.k.weightedScore).slice(0,10);return`📊 *KPI PER POINT*\n\n${arr.map((x,i)=>`${i+1}. ${x.p}: ${formatPct(x.k.weightedScore)} | bobot tersedia ${formatPct(x.k.availableWeight)}`).join("\n")}\n\nCatatan: NTB/ETB berasal dari KP Daily Area Bangkalan; parameter yang tidak tersedia tidak dianggap 0.`;}
if(!/(kpi|repayment|ntb|etb|disbursement|dpd)/.test(q))return null;const k=buildKpiSnapshot(sheet||{detected:{},rows:[]},point,kpSession),lines=k.metrics.map(formatKpiMetricLine).join("\n"),total=k.complete?`\n\n*Weighted KPI Score: ${formatPct(k.weightedScore)}*`:`\n\n*Weighted Score tersedia: ${formatPct(k.weightedScore)}*\nBobot parameter tersedia: ${formatPct(k.availableWeight)}\nParameter yang belum dapat dihitung tidak dianggap 0.`;const sourceNote=k.disbursement.available?`\n\n📁 Sumber NTB/ETB: *${k.disbursement.source}* — filter *Area Bangkalan* (${k.disbursement.rowCount.toLocaleString("id-ID")} baris).`:`\n\n⚠️ NTB/ETB: ${k.disbursement.error||"KP Daily belum tersedia."}`;return`🎯 *KPI INTELLIGENCE V5*\n${point?`Point: ${point}`:"Area: Bangkalan untuk NTB/ETB"}\n\n${lines}${total}${sourceNote}`;}

async function processKpDailyUpload(sock,from,msg,caption=""){const document=msg.message?.documentMessage||msg.message?.documentWithCaptionMessage?.message?.documentMessage;if(!document)return false;const filename=document.fileName||"KP Daily";const mime=document.mimetype||"application/octet-stream";if(!isKpDailySourceName(filename)&&!/kp\s*daily/i.test(caption))return false;if(!/\.(xlsx|xls|csv)$/i.test(filename)&&!/spreadsheet|excel|csv/i.test(mime))return false;try{await sock.sendMessage(from,{text:`📊 Marley membaca *${filename}* sebagai sumber *KP Daily*...`});const buffer=await downloadMediaMessage(msg,"buffer",{});const session=await loadSpreadsheetBuffer(buffer,filename);for(const s of session.sheets)s.kpDetected=detectKpDailyColumns(s.columns);kpDailySessions.set(from,session);const sh=activeSheetFor(session),d=sh.kpDetected;const area=d.area?uniqueValues(sh,d.area):[];await sock.sendMessage(from,{text:`✅ *KP Daily berhasil dimuat.*\nSumber: ${filename}\nSheet: ${session.sheets.length}\nArea terdeteksi: ${area.slice(0,10).join(", ")||"-"}\n\nMarley akan mengambil *hanya Area Bangkalan* untuk NTB/ETB.`});}catch(err){console.error("KP Daily upload error:",err);await sock.sendMessage(from,{text:`❌ Marley gagal membaca KP Daily.\n${err.message}`});}return true;}

// ======================================================
// IDENTITAS BOT
// ======================================================



// ======================================================
// REMINDER ENGINE MARLEY V2
// ======================================================

const REMINDER_TIMEZONE = process.env.TIMEZONE || "Asia/Jakarta";
const QUIET_GROUP_MINUTES = Number(process.env.QUIET_GROUP_MINUTES || 120);
const QUIET_CHECK_START = process.env.QUIET_CHECK_START || "08:00";
const QUIET_CHECK_END = process.env.QUIET_CHECK_END || "21:00";
const QUIET_REMINDER_COOLDOWN = Number(
  process.env.QUIET_REMINDER_COOLDOWN || 120
);

// Isi REMINDER_GROUPS dengan JID grup yang boleh menerima reminder.
// Contoh: 120363012345678901@g.us,120363098765432109@g.us
// Kosong = reminder otomatis tidak dikirim ke grup mana pun.
const REMINDER_GROUPS = new Set(
  String(process.env.REMINDER_GROUPS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
);

const DAILY_REMINDERS = [
  {
    id: "08",
    time: process.env.REMINDER_08 || "08:00",
    text:
      "Ayo Briefing yang bener, disusun dengan baik Plan Penagihan dan Proyeksi Disbursenya, Semangat guys",
  },
  {
    id: "12",
    time: process.env.REMINDER_12 || "12:00",
    text: "Ayo ayo halfday, Cek strategi, apa sudah berjalan",
  },
  {
    id: "15",
    time: process.env.REMINDER_15 || "15:00",
    text: "gimana ada kendala di lapang ?",
  },
  {
    id: "19",
    time: process.env.REMINDER_19 || "19:00",
    text:
      "Cek HV, SOS, FORM KM, Upload Call/Visit, Tugas Modal, Mikronova dan Segera Report",
  },
  {
    id: "21",
    time: process.env.REMINDER_21 || "21:00",
    text:
      "Selamat istirahat, Terimakasih untuk kerja kerasnya hari ini tim, Kita gas lagi besok.",
  },
];

const quietGroupState = new Map();
const sentReminderKeys = new Set();
const sentClosingKeys = new Set();
let reminderTimer = null;
let reminderSocket = null;

function isReminderGroup(groupId) {
  return Boolean(groupId) && REMINDER_GROUPS.has(groupId);
}

function parseHHMM(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function getJakartaNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REMINDER_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(new Date());

  const get = (type) => parts.find((p) => p.type === type)?.value;

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: get("weekday"),
  };
}

function getDateKey(now) {
  return `${now.year}-${now.month}-${now.day}`;
}

function isWithinTimeWindow(hour, minute, start, end) {
  const startParts = parseHHMM(start);
  const endParts = parseHHMM(end);
  if (!startParts || !endParts) return false;

  const current = hour * 60 + minute;
  const startValue = startParts.hour * 60 + startParts.minute;
  const endValue = endParts.hour * 60 + endParts.minute;

  if (startValue <= endValue) {
    return current >= startValue && current <= endValue;
  }

  return current >= startValue || current <= endValue;
}

function cleanupSentReminderKeys(currentDateKey) {
  for (const key of sentReminderKeys) {
    if (!key.startsWith(currentDateKey + ":")) {
      sentReminderKeys.delete(key);
    }
  }
}

async function sendReminderToConfiguredGroups(text) {
  if (!reminderSocket) return;

  if (REMINDER_GROUPS.size === 0) {
    console.warn(
      "Reminder Marley belum aktif: REMINDER_GROUPS belum diisi."
    );
    return;
  }

  for (const groupId of REMINDER_GROUPS) {
    try {
      await reminderSocket.sendMessage(groupId, { text });
      console.log(`Reminder Marley terkirim ke ${groupId}`);
    } catch (err) {
      console.error(
        `Gagal mengirim reminder ke ${groupId}:`,
        err?.message || err
      );
    }
  }
}

async function processScheduledReminders(now) {
  const dateKey = getDateKey(now);
  cleanupSentReminderKeys(dateKey);

  for (const reminder of DAILY_REMINDERS) {
    const time = parseHHMM(reminder.time);
    if (!time) {
      console.warn(`Format waktu reminder tidak valid: ${reminder.time}`);
      continue;
    }

    if (now.hour !== time.hour || now.minute !== time.minute) continue;

    const key = `${dateKey}:${reminder.id}`;
    if (sentReminderKeys.has(key)) continue;

    sentReminderKeys.add(key);
    await sendReminderToConfiguredGroups(`📢 ${reminder.text}`);
  }
}

async function processQuietGroups(now) {
  if (
    !isWithinTimeWindow(
      now.hour,
      now.minute,
      QUIET_CHECK_START,
      QUIET_CHECK_END
    )
  ) {
    return;
  }

  if (!reminderSocket || REMINDER_GROUPS.size === 0) return;

  const nowMs = Date.now();
  const quietMs = QUIET_GROUP_MINUTES * 60 * 1000;
  const cooldownMs = QUIET_REMINDER_COOLDOWN * 60 * 1000;

  for (const groupId of REMINDER_GROUPS) {
    const state = quietGroupState.get(groupId);
    if (!state?.lastActivity) continue;

    const inactiveMs = nowMs - state.lastActivity;
    if (inactiveMs < quietMs) continue;

    if (
      state.lastQuietReminder &&
      nowMs - state.lastQuietReminder < cooldownMs
    ) {
      continue;
    }

    const inactiveMinutes = Math.floor(inactiveMs / 60000);

    try {
      await reminderSocket.sendMessage(groupId, {
        text:
          `📢 WOI TEAM 😄\n\n` +
          `Grup sudah sepi sekitar ${inactiveMinutes} menit.\n` +
          `Jangan lupa update kegiatan lapang masing-masing ya.\n\n` +
          `Kalau ada kendala, langsung sampaikan di grup supaya bisa kita bantu cari solusinya.\n\n` +
          `Semangat team! 💪`,
      });

      state.lastQuietReminder = nowMs;
      console.log(
        `Quiet-group reminder terkirim ke ${groupId} setelah ${inactiveMinutes} menit.`
      );
    } catch (err) {
      console.error(
        `Gagal mengirim quiet-group reminder ke ${groupId}:`,
        err?.message || err
      );
    }
  }
}

function startReminderEngine(sock) {
  reminderSocket = sock;

  if (reminderTimer) return;

  console.log("========================================");
  console.log("REMINDER ENGINE MARLEY AKTIF");
  console.log(`Timezone: ${REMINDER_TIMEZONE}`);
  console.log(`Quiet group: ${QUIET_GROUP_MINUTES} menit`);
  console.log(`Reminder groups: ${REMINDER_GROUPS.size}`);
  console.log("========================================");

  // Cek setiap 30 detik agar reminder tidak bergantung pada adanya pesan masuk.
  reminderTimer = setInterval(async () => {
    if (!reminderSocket) return;

    try {
      const now = getJakartaNow();
      await processScheduledReminders(now);
      await processQuietGroups(now);
    } catch (err) {
      console.error("Error Reminder Engine:", err);
    }
  }, 30 * 1000);
}

function trackGroupActivity(groupId) {
  if (!groupId || !isReminderGroup(groupId)) return;

  const current = quietGroupState.get(groupId) || {
    lastActivity: null,
    lastQuietReminder: null,
  };

  current.lastActivity = Date.now();
  quietGroupState.set(groupId, current);
}

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

async function resolveMentionedUsers(sock, groupId, mentionedJids = []) {
  if (!groupId?.endsWith("@g.us") || !mentionedJids.length) return [];

  try {
    const metadata = await sock.groupMetadata(groupId);
    const participants = metadata?.participants || [];

    const normalizeJid = (jid) =>
      String(jid || "")
        .replace(/:\d+(?=@)/, "")
        .trim();

    return mentionedJids.map((jid) => {
      const cleanJid = normalizeJid(jid);
      const participant = participants.find(
        (p) => normalizeJid(p.id || p.jid || p.lid) === cleanJid
      );

      const displayName =
        participant?.notify ||
        participant?.name ||
        participant?.vname ||
        participant?.shortName ||
        cleanJid.split("@")[0];

      return { jid: cleanJid, name: displayName };
    });
  } catch (err) {
    console.warn("Gagal membaca metadata mention grup:", err?.message || err);
    return mentionedJids.map((jid) => ({
      jid: String(jid),
      name: String(jid).split("@")[0].replace(/:.*$/, ""),
    }));
  }
}

function formatMentionContext(mentionedUsers = []) {
  if (!mentionedUsers.length) return "";
  return mentionedUsers
    .map((u) => `- ${u.name} (${u.jid})`)
    .join("\n");
}

// ======================================================
// START BOT
// ======================================================

const AUTH_DIR = process.env.AUTH_DIR || "/app/data/auth_info_baileys";

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
  });

  // Socket terbaru dipakai oleh Reminder Engine, termasuk setelah reconnect.
  reminderSocket = sock;

  sock.ev.on("creds.update", saveCreds);

  startReminderEngine(sock);

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

      // Aktivitas grup dipakai oleh Quiet Group Detection.
      trackGroupActivity(from);

      const sender =
        msg.pushName ||
        msg.key.participant ||
        from;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.documentMessage?.caption ||
        msg.message.documentWithCaptionMessage?.message?.documentMessage?.caption ||
        "";

      // Spreadsheet / CSV / Google Sheets engine.
      try {
        const document = msg.message?.documentMessage || msg.message?.documentWithCaptionMessage?.message?.documentMessage;
        const documentName = document?.fileName || "";
        if (document && isOpsPortfolioSourceName(documentName)) {
          const handledOps = await processOpsReportUpload(sock, from, msg, documentName);
          if (handledOps) return;
        }

        const handledFile = await processSpreadsheetUpload(sock, from, msg, text);
        if (handledFile) return;
        const handledLink = await processSpreadsheetLink(sock, from, text);
        if (handledLink) return;
      } catch (spreadsheetErr) {
        console.error("Spreadsheet engine error:", spreadsheetErr);
      }

      const mentionedJids =
        msg.message.extendedTextMessage?.contextInfo
          ?.mentionedJid || [];

      // Baca siapa saja yang benar-benar di-tag di WhatsApp.
      const mentionedUsers =
        await resolveMentionedUsers(sock, from, mentionedJids);

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

        // Report Closing Harian diproses otomatis sebelum command/AI.
        if (text && /REPORT\s+CLOSING\s+HARIAN/i.test(text)) {
          try {
            const handled = await processIncomingDailyReport(sock, from, sender, text);
            if (handled) return;
          } catch (reportErr) {
            console.error("Error saat parsing Report Closing:", reportErr);
          }
        }
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

        if (command === "/dbstatus" || command === "/portfoliodb") {
          await sock.sendMessage(from, { text: portfolioDatabaseStatus() });
          return;
        }

        if (/^\/loan\s+/i.test(command)) {
          const query = command.replace(/^\/loan\s+/i, "").trim();
          const found = portfolioDatabaseFind(query);
          if (!found.length) {
            await sock.sendMessage(from, { text: `🔎 Loan/customer *${query}* tidak ditemukan di Portfolio Database.` });
          } else {
            await sock.sendMessage(from, { text: `🔎 *HASIL PENCARIAN LOAN* (${found.length})\n\n${found.slice(0, 10).map(formatPortfolioLoan).join("\n\n────────────\n\n")}` });
          }
          return;
        }

        if (await processSpreadsheetCommand(sock, from, command)) {
          return;
        } else if (command === "/rangkum") {
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
        } else if (command === "/statusclosing") {
          const now = getJakartaNow();
          const date = getDateKey(now);
          await sock.sendMessage(from, { text: formatReportStatus(date) });
        } else if (command === "/rekapclosing") {
          const now = getJakartaNow();
          const date = getDateKey(now);
          await sock.sendMessage(from, { text: formatDailyAreaReport(date) });
        } else if (command.startsWith("/rekapclosing ")) {
          const requestedDate = command.slice("/rekapclosing ".length).trim();
          const valid = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate);
          if (!valid) {
            await sock.sendMessage(from, {
              text: "Format tanggal: /rekapclosing YYYY-MM-DD",
            });
            return;
          }
          await sock.sendMessage(from, { text: formatDailyAreaReport(requestedDate) });
        } else if (command === "/statusclosing ") {
          const now = getJakartaNow();
          const date = getDateKey(now);
          await sock.sendMessage(from, { text: formatReportStatus(date) });
        } else if (command === "/reminderid") {
          if (!isGroup) {
            await sock.sendMessage(from, {
              text: "Perintah /reminderid hanya bisa digunakan di grup WhatsApp.",
            });
            return;
          }

          let subject = "Grup WhatsApp";
          try {
            const metadata = await sock.groupMetadata(from);
            subject = metadata?.subject || subject;
          } catch {
            // Tidak masalah jika metadata grup gagal diambil.
          }

          await sock.sendMessage(from, {
            text:
              `Nama grup: ${subject}\n` +
              `Group JID: ${from}\n\n` +
              `Masukkan JID ini ke REMINDER_GROUPS di .env agar Marley mengirim reminder otomatis ke grup ini.`,
          });
        } else if (command === "/reminderstatus") {
          if (!isGroup) {
            await sock.sendMessage(from, {
              text: "Perintah /reminderstatus hanya bisa digunakan di grup WhatsApp.",
            });
            return;
          }

          const state = quietGroupState.get(from);
          const lastActivity = state?.lastActivity
            ? new Date(state.lastActivity).toLocaleString("id-ID", {
                timeZone: REMINDER_TIMEZONE,
              })
            : "belum tercatat";

          const isConfigured = isReminderGroup(from);

          await sock.sendMessage(from, {
            text:
              `🤖 STATUS REMINDER MARLEY\n\n` +
              `Reminder grup: ${isConfigured ? "AKTIF" : "TIDAK AKTIF"}\n` +
              `Batas grup sepi: ${QUIET_GROUP_MINUTES} menit\n` +
              `Aktivitas terakhir: ${lastActivity}`,
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
              "/data - status spreadsheet yang sedang dimuat\n" +
              "Upload file bernama KP Daily - menjadi sumber NTB/ETB (hanya Area Bangkalan)\n" +
              "/grafik - buat grafik payment per point\n" +
              "/grafik tunggakan - grafik tunggakan per point\n" +
              "/statusclosing - status report closing hari ini\n" +
              "/rekapclosing - rekap closing area hari ini\n" +
              "/rekapclosing YYYY-MM-DD - rekap tanggal tertentu\n" +
              "/help - tampilkan menu ini\n\n" +
              "Memory Marley:\n" +
              "Marley ingat: ... - simpan memory\n" +
              "Marley memory - lihat memory\n" +
              "Marley cari memory: ... - cari memory\n" +
              "Marley lupakan: ... - hapus memory\n\n" +
              'Atau sebut nama saya "Marley" diikuti pertanyaan apa saja.',
          });
        } else if ((spreadsheetSessions.has(from) || kpDailySessions.has(from)) && (!isGroup || isMentioned) && /kpi|repayment|ntb|etb|disbursement|spreadsheet|excel|point mana|ranking|tunggakan|data file|file ini|grafik|loan|payment|dpd/i.test(stripMentions(text))) {
          const cleanQ=stripMentions(text);
          if (/kpi|ntb|etb|disbursement/i.test(cleanQ) && kpDailySessions.has(from)) {
            const ps=spreadsheetSessions.get(from), ks=kpDailySessions.get(from);
            const sh=ps?activeSheetFor(ps):null;
            const ka=answerKpiQuestion(sh,cleanQ,ks);
            if(ka){await sock.sendMessage(from,{text:ka});return;}
          }
          if (spreadsheetSessions.has(from)) { await answerSpreadsheetQuestion(sock, from, cleanQ); return; }
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

          const historyContext = formatHistory(from);
          const mentionContext = formatMentionContext(mentionedUsers);
          const context = [
            historyContext,
            mentionContext
              ? `ORANG YANG DI-TAG PADA PESAN INI:\n${mentionContext}`
              : "",
          ]
            .filter(Boolean)
            .join("\n\n");

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
// PORTFOLIO CONTROL TOWER DASHBOARD
// ======================================================

function dashboardTokenOk(req) {
  const expected = String(process.env.DASHBOARD_TOKEN || "").trim();
  if (!expected) return true;
  const supplied = String(req.query.token || req.headers["x-dashboard-token"] || "").trim();
  return supplied === expected;
}

function portfolioDashboardBucket(loan) {
  const dpd = Number(loan?.dpdOld ?? loan?.dpdNew);
  if (!Number.isFinite(dpd)) return null;
  if (dpd <= 0) return "current";
  if (dpd <= 30) return "1-30";
  if (dpd <= 90) return "31-90";
  return null;
}

function portfolioPaid(loan) {
  const v = String(loan?.paymentMin1x ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "y", "paid", "paid 1x", "lunas", "terbayar", "sudah bayar"].includes(v);
}

function buildPortfolioDashboardData() {
  const targets = { current: 0.98, "1-30": 0.55, "31-90": 0.13 };
  const rows = Object.values(loanMemory.loans || {})
    .filter(x => portfolioAreaIsBangkalan(x.area) && x.status !== "PAID")
    .map(x => ({ ...x, bucket: portfolioDashboardBucket(x) }))
    .filter(x => x.bucket);

  const points = new Set();
  const bps = new Set();
  const customerSets = { all: new Set(), current: new Set(), "1-30": new Set(), "31-90": new Set() };
  const aggregate = (list, target) => {
    const loans = list.length;
    const unpaid = list.filter(x => !portfolioPaid(x)).length;
    const paid = loans - unpaid;
    const os = list.reduce((n, x) => n + Number(x.osNew || x.osOld || 0), 0);
    const customers = new Set(list.map(x => x.customerNumber).filter(Boolean)).size;
    return { loans, unpaid, paid, repayment: loans ? paid / loans : null, unpaidRate: loans ? unpaid / loans : null, os, customers, target };
  };

  for (const x of rows) {
    if (x.point) points.add(x.point);
    if (x.bp) bps.add(x.bp);
    customerSets.all.add(x.customerNumber || x.customerName || x.loanId);
    customerSets[x.bucket].add(x.customerNumber || x.customerName || x.loanId);
  }

  const summary = { all: aggregate(rows, null) };
  for (const b of ["current", "1-30", "31-90"]) summary[b] = aggregate(rows.filter(x => x.bucket === b), targets[b]);

  const pointMap = new Map();
  const bpMap = new Map();
  const pointAllMap = new Map();
  const bpAllMap = new Map();
  for (const x of rows) {
    const pk = `${x.point || "-"}|${x.bucket}`;
    if (!pointMap.has(pk)) pointMap.set(pk, []);
    pointMap.get(pk).push(x);
    const bk = `${x.point || "-"}|${x.bp || "-"}|${x.bucket}`;
    if (!bpMap.has(bk)) bpMap.set(bk, []);
    bpMap.get(bk).push(x);
    const pAll = x.point || "-";
    if (!pointAllMap.has(pAll)) pointAllMap.set(pAll, []);
    pointAllMap.get(pAll).push(x);
    const bAll = `${x.point || "-"}|${x.bp || "-"}`;
    if (!bpAllMap.has(bAll)) bpAllMap.set(bAll, []);
    bpAllMap.get(bAll).push(x);
  }
  const makeBreakdown = (map, mode = "bucket") => [...map.entries()].map(([key, list]) => {
    const [point, ...rest] = key.split("|");
    const bucket = mode === "all" ? "all" : rest[rest.length - 1];
    const label = mode === "all" ? rest.join("|") : rest.slice(0, -1).join("|");
    const a = aggregate(list, targets[bucket]);
    const gap = a.repayment == null ? null : a.repayment - a.target;
    return { point, bp: mode === "all" ? (map === bpAllMap ? label : undefined) : (map === bpMap ? label : undefined), bucket, ...a, gap, priority: (gap == null ? 0 : Math.max(0, -gap)) * 100 + a.unpaid };
  });
  const pointRows = [...makeBreakdown(pointMap), ...makeBreakdown(pointAllMap, "all")];
  const bpRows = [...makeBreakdown(bpMap), ...makeBreakdown(bpAllMap, "all")];

  return {
    updatedAt: loanMemory.updatedAt || new Date().toISOString(),
    updatedAtLabel: loanMemory.updatedAt ? new Date(loanMemory.updatedAt).toLocaleString("id-ID") : "belum ada",
    summary,
    points: pointRows,
    bps: bpRows,
    pointCount: points.size,
    bpCount: bps.size,
    customerCount: customerSets.all.size,
  };
}

app.use("/dashboard", express.static(path.join(__dirname, "public")));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/api/dashboard", (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Dashboard token tidak valid." });
  res.json(buildPortfolioDashboardData());
});

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

async function bootstrap() {
  await initMemory();
  await initDailyReports();
  await initPortfolioDatabase();
  await startBot();
}

bootstrap().catch((err) => {
  console.error("BOOTSTRAP ERROR:", err);
  process.exit(1);
});