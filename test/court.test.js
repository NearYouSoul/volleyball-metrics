import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoneOf, zoneOfSlot, setDir } from '../public/court.js';

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
