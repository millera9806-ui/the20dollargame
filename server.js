// server.js — production-ready Render-safe version
import express from "express";
import bodyParser from "body-parser";
import sqlite3 from "sqlite3";
import pkg from "sqlite";                 // CommonJS-compatible import
import cron from "node-cron";
import path, { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import cors from "cors";
import fetch from "node-fetch";

// destructure open safely from sqlite
const { open } = pkg;

// setup env + paths
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, ".env") });

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "claims.db");

// middleware
app.use(cors());
app.use(express.static(PUBLIC));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// HTTPS redirect + canonical www
app.set("trust proxy", true);
app.use((req, res, next) => {
  if (req.headers["x-forwarded-proto"] && req.headers["x-forwarded-proto"] !== "https") {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  if (req.hostname === "the20dollargame.com") {
    return res.redirect(301, `https://www.the20dollargame.com${req.url}`);
  }
  next();
});

// database setup
let db;
(async () => {
  db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      payout_method TEXT,
      payout_id TEXT,
      created_at INTEGER,
      is_winner INTEGER DEFAULT 0,
      paid INTEGER DEFAULT 0,
      admin_note TEXT
    );
  `);
  console.log("✅ Database ready");
})().catch(console.error);

// game state
let openWindow = false;
let winnerSelected = false;
let windowExpiresAt = 0;

// helpers
function requireAdmin(req, res, next) {
  const key = req.query.admin || req.headers["x-admin-key"];
  if (!process.env.ADMIN_PASSWORD) return res.status(500).send("ADMIN_PASSWORD not set");
  if (key === process.env.ADMIN_PASSWORD) return next();
  return res.status(401).send("unauthorized");
}

async function verifyCaptcha(token) {
  const secret = process.env.RECAPTCHA_SECRET;
  const resp = await fetch("https://www.google.com/recaptcha/api/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token)}`
  });
  return resp.json();
}

// routes
app.get("/state", (req, res) => {
  const remaining = Math.max(0, Math.floor((windowExpiresAt - Date.now()) / 1000));
  res.json({ openWindow, remaining });
});

app.post("/claim", async (req, res) => {
  try {
    if (!openWindow) return res.status(400).json({ ok: false, msg: "Window closed" });

    const { name, payout_method, payout_id, captcha } = req.body;
    if (!name || !payout_method || !payout_id)
      return res.status(400).json({ ok: false, msg: "Missing fields" });

    const capRes = await verifyCaptcha(captcha);
    if (!capRes.success) return res.status(400).json({ ok: false, msg: "Captcha failed" });

    const now = Date.now();
    const r = await db.run(
      `INSERT INTO claims (name, payout_method, payout_id, created_at) VALUES (?,?,?,?)`,
      [name.trim(), payout_method.trim(), payout_id.trim(), now]
    );
    const claimId = r.lastID;

    if (!winnerSelected) {
      winnerSelected = true;
      await db.run(`UPDATE claims SET is_winner=1 WHERE id=?`, claimId);
      console.log(`🎉 Winner: claim ${claimId}`);
      return res.json({ ok: true, winner: true });
    }

    return res.json({ ok: true, winner: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, msg: "Server error" });
  }
});

app.get("/admin/claims", requireAdmin, async (req, res) => {
  const rows = await db.all(`SELECT * FROM claims ORDER BY created_at DESC LIMIT 500`);
  res.json(rows);
});

app.post("/admin/open", requireAdmin, (req, res) => {
  const seconds = parseInt(req.query.seconds || "60");
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

// cron job (daily auto-open)
cron.schedule(process.env.CRON_SCHEDULE || "0 18 * * *", () => {
  const seconds = parseInt(process.env.WINDOW_SECONDS || "60");
  openWindow = true;
  winnerSelected = false;
  windowExpiresAt = Date.now() + seconds * 1000;
  console.log(`🕕 Auto-opened window for ${seconds}s`);
  setTimeout(() => (openWindow = false), seconds * 1000);
});

app.listen(PORT, () => console.log(`🚀 Live on port ${PORT}`));
