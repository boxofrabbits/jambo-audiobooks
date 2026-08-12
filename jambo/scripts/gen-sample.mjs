// Generates a small sample "audiobook" (gentle sine melodies as WAV) plus a cover,
// so the app can be tried before real books are added. Delete books/Sample Book to remove.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'books', 'Jambo Demo - Sample Book');
fs.mkdirSync(dir, { recursive: true });

const RATE = 22050;

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);        // PCM
  header.writeUInt16LE(1, 22);        // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// A soft plucked melody so it's obvious audio is playing.
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

const scaleA = [0, 3, 5, 7, 10, 12, 10, 7, 5, 3, 0, -2, 0, 3, 7, 12];
const scaleB = [12, 10, 7, 5, 3, 0, 3, 5, 7, 10, 12, 15, 12, 10, 7, 5];

fs.writeFileSync(path.join(dir, '01 - Part One.wav'), wav(melody([...scaleA, ...scaleA, ...scaleB, ...scaleA], 0.9)));
fs.writeFileSync(path.join(dir, '02 - Part Two.wav'), wav(melody([...scaleB, ...scaleA, ...scaleB, ...scaleB], 0.9)));
console.log('wrote 2 sample tracks');

// Cover: warm gradient with concentric rings.
const S = 512;
const png = new PNG({ width: S, height: S });
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const idx = (S * y + x) << 2;
    const d = Math.hypot(x - S / 2, y - S / 2) / (S / 2);
    const ring = Math.sin(d * 22) * 0.5 + 0.5;
    png.data[idx] = Math.round(0x8a + ring * 30 - d * 60);
    png.data[idx + 1] = Math.round(0x5a + ring * 22 - d * 40);
    png.data[idx + 2] = Math.round(0x52 + ring * 20 - d * 30);
    png.data[idx + 3] = 255;
  }
}
fs.writeFileSync(path.join(dir, 'cover.png'), PNG.sync.write(png));
console.log('wrote cover.png');
