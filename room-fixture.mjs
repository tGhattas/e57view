// SPDX-License-Identifier: GPL-3.0-only
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export function roomPly(path, sx = 6, sy = 4, sz = 3, step = 0.05, x0 = 12, y0 = 8, z0 = 20) {
  const nx = Math.round(sx / step) + 1, ny = Math.round(sy / step) + 1, nz = Math.round(sz / step) + 1;
  const rows = [];
  const add = (x, y, z, n) => rows.push(`${(x0 + x).toFixed(4)} ${(y0 + y).toFixed(4)} ${(z0 + z).toFixed(4)} ${n[0]} ${n[1]} ${n[2]} 190 180 160`);
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    add(i * step, j * step, 0, [0, 0, 1]);          // floor, facing up into the room
    add(i * step, j * step, sz, [0, 0, -1]);        // ceiling, facing down
  }
  for (let j = 1; j < ny - 1; j++) for (let k = 1; k < nz - 1; k++) {
    add(0, j * step, k * step, [1, 0, 0]);
    add(sx, j * step, k * step, [-1, 0, 0]);
  }
  for (let i = 1; i < nx - 1; i++) for (let k = 1; k < nz - 1; k++) {
    add(i * step, 0, k * step, [0, 1, 0]);
    add(i * step, sy, k * step, [0, -1, 0]);
  }
  const L = ['ply', 'format ascii 1.0', `element vertex ${rows.length}`,
    'property float x', 'property float y', 'property float z',
    'property float nx', 'property float ny', 'property float nz',
    'property uchar red', 'property uchar green', 'property uchar blue', 'end_header', ...rows];
  writeFileSync(path, L.join('\n'));
  return { n: rows.length, sx, sy, sz, step };
}
