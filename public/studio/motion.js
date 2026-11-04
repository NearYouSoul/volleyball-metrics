// Движения игроков и полёт мяча — чистая математика, без three.js (проверяется тестами в node).
//
// Поза — набор углов суставов (радианы):
//   ноги:  hL/hR — бедро вперёд, abL/abR — бедро в сторону, kL/kR — сгиб колена, fL/fR — носок вниз (+) / пятка (−);
//   корпус: lean — наклон вперёд, twist — поворот (− правое плечо назад, замах), roll — крен; head — взгляд вверх;
//   руки:  sL/sR — плечо (0 — рука вниз, π/2 — вперёд, π — вверх, больше π — за голову), szL/szR — локоть в сторону,
//          eL/eR — сгиб локтя; fing — пальцы (0 — собраны, 1 — растопырены, как на блоке);
//   fwd — сколько метров игрок пробежал по ходу движения (разбег, подача).
// Движение — ключевые позы во времени (секунды «как в жизни»); между ними — плавная монотонная кривая
// (без перелётов и рывков). На экране всё идёт в SPEED раз быстрее жизни.

export const SPEED = 1.4;
export const GRAVITY = 9.81;

export const FIELDS = ['hL', 'abL', 'kL', 'fL', 'hR', 'abR', 'kR', 'fR', 'lean', 'twist', 'roll', 'head', 'sL', 'szL', 'eL', 'sR', 'szR', 'eR', 'fing', 'fwd'];

// Базовая стойка: ноги шире плеч, колени согнуты, корпус вперёд, вес на носках, правая нога чуть впереди,
// руки согнуты перед собой на уровне пояса.
export const READY = {
  hL: 0.42, abL: 0.17, kL: 0.84, fL: 0.1, hR: 0.55, abR: 0.17, kR: 0.88, fR: 0.1,
  lean: 0.52, twist: 0, roll: 0, head: 0.45,
  sL: 0.8, szL: 0.2, eL: 1.25, sR: 0.8, szR: 0.2, eR: 1.25, fing: 0.2, fwd: 0,
};

// Ключевые позы: каждая следующая — изменения к предыдущей.
function seq(base, list) {
  let cur = { ...base };
  return list.map(([t, p]) => { cur = { ...cur, ...p }; return [t, cur]; });
}

// Приём снизу: низкая широкая стойка, таз опущен, прямые руки «площадкой» вперёд-вниз, взгляд на мяч.
const REC = { hL: 0.85, abL: 0.32, kL: 1.45, fL: 0.05, hR: 0.92, abR: 0.32, kR: 1.5, fR: 0.05, lean: 0.55, head: 0.6, sL: 1.38, szL: -0.36, eL: 0.04, sR: 1.38, szR: -0.36, eR: 0.04, fing: 0 };
// Пас сверху: кисти над лбом «ковшом», локти в стороны.
const SET_UP = { hL: 0.3, abL: 0.12, kL: 0.6, fL: 0.12, hR: 0.36, abR: 0.12, kR: 0.64, fR: 0.12, lean: 0.04, head: 0.5, sL: 2.6, szL: 0.4, eL: 1.8, sR: 2.6, szR: 0.4, eR: 1.8, fing: 0.75 };

// Движения. tc — момент касания мяча (мяч прилетает ровно в tc; игрок «держит» эту позу, пока не решено,
// куда мяч полетит дальше). air — [отрыв, приземление]: высота прыжка считается по параболе.
export const ACTIONS = {
  rec: {
    tc: 0.42, dur: 0.95, anchor: 'platform', keys: seq(READY, [
      [0, {}],
      [0.22, { hL: 0.7, kL: 1.25, hR: 0.76, kR: 1.3, abL: 0.28, abR: 0.28, lean: 0.5, head: 0.5, sL: 1.05, sR: 1.05, eL: 0.45, eR: 0.45, szL: -0.2, szR: -0.2 }],
      [0.42, REC],
      [0.6, { hL: 0.6, kL: 1.0, hR: 0.64, kR: 1.02, lean: 0.42, sL: 1.75, sR: 1.75 }],
      [0.95, READY],
    ]),
  },
  dig: {
    tc: 0.36, dur: 0.95, anchor: 'platform', keys: seq(READY, [
      [0, {}],
      [0.18, { hL: 0.75, kL: 1.35, hR: 0.8, kR: 1.4, abL: 0.3, abR: 0.3, lean: 0.55, sL: 1.0, sR: 1.0, eL: 0.4, eR: 0.4, szL: -0.2, szR: -0.2 }],
      [0.36, { ...REC, hL: 0.95, kL: 1.65, hR: 1.0, kR: 1.7, abL: 0.38, abR: 0.38, lean: 0.62, sL: 1.4, sR: 1.4 }],
      [0.55, { hL: 0.7, kL: 1.2, hR: 0.72, kR: 1.2, lean: 0.48, sL: 1.6, sR: 1.6 }],
      [0.95, READY],
    ]),
  },
  set: {
    tc: 0.45, dur: 1.15, anchor: 'hands', keys: seq(READY, [
      [0, {}],
      [0.28, SET_UP],
      [0.45, { hL: 0.38, kL: 0.76, hR: 0.42, kR: 0.8, eL: 1.9, eR: 1.9 }], // мяч в ладонях: чуть «приседает» под него
      [0.62, { hL: 0.06, kL: 0.14, fL: 0.4, hR: 0.08, kR: 0.16, fR: 0.4, sL: 2.95, sR: 2.95, eL: 0.25, eR: 0.25, fing: 0.9, lean: -0.05 }],
      [0.8, { sL: 2.85, sR: 2.85, eL: 0.15, eR: 0.15 }],
      [1.15, READY],
    ]),
  },
  // Нападающий удар правой с разбега в три шага (левая — правая — левая): шаг-«прицел», длинный низкий
  // предпоследний шаг с махом обеих рук назад, постановка ног и мах руками вверх, прыжок, «лук»
  // (левая рука на мяч, правая за головой, корпус прогнут), удар в верхней точке, приземление на две ноги.
  att: {
    tc: 1.22, dur: 1.95, anchor: 'spike', air: [0.9, 1.56], keys: seq(READY, [
      [0, { hL: 0.25, kL: 0.5, hR: 0.28, kR: 0.52, lean: 0.3, sL: 0.3, eL: 0.3, sR: 0.3, eR: 0.3, szL: 0.1, szR: 0.1, head: 0.25, fwd: 0 }],
      [0.3, { hL: 0.45, kL: 0.35, fL: 0, hR: -0.35, kR: 0.75, fR: 0.4, lean: 0.38, sL: -0.35, eL: 0.2, sR: -0.35, eR: 0.2, fwd: 0.7 }],
      [0.52, { hL: -0.4, kL: 0.55, fL: 0.4, hR: 0.75, kR: 1.0, fR: 0, lean: 0.55, sL: -1.0, eL: 0.1, sR: -1.0, eR: 0.1, fwd: 1.35 }],
      [0.68, { hL: -0.45, kL: 0.9, fL: 0.5, hR: 0.6, kR: 0.45, fR: -0.15, lean: 0.62, sL: -1.35, eL: 0.05, sR: -1.35, eR: 0.05, head: 0.4, fwd: 1.95 }],
      [0.8, { hL: 0.85, kL: 1.45, fL: -0.1, hR: 0.9, kR: 1.5, fR: 0, abL: 0.15, abR: 0.15, lean: 0.5, sL: 0.2, eL: 0.15, sR: 0.2, eR: 0.15, head: 0.45, fwd: 2.3 }],
      [0.9, { hL: 0.2, kL: 0.3, fL: 0.6, hR: 0.22, kR: 0.32, fR: 0.6, lean: 0.12, sL: 2.3, eL: 0.25, sR: 2.4, eR: 0.4, head: 0.5, fwd: 2.42 }],
      [1.02, { hL: 0.05, kL: 0.35, fL: 0.75, hR: 0.1, kR: 0.45, fR: 0.75, lean: -0.05, sL: 2.75, eL: 0.2, szL: 0.1, sR: 3.05, eR: 1.1, szR: 0.3, twist: -0.2, head: 0.45, fwd: 2.55 }],
      [1.13, { hL: -0.15, kL: 0.85, fL: 0.7, hR: -0.1, kR: 0.75, fR: 0.7, lean: -0.32, twist: -0.5, sL: 2.8, eL: 0.12, szL: 0.12, sR: 3.6, eR: 2.15, szR: 0.45, head: 0.4, fwd: 2.66 }],
      [1.22, { hL: 0.25, kL: 0.55, hR: 0.2, kR: 0.5, lean: 0.12, twist: 0.25, sL: 0.9, eL: 1.4, szL: 0.15, sR: 2.75, eR: 0.03, szR: 0.12, head: 0.3, fwd: 2.75 }],
      [1.36, { hL: 0.45, kL: 0.6, hR: 0.4, kR: 0.55, lean: 0.42, twist: 0.42, sL: 0.6, eL: 1.1, sR: 1.0, eR: 0.2, szR: -0.35, head: 0.15, fwd: 2.85 }],
      [1.56, { hL: 0.8, kL: 1.35, fL: 0.1, hR: 0.85, kR: 1.4, fR: 0.1, abL: 0.2, abR: 0.2, lean: 0.45, twist: 0.1, sL: 0.6, eL: 0.8, sR: 0.55, eR: 0.7, szR: 0.1, fwd: 2.95 }],
      [1.95, { ...READY, fwd: 2.95 }],
    ]),
  },
  // Блок: присед → прыжок вертикально, прямые руки вверх и чуть вперёд над сеткой, кисти широко, пальцы растопырены.
  blk: {
    tc: 0.52, dur: 1.15, anchor: 'block', air: [0.27, 0.84], keys: seq(READY, [
      [0, { hL: 0.35, kL: 0.7, hR: 0.36, kR: 0.72, abL: 0.12, abR: 0.12, lean: 0.08, sL: 2.0, szL: 0.2, eL: 1.7, sR: 2.0, szR: 0.2, eR: 1.7, head: 0.2, fing: 0.5 }],
      [0.18, { hL: 0.6, kL: 1.15, hR: 0.6, kR: 1.15, lean: 0.15, sL: 1.85, eL: 1.75, sR: 1.85, eR: 1.75 }],
      [0.27, { hL: 0.15, kL: 0.3, fL: 0.5, hR: 0.15, kR: 0.3, fR: 0.5, lean: 0.06, sL: 2.5, eL: 0.9, sR: 2.5, eR: 0.9 }],
      [0.45, { hL: 0.05, kL: 0.22, fL: 0.75, hR: 0.05, kR: 0.22, fR: 0.75, lean: 0.1, sL: 2.9, szL: 0.13, eL: 0.02, sR: 2.9, szR: 0.13, eR: 0.02, fing: 1, head: 0.15 }],
      [0.6, { sL: 2.8, sR: 2.8 }],
      [0.84, { hL: 0.55, kL: 1.05, fL: 0.1, hR: 0.55, kR: 1.05, fR: 0.1, sL: 2.1, eL: 1.2, sR: 2.1, eR: 1.2, lean: 0.12, fing: 0.4 }],
      [1.15, READY],
    ]),
  },
  // Подача в прыжке: мяч в левой руке, подброс, два шага, прыжок, замах и удар правой.
  serve: {
    tc: 1.04, dur: 1.75, anchor: 'spike', air: [0.78, 1.4], toss: 0.35, keys: seq(READY, [
      [0, { hL: 0.12, kL: 0.25, hR: 0.12, kR: 0.25, abL: 0.1, abR: 0.1, lean: 0.15, sL: 0.75, eL: 1.2, sR: 0.3, eR: 0.3, head: 0.1, fwd: 0 }],
      [0.35, { sL: 2.9, eL: 0.1, sR: 0.2, lean: 0.05, head: 0.5, hL: 0.25, kL: 0.45, hR: -0.2, kR: 0.4, fwd: 0.35 }],
      [0.55, { hL: -0.3, kL: 0.6, hR: 0.7, kR: 0.9, sL: 2.6, sR: -0.8, eR: 0.2, lean: 0.45, fwd: 0.9 }],
      [0.7, { hL: 0.8, kL: 1.35, hR: 0.85, kR: 1.4, sL: 0.5, sR: 0.3, eL: 0.2, eR: 0.2, lean: 0.45, fwd: 1.3 }],
      [0.78, { hL: 0.2, kL: 0.3, fL: 0.6, hR: 0.2, kR: 0.3, fR: 0.6, sL: 2.4, sR: 2.6, eR: 0.6, lean: 0.1, fwd: 1.4 }],
      [0.95, { hL: -0.1, kL: 0.7, hR: -0.1, kR: 0.7, sL: 2.8, eL: 0.15, sR: 3.55, eR: 2.1, szR: 0.4, twist: -0.45, lean: -0.28, fwd: 1.6 }],
      [1.04, { sL: 0.9, eL: 1.3, sR: 2.8, eR: 0.03, szR: 0.1, twist: 0.25, lean: 0.1, hL: 0.2, kL: 0.5, hR: 0.2, kR: 0.5, fwd: 1.7 }],
      [1.2, { sR: 1.0, szR: -0.3, eR: 0.2, twist: 0.4, lean: 0.4, fwd: 1.85 }],
      [1.4, { hL: 0.75, kL: 1.3, hR: 0.8, kR: 1.3, sL: 0.6, sR: 0.6, eL: 0.8, eR: 0.8, lean: 0.4, fwd: 1.95 }],
      [1.75, { ...READY, fwd: 1.95 }],
    ]),
  },
};

// Монотонная кубическая интерполяция (Фриче — Карлсон): гладко, без перелётов за ключевые значения.
export function monotone(ts, vs, t) {
  const n = ts.length;
  if (t <= ts[0]) return vs[0];
  if (t >= ts[n - 1]) return vs[n - 1];
  let i = 0;
  while (t > ts[i + 1]) i++;
  const h = ts[i + 1] - ts[i];
  const slope = k => {
    if (k <= 0 || k >= n - 1) return 0; // на краях — плавный старт и остановка
    const h0 = ts[k] - ts[k - 1], h1 = ts[k + 1] - ts[k];
    const d0 = (vs[k] - vs[k - 1]) / h0, d1 = (vs[k + 1] - vs[k]) / h1;
    if (d0 * d1 <= 0) return 0;
    return (3 * (h0 + h1)) / ((2 * h1 + h0) / d0 + (h1 + 2 * h0) / d1);
  };
  const m0 = slope(i), m1 = slope(i + 1), u = (t - ts[i]) / h;
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * vs[i] + (u3 - 2 * u2 + u) * h * m0 + (-2 * u3 + 3 * u2) * vs[i + 1] + (u3 - u2) * h * m1;
}

// Кэш: для каждого движения — столбцы значений по полям (быстрее, чем собирать на каждом кадре).
const cols = new Map();
function columns(type) {
  if (!cols.has(type)) {
    const keys = ACTIONS[type].keys;
    const ts = keys.map(k => k[0]);
    cols.set(type, { ts, v: Object.fromEntries(FIELDS.map(f => [f, keys.map(k => k[1][f])])) });
  }
  return cols.get(type);
}

// Поза движения в момент s (секунды «как в жизни» от начала движения).
export function sampleAction(type, s, out = {}) {
  const c = columns(type);
  for (const f of FIELDS) out[f] = monotone(c.ts, c.v[f], s);
  return out;
}

// Высота прыжка в момент s: парабола между отрывом и приземлением, вершина — H.
export function jumpAt(type, s, H) {
  const air = ACTIONS[type]?.air;
  if (!air || s <= air[0] || s >= air[1]) return 0;
  const u = (s - air[0]) / (air[1] - air[0]);
  return 4 * H * u * (1 - u);
}

// Время движения на экране. Если игрок держит мяч (касание отмечено, а следующее — ещё нет), движение
// останавливается в момент касания и продолжается с момента «отпустили» (rel).
// Все времена — в мс экрана; результат — секунды «как в жизни».
export function actTime(act, now) {
  const tcAbs = act.t0 + act.tc;
  let ms;
  if (!act.hold || now < tcAbs) ms = now - act.t0;
  else if (act.rel == null || now < act.rel) ms = act.tc;
  else ms = act.tc + (now - Math.max(act.rel, tcAbs));
  return (Math.max(0, ms) / 1000) * SPEED;
}

// Полёт мяча: по горизонтали — равномерно, по высоте — парабола (так летит мяч при постоянной силе тяжести).
export function arcAt(p0, p1, apex, u) {
  const k = Math.max(0, apex - (p0.y + p1.y) / 2);
  return {
    x: p0.x + (p1.x - p0.x) * u,
    y: p0.y + (p1.y - p0.y) * u + 4 * k * u * (1 - u),
    z: p0.z + (p1.z - p0.z) * u,
  };
}
// Скорость в конце полёта (м/с, «как в жизни») — дальше мяч летит сам: падает, отскакивает, катится.
export function arcVelocity(p0, p1, apex, T) {
  const k = Math.max(0, apex - (p0.y + p1.y) / 2);
  return { x: (p1.x - p0.x) / T, y: (p1.y - p0.y - 4 * k) / T, z: (p1.z - p0.z) / T };
}

// Сколько летит мяч (секунды «как в жизни»). Навесом — по высоте дуги и силе тяжести;
// удар и подача соперника в атаку — быстро и почти прямо.
const DRIVE = { att: 19, spike: 16 };
export function flightTime(kind, dist, y0, y1, apex) {
  if (DRIVE[kind]) return Math.max(0.18, dist / DRIVE[kind] + 0.05);
  const top = Math.max(apex, y0 + 0.05, y1 + 0.05);
  const up = Math.sqrt((2 * (top - y0)) / GRAVITY), down = Math.sqrt((2 * (top - y1)) / GRAVITY);
  return Math.max(0.3, up + down);
}

// Насколько опущен таз над полом при данной позе ног: самая «длинная» нога стоит на полу.
// thigh, shin — длины бедра и голени (shin — от колена до подошвы).
export function legDrop(h, ab, k, f, thigh, shin) {
  const ankleH = 0.06;
  const foot = f > 0 ? 0.13 * Math.sin(f) : 0.04 * Math.sin(-f); // на носке / на пятке
  return (thigh * Math.cos(h) + (shin - ankleH) * Math.cos(h - k)) * Math.cos(ab) + ankleH + foot;
}

// Бег: ноги и руки по фазе шага, в сторону — приставными шагами. vf, vs — скорость вперёд/вбок (м/с) в системе игрока.
// w — насколько бег виден на ногах (во время приёма игрок ещё добегает), arms — на руках.
export function gait(P, phase, vf, vs, w = 1, arms = 1) {
  const sp = Math.hypot(vf, vs);
  const run = Math.min(1, sp / 3.2) * w;
  if (run < 0.01) return P;
  const cf = sp > 1e-3 ? vf / sp : 0, cs = sp > 1e-3 ? vs / sp : 0;
  const sn = Math.sin(phase), cn = Math.cos(phase);
  const A = 0.62 * run * Math.abs(cf), dir = Math.sign(cf) || 1;
  P.hL += A * sn * dir; P.hR -= A * sn * dir;
  P.kL += 0.95 * run * Math.abs(cf) * Math.max(0, cn); P.kR += 0.95 * run * Math.abs(cf) * Math.max(0, -cn);
  // Приставной шаг: ноги расходятся и сходятся.
  const side = 0.22 * run * Math.abs(cs);
  P.abL += side * (0.5 + 0.5 * sn); P.abR += side * (0.5 - 0.5 * sn);
  P.kL += 0.25 * run * Math.abs(cs) * Math.max(0, sn); P.kR += 0.25 * run * Math.abs(cs) * Math.max(0, -sn);
  // Руки — навстречу ногам, согнуты в беге.
  P.sL -= 0.7 * A * sn * dir * arms; P.sR += 0.7 * A * sn * dir * arms;
  P.eL += 0.35 * run * arms; P.eR += 0.35 * run * arms;
  P.lean += 0.14 * run * cf * arms;
  return P;
}
