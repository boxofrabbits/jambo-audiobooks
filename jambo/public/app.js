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
    const onMeta = () => {
      audio.currentTime = clamp(offset, 0, track.duration || offset);
      if (thenPlay) audio.play().catch(() => {});
    };
    audio.addEventListener('loadedmetadata', onMeta, { once: true });
    audio.load();
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
    globalSec = clamp(globalSec, 0, Math.max(0, this.book.duration - 0.5));
    const idx = this.trackForPos(globalSec);
    const offset = globalSec - this.book.tracks[idx].start;
    this.position = globalSec;
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
    if (this.playing) audio.pause();
    else audio.play().catch(err => console.warn('play failed', err));
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
    this.sleepDeadline = null;
    this.sleepChoice = 0;
  },

  onTick() {
    if (!this.book) return;
    const track = this.book.tracks[this.trackIdx];
    if (audio.readyState >= 1 && !audio.seeking) {
      this.position = track.start + audio.currentTime;
    }
    if (this.sleepDeadline && Date.now() >= this.sleepDeadline) {
      audio.pause();
      this.sleepDeadline = null;
      this.sleepChoice = 0;
      updatePlayerUI();
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
    if (!force && this.lastSavedPos === this.position) return;
    this.lastSavedPos = this.position;
    api('/api/progress', {
      method: 'PUT',
      body: { bookId: this.book.id, position: this.position, finished },
    }).catch(() => {});
  },

  beaconSave() {
    if (!this.book || !state.me) return;
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
    ms.setActionHandler('seekbackward', (e) => this.skip(-(e?.seekOffset || 30)));
    ms.setActionHandler('seekforward', (e) => this.skip(e?.seekOffset || 30));
    try {
      ms.setActionHandler('seekto', (e) => { if (e.seekTime != null) this.seek(e.seekTime); });
    } catch { /* not supported */ }
  },

  updatePositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState || !this.book) return;
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

audio.addEventListener('timeupdate', () => { player.onTick(); updatePlayerUI(); });
audio.addEventListener('ended', () => player.onEnded());
audio.addEventListener('error', () => {
  const codes = { 1: 'aborted', 2: 'network error', 3: 'decode error', 4: 'source not supported' };
  player.onMediaError(codes[audio.error?.code] || 'media error');
});
audio.addEventListener('play', () => updatePlayerUI());
audio.addEventListener('pause', () => { player.saveProgress(true); updatePlayerUI(); });

window.addEventListener('pagehide', () => player.beaconSave());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') player.beaconSave();
});

// ---------- routing ----------

let partnerPollTimer = null;
let libraryPollTimer = null;

function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

window.addEventListener('hashchange', render);

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
  renderLibrary();
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
      navigate('#/library');
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

async function renderLibrary() {
  const screen = el('div', { class: 'screen fade-in' + (player.book ? ' has-mini' : '') },
    el('div', { class: 'lib-header' },
      el('div', { class: 'logo' }, 'Jambo', el('span', { class: 'dot' }, '.')),
      el('div', { class: 'header-actions' },
        el('button', { class: 'icon-btn', title: 'Rescan library', html: ICONS.refresh,
          onclick: async (e) => {
            e.currentTarget.style.opacity = '0.4';
            await api('/api/rescan', { method: 'POST' }).catch(() => {});
            renderLibrary();
          } }),
        state.haUser ? null : el('button', { class: 'icon-btn', title: 'Log out', html: ICONS.logout,
          onclick: async () => {
            player.stop();
            await api('/api/logout', { method: 'POST' }).catch(() => {});
            state.me = null;
            navigate('');
          } }),
        state.me ? avatarEl(state.me, false) : null,
      )),
    el('div', { class: 'spinner' }),
  );
  screen.querySelector('.header-actions .avatar')?.classList.add('small');
  $app.replaceChildren(screen);

  let data;
  try {
    data = await api('/api/books');
  } catch { return; }
  state.booksCache = data.books;

  const spinner = screen.querySelector('.spinner');
  if (!spinner) return;

  if (data.books.length === 0) {
    spinner.replaceWith(el('div', { class: 'empty-lib' },
      el('p', { style: { fontSize: '40px', marginBottom: '10px' } }, '📚'),
      el('p', {}, 'No books yet.'),
      el('p', { style: { marginTop: '10px', fontSize: '14px' } },
        'Drop each audiobook into its own folder inside ', el('code', {}, 'books/'),
        ' (with a cover.jpg if you have one), then tap rescan.'),
    ));
  } else {
    spinner.replaceWith(el('div', { class: 'book-grid' }, data.books.map(bookCard)));
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
    const grid = screen.querySelector('.book-grid');
    if (grid) grid.replaceChildren(...data.books.map(bookCard));
  } catch { /* ignore */ }
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
    return el('div', { class: 'mini-bar-row' },
      el('span', { class: 'who', style: { color } }, who),
      el('div', { class: 'mini-bar' },
        el('div', { style: { width: `${pct * 100}%`, background: color } })),
      el('span', { class: 'pct' }, progress?.finished ? '✓' : `${Math.round(pct * 100)}%`));
  };

  return el('button', { class: 'book-card', onclick: () => navigate(`#/book/${encodeURIComponent(book.id)}`) },
    cover,
    el('div', { class: 'book-title' }, book.title),
    book.author ? el('div', { class: 'book-author' }, book.author) : null,
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

// ---------- player screen ----------

let playerUI = null; // refs to live DOM bits, null when not on player screen

async function renderPlayer(bookId) {
  playerUI = null;
  let book;
  try {
    book = await api(`/api/books/${encodeURIComponent(bookId)}`);
  } catch {
    navigate('#/library');
    return;
  }

  if (player.book?.id !== book.id) {
    // A finished book reopens from the start; otherwise resume where you left off.
    player.load(book, book.me?.finished ? 0 : book.me?.position || 0);
  } else {
    player.book.me = book.me;
    player.book.partner = book.partner;
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
  const timeline = el('div', { class: 'timeline' },
    el('div', { class: 'timeline-track' }, fill),
    thumb, partnerMarker);
  const elapsed = el('span', {}, '0:00');
  const remaining = el('span', {}, '-0:00');

  let scrubPos = null;
  const posFromEvent = (e) => {
    const rect = timeline.getBoundingClientRect();
    return clamp((e.clientX - rect.left) / rect.width, 0, 1) * book.duration;
  };
  timeline.addEventListener('pointerdown', (e) => {
    timeline.setPointerCapture(e.pointerId);
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

  const trackLabel = el('div', { class: 'track-label' });
  const deltaNum = el('div', { class: 'delta-num' });
  const partnerStatus = el('div', { class: 'partner-status' });
  const deltaCard = partnerInfo
    ? el('div', { class: 'delta-card' }, deltaNum, partnerStatus)
    : null;

  // --- chapters ---
  const chapterRows = book.tracks.map(t =>
    el('button', { class: 'chapter-row', onclick: () => player.seek(t.start + 0.01, true) },
      el('span', {}, t.title),
      el('span', { class: 'dur' }, fmtClock(t.duration))));
  const chapters = el('div', { class: 'chapters', style: { display: book.tracks.length > 1 ? '' : 'none' } }, chapterRows);

  $app.replaceChildren(el('div', { class: 'screen player fade-in' },
    el('div', { class: 'player-top' },
      el('button', { class: 'icon-btn', html: ICONS.backArrow, onclick: () => navigate('#/library') }),
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
    el('div', { class: 'sub-controls' }, speedChip, sleepChip),
    messageLine,
    chapters,
  ));

  playerUI = {
    book, fill, thumb, partnerMarker, elapsed, remaining, playBtn, speedChip, sleepChip,
    trackLabel, deltaNum, partnerStatus, chapterRows, partnerInfo, messageLine,
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
    const pos = scrub != null ? scrub : clamp(player.position, 0, book.duration);
    const pct = book.duration > 0 ? (pos / book.duration) * 100 : 0;
    ui.fill.style.width = `${pct}%`;
    ui.thumb.style.left = `${pct}%`;
    ui.elapsed.textContent = fmtClock(pos);
    ui.remaining.textContent = `-${fmtClock(book.duration - pos)}`;
    ui.playBtn.innerHTML = player.playing ? ICONS.pause : ICONS.play;
    ui.speedChip.textContent = `${player.speed}×`;
    ui.speedChip.classList.toggle('active', player.speed !== 1);
    const sleepMins = SLEEP_CHOICES[player.sleepChoice];
    ui.sleepChip.textContent = sleepMins ? `😴 ${sleepMins}m` : '😴 Off';
    ui.sleepChip.classList.toggle('active', !!sleepMins);

    if (book.tracks.length > 1) {
      ui.trackLabel.textContent = `Part ${player.trackIdx + 1} of ${book.tracks.length}`;
      ui.chapterRows.forEach((row, i) => row.classList.toggle('current', i === player.trackIdx));
    }

    // partner marker + ahead/behind indicator
    if (ui.partnerInfo) {
      const pp = ui.partnerProgress;
      const who = ui.partnerInfo.user;
      const liveDot = () => el('div', {
        class: isLive(pp) ? 'live-pulse' : '',
        style: { width: '8px', height: '8px', borderRadius: '50%', background: who.color },
      });
      if (pp && book.duration > 0) {
        const ppct = clamp(pp.position / book.duration, 0, 1) * 100;
        ui.partnerMarker.style.display = '';
        ui.partnerMarker.style.left = `${ppct}%`;
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
