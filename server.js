// server.js — with Google reCAPTCHA verification
import express from "express";
import bodyParser from "body-parser";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import cron from "node-cron";
import path, { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import fetch from "node-fetch";

// --- ensure .env loads even on Node 22+ ---
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, ".env") });

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");

app.use(express.static(PUBLIC));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ---------- Database ----------
let db;
(async () => {
  db = await open({ filename: "./claims.db", driver: sqlite3.Database });
  await db.exec(`CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    payout_method TEXT,
    payout_id TEXT,
    created_at INTEGER,
    is_winner INTEGER DEFAULT 0,
    paid INTEGER DEFAULT 0,
    admin_note TEXT
  );`);
  console.log("✅ Database ready");
})();

// ---------- State ----------
let openWindow = false;
let winnerSelected = false;
let windowExpiresAt = 0;

// ---------- Helpers ----------
function requireAdmin(req, res, next) {
  const key = req.query.admin || req.headers["x-admin-key"];
  if (!process.env.ADMIN_PASSWORD)
    return res.status(500).send("ADMIN_PASSWORD not set");
  if (key === process.env.ADMIN_PASSWORD) return next();
  return res.status(401).send("unauthorized");
}

async function verifyCaptcha(token) {
  const secret = process.env.RECAPTCHA_SECRET;
  const res = await fetch("https://www.google.com/recaptcha/api/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `secret=${secret}&response=${token}`
  });
  return await res.json();
}

// ---------- Routes ----------
app.get("/state", (req, res) => {
  const remaining = Math.max(0, Math.floor((windowExpiresAt - Date.now()) / 1000));
  res.json({ openWindow, winnerSelected, remaining });
});

app.post("/claim", async (req, res) => {
  try {
    if (!openWindow) return res.status(400).json({ ok: false, msg: "Window closed" });

    const { name, payout_method, payout_id, captcha } = req.body;
    if (!name || !payout_method || !payout_id)
      return res.status(400).json({ ok: false, msg: "Missing fields" });
    if (!captcha)
      return res.status(400).json({ ok: false, msg: "Captcha missing" });

    const capRes = await verifyCaptcha(captcha);
    if (!capRes.success)
      return res.status(400).json({ ok: false, msg: "Captcha failed" });

    const now = Date.now();
    const r = await db.run(
      `INSERT INTO claims (name, payout_method, payout_id, created_at) VALUES (?,?,?,?)`,
      [name.trim(), payout_method.trim(), payout_id.trim(), now]
    );
    const claimId = r.lastID;

    if (!winnerSelected) {
      winnerSelected = true;
      await db.run(`UPDATE claims SET is_winner=1 WHERE id=?`, claimId);
      console.log(`✅ Winner selected: claim ${claimId}`);
      return res.json({ ok: true, winner: true, claimId });
    }

    return res.json({ ok: true, winner: false, claimId });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, msg: "Server error" });
  }
});

// ---------- Admin ----------
app.get("/admin/claims", requireAdmin, async (req, res) => {
  const rows = await db.all(`SELECT * FROM claims ORDER BY created_at DESC LIMIT 500`);
  res.json(rows);
});

app.post("/admin/mark-paid", requireAdmin, async (req, res) => {
  const { id, admin_note } = req.body;
  if (!id) return res.status(400).json({ ok: false, msg: "missing id" });
  await db.run(`UPDATE claims SET paid=1, admin_note=? WHERE id=?`, [admin_note || "", id]);
  res.json({ ok: true });
});

app.post("/admin/open", requireAdmin, async (req, res) => {
  const seconds = parseInt(req.query.seconds || "60");
  openWindow = true;
  winnerSelected = false;
  windowExpiresAt = Date.now() + seconds * 1000;

  console.log(`🟢 Window opened for ${seconds}s by admin`);
  setTimeout(() => {
    openWindow = false;
    console.log("🔴 Window closed automatically.");
  }, seconds * 1000);

  res.json({ ok: true, opened_for: seconds });
});

// ---------- Scheduled open (optional) ----------
const cronSchedule = process.env.CRON_SCHEDULE || "0 18 * * *";
cron.schedule(cronSchedule, () => {
  const seconds = parseInt(process.env.WINDOW_SECONDS || "60");
  openWindow = true;
  winnerSelected = false;
  windowExpiresAt = Date.now() + seconds * 1000;
  console.log(`🕕 Scheduled window opened for ${seconds}s.`);
  setTimeout(() => {
    openWindow = false;
    console.log("🔴 Scheduled window closed.");
  }, seconds * 1000);
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(
    `ADMIN_PASSWORD: ${process.env.ADMIN_PASSWORD ? "✅ loaded" : "❌ missing"}`
  );
  console.log(
    `RECAPTCHA_SECRET: ${process.env.RECAPTCHA_SECRET ? "✅ loaded" : "❌ missing"}`
  );
});
