// ============================================================
// NEXORA Backend — Express + SQLite + Telegram reports
// ============================================================
const express = require('express');
const cors = require('cors');
const Database = require('node:sqlite').DatabaseSync;
const crypto = require('crypto');
const path = require('path');
const { sendTelegramMessage, sendTelegramPhoto, pollForCodes } = require('./telegram');
const { bakuDate, getEarningStartAt, getNextEarningDate } = require('./earnings');
const { getStaticPathStatus } = require('./static-path');
const { sendResetCodeEmail, isMailConfigured } = require('./mailer');
const config = require('./config');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const allowedOrigins = new Set(
  String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map(function (origin) { return origin.trim().replace(/\/$/, ''); })
    .filter(Boolean)
);
app.use(function (req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' fonts.googleapis.com; font-src fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  if (process.env.NODE_ENV === 'production' && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
function reqOrigin(req) {
  return req.protocol + '://' + req.get('host');
}

function isAllowedOrigin(origin, req) {
  return origin === reqOrigin(req) || allowedOrigins.has(String(origin).replace(/\/$/, ''));
}

app.use(function (req, res, next) {
  cors({
    origin: function (origin, callback) {
      callback(null, !origin || isAllowedOrigin(origin, req));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    maxAge: 600
  })(req, res, next);
});

app.use(function (req, res, next) {
  var origin = req.get('Origin');
  if (origin && req.method !== 'GET' && req.method !== 'HEAD' && !isAllowedOrigin(origin, req)) {
    return res.status(403).json({ error: 'Sorğu mənbəyinə icazə verilmir.' });
  }
  next();
});

function createRateLimiter(windowMs, maxRequests, bucketName) {
  var hits = new Map();
  setInterval(function () {
    var now = Date.now();
    hits.forEach(function (entry, key) {
      if (entry.resetAt <= now) hits.delete(key);
    });
  }, 60 * 1000).unref();

  return function (req, res, next) {
    var now = Date.now();
    var key = bucketName + ':' + req.ip;
    var entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (hits.size >= 20000) {
        hits.forEach(function (value, existingKey) {
          if (value.resetAt <= now) hits.delete(existingKey);
        });
        if (hits.size >= 20000) return res.status(503).json({ error: 'Server müvəqqəti yüklənib. Bir az sonra yenidən cəhd edin.' });
      }
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    res.setHeader('RateLimit-Limit', String(maxRequests));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, maxRequests - entry.count)));
    if (entry.count > maxRequests) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Çox sayda sorğu göndərildi. Bir az sonra yenidən cəhd edin.' });
    }
    next();
  };
}

app.use('/api', createRateLimiter(15 * 60 * 1000, 300, 'api'));
app.use('/api/login', createRateLimiter(15 * 60 * 1000, 10, 'auth'));
app.use('/api/register', createRateLimiter(15 * 60 * 1000, 10, 'auth'));
app.use('/api/forgot-password', createRateLimiter(15 * 60 * 1000, 5, 'reset'));
app.use('/api', express.json({ limit: '8mb' }));

// Serve the static site from the parent directory
const SITE_ROOT = path.join(__dirname, '..');
// Block sensitive paths BEFORE static serving (config.json, DB files, etc.)
app.use(function (req, res, next) {
  const pathStatus = getStaticPathStatus(req.path || '/');
  if (pathStatus === 'malformed') {
    return res.status(400).send('Bad Request');
  }
  if (pathStatus === 'blocked') {
    return res.status(403).send('Forbidden');
  }
  next();
});
app.use(express.static(SITE_ROOT, { dotfiles: 'ignore' }));

// ---------- DATABASE ----------
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'nexora.db');
const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fullname TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  company TEXT,
  fin_code TEXT,
  telegram_username TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan_name TEXT NOT NULL,
  price REAL NOT NULL,
  daily REAL NOT NULL,
  txn_id TEXT UNIQUE NOT NULL,
  amount_paid REAL NOT NULL,
  payment_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  method TEXT NOT NULL,
  target TEXT NOT NULL,
  wd_id TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payment_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan_name TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  auto_approve_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT
);
CREATE TABLE IF NOT EXISTS daily_earnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  earning_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  UNIQUE(purchase_id, earning_date)
);
CREATE TABLE IF NOT EXISTS payment_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  card_number TEXT NOT NULL,
  bank_name TEXT NOT NULL
);
`);

db.prepare('INSERT OR IGNORE INTO payment_settings (id, card_number, bank_name) VALUES (1, ?, ?)')
  .run(
    String(process.env.PAYMENT_CARD_NUMBER || config.PAYMENT_CARD_NUMBER || '').replace(/\D/g, ''),
    String(process.env.PAYMENT_BANK_NAME || config.PAYMENT_BANK_NAME || '').trim()
  );

// Migration: add telegram column to existing DBs
try { db.exec("ALTER TABLE users ADD COLUMN telegram_username TEXT"); } catch (e) { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN fin_code TEXT"); } catch (e) { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN phone TEXT"); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE purchases ADD COLUMN payment_verified INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE payment_receipts ADD COLUMN auto_approve_at TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE sessions ADD COLUMN expires_at TEXT'); } catch (e) { /* already exists */ }
db.exec("UPDATE sessions SET expires_at = datetime(created_at, '+30 days') WHERE expires_at IS NULL");
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_fin_code ON users(fin_code)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone)');
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)');
db.exec(`
CREATE INDEX IF NOT EXISTS idx_purchases_user_created
  ON purchases(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user_created
  ON withdrawals(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user_status
  ON withdrawals(user_id, status);
CREATE INDEX IF NOT EXISTS idx_daily_earnings_user_date
  ON daily_earnings(user_id, earning_date);
CREATE INDEX IF NOT EXISTS idx_payment_receipts_status_auto_approve
  ON payment_receipts(status, auto_approve_at);
`);

const PLANS = {
  'Başlanğıc Otaq': { price: 13, daily: 1 },
  'Standart Otaq':  { price: 30, daily: 2 },
  'Biznes Otaq':    { price: 67, daily: 4 },
  'Premium Otaq':   { price: 96, daily: 6 },
  'Elit Otaq':      { price: 200, daily: 14 },
  'Elit Plus Otaq': { price: 460, daily: 40 }
};

Object.keys(PLANS).forEach(function (name) {
  db.prepare('UPDATE purchases SET daily = ? WHERE plan_name = ? AND daily != ?')
    .run(PLANS[name].daily, name, PLANS[name].daily);
});

// ---------- HELPERS ----------
function getPaymentInfo() {
  var settings = db.prepare('SELECT card_number, bank_name FROM payment_settings WHERE id = 1').get();
  var cardNumber = settings ? settings.card_number : '';
  var bankName = settings ? settings.bank_name : '';
  return {
    configured: /^\d{13,19}$/.test(cardNumber) && Boolean(bankName),
    cardNumber,
    bankName
  };
}

function isPaymentTestMode() {
  return process.env.PAYMENT_TEST_MODE === 'true' &&
    getPaymentInfo().cardNumber === '1234567812341234';
}

function updatePaymentInfo(cardNumber, bankName) {
  db.prepare(`
    INSERT INTO payment_settings (id, card_number, bank_name)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET card_number = excluded.card_number, bank_name = excluded.bank_name
  `).run(cardNumber, bankName);
}

const PASSWORD_ITERATIONS = 210000;
function hashPassword(pw) {
  var salt = crypto.randomBytes(16);
  var digest = crypto.pbkdf2Sync(String(pw), salt, PASSWORD_ITERATIONS, 32, 'sha256');
  return 'pbkdf2$' + PASSWORD_ITERATIONS + '$' + salt.toString('hex') + '$' + digest.toString('hex');
}
function legacyHashPassword(pw) {
  return crypto.createHash('sha256').update('nexora::' + pw).digest('hex');
}
function legacyPbkdf2Hash(pw) {
  return crypto.pbkdf2Sync(String(pw), 'nexora::' + String(pw).slice(0, 8), 120000, 32, 'sha256').toString('hex');
}
function verifyPassword(pw, storedHash) {
  var current = /^pbkdf2\$(\d+)\$([a-f0-9]{32})\$([a-f0-9]{64})$/i.exec(storedHash || '');
  if (current) {
    var iterations = Number(current[1]);
    if (iterations < 100000 || iterations > 1000000) return false;
    var expected = Buffer.from(current[3], 'hex');
    var actual = crypto.pbkdf2Sync(String(pw), Buffer.from(current[2], 'hex'), iterations, expected.length, 'sha256');
    return crypto.timingSafeEqual(actual, expected);
  }
  if (!/^[a-f0-9]{64}$/i.test(storedHash || '')) return false;
  var oldSha256 = Buffer.from(legacyHashPassword(pw), 'hex');
  var oldPbkdf2 = Buffer.from(legacyPbkdf2Hash(pw), 'hex');
  var stored = Buffer.from(storedHash, 'hex');
  return crypto.timingSafeEqual(stored, oldSha256) || crypto.timingSafeEqual(stored, oldPbkdf2);
}
function parseSqlDate(value) {
  if (!value) return null;
  var text = String(value).trim();
  if (!text) return null;
  var iso = text.includes('T') ? text : text.replace(' ', 'T');
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) iso += 'Z';
  var date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date : null;
}
function normalizePhone(value) {
  var digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('994')) digits = digits.slice(3);
  else if (digits.length === 10 && digits.charAt(0) === '0') digits = digits.slice(1);
  if (digits.length !== 9) return '';
  return '+994 ' + digits.slice(0, 2) + ' ' + digits.slice(2, 5) + ' ' + digits.slice(5, 7) + ' ' + digits.slice(7, 9);
}
function getToken(req) {
  // Tokenlər httpOnly cookie-də saxlanılır (Bearer başlığına dəstək köhnə müştərilər üçün saxlanılır)
  var h = req.headers.authorization || '';
  var match = /^Bearer ([a-f0-9]{48})$/i.exec(h);
  if (match) return match[1];
  var cookies = req.headers.cookie || '';
  var m = /(?:^|;\s*)nexora_session=([a-f0-9]{48})/i.exec(cookies);
  return m ? m[1] : '';
}

function setSessionCookie(res, token) {
  var isProd = process.env.NODE_ENV === 'production';
  var parts = ['nexora_session=' + token, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + (30 * 24 * 60 * 60)];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  var isProd = process.env.NODE_ENV === 'production';
  var parts = ['nexora_session=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function escapeTelegramHtml(value) {
  return String(value || '').replace(/[&<>"']/g, function (char) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(32).toString('hex'));
// telegram connect codes: userId -> { code, created }
const codes = new Map();
function authUser(req) {
  var t = getToken(req);
  if (!t) return null;
  var session = db.prepare("SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(t);
  if (!session) db.prepare("DELETE FROM sessions WHERE token = ? AND expires_at <= datetime('now')").run(t);
  if (!session) return null;
  return db.prepare('SELECT id, fullname, email, phone, fin_code, telegram_username AS telegram_chat_id, created_at FROM users WHERE id = ?').get(session.user_id);
}

function accrueDailyEarnings(userId) {
  var now = new Date();
  var today = bakuDate(now);
  var purchases = db.prepare(`
    SELECT id, daily, created_at
    FROM purchases
    WHERE user_id = ?
      AND payment_verified = 1
      AND NOT EXISTS (
        SELECT 1 FROM daily_earnings
        WHERE purchase_id = purchases.id AND earning_date = ?
      )
  `).all(userId, today);
  var insertCredit = db.prepare('INSERT OR IGNORE INTO daily_earnings (purchase_id, user_id, earning_date, amount_cents) VALUES (?,?,?,?)');
  purchases.forEach(function (purchase) {
    var purchasedAt = parseSqlDate(purchase.created_at);
    if (!purchasedAt) return;
    var latest = db.prepare('SELECT MAX(earning_date) AS day FROM daily_earnings WHERE purchase_id = ?').get(purchase.id).day;
    var nextEarningDate = getNextEarningDate(purchasedAt, latest, now);
    if (!nextEarningDate) return;
    var day = new Date(nextEarningDate + 'T00:00:00Z');
    var todayStart = new Date(today + 'T00:00:00Z');
    while (day <= todayStart) {
      insertCredit.run(purchase.id, userId, day.toISOString().slice(0, 10), Math.round(Number(purchase.daily) * 100));
      day.setUTCDate(day.getUTCDate() + 1);
    }
  });
  var result = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM daily_earnings WHERE user_id = ?').get(userId);
  return result.cents / 100;
}

function totalEarned(userId) {
  return accrueDailyEarnings(userId);
}
function totalWithdrawn(userId) {
  return db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE user_id = ? AND status != 'rejected'").get(userId).s;
}

// ---------- AUTH ----------
app.post('/api/register', (req, res) => {
  var { fullname, email, password, phone } = req.body || {};
  if (typeof fullname !== 'string' || typeof email !== 'string' || typeof password !== 'string' ||
      typeof phone !== 'string' ||
      !fullname.trim() || !email.trim() || !password || !phone.trim()) {
    return res.status(400).json({ error: 'Bütün sahələr tələb olunur.' });
  }
  if (fullname.trim().length > 120 || email.trim().length > 254 || password.length > 128) {
    return res.status(400).json({ error: 'Daxil edilən məlumatlardan biri icazə verilən uzunluğu keçir.' });
  }
  if (password.length < 12) return res.status(400).json({ error: 'Şifrə minimum 12 simvol olmalıdır.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return res.status(400).json({ error: 'E-poçt formatı yanlışdır.' });
  phone = normalizePhone(phone);
  if (!/^\+994\s\d{2}\s\d{3}\s\d{2}\s\d{2}$/.test(phone)) return res.status(400).json({ error: 'Mobil nömrə formatı +994 xx xxx xx xx olmalıdır.' });
  var finCode = typeof (req.body || {}).finCode === 'string' ? req.body.finCode.trim().toUpperCase() : '';
  if (finCode && !/^[A-Z0-9]{7}$/.test(finCode)) finCode = '';
  try {
    var info = db.prepare('INSERT INTO users (fullname, email, phone, password_hash, fin_code) VALUES (?,?,?,?,?)')
      .run(fullname.trim(), email.trim().toLowerCase(), phone, hashPassword(password), finCode);
    var token = crypto.randomBytes(24).toString('hex');
    db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))").run(token, info.lastInsertRowid);
    setSessionCookie(res, token);
    sendTelegramMessage(
      '🆕 <b>YENİ QEYDİYYAT</b>\n\n' +
      '👤 Ad: <b>' + escapeTelegramHtml(fullname.trim()) + '</b>\n' +
      '📧 E-poçt: ' + escapeTelegramHtml(email.trim().toLowerCase()) + '\n' +
      '📱 Telefon: ' + escapeTelegramHtml(phone) + '\n' +
      '🆔 İstifadəçi: <code>' + info.lastInsertRowid + '</code>\n' +
      '🕒 ' + new Date().toLocaleString('az-AZ')
    );
    res.json({ ok: true, token, user: { id: info.lastInsertRowid, fullname: fullname.trim(), email: email.trim().toLowerCase(), phone } });
  } catch (e) {
    if (String(e.message).includes('users.email')) return res.status(409).json({ error: 'Bu e-poçt artıq qeydiyyatdan keçib.' });
    if (String(e.message).includes('users.phone')) return res.status(409).json({ error: 'Bu mobil nömrə artıq qeydiyyatdan keçib.' });
    if (String(e.message).includes('users.fin_code')) return res.status(409).json({ error: 'Bu FIN kodu artıq qeydiyyatdan keçib.' });
    res.status(500).json({ error: 'Qeydiyyat alınmadı.' });
  }
});

// ---------- PASSWORD RESET ----------
const passwordResetCodes = new Map(); // email -> { code, expiresAt }
const RESET_CODE_TTL = 15 * 60 * 1000;

app.post('/api/forgot-password', createRateLimiter(15 * 60 * 1000, 5, 'reset'), (req, res) => {
  var { email } = req.body || {};
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: 'Düzgün e-poçt ünvanı daxil edin.' });
  }
  var normalized = email.trim().toLowerCase();
  var user = db.prepare('SELECT id, fullname FROM users WHERE email = ?').get(normalized);
  // Cavabda istifadəçinin olub-olmadığını açıqlamırıq (security).
  if (user && isMailConfigured()) {
    var code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    passwordResetCodes.set(normalized, { code, expiresAt: Date.now() + RESET_CODE_TTL });
    sendResetCodeEmail(normalized, code).then(function (sent) {
      if (!sent) console.warn('[reset] Kod e-poçtu göndərilmədi:', normalized);
    });
  } else if (user && !isMailConfigured()) {
    console.warn('[reset] Mail konfiqurasiya edilməyib — kod göndərilmədi:', normalized);
  }
  res.json({ ok: true, message: 'Əgər bu e-poçt qeydiyyatdan keçibsə, bərpa kodu göndərildi.' });
});

app.post('/api/verify-reset-code', createRateLimiter(15 * 60 * 1000, 10, 'reset-verify'), (req, res) => {
  var { email, code } = req.body || {};
  if (typeof email !== 'string' || typeof code !== 'string') {
    return res.status(400).json({ error: 'E-poçt və kod tələb olunur.' });
  }
  var normalized = email.trim().toLowerCase();
  var entry = passwordResetCodes.get(normalized);
  if (!entry || entry.expiresAt <= Date.now() || entry.code !== code.trim()) {
    return res.status(400).json({ error: 'Kod yanlışdır və ya vaxtı keçib.' });
  }
  res.json({ ok: true });
});

app.post('/api/reset-password', createRateLimiter(15 * 60 * 1000, 10, 'reset-confirm'), (req, res) => {
  var { email, code, newPassword } = req.body || {};
  if (typeof email !== 'string' || typeof code !== 'string' || typeof newPassword !== 'string' ||
      !email.trim() || !code.trim() || !newPassword) {
    return res.status(400).json({ error: 'E-poçt, kod və yeni şifrə tələb olunur.' });
  }
  if (newPassword.length < 12 || newPassword.length > 128) {
    return res.status(400).json({ error: 'Şifrə minimum 12 simvol olmalıdır.' });
  }
  var normalized = email.trim().toLowerCase();
  var entry = passwordResetCodes.get(normalized);
  if (!entry || entry.expiresAt <= Date.now() || entry.code !== code.trim()) {
    return res.status(400).json({ error: 'Kod yanlışdır və ya vaxtı keçib.' });
  }
  var user = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);
  if (!user) return res.status(400).json({ error: 'İstifadəçi tapılmadı.' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  passwordResetCodes.delete(normalized);
  sendTelegramMessage('🔒 <b>ŞİFRƏ BƏRPASI</b>\n\n👤 İstifadəçi: <b>' + escapeTelegramHtml(normalized) + '</b>\n🕒 ' + new Date().toLocaleString('az-AZ'));
  res.json({ ok: true, message: 'Şifrə yeniləndi. Yeni şifrə ilə daxil ola bilərsiniz.' });
});

app.post('/api/login', (req, res) => {
  var { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password ||
      email.length > 254 || password.length > 128) {
    return res.status(400).json({ error: 'E-poçt və şifrə tələb olunur.' });
  }
  var user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  var passwordValid = verifyPassword(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
  if (!user || !passwordValid) {
    return res.status(401).json({ error: 'E-poçt və ya şifrə yanlışdır.' });
  }
  if (!String(user.password_hash).startsWith('pbkdf2$')) {
    var upgradedHash = hashPassword(password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(upgradedHash, user.id);
  }
  var token = crypto.randomBytes(24).toString('hex');
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))").run(token, user.id);
  setSessionCookie(res, token);
  res.json({ ok: true, token, user: { id: user.id, fullname: user.fullname, email: user.email } });
});

app.post('/api/logout', (req, res) => {
  var token = getToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ---------- ME / WALLET ----------
app.get('/api/payment-info', (req, res) => {
  var paymentInfo = getPaymentInfo();
  res.json({
    configured: paymentInfo.configured,
    cardNumber: paymentInfo.configured ? paymentInfo.cardNumber.replace(/(\d{4})(?=\d)/g, '$1 ') : '',
    bankName: paymentInfo.configured ? paymentInfo.bankName : '',
    testMode: paymentInfo.configured && isPaymentTestMode()
  });
});

app.get('/api/me', (req, res) => {
  var user = authUser(req);
  if (!user) return res.status(401).json({ error: 'Avtorizasiya tələb olunur.' });
  var purchases = db.prepare('SELECT plan_name, price, daily, txn_id, amount_paid, created_at FROM purchases WHERE user_id = ? ORDER BY created_at DESC')
    .all(user.id)
    .map(function (purchase) {
      var purchasedAt = parseSqlDate(purchase.created_at);
      var earningStartAt = getEarningStartAt(purchasedAt);
      purchase.earning_starts_at = earningStartAt ? earningStartAt.toISOString() : null;
      return purchase;
    });
  var withdrawals = db.prepare('SELECT wd_id, amount, method, target, status, created_at FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
  var earned = totalEarned(user.id);
  var withdrawn = totalWithdrawn(user.id);
  res.json({
    user,
    purchases,
    withdrawals,
    balance: Math.max(0, earned - withdrawn),
    totalEarned: earned,
    totalWithdrawn: withdrawn
  });
});

// ---------- PURCHASE ----------
app.post('/api/purchase', (req, res) => {
  var user = authUser(req);
  if (!user) return res.status(401).json({ error: 'Avtorizasiya tələb olunur.' });
  res.status(409).json({ error: 'Otaq yalnız ödəniş qəbzi göndərilib təsdiqləndikdən sonra aktivləşdirilir.' });
});

app.post('/api/payment/receipt', async (req, res) => {
  var user = authUser(req);
  if (!user) return res.status(401).json({ error: 'Avtorizasiya tələb olunur.' });
  if (!getPaymentInfo().configured) {
    return res.status(503).json({ error: 'Alıcı kartı hələ konfiqurasiya edilməyib.' });
  }

  var body = req.body || {};
  var plan = PLANS[body.plan];
  var amount = Number(body.amount);
  var promoRates = { PRO10: 0.1, NEXORA10: 0.1, START20: 0.2, VIP30: 0.3 };
  var promoCode = typeof body.promoCode === 'string' ? body.promoCode.trim().toUpperCase() : '';
  var promoRate = promoCode ? promoRates[promoCode] : 0;
  var expectedAmount = plan ? Math.round(plan.price * (1 - (promoRate || 0)) * 100) / 100 : 0;
  if (!plan || (promoCode && promoRate === undefined) || !Number.isFinite(amount) || amount !== expectedAmount) {
    return res.status(400).json({ error: 'Otaq və ya ödəniş məbləği yanlışdır.' });
  }

  var imageMatch = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.imageData || ''));
  if (!imageMatch) return res.status(400).json({ error: 'JPG, PNG və ya WebP qəbz şəkli tələb olunur.' });
  var imageType = imageMatch[1];
  var image = Buffer.from(imageMatch[2], 'base64');
  if (!image.length || image.length > 5 * 1024 * 1024) {
    return res.status(400).json({ error: 'Şəkil boşdur və ya 5 MB limitini keçir.' });
  }
  var validSignature = imageType === 'jpeg'
    ? image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff
    : imageType === 'png'
      ? image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : image.subarray(0, 4).toString() === 'RIFF' && image.subarray(8, 12).toString() === 'WEBP';
  if (!validSignature) return res.status(400).json({ error: 'Faylın məzmunu şəkil formatına uyğun deyil.' });

  var requestId = 'PAY-' + crypto.randomBytes(5).toString('hex').toUpperCase();
  var testMode = isPaymentTestMode();
  var autoApproveAt = testMode ? new Date(Date.now() + 60 * 1000).toISOString() : null;
  db.prepare('INSERT INTO payment_receipts (request_id, user_id, plan_name, amount, auto_approve_at) VALUES (?,?,?,?,?)')
    .run(requestId, user.id, body.plan, amount, autoApproveAt);
  var caption = [
    (testMode ? 'TEST QƏBZİ · ' : 'Ödəniş qəbzi · ') + requestId,
    'İstifadəçi: ' + escapeTelegramHtml(user.fullname),
    'E-poçt: ' + escapeTelegramHtml(user.email),
    'Otaq: ' + body.plan,
    'Məbləğ: ' + amount.toFixed(2) + ' AZN',
    testMode ? 'Test rejimi: 60 saniyəyə avtomatik təsdiqlənəcək' : 'Status: təsdiq gözləyir',
    'Aşağıdakı düymələrdən istifadə edin; əmrlə də təsdiqləyə bilərsiniz.'
  ].join('\n');
  var extension = imageType === 'jpeg' ? 'jpg' : imageType;
  var replyMarkup = {
    inline_keyboard: [[
      { text: '✅ Təsdiqlə', callback_data: 'payment:approve:' + requestId },
      { text: '❌ Rədd et', callback_data: 'payment:reject:' + requestId }
    ]]
  };
  var sent = await sendTelegramPhoto(image, 'receipt-' + requestId + '.' + extension, 'image/' + imageType, caption, null, replyMarkup);
  if (!sent) {
    db.prepare("UPDATE payment_receipts SET status = 'delivery_failed' WHERE request_id = ?").run(requestId);
    return res.status(502).json({ error: 'Qəbz Telegram-a göndərilmədi. Yenidən cəhd edin.' });
  }
  res.json({ ok: true, requestId, status: 'pending', autoApproveInSeconds: testMode ? 60 : null });
});

// ---------- WITHDRAW (with Telegram report) ----------
app.post('/api/withdraw', (req, res, next) => {
  var user = authUser(req);
  if (!user) return res.status(401).json({ error: 'Avtorizasiya tələb olunur.' });
  var { amount, method, target } = req.body || {};
  amount = Number(amount);
  method = method || 'card';

  if (typeof target !== 'string' || !target.trim() || target.trim().length > 200) {
    return res.status(400).json({ error: 'Çıxarış detallarını düzgün daxil edin.' });
  }
  if (method !== 'card' && method !== 'm10') return res.status(400).json({ error: 'Çıxarış üsulu yanlışdır.' });
  if (!Number.isFinite(amount) || amount < 1) return res.status(400).json({ error: 'Minimum çıxarış məbləği 1₼-dır.' });

  var balance = totalEarned(user.id) - totalWithdrawn(user.id);
  if (amount > balance) {
    return res.status(400).json({ error: 'Balansda kifayət qədər vəsait yoxdur. Əlçatan: ₼' + Math.max(0, balance).toFixed(2) });
  }

  var wdId;
  try {
    db.prepare("INSERT INTO withdrawals (user_id, amount, method, target, wd_id) VALUES (?,?,?,?,?)")
      .run(user.id, amount, method || 'card', String(target).trim(), (wdId = 'WD-' + crypto.randomBytes(3).toString('hex').toUpperCase()));
  } catch (e) {
    if (String(e.message).includes('withdrawals.wd_id')) {
      return res.status(409).json({ error: 'Təkrar sifariş IDsi yarandı, yenidən cəhd edin.' });
    }
    throw e;
  }

  var methodLabels = { card: 'Bank Kartı', m10: 'm10 / E-Wallet' };

  // >>> TELEGRAM REPORT <<<
  var notificationMessage =
    '💸 <b>YENİ ÇIXARIŞ SORĞUSU</b>\n\n' +
    '👤 İstifadəçi: <b>' + escapeTelegramHtml(user.fullname) + '</b>\n' +
    '📧 E-poçt: ' + escapeTelegramHtml(user.email) + '\n' +
    '💰 Məbləğ: <b>₼' + amount.toFixed(2) + '</b>\n' +
    '🏦 Üsul: ' + (methodLabels[method] || method) + '\n' +
    '🎯 Detallar: <code>' + escapeTelegramHtml(target.trim()) + '</code>\n' +
    '🧾 Sifariş: <code>' + wdId + '</code>\n' +
    '🕒 ' + new Date().toLocaleString('az-AZ') + '\n\n' +
    '⚠️ Balansda qalan: ₼' + Math.max(0, balance - amount).toFixed(2);

  // Şəxsi bildiriş: istifadəçinin öz Telegram-a da göndər
  var uRow = db.prepare('SELECT telegram_username FROM users WHERE id = ?').get(user.id);
  if (uRow && uRow.telegram_username) {
    sendTelegramMessage(
      '💸 <b>Çıxarış sorğunuz qəbul edildi</b>\n\n' +
      '🧾 Sifariş: <code>' + wdId + '</code>\n' +
      '💰 Məbləğ: ₼' + amount.toFixed(2) + '\n' +
      '🏦 ' + methodLabels[method] + ' · <code>' + escapeTelegramHtml(target.trim()) + '</code>\n\n' +
      '✅ Təsdiqləndikdən sonra vəsait 2 gün ərzində göndəriləcək.',
      uRow.telegram_username
    );
  }

  sendTelegramMessage(notificationMessage).then(function (notificationSent) {
    res.json({
      ok: true,
      wdId,
      remaining: Math.max(0, balance - amount),
      notificationSent
    });
  }).catch(next);
});

// ---------- HEALTH ----------
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'nexora-backend', time: new Date().toISOString() }));

// ---------- TELEGRAM ACCOUNT CONNECTION ----------
// User connects their own TG: they get a one-time code, send it to our bot,
// bot replies confirming. Withdrawal confirmations also go to their chat.
app.get('/api/telegram/start', (req, res) => {
  var user = authUser(req);
  if (!user) return res.status(401).json({ error: 'Avtorizasiya tələb olunur.' });
  var code = 'NX' + crypto.randomBytes(3).toString('hex').toUpperCase().padStart(6, '0');
  codes.set(user.id, { code, created: Date.now() });
  res.json({ ok: true, code, botUsername: config.TELEGRAM_BOT_USERNAME || null });
});

app.post('/api/telegram/confirm', (req, res) => {
  var user = authUser(req);
  if (!user) return res.status(401).json({ error: 'Avtorizasiya tələb olunur.' });
  var { chatId } = req.body || {};
  var entry = codes.get(user.id);
  if (!entry || Date.now() - entry.created > 15 * 60 * 1000) {
    return res.status(400).json({ error: 'Kod müddəti bitib. Yeni kod alın.' });
  }
  if (!/^-?\d{1,20}$/.test(String(chatId || ''))) return res.status(400).json({ error: 'chatId formatı yanlışdır.' });
  db.prepare('UPDATE users SET telegram_username = ? WHERE id = ?').run(String(chatId), user.id);
  codes.delete(user.id);
  sendTelegramMessage('🔗 <b>Telegram hesabı bağlandı!</b>\n\n👤 ' + escapeTelegramHtml(user.fullname) + ' (ID: ' + user.id + ') — çıxarış bildirişləri bu chat-ə göndəriləcək.', chatId);
  res.json({ ok: true, connected: chatId });
});

app.post('/api/telegram/disconnect', (req, res) => {
  var user = authUser(req);
  if (!user) return res.status(401).json({ error: 'Avtorizasiya tələb olunur.' });
  db.prepare('UPDATE users SET telegram_username = NULL WHERE id = ?').run(user.id);
  res.json({ ok: true });
});

app.use(function (error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Sorğu ölçüsü icazə verilən həddi keçir.' });
  }
  if (error instanceof SyntaxError && error.status === 400 && Object.prototype.hasOwnProperty.call(error, 'body')) {
    return res.status(400).json({ error: 'Sorğu JSON formatında deyil.' });
  }
  console.error('[http] Sorğu xətası:', error.message);
  res.status(500).json({ error: 'Daxili server xətası.' });
});

// Bot polls for user codes → links their chat to their account
function handlePaymentCommand(action, requestId, chatId, userId, isInternal) {
  if (!isInternal && (
    String(chatId) !== String(config.TELEGRAM_CHAT_ID) ||
    !config.TELEGRAM_ADMIN_USER_ID ||
    String(userId) !== String(config.TELEGRAM_ADMIN_USER_ID)
  )) {
    sendTelegramMessage('Bu əmri yerinə yetirmək icazəniz yoxdur.', chatId);
    return;
  }
  var receipt = db.prepare('SELECT * FROM payment_receipts WHERE request_id = ?').get(requestId);
  if (!receipt) {
    sendTelegramMessage('Qəbz sorğusu tapılmadı: ' + requestId, chatId);
    return;
  }
  if (receipt.status !== 'pending') {
    sendTelegramMessage(requestId + ' artıq işlənib. Status: ' + receipt.status, chatId);
    return;
  }

  var plan = PLANS[receipt.plan_name];
  if (action === 'approve' && !plan) {
    sendTelegramMessage('Otaq məlumatı tapılmadı; təsdiq edilmədi.', chatId);
    return;
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    var status = action === 'approve' ? 'approved' : 'rejected';
    var result = db.prepare("UPDATE payment_receipts SET status = ? WHERE request_id = ? AND status = 'pending'")
      .run(status, requestId);
    if (result.changes !== 1) throw new Error('Qəbz sorğusu artıq işlənib.');
    if (action === 'approve') {
      db.prepare('INSERT INTO purchases (user_id, plan_name, price, daily, txn_id, amount_paid, payment_verified) VALUES (?,?,?,?,?,?,1)')
        .run(receipt.user_id, receipt.plan_name, plan.price, plan.daily, '#' + requestId, receipt.amount);
      totalEarned(receipt.user_id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    sendTelegramMessage(error.message || 'Qəbz emal olunmadı.', chatId);
    return;
  }

  var message = action === 'approve'
    ? 'Təsdiqləndi: ' + requestId + '\nOtaq: ' + receipt.plan_name + '\nGündəlik gəlir: ' + plan.daily.toFixed(2) + ' AZN. İlk gündəlik məbləğ balansa köçürüldü.'
    : 'Rədd edildi: ' + requestId + '. Otaq aktivləşdirilmədi.';
  sendTelegramMessage(message, chatId);
}

function processTestAutoApprovals() {
  if (!isPaymentTestMode()) return;
  var due = db.prepare("SELECT request_id FROM payment_receipts WHERE status = 'pending' AND auto_approve_at <= ?")
    .all(new Date().toISOString());
  due.forEach(function (receipt) {
    handlePaymentCommand('approve', receipt.request_id, config.TELEGRAM_CHAT_ID, null, true);
  });
}

const telegramShutdown = new AbortController();
const telegramPolling = pollForCodes(function (code, chatId) {
  for (const [userId, entry] of codes.entries()) {
    if (entry.code === code) {
      if (Date.now() - entry.created > 15 * 60 * 1000) {
        sendTelegramMessage('⏰ Kodun müddəti bitib. Dashboard-da yeniləyin.', chatId);
        return;
      }
      db.prepare('UPDATE users SET telegram_username = ? WHERE id = ?').run(chatId, userId);
      codes.delete(userId);
      sendTelegramMessage('✅ <b>Hesabınız bağlandı!</b> Artıq çıxarış bildirişləri buraya gələcək.', chatId);
      return;
    }
  }
  sendTelegramMessage('❓ Bu kod tapılmadı və ya istifadə edilib. Dashboard-da yeni kod alın.', chatId);
}, handlePaymentCommand, updatePaymentInfo, telegramShutdown.signal);

const PORT = process.env.PORT || 3000;

// ---------- 24/7 RESILIENCE ----------
// A stray unhandled error or rejected promise must never take the server down.
process.on('uncaughtException', function (error) {
  console.error('[fatal] uncaughtException — server dayandırılır:', error);
  process.exit(1);
});
process.on('unhandledRejection', function (reason) {
  console.error('[fatal] unhandledRejection — server dayandırılır:', reason);
  process.exit(1);
});

function accrueAllDailyEarnings() {
  db.prepare('SELECT DISTINCT user_id FROM purchases').all().forEach(function (row) {
    try { totalEarned(row.user_id); }
    catch (error) { console.error('[earnings] Gündəlik kredit yazılmadı:', error.message); }
  });
}
accrueAllDailyEarnings();
const sessionCleanupInterval = setInterval(function () {
  try { db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run(); }
  catch (error) { console.error('[sessions] Müddəti bitmiş sessiyalar təmizlənmədi:', error.message); }
}, 60 * 60 * 1000).unref();
const paymentApprovalInterval = setInterval(function () {
  try { processTestAutoApprovals(); }
  catch (error) { console.error('[payments] Test təsdiqləri emal olunmadı:', error.message); }
}, 1000);
const server = app.listen(PORT, () => {
  console.log('✅ Nexora backend işə düşdü, port: ' + PORT);
  console.log('📊 Bazanın yerləşdiyi yer: ' + DB_PATH);
  console.log('🤖 Telegram: TELEGRAM_BOT_TOKEN və TELEGRAM_CHAT_ID environment dəyişənlərini yoxlayın.');
});
server.headersTimeout = 30 * 1000;
server.requestTimeout = 120 * 1000;
server.keepAliveTimeout = 5 * 1000;

const earningsInterval = setInterval(function () {
  try { accrueAllDailyEarnings(); }
  catch (error) { console.error('[earnings] tick xətası:', error.message); }
}, 15 * 60 * 1000);

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[shutdown] ' + signal + ' qəbul edildi; server dayandırılır.');
  clearInterval(earningsInterval);
  clearInterval(sessionCleanupInterval);
  clearInterval(paymentApprovalInterval);
  telegramShutdown.abort();

  const forceExit = setTimeout(function () {
    console.error('[shutdown] Vaxt limiti keçildi; proses dayandırılır.');
    process.exit(1);
  }, 20 * 1000);

  server.close(function (error) {
    const closeError = error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? error : null;
    if (closeError) console.error('[shutdown] HTTP server bağlanmadı:', closeError.message);
    telegramPolling.then(function () {
      try {
        db.close();
        clearTimeout(forceExit);
        console.log('[shutdown] DB bağlantısı bağlandı.');
        process.exitCode = closeError ? 1 : 0;
      } catch (closeError) {
        console.error('[shutdown] DB bağlanmadı:', closeError.message);
        clearTimeout(forceExit);
        process.exitCode = 1;
      }
    }, function (pollError) {
      console.error('[shutdown] Telegram sorğusu dayandırılmadı:', pollError.message);
    });
  });
}

process.once('SIGTERM', function () { shutdown('SIGTERM'); });
process.once('SIGINT', function () { shutdown('SIGINT'); });
