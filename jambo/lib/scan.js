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

// Scans one or more roots; the first root to claim a folder name wins.
export async function scanLibrary(booksDirs, cacheFile) {
  const roots = Array.isArray(booksDirs) ? booksDirs : [booksDirs];
  fs.mkdirSync(roots[0], { recursive: true });
  const cache = loadCache(cacheFile);
  const newCache = {};
  const books = [];

  const dirEntries = [];
  const seenNames = new Set();
  for (const root of roots) {
    let names = [];
    try {
      names = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    } catch { continue; }
    for (const name of names.sort(naturalCompare)) {
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      dirEntries.push({ root, dirName: name });
    }
  }

  for (const { root, dirName } of dirEntries) {
    const dirPath = path.join(root, dirName);
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
      if (!meta || !(meta.duration > 0)) {
        meta = { duration: 0, title: '', artist: '', album: '' };
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

    books.push({
      id: slug(dirName),
      dirName,
      title,
      author,
      coverPath: coverName ? path.join(dirPath, coverName) : null,
      duration: offset,
      tracks,
    });
  }

  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(newCache));
  return books;
}
