import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayQuick, quickTotals } from '../public/quick-engine.js';

const roster = [{ id: 'a', num: 0, name: 'Аня' }, { id: 'b', num: 7, name: 'Боря' }];
const run = events => replayQuick({ roster, events });
const end = (res, p = null) => ({ t: 'end', res, p });

test('счёт, подача и статистика игроков', () => {
  const st = run([{ t: 'set', weServe: false }, end('kill', 'a'), end('srvErr', 'a'), end('oppErr'), end('block', 'b')]);
  assert.equal(st.set.us, 3);
  assert.equal(st.set.them, 1);
  assert.deepEqual(quickTotals(st.players.all.a), { points: 1, errors: 1, diff: 0 });
  // 1-й розыгрыш на их подаче (выиграли), 2-й на нашей (проиграли), 3-й на их (выиграли), 4-й на нашей (выиграли)
  assert.deepEqual(st.teams.all.sideout, { n: 2, won: 2 });
  assert.deepEqual(st.teams.all.brk, { n: 2, won: 1 });
  assert.equal(st.teams.all.oppErr, 1);
  assert.equal(st.log.at(-1).text, '#7 Боря — Блок · 3:1');
});

test('партия кончается на 25, дальше розыгрыши не считаются', () => {
  const ev = [{ t: 'set', weServe: true }];
  for (let i = 0; i < 25; i++) ev.push(end('oppErr'));
  ev.push(end('oppErr'));
  const st = run(ev);
  assert.equal(st.set.us, 25);
  assert.equal(st.setsWon.us, 1);
});

// Выиграть партию: n очков подряд стороне side
const win = (side, n) => Array.from({ length: n }, () => end(side === 'us' ? 'oppErr' : 'oppKill'));

test('матч до двух побед: третья партия до 15, четвёртой не бывает', () => {
  const ev = [
    { t: 'set', weServe: true }, ...win('us', 25),
    { t: 'set', weServe: true }, ...win('them', 25),
    { t: 'set', weServe: true }, ...win('us', 14),
  ];
  assert.equal(run(ev).set.over, false); // 14:0 в тай-брейке
  ev.push(...win('us', 1), { t: 'set', weServe: true }, ...win('us', 3));
  const st = run(ev);
  assert.equal(st.sets.length, 3);
  assert.deepEqual([st.set.us, st.set.them], [15, 0]);
  assert.deepEqual(st.setsWon, { us: 2, them: 1 });
  assert.equal(st.matchOver, true);
});

test('после 2:0 матч окончен', () => {
  const st = run([{ t: 'set', weServe: true }, ...win('us', 25), { t: 'set', weServe: false }, ...win('us', 25), { t: 'set', weServe: true }]);
  assert.equal(st.matchOver, true);
  assert.equal(st.sets.length, 2);
});

test('старый «Блок-аут» (blockOut) засчитывается как blocked', () => {
  const st = run([{ t: 'set', weServe: true }, end('blockOut', 'a')]);
  assert.equal(st.set.them, 1);
  assert.equal(st.players.all.a.blocked, 1);
});

test('ошибка в защите — отдельная статистика; старая «ошибка приёма» на своей подаче считается защитой', () => {
  const st = run([
    { t: 'set', weServe: false },
    end('recErr', 'a'), // подают они — это приём подачи
    end('digErr', 'b'), // защита на их подаче
    { t: 'end', res: 'oppErr', p: null }, // переход подачи к нам
    end('recErr', 'a'), // подаём мы — значит, это была защита
  ]);
  assert.equal(st.players.all.a.recErr, 1);
  assert.equal(st.players.all.a.digErr, 1);
  assert.equal(st.players.all.b.digErr, 1);
  assert.deepEqual([st.set.us, st.set.them], [1, 3]);
});

test('потеря мяча — ошибка игрока, очко сопернику', () => {
  const st = run([{ t: 'set', weServe: true }, end('lost', 'a')]);
  assert.deepEqual([st.set.us, st.set.them], [0, 1]);
  assert.equal(st.players.all.a.lost, 1);
  assert.equal(quickTotals(st.players.all.a).errors, 1);
});
