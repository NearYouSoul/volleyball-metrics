import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay, totals, addStats } from '../public/engine.js';

const roster = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => ({ id, num: i + 1, name: id, setter: id === 'f' }));
const lineup = ['a', 'b', 'c', 'd', 'e', 'f'];
const run = events => replay({ roster, events });
const act = (skill, res, p = null) => ({ t: 'act', skill, res, p });

test('наша подача: эйс даёт очко, подаёт тот же игрок, подача посчитана', () => {
  const st = run([{ t: 'set', lineup, weServe: true }, act('serve', 'ace', 'a')]);
  assert.equal(st.set.us, 1);
  assert.equal(st.rally.server, 'a');
  assert.deepEqual(st.players.all.a.serve, { tot: 1, ace: 1, good: 0, err: 0 });
});

test('потеряли подачу, потом выиграли приём — подаёт следующий по порядку', () => {
  const st = run([
    { t: 'set', lineup, weServe: true },
    act('att', 'error', 'b'), // очко им, подают они
    act('rec', 'pp', 'c'),
    act('att', 'kill', 'd'), // сайд-аут, переход
  ]);
  assert.equal(st.set.us, 1);
  assert.equal(st.set.them, 1);
  assert.equal(st.rally.server, 'b');
  assert.deepEqual(st.players.all.a.serve, { tot: 1, ace: 0, good: 0, err: 0 }); // подача в игру
  assert.equal(st.teams.all.sideout.won, 1);
  assert.equal(st.teams.all.afterRec.pp.won, 1);
});

test('начинаем на приёме — первым подаёт игрок №1 в порядке', () => {
  const st = run([{ t: 'set', lineup, weServe: false }, act('team', 'oppError')]);
  assert.equal(st.rally.server, 'a');
});

test('связка: связующий берётся с площадки автоматически', () => {
  const st = run([{ t: 'set', lineup, weServe: false }, act('rec', 'p', 'a'), act('att', 'play', 'b'), act('att', 'kill', 'b')]);
  assert.deepEqual(st.teams.all.links['f>b'], { setter: 'f', attacker: 'b', tot: 2, kill: 1, err: 0 });
});

test('партия заканчивается на 25 с разницей 2, дальше события игнорируются', () => {
  const ev = [{ t: 'set', lineup, weServe: true }];
  for (let i = 0; i < 24; i++) ev.push({ t: 'pt', side: 'us' }, { t: 'pt', side: 'them' });
  ev.push({ t: 'pt', side: 'us' });
  assert.equal(run(ev).set.over, false); // 25:24
  ev.push({ t: 'pt', side: 'us' }, { t: 'pt', side: 'us' });
  const st = run(ev);
  assert.equal(st.set.us, 26);
  assert.equal(st.setsWon.us, 1);
});

test('плюс/минус игрока', () => {
  const st = run([{ t: 'set', lineup, weServe: false }, act('blk', 'point', 'c'), act('blk', 'out', 'c'), act('fault', 'error', 'c')]);
  assert.deepEqual(totals(st.players.all.c), { points: 1, errors: 2, diff: -1 });
});

test('статистика двух матчей складывается, связки тоже', () => {
  const m = run([{ t: 'set', lineup, weServe: false }, act('rec', 'pp', 'a'), act('att', 'kill', 'b')]);
  const sum = addStats(addStats({}, m.teams.all), m.teams.all);
  assert.deepEqual(sum.sideout, { n: 2, won: 2 });
  assert.deepEqual(sum.links['f>b'], { setter: 'f', attacker: 'b', tot: 2, kill: 2, err: 0 });
  assert.equal(addStats(addStats({}, m.players.all.b), m.players.all.b).att.kill, 2);
});

test('фазы: подача → у них → защита → у нас → атака в игру → у них', () => {
  const steps = [act('dig', 'plus', 'c'), act('att', 'play', 'b'), act('blk', 'touch', 'd'), act('team', 'back'), act('dig', 'error', 'a')];
  const phases = [];
  for (let k = 0; k <= steps.length; k++) phases.push(run([{ t: 'set', lineup, weServe: true }, ...steps.slice(0, k)]).rally.phase);
  // «не поднял» — очко им, новый розыгрыш на их подаче, поэтому в конце 'rec'
  assert.deepEqual(phases, ['serve', 'ours', 'their', 'their', 'ours', 'rec']);
  const st = run([{ t: 'set', lineup, weServe: true }, ...steps]);
  assert.deepEqual(st.players.all.c.dig, { tot: 1, plus: 1, minus: 0, over: 0, err: 0 });
  assert.deepEqual(st.players.all.a.dig, { tot: 1, plus: 0, minus: 0, over: 0, err: 1 });
  assert.deepEqual(st.players.all.a.serve, { tot: 1, ace: 0, good: 0, err: 0 }); // подача в игру засчитана сама
});

test('детальный режим: тай-брейк (3-я партия) до 15, после 2 побед новые партии игнорируются', () => {
  const pts = (side, n) => Array.from({ length: n }, () => ({ t: 'pt', side }));
  const st = run([
    { t: 'set', lineup, weServe: true }, ...pts('us', 25),
    { t: 'set', lineup, weServe: true }, ...pts('them', 25),
    { t: 'set', lineup, weServe: true }, ...pts('them', 15),
    { t: 'set', lineup, weServe: true },
  ]);
  assert.equal(st.sets.length, 3);
  assert.deepEqual(st.setsWon, { us: 1, them: 2 });
  assert.equal(st.matchOver, true);
});

test('расстановка: называется по зоне основного связующего и меняется при переходе', () => {
  // f — шестой в порядке подачи. Подают они первыми → в зоне 1 стоит шестой (f) → Р1.
  let st = run([{ t: 'set', lineup, weServe: false }]);
  assert.equal(st.rally.rot, 1);
  assert.deepEqual(st.rally.zones, [2, 3, 4, 5, 6, 1]);
  // Сайд-аут: переход, подаёт a, f уходит в зону 6.
  st = run([{ t: 'set', lineup, weServe: false }, act('team', 'oppError')]);
  assert.equal(st.rally.rot, 6);
  assert.equal(st.rally.zones[0], 1);
  assert.equal(st.teams.all.rot[1].so.won, 1);
});

test('пас: связывается со следующей атакой, направление по зоне нападающего', () => {
  // Подаём мы: a в зоне 1, b — 2, c — 3, d — 4.
  const st = run([
    { t: 'set', lineup, weServe: true }, act('serve', 'in', 'a'), act('dig', 'plus', 'e'),
    { ...act('set', 'perfect', 'f'), tempo: 'h' }, act('att', 'kill', 'd'),
  ]);
  const set = st.plays.find(p => p.skill === 'set');
  assert.equal(set.target, 'd');
  assert.equal(set.attRes, 'kill');
  assert.equal(set.dir, 4);
  assert.equal(set.poss, 'trans');
  assert.equal(set.won, true);
  assert.deepEqual(st.players.all.f.set, { tot: 1, perfect: 1, good: 0, poor: 0, err: 0 });
  assert.equal(st.plays.find(p => p.skill === 'att').setter, 'f');
});

test('пас без отметки: распределение считается «виртуальным» пасом, скидка связующего распознаётся', () => {
  const st = run([{ t: 'set', lineup, weServe: false }, act('rec', 'pp', 'a'), act('att', 'kill', 'c'), act('serve', 'in'), act('dig', 'plus', 'b'), act('att', 'kill', 'f')]);
  const virt = st.plays.filter(p => p.skill === 'set' && p.virtual);
  assert.equal(virt.length, 1);
  assert.equal(virt[0].recQ, 'pp');
  assert.equal(virt[0].p, 'f');
  const dump = st.plays.filter(p => p.skill === 'att').at(-1);
  assert.equal(dump.dump, true);
  assert.equal(st.teams.all.links['f>f'], undefined);
});

test('схема 4-2: пасует связующий из передней линии', () => {
  const r2 = roster.map(p => ({ ...p, setter: p.id === 'f' || p.id === 'c' }));
  // Подают они: зоны [2,3,4,5,6,1] → c в зоне 4 (передний), f в зоне 1.
  const st = replay({ roster: r2, events: [{ t: 'set', lineup, weServe: false }, act('rec', 'p', 'a'), act('att', 'kill', 'b')] }, { system: '4-2' });
  assert.equal(st.plays.find(p => p.skill === 'att').setter, 'c');
});

test('приём «перекид»: мяч уходит к ним', () => {
  const st = run([{ t: 'set', lineup, weServe: false }, act('rec', 'over', 'a')]);
  assert.equal(st.rally.phase, 'their');
  assert.equal(st.players.all.a.rec.over, 1);
});

test('форматы матча: до 3 побед, одиночная партия, ручная цель партии', () => {
  const pts = (side, n) => Array.from({ length: n }, () => ({ t: 'pt', side }));
  const bo5 = replay({ roster, format: { sets: 3, points: 25, tiebreak: 15 }, events: [
    { t: 'set', lineup, weServe: true }, ...pts('us', 25), { t: 'set', lineup, weServe: true }, ...pts('us', 25),
    { t: 'set', lineup, weServe: true }, ...pts('them', 25), { t: 'set', lineup, weServe: true }, ...pts('them', 25),
    { t: 'set', lineup, weServe: true }, ...pts('us', 15),
  ] });
  assert.deepEqual(bo5.setsWon, { us: 3, them: 2 });
  assert.equal(bo5.sets[4].target, 15);
  assert.equal(bo5.matchOver, true);
  const one = replay({ roster, format: { sets: 1, points: 25, tiebreak: 25 }, events: [{ t: 'set', lineup, weServe: true }, ...pts('us', 25)] });
  assert.equal(one.matchOver, true);
  const manual = replay({ roster, events: [{ t: 'set', lineup, weServe: true, target: 15 }, ...pts('us', 15)] });
  assert.equal(manual.sets[0].over, true);
});

test('тайм-ауты и плюс-минус на площадке', async () => {
  const { timeoutEffect } = await import('../public/engine.js');
  const st = run([
    { t: 'set', lineup, weServe: true }, { t: 'pt', side: 'them' }, { t: 'pt', side: 'them' },
    { t: 'timeout', side: 'us' }, { t: 'pt', side: 'us' }, { t: 'pt', side: 'us' },
  ]);
  assert.deepEqual(st.sets[0].timeouts[0], { side: 'us', i: 3, at: 2, score: [0, 2] });
  const ef = timeoutEffect(st.sets);
  assert.deepEqual([ef.count, ef.firstWon, ef.runs, ef.brokeRun, ef.nextWon], [1, 1, 1, 1, 2]);
  assert.deepEqual(st.players.all.a.court, { n: 4, us: 2 });
  assert.equal(st.players.all.g, undefined); // запасной не выходил
});
