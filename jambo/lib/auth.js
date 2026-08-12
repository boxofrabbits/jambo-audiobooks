// Signed-cookie sessions + PIN hashing + login rate limiting.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';

const COOKIE_NAME = 'jambo_session';
const SESSION_DAYS = 90;

export function loadSecret(dataDir) {
  const file = path.join(dataDir, 'secret.key');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch { /* fall through */ }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const hashPin = (pin) => bcrypt.hashSync(pin, 10);
export const checkPin = (pin, hash) => bcrypt.compareSync(pin, hash);

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function setSessionCookie(req, res, userId, secret) {
  const token = sign({ u: userId, exp: Date.now() + SESSION_DAYS * 864e5 }, secret);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Attaches req.user (or null) from the session cookie, unless something
// upstream (e.g. Home Assistant ingress) already identified the user.
export function sessionMiddleware(db, secret) {
  return (req, res, next) => {
    if (!req.user) {
      const payload = verify(parseCookies(req)[COOKIE_NAME], secret);
      req.user = payload ? db.getUser(payload.u) || null : null;
    }
    next();
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'not_logged_in' });
  next();
}

// Simple per-IP login limiter: 10 failed attempts per 15 minutes.
const attempts = new Map();
export function loginLimiter(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const entry = attempts.get(key) || { count: 0, resetAt: now + 15 * 60e3 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 15 * 60e3; }
  if (entry.count >= 10) {
    return res.status(429).json({ error: 'too_many_attempts', retryInMinutes: Math.ceil((entry.resetAt - now) / 60e3) });
  }
  res.recordFailedLogin = () => { entry.count++; attempts.set(key, entry); };
  next();
}
