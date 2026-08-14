// Tiny JSON-file datastore. Fine for two users; atomic writes, debounced flush.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT = () => ({ users: [], progress: {} });

export class Db {
  constructor(file) {
    this.file = file;
    this.flushTimer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });

    // Never silently discard an existing database. Try the main file, then
    // the in-flight temp, then the backup; strip a UTF-8 BOM if present. If
    // everything is unreadable, preserve the corrupt file before starting
    // fresh so nothing is ever overwritten and lost.
    this.data = null;
    let loadedFrom = null;
    for (const candidate of [file, file + '.tmp', file + '.bak']) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8').replace(/^﻿/, ''));
        if (parsed && typeof parsed === 'object') {
          this.data = parsed;
          loadedFrom = candidate;
          if (candidate !== file) console.warn(`[db] recovered database from ${path.basename(candidate)}`);
          break;
        }
      } catch { /* try next candidate */ }
    }
    if (!this.data) {
      if (fs.existsSync(file)) {
        const quarantine = `${file}.corrupt-${Date.now()}`;
        try {
          fs.copyFileSync(file, quarantine);
          console.error(`[db] DATABASE UNREADABLE — preserved as ${path.basename(quarantine)}, starting fresh`);
        } catch { /* at least we tried */ }
      }
      this.data = DEFAULT();
    }
    if (!this.data.users) this.data.users = [];
    if (!this.data.progress) this.data.progress = {};
    if (!this.data.notes) this.data.notes = [];
    if (!this.data.requests) this.data.requests = [];

    // Roll a backup of the last known-good state at every startup — but only
    // from the main file, so a corrupt main never clobbers a good backup.
    if (loadedFrom === file) {
      try { fs.copyFileSync(file, file + '.bak'); } catch { /* best effort */ }
    } else if (loadedFrom) {
      this.flushSync(); // restore the recovered data to the main file
    }
  }

  save() {
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      try { this.flushSync(); } catch (err) { console.error('[db] flush failed:', err.message); }
    }, 250);
  }

  flushSync() {
    clearTimeout(this.flushTimer);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    try {
      fs.renameSync(tmp, this.file);
    } catch {
      // Windows can briefly lock the target (AV scans etc.) — fall back to direct write.
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    }
  }

  // --- users ---
  get users() { return this.data.users; }
  getUser(id) { return this.data.users.find(u => u.id === id); }
  addUser(user) { this.data.users.push(user); this.save(); }

  // --- voice notes ---
  get notes() { return this.data.notes; }
  addNote(note) { this.data.notes.push(note); this.save(); }
  getNote(id) { return this.data.notes.find(n => n.id === id); }
  notesForBook(bookId) { return this.data.notes.filter(n => n.bookId === bookId); }
  deleteNote(id) {
    const i = this.data.notes.findIndex(n => n.id === id);
    if (i >= 0) { this.data.notes.splice(i, 1); this.save(); }
  }

  // --- progress ---
  getProgress(userId, bookId) {
    return this.data.progress[`${userId}:${bookId}`] || null;
  }
  // naturalStep = seconds of real listening since the previous save (0 for
  // seeks); accumulated into a "session" so the UI can say "listened 1h 20m".
  // A gap of 10+ minutes starts a new session.
  setProgress(userId, bookId, pos, finished, naturalStep = 0) {
    const prev = this.data.progress[`${userId}:${bookId}`];
    const now = Date.now();
    let session = prev?.session || null;
    if (naturalStep > 0) {
      if (session && now - (prev?.updatedAt || 0) < 10 * 60e3) {
        session = { seconds: session.seconds + naturalStep, endedAt: now };
      } else {
        session = { seconds: naturalStep, endedAt: now };
      }
    } else if (session) {
      session = { ...session };
    }
    this.data.progress[`${userId}:${bookId}`] = {
      position: pos,
      finished: !!finished,
      updatedAt: now,
      session,
    };
    this.save();
  }

  // --- book requests (wishlist) ---
  get requests() { return this.data.requests; }
  addRequest(r) { this.data.requests.push(r); this.save(); }
  deleteRequest(id) {
    const i = this.data.requests.findIndex(r => r.id === id);
    if (i >= 0) { this.data.requests.splice(i, 1); this.save(); }
  }

  // --- cached book metadata (synopsis, genres) ---
  getBookMeta(bookId) { return this.data.bookMeta?.[bookId] || null; }
  setBookMeta(bookId, meta) {
    if (!this.data.bookMeta) this.data.bookMeta = {};
    this.data.bookMeta[bookId] = meta;
    this.save();
  }

  // Removes every stored trace of a book (progress, deck state, metadata,
  // note records); returns the ids of removed notes so files can be cleaned.
  deleteBookData(bookId) {
    for (const k of Object.keys(this.data.progress)) {
      if (k.endsWith(`:${bookId}`)) delete this.data.progress[k];
    }
    for (const k of Object.keys(this.data.deckHidden || {})) {
      if (k.endsWith(`:${bookId}`)) delete this.data.deckHidden[k];
    }
    if (this.data.bookMeta) delete this.data.bookMeta[bookId];
    const removed = this.data.notes.filter(n => n.bookId === bookId).map(n => n.id);
    this.data.notes = this.data.notes.filter(n => n.bookId !== bookId);
    this.save();
    return removed;
  }

  // --- on-deck row hiding (per viewer) ---
  hideFromDeck(userId, bookId) {
    if (!this.data.deckHidden) this.data.deckHidden = {};
    this.data.deckHidden[`${userId}:${bookId}`] = Date.now();
    this.save();
  }
  deckHiddenAt(userId, bookId) {
    return this.data.deckHidden?.[`${userId}:${bookId}`] || 0;
  }
}
