// server.js — stable Render-ready build
import express from "express";
import bodyParser from "body-parser";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import cron from "node-cron";
import path, { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import cors from "cors";
import fetch from "node-fetch";
import fs from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, ".env") });

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");

// ✅ Always-writable DB location (persistent locally, temp on Render)
const DB_PATH = process.env.DB_PATH || path.join("/tmp", "claims.db");

// ensure directory exists
try {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
} catch {}

app.use(cors());
app.use(express.static(PUBLIC));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

let db;
let dbReady = false;

// ---------- DB INIT ----------
async function initDB() {
  try {
    db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    await db.exec(`
      CREATE TABLE IF NOT EXISTS claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payout_method TEXT,
        payout_id TEXT,
        created_at INTEGER,
        is_winner INTEGER DEFAULT 0
      );
    `);
    dbReady = true;
    console.log("✅ Database ready at", DB_PATH);
  } catch (err) {
    console.error("DB init error:", err);
  }
}
await initDB();

// ---------- STATE ----------
let openWindow = false;
let winnerSelected = false;
let windowExpiresAt = 0;

// ---------- HELPERS ----------
function requireAdmin(req, res, next) {
  const key = req.query.admin || req.headers["x-admin-key"];
  if (!process.env.ADMIN_PASSWORD) return res.status(500).send("ADMIN_PASSWORD not set");
  if (key === process.env.ADMIN_PASSWORD) return next();
  return res.status(401).send("unauthorized");
}

async function verifyCaptcha(token) {
  const secret = process.env.RECAPTCHA_SECRET;
  const r = await fetch("https://www.google.com/recaptcha/api/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `secret=${secret}&response=${token}`
  });
  return r.json();
}

// ---------- ROUTES ----------
app.get("/state", async (req, res) => {
  const remaining = Math.max(0, Math.floor((windowExpiresAt - Date.now()) / 1000));
  const recent = dbReady
    ? await db.all(`SELECT payout_id FROM claims WHERE is_winner=1 ORDER BY created_at DESC LIMIT 10`)
    : [];
  res.json({ openWindow, remaining, recent });
});

app.post("/claim", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ ok: false, msg: "Database not ready." });
    if (!openWindow) return res.status(400).json({ ok: false, msg: "Window closed." });

    const { payout_method, payout_id, captcha } = req.body;
    if (!payout_method || !payout_id)
      return res.status(400).json({ ok: false, msg: "Missing fields." });

    const c = await verifyCaptcha(captcha);
    if (!c.success) return res.status(400).json({ ok: false, msg: "Captcha failed." });

    const now = Date.now();
    const insert = await db.run(
      `INSERT INTO claims (payout_method, payout_id, created_at) VALUES (?,?,?)`,
      [payout_method.trim(), payout_id.trim(), now]
    );

    const position = insert.lastID;
    let winner = false;

    if (!winnerSelected) {
      winnerSelected = true;
      await db.run(`UPDATE claims SET is_winner=1 WHERE id=?`, position);
      winner = true;
    }

    res.json({ ok: true, winner, position });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, msg: "Server error." });
  }
});

app.get("/admin/claims", requireAdmin, async (_req, res) => {
  const rows = dbReady ? await db.all(`SELECT * FROM claims ORDER BY created_at DESC LIMIT 500`) : [];
  res.json(rows);
});

app.post("/admin/open", requireAdmin, (req, res) => {
  const seconds = parseInt(req.query.seconds || "60", 10);
  openWindow = true;
  winnerSelected = false;
  windowExpiresAt = Date.now() + seconds * 1000;
  console.log(`🟢 Window open for ${seconds}s`);
  setTimeout(() => {
    openWindow = false;
    console.log("🔴 Window closed");
  }, seconds * 1000);
  res.json({ ok: true, opened_for: seconds });
});

// ---------- CRON ----------
cron.schedule(process.env.CRON_SCHEDULE || "0 18 * * *", () => {
  const seconds = parseInt(process.env.WINDOW_SECONDS || "60", 10);
  openWindow = true;
  winnerSelected = false;
  windowExpiresAt = Date.now() + seconds * 1000;
  console.log(`🕕 Auto-opened window for ${seconds}s`);
  setTimeout(() => (openWindow = false), seconds * 1000);
});

// ---------- START ----------
app.listen(PORT, () => console.log(`🚀 Live on port ${PORT}`));
