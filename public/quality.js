// Зоны качества доводки: куда пришёл мяч ко второму касанию (к связующему) → оценка приёма/защиты.
// Наша половина разбита на клетки 0,5 × 0,5 м (18 × 18). Каждая клетка — '3' (++), '2' (+), '1' (−).
// Хранится строкой из 324 символов в настройках (settings.qualityZones) — зоны любой формы, хоть буквой Г.
import { W, NET } from './court.js';

export const CELL = 0.5;
export const COLS = Math.round(W / CELL), ROWS = Math.round(NET / CELL);
export const GRADES = {
  3: { res: 'pp', label: '++', name: 'Идеально (++)', color: '#59d499' },
  2: { res: 'pm', label: '+', name: 'Хороший (+)', color: '#63a1ff' },
  1: { res: 'p', label: '−', name: 'Плохой (−)', color: '#f0c85a' },
};

// Зоны по умолчанию: «++» — у сетки правее центра, где обычно стоит связующий;
// «+» — буквой Г: вдоль сетки и по трёхметровой линии; остальное — «−».
export function defaultZones() {
  let s = '';
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const x = (c + 0.5) * CELL, y = (r + 0.5) * CELL; // y — от нашей лицевой (0) к сетке (9)
    let g = 1;
    if ((x >= 3 && x <= 8.5 && y >= 6) || (x >= 1.5 && y >= 7.5)) g = 2;
    if (x >= 4.5 && x <= 7.5 && y >= 7) g = 3;
    s += g;
  }
  return s;
}

export const valid = z => typeof z === 'string' && z.length === COLS * ROWS && /^[123]+$/.test(z);
export const zonesOf = settings => (valid(settings?.qualityZones) ? settings.qualityZones : defaultZones());

// Оценка по точке второго касания. Мяч ушёл на их сторону — перекид.
export function gradeAt(zones, p) {
  if (!p) return null;
  if (p.y >= NET) return 'over';
  const c = Math.max(0, Math.min(COLS - 1, Math.floor(p.x / CELL)));
  const r = Math.max(0, Math.min(ROWS - 1, Math.floor(p.y / CELL)));
  return GRADES[zones[r * COLS + c]].res;
}

// Для защиты шкала короче: ++ и + — «защита +», − — «защита −».
export const digRes = rec => (rec === 'over' ? 'over' : rec === 'p' ? 'minus' : 'plus');
