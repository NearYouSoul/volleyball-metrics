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
  assert.deepEqual(st.players.all.a.serve, { tot: 1, ace: 1, err: 0 });
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
  assert.deepEqual(st.players.all.a.serve, { tot: 1, ace: 0, err: 0 }); // подача в игру
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
  assert.deepEqual(st.players.all.c.dig, { tot: 1, plus: 1, minus: 0, err: 0 });
  assert.deepEqual(st.players.all.a.dig, { tot: 1, plus: 0, minus: 0, err: 1 });
  assert.deepEqual(st.players.all.a.serve, { tot: 1, ace: 0, err: 0 }); // подача в игру засчитана сама
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
