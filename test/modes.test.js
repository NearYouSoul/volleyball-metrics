// Три режима статистики внутри одного матча: перевод старых файлов и вид матча глазами режима.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, sheet, emptyStats, MODE_KEYS } from '../public/modes.js';

test('старый быстрый матч — в экспресс, поле mode убрано', () => {
  const m = migrate({ id: 'a', mode: 'quick', roster: [], events: [{ t: 'set' }, { t: 'end' }] });
  assert.equal(m.stats.express.events.length, 2);
  assert.equal(m.stats.studio.events.length, 0);
  assert.equal(m.mode, undefined);
  assert.equal(m.events, undefined);
});

test('старый детальный матч: с точками — в студию, без точек — в ручной', () => {
  assert.equal(migrate({ id: 'a', events: [{ t: 'act', to: { x: 1, y: 2 } }, { t: 'pt' }] }).stats.studio.events.length, 2);
  assert.equal(migrate({ id: 'a', events: [{ t: 'act', vt: 0 }] }).stats.studio.events.length, 1);
  assert.equal(migrate({ id: 'a', events: [{ t: 'act', skill: 'att' }] }).stats.manual.events.length, 1);
});

test('матч без событий — все режимы пусты; новый формат не трогаем, недостающий режим дописываем', () => {
  const e = migrate({ id: 'a', events: [] });
  for (const k of MODE_KEYS) assert.deepEqual(e.stats[k].events, []);
  const n = migrate({ id: 'b', stats: { studio: { events: [{ t: 'pt' }] } } });
  assert.equal(n.stats.studio.events.length, 1);
  assert.deepEqual(n.stats.express.events, []);
});

test('вид режима: свой список событий, общие поля на месте', () => {
  const m = { id: 'a', opponent: 'X', stats: emptyStats() };
  m.stats.manual.events.push({ t: 'pt' });
  const v = sheet(m, 'manual');
  assert.equal(v.events.length, 1);
  assert.equal(v.opponent, 'X');
  assert.equal(v.stats, undefined);
  assert.equal(sheet(m, 'studio').events.length, 0);
});
