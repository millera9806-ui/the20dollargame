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
const CHAT_FETCH_LIMIT = 60;
const CHAT_MAX_MESSAGE_LENGTH = 120;
const CHAT_SLOW_MODE_MS = 8000;
const CHAT_MAX_POSTS_PER_MINUTE = 6;
const CHAT_MESSAGE_RETENTION_MS = 24 * 60 * 60 * 1000;
const CHAT_STALE_RATE_LIMIT_MS = 10 * 60 * 1000;
const DEFAULT_CHAT_NICKNAME = "potential winner";
const BLOCKED_CHAT_TERMS = [
  "fuck",
  "shit",
  "bitch",
  "cunt",
  "nigger",
  "nigga",
  "faggot",
  "retard",
  "slut",
  "whore",
  "asshole",
  "dickhead",
  "killyourself",
  "suicide",
  "rapist",
  "rape"
];
const chatRateLimiter = new Map();

app.set("trust proxy", 1);
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
  await ensureColumn("claims", "ip_address", "TEXT");
  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_round_ip
    ON claims(round_id, ip_address)
  `);

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

  await db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      ip_address TEXT NOT NULL
    );
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at
    ON chat_messages(created_at DESC)
  `);

  await db.run("UPDATE chat_messages SET nickname = ? WHERE nickname <> ?", [
    DEFAULT_CHAT_NICKNAME,
    DEFAULT_CHAT_NICKNAME
  ]);

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

function normalizeIp(ipAddress) {
  if (!ipAddress) {
    return "";
  }

  return String(ipAddress)
    .split(",")[0]
    .trim()
    .replace(/^::ffff:/, "");
}

function getClientIp(req) {
  return normalizeIp(req.ip || req.socket?.remoteAddress || "");
}

function sanitizeChatMessage(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, CHAT_MAX_MESSAGE_LENGTH);
}

function normalizeChatForModeration(value) {
  const substitutions = {
    "0": "o",
    "1": "i",
    "3": "e",
    "4": "a",
    "5": "s",
    "7": "t",
    "@": "a",
    "$": "s",
    "!": "i"
  };

  return sanitizeChatMessage(value)
    .toLowerCase()
    .replace(/[013457@$!]/g, (char) => substitutions[char] || char)
    .replace(/[^a-z0-9]/g, "");
}

function getChatModerationMessage(message) {
  if (!message) {
    return "Type a message before sending.";
  }

  if (/(https?:\/\/|www\.|(?:[a-z0-9-]+\.)+(?:com|net|org|gg|io|co|ly|app|me|tv|xyz)\b)/i.test(message)) {
    return "Links are not allowed in chat.";
  }

  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(message)) {
    return "Contact information is not allowed in chat.";
  }

  if (/(?:\+?\d[\d .-]{7,}\d)/.test(message)) {
    return "Contact information is not allowed in chat.";
  }

  if (/(.)\1{14,}/i.test(message)) {
    return "Please avoid spammy messages.";
  }

  const normalized = normalizeChatForModeration(message);
  if (BLOCKED_CHAT_TERMS.some((term) => normalized.includes(term))) {
    return "Keep chat clean for everyone.";
  }

  return null;
}

function getChatRateLimitMessage(ipAddress) {
  const now = Date.now();
  const existing = chatRateLimiter.get(ipAddress) || { lastPostedAt: 0, recentPosts: [] };
  const recentPosts = existing.recentPosts.filter((timestamp) => now - timestamp < 60000);

  if (now - existing.lastPostedAt < CHAT_SLOW_MODE_MS) {
    const seconds = Math.ceil((CHAT_SLOW_MODE_MS - (now - existing.lastPostedAt)) / 1000);
    return `Slow mode is on. Wait ${seconds}s and try again.`;
  }

  if (recentPosts.length >= CHAT_MAX_POSTS_PER_MINUTE) {
    return "You're sending messages too fast. Try again in a minute.";
  }

  recentPosts.push(now);
  chatRateLimiter.set(ipAddress, { lastPostedAt: now, recentPosts });
  return null;
}

async function isDuplicateRecentChatMessage(ipAddress, message) {
  const row = await db.get(
    `
      SELECT id
      FROM chat_messages
      WHERE ip_address = ?
        AND lower(message) = lower(?)
        AND created_at >= ?
      ORDER BY id DESC
      LIMIT 1
    `,
    [ipAddress, message, Date.now() - 2 * 60 * 1000]
  );

  return Boolean(row);
}

async function cleanupChatMessages() {
  await db.run("DELETE FROM chat_messages WHERE created_at < ?", [Date.now() - CHAT_MESSAGE_RETENTION_MS]);
  await db.run(`
    DELETE FROM chat_messages
    WHERE id NOT IN (
      SELECT id
      FROM chat_messages
      ORDER BY id DESC
      LIMIT 250
    )
  `);

  for (const [ipAddress, entry] of chatRateLimiter.entries()) {
    const recentPosts = entry.recentPosts.filter((timestamp) => Date.now() - timestamp < 60000);
    if (!recentPosts.length && Date.now() - entry.lastPostedAt > CHAT_STALE_RATE_LIMIT_MS) {
      chatRateLimiter.delete(ipAddress);
      continue;
    }

    chatRateLimiter.set(ipAddress, { ...entry, recentPosts });
  }
}

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

async function getTodayDrawSummary() {
  const todayStart = pacificMidnightMs();
  const totals = await db.get(
    "SELECT COUNT(*) AS totalPlayers FROM claims WHERE created_at >= ?",
    [todayStart]
  );
  const winner = await db.get(
    `
      SELECT payout_id
      FROM past_winners
      WHERE selected_at >= ?
      ORDER BY selected_at DESC
      LIMIT 1
    `,
    [todayStart]
  );

  return {
    totalPlayers: totals?.totalPlayers || 0,
    winnerPayoutId: winner?.payout_id || null
  };
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
    const todaySummary = await getTodayDrawSummary();
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
      hasWinnerToday: await hasWinnerToday(),
      totalPlayersToday: todaySummary.totalPlayers,
      winnerPayoutId: todaySummary.winnerPayoutId
    });
  } catch (err) {
    console.error("State error:", err);
    res.status(500).json({ ok: false, msg: "Server error" });
  }
});

app.get("/chat/messages", async (req, res) => {
  try {
    const afterId = Math.max(0, Number.parseInt(req.query.after || "0", 10) || 0);
    let messages;

    if (afterId > 0) {
      messages = await db.all(
        `
          SELECT id, nickname, message, created_at
          FROM chat_messages
          WHERE id > ?
          ORDER BY id ASC
          LIMIT ${CHAT_FETCH_LIMIT}
        `,
        [afterId]
      );
    } else {
      messages = await db.all(`
        SELECT id, nickname, message, created_at
        FROM chat_messages
        ORDER BY id DESC
        LIMIT ${CHAT_FETCH_LIMIT}
      `);
      messages.reverse();
    }

    const lastMessageId = messages.length ? messages[messages.length - 1].id : afterId;

    res.json({
      ok: true,
      messages,
      lastMessageId,
      slowModeMs: CHAT_SLOW_MODE_MS
    });
  } catch (err) {
    console.error("Chat fetch error:", err);
    res.status(500).json({ ok: false, msg: "Server error" });
  }
});

app.post("/chat/messages", async (req, res) => {
  try {
    const ipAddress = getClientIp(req);
    if (!ipAddress) {
      return res.status(400).json({ ok: false, msg: "Could not verify your network address" });
    }

    const nickname = DEFAULT_CHAT_NICKNAME;
    const message = sanitizeChatMessage(req.body.message);
    const moderationMessage = getChatModerationMessage(message);
    if (moderationMessage) {
      return res.status(400).json({ ok: false, msg: moderationMessage });
    }

    const rateLimitMessage = getChatRateLimitMessage(ipAddress);
    if (rateLimitMessage) {
      return res.status(429).json({ ok: false, msg: rateLimitMessage });
    }

    if (await isDuplicateRecentChatMessage(ipAddress, message)) {
      return res.status(409).json({ ok: false, msg: "You already sent that message recently." });
    }

    const createdAt = Date.now();
    const result = await db.run(
      `
        INSERT INTO chat_messages (nickname, message, created_at, ip_address)
        VALUES (?, ?, ?, ?)
      `,
      [nickname, message, createdAt, ipAddress]
    );

    res.json({
      ok: true,
      message: {
        id: result.lastID,
        nickname,
        message,
        created_at: createdAt
      }
    });
  } catch (err) {
    console.error("Chat post error:", err);
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

    const ipAddress = getClientIp(req);
    if (!ipAddress) {
      return res.status(400).json({ ok: false, msg: "Could not verify your network address" });
    }

    const existingEntry = await db.get(
      `
        SELECT id
        FROM claims
        WHERE round_id = ?
          AND ip_address = ?
      `,
      [currentRoundId, ipAddress]
    );
    if (existingEntry) {
      return res.status(409).json({
        ok: false,
        msg: "Only one entry per IP address is allowed during each draw."
      });
    }

    const capRes = await verifyCaptcha(captcha);
    if (!capRes.success) {
      return res.status(400).json({ ok: false, msg: "Captcha failed" });
    }

    const now = Date.now();
    let result;
    try {
      result = await db.run(
        `
          INSERT INTO claims (round_id, payout_method, payout_id, created_at, is_winner, ip_address)
          VALUES (?, ?, ?, ?, 0, ?)
        `,
        [currentRoundId, payout_method.trim(), payout_id.trim(), now, ipAddress]
      );
    } catch (err) {
      if (err?.code === "SQLITE_CONSTRAINT") {
        return res.status(409).json({
          ok: false,
          msg: "Only one entry per IP address is allowed during each draw."
        });
      }
      throw err;
    }

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
        SELECT id, round_id, payout_method, payout_id, created_at, ip_address
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
  "0 * * * *",
  async () => {
    try {
      await cleanupChatMessages();
    } catch (err) {
      console.error("Chat cleanup error:", err);
    }
  },
  { timezone: "America/Los_Angeles" }
);

cron.schedule(
  "0 0 * * *",
  async () => {
    try {
      openWindow = false;
      windowExpiresAt = 0;
      currentRoundId = null;
      await cleanupChatMessages();
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
