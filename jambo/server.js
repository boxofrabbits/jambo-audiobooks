import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db } from './lib/db.js';
import {
  loadSecret, hashPin, checkPin, setSessionCookie, clearSessionCookie,
  sessionMiddleware, requireAuth, loginLimiter,
} from './lib/auth.js';
import { scanLibrary } from './lib/scan.js';
import { syncSampleBook } from './lib/sample.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
let BOOKS_DIR = process.env.BOOKS_DIR || path.join(__dirname, 'books');

// Running as a Home Assistant add-on: options from the add-on's Configuration
// tab land in /data/options.json and override the env default.
try {
  const opts = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'options.json'), 'utf8'));
  if (opts.books_dir) BOOKS_DIR = opts.books_dir;
} catch { /* not an add-on */ }
const PORT = Number(process.env.PORT || 3000);

// Home Assistant ingress proxies from a fixed IP and adds X-Remote-User-* headers.
const INGRESS_TRUSTED_IP = process.env.INGRESS_TRUSTED_IP || '172.30.32.2';

const db = new Db(path.join(DATA_DIR, 'db.json'));
const secret = loadSecret(DATA_DIR);

let books = [];
let bookById = new Map();
let scanning = null;

async function rescan() {
  if (!scanning) {
    try { syncSampleBook(BOOKS_DIR); } catch (err) { console.warn('[sample]', err.message); }
    scanning = scanLibrary(BOOKS_DIR, path.join(DATA_DIR, 'scan-cache.json'))
      .then(result => {
        books = result;
        bookById = new Map(books.map(b => [b.id, b]));
        console.log(`[scan] ${books.length} book(s) found in ${BOOKS_DIR}`);
      })
      .finally(() => { scanning = null; });
  }
  return scanning;
}

const app = express();
app.set('trust proxy', 1); // behind Caddy/Tailscale the first proxy hop is trusted
app.disable('x-powered-by');
app.use(express.json());

// Home Assistant ingress: trust the HA-authenticated user identity, but only
// when the request really comes from the supervisor's ingress proxy. HA users
// are signed in automatically — linked by id, matched to an existing profile
// by name, or given a brand-new profile (first two HA users only).
const PALETTE = ['#e0918b', '#8bb8e0', '#9fd0a5', '#e0c98b', '#c39be0', '#e08bc3'];
app.use((req, res, next) => {
  const uid = req.headers['x-remote-user-id'];
  const from = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (uid && from === INGRESS_TRUSTED_IP) {
    req.haUser = {
      id: String(uid),
      displayName: String(req.headers['x-remote-user-display-name'] || req.headers['x-remote-user-name'] || '').trim(),
    };
    let user = db.users.find(u => u.haUserId === req.haUser.id);
    if (!user && req.haUser.displayName) {
      user = db.users.find(u => !u.haUserId && u.name.toLowerCase() === req.haUser.displayName.toLowerCase());
      if (user) { user.haUserId = req.haUser.id; db.save(); }
    }
    if (!user && db.users.length < 2) {
      user = {
        id: crypto.randomUUID(),
        name: (req.haUser.displayName || 'Listener').slice(0, 30),
        color: PALETTE.find(c => !db.users.some(u => u.color === c)) || PALETTE[0],
        pinHash: null,
        haUserId: req.haUser.id,
      };
      db.addUser(user);
      console.log(`[auth] created profile "${user.name}" for HA user ${req.haUser.id}`);
    }
    req.user = user || null;
  }
  next();
});

app.use(sessionMiddleware(db, secret));

const publicUser = (u) => u && { id: u.id, name: u.name, color: u.color };

function progressFor(userId, book) {
  const p = db.getProgress(userId, book.id);
  return p ? { position: p.position, finished: p.finished, updatedAt: p.updatedAt } : null;
}

function bookSummary(book, meId) {
  const partner = db.users.find(u => u.id !== meId);
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    duration: book.duration,
    trackCount: book.tracks.length,
    hasCover: !!book.coverPath,
    me: progressFor(meId, book),
    partner: partner ? { user: publicUser(partner), progress: progressFor(partner.id, book) } : null,
  };
}

// ---------- auth & setup ----------

app.get('/api/state', (req, res) => {
  res.json({
    setupNeeded: db.users.length === 0,
    users: db.users.map(publicUser),
    me: publicUser(req.user),
    haUser: req.haUser ? { displayName: req.haUser.displayName } : null,
  });
});

app.post('/api/setup', (req, res) => {
  if (db.users.length > 0) return res.status(403).json({ error: 'already_set_up' });
  const profiles = req.body?.profiles;
  if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > 2) {
    return res.status(400).json({ error: 'need_1_or_2_profiles' });
  }
  for (const p of profiles) {
    const name = String(p.name || '').trim().slice(0, 30);
    const pin = String(p.pin || '');
    if (!name) return res.status(400).json({ error: 'name_required' });
    if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'pin_must_be_4_to_8_digits' });
  }
  for (const p of profiles) {
    db.addUser({
      id: crypto.randomUUID(),
      name: String(p.name).trim().slice(0, 30),
      color: /^#[0-9a-fA-F]{6}$/.test(p.color || '') ? p.color : '#e0918b',
      pinHash: hashPin(String(p.pin)),
    });
  }
  db.flushSync();
  res.json({ ok: true, users: db.users.map(publicUser) });
});

app.post('/api/login', loginLimiter, (req, res) => {
  const user = db.getUser(String(req.body?.userId || ''));
  const pin = String(req.body?.pin || '');
  if (!user) {
    res.recordFailedLogin?.();
    return res.status(401).json({ error: 'wrong_pin' });
  }
  // Profiles auto-created via Home Assistant start without a PIN; the first
  // PIN entered on the standalone login screen claims and sets it. A different
  // HA account can never claim a profile that belongs to someone else's.
  if (!user.pinHash) {
    if (req.haUser && user.haUserId && user.haUserId !== req.haUser.id) {
      return res.status(401).json({ error: 'wrong_pin' });
    }
    if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'pin_must_be_4_to_8_digits' });
    user.pinHash = hashPin(pin);
    db.save();
  } else if (!checkPin(pin, user.pinHash)) {
    res.recordFailedLogin?.();
    return res.status(401).json({ error: 'wrong_pin' });
  }
  // First login through Home Assistant ingress links the HA account to this
  // profile; from then on that HA user is signed in automatically.
  if (req.haUser && !user.haUserId && !db.users.some(u => u.haUserId === req.haUser.id)) {
    user.haUserId = req.haUser.id;
    db.save();
  }
  setSessionCookie(req, res, user.id, secret);
  res.json({ ok: true, me: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  // Under ingress, logging out also unlinks the HA account (otherwise the
  // auto-login would sign the user straight back in).
  if (req.haUser) {
    const linked = db.users.find(u => u.haUserId === req.haUser.id);
    if (linked) { delete linked.haUserId; db.save(); }
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ---------- library ----------

app.get('/api/books', requireAuth, (req, res) => {
  res.json({ books: books.map(b => bookSummary(b, req.user.id)) });
});

app.post('/api/rescan', requireAuth, async (req, res) => {
  await rescan();
  res.json({ ok: true, count: books.length });
});

app.get('/api/books/:id', requireAuth, (req, res) => {
  const book = bookById.get(req.params.id);
  if (!book) return res.status(404).json({ error: 'not_found' });
  res.json({
    ...bookSummary(book, req.user.id),
    tracks: book.tracks.map(t => ({ idx: t.idx, title: t.title, duration: t.duration, start: t.start })),
  });
});

app.get('/api/books/:id/progress', requireAuth, (req, res) => {
  const book = bookById.get(req.params.id);
  if (!book) return res.status(404).json({ error: 'not_found' });
  const partner = db.users.find(u => u.id !== req.user.id);
  res.json({
    me: progressFor(req.user.id, book),
    partner: partner ? { user: publicUser(partner), progress: progressFor(partner.id, book) } : null,
  });
});

// POST is accepted too because sendBeacon (used for unload-time saves) can only POST.
const saveProgress = (req, res) => {
  const book = bookById.get(String(req.body?.bookId || ''));
  if (!book) return res.status(404).json({ error: 'unknown_book' });
  let pos = Number(req.body?.position);
  if (!Number.isFinite(pos) || pos < 0) return res.status(400).json({ error: 'bad_position' });
  pos = Math.min(pos, book.duration || pos);
  const finished = req.body?.finished === true || (book.duration > 0 && pos >= book.duration - 5);
  db.setProgress(req.user.id, book.id, pos, finished);
  res.json({ ok: true });
};
app.put('/api/progress', requireAuth, saveProgress);
app.post('/api/progress', requireAuth, saveProgress);

// ---------- media ----------

app.get('/media/:bookId/:idx', requireAuth, (req, res) => {
  const book = bookById.get(req.params.bookId);
  const track = book?.tracks[Number(req.params.idx)];
  if (!track) return res.status(404).end();
  res.sendFile(track.path, { acceptRanges: true, cacheControl: false });
});

app.get('/covers/:bookId', requireAuth, (req, res) => {
  const book = bookById.get(req.params.bookId);
  if (!book?.coverPath) return res.status(404).end();
  res.sendFile(book.coverPath, { maxAge: '1h' });
});

// ---------- static frontend ----------

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, async () => {
  console.log(`Jambo listening on http://localhost:${PORT}`);
  await rescan();
});

// Flush pending writes on shutdown.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { db.flushSync(); process.exit(0); });
}

// Never die silently: log the reason first.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception:', err);
  try { db.flushSync(); } catch { /* best effort */ }
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[warn] unhandled rejection:', err);
});
