// Веб-сервер на компьютере: отдаёт страницы и хранит матчи в папке data/.
// Телефон — только пульт: каждое нажатие сразу уходит сюда и сохраняется на диск.
import http from 'node:http';
import { readFile, writeFile, rename, mkdir, readdir } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { replay } from './public/engine.js';
import { replayQuick } from './public/quick-engine.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data'); // DATA_DIR — чтобы проверять на копии данных
const PORT = Number(process.env.PORT) || 4200;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2' };

await mkdir(DATA, { recursive: true });

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

// Пишем во временный файл и переименовываем — так файл не испортится, если компьютер выключится посреди записи.
async function writeJson(file, value) {
  await writeFile(file + '.tmp', JSON.stringify(value, null, 1));
  await rename(file + '.tmp', file);
}

// Все записи идут строго по очереди, чтобы быстрые нажатия не затёрли друг друга.
let queue = Promise.resolve();
const serial = fn => (queue = queue.then(fn, fn));

const rosterFile = path.join(DATA, 'roster.json');
const settingsFile = path.join(DATA, 'settings.json');
const matchFile = id => path.join(DATA, `match-${id}.json`);
// Удалённые матчи не стираются, а переезжают сюда — случайное удаление можно вернуть руками.
const TRASH = path.join(DATA, 'trash');
const DEFAULT_SETTINGS = { teamName: 'Мы', opponents: [] };

const readSettings = async () => ({ ...DEFAULT_SETTINGS, ...(await readJson(settingsFile, {})) });
const loadRefs = async () => ({ roster: await readJson(rosterFile, []), settings: await readSettings() });

// В файле матча лежит копия состава на момент игры. Перед отдачей подставляем текущие
// имена/номера игроков и название соперника — так переименование действует и на старые матчи.
// Отметку «связующий» не трогаем: она должна остаться такой, какой была в том матче.
// Игроков, добавленных в состав уже после начала матча, дописываем в конец — иначе их не выбрать.
function hydrate(match, { roster, settings }) {
  const opp = settings.opponents.find(o => o.id === match.opponentId);
  const snapshot = match.roster.map(p => {
    const cur = roster.find(r => r.id === p.id);
    return cur ? { ...p, num: cur.num, name: cur.name } : p;
  });
  const added = roster.filter(r => !match.roster.some(p => p.id === r.id));
  return { ...match, opponent: opp?.name ?? match.opponent, roster: [...snapshot, ...added] };
}

async function toTrash(file) {
  await mkdir(TRASH, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await rename(file, path.join(TRASH, `${stamp}-${path.basename(file)}`));
}

// Адреса, по которым телефон может достучаться до компьютера.
// 169.254.* — «пустой» адрес адаптера без сети, 198.18–19.* — виртуальные адаптеры VPN: их отбрасываем.
// Домашний Wi-Fi и раздача с телефона (192.168.*, 10.*, 172.16–31.*) — первыми.
function lanAddresses() {
  const isPrivate = ip => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return Object.values(networkInterfaces()).flat()
    .filter(a => a.family === 'IPv4' && !a.internal && !/^(169\.254\.|198\.1[89]\.)/.test(a.address))
    .map(a => a.address)
    .sort((a, b) => isPrivate(b) - isPrivate(a));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || 'null')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// full — отдать матчи целиком (для дашборда), иначе только краткую сводку (для меню пульта).
// mode — 'quick' (быстрая статистика) или 'detail' (детальная; у старых матчей поля mode нет).
async function readMatches(mode) {
  const files = (await readdir(DATA)).filter(f => /^match-[a-z0-9]+\.json$/.test(f));
  const matches = await Promise.all(files.map(f => readJson(path.join(DATA, f)).catch(e => {
    console.error(`  Не удалось прочитать ${f}, пропускаю:`, e.message); // один битый файл не должен ронять весь список
    return null;
  })));
  return matches.filter(m => m && (m.mode || 'detail') === mode);
}

async function listMatches(full, mode) {
  const refs = await loadRefs();
  const matches = (await readMatches(mode)).map(m => hydrate(m, refs)).sort((a, b) => b.created.localeCompare(a.created));
  if (full) return matches;
  const replayFn = mode === 'quick' ? replayQuick : replay;
  return matches.map(m => {
    const st = replayFn(m);
    return { id: m.id, opponent: m.opponent, created: m.created, setsWon: st.setsWon, over: st.matchOver };
  });
}

async function api(req, url) {
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /api/roster') return readJson(rosterFile, []);
  if (route === 'PUT /api/roster') {
    const roster = await readBody(req);
    return serial(async () => { await writeJson(rosterFile, roster); return roster; });
  }
  if (route === 'GET /api/settings') return readSettings();
  // Сливаем с сохранёнными: страница может прислать только часть настроек (например, только дашборд).
  if (route === 'PUT /api/settings') {
    const patch = await readBody(req);
    return serial(async () => {
      const settings = { ...(await readSettings()), ...patch };
      await writeJson(settingsFile, settings);
      return settings;
    });
  }
  if (route === 'GET /api/qr') {
    const urls = lanAddresses().map(ip => `http://${ip}:${PORT}/`);
    return { urls, qr: urls.length ? await QRCode.toDataURL(urls[0], { margin: 1, width: 320 }) : null };
  }
  if (route === 'GET /api/matches') return listMatches(url.searchParams.has('full'), url.searchParams.get('mode') || 'detail');
  // Очистить все матчи режима (перед турниром). Файлы уезжают в data/trash.
  if (route === 'DELETE /api/matches') {
    const mode = url.searchParams.get('mode') || 'detail';
    return serial(async () => {
      const matches = await readMatches(mode);
      for (const m of matches) await toTrash(matchFile(m.id));
      return { deleted: matches.length };
    });
  }
  if (route === 'POST /api/matches') {
    const { opponentId, mode } = await readBody(req);
    const refs = await loadRefs();
    const match = {
      id: Date.now().toString(36),
      ...(mode === 'quick' && { mode }),
      opponentId,
      opponent: refs.settings.opponents.find(o => o.id === opponentId)?.name || 'Соперник', // запасное имя, если соперника удалят
      created: new Date().toISOString(),
      roster: refs.roster, // копия состава на момент матча
      events: [],
    };
    return serial(async () => { await writeJson(matchFile(match.id), match); return hydrate(match, refs); });
  }

  const m = url.pathname.match(/^\/api\/matches\/([a-z0-9]+)(\/events(\/last)?)?$/);
  if (!m) return null;
  const file = matchFile(m[1]);
  if (req.method === 'GET' && !m[2]) {
    const match = await readJson(file, null);
    return match && hydrate(match, await loadRefs());
  }
  if (req.method === 'POST' && m[2] && !m[3]) {
    const ev = await readBody(req);
    return serial(async () => {
      const match = await readJson(file, null);
      if (!match) return null; // матч удалили с другого устройства
      match.events.push(ev);
      await writeJson(file, match);
      return hydrate(match, await loadRefs());
    });
  }
  if (req.method === 'DELETE' && !m[2]) {
    return serial(async () => {
      if (!(await readJson(file, null))) return null;
      await toTrash(file);
      return { ok: true };
    });
  }
  if (req.method === 'DELETE' && m[3]) {
    return serial(async () => {
      const match = await readJson(file, null);
      if (!match) return null;
      match.events.pop();
      await writeJson(file, match);
      return hydrate(match, await loadRefs());
    });
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      const result = await api(req, url);
      res.writeHead(result === null ? 404 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(result));
    }
    const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (e) {
    const notFound = e.code === 'ENOENT' || e.code === 'EISDIR';
    res.writeHead(notFound ? 404 : 500);
    res.end(notFound ? 'Not found' : String(e));
    if (!notFound) console.error(e);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Статистика волейбола запущена`);
  console.log(`  Компьютер: http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  Телефон:   http://${ip}:${PORT}/`);
  console.log(`\n  QR-код для телефона — в «Настройках». Не закрывай это окно, пока идёт матч.\n`);
});
