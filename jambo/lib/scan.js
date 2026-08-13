// Scans the books/ folder. One subfolder = one book.
// Audio tracks are sorted naturally by filename; durations are read with
// music-metadata and cached (keyed by path+size+mtime) so rescans are fast.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseFile } from 'music-metadata';

const execFileAsync = promisify(execFile);

export const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.m4b', '.aac', '.ogg', '.opus', '.flac']);
export const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'book';

function loadCache(cacheFile) {
  try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { return {}; }
}

// Fallback when music-metadata can't produce a duration: read the RIFF header
// directly (duration = data bytes / byte rate).
function wavDuration(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return 0;
    let pos = 12, byteRate = 0, dataSize = 0;
    const chunkHead = Buffer.alloc(8);
    while (pos + 8 <= size) {
      fs.readSync(fd, chunkHead, 0, 8, pos);
      const id = chunkHead.toString('ascii', 0, 4);
      const csize = chunkHead.readUInt32LE(4);
      if (id === 'fmt ') {
        const fmt = Buffer.alloc(16);
        fs.readSync(fd, fmt, 0, 16, pos + 8);
        byteRate = fmt.readUInt32LE(8);
      } else if (id === 'data') {
        dataSize = csize;
      }
      pos += 8 + csize + (csize % 2);
    }
    return byteRate > 0 ? dataSize / byteRate : 0;
  } finally {
    fs.closeSync(fd);
  }
}

// Last-resort duration reader: ffprobe handles every container music-metadata
// might choke on. Bundled in the add-on image; silently skipped if absent.
async function ffprobeDuration(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
      { timeout: 30000 });
    return parseFloat(stdout) || 0;
  } catch {
    return 0;
  }
}

// Chapter markers embedded in the file itself (standard in m4b audiobooks,
// occasionally ID3 CHAP in mp3s). Start times are file-relative seconds.
async function ffprobeChapters(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_chapters', filePath],
      { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
    return (JSON.parse(stdout).chapters || []).map((c, i) => ({
      start: parseFloat(c.start_time) || 0,
      title: c.tags?.title?.trim() || `Chapter ${i + 1}`,
    }));
  } catch {
    return [];
  }
}

// Cue sheets give named chapter points inside big single-file rips.
// Timestamps are mm:ss:ff (75 frames per second); mm may exceed 99.
function parseCueChapters(cuePath, tracks) {
  let text = fs.readFileSync(cuePath, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const chapters = [];
  let currentTrack = tracks.length === 1 ? tracks[0] : null;
  let pendingTitle = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    let m;
    if ((m = line.match(/^FILE\s+"(.+?)"/i)) || (m = line.match(/^FILE\s+(\S+)/i))) {
      const base = (f) => path.basename(f, path.extname(f)).toLowerCase();
      currentTrack = tracks.find(t => t.filename.toLowerCase() === m[1].toLowerCase())
        || tracks.find(t => base(t.filename) === base(m[1]))
        || (tracks.length === 1 ? tracks[0] : null);
    } else if (/^TRACK\s+\d+/i.test(line)) {
      pendingTitle = '';
    } else if ((m = line.match(/^TITLE\s+"(.*)"/i))) {
      pendingTitle = m[1];
    } else if ((m = line.match(/^INDEX\s+01\s+(\d+):(\d\d):(\d\d)/i))) {
      if (currentTrack) {
        chapters.push({
          title: pendingTitle || `Chapter ${chapters.length + 1}`,
          start: currentTrack.start + Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 75,
        });
      }
    }
  }
  return chapters;
}

// Scans one or more roots; the first root to claim a folder name wins.
export async function scanLibrary(booksDirs, cacheFile) {
  const roots = Array.isArray(booksDirs) ? booksDirs : [booksDirs];
  fs.mkdirSync(roots[0], { recursive: true });
  const cache = loadCache(cacheFile);
  const newCache = {};
  const books = [];

  // Two levels: a top-level folder with audio files is a book; one without
  // audio is a collection whose subfolders are books (shown as sections).
  const listDirs = (p) => {
    try {
      return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(naturalCompare);
    } catch { return []; }
  };
  const hasAudioFiles = (p) => {
    try { return fs.readdirSync(p).some(f => AUDIO_EXT.has(path.extname(f).toLowerCase())); } catch { return false; }
  };

  const dirEntries = [];
  const seenNames = new Set();
  for (const root of roots) {
    for (const name of listDirs(root)) {
      const dirPath = path.join(root, name);
      if (hasAudioFiles(dirPath)) {
        if (!seenNames.has(name)) {
          seenNames.add(name);
          dirEntries.push({ parent: root, dirName: name, folder: null });
        }
      } else {
        for (const sub of listDirs(dirPath)) {
          if (!seenNames.has(sub) && hasAudioFiles(path.join(dirPath, sub))) {
            seenNames.add(sub);
            dirEntries.push({ parent: dirPath, dirName: sub, folder: name });
          }
        }
      }
    }
  }

  for (const { parent, dirName, folder } of dirEntries) {
    const dirPath = path.join(parent, dirName);
    const entries = fs.readdirSync(dirPath).sort(naturalCompare);
    const audioFiles = entries.filter(f => AUDIO_EXT.has(path.extname(f).toLowerCase()));
    if (audioFiles.length === 0) continue;

    const coverName = entries.find(f => /^cover\./i.test(f) && IMAGE_EXT.has(path.extname(f).toLowerCase()))
      || entries.find(f => IMAGE_EXT.has(path.extname(f).toLowerCase()));

    let author = '';
    let title = dirName;
    // Folder names like "Author - Title" split on the first " - ".
    const m = dirName.match(/^(.+?) - (.+)$/);
    if (m) { author = m[1]; title = m[2]; }

    const tracks = [];
    const metas = [];
    let offset = 0;
    for (const file of audioFiles) {
      const filePath = path.join(dirPath, file);
      const stat = fs.statSync(filePath);
      const key = `${filePath}|${stat.size}|${stat.mtimeMs}`;
      let meta = cache[key];
      // chapters === undefined marks a cache entry from before chapter
      // support — re-probe those once so existing libraries pick them up.
      if (!meta || !(meta.duration > 0) || meta.chapters === undefined) {
        meta = { duration: 0, title: '', artist: '', album: '', chapters: [] };
        try {
          const parsed = await parseFile(filePath, { duration: true });
          meta.duration = parsed.format.duration || 0;
          meta.title = parsed.common.title || '';
          meta.artist = parsed.common.artist || parsed.common.albumartist || '';
          meta.album = parsed.common.album || '';
        } catch (err) {
          console.warn(`[scan] could not read metadata for ${filePath}: ${err.message}`);
        }
        if (!(meta.duration > 0) && path.extname(file).toLowerCase() === '.wav') {
          try {
            meta.duration = wavDuration(filePath);
            if (meta.duration > 0) console.log(`[scan] used RIFF-header duration for ${file}`);
          } catch (err) {
            console.warn(`[scan] RIFF fallback failed for ${filePath}: ${err.message}`);
          }
        }
        if (!(meta.duration > 0)) {
          meta.duration = await ffprobeDuration(filePath);
          if (meta.duration > 0) console.log(`[scan] used ffprobe duration for ${file}`);
        }
        if (!(meta.duration > 0)) console.warn(`[scan] NO DURATION for ${filePath} — timeline degraded for this book`);
        meta.chapters = await ffprobeChapters(filePath);
      }
      // Failed reads are not cached, so a transient failure heals on rescan.
      if (meta.duration > 0) newCache[key] = meta;
      metas.push(meta);
      tracks.push({
        idx: tracks.length,
        filename: file,
        path: filePath,
        title: meta.title || path.basename(file, path.extname(file)),
        duration: meta.duration,
        start: offset,
      });
      offset += meta.duration;
    }

    // Fall back to embedded tags when the folder name has no " - " split.
    if (!author) author = metas.map(m => m.artist).find(Boolean) || '';
    if (title === dirName) title = metas.map(m => m.album).find(Boolean) || dirName;

    // Chapters: cue sheets win (named points inside big files); otherwise one
    // chapter per audio file.
    let chapters = [];
    for (const cueFile of entries.filter(f => f.toLowerCase().endsWith('.cue'))) {
      try {
        chapters.push(...parseCueChapters(path.join(dirPath, cueFile), tracks));
      } catch (err) {
        console.warn(`[scan] bad cue sheet ${cueFile}: ${err.message}`);
      }
    }
    chapters = chapters.filter(c => c.start < offset + 1).sort((a, b) => a.start - b.start);
    // No cue: use chapter markers embedded in the audio files (m4b, ID3 CHAP).
    if (chapters.length === 0) {
      for (const [i, t] of tracks.entries()) {
        for (const ch of metas[i].chapters || []) {
          chapters.push({ title: ch.title, start: t.start + ch.start });
        }
      }
      chapters = chapters.filter(c => c.start < offset + 1).sort((a, b) => a.start - b.start);
      if (chapters.length) console.log(`[scan] ${dirName}: ${chapters.length} embedded chapter(s)`);
    }
    if (chapters.length === 0) chapters = tracks.map(t => ({ title: t.title, start: t.start }));
    chapters.forEach((c, i) => {
      c.duration = (i + 1 < chapters.length ? chapters[i + 1].start : offset) - c.start;
    });

    books.push({
      id: slug(dirName),
      dirName,
      folder,
      addedAt: (() => { try { return fs.statSync(dirPath).mtimeMs; } catch { return 0; } })(),
      title,
      author,
      coverPath: coverName ? path.join(dirPath, coverName) : null,
      duration: offset,
      tracks,
      chapters,
    });
  }

  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(newCache));
  return books;
}
