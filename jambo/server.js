import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db } from './lib/db.js';
import {
  loadSecret, hashPin, checkPin, setSessionCookie, clearSessionCookie,
  sessionMiddleware, requireAuth, loginLimiter,
} from './lib/auth.js';
import { scanLibrary, AUDIO_EXT, IMAGE_EXT } from './lib/scan.js';
import { syncSampleBook } from './lib/sample.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
let BOOKS_DIR = process.env.BOOKS_DIR || path.join(__dirname, 'books');

// Running as a Home Assistant add-on: options from the add-on's Configuration
// tab land in /data/options.json and override the env default.
let NOTIFY_SERVICES = new Map(); // lowercased profile name -> notify service
let LISTENING_NOTIFICATIONS = true;
try {
  const opts = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'options.json'), 'utf8'));
  if (opts.books_dir) BOOKS_DIR = opts.books_dir;
  if (opts.listening_notifications === false) LISTENING_NOTIFICATIONS = false;
  for (const entry of opts.overtake_notifications || []) {
    const service = String(entry.service || '').replace(/^notify\./, '');
    if (entry.profile && /^[a-z0-9_]+$/.test(service)) {
      NOTIFY_SERVICES.set(String(entry.profile).trim().toLowerCase(), service);
    }
  }
} catch { /* not an add-on */ }

const SUPERVISOR_URL = process.env.SUPERVISOR_URL || 'http://supervisor';
const PORT = Number(process.env.PORT || 3000);

// Home Assistant ingress proxies from a fixed IP and adds X-Remote-User-* headers.
const INGRESS_TRUSTED_IP = process.env.INGRESS_TRUSTED_IP || '172.30.32.2';

const db = new Db(path.join(DATA_DIR, 'db.json'));
const secret = loadSecret(DATA_DIR);

// Books can never silently vanish because books_dir changed: the add-on's
// default share folder is ALWAYS scanned alongside the configured folder.
const IS_ADDON = fs.existsSync(path.join(DATA_DIR, 'options.json'));
const BOOKS_ROOTS = [...new Set([BOOKS_DIR, ...(IS_ADDON ? ['/share/jambo/books'] : [])])];

// If the configured folder didn't exist at startup (e.g. an unmounted USB
// drive), creating it and carrying on would strand uploads in a folder that
// may not persist — surface that loudly instead.
let storageWarning = null;
if (!fs.existsSync(BOOKS_DIR)) {
  storageWarning = `Books folder ${BOOKS_DIR} did not exist at startup — if this should be a USB drive, check that it is actually mounted before uploading.`;
  console.warn(`[storage] ${storageWarning}`);
}

const SAMPLE_SLUG = 'jambo-demo-sample-book';

let books = [];
let bookById = new Map();
let missingBooks = [];
let scanning = null;

function findMissingBooks() {
  const present = new Set(books.map(b => b.id));
  const ids = new Set();
  for (const key of Object.keys(db.data.progress)) {
    const bookId = key.slice(key.indexOf(':') + 1);
    if (!present.has(bookId) && bookId !== SAMPLE_SLUG) ids.add(bookId);
  }
  return [...ids];
}

async function rescan() {
  if (!scanning) {
    scanning = (async () => {
      const cacheFile = path.join(DATA_DIR, 'scan-cache.json');
      books = await scanLibrary(BOOKS_ROOTS, cacheFile);
      missingBooks = findMissingBooks();
      // The demo book only appears on a genuinely fresh library — never to
      // paper over books that are missing because storage went away.
      const hasReal = books.some(b => b.id !== SAMPLE_SLUG);
      try {
        for (const [i, root] of BOOKS_ROOTS.entries()) {
          syncSampleBook(root, hasReal, i === 0 && missingBooks.length === 0);
        }
        if (!hasReal && missingBooks.length === 0 && books.length === 0) {
          books = await scanLibrary(BOOKS_ROOTS, cacheFile);
        }
      } catch (err) { console.warn('[sample]', err.message); }
      bookById = new Map(books.map(b => [b.id, b]));
      console.log(`[scan] ${books.length} book(s) across ${BOOKS_ROOTS.join(', ')}${missingBooks.length ? ` — MISSING: ${missingBooks.join(', ')}` : ''}`);
    })().finally(() => { scanning = null; });
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
  res.json({
    books: books.map(b => bookSummary(b, req.user.id)),
    missingBooks,
    storageWarning,
  });
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
    notes: notesForClient(book.id),
  });
});

// ---------- voice notes ----------

const NOTES_DIR = path.join(DATA_DIR, 'notes');
const MAX_NOTE_BYTES = 20 * 1024 * 1024; // ~2 min of 48kHz 16-bit WAV, with headroom

// POST /api/notes?bookId=&position= — raw WAV body.
app.post('/api/notes', requireAuth, (req, res) => {
  const book = bookById.get(String(req.query.bookId || ''));
  const position = Number(req.query.position);
  if (!book || !Number.isFinite(position) || position < 0) return res.status(400).json({ error: 'bad_note' });

  fs.mkdirSync(NOTES_DIR, { recursive: true });
  const id = crypto.randomUUID();
  const filePath = path.join(NOTES_DIR, `${id}.wav`);
  let bytes = 0;
  let failed = false;
  const ws = fs.createWriteStream(filePath);
  const fail = (status, error) => {
    if (failed) return;
    failed = true;
    ws.destroy();
    fs.rm(filePath, { force: true }, () => {});
    req.destroy();
    if (!res.headersSent) res.status(status).json({ error });
  };
  req.on('data', (c) => { bytes += c.length; if (bytes > MAX_NOTE_BYTES) fail(413, 'note_too_long'); });
  req.on('error', () => fail(500, 'upload_interrupted'));
  ws.on('error', () => fail(500, 'disk_write_failed'));
  ws.on('finish', () => {
    if (failed) return;
    const note = { id, bookId: book.id, userId: req.user.id, position, createdAt: Date.now() };
    db.addNote(note);
    console.log(`[notes] ${req.user.name} left a note on "${book.title}" at ${Math.round(position)}s`);
    res.json({ ok: true, note: { ...note, user: publicUser(req.user) } });
  });
  req.pipe(ws);
});

app.get('/api/notes/:id/audio', requireAuth, (req, res) => {
  const note = db.getNote(req.params.id);
  if (!note) return res.status(404).end();
  res.sendFile(path.join(NOTES_DIR, `${note.id}.wav`), { acceptRanges: true, cacheControl: false });
});

app.delete('/api/notes/:id', requireAuth, (req, res) => {
  const note = db.getNote(req.params.id);
  if (!note) return res.status(404).json({ error: 'not_found' });
  if (note.userId !== req.user.id) return res.status(403).json({ error: 'not_yours' });
  db.deleteNote(note.id);
  fs.rm(path.join(NOTES_DIR, `${note.id}.wav`), { force: true }, () => {});
  res.json({ ok: true });
});

const notesForClient = (bookId) =>
  db.notesForBook(bookId)
    .map(n => ({ id: n.id, position: n.position, user: publicUser(db.getUser(n.userId)), userId: n.userId, createdAt: n.createdAt }))
    .sort((a, b) => a.position - b.position);

app.get('/api/books/:id/progress', requireAuth, (req, res) => {
  const book = bookById.get(req.params.id);
  if (!book) return res.status(404).json({ error: 'not_found' });
  const partner = db.users.find(u => u.id !== req.user.id);
  res.json({
    me: progressFor(req.user.id, book),
    partner: partner ? { user: publicUser(partner), progress: progressFor(partner.id, book) } : null,
    notes: notesForClient(book.id),
  });
});

// Native push via the HA companion app when one listener overtakes the other.
const fmtGap = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : `${Math.round(sec)}s`;
};
const overtakeCooldown = new Map(); // `${passerId}:${bookId}` -> timestamp

async function haNotify(service, payload, label) {
  try {
    const res = await fetch(`${SUPERVISOR_URL}/core/api/services/notify/${service}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (label) console.log(`[notify] ${label}`);
  } catch (err) {
    console.warn(`[notify] failed (${label || 'notification'}): ${err.message}`);
  }
}

function notifyOvertake(passer, passed, book, newPos, partnerPos) {
  const service = NOTIFY_SERVICES.get(passed.name.toLowerCase());
  if (!service || !process.env.SUPERVISOR_TOKEN) return;
  const key = `${passer.id}:${book.id}`;
  if (Date.now() - (overtakeCooldown.get(key) || 0) < 30 * 60e3) return;
  overtakeCooldown.set(key, Date.now());
  haNotify(service, {
    title: 'Jambo 📖',
    message: `${passer.name} just passed you in “${book.title}” — you're now ${fmtGap(newPos - partnerPos)} behind 👀`,
  }, `told ${passed.name} that ${passer.name} passed them in "${book.title}"`);
}

// Ambient "now listening" notification on the partner's phone: silently
// refreshed (same tag replaces in place) while listening, cleared after ~2
// minutes of no progress saves.
const LISTEN_STALE_MS = Number(process.env.LISTEN_STALE_MS || 120e3);
const LISTEN_PUSH_INTERVAL_MS = Number(process.env.LISTEN_PUSH_INTERVAL_MS || 60e3);
const listenSessions = new Map(); // listenerId -> {bookId, lastAt, lastPushAt, cleared}

function updateListeningNotification(listener, partner, book, pos) {
  if (!LISTENING_NOTIFICATIONS || !process.env.SUPERVISOR_TOKEN) return;
  const service = NOTIFY_SERVICES.get(partner.name.toLowerCase());
  if (!service) return;
  let s = listenSessions.get(listener.id);
  if (!s || s.bookId !== book.id) {
    s = { bookId: book.id, lastAt: 0, lastPushAt: 0, cleared: true };
    listenSessions.set(listener.id, s);
  }
  s.lastAt = Date.now();
  if (Date.now() - s.lastPushAt < LISTEN_PUSH_INTERVAL_MS) return;
  s.lastPushAt = Date.now();
  s.cleared = false;

  const partnerProg = db.getProgress(partner.id, book.id);
  let gap = '';
  if (partnerProg && !partnerProg.finished) {
    const diff = pos - partnerProg.position;
    gap = Math.abs(diff) <= 60 ? " — you're at the same spot!" : ` — you're ${fmtGap(Math.abs(diff))} ${diff > 0 ? 'behind' : 'ahead'}`;
  }
  haNotify(service, {
    title: `${listener.name} is listening 🎧`,
    message: `${book.title}: ${fmtGap(pos)} in${gap}`,
    data: {
      tag: `jambo_listening_${listener.id}`,
      channel: 'Jambo listening',
      importance: 'low',
      notification_icon: 'mdi:book-play',
    },
  });
}

setInterval(() => {
  for (const [listenerId, s] of listenSessions) {
    if (s.cleared || Date.now() - s.lastAt < LISTEN_STALE_MS) continue;
    s.cleared = true;
    const partner = db.users.find(u => u.id !== listenerId);
    const service = partner && NOTIFY_SERVICES.get(partner.name.toLowerCase());
    if (service && process.env.SUPERVISOR_TOKEN) {
      haNotify(service, {
        message: 'clear_notification',
        data: { tag: `jambo_listening_${listenerId}` },
      }, `cleared listening notification for ${partner.name}`);
    }
  }
}, Math.min(30e3, LISTEN_STALE_MS / 2)).unref();

// POST is accepted too because sendBeacon (used for unload-time saves) can only POST.
const saveProgress = (req, res) => {
  const book = bookById.get(String(req.body?.bookId || ''));
  if (!book) return res.status(404).json({ error: 'unknown_book' });
  let pos = Number(req.body?.position);
  if (!Number.isFinite(pos) || pos < 0) return res.status(400).json({ error: 'bad_position' });
  pos = Math.min(pos, book.duration || pos);
  const finished = req.body?.finished === true || (book.duration > 0 && pos >= book.duration - 5);

  const prevPos = db.getProgress(req.user.id, book.id)?.position ?? 0;
  db.setProgress(req.user.id, book.id, pos, finished);
  res.json({ ok: true });

  // Overtake detection: only for natural listening (small forward step, not a
  // seek), crossing a partner who hasn't finished the book.
  const partner = db.users.find(u => u.id !== req.user.id);
  const partnerProg = partner && db.getProgress(partner.id, book.id);
  const step = pos - prevPos;
  if (partner && step > 0 && step < 60) {
    updateListeningNotification(req.user, partner, book, pos);
    if (partnerProg && !partnerProg.finished && prevPos <= partnerProg.position && pos > partnerProg.position) {
      notifyOvertake(req.user, partner, book, pos, partnerProg.position);
    }
  }
};
app.put('/api/progress', requireAuth, saveProgress);
app.post('/api/progress', requireAuth, saveProgress);

// ---------- uploads ----------

// One request per file, raw body streamed straight to disk (no buffering).
// POST /api/upload?book=<folder name>&filename=<file name>
const MAX_UPLOAD_BYTES = 3 * 1024 ** 3; // 3 GB per file
const SAFE_NAME = /^[^/\\<>:"|?*\x00-\x1f]{1,150}$/;

function safeEntryName(raw) {
  const name = String(raw || '').trim();
  if (!SAFE_NAME.test(name) || name.startsWith('.') || name.endsWith('.') || name.includes('..')) return null;
  return name;
}

// Chunked and resumable: the client sends 6MB pieces with ?offset=N&last=0|1.
// If a chunk arrives at the wrong offset (retry after a dropped connection),
// the server answers 409 with how many bytes it already has, and the client
// resumes from there — so a dead connection at 25% continues at 25%.
app.post('/api/upload', requireAuth, (req, res) => {
  const book = safeEntryName(req.query.book);
  const filename = safeEntryName(req.query.filename);
  if (!book || !filename) return res.status(400).json({ error: 'bad_name' });
  const ext = path.extname(filename).toLowerCase();
  if (!AUDIO_EXT.has(ext) && !IMAGE_EXT.has(ext)) return res.status(400).json({ error: 'unsupported_type' });

  const dir = path.join(BOOKS_DIR, book);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, filename);
  const tmpPath = finalPath + '.uploading';

  const chunked = req.query.offset !== undefined;
  const offset = chunked ? Number(req.query.offset) : 0;
  const last = chunked ? req.query.last === '1' : true;
  if (!Number.isInteger(offset) || offset < 0) return res.status(400).json({ error: 'bad_offset' });

  let have = 0;
  try { have = fs.statSync(tmpPath).size; } catch { /* no partial yet */ }
  if (chunked && offset !== have) {
    req.resume();
    return res.status(409).json({ error: 'offset_mismatch', have });
  }

  let bytes = 0;
  let failed = false;
  const ws = fs.createWriteStream(tmpPath, { flags: chunked && offset > 0 ? 'a' : 'w' });

  const fail = (status, error) => {
    if (failed) return;
    failed = true;
    ws.destroy();
    req.destroy();
    if (!res.headersSent) res.status(status).json({ error });
  };

  req.on('data', (c) => {
    bytes += c.length;
    if (offset + bytes > MAX_UPLOAD_BYTES) {
      fs.rm(tmpPath, { force: true }, () => {});
      fail(413, 'file_too_large');
    }
  });
  req.on('error', () => fail(500, 'upload_interrupted'));
  ws.on('error', (err) => {
    console.error('[upload] write failed:', err.message);
    fail(500, 'disk_write_failed');
  });
  ws.on('finish', () => {
    if (failed) return;
    try {
      if (last) {
        fs.renameSync(tmpPath, finalPath);
        console.log(`[upload] ${req.user.name} added ${book}/${filename} (${((offset + bytes) / 1e6).toFixed(1)} MB)`);
      }
      res.json({ ok: true, have: offset + bytes, done: last });
    } catch (err) {
      console.error('[upload] finalize failed:', err.message);
      fail(500, 'disk_write_failed');
    }
  });
  req.pipe(ws);
});

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
