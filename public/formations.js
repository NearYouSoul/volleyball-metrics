// Расстановки команды: где стоит игрок каждой зоны в каждой из шести расстановок (Р1…Р6) —
// на нашей подаче, на приёме и в защите. Атака одинаковая («по протоколу»), её считает студия.
// Расстановка внутри программы — зона связующего (r), на экране это Р1…Р6 по ходу игры — поэтому «зона в расстановке» однозначно задаёт роль игрока.
// Хранится в настройках: settings.formations[ситуация][расстановка][зона] = { x, y } (метры, см. court.js).
import { ZONE_SPOT } from './court.js';

export const SITUATIONS = {
  rec: 'Приём',
  serve: 'Наша подача',
  def: 'Защита',
  att: 'Атака',
};

// Стандартные позиции, если команда свои не задала.
const BASE = {
  // Приём: задняя линия глубже, центральный у сетки, крайний передний помогает на приёме.
  rec: { 1: { x: 7.3, y: 2.6 }, 6: { x: 4.5, y: 2.4 }, 5: { x: 1.7, y: 2.6 }, 4: { x: 1.5, y: 5.0 }, 3: { x: 4.1, y: 8.2 }, 2: { x: 7.2, y: 7.3 } },
  // Связующий на приёме «прячется» у сетки и сразу выходит пасовать.
  setterRec: { 1: { x: 8.3, y: 6.1 }, 6: { x: 5.4, y: 7.0 }, 5: { x: 2.4, y: 6.6 }, 2: { x: 6.4, y: 8.4 }, 3: { x: 5.2, y: 8.4 }, 4: { x: 2.8, y: 8.4 } },
  serve: ZONE_SPOT,
  // Защита «углом назад»: задняя линия — равнобедренный треугольник, игрок 6-й зоны у лицевой линии.
  // По умолчанию — как блок по центру: центральный у сетки, крайние отошли, сзади треугольник.
  def: { 5: { x: 1.4, y: 3.8 }, 1: { x: 7.7, y: 3.6 }, 6: { x: 4.4, y: 2.1 }, 4: { x: 1.8, y: 7.7 }, 3: { x: 4.5, y: 8.5 }, 2: { x: 7.2, y: 7.4 } },
};
// Атака: нападающие на разбеге, задняя линия — на пайп / заднюю атаку и страховку.
export const ATTACK = { 4: { x: 0.7, y: 5.6 }, 3: { x: 4.0, y: 6.5 }, 2: { x: 8.3, y: 5.6 }, 6: { x: 4.5, y: 3.0 }, 1: { x: 7.6, y: 3.0 }, 5: { x: 1.6, y: 2.4 } };
export const SETTER_SPOT = { x: 6.2, y: 8.2 };

export function defaultSpot(kind, rot, zone) {
  if (kind === 'rec' && zone === rot) return BASE.setterRec[zone];
  // Р5: связующий из 5-й зоны прячется за игроком 4-й — тот стоит у сетки (иначе нарушение расстановки).
  if (kind === 'rec' && rot === 5 && zone === 4) return { x: 1.4, y: 7.7 };
  if (kind === 'att') return zone === rot ? SETTER_SPOT : ATTACK[zone];
  return BASE[kind][zone];
}
export function spotFor(formations, kind, rot, zone) {
  return formations?.[kind]?.[rot]?.[zone] ?? defaultSpot(kind, rot, zone);
}
// Полная таблица для редактора: { 1: {x,y}, … 6 } для расстановки и ситуации.
export const tableFor = (formations, kind, rot) => Object.fromEntries([1, 2, 3, 4, 5, 6].map(z => [z, { ...spotFor(formations, kind, rot, z) }]));

// ---------- Защита в зависимости от блока ----------
// Шаблоны сняты с расстановок команды: блок по центру (один центральный), слева (4-я позиция + центральный),
// справа (центральный + 2-я позиция). Слева/справа — зеркальны. Кто «левый/центральный/правый» в передней
// линии и кто «5/6/1» в задней — берётся из базовой защиты команды для этой расстановки (по положению слева направо),
// поэтому гибридные схемы (центральный играет сзади в 6-й, а не в 1-й) работают без отдельных настроек.
const DEF_TPL = {
  center: { L: { x: 1.8, y: 7.7 }, R: { x: 7.2, y: 7.4 }, b5: { x: 1.4, y: 3.8 }, b6: { x: 4.4, y: 2.1 }, b1: { x: 7.7, y: 3.6 } },
  left: { R: { x: 7.2, y: 7.3 }, b5: { x: 0.4, y: 4.1 }, b6: { x: 5.7, y: 1.1 }, b1: { x: 7.0, y: 4.8 } },
  right: { L: { x: 1.6, y: 6.9 }, b5: { x: 1.7, y: 4.5 }, b6: { x: 3.9, y: 0.6 }, b1: { x: 8.2, y: 2.8 } },
};
export const blockSide = x => (x < 3 ? 'left' : x > 6 ? 'right' : 'center');
const NET_Y = 8.5;
const clampX = x => Math.max(0.4, Math.min(8.6, x));

// base: { зона → точка } — базовая защита; block: { x } — где наш блок. Возвращает { зона → точка } и зоны блокирующих.
export function defenseLayout(base, block) {
  const front = [2, 3, 4].sort((a, b) => base[a].x - base[b].x); // L, M, R по игровым позициям
  const back = [5, 6, 1].sort((a, b) => base[a].x - base[b].x); // 5, 6, 1 по игровым позициям
  const [L, M, Rz] = front, [b5, b6, b1] = back;
  const side = blockSide(block.x), t = DEF_TPL[side], out = {};
  let blockers;
  if (side === 'center') { out[M] = { x: clampX(block.x), y: NET_Y }; blockers = [M]; }
  else if (side === 'left') { out[L] = { x: clampX(block.x - 0.45), y: NET_Y }; out[M] = { x: clampX(block.x + 0.45), y: NET_Y }; blockers = [L, M]; }
  else { out[M] = { x: clampX(block.x - 0.45), y: NET_Y }; out[Rz] = { x: clampX(block.x + 0.45), y: NET_Y }; blockers = [M, Rz]; }
  if (t.L) out[L] = t.L;
  if (t.R) out[Rz] = t.R;
  out[b5] = t.b5; out[b6] = t.b6; out[b1] = t.b1;
  return { spots: out, blockers, side };
}

// ---------- Протокольная расстановка ----------
// В момент подачи игроки должны стоять по порядку: в линии — слева направо 4·3·2 и 5·6·1,
// каждый передний ближе к сетке, чем стоящий за ним задний (4–5, 3–6, 2–1). Подающий (зона 1 на нашей подаче) — вне правила.
export function overlapIssues(tab, { server = false } = {}) {
  const issues = [], bad = new Set();
  const skip = z => server && z === 1;
  const lr = (a, b) => { if (skip(a) || skip(b)) return; if (!(tab[a].x < tab[b].x)) { issues.push(`зона ${a} должна быть левее зоны ${b}`); bad.add(a); bad.add(b); } };
  const fb = (f, b) => { if (skip(b)) return; if (!(tab[f].y > tab[b].y)) { issues.push(`зона ${f} должна быть ближе к сетке, чем зона ${b}`); bad.add(f); bad.add(b); } };
  lr(4, 3); lr(3, 2); lr(5, 6); lr(6, 1);
  fb(4, 5); fb(3, 6); fb(2, 1);
  return { issues, bad };
}

// ---------- Атака по ролям ----------
// Игровая расстановка в атаке: в передней линии доигровщик — слева (4), центральный — в центре (3),
// диагональный — справа (2); в задней — доигровщик на пайп (6), диагональный — задняя атака из 1-й,
// центральный — страховка в 5-й. Связующий — к сетке (в том числе из задней линии).
// Если ролей нет или они повторяются — оставшиеся места занимают по зонам слева направо.
const FRONT_SPOT = { L: { x: 0.7, y: 5.6 }, M: { x: 4.0, y: 6.5 }, R: { x: 8.3, y: 5.6 } };
const BACK_SPOT = { L: { x: 1.6, y: 2.4 }, M: { x: 4.5, y: 3.0 }, R: { x: 7.6, y: 3.0 } };
const FRONT_PREF = { oh: 'L', mb: 'M', opp: 'R', s: 'R' };
const BACK_PREF = { oh: 'M', opp: 'R', mb: 'L', s: 'R', l: 'L' };
// players: [{ id, zone, role, front }]; setterId — кто пасует. Возвращает { id → точка }.
export function attackByRole(players, setterId) {
  const out = {};
  for (const [line, spots, pref] of [[true, FRONT_SPOT, FRONT_PREF], [false, BACK_SPOT, BACK_PREF]]) {
    const ps = players.filter(p => p.front === line && p.id !== setterId);
    const free = new Set(Object.keys(spots));
    const left = [];
    for (const p of ps) {
      const want = pref[p.role];
      if (want && free.has(want)) { out[p.id] = spots[want]; free.delete(want); } else left.push(p);
    }
    // Остальные — по своим зонам слева направо на свободные места.
    const order = ['L', 'M', 'R'].filter(k => free.has(k));
    const zx = z => ({ 4: 0, 3: 1, 2: 2, 5: 0, 6: 1, 1: 2 })[z];
    left.sort((a, b) => zx(a.zone) - zx(b.zone)).forEach((p, i) => { out[p.id] = spots[order[i]] ?? spots.M; });
  }
  if (setterId) out[setterId] = SETTER_SPOT;
  return out;
}

// ---------- Передняя линия по ролям ----------
// В передней линии игроки играют по амплуа: доигровщик — слева (4), центральный — в центре (3),
// связующий или диагональный — справа (2). Подписи «зона N» остаются протокольными — меняются только места.
const FRONT_ROLE_SPOT = {
  rec: { L: { x: 1.5, y: 5.0 }, M: { x: 4.1, y: 8.2 }, R: { x: 7.4, y: 7.0 }, S: { x: 6.4, y: 8.4 } },
  serve: { L: { x: 1.6, y: 7.6 }, M: { x: 4.5, y: 7.9 }, R: { x: 7.4, y: 7.6 }, S: { x: 6.6, y: 8.2 } },
  def: { L: { x: 1.8, y: 7.7 }, M: { x: 4.5, y: 8.5 }, R: { x: 7.2, y: 7.4 }, S: { x: 7.2, y: 7.4 } },
  att: { L: { x: 0.7, y: 5.6 }, M: { x: 4.0, y: 6.5 }, R: { x: 8.3, y: 5.6 }, S: SETTER_SPOT },
};
const ROLE_SIDE = { oh: 'L', mb: 'M', s: 'R', opp: 'R' };
// front: [{ zone, role }] — трое передней линии. Возвращает { зона → точка }.
export function frontByRole(kind, front) {
  const spots = FRONT_ROLE_SPOT[kind] ?? FRONT_ROLE_SPOT.serve, out = {}, free = new Set(['L', 'M', 'R']), left = [];
  // Связующий и диагональный оба хотят «справа» — связующий в приоритете.
  const order = [...front].sort((a, b) => (a.role === 's' ? -1 : b.role === 's' ? 1 : 0));
  for (const p of order) {
    const want = ROLE_SIDE[p.role];
    if (want && free.has(want)) { free.delete(want); out[p.zone] = want === 'R' && p.role === 's' ? spots.S : spots[want]; } else left.push(p);
  }
  const zx = { 4: 0, 3: 1, 2: 2 };
  const rest = ['L', 'M', 'R'].filter(k => free.has(k));
  left.sort((a, b) => zx[a.zone] - zx[b.zone]).forEach((p, i) => { out[p.zone] = spots[rest[i]]; });
  return out;
}
