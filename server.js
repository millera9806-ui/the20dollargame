// server.js — Render-stable version with working admin panel + position tracking
import express from "express";
import bodyParser from "body-parser";
import sqlite3 from "sqlite3";
import * as sqlite from "sqlite"; // Node 25 fix
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
const DB_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DB_DIR, "claims.db");

app.use(cors());
app.use(express.static(PUBLIC));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ensure /data folder exists
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR);

// --- DATABASE INIT ---
let db;
async function initDB() {
  db = await sqlite.open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payout_method TEXT,
      payout_id TEXT,
      created_at INTEGER,
      is_winner INTEGER DEFAULT 0
    );
  `);
  console.log("✅ Database ready");
}
await initDB();

// --- GAME STATE ---
let openWindow = false;
let winnerSelected = false;
let windowExpiresAt = 0;

// --- CAPTCHA ---
async function verifyCaptcha(token) {
  const secret = process.env.RECAPTCHA_SECRET;
  const resp = await fetch("https://www.google.com/recaptcha/api/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token)}`
  });
  return resp.json();
}

// --- ADMIN AUTH ---
function requireAdmin(req, res, next) {
  const key = req.query.admin || req.headers["x-admin-key"];
  if (!process.env.ADMIN_PASSWORD) return res.status(500).send("ADMIN_PASSWORD not set");
  if (key === process.env.ADMIN_PASSWORD) return next();
  return res.status(401).send("unauthorized");
}

// --- ROUTES ---
app.get("/state", async (req, res) => {
  const remaining = Math.max(0, Math.floor((windowExpiresAt - Date.now()) / 1000));
  const recent = await db.all(`SELECT payout_id FROM claims WHERE is_winner=1 ORDER BY created_at DESC LIMIT 10`);
  res.json({ openWindow, remaining, recent });
});

app.post("/claim", async (req, res) => {
  try {
    if (!openWindow) return res.status(400).json({ ok: false, msg: "Window closed" });

    const { payout_method, payout_id, captcha } = req.body;
    if (!payout_method || !payout_id) return res.status(400).json({ ok: false, msg: "Missing fields" });

    const capRes = await verifyCaptcha(captcha);
    if (!capRes.success) return res.status(400).json({ ok: false, msg: "Captcha failed" });

    const now = Date.now();
    const count = await db.get(`SELECT COUNT(*) AS total FROM claims WHERE created_at >= ?`, [now - 60000]);
    const position = count.total + 1;

    const r = await db.run(
      `INSERT INTO claims (payout_method, payout_id, created_at) VALUES (?,?,?)`,
      [payout_method.trim(), payout_id.trim(), now]
    );
    const claimId = r.lastID;

    let winner = false;
    if (!winnerSelected) {
      winnerSelected = true;
      await db.run(`UPDATE claims SET is_winner=1 WHERE id=?`, claimId);
      winner = true;
      console.log(`🎉 Winner: claim ${claimId} (${payout_id})`);
    }

    res.json({ ok: true, winner, position });
  } catch (err) {
    console.error("Claim error:", err);
    res.status(500).json({ ok: false, msg: "Server error" });
  }
});

// --- ADMIN VIEW CLAIMS ---
app.get("/admin/claims", requireAdmin, async (req, res) => {
  try {
    const rows = await db.all(`SELECT * FROM claims ORDER BY created_at DESC LIMIT 100`);
    res.json(rows);
  } catch (err) {
    console.error("Admin fetch error:", err);
    res.status(500).json({ ok: false, msg: "Server error" });
  }
});

// --- ADMIN OPEN WINDOW ---
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

// --- CRON AUTO WINDOW ---
cron.schedule(process.env.CRON_SCHEDULE || "0 18 * * *", () => {
  const seconds = parseInt(process.env.WINDOW_SECONDS || "60", 10);
  openWindow = true;
  winnerSelected = false;
  windowExpiresAt = Date.now() + seconds * 1000;
  console.log(`🕕 Auto-opened window for ${seconds}s`);
  setTimeout(() => (openWindow = false), seconds * 1000);
});

app.listen(PORT, () => console.log(`🚀 Live on port ${PORT}`));