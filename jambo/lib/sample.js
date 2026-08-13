// Generates the demo book when the library is empty, and removes it again
// once real books show up. Only folders containing our marker file are ever
// deleted. No external deps: WAV is raw PCM, PNG is written via node:zlib.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SAMPLE_DIR = 'Jambo Demo - Sample Book';
const MARKER = '.jambo-demo';
const RATE = 22050;

// ---------- WAV ----------

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function melody(notes, secondsPerNote, gain = 0.25) {
  const n = Math.floor(notes.length * secondsPerNote * RATE);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const ni = Math.min(notes.length - 1, Math.floor(t / secondsPerNote));
    const tin = t - ni * secondsPerNote;
    const f = 220 * 2 ** (notes[ni] / 12);
    const env = Math.exp(-2.2 * tin);
    out[i] = gain * env * (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(4 * Math.PI * f * t));
  }
  return out;
}

// ---------- PNG (truecolor, no deps) ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(size, pixelFn) {
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelFn(x, y);
      raw.writeUInt8(Math.max(0, Math.min(255, Math.round(r))), row + 1 + x * 3);
      raw.writeUInt8(Math.max(0, Math.min(255, Math.round(g))), row + 2 + x * 3);
      raw.writeUInt8(Math.max(0, Math.min(255, Math.round(b))), row + 3 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); ihdr.writeUInt8(2, 9); // 8-bit, truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- public API ----------

export function syncSampleBook(booksDir, hasRealBooksElsewhere = false, allowGenerate = true) {
  fs.mkdirSync(booksDir, { recursive: true });
  const dirs = fs.readdirSync(booksDir, { withFileTypes: true }).filter(d => d.isDirectory());
  const samplePath = path.join(booksDir, SAMPLE_DIR);
  const markerPath = path.join(samplePath, MARKER);
  const hasRealBooks = hasRealBooksElsewhere || dirs.some(d => d.name !== SAMPLE_DIR);

  if (hasRealBooks) {
    // Real library exists — retire the demo (only if it's really ours).
    if (fs.existsSync(markerPath)) {
      fs.rmSync(samplePath, { recursive: true, force: true });
      console.log('[sample] removed demo book (real books present)');
    }
    return;
  }

  if (!allowGenerate || fs.existsSync(markerPath)) return;

  fs.mkdirSync(samplePath, { recursive: true });
  const scaleA = [0, 3, 5, 7, 10, 12, 10, 7, 5, 3, 0, -2, 0, 3, 7, 12];
  const scaleB = [12, 10, 7, 5, 3, 0, 3, 5, 7, 10, 12, 15, 12, 10, 7, 5];
  fs.writeFileSync(path.join(samplePath, '01 - Part One.wav'), wav(melody([...scaleA, ...scaleA, ...scaleB, ...scaleA], 0.9)));
  fs.writeFileSync(path.join(samplePath, '02 - Part Two.wav'), wav(melody([...scaleB, ...scaleA, ...scaleB, ...scaleB], 0.9)));
  const S = 512;
  fs.writeFileSync(path.join(samplePath, 'cover.png'), png(S, (x, y) => {
    const d = Math.hypot(x - S / 2, y - S / 2) / (S / 2);
    const ring = Math.sin(d * 22) * 0.5 + 0.5;
    return [0x8a + ring * 30 - d * 60, 0x5a + ring * 22 - d * 40, 0x52 + ring * 20 - d * 30];
  }));
  fs.writeFileSync(markerPath, 'Auto-generated demo book. Safe to delete this folder.\n');
  console.log('[sample] generated demo book (library was empty)');
}
