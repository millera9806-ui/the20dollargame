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
app.use(bodyParser.urlencoded({ extended: true }));

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR);
}

let db;

async function ensureColumn(tableName, columnName, definition) {
  const columns = await db.all(`PRAGMA table_info(${tableName})`);
  const hasColumn = columns.some((column) => column.name === columnName);
  if (!hasColumn) {
    await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

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

  await ensureColumn("claims", "round_id", "TEXT");

  await db.exec(`
    CREATE TABLE IF NOT EXISTS past_winners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id TEXT NOT NULL UNIQUE,
      claim_id INTEGER NOT NULL UNIQUE,
      payout_method TEXT NOT NULL,
      payout_id TEXT NOT NULL,
      claim_created_at INTEGER NOT NULL,
      selected_at INTEGER NOT NULL,
      FOREIGN KEY (claim_id) REFERENCES claims(id)
    );
  `);

  await db.run(
    `
      UPDATE claims
      SET round_id = CAST(created_at AS TEXT)
      WHERE round_id IS NULL
        AND is_winner = 1
    `
  );

  await db.run(
    `
      INSERT INTO past_winners (
        round_id,
        claim_id,
        payout_method,
        payout_id,
        claim_created_at,
        selected_at
      )
      SELECT
        COALESCE(round_id, CAST(created_at AS TEXT)),
        id,
        payout_method,
        payout_id,
        created_at,
        created_at
      FROM claims
      WHERE is_winner = 1
        AND id NOT IN (SELECT claim_id FROM past_winners)
    `
  );

  console.log("Database ready");
}

await initDB();

let openWindow = false;
let windowExpiresAt = 0;
let currentRoundId = null;

async function verifyCaptcha(token) {
  const secret = process.env.RECAPTCHA_SECRET;
  if (!secret) {
    return { success: false };
  }

  const resp = await fetch("https://www.google.com/recaptcha/api/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token || "")}`
  });

  return resp.json();
}

function requireAdmin(req, res, next) {
  const key = req.query.admin || req.headers["x-admin-key"];
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ ok: false, msg: "ADMIN_PASSWORD not set" });
  }
  if (key === process.env.ADMIN_PASSWORD) {
    return next();
  }
  return res.status(401).json({ ok: false, msg: "unauthorized" });
}

function pacificMidnightMs() {
  const now = new Date();
  const pacificNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  pacificNow.setHours(0, 0, 0, 0);
  return pacificNow.getTime();
}

async function hasWinnerToday() {
  const todayStart = pacificMidnightMs();
  const row = await db.get(
    "SELECT COUNT(*) AS total FROM past_winners WHERE selected_at >= ?",
    [todayStart]
  );
  return (row?.total || 0) > 0;
}

async function closeWindowAndPickWinner(roundId) {
  openWindow = false;
  windowExpiresAt = 0;

  if (currentRoundId === roundId) {
    currentRoundId = null;
  }

  const winnerAlreadyStored = await db.get(
    "SELECT id FROM past_winners WHERE round_id = ?",
    [roundId]
  );
  if (winnerAlreadyStored) {
    return;
  }

  const winnerClaim = await db.get(
    `
      SELECT id, payout_method, payout_id, created_at
      FROM claims
      WHERE round_id = ?
      ORDER BY RANDOM()
      LIMIT 1
    `,
    [roundId]
  );

  if (!winnerClaim) {
    console.log(`Window closed for round ${roundId} with no claims`);
    return;
  }

  await db.run("UPDATE claims SET is_winner = 1 WHERE id = ?", [winnerClaim.id]);
  await db.run(
    `
      INSERT INTO past_winners (
        round_id,
        claim_id,
        payout_method,
        payout_id,
        claim_created_at,
        selected_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [
      roundId,
      winnerClaim.id,
      winnerClaim.payout_method,
      winnerClaim.payout_id,
      winnerClaim.created_at,
      Date.now()
    ]
  );

  console.log(`Winner selected for round ${roundId}: claim ${winnerClaim.id}`);
}

app.get("/state", async (req, res) => {
  try {
    const remaining = Math.max(0, Math.floor((windowExpiresAt - Date.now()) / 1000));
    const recent = await db.all(
      `
        SELECT payout_id
        FROM past_winners
        ORDER BY selected_at DESC
        LIMIT 10
      `
    );

    res.json({
      openWindow,
      remaining,
      recent,
      hasWinnerToday: await hasWinnerToday()
    });
  } catch (err) {
    console.error("State error:", err);
    res.status(500).json({ ok: false, msg: "Server error" });
  }
});

app.post("/claim", async (req, res) => {
  try {
    if (!openWindow || !currentRoundId) {
      return res.status(400).json({ ok: false, msg: "Window closed" });
    }

    const { payout_method, payout_id, captcha } = req.body;
    if (!payout_method || !payout_id) {
      return res.status(400).json({ ok: false, msg: "Missing fields" });
    }

    const capRes = await verifyCaptcha(captcha);
    if (!capRes.success) {
      return res.status(400).json({ ok: false, msg: "Captcha failed" });
    }

    const now = Date.now();
    const result = await db.run(
      `
        INSERT INTO claims (round_id, payout_method, payout_id, created_at, is_winner)
        VALUES (?, ?, ?, ?, 0)
      `,
      [currentRoundId, payout_method.trim(), payout_id.trim(), now]
    );

    res.json({
      ok: true,
      claimId: result.lastID,
      roundId: currentRoundId,
      msg: "Entry received"
    });
  } catch (err) {
    console.error("Claim error:", err);
    res.status(500).json({ ok: false, msg: "Server error" });
  }
});

app.get("/claim-result/:claimId", async (req, res) => {
  try {
    const claimId = Number(req.params.claimId);
    if (!claimId) {
      return res.status(400).json({ ok: false, msg: "Invalid claim id" });
    }

    const claim = await db.get(
      `
        SELECT id, round_id
        FROM claims
        WHERE id = ?
      `,
      [claimId]
    );

    if (!claim) {
      return res.status(404).json({ ok: false, msg: "Claim not found" });
    }

    const totals = await db.get(
      "SELECT COUNT(*) AS totalPlayers FROM claims WHERE round_id = ?",
      [claim.round_id]
    );
    const winner = await db.get(
      "SELECT claim_id FROM past_winners WHERE round_id = ?",
      [claim.round_id]
    );

    if (!winner) {
      return res.json({
        ok: true,
        resolved: false,
        totalPlayers: totals?.totalPlayers || 0
      });
    }

    res.json({
      ok: true,
      resolved: true,
      winner: winner.claim_id === claim.id,
      totalPlayers: totals?.totalPlayers || 0
    });
  } catch (err) {
    console.error("Claim result error:", err);
    res.status(500).json({ ok: false, msg: "Server error" });
  }
});

app.get("/admin/dashboard", requireAdmin, async (req, res) => {
  try {
    const claims = await db.all(
      `
        SELECT id, round_id, payout_method, payout_id, created_at
        FROM claims
        ORDER BY created_at DESC
        LIMIT 100
      `
    );

    const winners = await db.all(
      `
        SELECT id, round_id, claim_id, payout_method, payout_id, claim_created_at, selected_at
        FROM past_winners
        ORDER BY selected_at DESC
        LIMIT 100
      `
    );

    res.json({
      claims,
      winners,
      state: {
        openWindow,
        remaining: Math.max(0, Math.floor((windowExpiresAt - Date.now()) / 1000)),
        roundId: currentRoundId,
        hasWinnerToday: await hasWinnerToday()
      }
    });
  } catch (err) {
    console.error("Admin dashboard error:", err);
    res.status(500).json({ ok: false, msg: "Server error" });
  }
});

app.post("/admin/open", requireAdmin, async (req, res) => {
  try {
    if (openWindow) {
      return res.status(400).json({ ok: false, msg: "A window is already open" });
    }

    if (await hasWinnerToday()) {
      return res.status(400).json({ ok: false, msg: "A winner has already been selected today" });
    }

    const seconds = parseInt(req.query.seconds || "60", 10);
    const roundId = String(Date.now());

    openWindow = true;
    currentRoundId = roundId;
    windowExpiresAt = Date.now() + seconds * 1000;

    setTimeout(() => {
      closeWindowAndPickWinner(roundId).catch((err) => {
        console.error("Window close error:", err);
      });
    }, seconds * 1000);

    console.log(`Window open for ${seconds}s (round ${roundId})`);
    res.json({ ok: true, opened_for: seconds, roundId });
  } catch (err) {
    console.error("Admin open error:", err);
    res.status(500).json({ ok: false, msg: "Server error" });
  }
});

cron.schedule(
  "0 0 * * *",
  async () => {
    try {
      openWindow = false;
      windowExpiresAt = 0;
      currentRoundId = null;
      console.log("Midnight reset (Pacific) triggered");
    } catch (err) {
      console.error("Midnight reset error:", err);
    }
  },
  { timezone: "America/Los_Angeles" }
);

app.listen(PORT, () => {
  console.log(`Live on port ${PORT}`);
});
