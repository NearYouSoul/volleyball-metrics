// Векторная (SVG) площадка для дашборда: тепловые карты, точки, траектории, подписи зон.
// Площадка рисуется вертикально: соперник сверху, мы снизу. 1 единица SVG = 1 метр.
import { W, L, NET } from '../court.js';

const M = 1.6; // поле вокруг площадки, м
// half: 'full' | 'us' | 'them' — какую часть показать.
// Рамка сразу в координатах SVG: их половина — y 0…9, наша — 9…18.
export function frame(half = 'full') {
  const top = half === 'us' ? NET - 0.6 : -M, bottom = half === 'them' ? NET + 0.6 : L + M;
  return { x: -M, y: top, w: W + 2 * M, h: bottom - top, half };
}
// Координаты площадки → SVG (ось y перевёрнута: их лицевая линия сверху).
export const sx = p => p.x;
export const sy = p => L - p.y;

export function courtBase(half = 'full', { zones = true } = {}) {
  const f = frame(half);
  const lines = [];
  const ln = (x1, y1, x2, y2, cls = 'cl') => lines.push(`<line class="${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
  const showUs = half !== 'them', showThem = half !== 'us';
  if (showThem) lines.push(`<rect class="cf them" x="0" y="0" width="${W}" height="${NET}"/>`, `<rect class="cf atk" x="0" y="${NET - 3}" width="${W}" height="3"/>`);
  if (showUs) lines.push(`<rect class="cf us" x="0" y="${NET}" width="${W}" height="${NET}"/>`, `<rect class="cf atk" x="0" y="${NET}" width="${W}" height="3"/>`);
  if (zones) {
    for (const x of [3, 6]) { if (showThem) ln(x, 0, x, NET, 'zl'); if (showUs) ln(x, NET, x, L, 'zl'); }
  }
  if (showThem) { ln(0, 0, W, 0); ln(0, 0, 0, NET); ln(W, 0, W, NET); ln(0, NET - 3, W, NET - 3); }
  if (showUs) { ln(0, L, W, L); ln(0, NET, 0, L); ln(W, NET, W, L); ln(0, NET + 3, W, NET + 3); }
  lines.push(`<line class="net" x1="-0.6" y1="${NET}" x2="${W + 0.6}" y2="${NET}"/>`);
  return { f, svg: lines.join('') };
}

// Плотность точек на сетке с гауссовым ядром → прямоугольники с прозрачностью (одна гамма, от прозрачного к яркому).
export function heat(points, half, { cell = 0.3, sigma = 0.85, color = '#63a1ff' } = {}) {
  if (!points.length) return '';
  const f = frame(half);
  const nx = Math.ceil(f.w / cell), ny = Math.ceil(f.h / cell);
  const grid = new Float32Array(nx * ny);
  const r = Math.ceil((2.5 * sigma) / cell);
  for (const p of points) {
    const cx = Math.floor((sx(p) - f.x) / cell), cy = Math.floor((sy(p) - f.y) / cell);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const gx = cx + dx, gy = cy + dy;
      if (gx < 0 || gy < 0 || gx >= nx || gy >= ny) continue;
      const d2 = (dx * dx + dy * dy) * cell * cell;
      grid[gy * nx + gx] += (p.w ?? 1) * Math.exp(-d2 / (2 * sigma * sigma));
    }
  }
  let max = 0;
  for (const v of grid) if (v > max) max = v;
  const out = [];
  for (let gy = 0; gy < ny; gy++) for (let gx = 0; gx < nx; gx++) {
    const v = grid[gy * nx + gx] / max;
    if (v < 0.06) continue;
    out.push(`<rect x="${(f.x + gx * cell).toFixed(2)}" y="${(f.y + gy * cell).toFixed(2)}" width="${cell + 0.02}" height="${cell + 0.02}" fill="${color}" fill-opacity="${(0.08 + 0.8 * Math.pow(v, 0.8)).toFixed(2)}"/>`);
  }
  return `<g filter="url(#blur)" class="heat">${out.join('')}</g>`;
}

export function svgWrap(half, inner, { cls = '' } = {}) {
  const f = frame(half);
  return `<svg class="court2d ${cls}" viewBox="${f.x} ${f.y} ${f.w} ${f.h}" preserveAspectRatio="xMidYMid meet">
    <defs><filter id="blur" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="0.22"/></filter>
    <marker id="arr" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs>
    ${inner}</svg>`;
}
