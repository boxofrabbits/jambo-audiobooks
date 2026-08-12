// Tiny JSON-file datastore. Fine for two users; atomic writes, debounced flush.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT = () => ({ users: [], progress: {} });

export class Db {
  constructor(file) {
    this.file = file;
    this.flushTimer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.data = DEFAULT();
    }
    if (!this.data.users) this.data.users = [];
    if (!this.data.progress) this.data.progress = {};
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

  // --- progress ---
  getProgress(userId, bookId) {
    return this.data.progress[`${userId}:${bookId}`] || null;
  }
  setProgress(userId, bookId, pos, finished) {
    this.data.progress[`${userId}:${bookId}`] = {
      position: pos,
      finished: !!finished,
      updatedAt: Date.now(),
    };
    this.save();
  }
}
