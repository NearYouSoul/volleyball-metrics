// Геометрия площадки: координаты, зоны, расстановки. Общий модуль для движка, 3D-площадки и дашборда.
//
// Система координат — в метрах, как будто стоим за своей лицевой линией и смотрим на сетку:
//   x: 0 … 9   — слева направо;
//   y: 0 … 18  — от нашей лицевой линии (0) к их лицевой (18). Сетка на y = 9,
//                линии атаки на y = 6 (у нас) и y = 12 (у них).
// Точки за пределами 0…9 × 0…18 — это аут или зона подачи.

export const W = 9, L = 18, NET = 9, ATTACK = 3;
export const NET_H = 2.43; // мужская сетка; на 3D-сцене высоту можно поменять в настройках

// Где стоит игрок каждой зоны на нашей половине (базовая расстановка, без перемещений).
export const ZONE_SPOT = {
  1: { x: 7.4, y: 1.6 }, 6: { x: 4.5, y: 2.4 }, 5: { x: 1.6, y: 1.6 },
  2: { x: 7.4, y: 7.6 }, 3: { x: 4.5, y: 7.9 }, 4: { x: 1.6, y: 7.6 },
};

export const inCourt = p => p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= L;
export const side = p => (p.y < NET ? 'us' : 'them');

// Зона 1–6 по классической схеме, с точки зрения той команды, на чьей половине точка.
// У соперника лево/право зеркальны: их зона 4 — это наш правый край.
export function zoneOf(p) {
  if (!p) return null;
  const ours = p.y < NET;
  const depth = ours ? NET - p.y : p.y - NET; // расстояние от сетки
  const front = depth <= ATTACK;
  const col = p.x < 3 ? 0 : p.x <= 6 ? 1 : 2; // 0 — левый край с нашей стороны
  const c = ours ? col : 2 - col; // переводим в «левый край с их стороны»
  return front ? [4, 3, 2][c] : [5, 6, 1][c];
}

// Подзона: какая из 9 «клеток» 3×3 м на половине (для тепловых карт по сетке).
export const cellOf = p => ({ cx: Math.max(0, Math.min(2, Math.floor(p.x / 3))), cy: Math.max(0, Math.min(5, Math.floor(p.y / 3))) });

// ---------- Расстановки ----------
// lineup — шестеро в порядке подачи. z1 — индекс игрока, который сейчас стоит в зоне 1.
// Следующий подающий стоит в зоне 2, через одного — в зоне 3 и т. д.
const ZONE_BY_STEP = [1, 2, 3, 4, 5, 6];
export const zoneOfSlot = (slot, z1) => ZONE_BY_STEP[(slot - z1 + 6) % 6];
export const isFront = zone => zone >= 2 && zone <= 4;

// Зоны всех шести слотов: [зона слота 0, зона слота 1, …].
export const slotZones = z1 => [0, 1, 2, 3, 4, 5].map(s => zoneOfSlot(s, z1));

// Расстановка (Р1…Р6) называется по зоне, где стоит основной связующий — как в DataVolley/VolleyStation.
export const rotationOf = (setterSlot, z1) => zoneOfSlot(setterSlot < 0 ? 0 : setterSlot, z1);

// Схемы игры. Связующий в схеме — подсказка, кто вероятнее всего делает пас (его можно поменять в каждом касании).
//   5-1 — один связующий; 4-2 — двое, пасует тот, кто в передней линии; 6-2 — двое, пасует тот, кто в задней;
//   hybrid — без либеро и без жёстких ролей: пасует основной связующий, если на площадке, иначе любой отмеченный.
export const SYSTEMS = {
  '5-1': 'Один связующий (5-1)',
  '4-2': 'Два связующих, пасует передний (4-2)',
  '6-2': 'Два связующих, пасует задний (6-2)',
  hybrid: 'Гибрид без либеро',
};

export function guessSetter({ system = '5-1', lineup, zones, setters, main }) {
  const onCourt = lineup.map((id, slot) => ({ id, zone: zones[slot] })).filter(p => setters.has(p.id));
  if (!onCourt.length) return null;
  if (system === '4-2') return (onCourt.find(p => isFront(p.zone)) ?? onCourt[0]).id;
  if (system === '6-2') return (onCourt.find(p => !isFront(p.zone)) ?? onCourt[0]).id;
  return (onCourt.find(p => p.id === main) ?? onCourt[0]).id;
}

// ---------- Направления паса ----------
// Куда отдан пас — по точке паса или по зоне нападающего. Названия — как говорят на площадке.
export const SET_DIRS = {
  4: 'Край (4)', 3: 'Центр (3)', 2: 'Диагональ (2)', pipe: 'Пайп (6)', 1: 'Задняя (1)', 5: 'Задняя (5)', dump: 'Скидка',
};
export function setDir(point, attackerZone) {
  const z = point && point.y < NET ? zoneOf(point) : attackerZone;
  if (!z) return null;
  if (z === 6) return 'pipe';
  return z;
}

// Темп паса: высота верхней точки траектории над полом (м).
export const TEMPOS = {
  q: { label: 'Быстрый (1 темп)', short: '1т', h: 3.1 },
  f: { label: 'Быстрый высокий (2 темп)', short: '2т', h: 4.2 },
  h: { label: 'Высокий (3 темп)', short: '3т', h: 6.2 },
};

// Точки по умолчанию, если их не кликнули.
export const DEFAULT_SPOT = {
  setter: { x: 6.2, y: 8.2 }, // связующий у сетки чуть правее центра
  serveUs: { x: 7.5, y: -1.2 },
  serveThem: { x: 1.5, y: 19.2 },
};

// ---------- Роли игроков ----------
// Связующий, диагональный, доигровщик, центральный блокирующий, либеро. Команда может играть и без либеро,
// с двумя центральными и тремя доигровщиками, которые меняются между собой.
export const ROLES = {
  s: { name: 'Связующий', short: 'С' },
  opp: { name: 'Диагональный', short: 'Д' },
  oh: { name: 'Доигровщик', short: 'ДИ' },
  mb: { name: 'Центральный', short: 'ЦБ' },
  l: { name: 'Либеро', short: 'Л' },
};
// Старые составы хранили только галочку «связующий» — подхватываем её.
export const roleOf = p => p?.role || (p?.setter ? 's' : '');
