/* Jambo — a shared audiobook player for two. */
'use strict';

const $app = document.getElementById('app');
const audio = document.getElementById('audio');

// ---------- tiny DOM helper (safe against HTML injection) ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v; // trusted static markup only (icons)
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

// ---------- icons (static SVG) ----------

const ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4.4" height="14" rx="1.4"/><rect x="13.6" y="5" width="4.4" height="14" rx="1.4"/></svg>',
  back30: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 4.5a7.5 7.5 0 1 1-7.3 5.7"/><path d="M4.5 4v6h6" stroke-linejoin="round" fill="none" transform="translate(0.2,0.2) scale(0.62)"/></svg>',
  fwd30: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 4.5a7.5 7.5 0 1 0 7.3 5.7"/><path d="M19.5 4v6h-6" stroke-linejoin="round" fill="none" transform="translate(9,0.2) scale(0.62)"/></svg>',
  backArrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M20 11a8 8 0 1 0-1.5 6.5"/><path d="M20 5v6h-6" stroke-linejoin="round"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>',
};

// ---------- utils ----------

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
               : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtLong(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}

function fmtAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return `${Math.round(s / (86400 * 30))}mo ago`;
}

// All URLs must resolve relative to where the app is mounted, so it works both
// standalone ("/") and behind Home Assistant ingress
// ("/api/hassio_ingress/<token>/"). Leading slashes are stripped: "/api/x"
// would otherwise escape the ingress prefix and hit HA's own /api/.
const BASE = (() => {
  const p = location.pathname;
  if (p.endsWith('/')) return p;
  const last = p.split('/').pop();
  return last.includes('.') ? p.slice(0, p.length - last.length) : p + '/';
})();
const rel = (path) => BASE + String(path).replace(/^\/+/, '');

async function api(path, opts = {}) {
  const res = await fetch(rel(path), {
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    state.me = null;
    render();
    throw new Error('not_logged_in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
  return data;
}

function coverEl(book, cls) {
  const wrap = el('div', { class: cls });
  if (book.hasCover) {
    wrap.style.backgroundImage = `url(${rel('covers/' + book.id)})`;
  } else {
    let hash = 0;
    for (const ch of book.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const hue = hash % 360;
    wrap.style.background = `linear-gradient(145deg, hsl(${hue}, 32%, 30%), hsl(${(hue + 40) % 360}, 38%, 18%))`;
    wrap.append(el('div', { class: 'cover-fallback serif' }, book.title));
  }
  return wrap;
}

const avatarEl = (user, small) =>
  el('div', { class: `avatar${small ? ' small' : ''}`, style: { background: user.color } },
    user.name.trim().charAt(0).toUpperCase());

const isLive = (progress) => !!progress && Date.now() - progress.updatedAt < 90e3;

// ---------- global state ----------

const state = {
  me: null,
  users: [],
  setupNeeded: false,
  booksCache: null,
};

// ---------- player engine ----------

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const SLEEP_CHOICES = [null, 15, 30, 45, 60];

const player = {
  book: null,          // full book detail (with tracks)
  trackIdx: 0,
  position: 0,         // global seconds across the whole book
  speed: Number(localStorage.getItem('jambo_speed')) || 1,
  sleepChoice: 0,      // index into SLEEP_CHOICES
  sleepDeadline: null,
  saveTimer: null,
  lastSavedPos: null,
  blobUrl: null,       // fallback object URL when direct streaming fails
  blobTriedFor: null,
  notes: [],           // voice notes for the loaded book
  _prevTick: null,
  _preloaded: null,    // URL of the next track being warmed in the cache
  intendedPlaying: false, // true between user-play and user-pause (OS pauses don't clear it)

  get playing() { return this.book && !audio.paused && !audio.ended; },

  trackForPos(sec) {
    const tracks = this.book.tracks;
    let idx = tracks.length - 1;
    for (let i = 0; i < tracks.length; i++) {
      if (sec < tracks[i].start + tracks[i].duration) { idx = i; break; }
    }
    return idx;
  },

  load(book, startPos) {
    if (this.book?.id === book.id) return;
    this.stop(false);
    this.book = book;
    this.notes = book.notes || [];
    this._prevTick = null;
    this._played = false;
    this.position = clamp(startPos || 0, 0, Math.max(0, book.duration - 1));
    this.trackIdx = this.trackForPos(this.position);
    this.setTrack(this.trackIdx, this.position - book.tracks[this.trackIdx].start, false);
    this.updateMediaSession();
  },

  setTrack(idx, offset, thenPlay) {
    const track = this.book.tracks[idx];
    this.trackIdx = idx;
    if (this.blobUrl) { URL.revokeObjectURL(this.blobUrl); this.blobUrl = null; }
    setPlayerMessage('');
    audio.src = rel(`media/${this.book.id}/${idx}`);
    audio.playbackRate = this.speed;
    if (offset > 1) {
      const onMeta = () => {
        audio.currentTime = clamp(offset, 0, track.duration || offset);
        if (thenPlay) audio.play().catch(() => {});
      };
      audio.addEventListener('loadedmetadata', onMeta, { once: true });
      audio.load();
    } else {
      // Track starts from the top (file-to-file transition): play in the
      // SAME event stack as the caller. Waiting for metadata first means an
      // async play() that Android blocks when the screen is off — the cause
      // of "audio stops between chapters with the phone locked".
      audio.load();
      if (thenPlay) audio.play().catch(() => {});
    }
  },

  // Some webviews (notably the HA companion apps) fetch <audio> media without
  // the session cookies the page has, so the stream 401s at the ingress
  // layer. fetch() does carry the session — download the part and play it
  // from memory instead.
  async onMediaError(err) {
    if (!this.book) return;
    const key = `${this.book.id}/${this.trackIdx}`;
    if (this.blobTriedFor === key) {
      setPlayerMessage(`Could not play this file (${err || 'media error'}).`);
      return;
    }
    this.blobTriedFor = key;
    const wasPlayingIntent = true; // user just tried to play; resume after fallback
    const offset = this.position - this.book.tracks[this.trackIdx].start;
    setPlayerMessage('Direct stream blocked — loading this part instead…');
    try {
      const res = await fetch(rel(`media/${this.book.id}/${this.trackIdx}`));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = URL.createObjectURL(blob);
      audio.src = this.blobUrl;
      const onMeta = () => {
        audio.currentTime = Math.max(0, offset);
        if (wasPlayingIntent) audio.play().catch(() => {});
      };
      audio.addEventListener('loadedmetadata', onMeta, { once: true });
      audio.load();
      setPlayerMessage('');
    } catch (e) {
      setPlayerMessage(`Playback failed: ${e.message}`);
    }
  },

  seek(globalSec, thenPlay = this.playing) {
    if (!this.book) return;
    // Scrubbing away while a note is playing dismisses the note.
    if (notePlayer.playing) { notePlayer.stopAll(); setPlayerMessage(''); }
    globalSec = clamp(globalSec, 0, this.book.duration > 0 ? this.book.duration - 0.5 : Infinity);
    const idx = this.trackForPos(globalSec);
    const offset = globalSec - this.book.tracks[idx].start;
    this.position = globalSec;
    if (thenPlay) this.intendedPlaying = true;
    if (idx === this.trackIdx && audio.readyState >= 1) {
      audio.currentTime = offset;
      if (thenPlay) audio.play().catch(() => {});
    } else {
      this.setTrack(idx, offset, thenPlay);
    }
    this.saveProgress(true);
    updatePlayerUI();
  },

  toggle() {
    if (!this.book) return;
    if (this.playing) {
      this.intendedPlaying = false;
      audio.pause();
    } else {
      this.intendedPlaying = true;
      audio.play().catch(err => console.warn('play failed', err));
    }
  },

  skip(delta) { this.seek(this.position + delta, this.playing); },

  setSpeed(speed) {
    this.speed = speed;
    audio.playbackRate = speed;
    localStorage.setItem('jambo_speed', String(speed));
  },

  cycleSleep() {
    this.sleepChoice = (this.sleepChoice + 1) % SLEEP_CHOICES.length;
    const mins = SLEEP_CHOICES[this.sleepChoice];
    this.sleepDeadline = mins ? Date.now() + mins * 60e3 : null;
  },

  stop(save = true) {
    if (save && this.book) this.saveProgress(true);
    audio.pause();
    audio.removeAttribute('src');
    if (this.blobUrl) { URL.revokeObjectURL(this.blobUrl); this.blobUrl = null; }
    this.blobTriedFor = null;
    this.book = null;
    this.notes = [];
    this._prevTick = null;
    this._preloaded = null;
    this.intendedPlaying = false;
    this.sleepDeadline = null;
    this.sleepChoice = 0;
    notePlayer.stopAll();
    setMediaPlaybackState('none');
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  },

  onTick() {
    if (!this.book) return;
    const track = this.book.tracks[this.trackIdx];
    const prev = this._prevTick ?? this.position;
    if (audio.readyState >= 1 && !audio.seeking) {
      this.position = track.start + audio.currentTime;
    }
    // Notes fire when natural playback sweeps past them (not seeks).
    const advanced = this.position - prev;
    if (this.playing && advanced > 0 && advanced < 3) {
      for (const n of this.notes) {
        if (notePlayer.shouldAutoplay(n) && n.position > prev && n.position <= this.position) {
          notePlayer.trigger(n);
        }
      }
    }
    this._prevTick = this.position;
    if (this.sleepDeadline && Date.now() >= this.sleepDeadline) {
      this.intendedPlaying = false;
      audio.pause();
      this.sleepDeadline = null;
      this.sleepChoice = 0;
      updatePlayerUI();
    }
    // Warm the browser cache with the next file near the end of this one, so
    // the chapter transition needs no fresh network while the screen is off.
    const nextTrack = this.book.tracks[this.trackIdx + 1];
    if (nextTrack && this.playing) {
      const remaining = track.start + track.duration - this.position;
      const nextUrl = rel(`media/${this.book.id}/${nextTrack.idx}`);
      if (remaining > 0 && remaining < 90 && this._preloaded !== nextUrl) {
        this._preloaded = nextUrl;
        preloadAudio.src = nextUrl;
        preloadAudio.load();
      }
    }
    this.throttledSave();
    this.updatePositionState();
  },

  onEnded() {
    if (!this.book) return;
    if (this.trackIdx < this.book.tracks.length - 1) {
      this.setTrack(this.trackIdx + 1, 0, true);
      updatePlayerUI();
    } else {
      this.position = this.book.duration;
      this.intendedPlaying = false;
      this.saveProgress(true, true);
      updatePlayerUI();
    }
  },

  throttledSave() {
    if (this.saveTimer || !this.playing) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; }, 5000);
    this.saveProgress();
  },

  saveProgress(force = false, finished = false) {
    if (!this.book || !state.me) return;
    // Merely opening a book isn't progress — don't save until play is pressed.
    if (!this._played && this.position <= 0.5) return;
    if (!force && this.lastSavedPos === this.position) return;
    this.lastSavedPos = this.position;
    api('/api/progress', {
      method: 'PUT',
      body: { bookId: this.book.id, position: this.position, finished },
    }).catch(() => {});
  },

  beaconSave() {
    if (!this.book || !state.me) return;
    if (!this._played && this.position <= 0.5) return;
    const payload = JSON.stringify({ bookId: this.book.id, position: this.position });
    navigator.sendBeacon(rel('api/progress'), new Blob([payload], { type: 'application/json' }));
  },

  updateMediaSession() {
    if (!('mediaSession' in navigator) || !this.book) return;
    const ms = navigator.mediaSession;
    ms.metadata = new MediaMetadata({
      title: this.book.title,
      artist: this.book.author || 'Audiobook',
      album: 'Jambo',
      artwork: this.book.hasCover
        ? [{ src: new URL(rel('covers/' + this.book.id), location.origin).href, sizes: '512x512' }]
        : [],
    });
    ms.setActionHandler('play', () => this.toggle());
    ms.setActionHandler('pause', () => this.toggle());
    // Lock-screen button layouts differ per OS. Android reliably shows
    // prev/next track buttons but often hides seek actions, so prev/next
    // double as ±30s skips. On Apple platforms registering seekforward/
    // backward hides prev/next entirely (Music Assistant's finding), so
    // there we register ONLY prev/next-as-skips to get two visible buttons.
    const apple = /iPhone|iPad|iPod|Mac/i.test(navigator.userAgent);
    ms.setActionHandler('previoustrack', () => this.skip(-30));
    ms.setActionHandler('nexttrack', () => this.skip(30));
    if (!apple) {
      ms.setActionHandler('seekbackward', (e) => this.skip(-(e?.seekOffset || 30)));
      ms.setActionHandler('seekforward', (e) => this.skip(e?.seekOffset || 30));
    }
    try {
      ms.setActionHandler('seekto', (e) => { if (e.seekTime != null) this.seek(e.seekTime); });
    } catch { /* not supported */ }
  },

  updatePositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState || !this.book) return;
    if (!(this.book.duration > 0)) return; // a bogus position state can break the OS notification
    try {
      navigator.mediaSession.setPositionState({
        duration: this.book.duration,
        position: clamp(this.position, 0, this.book.duration),
        playbackRate: this.speed,
      });
    } catch { /* ignore */ }
  },
};

function setPlayerMessage(msg) {
  if (playerUI?.messageLine) playerUI.messageLine.textContent = msg;
  if (msg) console.warn('[player]', msg);
}

// Keeping playbackState in sync makes the OS media notification show and
// update reliably (same approach Music Assistant uses in the HA apps).
function setMediaPlaybackState(s) {
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.playbackState = s; } catch { /* ignore */ }
  }
}

audio.addEventListener('timeupdate', () => { player.onTick(); updatePlayerUI(); });
audio.addEventListener('ended', () => player.onEnded());
audio.addEventListener('error', () => {
  const codes = { 1: 'aborted', 2: 'network error', 3: 'decode error', 4: 'source not supported' };
  player.onMediaError(codes[audio.error?.code] || 'media error');
});
audio.addEventListener('play', () => { player._played = true; setMediaPlaybackState('playing'); updatePlayerUI(); });
audio.addEventListener('pause', () => { setMediaPlaybackState('paused'); player.saveProgress(true); updatePlayerUI(); });

// Warms the HTTP cache for upcoming chapter files; never actually played.
const preloadAudio = new Audio();
preloadAudio.preload = 'auto';
preloadAudio.muted = true;

window.addEventListener('pagehide', () => player.beaconSave());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    player.beaconSave();
  } else if (player.book && player.intendedPlaying && audio.paused && !notePlayer.playing) {
    // The OS paused us while the screen was off (the user never pressed
    // pause) — pick the book back up the moment the screen returns.
    audio.play().catch(() => {});
  }
});

// ---------- voice notes ----------

// Records mic audio via Web Audio and encodes 16-bit mono WAV client-side, so
// notes recorded on Android play on iPhone and vice versa (MediaRecorder's
// native formats don't cross over).
const recorder = {
  ctx: null, stream: null, proc: null, chunks: [], startedAt: 0, active: false,

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    const mute = this.ctx.createGain();
    mute.gain.value = 0; // processor must be connected to run; keep it silent
    this.chunks = [];
    this.startedAt = Date.now();
    this.active = true;
    this.proc.onaudioprocess = (e) => {
      if (this.active) this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    src.connect(this.proc);
    this.proc.connect(mute);
    mute.connect(this.ctx.destination);
  },

  stop() {
    this.active = false;
    const sampleRate = this.ctx?.sampleRate || 48000;
    const chunks = this.chunks;
    this.proc?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    this.ctx?.close().catch(() => {});
    this.ctx = this.stream = this.proc = null;
    this.chunks = [];

    const total = chunks.reduce((s, c) => s + c.length, 0);
    const seconds = total / sampleRate;
    if (seconds < 0.7) return null;

    const data = Buffer_writeWav(chunks, total, sampleRate);
    return { blob: new Blob([data], { type: 'audio/wav' }), seconds };
  },
};

function Buffer_writeWav(chunks, totalSamples, sampleRate) {
  const buf = new ArrayBuffer(44 + totalSamples * 2);
  const view = new DataView(buf);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + totalSamples * 2, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, totalSamples * 2, true);
  let off = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      view.setInt16(off, Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767))), true);
      off += 2;
    }
  }
  return buf;
}

// Plays partner notes when the playhead crosses them (toggleable).
const noteAudio = new Audio();
const notePlayer = {
  queue: [],
  playing: null,
  resumeAfter: false,

  // 'partner' = only their notes auto-play (default), 'all' = yours too, 'off' = none.
  mode: localStorage.getItem('jambo_notes_mode')
    || (localStorage.getItem('jambo_notes_autoplay') === '0' ? 'off' : 'partner'),
  cycleMode() {
    const order = ['partner', 'all', 'off'];
    this.mode = order[(order.indexOf(this.mode) + 1) % order.length];
    localStorage.setItem('jambo_notes_mode', this.mode);
  },
  shouldAutoplay(note) {
    if (this.mode === 'off') return false;
    if (this.mode === 'partner' && note.userId === state.me?.id) return false;
    return true;
  },

  trigger(note) {
    if (this.playing?.id === note.id || this.queue.some(n => n.id === note.id)) return;
    this.queue.push(note);
    if (!this.playing) this.next();
  },

  next() {
    const note = this.queue.shift();
    if (!note) {
      this.playing = null;
      if (this.resumeAfter && player.book) audio.play().catch(() => {});
      this.resumeAfter = false;
      setPlayerMessage('');
      updatePlayerUI();
      return;
    }
    this.playing = note;
    if (player.playing) { this.resumeAfter = true; audio.pause(); }
    setPlayerMessage(`🎙 Note from ${note.user?.name || 'your partner'}`);
    noteAudio.src = rel(`api/notes/${note.id}/audio`);
    noteAudio.play().catch(() => this.next());
  },

  stopAll() {
    this.queue = [];
    this.playing = null;
    this.resumeAfter = false;
    noteAudio.pause();
    noteAudio.removeAttribute('src');
  },
};
noteAudio.addEventListener('ended', () => notePlayer.next());
noteAudio.addEventListener('error', () => notePlayer.next());

// ---------- routing ----------

let partnerPollTimer = null;
let libraryPollTimer = null;

// Hierarchical navigation: going deeper (home → library → book) pushes one
// history entry per level; in-app back arrows pop it. The phone's back button
// therefore walks UP the screens and then exits to Home Assistant, instead of
// replaying every screen ever visited. Sideways moves (e.g. upload → library
// after a finished upload) replace the current entry.
let navDepth = 0;
let expectedNav = null; // { hash, push }

function navigate(hash, replace = false) {
  if (location.hash === hash) { render(); return; }
  expectedNav = { hash, push: !replace };
  if (replace) location.replace(hash || '#');
  else location.hash = hash;
}

// Up one level: pop real history if we pushed it; otherwise (deep link,
// fresh load) swap in the fallback screen without growing history.
function navigateUp(fallback = '') {
  if (navDepth > 0) history.back();
  else navigate(fallback, true);
}

window.addEventListener('hashchange', () => {
  if (expectedNav && location.hash === expectedNav.hash) {
    if (expectedNav.push) navDepth++;
  } else {
    navDepth = Math.max(0, navDepth - 1); // browser/phone back (or forward)
  }
  expectedNav = null;
  render();
});

async function boot() {
  try {
    const s = await api('/api/state');
    Object.assign(state, s);
  } catch {
    $app.replaceChildren(el('div', { class: 'screen auth' },
      el('p', { class: 'error-msg' }, 'Could not reach the server. Is it running?')));
    return;
  }
  render();
  // PWA shell only makes sense when served standalone, not inside HA ingress.
  if ('serviceWorker' in navigator && location.pathname === '/') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

function render() {
  clearInterval(partnerPollTimer);
  clearInterval(libraryPollTimer);
  if (state.setupNeeded) return renderSetup();
  if (!state.me) return renderLogin();
  const m = location.hash.match(/^#\/book\/(.+)$/);
  if (m) return renderPlayer(decodeURIComponent(m[1]));
  if (location.hash === '#/upload') return renderUpload();
  if (location.hash === '#/library') return renderLibrary();
  renderHome();
}

// ---------- setup screen ----------

function renderSetup() {
  const palette = ['#e0918b', '#8bb8e0', '#9fd0a5', '#e0c98b', '#c39be0', '#e08bc3'];
  const profiles = [
    { name: '', pin: '', color: palette[0] },
    { name: '', pin: '', color: palette[1] },
  ];

  const err = el('p', { class: 'error-msg' });

  const card = (i, title) => {
    const swatches = el('div', { class: 'swatches' },
      palette.map(c => el('button', {
        class: `swatch${profiles[i].color === c ? ' selected' : ''}`,
        style: { background: c },
        onclick: (e) => {
          profiles[i].color = c;
          e.currentTarget.parentElement.querySelectorAll('.swatch')
            .forEach(s => s.classList.toggle('selected', s === e.currentTarget));
        },
      })));
    return el('div', { class: 'setup-card' },
      el('h3', {}, title),
      el('div', { class: 'field' },
        el('label', {}, 'Name'),
        el('input', { placeholder: 'e.g. Kiki', maxlength: '30', oninput: e => profiles[i].name = e.target.value })),
      el('div', { class: 'field' },
        el('label', {}, 'PIN (4–8 digits)'),
        el('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '8',
          oninput: e => profiles[i].pin = e.target.value })),
      el('div', { class: 'field' }, el('label', {}, 'Colour'), swatches),
    );
  };

  const submit = async () => {
    err.textContent = '';
    for (const p of profiles) {
      if (!p.name.trim()) { err.textContent = 'Both profiles need a name.'; return; }
      if (!/^\d{4,8}$/.test(p.pin)) { err.textContent = 'PINs must be 4–8 digits.'; return; }
    }
    try {
      const res = await api('/api/setup', { method: 'POST', body: { profiles } });
      state.setupNeeded = false;
      state.users = res.users;
      render();
    } catch (e) {
      err.textContent = 'Setup failed: ' + e.message;
    }
  };

  $app.replaceChildren(el('div', { class: 'screen auth fade-in' },
    el('div', { class: 'logo' }, 'Jambo', el('span', { class: 'dot' }, '.')),
    el('p', { class: 'tagline' }, 'Set up your two listener profiles'),
    card(0, 'Profile 1'),
    card(1, 'Profile 2'),
    el('button', { class: 'btn-primary', onclick: submit }, 'Create profiles'),
    err,
  ));
}

// ---------- login screens ----------

function renderLogin() {
  $app.replaceChildren(el('div', { class: 'screen auth fade-in' },
    el('div', { class: 'logo' }, 'Jambo', el('span', { class: 'dot' }, '.')),
    el('p', { class: 'tagline' }, "Who's listening?"),
    el('div', { class: 'profile-row' },
      state.users.map(u =>
        el('button', { class: 'profile-card', onclick: () => renderPinPad(u) },
          avatarEl(u), el('span', {}, u.name)))),
    state.haUser ? el('p', { class: 'tagline', style: { marginTop: '26px', fontSize: '13px' } },
      `You're ${state.haUser.displayName || 'signed in'} on Home Assistant, but both profiles are taken — pick yours and enter its PIN once to claim it.`) : null,
  ));
}

function renderPinPad(user) {
  let pin = '';
  const dots = el('div', { class: 'pin-dots' });
  const err = el('p', { class: 'error-msg' });

  const redraw = () => {
    dots.replaceChildren(...Array.from({ length: Math.max(4, pin.length) },
      (_, i) => el('div', { class: `pin-dot${i < pin.length ? ' filled' : ''}` })));
  };
  redraw();

  const submit = async () => {
    try {
      const res = await api('/api/login', { method: 'POST', body: { userId: user.id, pin } });
      state.me = res.me;
      navigate('');
    } catch (e) {
      pin = '';
      redraw();
      err.textContent = e.message === 'too_many_attempts'
        ? `Too many tries — wait ${e.data?.retryInMinutes ?? 15} min.`
        : 'Wrong PIN, try again.';
    }
  };

  const press = (d) => {
    err.textContent = '';
    if (pin.length >= 8) return;
    pin += d;
    redraw();
  };

  const keys = ['1','2','3','4','5','6','7','8','9','back','0','go'];
  $app.replaceChildren(el('div', { class: 'screen auth fade-in' },
    avatarEl(user),
    el('p', { style: { marginTop: '10px', fontSize: '18px' } }, `Hi ${user.name}`),
    el('p', { class: 'tagline', style: { marginBottom: '0' } }, 'Enter your PIN'),
    dots,
    el('div', { class: 'pin-pad' },
      keys.map(k => {
        if (k === 'back') return el('button', { class: 'pin-key ghost', onclick: () => { pin = pin.slice(0, -1); redraw(); } }, '⌫');
        if (k === 'go') return el('button', { class: 'pin-key ghost', onclick: submit }, 'Go');
        return el('button', { class: 'pin-key', onclick: () => press(k) }, k);
      })),
    err,
    el('button', { style: { color: 'var(--text-faint)', marginTop: '18px' }, onclick: renderLogin }, '← switch profile'),
  ));
}

// ---------- library ----------

function libHeader(onRefresh, backTo) {
  const header = el('div', { class: 'lib-header' },
    backTo != null
      ? el('button', { class: 'icon-btn', html: ICONS.backArrow, onclick: () => navigateUp(backTo) })
      : el('div', { class: 'logo' }, 'Jambo', el('span', { class: 'dot' }, '.')),
    el('div', { class: 'header-actions' },
      el('button', { class: 'icon-btn', title: 'Add a book', html: ICONS.upload,
        onclick: () => navigate('#/upload') }),
      el('button', { class: 'icon-btn', title: 'Rescan library', html: ICONS.refresh,
        onclick: async (e) => {
          e.currentTarget.style.opacity = '0.4';
          await api('/api/rescan', { method: 'POST' }).catch(() => {});
          onRefresh();
        } }),
      state.haUser ? null : el('button', { class: 'icon-btn', title: 'Log out', html: ICONS.logout,
        onclick: async () => {
          player.stop();
          await api('/api/logout', { method: 'POST' }).catch(() => {});
          state.me = null;
          navigate('');
        } }),
      state.me ? avatarEl(state.me, true) : null,
    ));
  return header;
}

// ---------- home: On Deck + link to the library ----------

async function renderHome() {
  clearInterval(libraryPollTimer);
  const screen = el('div', { class: 'screen fade-in' + (player.book ? ' has-mini' : '') },
    libHeader(renderHome),
    el('div', { class: 'spinner' }),
  );
  $app.replaceChildren(screen);

  let data;
  try {
    data = await api('/api/books');
  } catch { return; }
  state.booksCache = data.books;
  const byId = new Map(data.books.map(b => [b.id, b]));

  const deckCard = (entry) => {
    const book = byId.get(entry.bookId);
    if (!book) return null;
    const who = entry.user.id === state.me?.id ? 'You' : entry.user.name;
    const line = entry.finished ? `${who} finished it`
      : entry.session?.seconds >= 30 ? `${who} listened ${fmtLong(entry.session.seconds)}`
      : `${who} at ${fmtLong(entry.position)}`;
    const card = el('div', { class: 'deck-card' },
      coverEl(book, 'cover'),
      el('div', { class: 'book-title' }, book.title),
      el('div', { class: 'deck-line', style: { color: entry.user.color } }, line),
      el('div', { class: 'deck-ago' }, fmtAgo(entry.updatedAt)));
    card.addEventListener('click', () => navigate(`#/book/${encodeURIComponent(book.id)}`));
    card.append(el('button', { class: 'deck-x', title: 'Remove from On Deck', onclick: async (e) => {
      e.stopPropagation();
      await api('/api/ondeck/hide', { method: 'POST', body: { bookId: book.id } }).catch(() => {});
      renderHome();
    } }, '✕'));
    return card;
  };

  const banners = [];
  if (data.storageWarning) banners.push(el('div', { class: 'warn-banner' }, '⚠️ ', data.storageWarning));
  if (data.missingBooks?.length) {
    banners.push(el('div', { class: 'warn-banner' },
      `⚠️ ${data.missingBooks.length} book${data.missingBooks.length > 1 ? 's are' : ' is'} missing from storage (${data.missingBooks.join(', ')}). Positions are safe — check the books folder and rescan.`));
  }

  const deck = data.onDeck?.map(deckCard).filter(Boolean) || [];
  screen.querySelector('.spinner').replaceWith(el('div', {},
    ...banners,
    deck.length ? el('h2', { class: 'folder-header serif' }, 'On Deck') : null,
    deck.length ? el('div', { class: 'deck-row' }, deck) : null,
    el('button', { class: 'library-link', onclick: () => navigate('#/library') },
      el('span', { class: 'serif', style: { fontSize: '19px' } }, '📚 Library'),
      el('span', { class: 'library-count' }, `${data.books.length} book${data.books.length === 1 ? '' : 's'} ›`)),
    deck.length === 0 ? el('p', { class: 'tagline', style: { textAlign: 'center', marginTop: '18px', fontSize: '13.5px' } },
      'Books you two listen to will appear here.') : null,
  ));

  if (player.book) screen.append(miniPlayerEl());

  libraryPollTimer = setInterval(async () => {
    if (location.hash === '' || location.hash === '#/' || location.hash === '#') {
      renderHome();
    }
  }, 60000);
}

async function renderLibrary() {
  const screen = el('div', { class: 'screen fade-in' + (player.book ? ' has-mini' : '') },
    libHeader(renderLibrary, ''),
    el('div', { class: 'spinner' }),
  );
  $app.replaceChildren(screen);

  let data;
  try {
    data = await api('/api/books');
  } catch { return; }
  state.booksCache = data.books;

  const spinner = screen.querySelector('.spinner');
  if (!spinner) return;

  const banners = [];
  if (data.storageWarning) {
    banners.push(el('div', { class: 'warn-banner' },
      '⚠️ ', data.storageWarning));
  }
  if (data.missingBooks?.length) {
    banners.push(el('div', { class: 'warn-banner' },
      `⚠️ ${data.missingBooks.length} book${data.missingBooks.length > 1 ? 's' : ''} with saved progress ${data.missingBooks.length > 1 ? 'are' : 'is'} missing from storage (${data.missingBooks.join(', ')}). ` +
      'Your listening positions are safe — check the USB drive / books folder and tap rescan.'));
  }

  if (data.books.length === 0) {
    spinner.replaceWith(el('div', {}, ...banners, el('div', { class: 'empty-lib' },
      el('p', { style: { fontSize: '40px', marginBottom: '10px' } }, '📚'),
      el('p', {}, 'No books yet.'),
      el('p', { style: { marginTop: '10px', fontSize: '14px' } },
        'Drop each audiobook into its own folder inside ', el('code', {}, 'books/'),
        ' (with a cover.jpg if you have one), then tap rescan.'),
    )));
  } else {
    const sections = el('div', { class: 'lib-sections' });
    const searchBox = el('input', { class: 'lib-search', placeholder: '🔍 Search title, author, genre…' });
    const sortSel = el('select', { class: 'lib-sort' },
      [['title', 'Title'], ['author', 'Author'], ['newest', 'Newest'], ['longest', 'Longest']].map(([v, label]) =>
        el('option', { value: v }, label)));
    sortSel.value = localStorage.getItem('jambo_sort') || 'title';
    const refresh = () => {
      localStorage.setItem('jambo_sort', sortSel.value);
      sections.replaceChildren(...librarySections(data.books, searchBox.value, sortSel.value));
    };
    searchBox.addEventListener('input', refresh);
    sortSel.addEventListener('change', refresh);
    refresh();
    spinner.replaceWith(el('div', {}, ...banners,
      el('div', { class: 'lib-toolbar' }, searchBox, sortSel),
      sections));
  }

  if (player.book) screen.append(miniPlayerEl());

  libraryPollTimer = setInterval(async () => {
    if (!location.hash.match(/^#\/book\//)) renderLibraryQuietly(screen);
  }, 30000);
}

async function renderLibraryQuietly(screen) {
  try {
    const data = await api('/api/books');
    state.booksCache = data.books;
    const container = screen.querySelector('.lib-sections');
    if (container) container.replaceChildren(...librarySections(data.books));
  } catch { /* ignore */ }
}

// Books grouped by their collection folder; ungrouped books first. A search
// query flattens the groups into one filtered grid.
const SORTERS = {
  title: (a, b) => a.title.localeCompare(b.title),
  author: (a, b) => (a.author || '~').localeCompare(b.author || '~') || a.title.localeCompare(b.title),
  newest: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
  longest: (a, b) => (b.duration || 0) - (a.duration || 0),
};

function librarySections(books, query = '', sort = 'title') {
  const sorter = SORTERS[sort] || SORTERS.title;
  const q = query.trim().toLowerCase();
  if (q) {
    const hits = books.filter(b =>
      b.title.toLowerCase().includes(q)
      || (b.author || '').toLowerCase().includes(q)
      || (b.folder || '').toLowerCase().includes(q)
      || (b.genres || []).some(g => g.toLowerCase().includes(q))).sort(sorter);
    return [hits.length
      ? el('div', { class: 'book-grid' }, hits.map(bookCard))
      : el('p', { class: 'empty-lib', style: { marginTop: '40px' } }, 'No matches.')];
  }
  const groups = new Map();
  for (const b of books) {
    const key = b.folder || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  const keys = [...groups.keys()].sort((a, b) => (b === '') - (a === '') || a.localeCompare(b));
  return keys.map(key => el('div', {},
    key ? el('h2', { class: 'folder-header serif' }, '📁 ', key) : null,
    el('div', { class: 'book-grid' }, groups.get(key).sort(sorter).map(bookCard))));
}

function bookCard(book) {
  const cover = coverEl(book, 'cover');
  const partner = book.partner;
  if (partner && isLive(partner.progress)) {
    cover.append(el('div', { class: 'live-badge' },
      el('div', { class: 'live-pulse', style: { background: partner.user.color } }),
      `${partner.user.name} is listening`));
  }

  const barRow = (who, color, progress) => {
    const pct = book.duration > 0 && progress ? clamp(progress.position / book.duration, 0, 1) : 0;
    // Unknown total length: show elapsed time rather than a misleading 0%.
    const label = progress?.finished ? '✓'
      : book.duration > 0 ? `${Math.round(pct * 100)}%`
      : progress?.position > 0 ? fmtLong(progress.position) : '—';
    return el('div', { class: 'mini-bar-row' },
      el('span', { class: 'who', style: { color } }, who),
      el('div', { class: 'mini-bar' },
        el('div', { style: { width: `${pct * 100}%`, background: color } })),
      el('span', { class: 'pct' }, label));
  };

  return el('button', { class: 'book-card', onclick: () => navigate(`#/book/${encodeURIComponent(book.id)}`) },
    cover,
    el('div', { class: 'book-title' }, book.title),
    book.author ? el('div', { class: 'book-author' }, book.author) : null,
    book.genres?.length ? el('div', { class: 'book-genre' }, book.genres.slice(0, 2).join(' · ')) : null,
    el('div', { class: 'mini-bars' },
      barRow(state.me.name.charAt(0).toUpperCase(), state.me.color, book.me),
      partner ? barRow(partner.user.name.charAt(0).toUpperCase(), partner.user.color, partner.progress) : null),
  );
}

function miniPlayerEl() {
  const book = player.book;
  const btn = el('button', { class: 'icon-btn', html: player.playing ? ICONS.pause : ICONS.play,
    onclick: (e) => { e.stopPropagation(); player.toggle(); btn.innerHTML = player.playing ? ICONS.pause : ICONS.play; } });
  const sub = el('div', { class: 'mini-sub' });
  const bar = el('div', { class: 'mini-player', onclick: () => navigate(`#/book/${encodeURIComponent(book.id)}`) },
    coverEl(book, 'mini-cover'),
    el('div', { class: 'mini-info' },
      el('div', { class: 'mini-title' }, book.title),
      sub),
    btn,
  );
  bar.update = () => {
    sub.textContent = `${fmtClock(player.position)} / ${fmtClock(book.duration)}`;
    btn.innerHTML = player.playing ? ICONS.pause : ICONS.play;
  };
  bar.update();
  return bar;
}

// ---------- upload screen ----------

function renderUpload() {
  let files = [];
  let uploading = false;

  const author = el('input', { placeholder: 'e.g. Ursula K. Le Guin (optional)' });
  const title = el('input', { placeholder: 'e.g. A Wizard of Earthsea' });

  // Look up the book online and autofill author/title.
  const lookupInput = el('input', { placeholder: 'e.g. wizard of earthsea' });
  const lookupResults = el('div', { class: 'lookup-results' });
  let lookupTimer = null;
  lookupInput.addEventListener('input', () => {
    clearTimeout(lookupTimer);
    const q = lookupInput.value.trim();
    if (q.length < 3) { lookupResults.replaceChildren(); return; }
    lookupTimer = setTimeout(async () => {
      lookupResults.replaceChildren(el('div', { class: 'lookup-hint' }, 'Searching…'));
      try {
        const { results } = await api(`/api/booksearch?q=${encodeURIComponent(q)}`);
        if (lookupInput.value.trim() !== q) return; // stale response
        lookupResults.replaceChildren(...(results.length ? results.map(r =>
          el('button', { class: 'lookup-row', onclick: () => {
            title.value = r.title;
            author.value = r.author;
            lookupResults.replaceChildren();
            lookupInput.value = '';
          } },
            el('span', {}, r.title),
            el('span', { class: 'dur' }, [r.author, r.year].filter(Boolean).join(' · '))))
          : [el('div', { class: 'lookup-hint' }, 'Nothing found — fill the fields in manually.')]));
      } catch {
        lookupResults.replaceChildren(el('div', { class: 'lookup-hint' }, 'Search unavailable — fill the fields in manually.'));
      }
    }, 500);
  });
  const existingFolders = [...new Set((state.booksCache || []).map(b => b.folder).filter(Boolean))].sort();
  const folderField = el('input', { placeholder: 'e.g. Fantasy (optional)', list: 'jambo-folders' });
  const folderDatalist = el('datalist', { id: 'jambo-folders' },
    existingFolders.map(f => el('option', { value: f })));
  // No accept filter: Android's picker refuses files with unknown MIME types
  // (like .cue) when one is set. The server validates extensions instead.
  const fileInput = el('input', { type: 'file', multiple: '' });
  const fileList = el('div', { class: 'upload-list' });
  const status = el('p', { class: 'error-msg', style: { textAlign: 'center' } });
  const progressFill = el('div', { style: { width: '0%', background: 'var(--accent)' } });
  const progressText = el('div', { style: { textAlign: 'center', fontSize: '12.5px', color: 'var(--text-dim)', marginTop: '6px' } });
  const progressBar = el('div', { style: { display: 'none', marginTop: '10px' } },
    el('div', { class: 'mini-bar', style: { height: '8px' } }, progressFill),
    progressText);
  const submitBtn = el('button', { class: 'btn-primary', style: { marginTop: '14px' } }, 'Upload book');

  // Each pick ADDS to the list (some in-app file pickers only allow choosing
  // one file at a time, so books can be assembled over several picks).
  const renderFileList = () => {
    fileList.replaceChildren(...files.map((f, i) =>
      el('div', { class: 'upload-file' },
        el('span', { class: 'upload-file-name' }, f.name),
        el('span', { class: 'dur' }, `${(f.size / 1e6).toFixed(1)} MB`),
        el('button', { class: 'upload-remove', title: 'Remove', onclick: () => {
          if (uploading) return;
          files.splice(i, 1);
          renderFileList();
        } }, '✕'))));
  };
  const UPLOAD_OK = /\.(mp3|wav|m4a|m4b|aac|ogg|opus|flac|jpe?g|png|webp|gif|cue)$/i;
  fileInput.addEventListener('change', () => {
    status.textContent = '';
    for (const f of fileInput.files) {
      if (!UPLOAD_OK.test(f.name)) { status.textContent = `Skipped ${f.name} — not an audio, image, or cue file.`; continue; }
      if (!files.some(x => x.name === f.name && x.size === f.size)) files.push(f);
    }
    fileInput.value = ''; // so picking again (even the same file) re-fires change
    renderFileList();
  });

  // Chunked + resumable. XHR (not fetch) for real upload progress events.
  // Each 6MB piece retries with backoff; a 409 from the server tells us how
  // much it already has, so interrupted uploads resume instead of restarting.
  const CHUNK_BYTES = 6 * 1024 * 1024;
  const sendChunk = (url, blob, onProgress) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.timeout = 120000;
    xhr.upload.addEventListener('progress', (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); });
    xhr.addEventListener('load', () => {
      const data = (() => { try { return JSON.parse(xhr.responseText); } catch { return {}; } })();
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(Object.assign(new Error(data.error || `HTTP ${xhr.status}`), { status: xhr.status, have: data.have }));
    });
    xhr.addEventListener('error', () => reject(new Error('network error')));
    xhr.addEventListener('timeout', () => reject(new Error('timed out')));
    xhr.send(blob);
  });

  const uploadOne = async (file, folder, collection, onProgress) => {
    let offset = 0;
    let retries = 0;
    while (offset < file.size || file.size === 0) {
      const chunk = file.slice(offset, offset + CHUNK_BYTES);
      const isLast = offset + chunk.size >= file.size;
      const url = rel(`api/upload?book=${encodeURIComponent(folder)}&filename=${encodeURIComponent(file.name)}`
        + (collection ? `&folder=${encodeURIComponent(collection)}` : '')
        + `&offset=${offset}&last=${isLast ? 1 : 0}`);
      try {
        const r = await sendChunk(url, chunk, (frac) => onProgress((offset + frac * chunk.size) / (file.size || 1)));
        offset = r.have ?? offset + chunk.size;
        retries = 0;
        if (r.done) break;
      } catch (e) {
        if (e.status === 409 && Number.isInteger(e.have)) { offset = e.have; continue; }
        if (e.status && e.status !== 409 && e.status < 500) throw e; // 4xx: not retryable
        if (++retries > 6) throw e;
        status.textContent = `Connection hiccup (${e.message}) — retrying…`;
        await new Promise(r2 => setTimeout(r2, Math.min(15000, 1000 * 2 ** retries)));
      }
    }
  };

  submitBtn.addEventListener('click', async () => {
    if (uploading) return;
    status.textContent = '';
    const t = title.value.trim();
    if (!t) { status.textContent = 'Give the book a title.'; return; }
    if (files.length === 0) { status.textContent = 'Pick the audio files (and a cover if you have one).'; return; }
    const bookDir = (author.value.trim() ? `${author.value.trim()} - ${t}` : t).replace(/[/\\<>:"|?*]/g, '');
    const collection = folderField.value.trim().replace(/[/\\<>:"|?*.]/g, '');

    uploading = true;
    submitBtn.disabled = true;
    progressBar.style.display = '';
    const totalBytes = files.reduce((s, f) => s + f.size, 0);
    let doneBytes = 0;
    try {
      for (const [i, file] of files.entries()) {
        status.textContent = '';
        submitBtn.textContent = `Uploading ${file.name}…`;
        await uploadOne(file, bookDir, collection, (frac) => {
          const pct = ((doneBytes + frac * file.size) / totalBytes) * 100;
          progressFill.style.width = `${pct}%`;
          progressText.textContent = `${Math.round(pct)}% — file ${i + 1} of ${files.length}`;
        });
        doneBytes += file.size;
      }
      progressText.textContent = '100% — done';
      submitBtn.textContent = 'Scanning…';
      await api('/api/rescan', { method: 'POST' });
      navigate('#/library', true);
    } catch (e) {
      status.textContent = `Upload failed: ${e.message}`;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Retry upload';
      uploading = false;
    }
  });

  $app.replaceChildren(el('div', { class: 'screen fade-in' },
    el('div', { class: 'player-top' },
      el('button', { class: 'icon-btn', html: ICONS.backArrow, onclick: () => navigateUp('') }),
      state.me ? avatarEl(state.me, true) : null),
    el('div', { class: 'setup-card', style: { marginTop: '8px' } },
      el('h3', {}, 'Add a book'),
      el('div', { class: 'field' },
        el('label', {}, 'Look up the book — tap a match to autofill'),
        lookupInput, lookupResults),
      el('div', { class: 'field' }, el('label', {}, 'Author'), author),
      el('div', { class: 'field' }, el('label', {}, 'Title'), title),
      el('div', { class: 'field' }, el('label', {}, 'Folder — group books into a section on the home screen'), folderField, folderDatalist),
      el('div', { class: 'field' },
        el('label', {}, 'Files — the audio parts, plus a cover image and .cue chapter sheet if you have them. Tap again to add more.'),
        fileInput),
      fileList,
      progressBar,
      submitBtn,
      status),
    el('p', { class: 'tagline', style: { fontSize: '12.5px', textAlign: 'center' } },
      'Parts play in filename order — name them 01, 02, 03… Big books over slow connections can take a while; keep the app open until it finishes.'),
  ));
}

// Genres + synopsis under the player controls, collapsed by default.
function aboutSection(book) {
  if (!book.genres?.length && !book.description) {
    return el('div', { class: 'about-section', style: { textAlign: 'center' } },
      el('button', { class: 'about-more', onclick: async (e) => {
        e.currentTarget.textContent = 'Searching…';
        await api(`/api/books/${encodeURIComponent(book.id)}/enrich`, { method: 'POST' }).catch(() => {});
        renderPlayer(book.id);
      } }, '🔍 Find book info'));
  }
  const chips = (book.genres || []).map(g => el('span', { class: 'genre-chip' }, g));
  if (book.year) chips.push(el('span', { class: 'genre-chip' }, book.year));
  if (!book.description) return el('div', { class: 'about-section' }, el('div', { class: 'genre-chips' }, chips));
  const text = el('p', { class: 'about-text clamped' }, book.description);
  const moreBtn = el('button', { class: 'about-more', onclick: () => {
    const open = text.classList.toggle('clamped');
    moreBtn.textContent = open ? 'More' : 'Less';
  } }, 'More');
  return el('div', { class: 'about-section' },
    el('div', { class: 'genre-chips' }, chips),
    text, moreBtn);
}

// ---------- player screen ----------

let playerUI = null; // refs to live DOM bits, null when not on player screen

async function renderPlayer(bookId) {
  playerUI = null;
  let book;
  try {
    book = await api(`/api/books/${encodeURIComponent(bookId)}`);
  } catch {
    navigate('', true);
    return;
  }

  if (player.book?.id !== book.id) {
    // A finished book reopens from the start; otherwise resume where you left off.
    player.load(book, book.me?.finished ? 0 : book.me?.position || 0);
  } else {
    player.book.me = book.me;
    player.book.partner = book.partner;
    player.notes = book.notes || [];
    Object.assign(player.book, { tracks: book.tracks });
  }

  const partnerInfo = book.partner;

  // --- timeline ---
  const fill = el('div', { class: 'timeline-fill', style: { background: state.me.color } });
  const thumb = el('div', { class: 'timeline-thumb', style: { background: state.me.color } });
  const partnerMarker = partnerInfo
    ? el('div', { class: 'partner-marker', style: { display: 'none' } },
        avatarEl(partnerInfo.user, true),
        el('div', { class: 'stem', style: { background: partnerInfo.user.color } }))
    : null;
  const noteDots = el('div', { class: 'note-dots' });
  const timeline = el('div', { class: 'timeline' },
    el('div', { class: 'timeline-track' }, fill),
    noteDots, thumb, partnerMarker);

  const renderNoteDots = () => {
    if (!(book.duration > 0)) return;
    noteDots.replaceChildren(...player.notes.map(n => {
      const mine = n.userId === state.me?.id;
      return el('button', {
        class: 'note-dot',
        title: mine ? 'Your note (tap to play)' : `Note from ${n.user?.name || 'partner'} (tap to play)`,
        style: { left: `${clamp(n.position / book.duration, 0, 1) * 100}%`, background: n.user?.color || 'var(--accent)' },
        onpointerdown: (e) => e.stopPropagation(),
        onclick: (e) => { e.stopPropagation(); notePlayer.trigger(n); },
      });
    }));
  };
  const elapsed = el('span', {}, '0:00');
  const remaining = el('span', {}, '-0:00');

  let scrubPos = null;
  const posFromEvent = (e) => {
    const rect = timeline.getBoundingClientRect();
    return clamp((e.clientX - rect.left) / rect.width, 0, 1) * book.duration;
  };
  timeline.addEventListener('pointerdown', (e) => {
    if (!(book.duration > 0)) return; // no known length → a tap would seek to 0
    try { timeline.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    scrubPos = posFromEvent(e);
    updatePlayerUI();
  });
  timeline.addEventListener('pointermove', (e) => {
    if (scrubPos == null) return;
    scrubPos = posFromEvent(e);
    updatePlayerUI();
  });
  timeline.addEventListener('pointerup', (e) => {
    if (scrubPos == null) return;
    const target = posFromEvent(e);
    scrubPos = null;
    player.seek(target);
  });
  timeline.addEventListener('pointercancel', () => { scrubPos = null; });

  // --- controls ---
  const playBtn = el('button', { class: 'play-btn', html: player.playing ? ICONS.pause : ICONS.play,
    onclick: () => player.toggle() });
  const speedChip = el('button', { class: 'chip-btn', onclick: () => {
    const next = SPEEDS[(SPEEDS.indexOf(player.speed) + 1) % SPEEDS.length] || 1;
    player.setSpeed(next);
    updatePlayerUI();
  } });
  const sleepChip = el('button', { class: 'chip-btn', onclick: () => { player.cycleSleep(); updatePlayerUI(); } });
  const messageLine = el('p', { class: 'error-msg', style: { textAlign: 'center', fontSize: '13px' } });

  // --- voice notes: hold to record, toggle for auto-play ---
  const notesChip = el('button', { class: 'chip-btn', title: 'Which notes auto-play', onclick: () => {
    notePlayer.cycleMode();
    updatePlayerUI();
  } });

  const micChip = el('button', { class: 'chip-btn mic-chip' }, '🎙 Hold');
  micChip.addEventListener('contextmenu', (e) => e.preventDefault());
  let recTimer = null;
  let recWasPlaying = false;

  const stopRecording = async (cancelled) => {
    if (!recorder.active) return;
    clearInterval(recTimer);
    micChip.classList.remove('recording');
    micChip.textContent = '🎙 Hold';
    const result = recorder.stop();
    if (recWasPlaying) audio.play().catch(() => {});
    if (cancelled) return;
    if (!result) { setPlayerMessage('Too short — hold the button while you speak.'); return; }
    const notePos = player.position;
    setPlayerMessage('Saving note…');
    try {
      const res = await fetch(rel(`api/notes?bookId=${encodeURIComponent(book.id)}&position=${notePos}`), {
        method: 'POST', body: result.blob,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      player.notes.push(data.note);
      renderNoteDots();
      messageLine.replaceChildren(
        `Note saved at ${fmtClock(notePos)} ✓ `,
        el('button', { class: 'undo-btn', onclick: async (e) => {
          e.currentTarget.disabled = true;
          await fetch(rel(`api/notes/${data.note.id}`), { method: 'DELETE' }).catch(() => {});
          player.notes = player.notes.filter(n => n.id !== data.note.id);
          renderNoteDots();
          setPlayerMessage('');
        } }, 'Undo'));
      setTimeout(() => { if (messageLine.textContent.startsWith('Note saved')) setPlayerMessage(''); }, 8000);
    } catch (e) {
      setPlayerMessage(`Could not save note: ${e.message}`);
    }
  };

  micChip.addEventListener('pointerdown', async (e) => {
    e.preventDefault();
    micChip.setPointerCapture(e.pointerId);
    if (recorder.active) return;
    recWasPlaying = player.playing;
    try {
      await recorder.start();
    } catch {
      setPlayerMessage('Microphone unavailable — check app permissions, or use Chrome/Safari.');
      return;
    }
    if (recWasPlaying) audio.pause(); // don't record the book over your voice
    micChip.classList.add('recording');
    const t0 = Date.now();
    micChip.textContent = '● 0s';
    recTimer = setInterval(() => {
      const s = Math.round((Date.now() - t0) / 1000);
      micChip.textContent = `● ${s}s`;
      if (s >= 120) stopRecording(false); // hard cap
    }, 500);
  });
  micChip.addEventListener('pointerup', () => stopRecording(false));
  micChip.addEventListener('pointercancel', () => stopRecording(true));

  const trackLabel = el('div', { class: 'track-label' });
  const deltaNum = el('div', { class: 'delta-num' });
  const partnerStatus = el('div', { class: 'partner-status' });
  const deltaCard = partnerInfo
    ? el('div', { class: 'delta-card' }, deltaNum, partnerStatus)
    : null;

  // --- chapters (from a cue sheet when present, otherwise one per file) ---
  const chapterList = book.chapters?.length ? book.chapters : book.tracks;
  const chapterIdx = () => {
    let ci = 0;
    for (let i = 0; i < chapterList.length; i++) if (player.position >= chapterList[i].start - 0.5) ci = i;
    return ci;
  };
  const chapterSkip = (dir) => {
    const ci = chapterIdx();
    if (dir > 0) {
      if (ci + 1 < chapterList.length) player.seek(chapterList[ci + 1].start + 0.01, true);
    } else {
      // Standard player behavior: restart the current chapter, unless we're
      // right at its start — then go to the previous one.
      const atStart = player.position - chapterList[ci].start <= 3;
      const target = atStart && ci > 0 ? chapterList[ci - 1] : chapterList[ci];
      player.seek(target.start + 0.01, true);
    }
  };
  const chapterRows = chapterList.map(c =>
    el('button', { class: 'chapter-row', onclick: () => player.seek(c.start + 0.01, true) },
      el('span', {}, c.title),
      el('span', { class: 'dur' }, fmtClock(c.duration))));
  const chapters = el('div', { class: 'chapters', style: { display: chapterList.length > 1 ? '' : 'none' } }, chapterRows);

  $app.replaceChildren(el('div', { class: 'screen player fade-in' },
    el('div', { class: 'player-top' },
      el('button', { class: 'icon-btn', html: ICONS.backArrow, onclick: () => navigateUp('') }),
      state.me ? avatarEl(state.me, true) : null),
    el('div', { class: 'player-cover-wrap' }, coverEl(book, 'player-cover')),
    el('div', { class: 'player-meta' },
      el('h1', {}, book.title),
      book.author ? el('div', { class: 'author' }, book.author) : null,
      trackLabel),
    deltaCard,
    el('div', { class: 'timeline-wrap' }, timeline),
    el('div', { class: 'time-row' }, elapsed, remaining),
    el('div', { class: 'controls' },
      el('button', { class: 'skip-btn', html: ICONS.back30 + '<span class="skip-num">30</span>', onclick: () => player.skip(-30) }),
      el('button', { class: 'skip-btn small', html: ICONS.back30 + '<span class="skip-num">10</span>', onclick: () => player.skip(-10) }),
      playBtn,
      el('button', { class: 'skip-btn small', html: ICONS.fwd30 + '<span class="skip-num">10</span>', onclick: () => player.skip(10) }),
      el('button', { class: 'skip-btn', html: ICONS.fwd30 + '<span class="skip-num">30</span>', onclick: () => player.skip(30) })),
    chapterList.length > 1 ? el('div', { class: 'sub-controls' },
      el('button', { class: 'chip-btn', onclick: () => chapterSkip(-1) }, '⏮ Chapter'),
      el('button', { class: 'chip-btn', onclick: () => chapterSkip(1) }, 'Chapter ⏭')) : null,
    el('div', { class: 'sub-controls' }, speedChip, sleepChip, micChip, notesChip),
    messageLine,
    aboutSection(book),
    chapters,
  ));
  renderNoteDots();

  playerUI = {
    book, fill, thumb, partnerMarker, elapsed, remaining, playBtn, speedChip, sleepChip,
    trackLabel, deltaNum, partnerStatus, chapterRows, partnerInfo, messageLine, notesChip, renderNoteDots,
    getScrub: () => scrubPos,
    partnerProgress: partnerInfo?.progress || null,
  };
  updatePlayerUI();

  // poll partner position while on this screen
  if (partnerInfo) {
    const poll = async () => {
      try {
        const p = await api(`/api/books/${encodeURIComponent(book.id)}/progress`);
        if (playerUI?.book.id === book.id) {
          playerUI.partnerProgress = p.partner?.progress || null;
          if (p.notes && player.book?.id === book.id) {
            player.notes = p.notes;
            playerUI.renderNoteDots();
          }
          updatePlayerUI();
        }
      } catch { /* ignore */ }
    };
    partnerPollTimer = setInterval(poll, 10000);
  }
}

function updatePlayerUI() {
  const ui = playerUI;
  if (ui) {
    const { book } = ui;
    const scrub = ui.getScrub();
    // With an unknown total duration the elapsed clock still ticks; only the
    // percentage-based visuals degrade.
    const pos = scrub != null ? scrub : (book.duration > 0 ? clamp(player.position, 0, book.duration) : player.position);
    const pct = book.duration > 0 ? (pos / book.duration) * 100 : 0;
    ui.fill.style.width = `${pct}%`;
    ui.thumb.style.left = `${pct}%`;
    ui.elapsed.textContent = fmtClock(pos);
    ui.remaining.textContent = book.duration > 0 ? `-${fmtClock(book.duration - pos)}` : '';
    ui.playBtn.innerHTML = player.playing ? ICONS.pause : ICONS.play;
    ui.speedChip.textContent = `${player.speed}×`;
    ui.speedChip.classList.toggle('active', player.speed !== 1);
    const sleepMins = SLEEP_CHOICES[player.sleepChoice];
    ui.sleepChip.textContent = sleepMins ? `😴 ${sleepMins}m` : '😴 Off';
    ui.sleepChip.classList.toggle('active', !!sleepMins);
    ui.notesChip.textContent = { partner: '💬 Partner', all: '💬 All', off: '💬 Off' }[notePlayer.mode];
    ui.notesChip.classList.toggle('active', notePlayer.mode !== 'off');

    const chapterList = book.chapters?.length ? book.chapters : book.tracks;
    if (chapterList.length > 1) {
      let ci = 0;
      for (let i = 0; i < chapterList.length; i++) if (pos >= chapterList[i].start - 0.5) ci = i;
      ui.trackLabel.textContent = `Chapter ${ci + 1} of ${chapterList.length}`;
      ui.chapterRows.forEach((row, i) => row.classList.toggle('current', i === ci));
    }

    // partner marker + ahead/behind indicator
    if (ui.partnerInfo) {
      const pp = ui.partnerProgress;
      const who = ui.partnerInfo.user;
      const liveDot = () => el('div', {
        class: isLive(pp) ? 'live-pulse' : '',
        style: { width: '8px', height: '8px', borderRadius: '50%', background: who.color },
      });
      if (pp) {
        if (book.duration > 0) {
          const ppct = clamp(pp.position / book.duration, 0, 1) * 100;
          ui.partnerMarker.style.display = '';
          ui.partnerMarker.style.left = `${ppct}%`;
        } else {
          ui.partnerMarker.style.display = 'none';
        }
        const delta = pos - pp.position;
        if (pp.finished) {
          ui.deltaNum.textContent = '📕';
          ui.deltaNum.style.color = '';
          ui.partnerStatus.replaceChildren(liveDot(), `${who.name} finished this book`);
        } else if (Math.abs(delta) <= 60) {
          ui.deltaNum.textContent = 'Together';
          ui.deltaNum.style.color = 'var(--accent)';
          ui.partnerStatus.replaceChildren(liveDot(),
            `you and ${who.name} are at the same spot${isLive(pp) ? ' — listening now' : ''}`);
        } else {
          ui.deltaNum.textContent = fmtLong(Math.abs(delta));
          ui.deltaNum.style.color = delta > 0 ? state.me.color : who.color;
          ui.partnerStatus.replaceChildren(liveDot(),
            `${delta > 0 ? 'ahead of' : 'behind'} ${who.name}` +
            `${isLive(pp) ? ' — listening now' : ''} (${who.name.split(' ')[0]} is at ${fmtClock(pp.position)})`);
        }
      } else {
        ui.partnerMarker.style.display = 'none';
        ui.deltaNum.textContent = '—';
        ui.deltaNum.style.color = '';
        ui.partnerStatus.replaceChildren(`${who.name} hasn't started this one yet`);
      }
    }
  }

  // mini player (library screen)
  document.querySelector('.mini-player')?.update?.();
}

boot();
