import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, FIELDS, READY, SPEED, sampleAction, monotone, actTime, jumpAt, arcAt, arcVelocity, flightTime, legDrop } from '../public/studio/motion.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('ключевые позы: в ключевой момент — ровно эта поза, каждое движение начинается и кончается стойкой', () => {
  for (const [type, A] of Object.entries(ACTIONS)) {
    for (const [t, pose] of A.keys) {
      const P = sampleAction(type, t);
      for (const f of FIELDS) near(P[f], pose[f]);
    }
    const end = sampleAction(type, A.dur);
    for (const f of FIELDS) if (f !== 'fwd') near(end[f], READY[f]);
    assert.ok(A.tc > 0 && A.tc < A.dur, `${type}: касание внутри движения`);
    assert.ok(A.keys.every(([, p]) => FIELDS.every(f => Number.isFinite(p[f]))), `${type}: все поля заданы`);
  }
});

test('плавная кривая не выходит за соседние ключевые значения (нет «перелётов» суставов)', () => {
  const ts = [0, 0.3, 0.5, 1.2], vs = [0, 1, 1, -2];
  for (let t = 0; t <= 1.2; t += 0.01) {
    const v = monotone(ts, vs, t);
    const i = Math.min(2, ts.findIndex((x, k) => t >= x && t <= ts[k + 1]));
    const lo = Math.min(vs[i], vs[i + 1]) - 1e-9, hi = Math.max(vs[i], vs[i + 1]) + 1e-9;
    assert.ok(v >= lo && v <= hi, `t=${t.toFixed(2)}: ${v} в [${lo}, ${hi}]`);
  }
});

test('разбег: вперёд без шагов назад, удар в верхней точке прыжка', () => {
  let prev = -1;
  for (let s = 0; s <= ACTIONS.att.dur; s += 0.01) {
    const f = sampleAction('att', s).fwd;
    assert.ok(f >= prev - 1e-9, `разбег не идёт назад (s=${s.toFixed(2)})`);
    prev = f;
  }
  const [up, down] = ACTIONS.att.air, H = 0.8;
  const peak = (up + down) / 2;
  assert.ok(Math.abs(ACTIONS.att.tc - peak) < 0.05, 'касание — у вершины прыжка');
  assert.ok(jumpAt('att', ACTIONS.att.tc, H) > H * 0.98);
  assert.equal(jumpAt('att', up - 0.01, H), 0);
  assert.equal(jumpAt('att', down + 0.01, H), 0);
});

test('держит мяч: движение стоит в момент касания и продолжается с момента броска', () => {
  const act = { t0: 1000, tc: 300, hold: true, rel: null };
  near(actTime(act, 1100), (100 / 1000) * SPEED);
  near(actTime(act, 1300), (300 / 1000) * SPEED);
  near(actTime(act, 5000), (300 / 1000) * SPEED); // ждёт сколько угодно
  act.rel = 6000;
  near(actTime(act, 5500), (300 / 1000) * SPEED);
  near(actTime(act, 6200), (500 / 1000) * SPEED); // продолжает с позы касания, без рывка
  near(actTime({ t0: 1000, tc: 300, hold: false }, 1800), (800 / 1000) * SPEED);
});

test('полёт мяча: из точки в точку, вершина дуги, скорость в конце', () => {
  const p0 = { x: 0, y: 2.5, z: 0 }, p1 = { x: 3, y: 3, z: -1 };
  const a = arcAt(p0, p1, 6, 0), b = arcAt(p0, p1, 6, 1), m = arcAt(p0, p1, 6, 0.5);
  assert.deepEqual(a, p0); assert.deepEqual(b, p1);
  near(m.y, 6);
  const T = 1.2, v = arcVelocity(p0, p1, 6, T), h = 1e-5;
  const q = arcAt(p0, p1, 6, 1 - h);
  near(v.x, (p1.x - q.x) / (h * T), 1e-3); near(v.y, (p1.y - q.y) / (h * T), 1e-3);
  assert.ok(v.y < 0, 'в конце дуги мяч падает');
});

test('время полёта: высокий пас дольше быстрого, удар быстрее паса, всё реалистично', () => {
  const high = flightTime('set', 3, 2.5, 3, 6.2), quick = flightTime('set', 1, 2.5, 3, 3.1);
  assert.ok(high > 1.4 && high < 2, `высокий пас ~1,7 с: ${high}`);
  assert.ok(quick > 0.3 && quick < 0.7, `быстрый пас ~0,5 с: ${quick}`);
  const spike = flightTime('att', 7, 3.1, 0.12, 3.25);
  assert.ok(spike < 0.6 && spike < quick + 0.2, `удар быстрый: ${spike}`);
  const serve = flightTime('serve', 18, 2.7, 0.8, 4.2);
  assert.ok(serve > 1 && serve < 2, `подача ~1,4 с: ${serve}`);
});

test('ноги: прямая нога — полная длина, в стойке таз ниже, на приёме — ещё ниже', () => {
  const T = 0.44, S = 0.48;
  near(legDrop(0, 0, 0, 0, T, S), T + S);
  const ready = legDrop(READY.hL, READY.abL, READY.kL, READY.fL, T, S);
  const rec = sampleAction('rec', ACTIONS.rec.tc);
  const low = legDrop(rec.hL, rec.abL, rec.kL, rec.fL, T, S);
  assert.ok(ready < T + S - 0.04 && low < ready - 0.12, `стойка ${ready.toFixed(2)}, приём ${low.toFixed(2)}`);
});
