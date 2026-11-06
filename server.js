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
import { replay, LABELS, formatOf } from './public/engine.js';
import { buildTeamPackage, readTeamPackage, applyTeamPackage, buildMatchPackage, readMatchPackage, importMatch, statsCsv, TEAM_PARTS } from './transfer.js';
import { replayQuick } from './public/quick-engine.js';
import { MODES, MODE_KEYS, emptyStats, migrate, sheet } from './public/modes.js';
import { hasFfmpeg, probe, plan, convert, cutHighlights } from './media.js';
import { youtubeId } from './public/studio/player.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
// Папка данных: --data <папка> или DATA_DIR — чтобы проверять на копии данных или на демо.
const argData = process.argv.includes('--data') ? process.argv[process.argv.indexOf('--data') + 1] : null;
const DATA = path.resolve(ROOT, argData || process.env.DATA_DIR || 'data');
const PORT = Number(process.env.PORT) || 4200;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
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
    const base = cur ? { ...p, num: cur.num, name: cur.name, ...(cur.role !== undefined && { role: cur.role, setter: cur.role === 's' }) } : p;
    // Роль на этот матч (ЦБ вынужден играть доигровщиком) — важнее роли в команде.
    const own = match.roles?.[p.id];
    return own ? { ...base, role: own, setter: own === 's' } : base;
  });
  // Пришедшие в команду после начала матча — дописываем (только активных: ушедшие игроки в новые списки не попадают).
  const added = roster.filter(r => r.active !== false && !match.roster.some(p => p.id === r.id))
    .map(r => (match.roles?.[r.id] ? { ...r, role: match.roles[r.id], setter: match.roles[r.id] === 's' } : r));
  return { ...match, opponent: opp?.name ?? match.opponent, roster: [...snapshot, ...added] };
}

// ---------- Резервные копии ----------
// Копия — один файл backup.json в data/backups/<дата>: состав, настройки и все матчи (без видео — оно большое).
const BACKUPS = path.join(DATA, 'backups');
async function snapshot() {
  const files = (await readdir(DATA)).filter(f => /^match-[a-z0-9]+\.json$/.test(f));
  const matches = (await Promise.all(files.map(f => readJson(path.join(DATA, f), null).catch(() => null)))).filter(Boolean);
  // Ссылки YouTube весят байты — входят в копию, в отличие от файлов видео.
  const youtube = (await readJson(videosFile, [])).filter(v => v.youtube);
  return { roster: await readJson(rosterFile, []), settings: await readJson(settingsFile, {}), matches, youtube };
}
async function makeBackup(reason = 'авто') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23); // с миллисекундами — две копии подряд не затрут друг друга
  const dir = path.join(BACKUPS, stamp);
  await mkdir(dir, { recursive: true });
  const data = { ...(await snapshot()), reason, created: new Date().toISOString() };
  await writeJson(path.join(dir, 'backup.json'), data);
  // Храним последние 30 копий.
  const all = (await readdir(BACKUPS)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 30))) await import('node:fs/promises').then(fs => fs.rm(path.join(BACKUPS, old), { recursive: true, force: true }));
  return { name: stamp, reason, matches: data.matches.length };
}
async function listBackups() {
  await mkdir(BACKUPS, { recursive: true });
  const names = (await readdir(BACKUPS)).sort().reverse();
  return Promise.all(names.map(async n => {
    const d = await readJson(path.join(BACKUPS, n, 'backup.json'), null).catch(() => null);
    return { name: n, created: d?.created ?? null, reason: d?.reason ?? '', matches: d?.matches?.length ?? 0 };
  }));
}
// Восстановление: состав и настройки — из копии; матчи — из копии, а лишние текущие уходят в корзину (не стираются).
async function restoreSnapshot(data) {
  await writeJson(rosterFile, data.roster ?? []);
  await writeJson(settingsFile, data.settings ?? {});
  const keep = new Set(data.matches.map(m => m.id));
  for (const f of (await readdir(DATA)).filter(f => /^match-[a-z0-9]+\.json$/.test(f))) {
    if (!keep.has(f.slice(6, -5))) await toTrash(path.join(DATA, f));
  }
  for (const m of data.matches) if (/^[a-z0-9]+$/.test(m.id)) await writeJson(matchFile(m.id), m);
  const list = await readJson(videosFile, []);
  const fresh = (data.youtube ?? []).filter(v => v.youtube && !list.some(x => x.id === v.id));
  if (fresh.length) await writeJson(videosFile, [...fresh, ...list]);
}
// Автокопия раз в день: при запуске и потом каждый час проверяем, есть ли копия за сегодня.
async function dailyBackup() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const list = await listBackups();
    if (!list.some(b => b.name.startsWith(today))) { const b = await serial(() => makeBackup('авто')); console.log(`  Резервная копия: data/backups/${b.name}`); }
  } catch (e) { console.error('  Резервная копия не получилась:', e.message); }
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

// Тело запроса как есть (файлы импорта: ZIP или JSON), до limit байт.
function readRaw(req, limit = 64e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { req.destroy(); reject(new Error('Файл слишком большой')); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// Ответ-файл для скачивания: обработчик возвращает { file: { name, type, data } }.
const download = (name, data, type = 'application/zip') => ({ [FILE]: { name, type, data } });
const FILE = Symbol('file');

// Файл матча читаем всегда через перевод в новый формат: старые копии и импорт работают сами.
const readMatch = async file => { const m = await readJson(file, null); return m && migrate(m); };
const srcOf = url => (MODES[url.searchParams.get('src')] ? url.searchParams.get('src') : 'studio');
async function readMatches() {
  const files = (await readdir(DATA)).filter(f => /^match-[a-z0-9]+\.json$/.test(f));
  const matches = await Promise.all(files.map(f => readMatch(path.join(DATA, f)).catch(e => {
    console.error(`  Не удалось прочитать ${f}, пропускаю:`, e.message); // один битый файл не должен ронять весь список
    return null;
  })));
  return matches.filter(Boolean);
}
// Один раз при запуске: старые файлы — в новый формат, перед этим резервная копия.
async function migrateFiles() {
  const files = (await readdir(DATA)).filter(f => /^match-[a-z0-9]+\.json$/.test(f));
  const raw = (await Promise.all(files.map(async f => ({ f, m: await readJson(path.join(DATA, f), null).catch(() => null) })))).filter(x => x.m && !x.m.stats);
  if (!raw.length) return;
  await makeBackup('перед переходом на единый матч');
  for (const { f, m } of raw) await writeJson(path.join(DATA, f), migrate(m));
  console.log(`  Матчи переведены в новый формат: ${raw.length}`);
}
// Сводка матча: по каждому режиму — партии со счётом. main — режим, где сыграно больше всего очков.
function summary(m) {
  const modes = {};
  for (const k of MODE_KEYS) {
    const st = (k === 'express' ? replayQuick : replay)(sheet(m, k));
    modes[k] = { events: m.stats[k].events.length, sets: st.sets.map(s => ({ n: s.n, us: s.us, them: s.them, over: !!s.over, target: s.target })), setsWon: st.setsWon, over: st.matchOver };
  }
  const points = k => modes[k].sets.reduce((a, s) => a + s.us + s.them, 0);
  const main = MODE_KEYS.reduce((a, k) => (points(k) > points(a) ? k : a), MODE_KEYS[0]);
  return { modes, main, setsWon: modes[main].setsWon, over: modes[main].over, events: MODE_KEYS.reduce((a, k) => a + modes[k].events, 0) };
}

// full — матчи целиком глазами режима src (для аналитики), иначе сводка по всем режимам.
async function listMatches(full, src) {
  const refs = await loadRefs();
  const matches = (await readMatches()).map(m => hydrate(m, refs)).sort((a, b) => b.created.localeCompare(a.created));
  if (full) return matches.map(m => sheet(m, src));
  return matches.map(m => ({ id: m.id, opponentId: m.opponentId, opponent: m.opponent, tournament: m.tournament ?? null, created: m.created, format: formatOf(m), videos: m.videos || [], ...summary(m) }));
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
    const urls = lanAddresses().map(ip => `http://${ip}:${PORT}/quick.html`); // телефон — только пульт
    return { urls, qr: urls.length ? await QRCode.toDataURL(urls[0], { margin: 1, width: 320 }) : null };
  }
  if (route === 'GET /api/matches') return listMatches(url.searchParams.has('full'), srcOf(url));
  if (route === 'POST /api/matches') {
    const { opponentId, format, tournament } = await readBody(req);
    // Формат матча (до скольки побед, до скольки очков) — запоминаем как последний выбранный.
    const fmt = format && Number.isInteger(format.sets) && format.sets >= 1 && format.sets <= 5 ? { sets: format.sets, points: +format.points || 25, tiebreak: +format.tiebreak || 15 } : null;
    if (fmt) await serial(async () => { const st = await readSettings(); st.lastFormat = fmt; await writeJson(settingsFile, st); });
    const refs = await loadRefs();
    const match = {
      id: Date.now().toString(36),
      opponentId,
      ...(fmt && { format: fmt }),
      // Турнир: явно выбранный или текущий из настроек — матчи с турнира группируются в аналитике.
      ...((tournament ?? refs.settings.activeTournament) && { tournament: tournament ?? refs.settings.activeTournament }),
      opponent: refs.settings.opponents.find(o => o.id === opponentId)?.name || 'Соперник', // запасное имя, если соперника удалят
      created: new Date().toISOString(),
      roster: refs.roster.filter(p => p.active !== false), // копия состава на момент матча — только активные игроки
      // Пресет команды (расстановки + схема) — активный в настройках; схема — из пресета.
      ...(() => { const pr = refs.settings.presets?.find(x => x.id === refs.settings.activePreset); return { system: pr?.system || refs.settings.system || '5-1', ...(pr && { preset: pr.id }) }; })(),
      videos: [],
      stats: emptyStats(),
    };
    return serial(async () => { await writeJson(matchFile(match.id), match); return sheet(hydrate(match, refs), srcOf(url)); });
  }

  // ---------- Экспорт и импорт ----------
  // Пакет команды (без матчей): состав, форма и эмблема, схема и расстановки, соперники — ZIP.
  if (route === 'GET /api/export/team') {
    const parts = (url.searchParams.get('parts') || Object.keys(TEAM_PARTS).join(',')).split(',').filter(k => TEAM_PARTS[k]);
    const f = buildTeamPackage(await loadRefs(), parts);
    return download(f.name, f.data);
  }
  // Посмотреть пакет перед загрузкой: что внутри.
  if (route === 'POST /api/import/team/preview') {
    try {
      const t = readTeamPackage(await readRaw(req));
      return { teamName: t.teamName, exported: t.exported, parts: t.parts, players: t.roster?.length ?? 0, opponents: t.opponents?.length ?? 0, presets: t.play?.presets?.length ?? (t.play?.formations ? 1 : 0) };
    } catch (e) { return { error: e.message }; }
  }
  if (route === 'POST /api/import/team') {
    let team;
    try { team = readTeamPackage(await readRaw(req)); } catch (e) { return { error: e.message }; }
    const parts = (url.searchParams.get('parts') || '').split(',').filter(k => TEAM_PARTS[k]);
    return serial(async () => {
      await makeBackup('перед загрузкой пакета команды');
      const refs = await loadRefs();
      const { roster, settingsPatch, report } = applyTeamPackage(refs, team, parts);
      await writeJson(rosterFile, roster);
      await writeJson(settingsFile, { ...refs.settings, ...settingsPatch });
      return report;
    });
  }
  // Один матч: события, состав на матч, соперник — ZIP (видео не входит).
  const em = url.pathname.match(/^\/api\/export\/match\/([a-z0-9]+)$/);
  if (em && req.method === 'GET') {
    const m = await readMatch(matchFile(em[1]));
    if (!m) return null;
    const refs = await loadRefs();
    const f = buildMatchPackage(hydrate(m, refs), { ...refs, videos: await readJson(videosFile, []) }, LABELS);
    return download(f.name, f.data);
  }
  if (route === 'POST /api/import/match') {
    let pkg;
    try { pkg = readMatchPackage(await readRaw(req)); } catch (e) { return { error: e.message }; }
    return serial(async () => {
      const refs = await loadRefs();
      const ids = new Set((await readdir(DATA)).map(f => /^match-([a-z0-9]+)\.json$/.exec(f)?.[1]).filter(Boolean));
      const list = await readJson(videosFile, []);
      const { match, roster, opponents, videos } = importMatch({ ...refs, ids, videos: list }, pkg);
      if (videos.length) await writeJson(videosFile, [...videos, ...list]);
      await writeJson(rosterFile, roster);
      await writeJson(settingsFile, { ...refs.settings, opponents });
      await writeJson(matchFile(match.id), match);
      return { id: match.id, opponent: match.opponent, events: MODE_KEYS.reduce((a, k) => a + match.stats[k].events.length, 0) };
    });
  }
  // Статистика игроков по детальным режимам (в матче — студия, а если её нет — ручной) — таблица для Excel.
  if (route === 'GET /api/export/stats.csv') {
    const refs = await loadRefs();
    const matches = (await readMatches()).map(m => hydrate(m, refs)).map(m => sheet(m, m.stats.studio.events.length ? 'studio' : 'manual')).filter(m => m.events.length);
    return download(`Статистика_${refs.settings.teamName || 'команда'}_${new Date().toISOString().slice(0, 10)}.csv`, statsCsv(matches), 'text/csv; charset=utf-8');
  }

  // ---------- Резервные копии и корзина ----------
  if (route === 'GET /api/backups') return listBackups();
  if (route === 'POST /api/backups') return serial(() => makeBackup('ручная'));
  // Весь набор данных одним файлом (перенести на другой ноутбук, сохранить в облако).
  if (route === 'GET /api/backup/file') return { ...(await snapshot()), app: 'volleyball-metrics', exported: new Date().toISOString() };
  if (route === 'POST /api/backup/file') {
    const data = await readBody(req);
    if (!data || !Array.isArray(data.matches) || !Array.isArray(data.roster)) return { error: 'Это не файл резервной копии' };
    return serial(async () => { await makeBackup('перед восстановлением'); await restoreSnapshot(data); return { ok: true, matches: data.matches.length }; });
  }
  const bm = url.pathname.match(/^\/api\/backups\/([\w-]+)\/restore$/);
  if (bm && req.method === 'POST') {
    return serial(async () => {
      const dir = path.join(BACKUPS, path.basename(bm[1]));
      const data = await readJson(path.join(dir, 'backup.json'), null);
      if (!data) return null;
      await makeBackup('перед восстановлением');
      await restoreSnapshot(data);
      return { ok: true, matches: data.matches.length };
    });
  }
  if (route === 'GET /api/trash') {
    await mkdir(TRASH, { recursive: true });
    const files = (await readdir(TRASH)).filter(f => /match-[a-z0-9]+\.json$/.test(f));
    const items = await Promise.all(files.map(async f => {
      const raw = await readJson(path.join(TRASH, f), null).catch(() => null), m = raw && migrate(raw);
      return m && { file: f, id: m.id, opponent: m.opponent, created: m.created, deleted: f.slice(0, 19), events: MODE_KEYS.reduce((a, k) => a + m.stats[k].events.length, 0) };
    }));
    return items.filter(Boolean).sort((a, b) => b.file.localeCompare(a.file));
  }
  const tm = url.pathname.match(/^\/api\/trash\/([^/]+)\/restore$/);
  if (tm && req.method === 'POST') {
    return serial(async () => {
      const f = path.basename(decodeURIComponent(tm[1]));
      const id = f.match(/match-([a-z0-9]+)\.json$/)?.[1];
      if (!id) return null;
      if (await readJson(matchFile(id), null)) return { error: 'Матч с таким номером уже есть' };
      await rename(path.join(TRASH, f), matchFile(id));
      return { ok: true, id };
    });
  }

  // ---------- Видеотека ----------
  // Прогресс подготовки видео живёт в памяти — подмешиваем его в список.
  if (route === 'GET /api/videos') return (await readJson(videosFile, [])).map(v => (jobs.has(v.id) ? { ...v, progress: jobs.get(v.id) } : v));
  // Ссылка на YouTube: в библиотеке рядом с файлами, только без файла. Та же ссылка второй раз не добавляется.
  if (route === 'POST /api/videos/youtube') {
    const { url: link, name } = await readBody(req);
    const youtube = youtubeId(link);
    if (!youtube) return { error: 'Не похоже на ссылку YouTube' };
    return serial(async () => {
      const list = await readJson(videosFile, []);
      const same = list.find(v => v.youtube === youtube);
      if (same) return same;
      const video = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: String(name ?? '').trim() || `YouTube · ${youtube}`, youtube, created: new Date().toISOString(), status: 'ready' };
      await writeJson(videosFile, [video, ...list]);
      return video;
    });
  }
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
    const segs = (segments || []).map(sg => ({ ...sg, v: list.find(v => v.id === sg.video) })).filter(sg => sg.v?.file && sg.end > sg.start)
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
      if (v.file) await rename(path.join(VIDEOS, v.file), path.join(TRASH, 'videos', v.file)).catch(() => {});
      await writeJson(videosFile, list.filter(x => x !== v));
      return { ok: true };
    });
  }

  const m = url.pathname.match(/^\/api\/matches\/([a-z0-9]+)(\/events(\/last|\/(\d+))?)?$/);
  if (!m) return null;
  const file = matchFile(m[1]), src = srcOf(url);
  const view = async match => sheet(hydrate(match, await loadRefs()), src);
  if (req.method === 'GET' && !m[2]) {
    const match = await readMatch(file);
    return match && view(match);
  }
  // Свойства матча: привязанные видео, схема игры.
  if (req.method === 'PATCH' && !m[2]) {
    const patch = await readBody(req);
    return serial(async () => {
      const match = await readMatch(file);
      if (!match) return null;
      if (Array.isArray(patch.videos)) match.videos = patch.videos;
      if (typeof patch.system === 'string') match.system = patch.system;
      if (typeof patch.preset === 'string') match.preset = patch.preset;
      if (typeof patch.scout === 'boolean') match.scout = patch.scout; // скаутинг соперника в этом матче
      if (typeof patch.tournament === 'string') { if (patch.tournament) match.tournament = patch.tournament; else delete match.tournament; }
      // Роли на этот матч: { id игрока → роль }; пустая роль — как в команде.
      if (patch.roles && typeof patch.roles === 'object') match.roles = Object.fromEntries(Object.entries(patch.roles).filter(([, r]) => r));
      if (patch.format && Number.isInteger(patch.format.sets)) match.format = { sets: patch.format.sets, points: +patch.format.points || 25, tiebreak: +patch.format.tiebreak || 15 };
      await writeJson(file, match);
      return view(match);
    });
  }
  // Правка события по номеру (по видео): заменить или удалить любое, не только последнее.
  if (m[4] && (req.method === 'PUT' || req.method === 'DELETE')) {
    const k = Number(m[4]);
    const ev = req.method === 'PUT' ? await readBody(req) : null;
    return serial(async () => {
      const match = await readMatch(file);
      const evs = match?.stats[src].events;
      if (!match || k >= evs.length) return null;
      if (ev) evs[k] = ev; else evs.splice(k, 1);
      await writeJson(file, match);
      return view(match);
    });
  }
  if (req.method === 'POST' && m[2] && !m[3]) {
    const ev = await readBody(req);
    // ?at=N — вставить перед событием N (пропущенное касание, найденное на видео).
    const at = url.searchParams.has('at') ? Number(url.searchParams.get('at')) : null;
    return serial(async () => {
      const match = await readMatch(file);
      if (!match) return null; // матч удалили с другого устройства
      const evs = match.stats[src].events;
      // Повтор того же нажатия (ответ потерялся при плохой связи) — второй раз не добавляем.
      if (ev?.cid && evs.some(e => e.cid === ev.cid)) return view(match);
      if (at !== null && at >= 0 && at < evs.length) evs.splice(at, 0, ev);
      else evs.push(ev);
      await writeJson(file, match);
      return view(match);
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
    // ?expect=N — удалить последнее, только если событий ровно N (повтор отмены при плохой связи не удалит лишнего).
    const expect = url.searchParams.has('expect') ? Number(url.searchParams.get('expect')) : null;
    return serial(async () => {
      const match = await readMatch(file);
      if (!match) return null;
      const evs = match.stats[src].events;
      if (expect !== null && evs.length !== expect) return view(match);
      evs.pop();
      await writeJson(file, match);
      return view(match);
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
      if (result?.[FILE]) {
        const f = result[FILE], body = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
        res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': body.length, 'Content-Disposition': `attachment; filename="export"; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'Cache-Control': 'no-store' });
        return res.end(body);
      }
      res.writeHead(result === null ? 404 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(result));
    }
    // await обязателен: иначе ошибка (например, файла уже нет) мимо catch роняет весь сервер.
    if (url.pathname.startsWith('/media/')) return await sendVideo(req, res, decodeURIComponent(url.pathname.slice(7)));
    if (url.pathname.startsWith('/clips/')) return await sendVideo(req, res, decodeURIComponent(url.pathname.slice(7)), CLIPS);
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

// Страховка на турнире: неожиданная ошибка пишется в окно сервера, а не останавливает его посреди матча.
process.on('unhandledRejection', e => console.error('  Ошибка (сервер продолжает работать):', e?.message ?? e));
process.on('uncaughtException', e => console.error('  Ошибка (сервер продолжает работать):', e?.message ?? e));

// Подготовка видео прервалась (закрыли окно сервера) — продолжаем после запуска.
for (const v of await readJson(videosFile, [])) if (v.status === 'processing' && hasFfmpeg()) enqueue(v.id);

await migrateFiles().catch(e => console.error('  Не удалось перевести матчи:', e.message));
dailyBackup();
setInterval(dailyBackup, 3600e3).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Волей Метрика запущена`);
  console.log(`  Компьютер: http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  Телефон:   http://${ip}:${PORT}/quick.html`);
  console.log(`\n  QR-код для телефона — в «Настройках». Не закрывай это окно, пока идёт матч.\n`);
});
