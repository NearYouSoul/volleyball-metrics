import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoneOf, zoneOfSlot, setDir, rotOrder, rotName, ROT_START } from '../public/court.js';
import { replay } from '../public/engine.js';

test('зоны на нашей половине и зеркально у соперника', () => {
  assert.equal(zoneOf({ x: 1, y: 8 }), 4);
  assert.equal(zoneOf({ x: 8, y: 1 }), 1);
  assert.equal(zoneOf({ x: 4.5, y: 3 }), 6);
  assert.equal(zoneOf({ x: 1, y: 10 }), 2); // наш левый край у них — их зона 2
  assert.equal(zoneOf({ x: 8, y: 17 }), 5);
});

test('слоты по порядку подачи: подающий в 1, следующий в 2', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(s => zoneOfSlot(s, 0)), [1, 2, 3, 4, 5, 6]);
  assert.equal(zoneOfSlot(0, 5), 2);
});

test('направление паса: по точке, иначе по зоне нападающего', () => {
  assert.equal(setDir({ x: 1, y: 8 }, 2), 4);
  assert.equal(setDir(null, 6), 'pipe');
});

test('номера расстановок идут по ходу игры от стартовой зоны', () => {
  assert.equal(ROT_START, 3);
  assert.deepEqual(rotOrder(), [3, 2, 1, 6, 5, 4]); // связка в 3 → 2 → 1 на подачу → 6 → 5 → 4
  assert.deepEqual(rotOrder(1), [1, 6, 5, 4, 3, 2]);
  assert.deepEqual(rotOrder(4), [4, 3, 2, 1, 6, 5]);
  assert.deepEqual(rotOrder(null), [3, 2, 1, 6, 5, 4]); // в старых настройках значения нет
  assert.deepEqual(rotOrder(9), [3, 2, 1, 6, 5, 4]);
  assert.deepEqual([3, 2, 1, 6, 5, 4].map(z => rotName(z)), ['Р1', 'Р2', 'Р3', 'Р4', 'Р5', 'Р6']);
  assert.equal(rotName(1, 1), 'Р1');
});

test('настоящая партия: переходы дают Р1, Р2, Р3… подряд', () => {
  // Связующий b — второй в порядке подачи: на их подаче он стартует в зоне 3.
  const lineup = ['a', 'b', 'c', 'd', 'e', 'f'];
  const roster = lineup.map((id, i) => ({ id, num: i + 1, name: id, setter: id === 'b' }));
  const events = [{ t: 'set', lineup, weServe: false }];
  const zones = [];
  for (let i = 0; i < 7; i++) {
    zones.push(replay({ roster, events }).rally.rot);
    events.push({ t: 'act', skill: 'team', res: 'oppError', p: null }); // сайд-аут: переход
    events.push({ t: 'act', skill: 'serve', res: 'error', p: replay({ roster, events }).rally.server }); // отдали подачу
  }
  assert.equal(zones[0], 3);
  assert.deepEqual(zones.map(z => rotName(z)), ['Р1', 'Р2', 'Р3', 'Р4', 'Р5', 'Р6', 'Р1']);
});

test('протокол: правила расстановки при подаче', async () => {
  const { overlapIssues, tableFor, defenseLayout } = await import('../public/formations.js');
  // Стандартный приём во всех расстановках — по правилам.
  for (let r = 1; r <= 6; r++) assert.deepEqual(overlapIssues(tableFor(null, 'rec', r)).issues, [], `Р${r}`);
  const bad = tableFor(null, 'rec', 1);
  bad[3] = { x: 1.0, y: 8.2 }; // центральный левее четвёртой зоны
  assert.ok(overlapIssues(bad).bad.has(3));
  // Подающий (зона 1) на своей подаче — вне правила.
  const srv = tableFor(null, 'serve', 1); srv[1] = { x: 7.6, y: -0.9 };
  assert.deepEqual(overlapIssues(srv, { server: true }).issues, []);
  // Блок слева: блокируют левый и центральный, справа — центральный и правый.
  assert.deepEqual(defenseLayout(tableFor(null, 'def', 1), { x: 1.5 }).blockers, [4, 3]);
  assert.deepEqual(defenseLayout(tableFor(null, 'def', 1), { x: 7.5 }).blockers, [3, 2]);
  assert.deepEqual(defenseLayout(tableFor(null, 'def', 1), { x: 4.5 }).blockers, [3]);
});
