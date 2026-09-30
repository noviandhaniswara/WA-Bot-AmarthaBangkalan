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
await initDailyReports();
await startBot();