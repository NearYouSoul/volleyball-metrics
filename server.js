// Веб-сервер на компьютере: отдаёт страницы и хранит матчи в папке data/.
// Телефон — только пульт: каждое нажатие сразу уходит сюда и сохраняется на диск.
import http from 'node:http';
import { readFile, writeFile, rename, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { replay } from './public/engine.js';
import { replayQuick } from './public/quick-engine.js';
import { hasFfmpeg, probe, plan, convert, cutHighlights } from './media.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
// Папка данных: --data <папка> или DATA_DIR — чтобы проверять на копии данных или на демо.
const argData = process.argv.includes('--data') ? process.argv[process.argv.indexOf('--data') + 1] : null;
const DATA = path.resolve(ROOT, argData || process.env.DATA_DIR || 'data');
const PORT = Number(process.env.PORT) || 4200;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
};
// Видеотека: файлы копируются сюда при загрузке (перетаскиванием в студии), список — в videos.json.
const VIDEOS = path.join(DATA, 'videos');
const CLIPS = path.join(DATA, 'clips'); // нарезки лучших моментов
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv']);

await mkdir(DATA, { recursive: true });
await mkdir(VIDEOS, { recursive: true });
const videosFile = path.join(VIDEOS, 'videos.json');

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
// Игроков, добавленных в состав уже после начала матча, дописываем в конец — иначе их не выбрать.
function hydrate(match, { roster, settings }) {
  const opp = settings.opponents.find(o => o.id === match.opponentId);
  const snapshot = match.roster.map(p => {
    const cur = roster.find(r => r.id === p.id);
    // Роль — тоже текущая (поправили роль в настройках — матчи видят новую). Отметку «связующий» обновляем,
    // только если у игрока задана роль; иначе оставляем, как была в матче.
    return cur ? { ...p, num: cur.num, name: cur.name, ...(cur.role !== undefined && { role: cur.role, setter: cur.role === 's' }) } : p;
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
    return { id: m.id, opponentId: m.opponentId, opponent: m.opponent, created: m.created, setsWon: st.setsWon, over: st.matchOver, videos: m.videos || [], events: m.events.length };
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
    const { opponentId, mode, format } = await readBody(req);
    // Формат матча (до скольки побед, до скольки очков) — запоминаем как последний выбранный.
    const fmt = format && Number.isInteger(format.sets) && format.sets >= 1 && format.sets <= 5 ? { sets: format.sets, points: +format.points || 25, tiebreak: +format.tiebreak || 15 } : null;
    if (fmt) await serial(async () => { const st = await readSettings(); st.lastFormat = fmt; await writeJson(settingsFile, st); });
    const refs = await loadRefs();
    const match = {
      id: Date.now().toString(36),
      ...(mode === 'quick' && { mode }),
      opponentId,
      ...(fmt && { format: fmt }),
      opponent: refs.settings.opponents.find(o => o.id === opponentId)?.name || 'Соперник', // запасное имя, если соперника удалят
      created: new Date().toISOString(),
      roster: refs.roster, // копия состава на момент матча
      // Пресет команды (расстановки + схема) — активный в настройках; схема — из пресета.
      ...(() => { const pr = refs.settings.presets?.find(x => x.id === refs.settings.activePreset); return { system: pr?.system || refs.settings.system || '5-1', ...(pr && { preset: pr.id }) }; })(),
      videos: [],
      events: [],
    };
    return serial(async () => { await writeJson(matchFile(match.id), match); return hydrate(match, refs); });
  }

  // ---------- Видеотека ----------
  // Прогресс подготовки видео живёт в памяти — подмешиваем его в список.
  if (route === 'GET /api/videos') return (await readJson(videosFile, [])).map(v => (jobs.has(v.id) ? { ...v, progress: jobs.get(v.id) } : v));
  // Загрузка: тело запроса — сам файл, имя — в заголовке X-Filename. Пишем потоком: файлы бывают по несколько гигабайт.
  if (route === 'POST /api/videos') {
    const name = decodeURIComponent(req.headers['x-filename'] || 'video.mp4');
    const ext = path.extname(name).toLowerCase() || '.mp4';
    // Без FFmpeg берём только то, что браузер играет сам; с FFmpeg — что угодно.
    if (!hasFfmpeg() && !VIDEO_EXT.has(ext)) { req.resume(); return { error: `Формат ${ext} не поддерживается. Нужен mp4, mov, webm или mkv.` }; }
    if (!/^\.[a-z0-9]{1,5}$/.test(ext)) { req.resume(); return { error: 'Непонятное расширение файла' }; }
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const file = `${id}${ext}`;
    await pipeline(req, createWriteStream(path.join(VIDEOS, file + '.part')));
    await rename(path.join(VIDEOS, file + '.part'), path.join(VIDEOS, file));
    const { size } = await stat(path.join(VIDEOS, file));
    const video = { id, name, file, size, created: new Date().toISOString(), status: 'ready' };
    if (hasFfmpeg()) {
      try {
        const info = await probe(path.join(VIDEOS, file));
        Object.assign(video, { codec: info.vcodec, width: info.width, height: info.height, ...(info.duration && { duration: info.duration }) });
        const mode = plan(info, ext);
        if (mode !== 'ready') Object.assign(video, { status: 'processing', mode, source: file });
      } catch (e) { console.error('  Не удалось прочитать видео:', e.message); }
    }
    await serial(async () => { const list = await readJson(videosFile, []); list.unshift(video); await writeJson(videosFile, list); });
    if (video.status === 'processing') enqueue(video.id);
    return video;
  }
  // Нарезка лучших моментов в один mp4: { name, segments: [{ video, start, end }] } → { url }.
  if (route === 'POST /api/clips') {
    if (!hasFfmpeg()) return { error: 'Для нарезки нужен FFmpeg — запустите start.bat с интернетом один раз' };
    const { name, segments } = await readBody(req);
    const list = await readJson(videosFile, []);
    const segs = (segments || []).map(sg => ({ ...sg, v: list.find(v => v.id === sg.video) })).filter(sg => sg.v && sg.end > sg.start)
      .map(sg => ({ file: path.join(VIDEOS, sg.v.file), start: +sg.start, end: +sg.end }));
    if (!segs.length) return { error: 'Нет отрезков с видео' };
    await mkdir(CLIPS, { recursive: true });
    const safe = String(name || 'нарезка').replace(/[^\p{L}\p{N} _.—-]+/gu, '').replace(/ {2,}/g, ' ').trim().slice(0, 60) || 'нарезка';
    const file = `${safe} ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.mp4`;
    await cutHighlights(segs, path.join(CLIPS, file), CLIPS);
    return { url: '/clips/' + encodeURIComponent(file), file };
  }
  if (route === 'GET /api/clips') {
    await mkdir(CLIPS, { recursive: true });
    const files = (await readdir(CLIPS)).filter(f => f.endsWith('.mp4'));
    return Promise.all(files.map(async f => ({ file: f, url: '/clips/' + encodeURIComponent(f), size: (await stat(path.join(CLIPS, f))).size }))).then(a => a.sort((x, y) => y.file.localeCompare(x.file)));
  }

  const vm = url.pathname.match(/^\/api\/videos\/([a-z0-9]+)$/);
  if (vm && req.method === 'PATCH') {
    const patch = await readBody(req);
    return serial(async () => {
      const list = await readJson(videosFile, []);
      const v = list.find(x => x.id === vm[1]);
      if (!v) return null;
      if (typeof patch.name === 'string') v.name = patch.name.trim() || v.name;
      if (typeof patch.duration === 'number') v.duration = patch.duration;
      await writeJson(videosFile, list);
      return v;
    });
  }
  if (vm && req.method === 'DELETE') {
    return serial(async () => {
      const list = await readJson(videosFile, []);
      const v = list.find(x => x.id === vm[1]);
      if (!v) return null;
      await mkdir(path.join(TRASH, 'videos'), { recursive: true });
      await rename(path.join(VIDEOS, v.file), path.join(TRASH, 'videos', v.file)).catch(() => {});
      await writeJson(videosFile, list.filter(x => x !== v));
      return { ok: true };
    });
  }

  const m = url.pathname.match(/^\/api\/matches\/([a-z0-9]+)(\/events(\/last|\/(\d+))?)?$/);
  if (!m) return null;
  const file = matchFile(m[1]);
  if (req.method === 'GET' && !m[2]) {
    const match = await readJson(file, null);
    return match && hydrate(match, await loadRefs());
  }
  // Свойства матча: привязанные видео, схема игры.
  if (req.method === 'PATCH' && !m[2]) {
    const patch = await readBody(req);
    return serial(async () => {
      const match = await readJson(file, null);
      if (!match) return null;
      if (Array.isArray(patch.videos)) match.videos = patch.videos;
      if (typeof patch.system === 'string') match.system = patch.system;
      if (typeof patch.preset === 'string') match.preset = patch.preset;
      if (patch.format && Number.isInteger(patch.format.sets)) match.format = { sets: patch.format.sets, points: +patch.format.points || 25, tiebreak: +patch.format.tiebreak || 15 };
      await writeJson(file, match);
      return hydrate(match, await loadRefs());
    });
  }
  // Правка события по номеру (по видео): заменить или удалить любое, не только последнее.
  if (m[4] && (req.method === 'PUT' || req.method === 'DELETE')) {
    const k = Number(m[4]);
    const ev = req.method === 'PUT' ? await readBody(req) : null;
    return serial(async () => {
      const match = await readJson(file, null);
      if (!match || k >= match.events.length) return null;
      if (ev) match.events[k] = ev; else match.events.splice(k, 1);
      await writeJson(file, match);
      return hydrate(match, await loadRefs());
    });
  }
  if (req.method === 'POST' && m[2] && !m[3]) {
    const ev = await readBody(req);
    // ?at=N — вставить перед событием N (пропущенное касание, найденное на видео).
    const at = url.searchParams.has('at') ? Number(url.searchParams.get('at')) : null;
    return serial(async () => {
      const match = await readJson(file, null);
      if (!match) return null; // матч удалили с другого устройства
      if (at !== null && at >= 0 && at < match.events.length) match.events.splice(at, 0, ev);
      else match.events.push(ev);
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

// ---------- Очередь подготовки видео (по одному файлу за раз) ----------
const jobs = new Map(); // id → прогресс 0…1
let chain = Promise.resolve();
function enqueue(id) {
  jobs.set(id, 0);
  chain = chain.then(() => prepareVideo(id)).catch(e => console.error(e));
}
async function patchVideo(id, patch) {
  return serial(async () => {
    const list = await readJson(videosFile, []);
    const v = list.find(x => x.id === id);
    if (v) Object.assign(v, patch);
    await writeJson(videosFile, list);
    return v;
  });
}
async function prepareVideo(id) {
  const v = (await readJson(videosFile, [])).find(x => x.id === id);
  if (!v || v.status !== 'processing') return jobs.delete(id);
  const src = path.join(VIDEOS, v.source), out = `${id}.mp4`, tmp = path.join(VIDEOS, `${id}.tmp.mp4`);
  console.log(`  Видео «${v.name}»: ${v.mode === 'remux' ? 'переупаковка' : 'перекодирование в H.264'}…`);
  try {
    const info = await probe(src);
    await convert(src, tmp, info, v.mode, p => jobs.set(id, p));
    await rename(tmp, path.join(VIDEOS, out));
    if (v.source !== out) await unlink(src).catch(() => {});
    const { size } = await stat(path.join(VIDEOS, out));
    await patchVideo(id, { status: 'ready', file: out, size, source: undefined, ...(info.duration && { duration: info.duration }) });
    console.log(`  Видео «${v.name}» готово.`);
  } catch (e) {
    console.error(`  Видео «${v.name}»: ошибка FFmpeg —`, e.message);
    await unlink(tmp).catch(() => {});
    await patchVideo(id, { status: 'error', error: e.message.slice(0, 200), file: v.source });
  }
  jobs.delete(id);
}

// Видео отдаём кусками (Range): без этого браузер не умеет перематывать.
async function sendVideo(req, res, name, dir = VIDEOS) {
  const file = path.join(dir, path.basename(name));
  const { size } = await stat(file);
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (!range) {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    return pipeline(createReadStream(file), res).catch(() => {});
  }
  let start = range[1] ? Number(range[1]) : size - Number(range[2]);
  let end = range[1] && range[2] ? Number(range[2]) : size - 1;
  start = Math.max(0, start); end = Math.min(end, size - 1);
  if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
  res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' });
  return pipeline(createReadStream(file, { start, end }), res).catch(() => {});
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      const result = await api(req, url);
      if (res.headersSent) return;
      res.writeHead(result === null ? 404 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(result));
    }
    if (url.pathname.startsWith('/media/')) return sendVideo(req, res, decodeURIComponent(url.pathname.slice(7)));
    if (url.pathname.startsWith('/clips/')) return sendVideo(req, res, decodeURIComponent(url.pathname.slice(7)), CLIPS);
    const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
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

// Подготовка видео прервалась (закрыли окно сервера) — продолжаем после запуска.
for (const v of await readJson(videosFile, [])) if (v.status === 'processing' && hasFfmpeg()) enqueue(v.id);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Статистика волейбола запущена`);
  console.log(`  Компьютер: http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  Телефон:   http://${ip}:${PORT}/`);
  console.log(`\n  QR-код для телефона — в «Настройках». Не закрывай это окно, пока идёт матч.\n`);
});
