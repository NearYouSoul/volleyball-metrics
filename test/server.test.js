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
