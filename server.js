// server.js — final Render-ready version (DB-safe, Captcha verified)
import express from "express";
import bodyParser from "body-parser";
import sqlite3 from "sqlite3";
import pkg from "sqlite";
import cron from "node-cron";
import path, { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import cors from "cors";
import fetch from "node-fetch";

const { open } = pkg;

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, ".env") });

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "claims.db");

app.use(cors());
app.use(express.static(PUBLIC));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// enforce HTTPS + canonical www
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

// ---------- DATABASE SETUP ----------
let db;
let dbReady = false;

async function initDB() {
  try {
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
    dbReady = true;
    console.log("✅ Database ready");
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
  const resp = await fetch("https://www.google.com/recaptcha/api/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token)}`
  });
  return resp.json();
}

// ---------- ROUTES ----------
app.get("/state", (req, res) => {
  const remaining = Math.max(0, Math.floor((windowExpiresAt - Date.now
