// Generates the PWA icons: warm gradient, two overlapping listener dots, play triangle.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

function lerp(a, b, t) { return a + (b - a) * t; }

function makeIcon(size) {
  const png = new PNG({ width: size, height: size });
  const cx1 = size * 0.38, cy = size * 0.46, r = size * 0.21;
  const cx2 = size * 0.62;
  // play triangle centred lower
  const tx = size * 0.5, ty = size * 0.72, ts = size * 0.1;

  const inCircle = (x, y, cx, cyy, rr) => (x - cx) ** 2 + (y - cyy) ** 2 <= rr * rr;
  const inTriangle = (x, y) => {
    const x0 = tx - ts * 0.7, y0 = ty - ts, x1 = tx - ts * 0.7, y1 = ty + ts, x2 = tx + ts, y2 = ty;
    const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    const a = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / d;
    const b = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / d;
    const c = 1 - a - b;
    return a >= 0 && b >= 0 && c >= 0;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (size * y + x) << 2;
      const t = (x + y) / (2 * size);
      // warm dark gradient background
      let R = lerp(0x2a, 0x18, t), G = lerp(0x1c, 0x12, t), B = lerp(0x18, 0x10, t);

      const inA = inCircle(x, y, cx1, cy, r);
      const inB = inCircle(x, y, cx2, cy, r);
      if (inA && inB) { R = 0xf3; G = 0xe9; B = 0xe2; }        // overlap: cream
      else if (inA)   { R = 0xe0; G = 0x91; B = 0x8b; }        // rose
      else if (inB)   { R = 0x8b; G = 0xb8; B = 0xe0; }        // blue
      if (inTriangle(x, y)) { R = 0xf3; G = 0xe9; B = 0xe2; }

      png.data[idx] = Math.round(R);
      png.data[idx + 1] = Math.round(G);
      png.data[idx + 2] = Math.round(B);
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

for (const [name, size] of [['icon-512.png', 512], ['icon-192.png', 192], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(path.join(outDir, name), makeIcon(size));
  console.log('wrote', name);
}
