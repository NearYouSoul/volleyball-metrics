// Сервер целиком: поднимаем на временной папке данных и проверяем основные запросы.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4700 + Math.floor(Math.random() * 200);
const URL_ = `http://127.0.0.1:${PORT}`;
let dir, proc;

const api = async (method, url, body, headers = {}) => {
  const r = await fetch(URL_ + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) });
  return { status: r.status, json: r.headers.get('content-type')?.includes('json') ? await r.json() : null, res: r };
};

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vb-test-'));
  await writeFile(path.join(dir, 'roster.json'), JSON.stringify([
    { id: 'a', num: 1, name: 'A', role: 's', setter: true }, { id: 'b', num: 2, name: 'B' }, { id: 'c', num: 3, name: 'C' },
    { id: 'd', num: 4, name: 'D' }, { id: 'e', num: 5, name: 'E' }, { id: 'f', num: 6, name: 'F' },
  ]));
  proc = spawn(process.execPath, ['server.js', '--data', dir], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(URL_ + '/api/settings'); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('сервер не поднялся');
});
after(async () => { proc?.kill(); await rm(dir, { recursive: true, force: true }); });

test('сервер: матч с форматом, события, вставка, правка, удаление', async () => {
  const m = (await api('POST', '/api/matches', { opponentId: 'x', format: { sets: 3, points: 25, tiebreak: 15 } })).json;
  assert.deepEqual(m.format, { sets: 3, points: 25, tiebreak: 15 });
  assert.deepEqual((await api('GET', '/api/settings')).json.lastFormat, m.format); // формат запомнился
  const ev = (await api('POST', `/api/matches/${m.id}/events`, { t: 'set', lineup: ['a', 'b', 'c', 'd', 'e', 'f'], weServe: true })).json;
  assert.equal(ev.events.length, 1);
  await api('POST', `/api/matches/${m.id}/events`, { t: 'pt', side: 'us' });
  const ins = (await api('POST', `/api/matches/${m.id}/events?at=1`, { t: 'pt', side: 'them' })).json;
  assert.deepEqual(ins.events.map(e => e.side ?? e.t), ['set', 'them', 'us']);
  const put = (await api('PUT', `/api/matches/${m.id}/events/1`, { t: 'pt', side: 'us', star: true })).json;
  assert.equal(put.events[1].star, true);
  const del = (await api('DELETE', `/api/matches/${m.id}/events/2`)).json;
  assert.equal(del.events.length, 2);
  const pat = (await api('PATCH', `/api/matches/${m.id}`, { format: { sets: 1, points: 15, tiebreak: 15 }, preset: 'p1' })).json;
  assert.equal(pat.format.points, 15);
  assert.equal(pat.preset, 'p1');
  // Роль из текущего состава попадает и в старый матч.
  const roster = (await api('GET', '/api/roster')).json;
  roster[1].role = 'oh';
  await api('PUT', '/api/roster', roster);
  const hyd = (await api('GET', `/api/matches/${m.id}`)).json;
  assert.equal(hyd.roster.find(p => p.id === 'b').role, 'oh');
  // Удаление — в корзину.
  assert.equal((await api('DELETE', `/api/matches/${m.id}`)).json.ok, true);
  assert.equal((await api('GET', `/api/matches/${m.id}`)).json, null);
});

test('сервер: видео — загрузка и перемотка (Range), нарезка без отрезков — понятная ошибка', async () => {
  const bytes = new Uint8Array(4096).map((_, i) => i % 251);
  const up = (await api('POST', '/api/videos', bytes, { 'X-Filename': encodeURIComponent('тест.mp4'), 'Content-Type': 'application/octet-stream' })).json;
  assert.equal(up.name, 'тест.mp4');
  const r = await fetch(`${URL_}/media/${up.file}`, { headers: { Range: 'bytes=10-19' } });
  assert.equal(r.status, 206);
  assert.equal((await r.arrayBuffer()).byteLength, 10);
  const bad = (await api('POST', '/api/clips', { segments: [] })).json;
  assert.ok(bad.error);
  // Нельзя выйти за пределы папки видео.
  assert.equal((await fetch(`${URL_}/media/..%2Froster.json`)).status, 404);
});

test('сервер: резервная копия, восстановление, корзина', async () => {
  const m = (await api('POST', '/api/matches', { opponentId: 'x' })).json;
  const b = (await api('POST', '/api/backups')).json;
  assert.ok(b.name);
  await api('DELETE', `/api/matches/${m.id}`);
  const trash = (await api('GET', '/api/trash')).json;
  const item = trash.find(t => t.id === m.id);
  assert.ok(item);
  assert.equal((await api('POST', `/api/trash/${encodeURIComponent(item.file)}/restore`)).json.ok, true);
  assert.equal((await api('GET', `/api/matches/${m.id}`)).json.id, m.id);
  // Файл копии: выгрузили, удалили матч, загрузили — матч вернулся.
  const file = (await api('GET', '/api/backup/file')).json;
  await api('DELETE', `/api/matches/${m.id}`);
  assert.equal((await api('POST', '/api/backup/file', file)).json.ok, true);
  assert.equal((await api('GET', `/api/matches/${m.id}`)).json.id, m.id);
  assert.ok((await api('GET', '/api/backups')).json.length >= 2); // автокопия при запуске + ручная + перед восстановлением
});

test('сервер: скаутинг — опция матча, номер соперника в событии', async () => {
  const m = (await api('POST', '/api/matches', { opponentId: 'x' })).json;
  assert.ok(!m.scout); // по умолчанию выключен
  assert.equal((await api('PATCH', `/api/matches/${m.id}`, { scout: true })).json.scout, true);
  await api('POST', `/api/matches/${m.id}/events`, { t: 'set', lineup: ['a', 'b', 'c', 'd', 'e', 'f'], weServe: false });
  const ev = (await api('POST', `/api/matches/${m.id}/events`, { t: 'act', skill: 'rec', res: 'pp', p: 'b', opp: '7' })).json;
  assert.equal(ev.events.at(-1).opp, '7');
  assert.equal((await api('PATCH', `/api/matches/${m.id}`, { scout: false })).json.scout, false);
});

test('сервер: режимы статистики не смешиваются, сводка показывает партии каждого', async () => {
  const m = (await api('POST', '/api/matches', { opponentId: 'x' })).json;
  await api('POST', `/api/matches/${m.id}/events?src=express`, { t: 'set', weServe: true });
  await api('POST', `/api/matches/${m.id}/events?src=express`, { t: 'end', res: 'oppErr', p: null });
  assert.equal((await api('GET', `/api/matches/${m.id}?src=express`)).json.events.length, 2);
  assert.equal((await api('GET', `/api/matches/${m.id}?src=studio`)).json.events.length, 0);
  assert.equal((await api('GET', `/api/matches/${m.id}?src=manual`)).json.events.length, 0);
  const s = (await api('GET', '/api/matches')).json.find(x => x.id === m.id);
  assert.equal(s.main, 'express');
  assert.deepEqual(s.modes.express.sets.map(x => [x.us, x.them, x.over]), [[1, 0, false]]);
  assert.equal(s.modes.studio.events, 0);
});

test('сервер: старый файл матча читается как новый и сам переводится при записи', async () => {
  await writeFile(path.join(dir, 'match-oldq.json'), JSON.stringify({ id: 'oldq', mode: 'quick', opponentId: 'x', opponent: 'X', created: '2026-01-01T00:00:00Z', roster: [], videos: [], events: [{ t: 'set', weServe: true }] }));
  assert.equal((await api('GET', '/api/matches/oldq?src=express')).json.events.length, 1);
  await api('POST', '/api/matches/oldq/events?src=express', { t: 'end', res: 'oppErr', p: null });
  assert.equal((await api('GET', '/api/matches/oldq?src=express')).json.events.length, 2);
});
