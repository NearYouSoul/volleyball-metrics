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
