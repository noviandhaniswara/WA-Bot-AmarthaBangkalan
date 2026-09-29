import express from "express";
import qrcode from "qrcode";
import pino from "pino";
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";

const app = express();
const PORT = process.env.PORT || 3000;

let latestQR = null;
let connectionStatus = "menghubungkan...";

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
    await sock.sendMessage(from, { text: "halo" });
  });
}

app.get("/", async (req, res) => {
  if (connectionStatus === "terhubung") {
    res.send(`<h2>Status: ${connectionStatus}</h2>`);
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
