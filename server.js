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
import twilio from "twilio";

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

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR);

// TWILIO
const client = twilio(
  process.env.TWILIO_SID,
  process.env.TWILIO_AUTH
);

// DB INIT
let db;
await (async () => {
  db = await sqlite.open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payout_method TEXT,
      payout_id TEXT,
      created_at INTEGER,
      is_winner INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE,
      created_at INTEGER
    );
  `);

  console.log("✅ DB READY");
})();

// GAME STATE
let openWindow = false;
let windowExpiresAt = 0;

// PACIFIC TIME
function pacificMidnight() {
  const now = new Date();
  const pac = new Date(
    now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  );
  pac.setHours(0, 0, 0, 0);
  return pac.getTime();
}

// CAPTCHA
async function verifyCaptcha(token) {
  try {
    const resp = await fetch(
      "https://www.google.com/recaptcha/api/siteverify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: `secret=${process.env.RECAPTCHA_SECRET}&response=${token}`
      }
    );

    return await resp.json();
  } catch {
    return { success: false };
  }
}

// SMS BLAST
async function sendSMSBlast() {
  const users = await db.all(`SELECT phone FROM subscribers`);

  console.log("📱 USERS:", users);

  for (const u of users) {
    try {
      await client.messages.create({
        body: "🚨 $20 DROP IS LIVE — GO NOW",
        from: process.env.TWILIO_PHONE,
        to: u.phone
      });

      console.log("sent to:", u.phone);

    } catch (err) {
      console.log("sms error:", u.phone, err.message);
    }
  }
}

// PICK WINNER
async function pickWinner() {
  const now = Date.now();

  const entries = await db.all(
    `SELECT id FROM claims WHERE created_at >= ?`,
    [now - 60000]
  );

  if (!entries.length) {
    console.log("no entries");
    return;
  }

  const winner = entries[Math.floor(Math.random() * entries.length)];

  await db.run(
    `UPDATE claims SET is_winner=1 WHERE id=?`,
    winner.id
  );

  console.log("🏆 WINNER ID:", winner.id);
}

// STATE
app.get("/state", async (req, res) => {
  const remaining = Math.max(
    0,
    Math.floor((windowExpiresAt - Date.now()) / 1000)
  );

  const todayStart = pacificMidnight();

  const claimsToday = await db.get(
    `SELECT COUNT(*) as c FROM claims WHERE created_at >= ?`,
    [todayStart]
  );

  const isNewDay = claimsToday.c === 0;

  const recent = await db.all(
    `SELECT payout_id FROM claims WHERE is_winner=1 ORDER BY created_at DESC LIMIT 10`
  );

  res.json({
    openWindow,
    remaining,
    recent,
    isNewDay
  });
});

// CLAIM (ANTI-SPAM + FIXED)
app.post("/claim", async (req, res) => {
  try {
    if (!openWindow) return res.json({ ok: false });

    const { payout_method, payout_id, captcha } = req.body;

    if (!payout_method || !payout_id) {
      return res.json({ ok: false });
    }

    const cap = await verifyCaptcha(captcha);
    if (!cap.success) return res.json({ ok: false });

    const now = Date.now();

    // 🔥 ANTI-SPAM
    const existing = await db.get(
      `SELECT id FROM claims WHERE created_at >= ? AND payout_id=?`,
      [now - 60000, payout_id]
    );

    if (existing) {
      return res.json({ ok: false, message: "Already entered" });
    }

    const count = await db.get(
      `SELECT COUNT(*) as total FROM claims WHERE created_at >= ?`,
      [now - 60000]
    );

    const position = count.total + 1;

    await db.run(
      `INSERT INTO claims (payout_method, payout_id, created_at) VALUES (?,?,?)`,
      [payout_method.trim(), payout_id.trim(), now]
    );

    res.json({ ok: true, position });

  } catch (err) {
    console.log("claim error:", err);
    res.status(500).json({ ok: false });
  }
});

// SMS SUBSCRIBE (WITH CONFIRM TEXT)
app.post("/subscribe-sms", async (req, res) => {
  try {
    const { phone } = req.body;

    const count = await db.get(
      `SELECT COUNT(*) as c FROM subscribers`
    );

    if (count.c >= 500) {
      return res.json({
        ok: false,
        message: "SMS list full (500 max)"
      });
    }

    await db.run(
      `INSERT INTO subscribers (phone, created_at) VALUES (?,?)`,
      [phone, Date.now()]
    );

    // CONFIRM TEXT
    try {
      await client.messages.create({
        body: "✅ You're signed up! You'll get notified when the $20 drop goes live.",
        from: process.env.TWILIO_PHONE,
        to: phone
      });
    } catch (err) {
      console.log("confirm sms fail:", phone);
    }

    res.json({ ok: true });

  } catch {
    res.json({
      ok: false,
      message: "Already subscribed"
    });
  }
});

// ADMIN AUTH
function requireAdmin(req, res, next) {
  if (req.query.admin === process.env.ADMIN_PASSWORD) return next();
  res.status(401).send("unauthorized");
}

app.get("/admin/claims", requireAdmin, async (req, res) => {
  const rows = await db.all(
    `SELECT * FROM claims ORDER BY created_at DESC LIMIT 100`
  );
  res.json(rows);
});

app.post("/admin/open", requireAdmin, (req, res) => {
  console.log("🟢 ADMIN OPEN WINDOW");

  openWindow = true;
  windowExpiresAt = Date.now() + 60000;

  sendSMSBlast();

  setTimeout(async () => {
    openWindow = false;
    await pickWinner();
    console.log("🔴 WINDOW CLOSED");
  }, 60000);

  res.json({ ok: true });
});

// AUTO DROP
cron.schedule("* * * * *", () => {
  const hour = new Date().getHours();

  if (hour >= 18 && hour < 21 && !openWindow) {
    if (Math.random() < 0.05) {
      console.log("🎯 AUTO DROP");

      openWindow = true;
      windowExpiresAt = Date.now() + 60000;

      sendSMSBlast();

      setTimeout(async () => {
        openWindow = false;
        await pickWinner();
      }, 60000);
    }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 running on port ${PORT}`);
});