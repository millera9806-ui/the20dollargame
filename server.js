import express from "express";
import bodyParser from "body-parser";
import sqlite3 from "sqlite3";
import * as sqlite from "sqlite";
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

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR);

// DB
let db;
await (async () => {
  db = await sqlite.open({ filename: DB_PATH, driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payout_method TEXT,
      payout_id TEXT,
      created_at INTEGER,
      is_winner INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      score INTEGER,
      created_at INTEGER
    );
  `);

  console.log("✅ DB READY");
})();

// GAME STATE
let openWindow = false;
let windowExpiresAt = 0;

function pacificMidnight() {
  const now = new Date();
  const pac = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  pac.setHours(0, 0, 0, 0);
  return pac.getTime();
}

// CAPTCHA
async function verifyCaptcha(token) {
  try {
    const resp = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `secret=${process.env.RECAPTCHA_SECRET}&response=${token}`
    });
    return await resp.json();
  } catch {
    return { success: false };
  }
}

// PICK WINNER
async function pickWinner() {
  const now = Date.now();
  const entries = await db.all(
    `SELECT id FROM claims WHERE created_at >= ?`,
    [now - 60000]
  );

  if (!entries.length) return;

  const winner = entries[Math.floor(Math.random() * entries.length)];
  await db.run(`UPDATE claims SET is_winner=1 WHERE id=?`, winner.id);
}

// STATE
app.get("/state", async (req, res) => {
  const remaining = Math.max(0, Math.floor((windowExpiresAt - Date.now()) / 1000));
  const todayStart = pacificMidnight();

  const claimsToday = await db.get(
    `SELECT COUNT(*) as c FROM claims WHERE created_at >= ?`,
    [todayStart]
  );

  const winnerToday = await db.get(
    `SELECT COUNT(*) as w FROM claims WHERE is_winner=1 AND created_at >= ?`,
    [todayStart]
  );

  const recent = await db.all(
    `SELECT payout_id FROM claims WHERE is_winner=1 ORDER BY created_at DESC LIMIT 10`
  );

  res.json({
    openWindow,
    remaining,
    isNewDay: claimsToday.c === 0,
    hasWinnerToday: winnerToday.w > 0,
    recent
  });
});

// CLAIM
app.post("/claim", async (req, res) => {
  if (!openWindow) return res.json({ ok: false });

  const { payout_method, payout_id, captcha } = req.body;

  const cap = await verifyCaptcha(captcha);
  if (!cap.success) return res.json({ ok: false });

  const now = Date.now();

  const existing = await db.get(
    `SELECT id FROM claims WHERE created_at >= ? AND payout_id=?`,
    [now - 60000, payout_id]
  );

  if (existing) return res.json({ ok: false });

  const count = await db.get(
    `SELECT COUNT(*) as total FROM claims WHERE created_at >= ?`,
    [now - 60000]
  );

  await db.run(
    `INSERT INTO claims (payout_method, payout_id, created_at) VALUES (?,?,?)`,
    [payout_method, payout_id, now]
  );

  res.json({ ok: true, position: count.total + 1 });
});

// 🏆 SAVE SCORE
app.post("/score", async (req, res) => {
  const { score } = req.body;

  if (!score || score < 1) return res.json({ ok: false });

  await db.run(
    `INSERT INTO scores (score, created_at) VALUES (?,?)`,
    [score, Date.now()]
  );

  res.json({ ok: true });
});

// 🏆 GET TOP SCORES
app.get("/scores", async (req, res) => {
  const rows = await db.all(
    `SELECT score FROM scores ORDER BY score DESC LIMIT 10`
  );
  res.json(rows);
});

// ADMIN OPEN
function requireAdmin(req, res, next) {
  if (req.query.admin === process.env.ADMIN_PASSWORD) return next();
  res.status(401).send("unauthorized");
}

app.post("/admin/open", requireAdmin, (req, res) => {
  openWindow = true;
  windowExpiresAt = Date.now() + 60000;

  setTimeout(async () => {
    openWindow = false;
    await pickWinner();
  }, 60000);

  res.json({ ok: true });
});

// AUTO DROP
cron.schedule("* * * * *", () => {
  const hour = new Date().getHours();

  if (hour >= 18 && hour < 21 && !openWindow) {
    if (Math.random() < 0.05) {
      openWindow = true;
      windowExpiresAt = Date.now() + 60000;

      setTimeout(async () => {
        openWindow = false;
        await pickWinner();
      }, 60000);
    }
  }
});

app.listen(PORT, () => console.log("🚀 running"));