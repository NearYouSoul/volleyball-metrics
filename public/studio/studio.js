// Студия — десктопная программа для разбора матча по видео и детальной статистики.
// Состояние матча, как и везде, вычисляет engine.js из списка событий на сервере;
// здесь — только интерфейс: видео, 3D-площадка, ввод касаний, правка и вставка событий.
import { replay, playerName, LABELS, ACTIONS, SKILLS, totals, attEff, recRating, newPlayer, addStats, setTitle, setTarget, formatOptions, formatKey, pickFormat, formatName, formatOf } from '../engine.js';
import { ZONE_SPOT, DEFAULT_SPOT, TEMPOS, SYSTEMS, guessSetter, zoneOf, SET_DIRS, setDir, NET, ROLES, roleOf, zoneOfSlot, slotZones } from '../court.js';
import { createCourt3D, KIT_DEFAULT } from './court3d.js';
import { initTips } from './tips.js';
import { gradeAt, digRes, zonesOf, defaultZones, GRADES, COLS, ROWS, CELL } from '../quality.js';
import { SITUATIONS, spotFor, tableFor, defaultSpot, ATTACK, SETTER_SPOT, defenseLayout, blockSide, overlapIssues, attackByRole, frontByRole } from '../formations.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (id, cls = '') => `<svg class="${cls}"><use href="#${id}"/></svg>`;
const newId = () => Math.random().toString(36).slice(2, 8);
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem('studio.' + k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('studio.' + k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};

const video = $('video');
const ui = {
  roster: [], settings: { teamName: 'Мы', opponents: [] }, matches: [], videos: [],
  match: null, full: null, st: null,
  sel: null, group: null, pending: {}, tempo: 'h', h: null,
  insertAt: null, edit: null, editPoints: false,
  tab: 'events', filter: { skill: '', p: '' },
  activeVideo: null, sub: null, uploads: [], playlist: null, resumeAfter: false, busy: false,
  trackSets: store.get('trackSets', true), view: 'persp',
  draft: null, moved: {}, movedKey: '', mouse: null, setH: null, menu: null, zones: null,
  sync: store.get('sync', false), syncRate: store.get('syncRate', 0.75), loopLen: store.get('loopLen', 5), seekStep: store.get('seekStep', 5), anchor: null, loops: 0, ff: false, rate: 1, manualPause: false,
  evView: store.get('evView', 'rallies'), focusRally: null,
};

// ---------- Сервер ----------
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}
async function call(fn) {
  if (ui.busy) return;
  ui.busy = true;
  try { await fn(); } catch (e) { toast('Не сохранилось: ' + e.message, true); console.error(e); }
  ui.busy = false;
  render();
}
let toastTimer;
function toast(text, err = false, action = null) {
  const t = $('toast');
  t.textContent = text;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label; b.className = 'toast-act';
    b.onclick = () => { t.className = 'toast'; action.fn(); };
    t.append(b);
  }
  t.className = 'toast on' + (err ? ' err' : '') + (action ? ' act' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), action ? 6000 : 2600);
}

function setMatch(match) {
  ui.match = match;
  recompute();
  // Краткая сводка в списке матчей — без лишнего запроса к серверу.
  const sum = ui.matches.find(x => x.id === match.id);
  if (sum) Object.assign(sum, { events: match.events.length, setsWon: ui.full.setsWon, videos: match.videos || [] });
  if (location.hash !== '#m=' + match.id) history.replaceState(null, '', '#m=' + match.id);
  store.set('lastMatch', match.id);
}
// full — весь матч (для списка событий), st — состояние «в точке ввода» (при вставке — до неё).
function recompute() {
  const m = ui.match;
  ui.full = replay(m);
  if (ui.insertAt !== null && ui.insertAt >= m.events.length) ui.insertAt = null;
  ui.st = ui.insertAt === null ? ui.full : replay({ ...m, events: m.events.slice(0, ui.insertAt) });
  lastForm = null;
  if (ui.st.set && !ui.st.set.over) lastForm = formation(ctx());
}

const name = id => (ui.match ? playerName(ui.match, id) : '?');
const person = id => ui.match?.roster.find(p => p.id === id) || {};
const setters = () => new Set((ui.match?.roster || []).filter(p => p.setter).map(p => p.id));
const fmt = t => {
  if (t == null || isNaN(t)) return '—';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};
const fmtShort = t => (t == null || isNaN(t) ? '0:00' : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`);
const mb = n => (n > 1e9 ? (n / 1e9).toFixed(1) + ' ГБ' : Math.round(n / 1e6) + ' МБ');

// ---------- Розыгрыш: что сейчас вводим ----------
const live = () => ui.st?.set && !ui.st.set.over;
const rallyPlays = () => ui.st?.rally?.plays ?? [];

// Какая группа действий нужна по фазе. После приёма/защиты — пас (если включено), после паса — атака.
function mainGroup() {
  const r = ui.st?.rally;
  if (!r) return 'att';
  if (r.phase === 'serve') return 'serve';
  if (r.phase === 'rec') return 'rec';
  if (r.phase === 'their') return 'def';
  const last = rallyPlays().filter(p => !p.virtual).at(-1);
  return ui.trackSets && last?.skill !== 'set' ? 'set' : 'att';
}
const group = () => ui.group || mainGroup();

const GROUPS = {
  serve: { label: 'Подача', icon: 's-serve', key: 'A', acts: [['serve', 'ace', 'Эйс', 'g'], ['serve', 'good', 'Сложная', 'g'], ['serve', 'in', 'В игру', 'n'], ['serve', 'error', 'Ошибка', 'r']] },
  rec: { label: 'Приём', icon: 's-rec', key: 'S', acts: [['rec', 'pp', '++ идеально', 'g'], ['rec', 'pm', '+ хороший', 'y'], ['rec', 'p', '− плохой', 'n'], ['rec', 'over', 'Перекид', 'y'], ['rec', 'error', 'Не принял', 'r']] },
  set: { label: 'Пас', icon: 's-set', key: 'D', acts: [['set', 'perfect', 'Идеальный', 'g'], ['set', 'good', 'Хороший', 'n'], ['set', 'poor', 'Неудобный', 'y'], ['set', 'over', 'Перевод к ним', 'n'], ['set', 'error', 'Ошибка паса', 'r']] },
  att: { label: 'Атака', icon: 's-att', key: 'F', acts: [['att', 'kill', 'Забил', 'g'], ['att', 'bo', 'От блока', 'g'], ['att', 'play', 'В игре', 'n'], ['att', 'error', 'Аут / сетка', 'r'], ['att', 'blocked', 'Заблокир.', 'r']] },
  def: { label: 'Защита и блок', icon: 's-dig', key: 'G', acts: [['dig', 'plus', 'Защита +', 'n'], ['dig', 'minus', 'Защита −', 'y'], ['dig', 'error', 'Не поднял', 'r'], ['blk', 'point', 'Блок: очко', 'g'], ['blk', 'touch', 'Касание блоком', 'y'], ['blk', 'out', 'Блок-аут', 'r']] },
  fault: { label: 'Ошибка', icon: 's-fault', key: 'H', acts: [['fault', 'net', 'Сетка', 'r'], ['fault', 'line', 'Заступ', 'r'], ['fault', 'reach', 'На их стороне', 'r'], ['fault', 'four', 'Четыре касания', 'r'], ['fault', 'double', 'Двойное', 'r'], ['fault', 'catch', 'Захват', 'r'], ['fault', 'rot', 'Переход / расстановка', 'r'], ['fault', 'back', 'Атака задней линии', 'r'], ['fault', 'error', 'Прочее', 'r']] },
};
const ACT_KEYS = ['Q', 'W', 'E', 'R', 'T', 'Y'];
const DISPLAY_SKILL = { serve: 'serve', rec: 'rec', set: 'set', att: 'att', def: 'dig', fault: null };

function guessedSetter() {
  const st = ui.st;
  if (!live()) return null;
  return guessSetter({ system: ui.match.system, lineup: st.set.lineup, zones: st.rally.zones, setters: setters(), main: st.set.main });
}
// Кто выполняет действие: выбранный игрок, иначе подающий (подача) или связующий по схеме (пас).
function actor(skill) {
  if (skill === 'serve') return ui.st.rally.server;
  if (ui.sel) return ui.sel;
  if (ui.draft?.touch) return ui.draft.touch.p;
  const c = ctx();
  if (skill === 'set' && c?.stage === 'set') return c.p;
  if (skill === 'att' && c?.stage === 'att') return c.p;
  if (skill === 'set') return guessedSetter();
  return null;
}

// ---------- Отправка событий ----------
// Отклик мгновенный: событие сразу применяется на экране, а на сервер уходит в очередь (по порядку).
// Если сервер не ответил — перечитываем матч с сервера и громко сообщаем.
// Время касания в видео. Если шаг начали кликом раньше (точка), берём время того клика — момент касания, а не подтверждения.
const curT = () => (ui.activeVideo && video.src && !isNaN(video.currentTime) ? +video.currentTime.toFixed(2) : null);
function stamp(ev) {
  if (ui.activeVideo && video.src) { ev.v = ui.activeVideo; if (ev.vt == null) ev.vt = curT(); }
  if (ev.vt == null) delete ev.vt;
  return ev;
}
let sendChain = Promise.resolve(), inFlight = 0;
function queue(fn) {
  inFlight++;
  sendChain = sendChain.then(fn).then(m => {
    if (--inFlight === 0 && m && m.id === ui.match?.id) { const ins = ui.insertAt; setMatch(m); ui.insertAt = ins; recompute(); render(); }
  }).catch(async e => {
    inFlight = 0;
    toast('Не сохранилось на компьютере: ' + e.message, true);
    if (ui.match) { setMatch(await api('GET', `/api/matches/${ui.match.id}`)); render(); }
  });
}
function postEvent(ev) {
  ui.focusRally = null; ui.pickedRally = false;
  const at = ui.insertAt, id = ui.match.id, before = rallyKey();
  if (at === null) ui.match.events.push(ev); else { ui.match.events.splice(at, 0, ev); ui.insertAt = at + 1; }
  recompute();
  // Розыгрыш закончился — видео дальше (петля синхронизации выключается). Иначе — следующий шаг от этого кадра.
  if (rallyKey() !== before) { ui.anchor = null; resume(); } else syncStep(ev.vt);
  render();
  queue(() => api('POST', `/api/matches/${id}/events${at !== null ? `?at=${at}` : ''}`, ev));
}
function sendAct(skill, res) {
  if (!live()) return toast('Партия не идёт — начните партию во вкладке «Матч»', true);
  if (skill === 'serve' && !ui.st.rally.weServe) return toast('Сейчас подаёт соперник', true);
  const c = ctx();
  // На шаге паса кнопки качества не отправляют пас, а выбирают качество (кроме ошибки).
  if (skill === 'set' && c?.stage === 'set' && res !== 'error' && res !== 'over') { setQuality(res); return; }
  const p = actor(skill);
  if (!p && skill !== 'team' && !(skill === 'fault' && res === 'rot')) return toast('Выберите игрока: клик по фишке на площадке или клавиши 1–6 (номер зоны)', true);
  const ev = stamp({ t: 'act', skill, res, p: skill === 'team' ? null : p });
  const t = ui.draft?.touch;
  if (t && (skill === t.kind || (t.kind === 'dig' && skill === 'blk'))) { ev.p = ui.sel ?? t.p; ev.to = t.at; if (t.from) ev.from = t.from; }
  if (skill === 'set' && c?.stage === 'set') { ev.p = ui.sel ?? c.p; ev.from = c.from; }
  if (skill === 'att' && c?.stage === 'att') { ev.p = ui.sel ?? c.p; ev.from = c.from; }
  if (skill === 'set') { ev.tempo = tempoOfH(curH()); ev.h = curH(); }
  scoutTag(ev);
  ui.sel = null; ui.group = null; ui.setH = null; ui.draft = null;
  postEvent(ev);
}
const sendRaw = ev => { ui.sel = null; ui.group = null; ui.draft = null; postEvent(stamp(ev)); };
function resume() {
  if (ui.resumeAfter || (ui.sync && video.src && video.paused && !ui.manualPause)) { ui.resumeAfter = false; video.playbackRate = ui.sync ? ui.syncRate : ui.rate; video.play().catch(() => {}); }
}
// Режим синхронизации: после каждого шага видео идёт дальше от кадра касания; если следующее касание
// не отмечено за ui.loopLen секунд — возвращаемся к нему (петля), второй круг медленнее.
function syncStep(t) {
  if (!ui.sync || t == null) return;
  ui.anchor = t; ui.loops = 0;
  if (video.paused && !ui.manualPause) { video.playbackRate = ui.syncRate; video.play().catch(() => {}); }
  paintSyncHud();
}
function pauseForInput() {
  if (ui.ff) stopFF();
  if ((ui.sync || $('autoPause').checked) && video.src && !video.paused) { video.pause(); ui.resumeAfter = !ui.sync; }
}

// Шаг назад. Сначала — незаконченный шаг на площадке; потом — последнее событие, и ввод возвращается
// ровно на тот шаг, где это событие вводили (удалили пас — снова тянем дугу паса от той же точки).
function undo() {
  closeMenu();
  const d = ui.draft;
  if (d?.await) { ui.draft = d.await.prev; return render(); }
  if (d?.touch) { ui.draft = null; return render(); }
  if (!ui.match?.events.length) return;
  const k = ui.insertAt !== null ? ui.insertAt - 1 : ui.match.events.length - 1;
  if (k < 0) return;
  const ev = ui.match.events[k];
  ui.match.events.splice(k, 1);
  if (ui.insertAt !== null) ui.insertAt = k;
  recompute();
  ui.draft = null; ui.sel = null; ui.setH = null;
  // Откат возвращает и видео — на кадр удалённого касания.
  if (ev.vt != null && ev.v === ui.activeVideo && video.src) { video.pause(); seekTo(ev.vt); if (ui.sync) ui.anchor = ev.vt; }
  if (ev.t === 'act' && live()) {
    if (ev.skill === 'set' && ev.from) { ui.draft = { set: { p: ev.p, from: ev.from, q: ev.res, t: ev.vt ?? null } }; ui.setH = ev.h ?? null; }
    else if ((ev.skill === 'rec' || ev.skill === 'dig') && ev.to && ev.res !== 'error') ui.draft = { touch: { kind: ev.skill, p: ev.p, at: ev.to, from: ev.from ?? null, t: ev.vt ?? null } };
  }
  render();
  const id = ui.match.id;
  queue(() => api('DELETE', `/api/matches/${id}/events/${k}`));
}

// ---------- 3D-площадка: розыгрыш по касаниям ----------
// На нашей стороне до трёх касаний. Каждый шаг: клик по точке → подсвечен вероятный игрок (пульсирует) →
// клик по нему (или по другому) завершает шаг. Клик сразу по фишке — «этот игрок, там, где стоит».
//   1 — приём/защита: куда пришёл мяч;
//   2 — доводка: куда мяч пришёл к пасующему → оценка приёма по зонам доводки;
//   3 — пас: дуга за мышью (колесо — высота), точка — откуда бьют → нападающий; дальше — куда ударили.

const court = createCourt3D($('court3d'), {
  onPick: (p, e, hit) => onCourtPick(p, e, hit),
  onHover: (p, e, hit) => {
    const el = $('courtHover');
    if (hit?.net && !hit.player && !hit.hands && ctx()?.stage !== 'their') hit = null;
    ui.mouse = p;
    // Пока мяч у соперника, сетка важнее игроков у сетки: мышь на сетке — предпросмотр блока и перестроения.
    const their = ctx()?.stage === 'their';
    const fixed = !!ui.draft?.block;
    const netX = their && !(fixed && hit?.hands) ? (hit?.net?.x ?? (inNetBand(p) ? p.x : null)) : null;
    const hp = netX != null ? null : hit?.player ?? null;
    const bh = their && !ui.draft?.block && netX != null ? { x: +Math.max(0, Math.min(9, netX)).toFixed(1) } : null;
    if (JSON.stringify(bh) !== JSON.stringify(ui.blockHover)) { ui.blockHover = bh; ui.cand = undefined; }
    const cand = liveCandidate(p);
    if (hp !== ui.hoverPid || cand !== ui.cand) { ui.hoverPid = hp; ui.cand = cand; paintPlayers(); }
    if (!p) { el.classList.remove('on'); paintPreview(); return; }
    el.classList.add('on');
    el.textContent = hp ? name(hp) : hit?.hands ? (hit.hands === 'us' ? 'наш блок' : 'блок соперника') : `${p.y < NET ? 'наша' : 'их'} зона ${p.zone ?? '—'} · x ${p.x.toFixed(1)} · y ${p.y.toFixed(1)}`;
    paintPreview();
  },
  onWheel: dir => {
    if (ctx()?.stage !== 'set') return;
    ui.setH = Math.max(2.6, Math.min(9, +(curH() - dir * 0.35).toFixed(2)));
    paintPreview(); paintBar(); paintDock(); paintHud();
  },
});
// Подписи над игроками: номер / имя / как записан / без подписи (запоминается).
const LABEL_ICON = { num: '№', name: 'Аб', full: '№А', none: '–' };
function paintLabelBtn() { const b = $('labelBtn'); if (b) b.querySelector('b').textContent = LABEL_ICON[store.get('labelMode', 'num')] ?? '№'; }
court.setLabelMode(store.get('labelMode', 'num'));
paintLabelBtn();
// Режим подсказок: кнопка «?» в верхней панели (запоминается). Включён — подсказка у курсора через ~0,8 с.
const tips = initTips({ get: () => store.get('tips', false), set: v => store.set('tips', v), button: $('tipsBtn') });
// Детализация игроков: реалистичные или простые (запоминается).
function paintDetailBtn() { const b = $('detailBtn'); if (b) { const real = store.get('detail', 'real') === 'real'; b.classList.toggle('on', real); b.querySelector('b').textContent = real ? 'HD' : 'Lo'; } }
court.setDetail(store.get('detail', 'real'));
paintDetailBtn();
// Настройки вида при запуске: сетка зон, ракурс камеры, пауза при вводе.
if (!store.get('zonesOn', true)) { court.toggleZones(false); document.querySelector('[data-a=zones]')?.classList.remove('on'); }
if (store.get('view3d', 'persp') !== 'persp') { const v = store.get('view3d', 'persp'); court.setView(v); document.querySelectorAll('[data-a=view]').forEach(b => b.classList.toggle('on', b.dataset.v === v)); }
$('autoPause').checked = store.get('autoPause', true);
$('autoPause').addEventListener('change', e => store.set('autoPause', e.target.checked));

const inCourtUs = p => p.x >= 0 && p.x <= 9 && p.y >= 0 && p.y < NET;
const inCourtThem = p => p.x >= 0 && p.x <= 9 && p.y >= NET && p.y <= 18;
const rallyKey = () => (ui.st?.set ? `${ui.st.set.n}:${ui.st.rally.no}` : '');
const curH = () => ui.setH ?? TEMPOS[ui.tempo].h;
const tempoOfH = h => (h < 3.6 ? 'q' : h < 5 ? 'f' : 'h');
const TEMPO_NAME = { q: '1 темп', f: '2 темп', h: '3 темп' };
const SET_Q = { perfect: 'идеальный', good: 'хороший', poor: 'неудобный' };
function setQuality(q) {
  const c = ctx();
  if (c?.stage !== 'set') return;
  ui.draft = { ...ui.draft, set: { ...ui.draft?.set, p: c.p, from: c.from, q } };
  render();
}

const zoneOfId = id => ui.st.rally.zones[ui.st.set.lineup.indexOf(id)];
const frontRow = () => ui.st.set.lineup.filter(id => isFrontZone(zoneOfId(id)));
const isFrontZone = z => z >= 2 && z <= 4;

// ---------- Пресеты команды ----------
// Пресет — именованный набор: схема игры, стартовый состав и все расстановки (приём, подача, защита, атака по Р1–Р6).
// Матч использует свой пресет (выбирается во вкладке «Матч»), новые матчи — активный пресет из настроек.
function presets() {
  const list = ui.settings.presets;
  if (list?.length) return list;
  return [{ id: 'main', name: 'Основной', system: ui.settings.system || '5-1', formations: ui.settings.formations ?? {} }];
}
const presetById = id => presets().find(p => p.id === id);
// Роль игрока с учётом матча: в этом матче ЦБ может играть доигровщика (match.roles), иначе — роль в команде.
const roleIn = id => ui.match?.roles?.[id] ?? roleOf(person(id)?.id ? person(id) : ui.roster.find(p => p.id === id));
const curPreset = () => presetById(ui.match?.preset) ?? presetById(ui.settings.activePreset) ?? presets()[0];
const FORM = () => curPreset().formations ?? {};

// ---------- Расстановка по ситуации ----------
// Подача, приём и защита — из расстановок команды (редактор «Расстановки», по умолчанию — стандартные).
// Атака одинаковая: нападающие на разбеге, связующий (в том числе из задней линии) выходит к сетке.
function formation(c) {
  const st = ui.st, out = {};
  const gs = guessedSetter();
  const stage = c?.stage === 'await' ? c.base : c?.stage;
  const kind = stage === 'serve' ? 'serve' : stage === 'rec' ? 'rec' : stage === 'their' ? 'def' : stage ? 'att' : 'serve';
  const rot = st.rally.rot, F = FORM();
  // Атака: настроенная в редакторе для этой расстановки — по ней; иначе — по ролям игроков.
  const byRole = kind === 'att' && !F.touched?.att?.[rot]
    ? attackByRole(st.set.lineup.map(id => ({ id, zone: zoneOfId(id), role: roleOf(person(id)), front: isFrontZone(zoneOfId(id)) })), gs) : null;
  for (const id of st.set.lineup) {
    const z = zoneOfId(id);
    // Атака: из расстановок команды; пасующий (если пасует не тот, кто в зоне связующего, — например, в 4-2) — к сетке.
    let s = kind === 'att' ? (byRole ? byRole[id] : id === gs && z !== rot ? SETTER_SPOT : spotFor(F, 'att', rot, z)) : spotFor(F, kind, rot, z);
    if (kind === 'serve' && st.rally.server === id) s = { x: 7.6, y: -0.9 };
    out[id] = s;
  }
  if (kind === 'def') {
    // Блок поставлен (или мышь у сетки) — команда перестраивается под блок слева / по центру / справа.
    const lay = blockLayout();
    if (lay) for (const id of st.set.lineup) out[id] = lay.spots[zoneOfId(id)] ?? out[id];
  }
  return out;
}
let lastForm = null;
// lastForm считается при отрисовке фишек; до первой отрисовки — обычные зоны (без вызова ctx, чтобы не зациклиться).
function posOf(id) { return ui.moved[id] ?? lastForm?.[id] ?? ZONE_SPOT[zoneOfId(id)] ?? ZONE_SPOT[1]; }
function nearest(p, { exclude = [], only = null } = {}) {
  let best = null, bd = 1e9;
  for (const id of ui.st.set.lineup) {
    if (exclude.includes(id) || (only && !only.includes(id))) continue;
    const s = posOf(id), d = Math.hypot(s.x - p.x, s.y - p.y);
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}
// Наш блок: зафиксированный кликом у сетки (ui.draft.block) или предпросмотр под мышью (ui.blockHover).
function blockLayout() {
  if (!ui.st?.set) return null;
  const b = ui.draft?.block ?? ui.blockHover;
  if (!b) return null;
  const base = tableFor(FORM(), 'def', ui.st.rally.rot);
  return defenseLayout(base, b);
}
function ourBlockers() {
  const lay = blockLayout();
  if (!lay) return [];
  return ui.st.set.lineup.filter(id => lay.blockers.includes(zoneOfId(id))).map(id => ({ id, x: lay.spots[zoneOfId(id)].x }));
}
// Полоса у сетки на нашей стороне: здесь ставится блок.
const inNetBand = p => p && p.y >= NET - 0.45 && p.y < NET + 0.35 && p.x > -0.5 && p.x < 9.5;

// Текущий шаг. Без черновика шаг выводится из состояния розыгрыша — ввод с телефона и правки поток не ломают.
function ctx() {
  if (!live() || ui.editPoints) return null;
  const st = ui.st, r = st.rally, d = ui.draft || {};
  if (d.await) return { stage: 'await', ...d.await };
  if (d.touch) return { stage: 'touch2', touch: d.touch };
  if (r.phase === 'serve') return { stage: 'serve', p: r.server };
  if (r.phase === 'rec') return { stage: 'rec' };
  if (r.phase === 'their') return { stage: 'their', origin: d.origin ?? null, block: d.block ?? null };
  const last = rallyPlays().filter(p => !p.virtual).at(-1);
  if (d.att || last?.skill === 'set') {
    const from = d.att?.from ?? last?.to ?? spotOfTarget({ dir: 4 });
    return { stage: 'att', from, t: d.att?.t ?? null, p: d.att?.p ?? last?.target ?? nearest(from, { exclude: last?.skill === 'set' ? [last.p] : [] }) };
  }
  if (d.set || (last && ['rec', 'dig'].includes(last.skill))) {
    const gs = guessedSetter();
    return { stage: 'set', from: d.set?.from ?? SETTER_SPOT, p: d.set?.p ?? gs, q: d.set?.q ?? 'good', t: d.set?.t ?? null };
  }
  return { stage: 'free' };
}
const touchNo = c => ({ rec: 1, their: 1, free: 1, touch2: 2, set: 3, att: 3, await: c?.kind === 'touch' ? 1 : c?.kind === 'setter' ? 2 : 3 })[c?.stage] ?? 0;
const baseStage = c => (c?.stage === 'await' ? c.base : c?.stage);

// Скаутинг: номер соперника к событию — подающий (приём, эйс, ошибка их подачи) или бьющий (защита, блок, их очко).
function scoutTag(ev) {
  if (!ui.match?.scout) return ev;
  const st = baseStage(ctx());
  const serve = ev.skill === 'rec' || (ev.skill === 'team' && (ev.res === 'oppAce' || (ev.res === 'oppError' && st === 'rec')));
  const attack = ev.skill === 'dig' || ev.skill === 'blk' || (ev.skill === 'team' && (ev.res === 'oppKill' || ev.res === 'oppError') && !serve);
  if (serve && ui.scoutSrv) ev.opp = ui.scoutSrv;
  if (attack && ui.scoutAtt) { ev.opp = ui.scoutAtt; ui.scoutAtt = null; } // бьющий — на один удар
  return ev;
}
function postAct(ev) {
  scoutTag(ev);
  postEvent(stamp({ t: 'act', ...ev }));
}
function moveTo(id, p) { if (id && p) ui.moved[id] = { x: p.x, y: p.y }; }
// Движение игрока на 3D при повторе по видео: приём, пас, удар, блок, подача.
// Во время ввода движения запускает сценарий мяча (ballScript) — точно к моменту касания.
const ACT_OF = { rec: 'rec', dig: 'dig', set: 'set', att: 'att', blk: 'blk', serve: 'serve' };

// Кто бьёт с этой точки: за трёхметровой — только задняя линия, у сетки — только передняя (кроме пасующего).
function attackerFor(p, setter) {
  const front = frontRow(), back = ui.st.set.lineup.filter(id => !front.includes(id));
  const pool = (p.y >= NET - 3 ? front : back).filter(id => id !== setter);
  return nearest(p, { only: pool.length ? pool : null, exclude: [setter] });
}

// Ждём подтверждения игрока: точка уже стоит, вероятный игрок пульсирует, клик по фишке — завершить шаг.
function awaitPlayer(kind, point, suggest, extra = {}) {
  const prev = ui.draft?.await ? ui.draft.await.prev : ui.draft;
  ui.draft = { ...(prev || {}), await: { kind, point, suggest, base: baseStage(ctx()), prev, t: curT(), ...extra } };
  render();
}
// Шаг завершён: игрок выбран.
function confirmPlayer(a, id) {
  ui.draft = a.prev;
  if (a.kind === 'touch') {
    ui.draft = { touch: { kind: a.touchKind, p: id, at: a.point, from: a.from ?? null, t: a.t ?? curT() } };
    moveTo(id, a.point);
    syncStep(a.t ?? curT());
  } else if (a.kind === 'setter') {
    const t = a.touch;
    ui.draft = null;
    postAct({ skill: t.kind, res: a.res, p: t.p, to: t.at, ...(t.from && { from: t.from }), ...(t.t != null && { vt: t.t }) });
    ui.draft = { set: { p: id, from: a.point, q: 'good', t: a.t ?? curT() } };
    syncStep(a.t ?? curT());
    moveTo(id, a.point);
    toast(`${name(t.p)} — ${LABELS[t.kind][a.res]}`);
  } else if (a.kind === 'attacker') {
    const c = a.set;
    ui.draft = null;
    postAct({ skill: 'set', res: c.q, p: c.p, from: c.from, to: a.point, tempo: tempoOfH(curH()), h: curH(), ...(c.t != null && { vt: c.t }) });
    ui.setH = null;
    ui.draft = { att: { p: id, from: a.point, t: a.t ?? curT() } };
    syncStep(a.t ?? curT());
    moveTo(id, a.point);
  }
  ui.hoverPid = null;
  render();
}

function onCourtPick(p, e, hit) {
  if (!ui.match) return;
  closeMenu();
  if (ui.editPoints && ui.edit !== null) {
    const key = e.shiftKey || e.button === 2 ? 'from' : 'to';
    return updateEvent(ui.edit, { [key]: p });
  }
  const c = ctx();
  if (!c) return;
  pauseForInput();
  const right = e.button === 2;
  // Мяч у соперника: клик по сетке ставит (переставляет) наш блок — раньше, чем клик по игроку у сетки.
  if (c.stage === 'their' && !(ui.draft?.block && hit?.hands) && (hit?.net || inNetBand(p))) {
    const x = Math.max(0, Math.min(9, hit?.net?.x ?? p.x));
    ui.draft = { ...ui.draft, block: { x, side: blockSide(x) } }; ui.blockHover = null;
    return render();
  }
  const id = hit?.hands ? null : hit?.player;

  if (c.stage === 'await') {
    if (id) return confirmPlayer(c, id);
    // Клик по полу — переставить точку этого же шага.
    const prevCtx = { ...c };
    ui.draft = c.prev;
    return stepPoint(ctx(), p, right, hit, prevCtx);
  }
  if (id) {
    // Клик сразу по игроку: точка и игрок одним кликом.
    if (['rec', 'their', 'free'].includes(c.stage)) return confirmPlayer({ kind: 'touch', t: curT(), point: posOf(id), touchKind: c.stage === 'rec' ? 'rec' : 'dig', from: c.origin ?? null, prev: ui.draft }, id);
    if (c.stage === 'touch2') { const at = posOf(id); return confirmPlayer({ kind: 'setter', t: curT(), point: at, touch: c.touch, res: gradeFor(c.touch, at), prev: null }, id); }
    if (c.stage === 'set') { if (id === c.p) return; const at = { x: posOf(id).x, y: Math.max(6.6, posOf(id).y + 1.6) }; return confirmPlayer({ kind: 'attacker', t: curT(), point: at, set: c, prev: null }, id); }
    if (c.stage === 'att') { ui.draft = { att: { p: id, from: c.from } }; moveTo(id, c.from); return render(); }
    return;
  }
  stepPoint(c, p, right, hit);
}
const gradeFor = (t, at) => { const g = gradeAt(ui.zones, at); return t.kind === 'rec' ? g : digRes(g); };

function stepPoint(c, p, right, hit) {
  switch (c.stage) {
    case 'serve': {
      if (p.y < NET) return toast('Подача: кликните на их половине. Ошибка — клик за их линиями или ПКМ');
      const ev = { skill: 'serve', p: c.p, to: p };
      if (!inCourtThem(p)) return postAct({ ...ev, res: 'error' });
      if (right) return openMenu(p, 0, [
        ['Сложная подача', 'g', () => postAct({ ...ev, res: 'good' })],
        ['Эйс', 'g', () => postAct({ ...ev, res: 'ace' })],
        ['В игру', 'n', () => postAct({ ...ev, res: 'in' })],
        ['Ошибка подачи', 'r', () => postAct({ ...ev, res: 'error' })],
      ]);
      return postAct({ ...ev, res: 'in' });
    }
    case 'rec':
    case 'free':
    case 'their': {
      if (hit?.hands === 'us') return ourBlockMenu(p);
      // Клик по сетке — поставить наш блок (по центру — один, у краёв — двое); команда перестроится.
      if (c.stage === 'their' && inNetBand(p)) { ui.draft = { ...ui.draft, block: { x: p.x, side: blockSide(p.x) } }; ui.blockHover = null; render(); return; }
      if (p.y >= NET) { if (c.stage === 'their') { ui.draft = { ...ui.draft, origin: p }; render(); } return; }
      if (!inCourtUs(p)) return postAct({ skill: 'team', res: 'oppError', p: null, to: p });
      const lost = { skill: 'team', res: c.stage === 'rec' ? 'oppAce' : 'oppKill', p: null, to: p, ...(c.origin && { from: c.origin }) };
      if (right) return postAct(lost);
      // Один клик — касание (дальше выбираем игрока), двойной — соперник забил в эту точку (на приёме — эйс).
      return singleOrDouble(p, () => awaitPlayer('touch', p, nearest(p), { touchKind: c.stage === 'rec' ? 'rec' : 'dig', from: c.origin ?? null }), () => { ui.draft = null; postAct(lost); });
    }
    case 'touch2': {
      const t = c.touch;
      if (p.y >= NET) { ui.draft = null; return postAct({ skill: t.kind, res: 'over', p: t.p, to: t.at, ...(t.from && { from: t.from }) }); }
      const gs = guessedSetter();
      const suggest = gs && gs !== t.p ? gs : nearest(p, { exclude: [t.p] });
      return awaitPlayer('setter', p, suggest, { touch: t, res: gradeFor(t, p) });
    }
    case 'set': {
      // Второе касание на их половину — не обязательно атака: перевод (мяч просто ушёл к ним) или скидка.
      if (p.y >= NET) return secondOverMenu(p, c);
      return awaitPlayer('attacker', p, attackerFor(p, c.p), { set: c });
    }
    case 'att': {
      if (hit?.hands === 'them') return blockMenu(p, c);
      if (p.y < NET) return openMenu(p, 0, [
        ['Атака в сетку', 'r', () => postAct({ skill: 'att', res: 'error', p: c.p, from: c.from, to: p })],
        ['Четыре касания', 'r', () => postAct({ skill: 'fault', res: 'four', p: c.p })],
      ]);
      return attackLanding(p, right, c);
    }
  }
}

// Атака на их половину: один клик в площадке — мяч в игре, двойной — забили в эту точку, клик за линиями — аут.
// Одиночный клик ждёт ~0,3 с, не будет ли второго; ПКМ — меню со всеми вариантами.
let landing = null;
const DBL_MS = 300;
function attackLanding(p, right, c) {
  const ev = { skill: 'att', p: c.p, from: c.from, to: p, ...(c.t != null && { vt: c.t }) };
  if (right) {
    return openMenu(p, 0, [
      ['Забил (очко)', 'g', () => postAct({ ...ev, res: 'kill' })],
      ['В игре — подняли', 'n', () => postAct({ ...ev, res: 'play' })],
      ['Аут / сетка', 'r', () => postAct({ ...ev, res: 'error' })],
    ], 'Атака');
  }
  if (!inCourtThem(p)) { clearLanding(); ui.draft = null; return postAct({ ...ev, res: 'error' }); }
  // Второй клик рядом с первым и быстро — это двойной: очко.
  if (landing && Math.hypot(landing.p.x - p.x, landing.p.y - p.y) < 1.2) {
    const first = landing; clearLanding();
    ui.draft = null;
    return postAct({ ...first.ev, res: 'kill' });
  }
  clearLanding();
  landing = { p, ev, timer: setTimeout(() => { const l = landing; landing = null; ui.draft = null; postAct({ ...l.ev, res: 'play' }); }, DBL_MS) };
  court.setPending({ to: p });
}
// Второе касание на сторону соперника: связующий (или кто играл вторым) перевёл мяч или сделал скидку.
function secondOverMenu(p, c) {
  const set = { skill: 'set', p: c.p, from: c.from, to: p, ...(c.t != null && { vt: c.t }) };
  const att = { skill: 'att', p: c.p, from: c.from, to: p, ...(c.t != null && { vt: c.t }) };
  const go = ev => { ui.draft = null; ui.setH = null; postAct(ev); };
  if (!inCourtThem(p)) return openMenu(p, 0, [
    ['Перевод в аут — ошибка паса', 'r', () => go({ ...set, res: 'error' })],
    ['Скидка в аут — ошибка атаки', 'r', () => go({ ...att, res: 'error' })],
  ], 'Второе касание за их линии');
  openMenu(p, 0, [
    ['Перевод — мяч ушёл к ним', 'n', () => go({ ...set, res: 'over' })],
    ['Скидка — в игре', 'y', () => go({ ...att, res: 'play' })],
    ['Скидка — очко', 'g', () => go({ ...att, res: 'kill' })],
  ], `Второе касание: ${esc(name(c.p))}`);
}
function clearLanding() { if (landing) { clearTimeout(landing.timer); landing = null; } }
// Общий разбор одиночного / двойного клика по полу: одиночный ждёт ~0,3 с, не будет ли второго рядом.
let pendingClick = null;
function singleOrDouble(p, single, double) {
  if (pendingClick && Math.hypot(pendingClick.p.x - p.x, pendingClick.p.y - p.y) < 1.2) {
    clearTimeout(pendingClick.timer); pendingClick = null;
    return double();
  }
  if (pendingClick) clearTimeout(pendingClick.timer);
  pendingClick = { p, timer: setTimeout(() => { pendingClick = null; single(); }, DBL_MS) };
  court.setPending({ to: p });
}
function blockMenu(p, c) {
  const at = { x: p.x, y: NET + 0.1 };
  openMenu(at, 2.9, [
    ['Блок-аут — очко нам', 'g', () => postAct({ skill: 'att', res: 'bo', p: c.p, from: c.from, to: at })],
    ['В пол от блока — очко им', 'r', () => postAct({ skill: 'att', res: 'blocked', p: c.p, from: c.from, to: { x: p.x, y: NET - 1.2 } })],
    ['Отскок к нам — играем дальше', 'n', () => postAct({ skill: 'att', res: 'play', p: c.p, from: c.from, to: at, cover: true })],
  ], 'Блок соперника');
}
function ourBlockMenu(p) {
  const bl = ourBlockers();
  const blocker = bl.length ? bl.reduce((a, b) => (Math.abs(b.x - p.x) < Math.abs(a.x - p.x) ? b : a)).id : nearest({ x: p.x, y: NET - 0.5 }, { only: frontRow() });
  const at = { x: p.x, y: NET - 0.1 };
  const from = ui.draft?.origin;
  openMenu(at, 2.9, [
    ['Блок: очко', 'g', () => postAct({ skill: 'blk', res: 'point', p: blocker, to: at, ...(from && { from }) })],
    ['Касание — мяч у нас', 'y', () => { const block = ui.draft?.block; postAct({ skill: 'blk', res: 'touch', p: blocker, to: at, ...(from && { from }) }); ui.draft = { origin: from, block }; render(); }],
    ['Блок-аут — очко им', 'r', () => postAct({ skill: 'blk', res: 'out', p: blocker, to: at, ...(from && { from }) })],
  ], `Наш блок: ${esc(name(blocker))}`);
}

// «Мяч упал»: не принял / не поднял (игрок из текущего касания) или эйс / удар соперника без касания.
function ballDown() {
  const c = ctx(), a = c?.stage === 'await' ? c : null;
  const t = ui.draft?.touch ?? (a?.kind === 'setter' ? a.touch : null);
  if (a?.kind === 'touch') { ui.draft = null; return postAct({ skill: a.touchKind, res: 'error', p: ui.hoverPid ?? a.suggest, to: a.point, ...(a.from && { from: a.from }) }); }
  if (t) { ui.draft = null; return postAct({ skill: t.kind, res: 'error', p: t.p, to: t.at, ...(t.from && { from: t.from }) }); }
  const st = baseStage(c);
  if (st === 'rec') sendAct('team', 'oppAce');
  else if (st === 'their' || st === 'free') sendAct('team', 'oppKill');
}

// Удаление событий (одного или целого розыгрыша): сразу на экране, на сервер — очередью, с возможностью вернуть.
function deleteEvents(idxs) {
  const id = ui.match.id;
  const sorted = [...new Set(idxs)].sort((a, b) => b - a);
  const removed = sorted.map(i => ({ i, ev: ui.match.events[i] })).filter(x => x.ev);
  for (const { i } of removed) {
    ui.match.events.splice(i, 1);
    if (ui.insertAt !== null && ui.insertAt > i) ui.insertAt--;
    queue(() => api('DELETE', `/api/matches/${id}/events/${i}`));
  }
  ui.edit = null; ui.draft = null; ui.focusRally = null;
  recompute(); render();
  toast(removed.length > 1 ? `Розыгрыш удалён (${removed.length} касаний)` : 'Событие удалено', false, {
    label: 'Вернуть',
    fn: () => {
      // Возвращаем в обратном порядке удаления — каждое на своё место.
      for (const { i, ev } of [...removed].reverse()) {
        ui.match.events.splice(i, 0, ev);
        queue(() => api('POST', `/api/matches/${id}/events?at=${i}`, ev));
      }
      recompute(); render();
    },
  });
}

// ---------- Всплывающее меню возле точки ----------
function openMenu(p, h, items, title = '') {
  const pos = court.project(p, h);
  ui.menu = { items };
  const el = $('courtMenu');
  el.innerHTML = (title ? `<div class="cm-title">${title}</div>` : '') + items.map(([label, cls], k) =>
    `<button class="cm-item ${cls}" data-a="menuPick" data-k="${k}"><span class="kbd">${k + 1}</span>${label}</button>`).join('');
  const pane = el.parentElement.getBoundingClientRect();
  el.style.left = Math.min(pos.x + 12, pane.width - 250) + 'px';
  el.style.top = Math.min(Math.max(8, pos.y - 20), pane.height - 40 * items.length - 30) + 'px';
  el.classList.add('on');
}
function closeMenu() { ui.menu = null; $('courtMenu').classList.remove('on'); }
function menuPick(k) {
  const it = ui.menu?.items[k];
  closeMenu();
  if (!it) return;
  ui.draft = null;
  it[2]();
}

// ---------- Отрисовка площадки ----------
const RES_COLOR = { us: 0x59d499, them: 0xff6363, null: 0xf2f2f2 };
const outcomeOf = pl => ACTIONS[pl.skill]?.[pl.res] ?? null;
const colorOf = pl => (pl.skill === 'set' ? (pl.won === true ? 0x59d499 : pl.won === false ? 0xff6363 : 0xf0c85a) : RES_COLOR[outcomeOf(pl)]);
function spotOf(pl) { return pl.zone ? ZONE_SPOT[pl.zone] : null; }

// Траектории розыгрыша по касаниям: подача → приём → доводка к связующему → пас → атака.
function trailsFor(plays) {
  const out = [];
  let lastSetTo = null, lastTouch = null;
  for (const pl of plays) {
    const c = colorOf(pl);
    if (pl.skill === 'serve' && pl.to) out.push({ from: pl.from ?? DEFAULT_SPOT.serveUs, to: pl.to, y0: 2.7, y1: 0.4, apex: 4.4, color: 0x63a1ff });
    if (pl.skill === 'rec' && pl.to) out.push({ from: pl.from ?? DEFAULT_SPOT.serveThem, to: pl.to, y0: 2.7, y1: 0.7, apex: 4.2, color: 0xf0c85a, opacity: 0.55 });
    if (pl.skill === 'dig' && pl.to) out.push({ from: pl.from ?? { x: 9 - pl.to.x, y: 10.5 }, to: pl.to, y0: 3.0, y1: 0.6, apex: 3.2, color: 0xff9f8a, opacity: 0.5 });
    if ((pl.skill === 'rec' || pl.skill === 'dig') && pl.to) lastTouch = pl.to;
    if (pl.skill === 'set') {
      const to = pl.to ?? (pl.target ? spotOfTarget(pl) : null);
      // Доводка: от точки приёма к точке паса — пунктиром.
      if (lastTouch && pl.from) out.push({ from: lastTouch, to: pl.from, y0: 0.8, y1: 2.5, apex: 4.6, color: 0xf0c85a, opacity: 0.6, width: 0.025 });
      if (to) {
        out.push({ from: pl.from ?? DEFAULT_SPOT.setter, to, y0: 2.5, y1: 3.0, apex: pl.h ?? TEMPOS[pl.tempo]?.h ?? 4.2, color: c, opacity: pl.virtual ? 0.35 : 0.9, width: 0.03 });
        lastSetTo = to;
      }
      lastTouch = null;
    }
    if (pl.skill === 'att' && pl.to) {
      const from = pl.from ?? lastSetTo ?? spotOf(pl) ?? { x: 4.5, y: 7.5 };
      out.push({ from, to: pl.to, y0: 3.1, y1: pl.res === 'bo' || pl.res === 'play' && pl.to.y < NET + 0.5 ? 2.8 : 0.12, apex: 3.25, color: c, width: 0.045 });
    }
  }
  return out;
}
function spotOfTarget(set) {
  const k = ui.st?.set?.lineup.indexOf(set.target);
  const z = set.dir === 'pipe' ? 6 : typeof set.dir === 'number' ? set.dir : null;
  const s = z ? ZONE_SPOT[z] : k >= 0 ? ZONE_SPOT[ui.st.rally.zones[k]] : null;
  return s && { x: s.x, y: Math.max(s.y, 6.6) };
}
// Траектории только текущего розыгрыша (или розыгрыша выбранного события) — старые дуги не мешают.
function focusPlays() {
  const plays = ui.full?.plays ?? [];
  if (ui.edit !== null) {
    const pl = plays.find(p => p.i === ui.edit);
    if (pl) return plays.filter(p => p.set === pl.set && p.rally === pl.rally);
  }
  if (ui.focusRally) return rallyByKey(ui.focusRally)?.plays ?? [];
  // Во время ввода — только текущая фаза: когда мяч перешёл к сопернику, прошлые линии убираем.
  const rp = rallyPlays();
  const CROSS = new Set(['serve.in', 'serve.good', 'att.play', 'rec.over', 'dig.over', 'set.over', 'blk.touch', 'team.over']);
  let k = -1;
  rp.forEach((p, i) => { if (CROSS.has(`${p.skill}.${p.res}`)) k = i; });
  return k >= 0 && baseStage(ctx()) === 'their' ? [] : rp.slice(k + 1);
}

// Мяч на 3D по шагам ввода. Полёт добавляется, когда шаг завершён (выбран игрок), — до этого мяч ждёт
// у того, кто его последним коснулся: на предплечьях принимающего, в ладонях связующего, у руки нападающего.
//   приём: мяч с подачи летит в «площадку» принимающему → доводка: от него к связующему →
//   пас: связующий отдаёт, нападающий разбегается в три шага и бьёт в прыжке → атака: мяч летит в точку удара.
const HOLD_SKILLS = new Set(['rec', 'dig', 'set', 'att']);
function ballScript() {
  if (!live() || ui.edit !== null || ui.focusRally || ui.editPoints) return null;
  const c = ctx(), d = ui.draft || {};
  const segs = [];
  let holder = null, holderAt = null; // кто сейчас держит мяч и где
  const key = p => (p ? `${(+p.x).toFixed(2)},${(+p.y).toFixed(2)}` : '');
  const add = s => {
    s.id = [s.kind, key(s.to), s.by ?? '', s.catcher ?? '', s.catchAs ?? ''].join('|');
    segs.push(s);
    holder = HOLD_SKILLS.has(s.catchAs) ? s.catcher : null;
    holderAt = holder ? s.to : null;
  };
  const touch = (kind, p, to, from, res) => {
    const rec = kind === 'rec';
    add({ kind: rec ? 'serve' : 'spike', from: from ?? (rec ? DEFAULT_SPOT.serveThem : { x: 9 - to.x, y: 10.5 }), to, y0: rec ? 2.7 : 3.0, y1: 0.8, apex: rec ? 4.2 : 3.2, catcher: p, catchAs: kind });
    if (res === 'over') add({ kind: 'free', from: to, to: { x: to.x, y: 13 }, y0: 0.8, y1: 0.12, apex: 4.6, by: p });
    if (res === 'error') add({ kind: 'free', from: to, to: { x: to.x < 4.5 ? -1.2 : 10.2, y: Math.max(0.5, to.y - 2.5) }, y0: 0.8, y1: 0.12, apex: 2.8, by: p });
  };
  const pass = (to, p) => {
    if (!holder || holder === p || !to) return;
    add({ kind: 'pass', from: holderAt, to, y0: 0.8, y1: 2.45, apex: Math.max(3.4, 2.5 + Math.hypot(to.x - holderAt.x, to.y - holderAt.y) * 0.35), by: holder, catcher: p, catchAs: 'set' });
  };
  const plays = rallyPlays().filter(p => !p.virtual);
  let lastSetTo = null;
  plays.forEach((pl, i) => {
    const next = plays[i + 1];
    if (pl.skill === 'serve' && pl.to) add({ kind: 'serve', from: pl.from ?? DEFAULT_SPOT.serveUs, to: pl.to, y0: 2.7, y1: 0.12, apex: 4.4, by: pl.p, byAct: 'serve' });
    if ((pl.skill === 'rec' || pl.skill === 'dig') && pl.to) touch(pl.skill, pl.p, pl.to, pl.from, pl.res);
    if (pl.skill === 'set') {
      const from = pl.from ?? SETTER_SPOT;
      pass(from, pl.p);
      const to = pl.to ?? spotOfTarget(pl);
      if (to) {
        // Кто бьёт: из записанной атаки, иначе — выбранный нападающий текущего шага.
        const att = next ? (next.skill === 'att' ? next.p : null) : d.att?.p ?? (c?.stage === 'att' ? c.p : null);
        if (pl.res === 'over' || pl.res === 'error') add({ kind: 'free', from, to, y0: 2.5, y1: 0.12, apex: 3.6, by: pl.p });
        else add({ kind: 'set', from, to, y0: 2.5, y1: 3.0, apex: pl.h ?? TEMPOS[pl.tempo]?.h ?? 4.2, by: pl.p, catcher: att, catchAs: att ? 'att' : null });
        lastSetTo = to;
      }
    }
    if (pl.skill === 'att' && pl.to) {
      const low = pl.res === 'bo' || (pl.res === 'play' && pl.to.y < NET + 0.5);
      add({ kind: 'att', from: pl.from ?? lastSetTo ?? { x: 4.5, y: 7.5 }, to: pl.to, y0: 3.1, y1: low ? 2.8 : 0.12, apex: 3.25, by: pl.p });
    }
    if (pl.skill === 'blk' && pl.to) add({ kind: 'spike', from: pl.from ?? { x: pl.to.x, y: NET + 1 }, to: pl.to, y0: 3.1, y1: 2.75, apex: 3.2, catcher: pl.p, catchAs: 'blk', deflect: pl.res });
    if (pl.skill === 'team' && pl.to && (pl.res === 'oppKill' || pl.res === 'oppAce')) {
      const ace = pl.res === 'oppAce';
      add({ kind: ace ? 'serve' : 'spike', from: pl.from ?? (ace ? DEFAULT_SPOT.serveThem : { x: 9 - pl.to.x, y: 10.5 }), to: pl.to, y0: ace ? 2.7 : 3.0, y1: 0.12, apex: ace ? 4.2 : 3.2 });
    }
  });
  // Шаги, которые ещё не записаны в матч: выбран принимающий; выбран связующий.
  if (d.touch?.at) touch(d.touch.kind, d.touch.p, d.touch.at, d.touch.from);
  if (baseStage(c) === 'set') { const s = c.stage === 'await' ? c.set : c; pass(s.from, s.p); }
  const r = ui.st.rally;
  return { rally: rallyKey(), start: r.phase === 'serve' && r.weServe ? { hold: r.server } : null, segs };
}

// Линии за мышью: подача, доводка к связующему, дуга паса, удар; руки блока.
function paintPreview() {
  const c = ctx(), m = ui.mouse;
  const pv = [];
  let hands = [];
  const st = baseStage(c);
  const a = c?.stage === 'await' ? c : null;
  if (st === 'att') {
    hands = [{ x: Math.max(0.5, Math.min(8.5, c.from.x - 0.45)), side: 'them' }, { x: Math.max(0.5, Math.min(8.5, c.from.x + 0.45)), side: 'them' }];
    if (m) pv.push({ from: c.from, to: m, y0: 3.1, y1: 0.12, apex: 3.25, color: m.y >= NET && inCourtThem(m) ? 0x59d499 : 0xff6363, ball: true });
  }
  if (st === 'set') {
    const from = a ? a.set.from : c.from, to = a ? a.point : m;
    if (to) pv.push({ from, to, y0: 2.5, y1: 3.0, apex: curH(), color: 0xffffff, ball: true, ballAtEnd: !!a });
  }
  if (st === 'touch2') {
    const t = a ? a.touch : c.touch, to = a ? a.point : m;
    if (to) pv.push({ from: t.at, to, y0: 0.8, y1: 2.5, apex: Math.max(3.4, 2.5 + Math.hypot(to.x - t.at.x, to.y - t.at.y) * 0.35), color: 0xf0c85a, dashed: true, ball: true, ballAtEnd: !!a });
  }
  if ((st === 'rec' || st === 'their' || st === 'free') && (a?.point || (m && m.y < NET))) {
    const to = a?.point ?? m, origin = st === 'rec' ? DEFAULT_SPOT.serveThem : (a?.from ?? c.origin);
    if (origin && (st !== 'their' || a)) pv.push({ from: origin, to, y0: st === 'rec' ? 2.7 : 3.1, y1: 0.7, apex: st === 'rec' ? 4.2 : 3.3, color: 0xff9f8a, dashed: st === 'rec', ball: true, ballAtEnd: !!a });
  }
  if (st === 'serve' && m && m.y >= NET) pv.push({ from: DEFAULT_SPOT.serveUs, to: m, y0: 2.7, y1: 0.3, apex: 4.4, color: inCourtThem(m) ? 0x63a1ff : 0xff6363, dashed: true, ball: true });
  if (st === 'their') hands = ourBlockers().map(b => ({ x: b.x, side: 'us' }));
  // Удар соперника: от места удара (или от блока, если удар не отмечен) к мыши на нашей половине.
  if (st === 'their' && !a && m && m.y < NET - 0.45 && (c.origin || c.block)) pv.push({ from: c.origin ?? { x: c.block.x, y: 10.2 }, to: m, y0: 3.1, y1: 0.4, apex: 3.3, color: 0xff9f8a, ball: true });
  court.setPreview(pv);
  court.setHands(hands);
  court.setWheelCapture(st === 'set');
}

// Кто вероятнее всего сыграет мяч в точке под курсором (пульсирует, пока ведёте мышь).
function liveCandidate(m) {
  const c = ctx();
  if (!m || !c) return null;
  if (c.stage === 'set' && m.y < NET) return attackerFor(m, c.p);
  if (c.stage === 'touch2' && m.y < NET) { const gs = guessedSetter(); return gs && gs !== c.touch.p ? gs : nearest(m, { exclude: [c.touch.p] }); }
  if ((c.stage === 'rec' || c.stage === 'their' || c.stage === 'free') && m.y < NET && inCourtUs(m)) return nearest(m);
  return null;
}

// Фишки: расстановка по ситуации + кто где у мяча. Пульсирует вероятный игрок (или тот, на кого наведена мышь),
// сплошное кольцо — уже выбранный исполнитель текущего шага.
function paintPlayers() {
  if (!live()) { court.setPlayers([]); return; }
  const st = ui.st, c = ctx();
  lastForm = formation(c);
  const gs = guessedSetter();
  const a = c?.stage === 'await' ? c : null;
  // Пульсация: при ожидании игрока — наведённый или предложенный; на шаге паса/атаки — вероятный нападающий под мышью.
  let pulse = null;
  if (a) pulse = ui.hoverPid ?? a.suggest;
  else if (c && ['rec', 'their', 'free', 'touch2', 'set', 'att'].includes(c.stage)) pulse = ui.hoverPid ?? ui.cand ?? null;
  const actorId = c?.stage === 'touch2' ? c.touch.p : c?.stage === 'set' || c?.stage === 'att' ? c.p : a?.kind === 'setter' ? a.touch.p : a?.kind === 'attacker' ? a.set.p : null;
  // Куда смотрят игроки. Связующий на пасе стоит боком — лицом к 4-й зоне (как в жизни).
  // В защите, когда отмечен наш блок (или точка, откуда бьют), — все разворачиваются к месту удара.
  const setterNow = c?.stage === 'set' ? c.p : a?.kind === 'attacker' ? a.set?.p : null;
  const hitFrom = c?.stage === 'their' ? c.origin ?? (c.block ?? ui.blockHover ? { x: (c.block ?? ui.blockHover).x, y: NET + 0.9 } : null) : null;
  court.setPlayers(st.set.lineup.map(id => {
    const p = person(id);
    return { id, ...(id === setterNow ? { yaw: Math.PI / 2 } : hitFrom ? { face: hitFrom } : {}), label: p.num || (p.name || '?').slice(0, 2), num: p.num, name: p.name, libero: roleOf(p) === 'l', spot: posOf(id), setter: id === gs, selected: ui.sel === id || id === actorId, server: st.rally.phase === 'serve' && st.rally.server === id, hl: id === pulse, pinned: !!ui.moved[id] };
  }));
}

function paintCourt() {
  const c = ctx();
  // Новый розыгрыш или мяч ушёл к сопернику — игроки возвращаются в расстановку.
  // Сколько раз мяч перешёл на их сторону в этом розыгрыше: при каждом переходе игроки заново встают в расстановку.
  const CROSS = new Set(['serve.in', 'serve.good', 'att.play', 'rec.over', 'dig.over', 'set.over', 'blk.touch', 'team.over']);
  const key = `${rallyKey()}:${rallyPlays().filter(p => CROSS.has(`${p.skill}.${p.res}`)).length}`;
  if (key !== ui.movedKey) { ui.moved = {}; ui.movedKey = key; if (ui.draft && !ui.draft.touch && !ui.draft.set && !ui.draft.att && !ui.draft.origin && !ui.draft.await) ui.draft = null; }
  if (ui.rallyKeySeen !== rallyKey()) { ui.rallyKeySeen = rallyKey(); if (!ui.draft?.set && !ui.draft?.touch) ui.draft = null; }
  paintPlayers();
  const edit = ui.editPoints && ui.edit !== null ? ui.match.events[ui.edit] : null;
  const a = c?.stage === 'await' ? c : null;
  court.setPending(edit ? { from: edit.from, to: edit.to } : a ? { to: a.point } : c?.stage === 'their' && c.origin ? { from: c.origin } : {});
  // Мяч во время ввода — по шагам (сценарий), при просмотре розыгрыша из истории — пролётом по дугам.
  const script = ballScript();
  court.setScript(script);
  court.setTrails(trailsFor(focusPlays()), { animate: !script });
  const sk = DISPLAY_SKILL[group()];
  court.setDots(ui.history && sk && ui.full ? ui.full.plays.filter(p => p.skill === sk && p.to && !p.virtual).map(p => ({ ...p.to, color: colorOf(p), opacity: 0.45 })) : []);
  paintPreview();
  paintBar();
}

// Панель кнопок прямо под площадкой: шаг назад, отмена шага, «мяч упал», очки, пас (темп и качество).
function paintBar() {
  const el = $('courtBar');
  const c = ctx();
  if (!c) { el.innerHTML = ''; return; }
  const st = baseStage(c);
  const btn = (a, label, cls = '', extra = '', kbd = '') => `<button class="cb ${cls}" data-a="${a}" ${extra}>${label}${kbd ? `<span class="kbd">${kbd}</span>` : ''}</button>`;
  const parts = [btn('undo', `${icon('i-undo')}Назад`, 'strong', '', '⌫')];
  if (ui.draft) parts.push(btn('cancelStep', 'Отмена', '', 'title="Отменить незаконченный шаг"', 'Esc'));
  if (c.stage === 'await') parts.push(btn('confirmSuggest', `Это #${esc(person(ui.hoverPid ?? c.suggest).num ?? '')}`, 'primary', `title="${esc(name(ui.hoverPid ?? c.suggest))}"`, '⏎'));
  if (st === 'set') {
    const q = c.stage === 'await' ? c.set.q : c.q, t = tempoOfH(curH());
    parts.push('<span class="sep"></span>', ...Object.entries({ q: '1т', f: '2т', h: '3т' }).map(([k, v]) => btn('tempo', v, t === k ? 'on' : '', `data-v="${k}" title="${TEMPO_NAME[k]} · колесо мыши"`)),
      `<span class="hv">${curH().toFixed(1)}м</span>`, '<span class="sep"></span>',
      ...[['perfect', 'Идеал', 'Q'], ['good', 'Хорош', 'W'], ['poor', 'Неудоб', 'E']].map(([k, v, kb]) => btn('setQ', v, q === k ? 'on' : '', `data-v="${k}" title="Качество паса"`, kb)));
  }
  // Скаутинг: номер подающего / бьющего соперника — чипами (подающий запоминается, бьющий — на один удар).
  if (ui.match.scout && (st === 'rec' || st === 'their' || (st === 'touch2' && !c.touch?.from && c.touch?.kind === 'dig'))) {
    const nums = oppOf(ui.match)?.numbers ?? [];
    const cur = st === 'rec' ? ui.scoutSrv : ui.scoutAtt;
    parts.push('<span class="sep"></span>', `<span class="sl">${st === 'rec' ? 'Подаёт' : 'Бьёт'} №</span>`,
      ...nums.map(n => btn('scoutNum', esc(n), cur === n ? 'on' : '', `data-v="${esc(n)}" data-w="${st === 'rec' ? 'srv' : 'att'}"`)),
      btn('scoutAdd', '+', '', `data-w="${st === 'rec' ? 'srv' : 'att'}" title="Добавить номер игрока соперника"`), '<span class="sep"></span>');
  }
  if (['touch2', 'rec', 'their', 'free'].includes(st)) parts.push(btn('ballDown', st === 'rec' && !ui.draft?.touch ? 'Эйс соперника' : 'Мяч упал', 'r', '', 'X'));
  if (st === 'att') parts.push(btn('netErr', 'Сетка', 'r', '', 'N'));
  if (st === 'their') parts.push(btn('act', 'Ошибка соперника', 'g', 'data-skill="team" data-res="oppError"', '+'), ...(c.block ? [btn('blockOff', 'Без блока')] : []));
  parts.push('<span class="grow"></span>', btn('timeout', '⏸ Т-аут', 'opt', 'data-side="us" title="Тайм-аут наш (метка на видео и в анализе)"'), btn('timeout', '⏸ их', 'opt', 'data-side="them" title="Тайм-аут соперника"'), btn('pt', '+1', 'g opt', 'data-side="us" title="Очко нам без статистики"'), btn('pt', '+1', 'r opt', 'data-side="them" title="Очко им без статистики"'), btn('flip', icon('i-swap'), 'opt', 'title="Мяч на другой стороне (если программа ошиблась)"'));
  el.innerHTML = parts.join('');
}

// ---------- Отрисовка ----------
// Эмблема команды: картинка или кружок с инициалами (цвет — от названия, всегда один и тот же).
function emblem(src, title, cls = '') {
  if (src) return `<img class="emb ${cls}" src="${src}" alt="">`;
  const ini = String(title || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  let h = 0; for (const ch of String(title)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `<span class="emb ini ${cls}" style="background:hsl(${h} 45% 32%)">${esc(ini)}</span>`;
}
const oppOf = m => ui.settings.opponents.find(o => o.id === m?.opponentId);
const ourEmblem = (cls = '') => emblem(ui.settings.emblem, ui.settings.teamName, cls);
const oppEmblem = (m, cls = '') => emblem(oppOf(m)?.emblem, m?.opponent, cls);

function paintTop() {
  const m = ui.match, st = ui.st;
  document.querySelector('.top-actions .btn-chip').href = m ? `stats.html#m=${m.id}` : 'stats.html';
  $('matchPick').innerHTML = m ? `<b>${esc(ui.settings.teamName)} — ${esc(m.opponent)}</b> · ${new Date(m.created).toLocaleDateString('ru')}` : 'Выберите матч';
  if (!m || !st.set) { $('score').innerHTML = ''; $('phase').innerHTML = ''; $('phase').className = 'phase-pill'; return; }
  const s = st.set;
  $('score').innerHTML = `
    <div class="team"><span class="${s.serving === 'us' ? 'serving' : ''}"></span>${ourEmblem()}${esc(ui.settings.teamName)}<span class="pts">${s.us}</span></div>
    <div class="mid"><b>${st.setsWon.us} : ${st.setsWon.them}</b>партия ${s.n + 1}</div>
    <div class="team them"><span class="${s.serving === 'them' ? 'serving' : ''}"></span>${oppEmblem(m)}${esc(m.opponent)}<span class="pts">${s.them}</span></div>`;
  if (s.over) { $('phase').className = 'phase-pill'; $('phase').innerHTML = '<i></i>Партия окончена'; return; }
  const ph = { serve: ['Наша подача', `подаёт ${esc(name(st.rally.server))}`], rec: ['Приём', 'подают они'], ours: ['Мяч у нас', 'пас и атака'], their: ['Мяч у них', 'защита или блок'] }[st.rally.phase];
  $('phase').className = `phase-pill ph-${st.rally.phase}`;
  $('phase').innerHTML = `<i></i>${ph[0]} <small>${ph[1]} · Р${st.rally.rot}</small><button data-a="flip" title="Мяч на другой стороне (если программа ошиблась)">${icon('i-swap')}</button>`;
}

function tile(id, zone, extra = '') {
  const p = person(id);
  const st = ui.st;
  const tags = [];
  if (id === guessedSetter()) tags.push('<span class="tag s">С</span>');
  if (st.rally.server === id && st.rally.phase === 'serve') tags.push('<span class="tag srv">●</span>');
  const cls = [ui.sel === id && 'on', ui.sub?.out === id && 'out'].filter(Boolean).join(' ');
  return `<button class="ptile ${cls}" data-a="${ui.sub ? 'subOut' : 'sel'}" data-id="${id}" ${extra}>
    <span class="z">${zone}</span>${tags.join('')}
    <span class="n${p.num ? '' : ' name'}">${esc(p.num || p.name)}</span>${p.num ? `<span class="nm">${esc(p.name)}${ROLES[roleOf(p)] ? ' · ' + ROLES[roleOf(p)].short : ''}</span>` : ''}</button>`;
}

function paintDock() {
  const dock = $('dock');
  if (!ui.match) {
    dock.innerHTML = `<div style="grid-column:1/-1"><div class="empty">Откройте матч или создайте новый во вкладке «Матч» справа.
      <button class="btn sm" data-a="newMatch" style="margin-left:10px">${icon('i-plus')}Новый матч</button></div></div>`;
    return;
  }
  const st = ui.st;
  if (!st.set || st.set.over) {
    const n = st.sets.length;
    const over = st.matchOver;
    dock.innerHTML = `<div style="grid-column:1/-1"><div class="empty">${over ? `Матч окончен · ${st.setsWon.us}:${st.setsWon.them}. Можно разбирать по видео и править события.` : n ? `Партия ${n} окончена ${st.set.us}:${st.set.them}.` : 'Матч создан.'}
      ${over ? '' : `<button class="btn sm primary" data-a="lineup" style="margin-left:10px">Начать: ${setTitle(n, st.format)}</button>`}
      ${n ? `<button class="btn sm ghost" data-a="undo" style="margin-left:6px">${icon('i-undo')}Отменить последнее</button>` : ''}</div></div>`;
    return;
  }
  // Левая колонка: расстановка.
  const zones = st.rally.zones, lineup = st.set.lineup;
  const byZone = z => lineup[zones.indexOf(z)];
  const bench = ui.match.roster.filter(p => !lineup.includes(p.id)).sort((a, b) => a.num - b.num);
  const left = `<div>
    <h4>Расстановка <span class="kbd">1–6</span><span class="grow"></span>
      <button class="btn sm ghost" data-a="sub">${icon('i-swap')}${ui.sub ? 'Отмена' : 'Замена'}</button></h4>
    <div class="rot">${[4, 3, 2, 5, 6, 1].map(z => tile(byZone(z), z)).join('')}</div>
    ${ui.sub?.out ? `<div class="bench">${bench.map(p => `<button class="ptile" data-a="subIn" data-id="${p.id}"><span class="n${p.num ? '' : ' name'}">${esc(p.num || p.name)}</span><span class="nm">${esc(p.name)}</span></button>`).join('') || '<span class="muted">Запасных нет</span>'}</div>` : ''}
    <div class="rot-meta"><b>Р${st.rally.rot}</b><span>${esc(SYSTEMS[ui.match.system] || '')}</span><span class="grow"></span>${ui.sub ? '<span>кто уходит?</span>' : ''}</div>
  </div>`;

  // Центр: палитра действий.
  const g = group(), main = mainGroup();
  const tabs = Object.entries(GROUPS).map(([k, v]) => `<button class="${k === g ? 'on' : ''} ${k === main ? 'main' : ''}" data-a="group" data-g="${k}">${icon(v.icon)}${v.label}<span class="kbd">${v.key}</span></button>`).join('');
  const who = actor(GROUPS[g].acts[0][0]);
  const serveDisabled = g === 'serve' && !st.rally.weServe;
  const cq = baseStage(ctx()) === 'set' ? (ctx().stage === 'await' ? ctx().set.q : ctx().q) : null;
  const acts = GROUPS[g].acts.map(([sk, res, label, cls], k) =>
    `<button class="act ${cls} ${sk === 'set' && cq === res ? 'sel' : ''}" data-a="act" data-skill="${sk}" data-res="${res}" ${serveDisabled ? 'disabled' : ''}>${label}${ACT_KEYS[k] ? `<span class="kbd">${ACT_KEYS[k]}</span>` : ''}</button>`).join('');
  const center = `<div>
    <div class="skills">${tabs}</div>
    <div class="acts">${acts}</div>
    <div class="act-hint">
      <span>Игрок: <b>${who ? esc(name(who)) : '— не выбран'}</b>${g === 'set' && !ui.sel && who ? ' (по схеме)' : ''}</span>
      ${ui.insertAt !== null ? `<span style="color:var(--sky)">Вставка перед событием №${ui.insertAt + 1}</span>` : ''}
      <span><b>X</b> мяч упал · <b>ПКМ</b> — второй вариант · <b>⌫</b> шаг назад</span>
    </div>
  </div>`;

  // Справа: точки, пас, команда.
  const setCtl = g === 'set' || ctx()?.stage === 'set' ? `
    <div class="lbl">Темп паса</div>
    <div class="tempo">${Object.entries(TEMPOS).map(([k, t]) => `<button class="${tempoOfH(curH()) === k ? 'on' : ''}" data-a="tempo" data-v="${k}" title="${t.label}">${{ q: '1 темп', f: '2 темп', h: '3 темп' }[k]}</button>`).join('')}</div>
    <div class="lbl">Высота дуги (колесо мыши) <b>${curH().toFixed(1)} м</b></div>
    <input type="range" min="2.6" max="9" step="0.1" value="${curH()}" data-k="setH">
    <div class="tip-inline">Качество: Q идеальный · W хороший · E неудобный</div>` : '';
  const teamActs = st.rally.phase === 'rec'
    ? `<button class="act r" data-a="act" data-skill="team" data-res="oppAce">Эйс соперника</button><button class="act g" data-a="act" data-skill="team" data-res="oppError">Ошибка соперника <span class="kbd">+</span></button>`
    : `<button class="act g" data-a="act" data-skill="team" data-res="oppError">Ошибка соперника <span class="kbd">+</span></button><button class="act r" data-a="act" data-skill="team" data-res="oppKill">Соперник забил <span class="kbd">−</span></button>`;
  const right = `<div class="ctx">
    ${setCtl ? `<h4>Пас</h4>${setCtl}` : `<h4>Ввод на площадке</h4><div class="tip-inline">Розыгрыш вводится кликами по 3D-площадке: приём → куда пришёл мяч к пасующему → откуда бьют → куда ударили. Кнопки слева — запасной вариант.</div>`}
    <h4 style="margin-top:14px">Соперник и розыгрыш</h4>
    <div class="team-acts">${teamActs}</div>
    <div class="tools-row">
      <button class="btn sm" data-a="undo">${icon('i-undo')}Назад <span class="kbd">⌫</span></button>
      <button class="btn sm ghost" data-a="pt" data-side="us">+1 нам</button>
      <button class="btn sm ghost" data-a="pt" data-side="them">+1 им</button>
    </div>
  </div>`;
  dock.innerHTML = left + center + right;
}

// ---------- Боковая панель ----------
function paintSide() {
  document.querySelectorAll('#sideTabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));
  $('side').innerHTML = { events: sideEvents, video: sideVideo, match: sideMatch, stat: sideStat }[ui.tab]();
}

function eventRows() {
  const m = ui.match, full = ui.full;
  const plays = new Map(full.plays.filter(p => !p.virtual).map(p => [p.i, p]));
  const logBy = new Map(full.log.map(l => [l.i, l]));
  const rows = [];
  m.events.forEach((ev, i) => {
    const l = logBy.get(i);
    if (!l) return; // проигнорированные движком (например, после конца партии)
    const pl = plays.get(i);
    if (ui.filter.skill && pl?.skill !== ui.filter.skill) return;
    if (ui.filter.p && pl?.p !== ui.filter.p) return;
    rows.push({ i, ev, l, pl });
  });
  return rows;
}

function sideEvents() {
  if (!ui.match) return '<p class="muted">Матч не открыт.</p>';
  const rows = eventRows();
  const clips = rows.filter(r => r.ev.vt != null && r.ev.v === ui.activeVideo);
  const skills = Object.entries(SKILLS).filter(([k]) => k !== 'team').map(([k, v]) => `<option value="${k}" ${ui.filter.skill === k ? 'selected' : ''}>${v}</option>`).join('');
  const people = [...ui.match.roster].sort((a, b) => a.num - b.num).map(p => `<option value="${p.id}" ${ui.filter.p === p.id ? 'selected' : ''}>${esc(playerName(ui.match, p.id))}</option>`).join('');
  let html = '';
  if (ui.insertAt !== null) html += `<div class="banner">${icon('i-insert')}<span class="grow">Вставка: новые касания встают перед событием №${ui.insertAt + 1}</span><button class="btn sm" data-a="insertOff">Готово</button></div>`;
  if (ui.playlist) html += `<div class="banner" style="color:var(--mint);background:var(--us-bg)">${icon('i-clip')}<span class="grow">Клипы: ${ui.playlist.k + 1} из ${ui.playlist.items.length}</span><button class="btn sm" data-a="stopClips">Стоп</button></div>`;
  html += `<div class="seg evseg"><button class="${ui.evView === 'rallies' ? 'on' : ''}" data-a="evView" data-v="rallies">Розыгрыши</button><button class="${ui.evView === 'events' ? 'on' : ''}" data-a="evView" data-v="events">Все события</button></div>`;
  if (ui.evView === 'rallies') {
    const fr = filteredRallies().filter(r => r.t0 != null);
    return html + `<div class="filters"><select data-k="rFilter">${Object.entries(RFILTER).map(([k, v]) => `<option value="${k}" ${(ui.rFilter ?? 'all') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="filters"><button class="btn sm" data-a="rallyClips" ${fr.length ? '' : 'disabled'} style="flex:1">${icon('i-clip')}Смотреть подряд (${fr.length})</button>
        <button class="btn sm" data-a="exportClips" ${fr.length ? '' : 'disabled'} title="Склеить эти розыгрыши в один видеофайл">⤓ Нарезка mp4</button></div>
      <p class="tip-inline">Клик — видео и 3D на этот розыгрыш · PgUp / PgDn — соседний · ☆ — в избранное</p><div class="evlist">${sideRallies()}</div>`;
  }
  html += `<div class="filters">
    <select data-k="fskill"><option value="">Все навыки</option>${skills}</select>
    <select data-k="fp"><option value="">Все игроки</option>${people}</select>
  </div>
  <div class="filters"><button class="btn sm" data-a="clips" ${clips.length ? '' : 'disabled'} style="flex:1">${icon('i-clip')}Смотреть клипы (${clips.length})</button></div>`;
  let curSet = -1;
  const items = [];
  for (const r of rows) {
    const setNo = r.ev.t === 'set' ? (r.pl?.set ?? null) : null;
    if (r.ev.t === 'set') { curSet++; items.push(`<div class="ev-div">Партия ${curSet + 1}</div>`); }
    const cls = [r.l.side || '', r.ev.t !== 'act' && r.ev.t !== 'pt' ? 'sys' : '', ui.edit === r.i ? 'sel' : '', ui.insertAt === r.i ? 'cursor' : '', ui.playlist?.items[ui.playlist.k]?.i === r.i && r.i != null ? 'playing' : ''].join(' ');
    const ic = [r.ev.to || r.ev.from ? icon('i-pin') : '', r.ev.v && r.ev.v !== ui.activeVideo ? icon('i-film') : ''].join('');
    items.push(`<div class="ev has-del ${cls}" data-a="pickEv" data-i="${r.i}">
      <span class="t ${r.ev.vt == null ? 'none' : ''}">${r.ev.vt == null ? '—' : fmtShort(r.ev.vt)}</span>
      <span class="sc">${r.i + 1}</span>
      <span class="tx">${esc(r.l.text)}</span><span class="ic">${ic}</span><button class="rowdel" data-a="evDelQuick" data-i="${r.i}" title="Удалить событие">${icon('i-x')}</button></div>`);
    if (ui.edit === r.i) items.push(editor(r));
    void setNo;
  }
  html += `<div class="evlist">${items.join('') || '<p class="muted">Событий пока нет.</p>'}</div>`;
  return html;
}

function editor({ i, ev }) {
  const isAct = ev.t === 'act';
  const resOpts = isAct ? Object.keys(ACTIONS[ev.skill]).map(r => `<option value="${r}" ${ev.res === r ? 'selected' : ''}>${esc(LABELS[ev.skill][r])}</option>`).join('') : '';
  const people = isAct && ev.skill !== 'team' ? `<option value="">—</option>` + [...ui.match.roster].sort((a, b) => a.num - b.num).map(p => `<option value="${p.id}" ${ev.p === p.id ? 'selected' : ''}>${esc(playerName(ui.match, p.id))}</option>`).join('') : '';
  return `<div class="card editor">
    ${isAct ? `<div class="row">Результат<select data-k="eres">${resOpts}</select></div>` : ''}
    ${people ? `<div class="row">Игрок<select data-k="ep">${people}</select></div>` : ''}
    ${isAct && ev.skill === 'set' ? `<div class="row">Темп<select data-k="etempo">${Object.entries(TEMPOS).map(([k, t]) => `<option value="${k}" ${ev.tempo === k ? 'selected' : ''}>${t.label}</option>`).join('')}</select></div>` : ''}
    <div class="row">Время<span class="mono">${ev.vt == null ? 'не привязано' : fmt(ev.vt)}</span></div>
    <div class="row">Точки<span>${ev.to ? `куда: зона ${zoneOf(ev.to)}` : 'куда: —'} · ${ev.from ? `откуда: зона ${zoneOf(ev.from)}` : 'откуда: —'}</span></div>
    <div class="btns">
      <button class="btn sm" data-a="evTime" ${ui.activeVideo ? '' : 'disabled'}>${icon('i-clock')}Время = сейчас</button>
      ${isAct ? `<button class="btn sm ${ui.editPoints ? 'primary' : ''}" data-a="evPoints">${icon('i-pin')}${ui.editPoints ? 'Кликайте по площадке' : 'Точки'}</button>` : ''}
      ${isAct && (ev.to || ev.from) ? `<button class="btn sm ghost" data-a="evClearPts">Убрать точки</button>` : ''}
    </div>
    <div class="btns">
      <button class="btn sm" data-a="insertHere" data-i="${i}">${icon('i-insert')}Вставить перед</button>
      <button class="btn sm danger" data-a="evDel" data-i="${i}">${icon('i-x')}Удалить</button>
    </div>
  </div>`;
}

// ---------- Живая статистика матча (правая панель) ----------
// Обновляется с каждым касанием: счёт по партиям, сайд-аут / брейк, серия, игроки, расстановки.
function sideStat() {
  if (!ui.match) return '<p class="muted">Матч не открыт.</p>';
  const st = ui.full, scope = ui.statScope ?? 'all';
  const t = st.teams[scope] ?? {}, pl = st.players[scope] ?? {};
  const pc = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '–');
  const sets = st.sets.map(s => `<button class="${scope === s.n ? 'on' : ''}" data-a="statScope" data-v="${s.n}">П${s.n + 1} ${s.us}:${s.them}</button>`).join('');
  // Текущая серия очков в партии.
  const flow = st.set?.flow ?? [];
  let run = 0; for (let i = flow.length - 1; i >= 0 && flow[i] === flow.at(-1); i--) run++;
  const so = t.sideout ?? { n: 0, won: 0 }, brk = t.brk ?? { n: 0, won: 0 };
  const sum = Object.values(pl).reduce((a, p) => addStats(a, p), newPlayer());
  const ours = totals(sum);
  const kpi = (title, v, s2) => `<div class="sk"><span>${title}</span><b>${v}</b><small>${s2}</small></div>`;
  const rows = Object.entries(pl).map(([id, p]) => ({ id, p, tt: totals(p) })).sort((a, b) => b.tt.points - a.tt.points || b.tt.diff - a.tt.diff);
  const rots = [1, 6, 5, 4, 3, 2].map(r => { const x = t.rot?.[r]; return `<div class="sr ${x && x.so.n >= 2 && x.so.won / x.so.n < 0.45 ? 'weak' : ''}"><b>Р${r}</b><span>${x ? pc(x.so.won, x.so.n) : '–'}</span><small>${x ? `${x.us}:${x.them}` : ''}</small></div>`; }).join('');
  return `<div class="seg statseg"><button class="${scope === 'all' ? 'on' : ''}" data-a="statScope" data-v="all">Матч ${st.setsWon.us}:${st.setsWon.them}</button>${sets}</div>
    <div class="sks">
      ${kpi('Сайд-аут', pc(so.won, so.n), `${so.won} из ${so.n}`)}
      ${kpi('Брейк', pc(brk.won, brk.n), `${brk.won} из ${brk.n}`)}
      ${kpi('Атака', pc(sum.att.kill + sum.att.bo, sum.att.tot), `эфф ${sum.att.tot ? Math.round(attEff(sum.att) * 100) + '%' : '–'}`)}
      ${kpi('Приём', sum.rec.tot ? recRating(sum.rec).toFixed(2) : '–', `из 3 · ош ${sum.rec.err}`)}
      ${kpi('Наши очки', ours.points, `ошибок ${ours.errors}`)}
      ${kpi('Подарки', t.oppError ?? 0, `соперник забил ${t.oppKill ?? 0}`)}
    </div>
    ${run >= 3 && st.set && !st.set.over ? `<div class="banner ${flow.at(-1) === 'us' ? 'ok' : 'bad'}" style="margin-top:8px">Серия ${run}:0 ${flow.at(-1) === 'us' ? 'наша' : 'соперника'}${flow.at(-1) === 'them' ? ' — может, тайм-аут?' : ''}</div>` : ''}
    <h3>Игроки</h3>
    <table class="stbl"><tr><th class="l">Игрок</th><th title="Очки">Оч</th><th title="Плюс / минус">±</th><th title="Атака: очки / всего">Атака</th><th title="Приём: средняя оценка 0–3">Пр</th><th title="Подача: эйсы / ошибки">Под</th><th title="Блок: очки">Бл</th></tr>
      ${rows.map(({ id, p, tt }) => `<tr><td class="l"><a href="player.html?p=${id}" target="_blank" style="color:inherit" title="Отчёт игрока">${esc(name(id))}</a></td><td><b>${tt.points}</b></td><td class="${tt.diff > 0 ? 'pos' : tt.diff < 0 ? 'neg' : ''}">${tt.diff > 0 ? '+' : ''}${tt.diff}</td>
        <td>${p.att.tot ? `${p.att.kill + p.att.bo}/${p.att.tot}` : '·'}</td><td>${p.rec.tot ? recRating(p.rec).toFixed(1) : '·'}</td><td>${p.serve.ace || p.serve.err ? `${p.serve.ace}/${p.serve.err}` : '·'}</td><td>${p.blk.point || '·'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Касаний пока нет</td></tr>'}
    </table>
    <h3>Сайд-аут по расстановкам</h3>
    <div class="srs">${rots}</div>
    <p class="muted" style="margin-top:10px">Подробно — в <a href="stats.html#m=${ui.match.id}" target="_blank" style="color:var(--sky)">аналитике</a>.</p>`;
}

function sideVideo() {
  const mv = new Set(ui.match?.videos || []);
  const item = v => `<div class="vitem ${ui.activeVideo === v.id ? 'active' : ''}">
    <span class="th">${icon(ui.activeVideo === v.id ? 'i-play' : 'i-film')}</span>
    <span style="min-width:0"><b title="${esc(v.name)}">${esc(v.name)}</b><small>${v.status === 'processing'
      ? `${v.mode === 'remux' ? 'переупаковка' : `перекодирование ${(v.codec || '').toUpperCase()} → H.264`} · ${Math.round((v.progress ?? 0) * 100)}%`
      : v.status === 'error' ? `<span style="color:var(--coral)">ошибка подготовки: ${esc(v.error || '')}</span>`
      : `${v.duration ? fmtShort(v.duration) + ' · ' : ''}${v.height ? v.height + 'p · ' : ''}${mb(v.size)} · ${new Date(v.created).toLocaleDateString('ru')}`}</small>
      ${v.status === 'processing' ? `<div class="bar2"><i style="width:${(v.progress ?? 0) * 100}%"></i></div>` : ''}</span>
    <span class="acts2">
      ${ui.match && !mv.has(v.id) ? `<button class="ibtn" data-a="linkVideo" data-id="${v.id}" title="Привязать к матчу">${icon('i-plus')}</button>` : ''}
      <button class="ibtn" data-a="openVideo" data-id="${v.id}" title="Открыть">${icon('i-play')}</button>
      ${ui.match && mv.has(v.id) ? `<button class="ibtn" data-a="unlinkVideo" data-id="${v.id}" title="Отвязать от матча">${icon('i-x')}</button>` : `<button class="ibtn" data-a="delVideo" data-id="${v.id}" title="Удалить из библиотеки">${icon('i-x')}</button>`}
    </span></div>`;
  const ups = ui.uploads.map(u => `<div class="vitem"><span class="th">${icon('i-upload')}</span><span style="min-width:0"><b>${esc(u.name)}</b>
    <small>${u.err ? `<span style="color:var(--coral)">${esc(u.err)}</span>` : `копирую… ${Math.round(u.p * 100)}%`}</small><div class="progress"><i style="width:${u.p * 100}%"></i></div></span><span></span></div>`).join('');
  const inMatch = ui.videos.filter(v => mv.has(v.id));
  const rest = ui.videos.filter(v => !mv.has(v.id));
  return `
    <div class="dropzone" data-a="pickFile">${icon('i-upload')}<b>Добавить видео</b>Перетащите файл сюда или в любое место окна. Подойдёт любой формат: что не играет браузер (H.265/HEVC с iPhone, ProRes, AVI…), FFmpeg сам переведёт в H.264. Файл копируется в data/videos.</div>
    ${ups ? `<h3>Загрузка</h3><div class="vlist">${ups}</div>` : ''}
    ${ui.match ? `<h3>В этом матче</h3><div class="vlist">${inMatch.map(item).join('') || '<p class="muted">Нет привязанных видео. Если матч снят несколькими файлами — привяжите все.</p>'}</div>` : ''}
    <h3>Библиотека</h3><div class="vlist">${rest.map(item).join('') || '<p class="muted">Пусто.</p>'}</div>
    <h3>Нарезки лучших моментов</h3><div class="vlist">${(ui.clips ?? []).map(c => `<div class="vitem"><span class="th">${icon('i-clip')}</span>
      <span style="min-width:0"><b title="${esc(c.file)}">${esc(c.file)}</b><small>${mb(c.size)} · data/clips</small></span>
      <span class="acts2"><a class="ibtn" href="${c.url}" download title="Скачать">⤓</a><a class="ibtn" href="${c.url}" target="_blank" title="Открыть">${icon('i-play')}</a></span></div>`).join('') || '<p class="muted">Пока нет. В «Событиях → Розыгрыши» отметьте ★ и нажмите «Нарезка mp4».</p>'}</div>`;
}

function sideMatch() {
  const m = ui.match, st = ui.st;
  const list = ui.matches.map(x => `<div class="mitem ${m?.id === x.id ? 'on' : ''}" data-a="open" data-id="${x.id}">${emblem(ui.settings.opponents.find(o => o.id === x.opponentId)?.emblem, x.opponent, 'sm')}
    <span class="grow"><b>${esc(x.opponent)}</b><small>${new Date(x.created).toLocaleDateString('ru')}${x.tournament ? ' · ' + esc(ui.settings.tournaments?.find(t => t.id === x.tournament)?.name ?? '') : ''} · событий ${x.events}${x.videos.length ? ' · видео ' + x.videos.length : ''}</small></span>
    <span class="sc">${x.setsWon.us}:${x.setsWon.them}</span>
    <button class="rowdel" data-a="matchDel" data-id="${x.id}" title="Удалить матч">${icon('i-x')}</button></div>`).join('');
  const sys = m ? Object.entries(SYSTEMS).map(([k, v]) => `<option value="${k}" ${m.system === k ? 'selected' : ''}>${v}</option>`).join('') : '';
  return `
    ${m ? `<h3>Текущий матч</h3>
    <div class="card">
      <div class="kv">
        <span>Соперник</span><b>${esc(m.opponent)}</b>
        <span>Партии</span><b class="mono">${st.sets.map(s => `${s.us}:${s.them}`).join(', ') || '—'}</b>
        <span>Событий</span><b class="mono">${m.events.length}</b>
      </div>
      <div class="field" style="display:grid;gap:6px;margin-top:12px;font-size:12.5px;color:var(--smoke)">Турнир
        <div style="display:flex;gap:6px"><select data-k="matchTour" style="flex:1"><option value="">— без турнира —</option>${(ui.settings.tournaments ?? []).map(t => `<option value="${t.id}" ${m.tournament === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
        <button class="btn sm" data-a="tourNew" title="Новый турнир">＋</button></div>
        <span>${ui.settings.activeTournament ? `Новые матчи попадают в «${esc(ui.settings.tournaments?.find(t => t.id === ui.settings.activeTournament)?.name ?? '')}»` : 'Новые матчи — без турнира'} · <a href="#" data-a="tourActive" style="color:var(--sky)">${ui.settings.activeTournament === m.tournament && m.tournament ? 'не добавлять новые сюда' : 'новые матчи — в этот турнир'}</a></span>
      </div>
      <div class="field" style="display:grid;gap:6px;margin-top:12px;font-size:12.5px;color:var(--smoke)">Формат матча
        <select data-k="matchFormat">${formatOptions(formatKey(m.format ?? formatOf(m)))}</select>
        <span>${esc(formatName(formatOf(m)))}</span>
      </div>
      <div class="field" style="display:grid;gap:6px;margin-top:12px;font-size:12.5px;color:var(--smoke)">Пресет команды (расстановки)
        <select data-k="matchPreset">${presets().map(p => `<option value="${p.id}" ${curPreset().id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      </div>
      <div class="field" style="display:grid;gap:6px;margin-top:12px;font-size:12.5px;color:var(--smoke)">Схема игры
        <select data-k="system">${sys}</select>
        <span>Схема только подсказывает, кто пасует. В любом касании можно выбрать другого игрока — нестандартные перемещения не мешают.</span>
      </div>
      <details class="mroles" style="margin-top:12px"><summary>Роли в этом матче${Object.keys(m.roles ?? {}).length ? ` · изменено: ${Object.keys(m.roles).length}` : ''}</summary>
        <p class="tip-inline">Если в этом матче игрок вынужденно играет другую роль (ЦБ — доигровщиком). На команду не влияет.</p>
        ${[...m.roster].sort((a, b) => (a.num || 99) - (b.num || 99)).map(p => { const team = ui.roster.find(r => r.id === p.id); const teamRole = roleOf(team ?? {}); return `<div class="mrole"><span>${esc(playerName(m, p.id))}</span>
          <select data-k="matchRole" data-id="${p.id}"><option value="">как в команде${ROLES[teamRole] ? ` (${ROLES[teamRole].short})` : ''}</option>${Object.entries(ROLES).map(([k, x]) => `<option value="${k}" ${m.roles?.[p.id] === k ? 'selected' : ''}>${x.name}</option>`).join('')}</select></div>`; }).join('')}
      </details>
      <label class="toggle" style="margin-top:12px" title="В этом матче отмечать номер подающего и бьющего соперника — накопится отчёт по команде соперника"><input type="checkbox" data-k="matchScout" ${m.scout ? 'checked' : ''}><span>Скаутинг соперника (номера подающих и бьющих)</span></label>
      <label class="toggle" style="margin-top:12px"><input type="checkbox" data-k="trackSets" ${ui.trackSets ? 'checked' : ''}><span>Отмечать каждый пас (статистика связующего)</span></label>
      <div class="btns" style="display:flex;gap:6px;margin-top:12px;flex-wrap:wrap">
        ${!st.matchOver && (!st.set || st.set.over) ? `<button class="btn sm primary" data-a="lineup">Начать: ${setTitle(st.sets.length, st.format)}</button>` : ''}
        <a class="btn sm" href="stats.html#m=${m.id}" target="_blank">${icon('i-chart')}Дашборд матча</a>
      </div>
    </div>` : ''}
    <h3>Матчи <span class="grow"></span><button class="btn sm" data-a="newMatch">${icon('i-plus')}Новый</button></h3>
    <div class="mlist">${list || '<p class="muted">Матчей пока нет.</p>'}</div>
    <h3>Команда</h3>
    <div class="card teamcard">${ourEmblem('lg')}<span class="grow"><b>${esc(ui.settings.teamName)}</b><small>состав, форма, расстановки, зоны доводки, данные — в настройках</small></span>
      <button class="btn sm" data-a="settings" data-tab="team">Настройки</button></div>`;
}

// ---------- Таймлайн ----------
function paintTimeline() {
  const track = $('tlTrack');
  const d = video.duration;
  if (!ui.match || !ui.activeVideo || !d) { track.innerHTML = ''; return; }
  const out = [];
  const bySet = {};
  for (const l of ui.full.log) {
    const ev = ui.match.events[l.i];
    if (ev.v !== ui.activeVideo || ev.vt == null) continue;
    if (ev.t === 'set') { bySet[l.i] = ev.vt; continue; }
    out.push(`<i class="mk ${l.side || ''} ${l.timeout ? 'to' : ''} ${ui.edit === l.i ? 'sel' : ''}" style="left:${(100 * ev.vt) / d}%" title="${fmt(ev.vt)} · ${esc(l.text)}" data-i="${l.i}"></i>`);
  }
  const bands = Object.values(bySet).sort((a, b) => a - b).map((t, k, arr) =>
    `<div class="set-band" style="left:${(100 * t) / d}%;width:${(100 * ((arr[k + 1] ?? d) - t)) / d}%"><span>П${k + 1}</span></div>`).join('');
  track.innerHTML = bands + out.join('');
}
function paintHead() {
  const d = video.duration || 0, t = video.currentTime || 0;
  const tl = $('timeline');
  const w = tl.clientWidth - 28;
  $('tlHead').style.transform = `translateX(${d ? (t / d) * w : 0}px)`;
  $('tc').textContent = `${fmt(t)} / ${fmtShort(d)}`;
  // Иконку меняем только при смене состояния: если перерисовывать кнопку каждый кадр, клик по ней «теряется».
  if (paintHead.paused !== video.paused) { paintHead.paused = video.paused; $('playBtn').innerHTML = icon(video.paused ? 'i-play' : 'i-pause'); }
}

function paintHud() {
  const last = ui.full?.log.at(-1);
  const has = !!video.src;
  $('videoEmpty').style.display = has ? 'none' : '';
  $('videoHud').innerHTML = has && ui.st?.set ? `<span>Р${ui.st.rally.rot}</span>${last ? `<span>${esc(last.text)}</span>` : ''}` : '';
  const hint = [];
  const c = ctx();
  if (ui.editPoints && ui.edit !== null) hint.push('<span><b>Правка точек</b> события №' + (ui.edit + 1) + ' — клик: куда, Shift+клик: откуда</span>');
  else if (c) {
    const n = touchNo(c);
    if (n) hint.push(`<span class="touches">${[1, 2, 3].map(k => `<i class="${k < n ? 'done' : k === n ? 'on' : ''}">${k}</i>`).join('')}</span>`);
    // Подсказка шага свёрнута в кружок «i»: клик — открыть/скрыть (запоминается), при наведении — текст во всплывашке.
    const text = STEP_HINT[c.stage](c), open = store.get('hintOpen', false);
    hint.push(`<button class="hint-i ${open ? 'on' : ''}" data-a="hintToggle" title="${open ? 'Скрыть подсказку' : esc(text.replace(/<[^>]+>/g, ''))}">${open ? '×' : 'i'}</button>`);
    if (open) hint.push(`<span>${text}</span>`);
  }
  $('courtHint').innerHTML = hint.join('');
}

// Подсказка шага: что кликнуть и какие есть варианты. ЛКМ/ПКМ — левая/правая кнопка мыши.
const who = id => (id ? `<b>${esc(name(id))}</b>` : '—');
const AWAIT_HINT = { touch: 'Кто принял мяч?', setter: 'Кто пасует?', attacker: 'Кто бьёт?' };
const STEP_HINT = {
  await: c => `${AWAIT_HINT[c.kind]} Кликните <b>подсвеченного</b> ${who(ui.hoverPid ?? c.suggest)} или другого игрока · <span class="kbd">⏎</span> — подсвеченный${c.kind === 'setter' ? ` · приём: <b>${LABELS[c.touch.kind][c.res].split(' ').pop()}</b>` : ''}`,
  serve: c => `Подача ${who(c.p)}: клик на их половине — <b>в игру</b> · ПКМ — эйс / сложная · за линией или в сетку — ошибка`,
  rec: () => `<b>Приём</b>: клик, куда пришла подача (или сразу по игроку) · <b>двойной клик — эйс</b> соперника в эту точку`,
  their: c => c.block
    ? `<b>Блок ${{ left: 'слева', center: 'по центру', right: 'справа' }[c.block.side]}</b> · клик на их половине — откуда бьют · по нашей площадке — куда пришёл мяч, <b>двойной — забили нам</b> · по <b>рукам</b> — результат блока`
    : `<b>Мяч у них</b>: ведите мышь по <b>сетке</b> — блок (клик ставит) · на их половине — откуда бьют · по нашей площадке — куда пришёл мяч, <b>двойной клик — забили нам</b>`,
  free: () => `<b>Мяч у нас</b>: клик, где первое касание`,
  touch2: c => `${who(c.touch.p)} — ${c.touch.kind === 'rec' ? 'приём' : 'защита'}. Клик — <b>куда пришёл мяч к пасующему</b> (оценка по зонам доводки) или сразу по пасующему · на их сторону — перекид`,
  set: c => `Пас ${who(c.p)}: клик — <b>откуда бьют</b> (или сразу по нападающему) · колесо — высота · на их сторону — скидка`,
  att: c => `Атака ${who(c.p)}: клик на их площадке — <b>в игре</b>, <b>двойной — очко</b> · за линией — аут · по рукам — блок · ПКМ — меню`,
};

function render() {
  paintTop();
  paintDock();
  paintSide();
  paintTimeline();
  paintHud();
  if (ui.match) paintCourt(); else { court.setPlayers([]); court.setTrails([]); court.setDots([]); court.setPending({}); }
}

// ---------- Модальные окна ----------
// Перерисовка открытого окна меняет только содержимое — без повторной анимации появления.
function modal(html) {
  const box = $('modal').querySelector('.modal');
  if (html && box) { box.className = 'modal'; box.innerHTML = html; }
  else $('modal').innerHTML = html ? `<div class="modal-bg" data-a="modalBg"><div class="modal">${html}</div></div>` : '';
}
const modalOpen = () => !!$('modal').innerHTML;

function openLineup() {
  const last = ui.st.sets.at(-1);
  // Нет прошлой партии — берём стартовый состав пресета команды.
  const pl = curPreset().lineup;
  const from = last ? { start: last.start, main: last.main } : pl;
  ui.lineupDraft = { order: from ? from.start.filter(id => ui.match.roster.some(p => p.id === id)) : [], weServe: true, setter: from?.main ?? null };
  paintLineup();
}
// Порядок подачи из состава пресета так, чтобы партия началась в расстановке rot (связующий в зоне rot).
// Подаём мы — первым подаёт тот, кто в зоне 1; подаёт соперник — он же будет последним в порядке (подавал «до нас»).
function lineupFromPreset(rot, weServe) {
  const pl = curPreset().lineup;
  if (pl?.start?.length !== 6) return null;
  const ms = Math.max(0, pl.start.indexOf(pl.main));
  const k = [0, 1, 2, 3, 4, 5].find(z1 => zoneOfSlot(ms, z1) === rot); // слот, который стоит в зоне 1
  const first = weServe ? k : (k + 1) % 6;
  return { order: [0, 1, 2, 3, 4, 5].map(i => pl.start[(first + i) % 6]), setter: pl.main };
}
function paintLineup() {
  const d = ui.lineupDraft, n = ui.st.sets.length + 1;
  const pl = curPreset().lineup;
  const fromPreset = pl?.start?.length === 6 ? `<div class="field">Старт из пресета «${esc(curPreset().name)}» — нажмите расстановку, порядок подачи посчитается сам
      <div class="seg">${[1, 6, 5, 4, 3, 2].map(r => `<button class="${d.fromRot === r ? 'on' : ''}" data-a="lrot" data-v="${r}">Р${r}</button>`).join('')}</div></div>`
    : `<p class="tip-inline">Совет: задайте состав пресета в редакторе расстановок — тогда партию можно начинать одной кнопкой Р1–Р6.</p>`;
  const roster = [...ui.match.roster].sort((a, b) => a.num - b.num);
  const chosen = d.order.map(id => person(id));
  const setterOpts = chosen.map(p => `<option value="${p.id}" ${(d.setter ?? chosen.find(c => c.setter)?.id) === p.id ? 'selected' : ''}>${esc(playerName(ui.match, p.id))}${p.setter ? ' · связ.' : ''}</option>`).join('');
  const auto = setTarget(n - 1, ui.st.format);
  modal(`<h2>${setTitle(n - 1, ui.st.format, d.target ?? auto)} — ${esc(ui.match.opponent)}</h2>
    <div class="field">Партия до
      <div class="seg">${[[null, `${auto} (по формату)`], ...[25, 21, 15].filter(x => x !== auto).map(x => [x, String(x)])].map(([v, t]) => `<button class="${(d.target ?? null) === v ? 'on' : ''}" data-a="ltarget" data-v="${v ?? ''}">${t}</button>`).join('')}</div></div>
    ${fromPreset}
    <p>${pl?.start?.length === 6 ? 'Или вручную: н' : 'Н'}ажимайте игроков <b>в порядке подачи</b>: 1 — подаёт первым. Повторное нажатие убирает.</p>
    <div class="grid">${roster.map(p => {
      const k = d.order.indexOf(p.id);
      return `<button class="ptile ${k >= 0 ? 'on' : ''}" data-a="lpick" data-id="${p.id}">${k >= 0 ? `<span class="ord">${k + 1}</span>` : ''}
        ${p.setter ? '<span class="tag s">С</span>' : ''}<span class="n">${esc(p.num || p.name)}</span><span class="nm">${esc(p.name)}</span></button>`;
    }).join('')}</div>
    <div class="field">Кто подаёт первым
      <div class="seg"><button class="${d.weServe ? 'on' : ''}" data-a="lserve" data-v="1">Мы</button><button class="${!d.weServe ? 'on' : ''}" data-a="lserve" data-v="0">Соперник</button></div></div>
    <div class="field">Основной связующий (по нему считаются расстановки Р1–Р6)
      <select data-k="lsetter">${setterOpts || '<option>— сначала выберите шестерых —</option>'}</select></div>
    <div class="foot"><button class="btn ghost" data-a="modalClose">Отмена</button>
      <button class="btn primary" data-a="lstart" ${d.order.length === 6 ? '' : 'disabled'}>Начать (${d.order.length}/6)</button></div>`);
}

async function openNewMatch() {
  modal(`<h2>Новый матч</h2>
    <div class="field">Формат матча<select id="fmt">${formatOptions(formatKey(ui.settings.lastFormat))}</select></div>
    <p style="margin-top:14px">С кем играем?</p>
    <div class="mlist">${ui.settings.opponents.map(o => `<div class="mitem" data-a="createMatch" data-id="${o.id}">${emblem(o.emblem, o.name, 'sm')}<span class="grow"><b>${esc(o.name)}</b></span></div>`).join('') || '<p class="muted">Соперников пока нет.</p>'}</div>
    <div class="field">Новый соперник<div style="display:flex;gap:8px"><input id="newOpp" placeholder="Название команды" style="flex:1"><button class="btn primary" data-a="createNewOpp">Создать</button></div></div>
    <div class="foot"><button class="btn ghost" data-a="modalClose">Отмена</button></div>`);
  setTimeout(() => $('newOpp')?.focus(), 30);
}

function openHelp() {
  const k = (keys, text) => `<span class="k">${keys.map(x => `<span class="kbd">${x}</span>`).join('')}</span><span>${text}</span>`;
  modal(`<h2>Горячие клавиши</h2><p>Раскладка не важна. В полях ввода клавиши не срабатывают.</p>
    <div class="keys">
      ${k(['Пробел'], 'пуск / пауза видео')}
      ${k(['←', '→'], 'назад / вперёд 5 с (с Shift — 15 с)')}
      ${k(['Колесо'], 'над видео — зум, перетаскивание — сдвиг, двойной клик — сброс')}
      ${k(['L'], 'синхронизация с видео: пробел — стоп-кадр на касании, петля страхует')}
      ${k(['Tab'], 'быстро к следующей подаче (×3), пробел — стоп')}
      ${k(['PgUp', 'PgDn'], 'предыдущий / следующий розыгрыш (видео и 3D)')}
      ${k([',', '.'], 'кадр назад / вперёд')}
      ${k(['[', ']'], 'скорость видео: медленнее / быстрее')}
      ${k(['1', '…', '6'], 'выбрать игрока по номеру зоны')}
      ${k(['A', 'S', 'D', 'F', 'G', 'H'], 'группа: подача, приём, пас, атака, защита/блок, ошибка')}
      ${k(['Q', 'W', 'E', 'R', 'T', 'Y'], 'действие в группе (подсказка на кнопке)')}
      ${k(['+', '−'], 'ошибка соперника / соперник забил')}
      ${k(['Z'], 'темп паса по кругу: 1т → 2т → 3т (или колесо мыши над площадкой)')}
      ${k(['X'], 'мяч упал: не принял / не поднял')}
      ${k(['N'], 'атака в сетку')}
      ${k(['ПКМ'], 'на площадке — второй вариант: «подняли» вместо «очко», меню подачи, «не подняли»')}
      ${k(['⌫'], 'назад на одно действие (возвращает на тот же шаг ввода)')}
      ${k(['Esc'], 'отменить незаконченный шаг (или закрыть меню)')}
      ${k(['Enter'], 'подтвердить подсвеченного игрока')}
      ${k(['V'], 'раскладка: видео / обе / площадка')}
      ${k(['?'], 'эта справка')}
    </div>
    <div class="foot"><button class="btn ghost" data-a="tourStart">Пройти обучение</button><span class="grow"></span><button class="btn primary" data-a="modalClose">Понятно</button></div>`);
}


// ---------- Конструктор зон доводки ----------
// Вид сверху на нашу половину (сетка — сверху). Кисть красит клетки 0,5 м, Shift+протянуть — прямоугольник.
function openZonesEditor() {
  ui.zEdit = { z: [...(ui.zones || defaultZones())], brush: 3 };
  const W = COLS * CELL, Hh = ROWS * CELL;
  const cells = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    cells.push(`<rect class="zc" data-i="${r * COLS + c}" x="${c * CELL}" y="${Hh - (r + 1) * CELL}" width="${CELL}" height="${CELL}"/>`);
  }
  modal(`<h2>Зоны доводки</h2>
    <p>Куда мяч приходит к пасующему после приёма или защиты — такая и оценка. Сетка сверху, клетка — 0,5 м.
      Кисть — водите мышью с нажатой кнопкой, <b>Shift</b> + протянуть — залить прямоугольник. Зоны могут быть любой формы.</p>
    <div class="zbar">${Object.entries(GRADES).reverse().map(([g, v]) => `<button class="zbrush ${g === '3' ? 'on' : ''}" data-a="zBrush" data-g="${g}"><i style="background:${v.color}"></i>${v.name}</button>`).join('')}</div>
    <div class="zwrap"><svg id="zsvg" viewBox="-0.6 -0.9 ${W + 1.2} ${Hh + 1.5}">
      <rect x="0" y="0" width="${W}" height="${Hh}" fill="#1d3a57"/>
      <g id="zcells">${cells.join('')}</g>
      <rect id="zsel" x="0" y="0" width="0" height="0" fill="none" stroke="#fff" stroke-width=".06" stroke-dasharray=".15 .1" visibility="hidden"/>
      <line x1="-0.4" y1="0" x2="${W + 0.4}" y2="0" stroke="#fff" stroke-width=".14"/>
      <line x1="0" y1="3" x2="${W}" y2="3" stroke="#e9eaec" stroke-width=".05"/>
      <rect x="0" y="0" width="${W}" height="${Hh}" fill="none" stroke="#e9eaec" stroke-width=".06"/>
      <text x="${W / 2}" y="-0.35" text-anchor="middle" font-size=".42" fill="#a0a3aa">сетка</text>
      <text x="${W + 0.1}" y="3.15" font-size=".3" fill="#6c7078">3 м</text>
      <text x="${W / 2}" y="${Hh + 0.5}" text-anchor="middle" font-size=".36" fill="#6c7078">наша лицевая линия</text>
    </svg></div>
    <div class="foot"><button class="btn ghost" data-a="zReset">Сбросить к стандартным</button><span class="grow"></span>
      <button class="btn ghost" data-a="modalClose">Отмена</button><button class="btn primary" data-a="zSave">Сохранить</button></div>`);
  paintZones();
  const svg = $('zsvg');
  let drag = null;
  const cellAt = e => {
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const q = pt.matrixTransform(svg.getScreenCTM().inverse());
    const c = Math.floor(q.x / CELL), r = Math.floor((Hh - q.y) / CELL);
    return c >= 0 && c < COLS && r >= 0 && r < ROWS ? { c, r } : null;
  };
  const paint = cell => { if (cell) { ui.zEdit.z[cell.r * COLS + cell.c] = String(ui.zEdit.brush); paintZones(); } };
  svg.addEventListener('pointerdown', e => {
    const cell = cellAt(e);
    if (!cell) return;
    svg.setPointerCapture(e.pointerId);
    drag = { rect: e.shiftKey, a: cell };
    if (!drag.rect) paint(cell);
  });
  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    const cell = cellAt(e);
    if (!cell) return;
    if (!drag.rect) return paint(cell);
    drag.b = cell;
    const sel = $('zsel');
    const c0 = Math.min(drag.a.c, cell.c), c1 = Math.max(drag.a.c, cell.c), r0 = Math.min(drag.a.r, cell.r), r1 = Math.max(drag.a.r, cell.r);
    Object.entries({ x: c0 * CELL, y: Hh - (r1 + 1) * CELL, width: (c1 - c0 + 1) * CELL, height: (r1 - r0 + 1) * CELL, visibility: 'visible' }).forEach(([k, v]) => sel.setAttribute(k, v));
  });
  svg.addEventListener('pointerup', () => {
    if (drag?.rect && drag.b) {
      for (let r = Math.min(drag.a.r, drag.b.r); r <= Math.max(drag.a.r, drag.b.r); r++)
        for (let c = Math.min(drag.a.c, drag.b.c); c <= Math.max(drag.a.c, drag.b.c); c++) ui.zEdit.z[r * COLS + c] = String(ui.zEdit.brush);
      paintZones();
    }
    $('zsel').setAttribute('visibility', 'hidden');
    drag = null;
  });
}
function paintZones() {
  document.querySelectorAll('#zcells .zc').forEach(el => { el.setAttribute('fill', GRADES[ui.zEdit.z[+el.dataset.i]].color); });
}


// ---------- Редактор расстановок ----------
// Как команда стоит в каждой из шести расстановок: на приёме, на своей подаче и в защите.
// Позиции задаются для зоны (в Рn связующий в зоне n), поэтому подходят к любому составу.
// Расстановки связаны: Р1 → Р6 → Р5 → Р4 → Р3 → Р2 — порядок переходов (игроки идут по часовой стрелке).
const GAME_ORDER = [1, 6, 5, 4, 3, 2];
const prevRot = r => GAME_ORDER[(GAME_ORDER.indexOf(r) + 5) % 6];
const nextRot = r => GAME_ORDER[(GAME_ORDER.indexOf(r) + 1) % 6];
// Игроки по слотам (порядок подачи): номера — из стартового состава последней партии, если она есть.
function refSlots() {
  const pl = ui.fEdit ? editPreset()?.lineup : curPreset().lineup;
  // Связующий в зоне текущей расстановки определяет, как «повёрнут» состав, — ms по пресету.
  if (pl?.start?.length === 6) return { start: pl.start, ms: Math.max(0, pl.start.indexOf(pl.main)) };
  const set = ui.st?.sets.at(-1);
  return set && set.mainSlot >= 0 ? { start: set.start, ms: set.mainSlot } : { start: null, ms: 0 };
}
// В какой зоне слот s в расстановке r (в Рr связующий — в зоне r).
function slotZone(s, r, ms) {
  const z1 = [0, 1, 2, 3, 4, 5].find(k => zoneOfSlot(ms, k) === r);
  return zoneOfSlot(s, z1);
}
// Рабочие копии всех пресетов: правки разных пресетов не теряются при переключении, сохраняются разом.
function presetWork(pr) {
  const data = {};
  for (const k of Object.keys(SITUATIONS)) { data[k] = {}; for (let r = 1; r <= 6; r++) data[k][r] = tableFor(pr.formations, k, r); }
  return { id: pr.id, name: pr.name, system: pr.system || '5-1', rules: pr.rules ?? 'strict', lineup: pr.lineup ?? null, data, touched: JSON.parse(JSON.stringify(pr.formations?.touched ?? {})), inherited: {} };
}
function openFormEditor() {
  const works = presets().map(presetWork);
  const cur = curPreset().id;
  ui.fEdit = { kind: 'rec', rot: ui.st?.rally?.rot ?? 1, works, presetId: cur };
  bindPreset();
  paintFormEditor();
}
const editPreset = () => ui.fEdit?.works.find(w => w.id === ui.fEdit.presetId);
// Состав пресета по зонам текущей расстановки: выбираете игрока в каждую зону — остальные переходы считаются по кругу.
function teamRoster() { return [...(ui.match?.roster ?? ui.roster)].sort((a, b) => a.num - b.num); }
function ensurePresetLineup() {
  const w = editPreset();
  if (w.lineup?.start?.length === 6) return w.lineup;
  const { start } = refSlots();
  const roster = teamRoster();
  const ids = start ?? roster.slice(0, 6).map(p => p.id);
  while (ids.length < 6) ids.push(null);
  w.lineup = { start: ids, main: ids.find(id => roleOf(person(id) ?? roster.find(p => p.id === id)) === 's') ?? ids[0] };
  return w.lineup;
}
function rosterPanel(f) {
  const lu = ensurePresetLineup();
  const ms = Math.max(0, lu.start.indexOf(lu.main));
  const roster = teamRoster();
  const cell = z => {
    const sl = [0, 1, 2, 3, 4, 5].find(s => slotZone(s, f.rot, ms) === z);
    const cur = lu.start[sl];
    return `<label class="rz"><span>зона ${z}${sl === ms ? ' · связующий' : ''}</span>
      <select data-k="fSlot" data-slot="${sl}">${roster.map(p => `<option value="${p.id}" ${p.id === cur ? 'selected' : ''}>#${esc(p.num)} ${esc(p.name)}${ROLES[roleOf(p)] ? ' · ' + ROLES[roleOf(p)].short : ''}</option>`).join('')}</select></label>`;
  };
  return `<div class="rpanel"><p class="muted" style="margin:0 0 8px"><span class="tip-inline">Кто где стоит в Р${f.rot}. Задайте один раз — в остальных переходах игроки встанут по кругу.</span>
      Связующий (по нему считаются Р1–Р6): <select data-k="fMain">${lu.start.filter(Boolean).map(id => { const p = roster.find(x => x.id === id); return `<option value="${id}" ${id === lu.main ? 'selected' : ''}>#${esc(p?.num)} ${esc(p?.name)}</option>`; }).join('')}</select></p>
    <div class="rgrid">${[4, 3, 2, 5, 6, 1].map(cell).join('')}</div></div>`;
}
// Поля редактора смотрят в рабочую копию выбранного пресета.
function bindPreset() { const w = editPreset(); Object.assign(ui.fEdit, { data: w.data, touched: w.touched, inherited: w.inherited }); }
const isTouched = (f, k, r) => !!f.touched[k]?.[r];
// Переход в расстановку: если её ещё не настраивали — все сдвигаются на переход из предыдущей и встают на её места.
// Передняя линия расстановки r по ролям игроков состава пресета.
function applyFrontRoles(k, r) {
  const f = ui.fEdit, { start, ms } = refSlots();
  if (!start) return false;
  const front = [0, 1, 2, 3, 4, 5].map(sl => ({ zone: slotZone(sl, r, ms), role: roleIn(start[sl]) })).filter(p => p.zone >= 2 && p.zone <= 4);
  if (!front.some(p => p.role)) return false;
  Object.assign(f.data[k][r], JSON.parse(JSON.stringify(frontByRole(k, front))));
  return true;
}
function goRot(r) {
  const f = ui.fEdit, from = f.rot, k = f.kind;
  const pr = prevRot(r);
  if (!isTouched(f, k, r) && (isTouched(f, k, pr) || f.inherited[k]?.[pr])) {
    f.data[k][r] = JSON.parse(JSON.stringify(f.data[k][pr]));
    // Сдвиг на переход + передняя линия сразу по ролям (ДО — 4, ЦБ — центр, СВ/ДИ — 2): меньше ручной правки.
    applyFrontRoles(k, r);
    (f.inherited[k] ??= {})[r] = true;
  }
  f.rot = r;
  paintFormEditor(from);
}
function paintFormEditor(fromRot = null) {
  const f = ui.fEdit, { start, ms } = refSlots();
  // В защите можно посмотреть, как команда перестроится под блок слева / по центру / справа (это считается само).
  const view = f.kind === 'def' ? f.defView ?? 'base' : 'base';
  const base = f.data[f.kind][f.rot];
  const tab = view === 'base' ? base : defenseLayout(base, { x: { left: 1.5, center: 4.5, right: 7.5 }[view] }).spots;
  // Протокол: в момент подачи (приём и наша подача) проверяем правила расстановки.
  // Правила расстановки проверяем только на приёме и только в строгом режиме пресета;
  // на своей подаче команда стоит свободно (современные правила), в свободном режиме — без проверок вовсе.
  const strict = (editPreset()?.rules ?? 'strict') === 'strict';
  const legal = view === 'base' && f.kind === 'rec' && strict ? overlapIssues(base) : null;
  const sy = y => 9 - y; // сетка сверху
  // Фишки по игрокам (слотам): при переходе на другую расстановку каждый плавно едет из старой точки в новую.
  const oldTab = fromRot != null && fromRot !== f.rot ? f.data[f.kind][fromRot] : null;
  const tokens = [0, 1, 2, 3, 4, 5].map(sl => {
    const z = slotZone(sl, f.rot, ms), p = tab[z];
    const o = oldTab ? oldTab[slotZone(sl, fromRot, ms)] : p;
    const id = start?.[sl], pl = id ? (person(id)?.id ? person(id) : ui.roster.find(p => p.id === id)) : null;
    const role = pl ? ROLES[roleOf(pl)]?.short ?? '' : sl === ms ? 'СВ' : '';
    return `<g class="ftok ${z === f.rot ? 'setter' : ''} ${legal?.bad.has(z) ? 'bad' : ''}" data-z="${z}" data-tx="${p.x} ${sy(p.y)}" style="transform: translate(${o.x}px, ${sy(o.y)}px)">
      <circle r=".46"/><text class="n" y=".15">${pl ? esc(pl.num || pl.name.slice(0, 2)) : z}</text>
      <text class="r" y="-.62">${role ? role + ' · ' : ''}зона ${z}</text></g>`;
  }).join('');
  const inh = f.inherited[f.kind]?.[f.rot] && !isTouched(f, f.kind, f.rot);
  const w = editPreset();

  const ghosts = [1, 2, 3, 4, 5, 6].map(z => { const b = ZONE_SPOT[z]; return `<text class="fz" x="${b.x}" y="${sy(b.y) + 0.15}">${z}</text>`; }).join('');
  modal(`<h2>Расстановки команды</h2>
    <div class="pbar">Пресет
      <select data-k="fPreset">${f.works.map(x => `<option value="${x.id}" ${x.id === f.presetId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      <select data-k="fRules" title="Проверять ли правила расстановки на приёме (до подброса мяча соперником)">
        <option value="strict" ${(w.rules ?? 'strict') === 'strict' ? 'selected' : ''}>Строгие правила при приёме</option>
        <option value="free" ${w.rules === 'free' ? 'selected' : ''}>Свободно (без проверки)</option>
      </select>
      <select data-k="fSystem" title="Схема игры пресета">${Object.entries(SYSTEMS).map(([k, v]) => `<option value="${k}" ${w.system === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <button class="btn sm" data-a="fNew" title="Новый пресет — копия текущего">＋ Копия</button>
      <button class="btn sm ghost" data-a="fRename">Переименовать</button>
      ${f.works.length > 1 ? '<button class="btn sm ghost danger" data-a="fDel">Удалить</button>' : ''}
      <span class="grow"></span>
      <button class="btn sm ${f.showRoster ? 'primary' : ''}" data-a="fRoster" title="Кто где стоит — для всех переходов пресета">Состав пресета</button>
      ${ui.st?.sets.length ? '<button class="btn sm ghost" data-a="fTakeLineup" title="Номера на фишках — из стартового состава этого матча">Из матча</button>' : ''}
    </div>
    ${f.showRoster ? rosterPanel(f) : ''}
    <p>Перетащите игроков: как команда стоит в каждой расстановке (игровые позиции; «зона N» на фишке — где игрок по протоколу).
      В <b>Р${f.rot}</b> связующий — в зоне ${f.rot}. В защите задайте базовую расстановку — под блок слева / по центру / справа команда
      перестроится сама: кто левее, центральнее и правее в передней и задней линии, тот и займёт своё место.</p>
    <div class="fbar"><div class="seg">${Object.entries(SITUATIONS).map(([k, v]) => `<button class="${f.kind === k ? 'on' : ''}" data-a="fKind" data-v="${k}">${v}</button>`).join('')}</div>
      ${f.kind === 'def' ? `<div class="seg" title="Как команда встанет, когда поставите блок у сетки">${[['base', 'Базовая'], ['left', 'Блок слева'], ['center', 'По центру'], ['right', 'Справа']].map(([k, v]) => `<button class="${view === k ? 'on' : ''}" data-a="fDefView" data-v="${k}">${v}</button>`).join('')}</div>` : ''}
      <div class="seg" title="В порядке переходов: игроки идут по часовой стрелке, номер расстановки — против">
        <button data-a="fStep" data-d="-1" title="Предыдущий переход">◀</button>${GAME_ORDER.map(r => `<button class="${f.rot === r ? 'on' : ''} ${isTouched(f, f.kind, r) ? 'done' : ''}" data-a="fRot" data-v="${r}">Р${r}</button>`).join('')}<button data-a="fStep" data-d="1" title="Следующий переход">▶</button></div></div>
    ${view === 'base' && f.kind === 'serve' ? '<div class="banner" style="margin:0 0 8px">На своей подаче игроки стоят свободно — правила расстановки действуют только для принимающей команды.</div>' : ''}
    ${view === 'base' && f.kind === 'rec' && !strict ? '<div class="banner" style="margin:0 0 8px">Свободный режим: правила расстановки не проверяются.</div>' : ''}
    ${legal ? (legal.issues.length ? `<div class="banner bad" style="margin:0 0 8px">Нарушение расстановки при подаче: ${legal.issues.join('; ')}</div>` : `<div class="banner ok" style="margin:0 0 8px">Расстановка по правилам: линии не пересекаются до удара по мячу.</div>`) : ''}
    ${inh ? `<div class="banner" style="margin:0 0 8px">Р${f.rot} ещё не настроена — игроки сдвинуты на один переход из Р${prevRot(f.rot)}. Поправьте места — и она запомнится.</div>` : ''}
    <div class="zwrap"><svg id="fsvg" viewBox="-1.6 -1.1 12.2 13.4">
      <rect x="0" y="0" width="9" height="9" fill="#1d3a57"/>
      <rect x="0" y="0" width="9" height="3" fill="rgb(255 255 255 / .04)"/>
      <line x1="3" y1="0" x2="3" y2="9" class="fl"/><line x1="6" y1="0" x2="6" y2="9" class="fl"/>
      <line x1="0" y1="3" x2="9" y2="3" stroke="#e9eaec" stroke-width=".05"/>
      <rect x="0" y="0" width="9" height="9" fill="none" stroke="#e9eaec" stroke-width=".06"/>
      <line x1="-0.5" y1="0" x2="9.5" y2="0" stroke="#fff" stroke-width=".14"/>
      <text x="4.5" y="-0.45" class="fcap">сетка</text><text x="4.5" y="10.9" class="fcap">зона подачи</text>
      ${ghosts}${tokens}
    </svg></div>
    <div class="fcopy">
      <button class="btn sm" data-a="fFront" title="Передняя линия по амплуа: ДО — слева (4), ЦБ — в центре, СВ/ДИ — справа (2). Подписи зон — протокольные">Передняя по ролям</button>
      <button class="btn sm ghost" data-a="fFrontAll" title="То же во всех Р1–Р6 этой ситуации">…во всех Р</button>
      <span class="grow"></span>
      Скопировать из <select data-k="fSrcKind">${Object.entries(SITUATIONS).map(([k, v]) => `<option value="${k}" ${(f.srcKind ?? f.kind) === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <select data-k="fSrcRot">${GAME_ORDER.map(r => `<option value="${r}" ${(f.srcRot ?? f.rot) === r ? 'selected' : ''}>Р${r}</option>`).join('')}</select>
      <button class="btn sm" data-a="fCopyFrom">Копировать</button>
    </div>
    <div class="foot"><button class="btn ghost" data-a="fProto" title="Все — ровно в свои зоны по протоколу; от этого удобно расставлять">Протокольная</button><button class="btn ghost" data-a="fReset">Сбросить Р${f.rot}</button><button class="btn ghost" data-a="fCopy">Копировать во все Р1–Р6</button><span class="grow"></span>
      <button class="btn ghost" data-a="modalClose">Отмена</button><button class="btn primary" data-a="fSave">Сохранить</button></div>`);
  const svg = $('fsvg');
  let drag = null;
  const pt = e => { const q = svg.createSVGPoint(); q.x = e.clientX; q.y = e.clientY; return q.matrixTransform(svg.getScreenCTM().inverse()); };
  // Сначала фишки стоят на старых местах, на следующем кадре едут на новые (CSS-переход).
  requestAnimationFrame(() => requestAnimationFrame(() => svg.querySelectorAll('.ftok').forEach(g => { const [x, y] = g.dataset.tx.split(' '); g.style.transform = `translate(${x}px, ${y}px)`; })));
  svg.onpointerdown = e => {
    if (view !== 'base') return toast('Это предпросмотр — двигайте игроков в «Базовой»');
    const g = e.target.closest('.ftok'); if (!g) return;
    drag = +g.dataset.z; g.classList.add('dragging'); svg.setPointerCapture(e.pointerId);
  };
  svg.onpointermove = e => {
    if (!drag) return;
    const q = pt(e);
    const x = Math.max(-1, Math.min(10, Math.round(q.x * 10) / 10)), y = Math.max(-2.5, Math.min(9, Math.round((9 - q.y) * 10) / 10));
    tab[drag] = { x, y };
    svg.querySelector(`.ftok[data-z="${drag}"]`).style.transform = `translate(${x}px, ${9 - y}px)`;
  };
  svg.onpointerup = () => {
    if (!drag) return;
    drag = null;
    svg.querySelector('.ftok.dragging')?.classList.remove('dragging');
    (f.touched[f.kind] ??= {})[f.rot] = true;
    paintFormEditor();
  };
}


// ---------- Команда: название и эмблемы ----------
// Картинку сразу уменьшаем до 160 px (PNG с прозрачностью) — настройки остаются лёгкими.
function fileToEmblem(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const S = 160, c = document.createElement('canvas'); c.width = c.height = S;
      const k = Math.min(S / img.width, S / img.height), w = img.width * k, h = img.height * k;
      c.getContext('2d').drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
      URL.revokeObjectURL(url);
      let out = c.toDataURL('image/png');
      if (out.length > 90000) out = c.toDataURL('image/webp', 0.9);
      resolve(out);
    };
    img.onerror = () => reject(new Error('Не получилось открыть картинку'));
    img.src = url;
  });
}
// Форма команды: цвета майки, шортов, цифр; отдельная майка у связующего и у либеро. Справа — как это выглядит.
const KIT_FIELDS = [['main', 'Майка'], ['shorts', 'Шорты'], ['number', 'Цифры номера'], ['setter', 'Майка связующего'], ['libero', 'Майка либеро']];
function kitPreview(k) {
  const fig = (shirt, label) => `<div class="kitfig"><svg viewBox="0 0 60 70"><path d="M18 6h24l14 10-7 11-6-4v41H17V23l-6 4-7-11z" fill="${shirt}" stroke="rgb(0 0 0 / .35)"/>
    <text x="30" y="46" text-anchor="middle" font-size="22" font-weight="800" fill="${k.number}">7</text></svg><div class="kshorts" style="background:${k.shorts}"></div><small>${label}</small></div>`;
  return fig(k.main, 'игроки') + fig(k.setter, 'связующий') + fig(k.libero, 'либеро');
}
function kitHtml(k) {
  return `<p class="tip-inline">Цвета формы на 3D-площадке. Связующий — тот, кто пасует в этой расстановке; либеро — игрок с ролью «Либеро».</p>
    <div class="kitwrap"><div class="kitlist">${KIT_FIELDS.map(([key, name]) => `<label class="kitrow"><input type="color" data-k="kitColor" data-key="${key}" value="${k[key]}"><span>${name}</span></label>`).join('')}
      <button class="btn sm ghost" data-a="kitReset" style="margin-top:6px;justify-self:start">Как было по умолчанию</button></div>
    <div class="kitprev">${kitPreview(k)}</div></div>`;
}
function openTeamModal() {
  ui.team = { teamName: ui.settings.teamName, emblem: ui.settings.emblem ?? null, kit: { ...KIT_DEFAULT, ...ui.settings.kit }, opponents: JSON.parse(JSON.stringify(ui.settings.opponents)), roster: JSON.parse(JSON.stringify(ui.roster)), tab: 'players' };
  paintTeamModal();
}
function paintTeamModal() {
  const t = ui.team;
  const pick = (who) => `<label class="embpick" title="Загрузить эмблему">${emblem(who === 'us' ? t.emblem : t.opponents[who].emblem, who === 'us' ? t.teamName : t.opponents[who].name, 'lg')}
    <input type="file" accept="image/*" hidden data-k="embFile" data-who="${who}"></label>`;
  const roleOpts = r => `<option value="">Роль</option>${Object.entries(ROLES).map(([k, x]) => `<option value="${k}" ${r === k ? 'selected' : ''}>${x.name}</option>`).join('')}`;
  const players = [...t.roster].map((p, i) => ({ p, i })).sort((a, b) => (a.p.active === false) - (b.p.active === false) || (a.p.num || 99) - (b.p.num || 99));
  const playersHtml = `<p class="tip-inline">Пул игроков: «в составе» — попадают в новые матчи; «в запасе» — пока не играют (ушли, травма, другой турнир), их статистика в прошлых матчах сохраняется.</p>
    <div class="tlist">${players.map(({ p, i }) => `<div class="trow pl ${p.active === false ? 'off' : ''}">
      <input class="num" data-k="plNum" data-i="${i}" value="${esc(p.num ?? '')}" placeholder="№" inputmode="numeric">
      <input data-k="plName" data-i="${i}" value="${esc(p.name)}" placeholder="Имя">
      <select data-k="plRole" data-i="${i}">${roleOpts(roleOf(p))}</select>
      <button class="btn sm ${p.active === false ? '' : 'ghost'}" data-a="plActive" data-i="${i}" title="В составе / в запасе">${p.active === false ? 'В запасе' : 'В составе'}</button>
      <button class="rowdel" style="opacity:1" data-a="plDel" data-i="${i}" title="Удалить игрока">${icon('i-x')}</button></div>`).join('')}</div>
    <button class="btn sm" data-a="plAdd" style="margin-top:8px">${icon('i-plus')}Игрок</button>`;
  modal(`<h2>Команда</h2>
    <div class="trow us">${pick('us')}<input data-k="teamName" value="${esc(t.teamName)}" placeholder="Название команды">
      ${t.emblem ? '<button class="btn sm ghost" data-a="embDel" data-who="us">Убрать эмблему</button>' : ''}</div>
    <div class="seg" style="margin:14px 0 10px"><button class="${t.tab === 'players' ? 'on' : ''}" data-a="teamTab" data-v="players">Игроки</button><button class="${t.tab === 'kit' ? 'on' : ''}" data-a="teamTab" data-v="kit">Форма</button><button class="${t.tab === 'opps' ? 'on' : ''}" data-a="teamTab" data-v="opps">Соперники и эмблемы</button></div>
    ${t.tab === 'kit' ? kitHtml(t.kit) + `<div class="foot"><button class="btn ghost" data-a="modalClose">Отмена</button><button class="btn primary" data-a="teamSave">Сохранить</button></div>` : ''}
    ${t.tab === 'players' ? playersHtml + `<div class="foot"><button class="btn ghost" data-a="modalClose">Отмена</button><button class="btn primary" data-a="teamSave">Сохранить</button></div>` : ''}
    <div ${t.tab !== 'opps' ? 'hidden' : ''}>
    <p class="tip-inline">Эмблемы показываются в табло, списках матчей и аналитике. Кликните по кружку, чтобы загрузить картинку.</p>
    <div class="tlist">${t.opponents.map((o, i) => `<div class="trow">${pick(i)}<input data-k="oppName" data-i="${i}" value="${esc(o.name)}" placeholder="Название">
      ${o.emblem ? `<button class="btn sm ghost" data-a="embDel" data-who="${i}">Убрать</button>` : ''}
      <button class="rowdel" style="opacity:1" data-a="oppDel" data-i="${i}" title="Удалить соперника">${icon('i-x')}</button></div>`).join('') || '<p class="muted">Соперников пока нет.</p>'}</div>
    <button class="btn sm" data-a="oppAdd" style="margin-top:8px">${icon('i-plus')}Соперник</button>
    <div class="foot"><button class="btn ghost" data-a="modalClose">Отмена</button><button class="btn primary" data-a="teamSave">Сохранить</button></div></div>`);
}


// ---------- Настройки: общие, плеер, 3D-площадка, команда, данные ----------
// Одно окно с разделами слева (как в Figma / Adobe). Настройки вида запоминаются на этом компьютере,
// настройки команды и данные — на сервере (общие для студии и пультов).
const SET_TABS = [['general', 'Общие'], ['player', 'Плеер'], ['court', '3D-площадка'], ['team', 'Команда'], ['data', 'Данные']];
const VIEW_NAMES = { persp: 'Перспектива', top: 'Сверху', behind: 'Из-за спины', side: 'Сбоку' };
const LABEL_NAMES = { num: 'Номер', name: 'Имя', full: 'Номер и имя', none: 'Без подписи' };
function openSettings(tab = ui.setTab ?? 'general') {
  ui.setTab = tab;
  if (tab === 'data') return call(async () => { await loadDataView(); paintSettings(); });
  paintSettings();
}
const optRow = (title, sub, ctl) => `<div class="srow"><span class="grow"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</span>${ctl}</div>`;
const segCtl = (k, cur, opts) => `<div class="seg">${opts.map(([v, l]) => `<button class="${String(cur) === String(v) ? 'on' : ''}" data-a="setOpt" data-k="${k}" data-v="${v}">${l}</button>`).join('')}</div>`;
const switchCtl = (k, on) => `<label class="switch"><input type="checkbox" data-k="${k}" ${on ? 'checked' : ''}><i></i></label>`;
function settingsBody(tab) {
  if (tab === 'general') return `<h3 class="mh">Общие</h3>
    ${optRow('Режим подсказок', 'Задержите курсор на кнопке — появится пояснение. То же — кнопка «?» в верхней панели.', switchCtl('optTips', tips.on))}
    ${optRow('Стартовый экран при запуске', 'Последние матчи, новый матч, команда — вместо сразу открытого матча.', switchCtl('optStart', store.get('startScreen', true)))}
    ${optRow('Обучение', 'Короткий тур по окну студии.', '<button class="btn sm" data-a="tourStart">Пройти снова</button>')}
    ${optRow('Горячие клавиши', 'Все сочетания на одной странице. Клавиша ?', '<button class="btn sm" data-a="help">Открыть</button>')}`;
  if (tab === 'player') return `<h3 class="mh">Плеер</h3>
    ${optRow('Пауза при вводе', 'Видео останавливается, пока вводите касание; после конца розыгрыша продолжится само.', switchCtl('optAutoPause', $('autoPause').checked))}
    ${optRow('Скорость в синхронизации', 'Режим «Синхр.»: видео идёт от касания к касанию на этой скорости.', segCtl('syncRate', ui.syncRate, [[0.5, '0,5×'], [0.75, '0,75×'], [1, '1×']]))}
    ${optRow('Петля синхронизации', 'Если следующее касание не отмечено — через столько секунд видео вернётся к прошлому.', segCtl('loopLen', ui.loopLen, [[3, '3 с'], [5, '5 с'], [8, '8 с'], [12, '12 с']]))}
    ${optRow('Перемотка стрелками ← →', 'С Shift — втрое дальше.', segCtl('seekStep', ui.seekStep, [[2, '2 с'], [5, '5 с'], [10, '10 с']]))}`;
  if (tab === 'court') return `<h3 class="mh">3D-площадка</h3>
    ${optRow('Детализация игроков', 'Реалистичные фигуры или простые человечки (легче для слабого компьютера). Кнопка HD/Lo на панели площадки.', segCtl('detail', store.get('detail', 'real'), [['real', 'Реалистичные'], ['simple', 'Простые']]))}
    ${optRow('Подписи над игроками', '', segCtl('labelMode', store.get('labelMode', 'num'), Object.entries(LABEL_NAMES)))}
    ${optRow('Вид при запуске', '', segCtl('view3d', store.get('view3d', 'persp'), Object.entries(VIEW_NAMES)))}
    ${optRow('Сетка зон', 'Тонкие линии 3×3 м на площадке.', switchCtl('optZones', store.get('zonesOn', true)))}`;
  if (tab === 'team') {
    const act = ui.roster.filter(p => p.active !== false).length;
    return `<h3 class="mh">Команда</h3>
    <div class="card teamcard" style="margin-bottom:10px">${ourEmblem('lg')}<span class="grow"><b>${esc(ui.settings.teamName)}</b><small>в составе ${act} · в запасе ${ui.roster.length - act} · соперников ${ui.settings.opponents.length}</small></span></div>
    ${optRow('Игроки, форма, соперники', 'Номера, имена, роли; цвета майки и шортов; эмблемы.', '<button class="btn sm" data-a="teamModal">Изменить</button>')}
    ${optRow('Расстановки', 'Как команда стоит на приёме, на своей подаче и в защите — для каждой из Р1–Р6.', '<button class="btn sm" data-a="formEditor">Настроить</button>')}
    ${optRow('Зоны доводки', 'Оценка приёма и защиты ++ / + / − по точке, куда мяч пришёл к пасующему.', '<button class="btn sm" data-a="zonesEditor">Настроить</button>')}`;
  }
  return `<h3 class="mh">Данные</h3>${dataBody()}`;
}
function paintSettings() {
  const tab = ui.setTab;
  modal(`<div class="setwin"><nav class="setnav"><h2>Настройки</h2>${SET_TABS.map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" data-a="setTab" data-v="${k}">${l}</button>`).join('')}</nav>
    <div class="setbody">${settingsBody(tab)}<div class="foot"><button class="btn primary" data-a="settingsClose">Готово</button></div></div></div>`);
  $('modal').querySelector('.modal')?.classList.add('wide');
}
// Применить настройку вида (кнопки-сегменты в окне настроек).
function applyOpt(k, v) {
  if (k === 'syncRate') { if (ui.sync) setSpeed(+v); else { ui.syncRate = +v; store.set('syncRate', ui.syncRate); paintSpeed(); } }
  if (k === 'loopLen') { ui.loopLen = +v; store.set('loopLen', ui.loopLen); paintSyncUi(); }
  if (k === 'seekStep') { ui.seekStep = +v; store.set('seekStep', ui.seekStep); }
  if (k === 'detail') { store.set('detail', v); court.setDetail(v); paintDetailBtn(); }
  if (k === 'labelMode') { store.set('labelMode', v); court.setLabelMode(v); paintLabelBtn(); }
  if (k === 'view3d') { store.set('view3d', v); H.view({ v }); }
  paintSettings();
}

// ---------- Данные: резервные копии и корзина ----------
async function loadDataView() {
  const [backups, trash] = await Promise.all([api('GET', '/api/backups'), api('GET', '/api/trash')]);
  ui.dataView = { backups, trash };
}
async function openDataModal() {
  await loadDataView();
  ui.setTab = 'data';
  paintSettings();
}
function paintDataModal() { paintSettings(); }
function dataBody() {
  const { backups, trash } = ui.dataView;
  const when = iso => (iso ? new Date(iso).toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
  return `
    <p>Копия — состав, настройки (пресеты, эмблемы, турниры) и все матчи. Делается сама раз в день (хранятся 30 последних),
      лежит в <code>data/backups</code>. Видео в копию не входит — оно в <code>data/videos</code>.</p>
    <div class="dbtns">
      <button class="btn primary" data-a="bkMake">Сделать копию сейчас</button>
      <button class="btn" data-a="bkDownload">⤓ Сохранить в файл</button>
      <label class="btn">⤒ Восстановить из файла<input type="file" accept=".json,application/json" hidden data-k="bkFile"></label>
    </div>
    <h3 class="mh">Копии</h3>
    <div class="dlist">${backups.map(b => `<div class="drow"><span><b>${when(b.created)}</b><small>${esc(b.reason)} · матчей ${b.matches}</small></span>
      <button class="btn sm ghost" data-a="bkRestore" data-n="${b.name}">Восстановить</button></div>`).join('') || '<p class="muted">Копий пока нет.</p>'}</div>
    <h3 class="mh">Корзина: удалённые матчи</h3>
    <div class="dlist">${trash.map(t => `<div class="drow"><span><b>${esc(t.opponent)} · ${new Date(t.created).toLocaleDateString('ru')}</b><small>${t.mode === 'quick' ? 'быстрая' : 'детальная'} · событий ${t.events} · удалён ${esc(t.deleted.slice(0, 10))}</small></span>
      <button class="btn sm" data-a="trRestore" data-f="${esc(t.file)}">Вернуть</button></div>`).join('') || '<p class="muted">Корзина пуста.</p>'}</div>`;
}
async function afterRestore(msg) {
  await loadAll();
  if (ui.match && ui.matches.some(m => m.id === ui.match.id)) setMatch(await api('GET', `/api/matches/${ui.match.id}`)); else { ui.match = null; ui.full = ui.st = null; }
  await openDataModal();
  toast(msg);
}


// ---------- Обучение: короткий тур по студии ----------
// Подсвечиваем часть окна и коротко объясняем. Сам запускается при первом открытии студии, потом — из справки (⌨).
const TOUR = [
  ['.topbar .scoreboard', 'Табло', 'Счёт партии, партии в матче и кто подаёт (жёлтая точка). Слева — выбранный матч, справа — аналитика.'],
  ['.video-pane', 'Видео матча', 'Перетащите файл в окно — он скопируется в программу (любой формат). Колесо мыши над видео — зум, двойной клик — сброс.'],
  ['#transport', 'Управление видео', 'Перемотка ±5 и ±15 с (стрелки ← →, с Shift — 15 с), скорость. «⟲ Синхр.» — разметка вслед за видео: Пробел на касании, после шага видео едет дальше, петля повторяет момент.'],
  ['#timeline', 'Таймлайн', 'Метки касаний: зелёные — очко нам, красные — им, жёлтые — тайм-ауты. Клик по метке — к этому моменту.'],
  ['.court-pane', '3D-площадка', 'Розыгрыш вводится кликами. Сначала точка, куда пришёл мяч, потом игрок (вероятный пульсирует). Двойной клик по полу — очко в эту точку. Мышь — вращать, колесо — зум.'],
  ['#courtHint', 'Что делать сейчас', 'Подсказка шага и счётчик касаний 1 · 2 · 3: приём → доводка (оценка по зонам) → пас (колесо — высота) → атака.'],
  ['#courtBar', 'Кнопки под рукой', '«Назад» (⌫) — на шаг назад, «Отмена» (Esc), «Мяч упал» (X), тайм-ауты, +1 без статистики.'],
  ['.court-tools', 'Виды и настройки', 'Камера: перспектива, сверху, из-за спины, сбоку. Сетка зон, история касаний, расстановки команды и зоны доводки ++ / + / −.'],
  ['#dock', 'Нижняя панель', 'Расстановка Р1–Р6 и замены, кнопки действий — запасной вариант ввода без площадки (клавиши A–H, Q–Y).'],
  ['#sideTabs', 'Панели справа', '«События» — розыгрыши (★ лучшие моменты, нарезка mp4) и правка; «Видео» — библиотека; «Стат.» — живая статистика; «Матч» — формат, турнир, пресет, команда и резервные копии.'],
  [null, 'Начнём', 'Вкладка «Матч» → «Новый»: соперник и формат, затем старт партии из пресета (Р1–Р6). Все клавиши — кнопка ⌨ или «?». Тур можно пройти снова оттуда же.'],
];
function startTour(k = 0) {
  modal('');
  let el = $('tour');
  if (!el) { el = document.createElement('div'); el.id = 'tour'; document.body.append(el); }
  const [sel, title, text] = TOUR[k];
  const target = sel && document.querySelector(sel);
  const r = target?.getBoundingClientRect();
  const hole = r && r.width ? `<div class="tour-hole" style="left:${r.left - 6}px;top:${r.top - 6}px;width:${r.width + 12}px;height:${r.height + 12}px"></div>` : '<div class="tour-dim"></div>';
  // Карточку ставим рядом с подсвеченным: снизу, если есть место, иначе сверху; по центру — для финального шага.
  let pos = 'left:50%;top:50%;transform:translate(-50%,-50%)';
  if (r && r.width) {
    const left = Math.max(16, Math.min(innerWidth - 376, r.left + r.width / 2 - 180));
    if (r.bottom + 220 < innerHeight) pos = `left:${left}px;top:${r.bottom + 14}px`;
    else if (r.top - 220 > 0) pos = `left:${left}px;top:${r.top - 14}px;transform:translateY(-100%)`;
    else pos = `left:${Math.max(16, r.left + 16)}px;top:${r.top + 60}px`; // большой блок — карточка внутри него
  }
  el.innerHTML = `${hole}<div class="tour-card" style="${pos}">
    <div class="tour-step">${k + 1} / ${TOUR.length}</div><b>${title}</b><p>${text}</p>
    <div class="tour-btns"><button class="btn sm ghost" data-a="tourEnd">Пропустить</button><span class="grow"></span>
      ${k ? '<button class="btn sm" data-a="tourGo" data-k="' + (k - 1) + '">Назад</button>' : ''}
      ${k < TOUR.length - 1 ? `<button class="btn sm primary" data-a="tourGo" data-k="${k + 1}">Далее</button>` : '<button class="btn sm primary" data-a="tourEnd">Начать работу</button>'}</div></div>`;
  ui.tour = k;
}
function endTour() { $('tour')?.remove(); ui.tour = null; store.set('tourDone', true); }

// ---------- Видео ----------
function openVideo(id, { keepTime = false } = {}) {
  const v = ui.videos.find(x => x.id === id);
  if (!v) return;
  if (v.status === 'processing') return toast('Видео ещё готовится — откроется само, когда будет готово');
  const t = keepTime ? video.currentTime : null;
  ui.activeVideo = id;
  video.src = '/media/' + encodeURIComponent(v.file);
  if (t) video.currentTime = t;
  if (ui.match) store.set('video.' + ui.match.id, id);
  render();
}
function seekTo(t) { if (video.src) video.currentTime = Math.max(0, Math.min(video.duration || 1e9, t)); }

function uploadFiles(files) {
  for (const file of files) {
    const u = { name: file.name, p: 0 };
    ui.uploads.push(u);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/videos');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = e => { u.p = e.loaded / e.total; if (ui.tab === 'video') paintSide(); };
    xhr.onload = async () => {
      const res = JSON.parse(xhr.responseText || '{}');
      if (res.error) { u.err = res.error; render(); return; }
      ui.uploads.splice(ui.uploads.indexOf(u), 1);
      ui.videos = await api('GET', '/api/videos');
      if (ui.match) await linkVideo(res.id);
      if (res.status === 'processing') {
        toast(`«${file.name}»: ${res.mode === 'remux' ? 'переупаковываю' : 'перевожу в H.264 для плавной перемотки'} — можно работать дальше`);
        ui.openWhenReady = res.id;
        pollVideos();
      } else { toast(`Видео «${file.name}» в библиотеке`); if (ui.match) openVideo(res.id); else render(); }
    };
    xhr.onerror = () => { u.err = 'Не удалось скопировать'; render(); };
    xhr.send(file);
  }
  ui.tab = 'video';
  render();
}
// Пока какое-то видео готовится — раз в 1,5 с обновляем список (прогресс в панели «Видео»).
let polling = false;
async function pollVideos() {
  if (polling) return;
  polling = true;
  while (ui.videos.some(v => v.status === 'processing')) {
    await new Promise(r => setTimeout(r, 1500));
    ui.videos = await api('GET', '/api/videos').catch(() => ui.videos);
    const ready = ui.videos.find(v => v.id === ui.openWhenReady && v.status !== 'processing');
    if (ready) { ui.openWhenReady = null; if (ready.status === 'ready') { toast(`Видео «${ready.name}» готово`); if (ui.match?.videos?.includes(ready.id)) openVideo(ready.id); } else toast(`Не удалось подготовить «${ready.name}»`, true); }
    if (ui.tab === 'video') paintSide();
  }
  polling = false;
}
async function linkVideo(id) {
  const videos = [...new Set([...(ui.match.videos || []), id])];
  setMatch(await api('PATCH', `/api/matches/${ui.match.id}`, { videos }));
}




// ---------- Розыгрыши: история ↔ видео ↔ 3D ----------
// Розыгрыш — касания одной подачи. По времени касаний видео и 3D показывают одно и то же.
let rallyCache = { m: null, list: [] };
function rallies() {
  if (rallyCache.m === ui.full) return rallyCache.list;
  const groups = new Map();
  for (const pl of ui.full.plays) {
    if (pl.virtual) continue;
    const key = `${pl.set}:${pl.rally}`;
    if (!groups.has(key)) groups.set(key, { key, set: pl.set, rally: pl.rally, plays: [], rot: pl.rot, weServe: pl.weServe, score: pl.score });
    groups.get(key).plays.push(pl);
  }
  const list = [...groups.values()].map(r => {
    const won = r.plays[0].won;
    const ts = r.plays.filter(p => p.vt != null).map(p => p.vt);
    const head = ui.match.events[r.plays[0].i] ?? {};
    return { ...r, won, star: !!head.star, note: head.note ?? '', after: won == null ? null : [r.score[0] + (won ? 1 : 0), r.score[1] + (won ? 0 : 1)],
      t0: ts.length ? Math.min(...ts) : null, t1: ts.length ? Math.max(...ts) : null, v: r.plays.find(p => p.v)?.v ?? null };
  });
  rallyCache = { m: ui.full, list, st0: new Map() };
  return list;
}
const rallyByKey = key => rallies().find(r => r.key === key);
const SHORT = { serve: 'подача', rec: 'приём', set: 'пас', att: 'атака', blk: 'блок', dig: 'защита', fault: 'ошибка', team: '' };
function rallySummary(r) {
  return r.plays.map(p => {
    if (p.skill === 'team') return LABELS.team[p.res];
    const num = person(p.p).num;
    const lbl = LABELS[p.skill][p.res].replace(/^[^:]+: /, '');
    return `${num ? '#' + num + ' ' : ''}${SHORT[p.skill]}${p.skill === 'serve' || p.skill === 'set' || p.skill === 'rec' || p.skill === 'att' ? ' ' + lbl.replace(/^(Приём|Подача|Пас|Атака) ?/, '').toLowerCase() : ''}`;
  }).join(' → ');
}
function pickRally(key, { seek = true } = {}) {
  ui.focusRally = key; ui.edit = null; ui.pickedRally = true;
  const r = rallyByKey(key);
  if (seek && r?.t0 != null) {
    if (r.v && r.v !== ui.activeVideo && ui.videos.some(v => v.id === r.v)) openVideo(r.v);
    seekTo(r.t0 - 2.5);
  }
  render();
  document.querySelector('.rl.sel')?.scrollIntoView({ block: 'nearest' });
}
function stepRally(dir) {
  const list = rallies();
  if (!list.length) return;
  const k = list.findIndex(r => r.key === ui.focusRally);
  const next = list[Math.max(0, Math.min(list.length - 1, k < 0 ? (dir > 0 ? 0 : list.length - 1) : k + dir))];
  pickRally(next.key);
}
// Фильтр розыгрышей: все / избранные / наши очки / их очки.
const RFILTER = { all: 'Все', star: '★ Избранное', us: 'Наши очки', them: 'Их очки' };
const filteredRallies = () => rallies().filter(r => ({ all: true, star: r.star, us: r.won === true, them: r.won === false })[ui.rFilter ?? 'all']);
function sideRallies() {
  const list = filteredRallies();
  let html = '', set = -1;
  // Тайм-ауты — строками между розыгрышами (по месту в списке событий).
  const tos = ui.full.log.filter(l => l.timeout).map(l => ({ i: l.i, side: l.timeout, text: l.text, vt: ui.match.events[l.i]?.vt }));
  let ti = 0;
  const flushTo = upto => { let h = ''; while (ti < tos.length && tos[ti].i < upto) { const t = tos[ti++]; h += `<div class="tol" data-a="pickEv" data-i="${t.i}"><span>${t.vt != null ? fmtShort(t.vt) : ''}</span>⏸ ${esc(t.text)}</div>`; } return h; };
  for (const r of list) {
    html += (ui.rFilter ?? 'all') === 'all' ? flushTo(r.plays[0].i) : '';
    if (r.set !== set) { set = r.set; html += `<div class="ev-div">Партия ${set + 1}</div>`; }
    const cls = `rl ${r.won === true ? 'us' : r.won === false ? 'them' : 'open'} ${ui.focusRally === r.key ? 'sel' : ''}`;
    html += `<div class="${cls}" data-a="pickRally" data-k="${r.key}">
      <span class="t ${r.t0 == null ? 'none' : ''}">${r.t0 == null ? '—' : fmtShort(r.t0)}</span>
      <span class="sc">${r.after ? r.after.join(':') : '…'}</span>
      <span class="body"><b>${r.won === true ? 'Очко нам' : r.won === false ? 'Очко им' : 'Идёт'}</b> · Р${r.rot} · ${r.weServe ? 'наша подача' : 'приём'}<small>${esc(rallySummary(r))}</small>${r.note ? `<em class="note">${esc(r.note)}</em>` : ''}</span>
      <span class="racts"><button class="rowstar ${r.star ? 'on' : ''}" data-a="rallyStar" data-k="${r.key}" title="${r.star ? 'Убрать из избранного' : 'В избранное (лучшие моменты)'}">${r.star ? '★' : '☆'}</button>
      ${r.star ? `<button class="rowdel" data-a="rallyNote" data-k="${r.key}" title="Заметка">✎</button>` : ''}
      <button class="rowdel" data-a="rallyDel" data-k="${r.key}" title="Удалить розыгрыш целиком">${icon('i-x')}</button></span></div>`;
  }
  return html || '<p class="muted">Розыгрышей пока нет.</p>';
}

// Повтор по видео: розыгрыш, во время которого сейчас кадр, показывается на 3D синхронно.
function rallyAtTime(t) {
  return rallies().find(r => r.won != null && r.t0 != null && r.v === ui.activeVideo && t >= r.t0 - 2 && t <= r.t1 + 2.5);
}
function stateAt(r) {
  // Состав и зоны на начало розыгрыша — переигрываем события до его первого касания.
  if (!rallyCache.st0.has(r.key)) {
    const first = Math.min(...r.plays.map(p => p.i));
    rallyCache.st0.set(r.key, replay({ ...ui.match, events: ui.match.events.slice(0, first) }));
  }
  return rallyCache.st0.get(r.key);
}
// Ключевые точки полёта мяча: время → точка и высота; между ними — дуга.
function ballKeys(r) {
  const k = [];
  let lastSetTo = null;
  for (const pl of r.plays) {
    if (pl.vt == null) continue;
    const t = pl.vt;
    // Защита без отмеченного удара соперника: мяч прилетает из их передней зоны (зеркально по ширине).
    if (pl.skill === 'dig' && pl.to && !pl.from) k.push({ t: t - 0.8, p: { x: 9 - pl.to.x, y: 10.4 }, h: 3.1, apex: 3.2 });
    // Подача приземляется не позже чем через 40% времени до следующего касания (там ещё их приём и атака).
    const nextVt = r.plays.find(q => q.vt != null && q.vt > t)?.vt;
    const fly = nextVt ? Math.min(1.1, (nextVt - t) * 0.4) : 1.1;
    if (pl.skill === 'serve') { k.push({ t, p: pl.from ?? DEFAULT_SPOT.serveUs, h: 2.8, apex: 4.4 }); if (pl.to) k.push({ t: t + fly, p: pl.to, h: 0.3, apex: 3 }); }
    if (pl.skill === 'rec' && pl.to) { k.push({ t: t - 1.2, p: pl.from ?? DEFAULT_SPOT.serveThem, h: 2.8, apex: 4.2 }); k.push({ t, p: pl.to, h: 0.8, apex: 4.6 }); }
    if (pl.skill === 'dig' && pl.to) { if (pl.from) k.push({ t: t - 0.8, p: pl.from, h: 3.1, apex: 3.2 }); k.push({ t, p: pl.to, h: 0.8, apex: 4.6 }); }
    if (pl.skill === 'set') { k.push({ t, p: pl.from ?? SETTER_SPOT, h: 2.5, apex: pl.h ?? TEMPOS[pl.tempo]?.h ?? 4.2 }); lastSetTo = pl.to ?? null; }
    if (pl.skill === 'att') { k.push({ t, p: pl.from ?? lastSetTo ?? { x: 4.5, y: 7.6 }, h: 3.1, apex: 3.25 }); if (pl.to) k.push({ t: t + 0.55, p: pl.to, h: 0.12, apex: 1.5 }); }
    if (pl.skill === 'blk' && pl.to) k.push({ t, p: pl.to, h: 2.9, apex: 3.4 });
  }
  return k.sort((a, b) => a.t - b.t);
}
function ballAt(keys, t) {
  if (!keys.length) return null;
  if (t <= keys[0].t) return { ...keys[0].p, h: keys[0].h };
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t < b.t) {
      const f = (t - a.t) / Math.max(0.05, b.t - a.t), mid = (a.h + b.h) / 2, kk = Math.max(0, a.apex - mid);
      return { x: a.p.x + (b.p.x - a.p.x) * f, y: a.p.y + (b.p.y - a.p.y) * f, h: a.h + (b.h - a.h) * f + 4 * kk * f * (1 - f) };
    }
  }
  const z = keys.at(-1);
  return { ...z.p, h: z.h };
}
// Игроки в повторе: расстановка на начало розыгрыша, дальше — кто сыграл мяч, выбегает в точку касания.
function replayPlayers(r, t) {
  const st0 = stateAt(r);
  if (!st0.set) return [];
  const lineup = st0.set.lineup, zones = st0.rally.zones, rot = st0.rally.rot, F = FORM();
  const done = r.plays.filter(p => p.vt != null && p.vt <= t);
  const last = done.at(-1);
  const crossed = last && (['serve', 'att'].includes(last.skill) && last.res !== 'kill' || ['over'].includes(last.res));
  const kind = !last ? (r.weServe ? 'serve' : 'rec') : crossed || last.skill === 'serve' ? 'def' : 'att';
  const setters = new Set(ui.match.roster.filter(p => p.setter).map(p => p.id));
  const moved = {};
  // Касания текущего владения мячом.
  let lastSetTo = null;
  for (const pl of done) {
    if (['serve', 'att'].includes(pl.skill) || pl.res === 'over') {
      for (const k in moved) delete moved[k];
      // Нападающий остаётся в точке удара, пока мяч у соперника.
      if (pl.skill === 'att' && pl.p) { const f = pl.from ?? lastSetTo; if (f) moved[pl.p] = f; }
      continue;
    }
    if (pl.skill === 'set') lastSetTo = pl.to ?? null;
    const pt = pl.skill === 'set' ? pl.from : pl.to;
    if (pl.p && pt) moved[pl.p] = pt;
  }
  const gsR = lineup.find(id => setters.has(id) && isFrontZone(zones[lineup.indexOf(id)])) ?? lineup.find(id => setters.has(id));
  const attRole = attackByRole(lineup.map((id, k) => ({ id, zone: zones[k], role: roleOf(person(id)), front: isFrontZone(zones[k]) })), gsR);
  return lineup.map((id, k) => {
    const z = zones[k], p = person(id);
    let spot = kind === 'att' ? (F.touched?.att?.[rot] ? spotFor(F, 'att', rot, z) : attRole[id]) : spotFor(F, kind, rot, z);
    if (kind === 'serve' && st0.rally.server === id && !last) spot = { x: 7.6, y: -0.9 };
    return { id, ...(last?.skill === 'set' && last.p === id ? { yaw: Math.PI / 2 } : {}), label: p.num || (p.name || '?').slice(0, 2), num: p.num, name: p.name, libero: roleOf(p) === 'l', spot: moved[id] ?? spot, setter: setters.has(id), selected: last?.p === id, pinned: !!moved[id], act: last?.p === id && ACT_OF[last.skill] ? { type: ACT_OF[last.skill], key: `${last.skill}:${last.vt}` } : null };
  });
}
let replayKey = null;
function replayTick() {
  requestAnimationFrame(replayTick);
  // В синхронизации повтор — только если розыгрыш выбрали в истории сами (иначе он мешал бы вводу следующего).
  if (!ui.match || !video.src || ui.draft || (ui.sync && (ui.anchor != null || !ui.pickedRally))) { if (replayKey) { replayKey = null; court.setBall(null); paintCourt(); } return; }
  const t = video.currentTime;
  const r = rallyAtTime(t);
  if (!r) { if (replayKey) { replayKey = null; court.setBall(null); paintCourt(); } return; }
  if (replayKey !== r.key) {
    replayKey = r.key;
    if (ui.focusRally !== r.key) { ui.focusRally = r.key; if (ui.tab === 'events') paintSide(); }
    court.setTrails(trailsFor(r.plays), { animate: false });
    court.setPreview([]); court.setHands([]);
  }
  court.setPlayers(replayPlayers(r, t));
  court.setBall(ballAt(ballKeys(r), t));
}
requestAnimationFrame(replayTick);

// ---------- Скорость видео: выпадающее меню (много вариантов замедления) ----------
// В режиме синхронизации своя скорость (запоминается отдельно) — обычно медленнее.
const SPEEDS = [0.1, 0.2, 0.25, 0.33, 0.4, 0.5, 0.6, 0.75, 0.9, 1, 1.25, 1.5, 2];
const curRate = () => (ui.sync ? ui.syncRate : ui.rate);
const fmtRate = r => `${String(+r.toFixed(2)).replace('.', ',')}×`;
function setSpeed(r) {
  if (ui.sync) { ui.syncRate = r; store.set('syncRate', r); } else ui.rate = r;
  if (!ui.ff) video.playbackRate = r;
  paintSpeed();
}
function paintSpeed() {
  const r = curRate();
  $('speedVal').textContent = fmtRate(r);
  $('speedBtn').classList.toggle('slow', r < 1);
  $('speedPop').innerHTML = `<div class="sp-h">Скорость${ui.sync ? ' <small>в синхронизации</small>' : ''}</div>`
    + [...SPEEDS].reverse().map(v => `<button data-a="speed" data-v="${v}" class="${Math.abs(v - r) < 1e-3 ? 'on' : ''}">${fmtRate(v)}${v === 1 ? '<small>обычная</small>' : ''}</button>`).join('');
}
const closeSpeed = () => $('speedPop').classList.remove('on');
// Шаг скорости с клавиатуры: [ — медленнее, ] — быстрее.
function stepSpeed(dir) {
  const r = curRate(), i = SPEEDS.findIndex(v => v >= r - 1e-3);
  const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? SPEEDS.length - 1 : i) + dir))];
  setSpeed(next); toast('Скорость ' + fmtRate(next));
}
document.addEventListener('pointerdown', e => { if (!e.target.closest('#speed')) closeSpeed(); });

// ---------- Синхронизация с видео ----------
function setSync(on) {
  ui.sync = on; store.set('sync', on);
  ui.anchor = null; ui.loops = 0;
  if (video.src) video.playbackRate = on ? ui.syncRate : ui.rate;
  paintSpeed();
  paintSyncUi();
  toast(on ? 'Синхронизация: Пробел — стоп-кадр на касании, Tab — к следующей подаче' : 'Синхронизация выключена');
}
function paintSyncUi() {
  $('syncBtn').classList.toggle('on', ui.sync);
  $('loopSeg').classList.toggle('on', ui.sync);
  document.querySelectorAll('[data-a=loopLen]').forEach(b => b.classList.toggle('on', +b.dataset.v === ui.loopLen));
  paintSyncHud();
}
function paintSyncHud() {
  const out = [];
  if (ui.ff) out.push('<span class="ff">⏩ К подаче ×3 · Пробел — стоп</span>');
  else if (ui.sync && video.src) {
    if (video.paused) out.push('<span class="frz">❚❚ Стоп-кадр · отметьте касание</span>');
    else if (ui.anchor != null) out.push(`<span>⟲ Петля ${ui.loopLen} с${ui.loops ? ` · круг ${ui.loops + 1} · 0.5×` : ''}</span>`);
    else out.push('<span>⟲ Синхр. · Пробел на касании</span>');
  }
  $('syncHud').innerHTML = out.join('');
}
// «К следующей подаче»: быстро вперёд, пока не нажмёте Пробел.
function toggleFF() {
  if (ui.ff) { stopFF(); video.pause(); paintSyncHud(); return; }
  ui.ff = true; ui.anchor = null; ui.manualPause = false;
  video.playbackRate = 3; video.play().catch(() => {});
  paintSyncHud();
}
function stopFF() { if (!ui.ff) return; ui.ff = false; video.playbackRate = ui.sync ? ui.syncRate : ui.rate; }
setInterval(() => {
  if (!ui.sync || ui.anchor == null || video.paused || ui.ff) return;
  if (video.currentTime > ui.anchor + ui.loopLen) {
    ui.loops++;
    video.currentTime = ui.anchor;
    video.playbackRate = ui.loops >= 1 ? 0.5 : ui.syncRate;
    paintSyncHud();
  }
}, 100);
video.addEventListener('play', paintSyncHud);
video.addEventListener('pause', paintSyncHud);

// ---------- Зум видео ----------
// Колесо над видео — зум к курсору (до 8×), перетаскивание — сдвиг, двойной клик — сброс.
// Зум запоминается для каждого видео: камера на турнире обычно стоит неподвижно.
const vz = { z: 1, x: 0, y: 0 };
const vstage = $('vstage'), mini = $('minimap');
function clampZoom() {
  const W = vstage.clientWidth, H = vstage.clientHeight;
  vz.z = Math.max(1, Math.min(8, vz.z));
  vz.x = Math.min(0, Math.max(W - W * vz.z, vz.x));
  vz.y = Math.min(0, Math.max(H - H * vz.z, vz.y));
}
let zoomSave;
function applyZoom() {
  clampZoom();
  video.style.transform = vz.z > 1.001 ? `translate(${vz.x}px, ${vz.y}px) scale(${vz.z})` : '';
  vstage.classList.toggle('zoomed', vz.z > 1.001);
  mini.classList.toggle('on', vz.z > 1.001 && !!video.src);
  $('zoomVal').textContent = Math.round(vz.z * 100) + '%';
  drawMini();
  clearTimeout(zoomSave);
  // Храним в долях, чтобы зум не «уезжал» при другом размере окна.
  if (ui.activeVideo) zoomSave = setTimeout(() => store.set('zoom.' + ui.activeVideo, { z: vz.z, fx: vz.x / vstage.clientWidth, fy: vz.y / vstage.clientHeight }), 300);
}
function zoomAt(factor, cx, cy) {
  const z2 = Math.max(1, Math.min(8, vz.z * factor));
  vz.x = cx - ((cx - vz.x) * z2) / vz.z;
  vz.y = cy - ((cy - vz.y) * z2) / vz.z;
  vz.z = z2;
  applyZoom();
}
function restoreZoom() {
  const z = ui.activeVideo && store.get('zoom.' + ui.activeVideo, null);
  Object.assign(vz, z ? { z: z.z, x: z.fx * vstage.clientWidth, y: z.fy * vstage.clientHeight } : { z: 1, x: 0, y: 0 });
  applyZoom();
}
vstage.addEventListener('wheel', e => {
  if (!video.src) return;
  e.preventDefault();
  const r = vstage.getBoundingClientRect();
  zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
let pan = null;
vstage.addEventListener('pointerdown', e => {
  if (vz.z <= 1.001) return;
  pan = { x: e.clientX, y: e.clientY, vx: vz.x, vy: vz.y };
  vstage.setPointerCapture(e.pointerId);
  vstage.classList.add('pan');
});
vstage.addEventListener('pointermove', e => {
  if (!pan) return;
  vz.x = pan.vx + e.clientX - pan.x; vz.y = pan.vy + e.clientY - pan.y;
  applyZoom();
});
vstage.addEventListener('pointerup', () => { pan = null; vstage.classList.remove('pan'); });
vstage.addEventListener('dblclick', () => { Object.assign(vz, { z: 1, x: 0, y: 0 }); applyZoom(); });
new ResizeObserver(() => applyZoom()).observe(vstage);

// Мини-карта: весь кадр и рамка видимой области.
function drawMini() {
  if (vz.z <= 1.001 || !video.videoWidth) return;
  const g = mini.getContext('2d'), W = vstage.clientWidth, H = vstage.clientHeight;
  const k = Math.min(mini.width / W, mini.height / H);
  const ox = (mini.width - W * k) / 2, oy = (mini.height - H * k) / 2;
  const vk = Math.min(W / video.videoWidth, H / video.videoHeight); // object-fit: contain
  const vw = video.videoWidth * vk, vh = video.videoHeight * vk;
  g.fillStyle = '#000'; g.fillRect(0, 0, mini.width, mini.height);
  g.drawImage(video, ox + ((W - vw) / 2) * k, oy + ((H - vh) / 2) * k, vw * k, vh * k);
  g.strokeStyle = '#fff'; g.lineWidth = 2;
  g.strokeRect(ox + (-vz.x / vz.z) * k, oy + (-vz.y / vz.z) * k, (W / vz.z) * k, (H / vz.z) * k);
}
setInterval(() => { if (!video.paused) drawMini(); }, 250);
video.addEventListener('seeked', drawMini);
mini.addEventListener('pointerdown', e => {
  const r = mini.getBoundingClientRect(), W = vstage.clientWidth, H = vstage.clientHeight;
  const k = Math.min(mini.width / W, mini.height / H);
  const ox = (mini.width - W * k) / 2, oy = (mini.height - H * k) / 2;
  const px = ((e.clientX - r.left) * (mini.width / r.width) - ox) / k, py = ((e.clientY - r.top) * (mini.height / r.height) - oy) / k;
  vz.x = W / 2 - px * vz.z; vz.y = H / 2 - py * vz.z;
  applyZoom();
});

// Плейлист клипов: каждое событие с запасом 4 с до и 2 с после.
const PRE = 4, POST = 2.5;
// Плейлист: отрезки { start, end, v, i? (событие), key? (розыгрыш) } — проигрываются подряд.
function startClips() {
  const items = eventRows().filter(r => r.ev.vt != null && r.ev.v === ui.activeVideo).map(r => ({ i: r.i, start: r.ev.vt - PRE, end: r.ev.vt + POST, v: r.ev.v }));
  playList(items);
}
function rallySegments() {
  return filteredRallies().filter(r => r.t0 != null && r.v).map(r => ({ key: r.key, start: Math.max(0, r.t0 - 2.5), end: r.t1 + 2.5, v: r.v }));
}
function playList(items) {
  if (!items.length) return;
  ui.playlist = { items, k: 0 };
  playItem(items[0]);
  render();
}
function playItem(it) {
  if (it.v && it.v !== ui.activeVideo && ui.videos.some(v => v.id === it.v)) openVideo(it.v);
  if (it.i != null) ui.edit = it.i;
  if (it.key) { ui.focusRally = it.key; ui.pickedRally = true; }
  seekTo(it.start);
  video.play().catch(() => {});
}
video.addEventListener('timeupdate', () => {
  const pl = ui.playlist;
  if (!pl) return;
  if (video.currentTime >= pl.items[pl.k].end) {
    pl.k++;
    if (pl.k >= pl.items.length) { ui.playlist = null; video.pause(); toast('Клипы закончились'); render(); return; }
    playItem(pl.items[pl.k]);
    render();
  }
});
video.addEventListener('loadedmetadata', () => {
  restoreZoom();
  const v = ui.videos.find(x => x.id === ui.activeVideo);
  if (v && !v.duration && video.duration) api('PATCH', `/api/videos/${v.id}`, { duration: video.duration }).then(nv => Object.assign(v, nv));
  paintTimeline(); paintHead();
});
video.addEventListener('play', paintHead);
video.addEventListener('pause', paintHead);
(function loop() { if (!video.paused || video.seeking) paintHead(); requestAnimationFrame(loop); })();
video.addEventListener('seeked', paintHead);

// Таймлайн: клик по метке — к событию, по дорожке — перемотка, можно тянуть.
const tl = $('timeline');
let scrubbing = false;
const scrubTo = e => {
  const r = $('tlTrack').getBoundingClientRect();
  seekTo(((e.clientX - r.left) / r.width) * (video.duration || 0));
};
tl.addEventListener('pointerdown', e => {
  const mk = e.target.closest('.mk');
  if (mk) { pickEvent(+mk.dataset.i); return; }
  scrubbing = true; tl.setPointerCapture(e.pointerId); scrubTo(e);
});
tl.addEventListener('pointermove', e => scrubbing && scrubTo(e));
tl.addEventListener('pointerup', () => (scrubbing = false));

function pickEvent(i) {
  ui.edit = ui.edit === i ? null : i;
  ui.editPoints = false;
  const ev = ui.match.events[i];
  if (ui.edit !== null && ev?.vt != null) {
    if (ev.v && ev.v !== ui.activeVideo && ui.videos.some(v => v.id === ev.v)) openVideo(ev.v);
    seekTo(ev.vt - 2);
  }
  ui.tab = 'events';
  render();
  document.querySelector('.ev.sel')?.scrollIntoView({ block: 'nearest' });
}
function updateEvent(i, patch) {
  const ev = { ...ui.match.events[i], ...patch };
  for (const k in ev) if (ev[k] === undefined) delete ev[k];
  call(async () => setMatch(await api('PUT', `/api/matches/${ui.match.id}/events/${i}`, ev)));
}

// ---------- Действия ----------
async function loadAll() {
  [ui.roster, ui.settings, ui.matches, ui.videos] = await Promise.all([api('GET', '/api/roster'), api('GET', '/api/settings'), api('GET', '/api/matches'), api('GET', '/api/videos')]);
  court.setKit(ui.settings.kit);
  ui.zones = zonesOf(ui.settings);
}
async function openMatch(id) {
  const match = await api('GET', `/api/matches/${id}`);
  if (!match || match.mode === 'quick') return;
  ui.insertAt = null; ui.edit = null; ui.sel = null; ui.pending = {}; ui.playlist = null;
  setMatch(match);
  const vid = store.get('video.' + id) ?? match.videos?.[0];
  if (vid && ui.videos.some(v => v.id === vid)) openVideo(vid);
  else { ui.activeVideo = null; video.removeAttribute('src'); video.load(); }
}

// Новый матч. Если открыто видео — сразу привязываем его: обычно матч создают, уже открыв запись игры.
async function createMatch(opponentId) {
  const fmtSel = $('fmt')?.value;
  if (fmtSel) ui.fmtSel = fmtSel;
  modal('');
  ui.insertAt = null; ui.edit = null; ui.sel = null; ui.pending = {}; ui.playlist = null;
  const format = pickFormat(ui.fmtSel ?? formatKey(ui.settings.lastFormat));
  ui.fmtSel = null;
  setMatch(await api('POST', '/api/matches', { opponentId, format }));
  ui.settings.lastFormat = format;
  ui.matches = await api('GET', '/api/matches');
  if (ui.activeVideo) { await linkVideo(ui.activeVideo); store.set('video.' + ui.match.id, ui.activeVideo); toast('Открытое видео привязано к новому матчу'); }
  recompute();
  openLineup();
}

const H = {
  tab: d => { ui.tab = d.tab; if (d.tab === 'video' && !ui.clips) api('GET', '/api/clips').then(c => { ui.clips = c; if (ui.tab === 'video') paintSide(); }).catch(() => {}); render(); },
  help: openHelp,
  tips: () => toast(tips.toggle() ? 'Подсказки включены: задержите курсор на кнопке — появится пояснение' : 'Подсказки выключены'),
  modalClose: () => { modal(''); ui.fEdit = null; ui.team = null; },
  modalBg: (d, e) => { if (e.target.classList.contains('modal-bg')) modal(''); },
  pickFile: () => $('fileInput').click(),
  view: d => { court.setView(d.v); document.querySelectorAll('[data-a=view]').forEach(b => b.classList.toggle('on', b.dataset.v === d.v)); },
  labelMode: () => {
    const order = ['num', 'name', 'full', 'none'], names = { num: 'номер', name: 'имя', full: 'как записан в составе', none: 'без подписи' };
    const m = order[(order.indexOf(store.get('labelMode', 'num')) + 1) % order.length];
    store.set('labelMode', m); court.setLabelMode(m); paintLabelBtn();
    toast('Над игроками: ' + names[m]);
  },
  detail: () => {
    const m = store.get('detail', 'real') === 'real' ? 'simple' : 'real';
    store.set('detail', m); court.setDetail(m); paintDetailBtn();
    toast(m === 'real' ? 'Игроки: реалистичные' : 'Игроки: простые (минималистичные)');
  },
  zones: (d, e) => { const on = court.toggleZones(); e.target.closest('button').classList.toggle('on', on); },
  // Кнопка пуска — «ручное» управление: на паузе видео само не поедет, пока не нажмёте снова.
  play: () => {
    ui.resumeAfter = false; stopFF();
    if (video.paused) { ui.manualPause = false; video.playbackRate = ui.sync ? ui.syncRate : ui.rate; video.play().catch(() => {}); }
    else { ui.manualPause = true; video.pause(); }
    paintSyncHud();
  },
  sync: () => setSync(!ui.sync),
  loopLen: d => { ui.loopLen = +d.v; store.set('loopLen', ui.loopLen); paintSyncUi(); },
  seek: d => seekTo(video.currentTime + Number(d.d)),
  frame: d => { video.pause(); seekTo(video.currentTime + Number(d.d) / 25); },
  vzoom: d => zoomAt(+d.d > 0 ? 1.25 : 0.8, vstage.clientWidth / 2, vstage.clientHeight / 2),
  speed: d => { setSpeed(Number(d.v)); closeSpeed(); },
  speedMenu: () => { const pop = $('speedPop'); if (pop.classList.contains('on')) return closeSpeed(); paintSpeed(); pop.classList.add('on'); },
  layout: d => setLayout(d.v),
  hintToggle: () => { store.set('hintOpen', !store.get('hintOpen', false)); paintHud(); },
  sel: d => { pauseForInput(); ui.sel = ui.sel === d.id ? null : d.id; render(); },
  group: d => { ui.group = d.g === mainGroup() ? null : d.g; render(); },
  act: d => sendAct(d.skill, d.res),
  tempo: d => { ui.tempo = d.v; ui.setH = TEMPOS[d.v].h; render(); },
  menuPick: d => menuPick(+d.k),
  scoutNum: d => { const k = d.w === 'srv' ? 'scoutSrv' : 'scoutAtt'; ui[k] = ui[k] === d.v ? null : d.v; paintBar(); },
  scoutAdd: d => {
    const n = prompt('Номер игрока соперника:')?.trim();
    if (!n) return;
    const o = oppOf(ui.match);
    if (!o) return;
    const numbers = [...new Set([...(o.numbers ?? []), n])].sort((a, b) => (+a || 99) - (+b || 99));
    ui[d.w === 'srv' ? 'scoutSrv' : 'scoutAtt'] = n;
    call(async () => { ui.settings = await api('PUT', '/api/settings', { opponents: ui.settings.opponents.map(x => (x.id === o.id ? { ...x, numbers } : x)) }); });
  },
  tourGo: d => startTour(+d.k),
  tourEnd: () => endTour(),
  tourStart: () => startTour(0),
  dataModal: () => call(openDataModal),
  settings: d => openSettings(d.tab),
  setTab: d => openSettings(d.v),
  setOpt: d => applyOpt(d.k, d.v),
  settingsClose: () => { modal(''); ui.dataView = null; },
  bkMake: () => call(async () => { const b = await api('POST', '/api/backups'); await openDataModal(); toast(`Копия сделана: матчей ${b.matches}`); }),
  bkDownload: () => call(async () => {
    const data = await api('GET', '/api/backup/file');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    a.download = `volleyball-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }),
  bkRestore: d => {
    if (!confirm('Восстановить данные из этой копии? Текущие данные сначала сохранятся отдельной копией, лишние матчи уйдут в корзину.')) return;
    call(async () => { const r = await api('POST', `/api/backups/${d.n}/restore`); await afterRestore(`Восстановлено: матчей ${r.matches}`); });
  },
  trRestore: d => call(async () => { const r = await api('POST', `/api/trash/${encodeURIComponent(d.f)}/restore`); if (r?.error) return toast(r.error, true); await afterRestore('Матч возвращён'); }),
  tourNew: () => {
    const name = prompt('Название турнира (например, «Кубок города, ноябрь»):');
    if (!name?.trim()) return;
    const t = { id: newId(), name: name.trim(), created: new Date().toISOString() };
    call(async () => {
      ui.settings = await api('PUT', '/api/settings', { tournaments: [...(ui.settings.tournaments ?? []), t], activeTournament: t.id });
      if (ui.match) setMatch(await api('PATCH', `/api/matches/${ui.match.id}`, { tournament: t.id }));
      toast(`Турнир «${t.name}» создан — новые матчи попадут в него`);
    });
  },
  tourActive: (d, e) => {
    e.preventDefault();
    const cur = ui.match?.tournament ?? '';
    const next = ui.settings.activeTournament === cur && cur ? '' : cur;
    call(async () => { ui.settings = await api('PUT', '/api/settings', { activeTournament: next || null }); });
  },
  timeout: d => { if (!live()) return; sendRaw({ t: 'timeout', side: d.side }); toast(`Тайм-аут ${d.side === 'us' ? 'наш' : 'соперника'} отмечен`); },
  statScope: d => { ui.statScope = d.v === 'all' ? 'all' : +d.v; paintSide(); },
  teamModal: () => openTeamModal(),
  embDel: d => { if (d.who === 'us') ui.team.emblem = null; else delete ui.team.opponents[+d.who].emblem; paintTeamModal(); },
  oppAdd: () => { ui.team.opponents.push({ id: newId(), name: '' }); paintTeamModal(); },
  oppDel: d => { const o = ui.team.opponents[+d.i]; if (o.name && !confirm(`Удалить соперника «${o.name}»? Его матчи останутся.`)) return; ui.team.opponents.splice(+d.i, 1); paintTeamModal(); },
  teamTab: d => { ui.team.tab = d.v; paintTeamModal(); },
  kitReset: () => { ui.team.kit = { ...KIT_DEFAULT }; paintTeamModal(); },
  plAdd: () => { ui.team.roster.push({ id: newId(), num: '', name: '', role: '', setter: false }); paintTeamModal(); setTimeout(() => document.querySelector('.trow.pl:last-of-type input[data-k=plName]')?.focus(), 30); },
  plActive: d => { const p = ui.team.roster[+d.i]; p.active = p.active === false ? true : false; paintTeamModal(); },
  plDel: d => { const p = ui.team.roster[+d.i]; if (p.name && !confirm(`Удалить игрока «${p.name}» из команды? В прошлых матчах он останется. Если он просто не играет сейчас — лучше «В запасе».`)) return; ui.team.roster.splice(+d.i, 1); paintTeamModal(); },
  teamSave: () => call(async () => {
    const t = ui.team;
    const opponents = t.opponents.filter(o => o.name.trim()).map(o => ({ ...o, name: o.name.trim() }));
    const roster = t.roster.filter(p => String(p.num).trim() || p.name.trim()).map(p => ({ ...p, num: p.num === '' ? '' : Number(p.num), name: p.name.trim(), role: roleOf(p), setter: roleOf(p) === 's' }));
    ui.roster = await api('PUT', '/api/roster', roster);
    ui.settings = await api('PUT', '/api/settings', { teamName: t.teamName.trim() || 'Мы', emblem: t.emblem, opponents, kit: t.kit });
    court.setKit(ui.settings.kit);
    ui.team = null; modal('');
    ui.matches = await api('GET', '/api/matches');
    if (ui.match) setMatch(await api('GET', `/api/matches/${ui.match.id}`));
    toast('Команда сохранена');
  }),
  rallyStar: d => { const r = rallyByKey(d.k); if (r) updateEvent(r.plays[0].i, { star: r.star ? undefined : true, ...(r.star && { note: undefined }) }); },
  rallyNote: d => { const r = rallyByKey(d.k); if (!r) return; const note = prompt('Заметка к моменту (например, «лучший блок»):', r.note); if (note !== null) updateEvent(r.plays[0].i, { note: note.trim() || undefined }); },
  rallyClips: () => playList(rallySegments()),
  exportClips: () => {
    const segs = rallySegments();
    if (!segs.length) return;
    const name = `${ui.settings.teamName} — ${ui.match.opponent}${ui.rFilter === 'star' ? ' лучшее' : ''}`;
    toast(`Готовлю нарезку из ${segs.length} розыгрышей… это может занять минуту`);
    call(async () => {
      const r = await api('POST', '/api/clips', { name, segments: segs.map(sg => ({ video: sg.v, start: +sg.start.toFixed(2), end: +sg.end.toFixed(2) })) });
      if (r.error) return toast(r.error, true);
      ui.clips = await api('GET', '/api/clips');
      toast(`Нарезка готова: ${r.file} — во вкладке «Видео»`);
    });
  },
  blockOff: () => { if (ui.draft) delete ui.draft.block; render(); },
  evView: d => { ui.evView = d.v; store.set('evView', d.v); paintSide(); },
  pickRally: d => pickRally(d.k),
  formEditor: () => openFormEditor(),
  fKind: d => { ui.fEdit.kind = d.v; ui.fEdit.defView = 'base'; goRot(ui.fEdit.rot); },
  fDefView: d => { ui.fEdit.defView = d.v; paintFormEditor(); },
  fRot: d => goRot(+d.v),
  fFront: () => {
    const f = ui.fEdit;
    if (!applyFrontRoles(f.kind, f.rot)) return toast('Нужен состав пресета с ролями игроков («Состав пресета» и роли в настройках)', true);
    (f.touched[f.kind] ??= {})[f.rot] = true; paintFormEditor();
  },
  fFrontAll: () => {
    const f = ui.fEdit;
    let ok = false;
    for (const r of GAME_ORDER) if (applyFrontRoles(f.kind, r)) { ok = true; (f.touched[f.kind] ??= {})[r] = true; }
    if (!ok) return toast('Нужен состав пресета с ролями игроков', true);
    toast(`Передняя линия по ролям — во всех расстановках («${SITUATIONS[f.kind]}»)`); paintFormEditor();
  },
  fCopyFrom: () => {
    const f = ui.fEdit, sk = f.srcKind ?? f.kind, sr = f.srcRot ?? f.rot;
    if (sk === f.kind && sr === f.rot) return toast('Выберите другую ситуацию или расстановку');
    f.data[f.kind][f.rot] = JSON.parse(JSON.stringify(f.data[sk][sr]));
    (f.touched[f.kind] ??= {})[f.rot] = true;
    toast(`Скопировано из «${SITUATIONS[sk]}» Р${sr} — поправьте, что отличается`); paintFormEditor();
  },
  fProto: () => {
    const f = ui.fEdit;
    f.data[f.kind][f.rot] = Object.fromEntries([1, 2, 3, 4, 5, 6].map(z => [z, { ...ZONE_SPOT[z] }]));
    (f.touched[f.kind] ??= {})[f.rot] = true;
    paintFormEditor();
  },
  fNew: () => {
    const f = ui.fEdit, src = editPreset();
    const nm = prompt('Название нового пресета (например, «4-2 турнир»):', src.name + ' — копия');
    if (!nm?.trim()) return;
    const copy = JSON.parse(JSON.stringify(src));
    Object.assign(copy, { id: newId(), name: nm.trim() });
    f.works.push(copy); f.presetId = copy.id; bindPreset(); paintFormEditor();
  },
  fRename: () => { const w = editPreset(); const nm = prompt('Название пресета:', w.name); if (nm?.trim()) { w.name = nm.trim(); paintFormEditor(); } },
  fDel: () => {
    const f = ui.fEdit, w = editPreset();
    if (!confirm(`Удалить пресет «${w.name}»?`)) return;
    f.works = f.works.filter(x => x !== w); f.presetId = f.works[0].id; bindPreset(); paintFormEditor();
  },
  fRoster: () => { ui.fEdit.showRoster = !ui.fEdit.showRoster; paintFormEditor(); },
  fTakeLineup: () => {
    const set = ui.st?.sets.at(-1);
    if (!set) return;
    editPreset().lineup = { start: [...set.start], main: set.main };
    toast('Стартовый состав пресета — из этого матча'); paintFormEditor();
  },
  fStep: d => goRot(+d.d > 0 ? nextRot(ui.fEdit.rot) : prevRot(ui.fEdit.rot)),
  fReset: () => {
    const f = ui.fEdit;
    f.data[f.kind][f.rot] = Object.fromEntries([1, 2, 3, 4, 5, 6].map(z => [z, { ...defaultSpot(f.kind, f.rot, z) }]));
    if (f.touched[f.kind]) delete f.touched[f.kind][f.rot];
    if (f.inherited[f.kind]) delete f.inherited[f.kind][f.rot];
    paintFormEditor();
  },
  fCopy: () => {
    const f = ui.fEdit, src = f.data[f.kind][f.rot];
    if (!confirm(`Поставить «${SITUATIONS[f.kind]}» во всех расстановках как в Р${f.rot}? Позиции считаются по зонам.`)) return;
    for (let r = 1; r <= 6; r++) { f.data[f.kind][r] = JSON.parse(JSON.stringify(src)); (f.touched[f.kind] ??= {})[r] = true; }
    paintFormEditor();
  },
  fSave: () => call(async () => {
    // Унаследованные (сдвинутые) расстановки тоже сохраняем как настроенные — это то, что вы видели.
    const f = ui.fEdit;
    const list = f.works.map(w => {
      for (const k in w.inherited) for (const r in w.inherited[k]) (w.touched[k] ??= {})[r] = true;
      return { id: w.id, name: w.name, system: w.system, rules: w.rules ?? 'strict', ...(w.lineup && { lineup: w.lineup }), formations: { ...w.data, touched: w.touched } };
    });
    ui.settings = await api('PUT', '/api/settings', { presets: list, activePreset: f.presetId });
    // Открытый матч переходит на выбранный пресет (и его схему).
    if (ui.match && ui.match.preset !== f.presetId) setMatch(await api('PATCH', `/api/matches/${ui.match.id}`, { preset: f.presetId, system: editPreset().system }));
    ui.fEdit = null;
    modal('');
    recompute();
    toast('Расстановки сохранены — игроки на площадке встают по ним');
  }),
  cancelStep: () => { closeMenu(); ui.draft = ui.draft?.await ? ui.draft.await.prev : null; ui.setH = null; render(); },
  confirmSuggest: () => { const c = ctx(); if (c?.stage === 'await') confirmPlayer(c, ui.hoverPid ?? c.suggest); },
  setQ: d => setQuality(d.v),
  ballDown: () => ballDown(),
  netErr: () => { const c = ctx(); if (baseStage(c) === 'att') { ui.draft = null; postAct({ skill: 'att', res: 'error', p: c.p, from: c.from }); } },
  history: () => { ui.history = !ui.history; $('historyBtn').classList.toggle('on', ui.history); paintCourt(); },
  zBrush: d => { ui.zEdit.brush = +d.g; document.querySelectorAll('.zbrush').forEach(b => b.classList.toggle('on', b.dataset.g === d.g)); },
  zReset: () => { ui.zEdit.z = [...defaultZones()]; paintZones(); },
  zSave: () => call(async () => {
    ui.settings = await api('PUT', '/api/settings', { qualityZones: ui.zEdit.z.join('') });
    ui.zones = zonesOf(ui.settings);
    modal('');
    toast('Зоны доводки сохранены — оценка приёма считается по ним');
  }),
  zonesEditor: () => openZonesEditor(),
  clearPt: d => { delete ui.pending[d.k]; render(); },
  flip: () => sendRaw({ t: 'act', skill: 'team', res: ['serve', 'ours'].includes(ui.st.rally.phase) ? 'over' : 'back', p: null }),
  pt: d => sendRaw({ t: 'pt', side: d.side }),
  undo,
  sub: () => { ui.sub = ui.sub ? null : { out: null }; ui.sel = null; render(); },
  subOut: d => { ui.sub.out = d.id; render(); },
  subIn: d => { const out = ui.sub.out; ui.sub = null; sendRaw({ t: 'sub', out, in: d.id }); },
  lineup: openLineup,
  lpick: d => {
    ui.lineupDraft.fromRot = null;
    const o = ui.lineupDraft.order, k = o.indexOf(d.id);
    if (k >= 0) o.splice(k, 1); else if (o.length < 6) o.push(d.id);
    paintLineup();
  },
  lserve: d => {
    const ld = ui.lineupDraft;
    ld.weServe = d.v === '1';
    if (ld.fromRot) Object.assign(ld, lineupFromPreset(ld.fromRot, ld.weServe)); // кто подаёт — меняет порядок, но не расстановку
    paintLineup();
  },
  ltarget: d => { ui.lineupDraft.target = d.v ? +d.v : null; paintLineup(); },
  lrot: d => { const ld = ui.lineupDraft; ld.fromRot = +d.v; Object.assign(ld, lineupFromPreset(ld.fromRot, ld.weServe)); paintLineup(); },
  lstart: () => {
    const d = ui.lineupDraft;
    const setter = d.order.includes(d.setter) ? d.setter : d.order.find(id => person(id).setter) ?? null;
    modal('');
    sendRaw({ t: 'set', lineup: d.order, weServe: d.weServe, ...(setter && { setter }), ...(d.target && { target: d.target }) });
  },
  newMatch: openNewMatch,
  createMatch: d => call(() => createMatch(d.id)),
  createNewOpp: () => {
    const nm = $('newOpp').value.trim();
    if (!nm) return;
    const same = ui.settings.opponents.find(o => o.name.trim().toLowerCase() === nm.toLowerCase());
    if (same) return H.createMatch({ id: same.id });
    const opp = { id: newId(), name: nm };
    call(async () => {
      ui.settings = await api('PUT', '/api/settings', { opponents: [...ui.settings.opponents, opp] });
      await createMatch(opp.id);
    });
  },
  open: d => call(() => openMatch(d.id)),
  openVideo: d => openVideo(d.id),
  linkVideo: d => call(() => linkVideo(d.id)),
  unlinkVideo: d => call(async () => setMatch(await api('PATCH', `/api/matches/${ui.match.id}`, { videos: ui.match.videos.filter(x => x !== d.id) }))),
  delVideo: d => {
    const v = ui.videos.find(x => x.id === d.id);
    if (!confirm(`Удалить «${v.name}» из библиотеки? Файл переедет в data/trash/videos.`)) return;
    call(async () => { await api('DELETE', `/api/videos/${d.id}`); ui.videos = await api('GET', '/api/videos'); if (ui.activeVideo === d.id) { ui.activeVideo = null; video.removeAttribute('src'); video.load(); } });
  },
  pickEv: (d, e) => { if (e.target.closest('.editor')) return; pickEvent(+d.i); },
  evTime: () => updateEvent(ui.edit, { v: ui.activeVideo, vt: +video.currentTime.toFixed(2) }),
  evPoints: () => { ui.editPoints = !ui.editPoints; render(); },
  evClearPts: () => updateEvent(ui.edit, { to: undefined, from: undefined }),
  // Быстрое удаление без вопросов — с кнопкой «Вернуть» во всплывающей подсказке.
  evDelQuick: d => deleteEvents([+d.i]),
  rallyDel: d => { const r = rallyByKey(d.k); if (r) deleteEvents(r.plays.map(p => p.i)); },
  matchDel: d => {
    const x = ui.matches.find(m => m.id === d.id);
    if (!confirm(`Удалить матч с «${x.opponent}» (${new Date(x.created).toLocaleDateString('ru')})? Файл переедет в data/trash.`)) return;
    call(async () => {
      await api('DELETE', `/api/matches/${d.id}`);
      ui.matches = await api('GET', '/api/matches');
      if (ui.match?.id === d.id) { ui.match = null; ui.full = ui.st = null; history.replaceState(null, '', location.pathname); }
      toast('Матч удалён (лежит в data/trash)');
    });
  },
  evDel: d => {
    if (!confirm(`Удалить событие №${+d.i + 1}? Счёт и статистика пересчитаются.`)) return;
    const i = +d.i;
    ui.edit = null;
    call(async () => { setMatch(await api('DELETE', `/api/matches/${ui.match.id}/events/${i}`)); if (ui.insertAt !== null && ui.insertAt > i) { ui.insertAt--; recompute(); } });
  },
  insertHere: d => { ui.insertAt = +d.i; ui.edit = null; ui.editPoints = false; recompute(); render(); toast('Режим вставки: вносите пропущенные касания'); },
  insertOff: () => { ui.insertAt = null; recompute(); render(); },
  clips: startClips,
  stopClips: () => { ui.playlist = null; video.pause(); render(); },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-a]');
  if (!el || el.disabled) return;
  const fn = H[el.dataset.a];
  // Кнопка не держит фокус — иначе пробел «нажимает» её второй раз вместе с горячей клавишей.
  if (el.tagName === 'BUTTON') el.blur();
  if (fn) fn(el.dataset, e);
});
document.addEventListener('change', e => {
  const k = e.target.dataset.k;
  if (!k) return;
  const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  if (k === 'fskill') { ui.filter.skill = v; render(); }
  if (k === 'optTips' && v !== tips.on) { tips.toggle(); }
  if (k === 'optStart') store.set('startScreen', v);
  if (k === 'optAutoPause') { $('autoPause').checked = v; store.set('autoPause', v); }
  if (k === 'optZones') { store.set('zonesOn', v); court.toggleZones(v); document.querySelector('[data-a=zones]')?.classList.toggle('on', v); }
  if (k === 'rFilter') { ui.rFilter = v; paintSide(); }
  if (k === 'bkFile' && e.target.files[0]) {
    const f = e.target.files[0];
    if (!confirm(`Восстановить всё из файла «${f.name}»? Текущие данные сначала сохранятся отдельной копией.`)) return;
    f.text().then(t => call(async () => {
      let data; try { data = JSON.parse(t); } catch { return toast('Файл не читается — это не копия', true); }
      const r = await api('POST', '/api/backup/file', data);
      if (r.error) return toast(r.error, true);
      await afterRestore(`Восстановлено из файла: матчей ${r.matches}`);
    }));
  }
  if (k === 'plRole' && ui.team) { const p = ui.team.roster[+e.target.dataset.i]; p.role = v; p.setter = v === 's'; }
  if (k === 'matchRole') {
    const roles = { ...(ui.match.roles ?? {}), [e.target.dataset.id]: v };
    call(async () => { setMatch(await api('PATCH', `/api/matches/${ui.match.id}`, { roles })); toast(v ? 'Роль на этот матч изменена — статистика и расстановки пересчитаны' : 'Роль — как в команде'); });
  }
  if (k === 'embFile' && e.target.files[0]) {
    const who = e.target.dataset.who;
    fileToEmblem(e.target.files[0]).then(src => { if (who === 'us') ui.team.emblem = src; else ui.team.opponents[+who].emblem = src; paintTeamModal(); }).catch(err => toast(err.message, true));
  }
  if (k === 'fp') { ui.filter.p = v; render(); }
  if (k === 'system') call(async () => setMatch(await api('PATCH', `/api/matches/${ui.match.id}`, { system: v })));
  if (k === 'trackSets') { ui.trackSets = v; store.set('trackSets', v); render(); }
  if (k === 'lsetter') ui.lineupDraft.setter = v;
  if (k === 'fPreset') { ui.fEdit.presetId = v; bindPreset(); paintFormEditor(); }
  if (k === 'fSystem') { editPreset().system = v; }
  if (k === 'fRules') { editPreset().rules = v; paintFormEditor(); }
  if (k === 'fSrcKind') ui.fEdit.srcKind = v;
  if (k === 'fSrcRot') ui.fEdit.srcRot = +v;
  if (k === 'fSlot') {
    // Игрок уже стоит в другой зоне — меняем их местами.
    const lu = ensurePresetLineup(), sl = +e.target.dataset.slot, other = lu.start.indexOf(v);
    if (other >= 0 && other !== sl) lu.start[other] = lu.start[sl];
    lu.start[sl] = v;
    if (!lu.start.includes(lu.main)) lu.main = v;
    paintFormEditor();
  }
  if (k === 'fMain') {
    // Связующий — по нему нумеруются расстановки; меняем, сохраняя, кто в какой зоне текущей Р стоит.
    const f = ui.fEdit, lu = ensurePresetLineup();
    const oldMs = Math.max(0, lu.start.indexOf(lu.main));
    const zoneOf = {}; lu.start.forEach((id, s) => (zoneOf[id] = slotZone(s, f.rot, oldMs)));
    lu.main = v;
    f.rot = zoneOf[v]; // та же картина на площадке — теперь это Р по зоне нового связующего
    paintFormEditor();
  }
  if (k === 'matchScout') call(async () => { setMatch(await api('PATCH', `/api/matches/${ui.match.id}`, { scout: v })); toast(v ? 'Скаутинг включён: под площадкой — номера подающего и бьющего соперника' : 'Скаутинг выключен'); });
  if (k === 'matchTour') call(async () => setMatch(await api('PATCH', `/api/matches/${ui.match.id}`, { tournament: v })));
  if (k === 'matchFormat') { const format = pickFormat(v); call(async () => setMatch(await api('PATCH', `/api/matches/${ui.match.id}`, { format }))); }
  if (k === 'matchPreset') { const pr = presetById(v); call(async () => setMatch(await api('PATCH', `/api/matches/${ui.match.id}`, { preset: v, system: pr.system || ui.match.system }))); }
  if (k === 'eres') updateEvent(ui.edit, { res: v });
  if (k === 'ep') updateEvent(ui.edit, { p: v || null });
  if (k === 'etempo') updateEvent(ui.edit, { tempo: v });
});
document.addEventListener('input', e => {
  if (ui.team && e.target.dataset.k === 'teamName') ui.team.teamName = e.target.value;
  if (ui.team && e.target.dataset.k === 'kitColor') { ui.team.kit[e.target.dataset.key] = e.target.value; document.querySelector('.kitprev').innerHTML = kitPreview(ui.team.kit); }
  if (ui.team && e.target.dataset.k === 'oppName') ui.team.opponents[+e.target.dataset.i].name = e.target.value;
  if (ui.team && e.target.dataset.k === 'plName') ui.team.roster[+e.target.dataset.i].name = e.target.value;
  if (ui.team && e.target.dataset.k === 'plNum') ui.team.roster[+e.target.dataset.i].num = e.target.value;
  if (e.target.dataset.k === 'setH') {
    ui.setH = Number(e.target.value);
    e.target.previousElementSibling.querySelector('b').textContent = ui.setH.toFixed(1) + ' м';
    paintPreview();
  }
});

// ---------- Клавиатура ----------
const CODE_LETTER = { KeyA: 'A', KeyS: 'S', KeyD: 'D', KeyF: 'F', KeyG: 'G', KeyH: 'H', KeyQ: 'Q', KeyW: 'W', KeyE: 'E', KeyR: 'R', KeyT: 'T', KeyY: 'Y' };
document.addEventListener('keydown', e => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'range' || tag === 'SELECT' || tag === 'TEXTAREA') {
    if (e.key === 'Enter' && e.target.id === 'newOpp') H.createNewOpp();
    return;
  }
  if (ui.tour != null) {
    if (e.key === 'Escape') endTour();
    if (e.key === 'ArrowRight' || e.key === 'Enter') ui.tour < TOUR.length - 1 ? startTour(ui.tour + 1) : endTour();
    if (e.key === 'ArrowLeft' && ui.tour > 0) startTour(ui.tour - 1);
    e.preventDefault();
    return;
  }
  if (modalOpen()) {
    if (e.key === 'Escape') { modal(''); ui.fEdit = null; }
    if (e.key === 'Enter' && ui.lineupDraft?.order.length === 6 && $('modal').querySelector('[data-a=lstart]')) H.lstart();
    return;
  }
  if (e.ctrlKey || e.metaKey) { if (e.code === 'KeyZ') { e.preventDefault(); undo(); } if (e.code === 'Comma') { e.preventDefault(); openSettings(); } return; }
  const c = e.code;
  if (c === 'BracketLeft' || c === 'BracketRight') { stepSpeed(c === 'BracketLeft' ? -1 : 1); return; }
  if (c === 'Escape' && $('speedPop').classList.contains('on')) { closeSpeed(); return; }
  if (c === 'Space') {
    e.preventDefault();
    if (e.repeat) return;
    // В синхронизации пробел — стоп-кадр на касании: после следующего шага видео поедет само.
    if (ui.sync && video.src) {
      if (ui.ff) { stopFF(); video.pause(); }
      else if (video.paused) { ui.manualPause = false; video.playbackRate = ui.syncRate; video.play().catch(() => {}); }
      else { ui.manualPause = false; video.pause(); }
      paintSyncHud();
      return;
    }
    H.play(); return;
  }
  if (c === 'Tab' && video.src) { e.preventDefault(); toggleFF(); return; }
  if (c === 'PageUp' || c === 'PageDown') { e.preventDefault(); stepRally(c === 'PageUp' ? -1 : 1); return; }
  if (c === 'KeyL' && !e.shiftKey) { setSync(!ui.sync); return; }
  if (c === 'ArrowLeft' || c === 'ArrowRight') { e.preventDefault(); seekTo(video.currentTime + (c === 'ArrowLeft' ? -1 : 1) * ui.seekStep * (e.shiftKey ? 3 : 1)); return; }
  if (c === 'Comma' || c === 'Period') { H.frame({ d: c === 'Comma' ? -1 : 1 }); return; }
  // Esc: сначала меню, потом незаконченный шаг, потом выбор/правка.
  if (c === 'Escape') {
    if (ui.menu) { closeMenu(); return; }
    if (ui.draft) { H.cancelStep(); return; }
    ui.sel = null; ui.group = null; ui.edit = null; ui.editPoints = false; ui.sub = null; render(); return;
  }
  if (c === 'Backspace' || c === 'Delete') { e.preventDefault(); undo(); return; }
  if (c === 'KeyV') { const order = ['split', 'video', 'court']; setLayout(order[(order.indexOf($('viewport').dataset.layout) + 1) % 3]); return; }
  if (e.key === '?' || (c === 'Slash' && e.shiftKey)) { openHelp(); return; }
  if (!live()) return;
  if (ui.menu) { const d = /^(Digit|Numpad)([1-9])$/.exec(c); if (d) { menuPick(+d[2] - 1); return; } if (c === 'Enter') { menuPick(0); return; } }
  const cx = ctx();
  // X — мяч упал: не принял / не поднял (с игроком из отмеченного касания) или эйс/атака соперника без касания.
  if (c === 'KeyX') { ballDown(); return; }
  if (c === 'Enter' && cx?.stage === 'await') { H.confirmSuggest(); return; }
  // На шаге паса Q/W/E — качество паса (уйдёт вместе с точкой), R — ошибка паса сразу.
  if (baseStage(cx) === 'set' && ['KeyQ', 'KeyW', 'KeyE'].includes(c)) {
    const q = { KeyQ: 'perfect', KeyW: 'good', KeyE: 'poor' }[c];
    if (cx.stage === 'await') { cx.set.q = q; ui.draft.await.set.q = q; render(); } else setQuality(q);
    return;
  }
  if (baseStage(cx) === 'att' && c === 'KeyN') { H.netErr(); return; }
  const digit = /^(Digit|Numpad)([1-6])$/.exec(c);
  if (digit) {
    const z = Number(digit[2]);
    const id = ui.st.set.lineup[ui.st.rally.zones.indexOf(z)];
    if (ui.sub) { if (!ui.sub.out) H.subOut({ id }); return; }
    if (cx && cx.stage !== 'serve') { onCourtPick(posOf(id), { button: 0 }, { player: id }); return; }
    H.sel({ id });
    return;
  }
  if (c === 'Equal' || c === 'NumpadAdd') { sendAct('team', 'oppError'); return; }
  if (c === 'Minus' || c === 'NumpadSubtract') { sendAct('team', ui.st.rally.phase === 'rec' ? 'oppAce' : 'oppKill'); return; }
  if (c === 'KeyZ') { const ks = Object.keys(TEMPOS); ui.tempo = ks[(ks.indexOf(tempoOfH(curH())) + 1) % ks.length]; ui.setH = null; render(); return; }
  const L = CODE_LETTER[c];
  if (!L) return;
  const gk = Object.entries(GROUPS).find(([, g]) => g.key === L);
  if (gk) { H.group({ g: gk[0] }); return; }
  const k = ACT_KEYS.indexOf(L);
  const a = GROUPS[group()].acts[k];
  if (a) sendAct(a[0], a[1]);
});

// ---------- Раскладка, разделитель, перетаскивание файлов ----------
function setLayout(v) {
  $('viewport').dataset.layout = v;
  document.querySelectorAll('[data-a=layout]').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  store.set('layout', v);
}
const splitter = $('splitter');
splitter.addEventListener('pointerdown', e => {
  splitter.setPointerCapture(e.pointerId); splitter.classList.add('drag');
  const move = ev => {
    const r = $('viewport').getBoundingClientRect();
    const pct = Math.max(25, Math.min(80, ((ev.clientX - r.left) / r.width) * 100));
    $('viewport').style.setProperty('--split', pct + '%');
    store.set('split', pct);
  };
  const up = () => { splitter.classList.remove('drag'); splitter.removeEventListener('pointermove', move); splitter.removeEventListener('pointerup', up); };
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', up);
});

let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('dropVeil').classList.add('on'); });
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropVeil').classList.remove('on'); } });
addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('dropVeil').classList.remove('on');
  uploadFiles([...e.dataTransfer.files]);
});
$('fileInput').addEventListener('change', e => { uploadFiles([...e.target.files]); e.target.value = ''; });

// Для отладки из консоли браузера: studio.ui, studio.court.
window.studio = { ui, court, rallies, ballKeys, ballAt, replayPlayers, repaint: () => paintPlayers() };

// ---------- Старт ----------
setLayout(store.get('layout', 'split'));
paintSyncUi();
paintSpeed();
$('viewport').style.setProperty('--split', store.get('split', 58) + '%');
call(async () => {
  await loadAll();
  const id = location.hash.match(/m=([a-z0-9]+)/)?.[1] ?? store.get('lastMatch', null) ?? ui.matches[0]?.id;
  pollVideos();
  if (!store.get('tourDone', false)) setTimeout(() => startTour(0), 900);
  if (id && ui.matches.some(m => m.id === id)) {
    await openMatch(id);
    // Ссылка на конкретный розыгрыш (из отчёта игрока): #m=…&r=партия:розыгрыш.
    const rk = location.hash.match(/r=(\d+:\d+)/)?.[1];
    if (rk) setTimeout(() => { ui.tab = 'events'; ui.evView = 'rallies'; pickRally(rk); }, 300);
  }
  else ui.tab = 'match';
});
// Дашборд и телефон могут менять данные — подтягиваем список матчей, когда окно снова в фокусе.
addEventListener('focus', () => { if (!ui.busy) loadAll().then(() => ui.match && api('GET', `/api/matches/${ui.match.id}`)).then(m => { if (m) setMatch(m); render(); }).catch(() => {}); });

// Ссылка на другой матч или розыгрыш в уже открытой студии (#m=…&r=…) — открываем без перезагрузки.
addEventListener('hashchange', () => {
  const id = location.hash.match(/m=([a-z0-9]+)/)?.[1];
  const rk = location.hash.match(/r=(\d+:\d+)/)?.[1];
  if (!id) return;
  call(async () => {
    if (ui.match?.id !== id) await openMatch(id);
    if (rk) { ui.tab = 'events'; ui.evView = 'rallies'; pickRally(rk); }
  });
});
