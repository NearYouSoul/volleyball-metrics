// Студия — десктопная программа для разбора матча по видео и детальной статистики.
// Состояние матча, как и везде, вычисляет engine.js из списка событий на сервере;
// здесь — только интерфейс: видео, 3D-площадка, ввод касаний, правка и вставка событий.
import { replay, playerName, LABELS, ACTIONS, SKILLS, setTitle, setTarget, formatOptions, formatKey, pickFormat, formatName, formatOf } from '../engine.js';
import { ZONE_SPOT, DEFAULT_SPOT, TEMPOS, SYSTEMS, guessSetter, zoneOf, SET_DIRS, setDir, NET, ROLES, roleOf, zoneOfSlot, slotZones } from '../court.js';
import { createCourt3D } from './court3d.js';
import { gradeAt, digRes, zonesOf, defaultZones, GRADES, COLS, ROWS, CELL } from '../quality.js';
import { SITUATIONS, spotFor, tableFor, defaultSpot, ATTACK, SETTER_SPOT, defenseLayout, blockSide, overlapIssues, attackByRole } from '../formations.js';

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
  draft: null, moved: {}, movedKey: '', acts: {}, mouse: null, setH: null, menu: null, zones: null,
  sync: store.get('sync', false), syncRate: store.get('syncRate', 0.75), loopLen: store.get('loopLen', 5), anchor: null, loops: 0, ff: false, rate: 1, manualPause: false,
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
  rec: { label: 'Приём', icon: 's-rec', key: 'S', acts: [['rec', 'pp', '++ идеально', 'g'], ['rec', 'pm', '+− средне', 'y'], ['rec', 'p', '+ плохо', 'n'], ['rec', 'over', 'Перекид', 'y'], ['rec', 'error', 'Не принял', 'r']] },
  set: { label: 'Пас', icon: 's-set', key: 'D', acts: [['set', 'perfect', 'Идеальный', 'g'], ['set', 'good', 'Хороший', 'n'], ['set', 'poor', 'Неудобный', 'y'], ['set', 'error', 'Ошибка паса', 'r']] },
  att: { label: 'Атака', icon: 's-att', key: 'F', acts: [['att', 'kill', 'Забил', 'g'], ['att', 'bo', 'От блока', 'g'], ['att', 'play', 'В игре', 'n'], ['att', 'error', 'Аут / сетка', 'r'], ['att', 'blocked', 'Заблокир.', 'r']] },
  def: { label: 'Защита и блок', icon: 's-dig', key: 'G', acts: [['dig', 'plus', 'Защита +', 'n'], ['dig', 'minus', 'Защита −', 'y'], ['dig', 'error', 'Не поднял', 'r'], ['blk', 'point', 'Блок: очко', 'g'], ['blk', 'touch', 'Касание блоком', 'y'], ['blk', 'out', 'Блок-аут', 'r']] },
  fault: { label: 'Ошибка', icon: 's-fault', key: 'H', acts: [['fault', 'error', 'Сетка / заступ / касания', 'r']] },
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
  if (skill === 'set' && c?.stage === 'set' && res !== 'error') { setQuality(res); return; }
  const p = actor(skill);
  if (!p && skill !== 'team') return toast('Выберите игрока: клик по фишке на площадке или клавиши 1–6 (номер зоны)', true);
  const ev = stamp({ t: 'act', skill, res, p: skill === 'team' ? null : p });
  const t = ui.draft?.touch;
  if (t && (skill === t.kind || (t.kind === 'dig' && skill === 'blk'))) { ev.p = ui.sel ?? t.p; ev.to = t.at; if (t.from) ev.from = t.from; }
  if (skill === 'set' && c?.stage === 'set') { ev.p = ui.sel ?? c.p; ev.from = c.from; }
  if (skill === 'att' && c?.stage === 'att') { ev.p = ui.sel ?? c.p; ev.from = c.from; }
  if (skill === 'set') { ev.tempo = tempoOfH(curH()); ev.h = curH(); }
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

function postAct(ev) {
  if (ev.p && ACT_OF[ev.skill] && ev.skill !== 'rec' && ev.skill !== 'dig' && ev.skill !== 'set') doAct(ev.p, ACT_OF[ev.skill]);
  postEvent(stamp({ t: 'act', ...ev }));
}
function moveTo(id, p) { if (id && p) ui.moved[id] = { x: p.x, y: p.y }; }
// Движение игрока на 3D: приём, пас, удар, блок, подача.
const ACT_OF = { rec: 'rec', dig: 'dig', set: 'set', att: 'att', blk: 'blk', serve: 'serve' };
function doAct(id, type) { if (id && type) ui.acts[id] = { type, key: Math.random() }; }

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
    doAct(id, a.touchKind);
    moveTo(id, a.point);
    syncStep(a.t ?? curT());
  } else if (a.kind === 'setter') {
    const t = a.touch;
    ui.draft = null;
    postAct({ skill: t.kind, res: a.res, p: t.p, to: t.at, ...(t.from && { from: t.from }), ...(t.t != null && { vt: t.t }) });
    ui.draft = { set: { p: id, from: a.point, q: 'good', t: a.t ?? curT() } };
    setTimeout(() => { doAct(id, 'set'); paintPlayers(); }, 350); // связующий добегает и пасует
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
      if (p.y >= NET) return attackLanding(p, right, { p: c.p, from: c.from }); // скидка вторым касанием
      return awaitPlayer('attacker', p, attackerFor(p, c.p), { set: c });
    }
    case 'att': {
      if (hit?.hands === 'them') return blockMenu(p, c);
      if (p.y < NET) return openMenu(p, 0, [
        ['Атака в сетку', 'r', () => postAct({ skill: 'att', res: 'error', p: c.p, from: c.from, to: p })],
        ['Четыре касания', 'r', () => postAct({ skill: 'fault', res: 'error', p: c.p })],
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
  const CROSS = new Set(['serve.in', 'serve.good', 'att.play', 'rec.over', 'dig.over', 'blk.touch', 'team.over']);
  let k = -1;
  rp.forEach((p, i) => { if (CROSS.has(`${p.skill}.${p.res}`)) k = i; });
  return k >= 0 && baseStage(ctx()) === 'their' ? [] : rp.slice(k + 1);
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
  court.setPlayers(st.set.lineup.map(id => {
    const p = person(id);
    return { id, act: ui.acts[id], label: p.num || (p.name || '?').slice(0, 2), spot: posOf(id), setter: id === gs, selected: ui.sel === id || id === actorId, server: st.rally.phase === 'serve' && st.rally.server === id, hl: id === pulse, pinned: !!ui.moved[id] };
  }));
}

function paintCourt() {
  const c = ctx();
  // Новый розыгрыш или мяч ушёл к сопернику — игроки возвращаются в расстановку.
  // Сколько раз мяч перешёл на их сторону в этом розыгрыше: при каждом переходе игроки заново встают в расстановку.
  const CROSS = new Set(['serve.in', 'serve.good', 'att.play', 'rec.over', 'dig.over', 'blk.touch', 'team.over']);
  const key = `${rallyKey()}:${rallyPlays().filter(p => CROSS.has(`${p.skill}.${p.res}`)).length}`;
  if (key !== ui.movedKey) { ui.moved = {}; ui.movedKey = key; if (ui.draft && !ui.draft.touch && !ui.draft.set && !ui.draft.att && !ui.draft.origin && !ui.draft.await) ui.draft = null; }
  if (ui.rallyKeySeen !== rallyKey()) { ui.rallyKeySeen = rallyKey(); if (!ui.draft?.set && !ui.draft?.touch) ui.draft = null; }
  paintPlayers();
  const edit = ui.editPoints && ui.edit !== null ? ui.match.events[ui.edit] : null;
  const a = c?.stage === 'await' ? c : null;
  court.setPending(edit ? { from: edit.from, to: edit.to } : a ? { to: a.point } : c?.stage === 'their' && c.origin ? { from: c.origin } : {});
  court.setTrails(trailsFor(focusPlays()));
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
  if (['touch2', 'rec', 'their', 'free'].includes(st)) parts.push(btn('ballDown', st === 'rec' && !ui.draft?.touch ? 'Эйс соперника' : 'Мяч упал', 'r', '', 'X'));
  if (st === 'att') parts.push(btn('netErr', 'Сетка', 'r', '', 'N'));
  if (st === 'their') parts.push(btn('act', 'Ошибка соперника', 'g', 'data-skill="team" data-res="oppError"', '+'), ...(c.block ? [btn('blockOff', 'Без блока')] : []));
  parts.push('<span class="grow"></span>', btn('pt', '+1', 'g opt', 'data-side="us" title="Очко нам без статистики"'), btn('pt', '+1', 'r opt', 'data-side="them" title="Очко им без статистики"'), btn('flip', icon('i-swap'), 'opt', 'title="Мяч на другой стороне (если программа ошиблась)"'));
  el.innerHTML = parts.join('');
}

// ---------- Отрисовка ----------
function paintTop() {
  const m = ui.match, st = ui.st;
  document.querySelector('.top-actions .btn-chip').href = m ? `stats.html#m=${m.id}` : 'stats.html';
  $('matchPick').innerHTML = m ? `<b>${esc(ui.settings.teamName)} — ${esc(m.opponent)}</b> · ${new Date(m.created).toLocaleDateString('ru')}` : 'Выберите матч';
  if (!m || !st.set) { $('score').innerHTML = ''; $('phase').innerHTML = ''; $('phase').className = 'phase-pill'; return; }
  const s = st.set;
  $('score').innerHTML = `
    <div class="team"><span class="${s.serving === 'us' ? 'serving' : ''}"></span>${esc(ui.settings.teamName)}<span class="pts">${s.us}</span></div>
    <div class="mid"><b>${st.setsWon.us} : ${st.setsWon.them}</b>партия ${s.n + 1}</div>
    <div class="team them"><span class="${s.serving === 'them' ? 'serving' : ''}"></span>${esc(m.opponent)}<span class="pts">${s.them}</span></div>`;
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
    <span class="n">${esc(p.num || p.name)}</span>${p.num ? `<span class="nm">${esc(p.name)}${ROLES[roleOf(p)] ? ' · ' + ROLES[roleOf(p)].short : ''}</span>` : ''}</button>`;
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
    ${ui.sub?.out ? `<div class="bench">${bench.map(p => `<button class="ptile" data-a="subIn" data-id="${p.id}"><span class="n">${esc(p.num || p.name)}</span><span class="nm">${esc(p.name)}</span></button>`).join('') || '<span class="muted">Запасных нет</span>'}</div>` : ''}
    <div class="rot-meta"><b>Р${st.rally.rot}</b><span>${esc(SYSTEMS[ui.match.system] || '')}</span><span class="grow"></span>${ui.sub ? '<span>кто уходит?</span>' : ''}</div>
  </div>`;

  // Центр: палитра действий.
  const g = group(), main = mainGroup();
  const tabs = Object.entries(GROUPS).map(([k, v]) => `<button class="${k === g ? 'on' : ''} ${k === main ? 'main' : ''}" data-a="group" data-g="${k}">${icon(v.icon)}${v.label}<span class="kbd">${v.key}</span></button>`).join('');
  const who = actor(GROUPS[g].acts[0][0]);
  const serveDisabled = g === 'serve' && !st.rally.weServe;
  const cq = baseStage(ctx()) === 'set' ? (ctx().stage === 'await' ? ctx().set.q : ctx().q) : null;
  const acts = GROUPS[g].acts.map(([sk, res, label, cls], k) =>
    `<button class="act ${cls} ${sk === 'set' && cq === res ? 'sel' : ''}" data-a="act" data-skill="${sk}" data-res="${res}" ${serveDisabled ? 'disabled' : ''}>${label}<span class="kbd">${ACT_KEYS[k]}</span></button>`).join('');
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
    <div class="muted" style="margin-top:6px;font-size:12px;color:var(--smoke)">Качество: Q идеальный · W хороший · E неудобный</div>` : '';
  const teamActs = st.rally.phase === 'rec'
    ? `<button class="act r" data-a="act" data-skill="team" data-res="oppAce">Эйс соперника</button><button class="act g" data-a="act" data-skill="team" data-res="oppError">Ошибка соперника <span class="kbd">+</span></button>`
    : `<button class="act g" data-a="act" data-skill="team" data-res="oppError">Ошибка соперника <span class="kbd">+</span></button><button class="act r" data-a="act" data-skill="team" data-res="oppKill">Соперник забил <span class="kbd">−</span></button>`;
  const right = `<div class="ctx">
    ${setCtl ? `<h4>Пас</h4>${setCtl}` : `<h4>Ввод на площадке</h4><div class="muted" style="font-size:12.5px;color:var(--smoke);line-height:1.5">Розыгрыш вводится кликами по 3D-площадке: приём → куда пришёл мяч к пасующему → откуда бьют → куда ударили. Кнопки слева — запасной вариант.</div>`}
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
  $('side').innerHTML = { events: sideEvents, video: sideVideo, match: sideMatch }[ui.tab]();
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
  if (ui.evView === 'rallies') return html + `<p class="muted" style="margin:4px 2px 8px">Клик — видео и 3D на этот розыгрыш · PgUp / PgDn — соседний</p><div class="evlist">${sideRallies()}</div>`;
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
    const cls = [r.l.side || '', r.ev.t !== 'act' && r.ev.t !== 'pt' ? 'sys' : '', ui.edit === r.i ? 'sel' : '', ui.insertAt === r.i ? 'cursor' : '', ui.playlist?.items[ui.playlist.k]?.i === r.i ? 'playing' : ''].join(' ');
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
    <h3>Библиотека</h3><div class="vlist">${rest.map(item).join('') || '<p class="muted">Пусто.</p>'}</div>`;
}

function sideMatch() {
  const m = ui.match, st = ui.st;
  const list = ui.matches.map(x => `<div class="mitem ${m?.id === x.id ? 'on' : ''}" data-a="open" data-id="${x.id}">
    <span class="grow"><b>${esc(x.opponent)}</b><small>${new Date(x.created).toLocaleDateString('ru')} · событий ${x.events}${x.videos.length ? ' · видео ' + x.videos.length : ''}</small></span>
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
      <label class="toggle" style="margin-top:12px"><input type="checkbox" data-k="trackSets" ${ui.trackSets ? 'checked' : ''}><span>Отмечать каждый пас (статистика связующего)</span></label>
      <div class="btns" style="display:flex;gap:6px;margin-top:12px;flex-wrap:wrap">
        ${!st.matchOver && (!st.set || st.set.over) ? `<button class="btn sm primary" data-a="lineup">Начать: ${setTitle(st.sets.length, st.format)}</button>` : ''}
        <a class="btn sm" href="stats.html#m=${m.id}" target="_blank">${icon('i-chart')}Дашборд матча</a>
      </div>
    </div>` : ''}
    <h3>Матчи <span class="grow"></span><button class="btn sm" data-a="newMatch">${icon('i-plus')}Новый</button></h3>
    <div class="mlist">${list || '<p class="muted">Матчей пока нет.</p>'}</div>
    <h3>Расстановки команды</h3>
    <p class="muted">Как команда стоит на приёме, на своей подаче и в защите — для каждой из Р1–Р6. <button class="btn sm" data-a="formEditor" style="margin-top:8px">Настроить расстановки</button></p>
    <h3>Зоны доводки</h3>
    <p class="muted">Оценка приёма и защиты ставится сама — по точке, куда мяч пришёл к пасующему. <button class="btn sm" data-a="zonesEditor" style="margin-top:8px">Настроить зоны ++ / +− / +</button></p>
    <h3>Команда</h3>
    <p class="muted">Игроки, отметка «связующий» и соперники — в <a href="detailed.html#settings" style="color:var(--sky)">настройках</a>.</p>`;
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
    out.push(`<i class="mk ${l.side || ''} ${ui.edit === l.i ? 'sel' : ''}" style="left:${(100 * ev.vt) / d}%" title="${fmt(ev.vt)} · ${esc(l.text)}" data-i="${l.i}"></i>`);
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
    hint.push(`<span>${STEP_HINT[c.stage](c)}</span>`);
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
  if (html && box) box.innerHTML = html;
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
    : `<p class="muted" style="margin-top:-6px">Совет: задайте состав пресета в редакторе расстановок — тогда партию можно начинать одной кнопкой Р1–Р6.</p>`;
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
    <div class="mlist">${ui.settings.opponents.map(o => `<div class="mitem" data-a="createMatch" data-id="${o.id}"><span class="grow"><b>${esc(o.name)}</b></span></div>`).join('') || '<p class="muted">Соперников пока нет.</p>'}</div>
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
    <div class="foot"><button class="btn primary" data-a="modalClose">Понятно</button></div>`);
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
  return `<div class="rpanel"><p class="muted" style="margin:0 0 8px">Кто где стоит в <b>Р${f.rot}</b>. Задайте один раз — в остальных переходах игроки встанут по кругу.
      Связующий (по нему считаются Р1–Р6): <select data-k="fMain">${lu.start.filter(Boolean).map(id => { const p = roster.find(x => x.id === id); return `<option value="${id}" ${id === lu.main ? 'selected' : ''}>#${esc(p?.num)} ${esc(p?.name)}</option>`; }).join('')}</select></p>
    <div class="rgrid">${[4, 3, 2, 5, 6, 1].map(cell).join('')}</div></div>`;
}
// Поля редактора смотрят в рабочую копию выбранного пресета.
function bindPreset() { const w = editPreset(); Object.assign(ui.fEdit, { data: w.data, touched: w.touched, inherited: w.inherited }); }
const isTouched = (f, k, r) => !!f.touched[k]?.[r];
// Переход в расстановку: если её ещё не настраивали — все сдвигаются на переход из предыдущей и встают на её места.
function goRot(r) {
  const f = ui.fEdit, from = f.rot, k = f.kind;
  const pr = prevRot(r);
  if (!isTouched(f, k, r) && (isTouched(f, k, pr) || f.inherited[k]?.[pr])) {
    f.data[k][r] = JSON.parse(JSON.stringify(f.data[k][pr]));
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
    return { ...r, won, after: won == null ? null : [r.score[0] + (won ? 1 : 0), r.score[1] + (won ? 0 : 1)],
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
function sideRallies() {
  const list = rallies();
  let html = '', set = -1;
  for (const r of list) {
    if (r.set !== set) { set = r.set; html += `<div class="ev-div">Партия ${set + 1}</div>`; }
    const cls = `rl ${r.won === true ? 'us' : r.won === false ? 'them' : 'open'} ${ui.focusRally === r.key ? 'sel' : ''}`;
    html += `<div class="${cls}" data-a="pickRally" data-k="${r.key}">
      <span class="t ${r.t0 == null ? 'none' : ''}">${r.t0 == null ? '—' : fmtShort(r.t0)}</span>
      <span class="sc">${r.after ? r.after.join(':') : '…'}</span>
      <span class="body"><b>${r.won === true ? 'Очко нам' : r.won === false ? 'Очко им' : 'Идёт'}</b> · Р${r.rot} · ${r.weServe ? 'наша подача' : 'приём'}<small>${esc(rallySummary(r))}</small></span>
      <button class="rowdel" data-a="rallyDel" data-k="${r.key}" title="Удалить розыгрыш целиком">${icon('i-x')}</button></div>`;
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
  for (const pl of r.plays) {
    if (pl.vt == null) continue;
    const t = pl.vt;
    if (pl.skill === 'serve') { k.push({ t, p: pl.from ?? DEFAULT_SPOT.serveUs, h: 2.8, apex: 4.4 }); if (pl.to) k.push({ t: t + 1.1, p: pl.to, h: 0.3, apex: 3 }); }
    if (pl.skill === 'rec' && pl.to) { k.push({ t: t - 1.2, p: pl.from ?? DEFAULT_SPOT.serveThem, h: 2.8, apex: 4.2 }); k.push({ t, p: pl.to, h: 0.8, apex: 4.6 }); }
    if (pl.skill === 'dig' && pl.to) { if (pl.from) k.push({ t: t - 0.8, p: pl.from, h: 3.1, apex: 3.2 }); k.push({ t, p: pl.to, h: 0.8, apex: 4.6 }); }
    if (pl.skill === 'set') k.push({ t, p: pl.from ?? SETTER_SPOT, h: 2.5, apex: pl.h ?? TEMPOS[pl.tempo]?.h ?? 4.2 });
    if (pl.skill === 'att') { k.push({ t, p: pl.from ?? { x: 4.5, y: 7.6 }, h: 3.1, apex: 3.25 }); if (pl.to) k.push({ t: t + 0.55, p: pl.to, h: 0.12, apex: 1.5 }); }
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
  for (const pl of done) {
    if (['serve', 'att'].includes(pl.skill) || pl.res === 'over') { for (const k in moved) delete moved[k]; continue; }
    const pt = pl.skill === 'set' ? pl.from : pl.to;
    if (pl.p && pt) moved[pl.p] = pt;
  }
  const gsR = lineup.find(id => setters.has(id) && isFrontZone(zones[lineup.indexOf(id)])) ?? lineup.find(id => setters.has(id));
  const attRole = attackByRole(lineup.map((id, k) => ({ id, zone: zones[k], role: roleOf(person(id)), front: isFrontZone(zones[k]) })), gsR);
  return lineup.map((id, k) => {
    const z = zones[k], p = person(id);
    let spot = kind === 'att' ? (F.touched?.att?.[rot] ? spotFor(F, 'att', rot, z) : attRole[id]) : spotFor(F, kind, rot, z);
    if (kind === 'serve' && st0.rally.server === id && !last) spot = { x: 7.6, y: -0.9 };
    return { id, label: p.num || (p.name || '?').slice(0, 2), spot: moved[id] ?? spot, setter: setters.has(id), selected: last?.p === id, pinned: !!moved[id], act: last?.p === id && ACT_OF[last.skill] ? { type: ACT_OF[last.skill], key: `${last.skill}:${last.vt}` } : null };
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

// ---------- Синхронизация с видео ----------
function setSync(on) {
  ui.sync = on; store.set('sync', on);
  ui.anchor = null; ui.loops = 0;
  if (video.src) video.playbackRate = on ? ui.syncRate : ui.rate;
  document.querySelectorAll('[data-a=speed]').forEach(b => b.classList.toggle('on', +b.dataset.v === video.playbackRate));
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
function startClips() {
  const items = eventRows().filter(r => r.ev.vt != null && r.ev.v === ui.activeVideo).map(r => ({ i: r.i, vt: r.ev.vt }));
  if (!items.length) return;
  ui.playlist = { items, k: 0 };
  ui.edit = items[0].i;
  seekTo(items[0].vt - PRE);
  video.play();
  render();
}
video.addEventListener('timeupdate', () => {
  const pl = ui.playlist;
  if (!pl) return;
  if (video.currentTime >= pl.items[pl.k].vt + POST) {
    pl.k++;
    if (pl.k >= pl.items.length) { ui.playlist = null; video.pause(); toast('Клипы закончились'); render(); return; }
    ui.edit = pl.items[pl.k].i;
    seekTo(pl.items[pl.k].vt - PRE);
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
  tab: d => { ui.tab = d.tab; render(); },
  help: openHelp,
  modalClose: () => { modal(''); ui.fEdit = null; },
  modalBg: (d, e) => { if (e.target.classList.contains('modal-bg')) modal(''); },
  pickFile: () => $('fileInput').click(),
  view: d => { court.setView(d.v); document.querySelectorAll('[data-a=view]').forEach(b => b.classList.toggle('on', b.dataset.v === d.v)); },
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
  speed: d => { const r = Number(d.v); if (ui.sync) { ui.syncRate = r; store.set('syncRate', r); } else ui.rate = r; video.playbackRate = r; document.querySelectorAll('[data-a=speed]').forEach(b => b.classList.toggle('on', b.dataset.v === d.v)); },
  layout: d => setLayout(d.v),
  sel: d => { pauseForInput(); ui.sel = ui.sel === d.id ? null : d.id; render(); },
  group: d => { ui.group = d.g === mainGroup() ? null : d.g; render(); },
  act: d => sendAct(d.skill, d.res),
  tempo: d => { ui.tempo = d.v; ui.setH = TEMPOS[d.v].h; render(); },
  menuPick: d => menuPick(+d.k),
  blockOff: () => { if (ui.draft) delete ui.draft.block; render(); },
  evView: d => { ui.evView = d.v; store.set('evView', d.v); paintSide(); },
  pickRally: d => pickRally(d.k),
  formEditor: () => openFormEditor(),
  fKind: d => { ui.fEdit.kind = d.v; ui.fEdit.defView = 'base'; goRot(ui.fEdit.rot); },
  fDefView: d => { ui.fEdit.defView = d.v; paintFormEditor(); },
  fRot: d => goRot(+d.v),
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
  if (k === 'fp') { ui.filter.p = v; render(); }
  if (k === 'system') call(async () => setMatch(await api('PATCH', `/api/matches/${ui.match.id}`, { system: v })));
  if (k === 'trackSets') { ui.trackSets = v; store.set('trackSets', v); render(); }
  if (k === 'lsetter') ui.lineupDraft.setter = v;
  if (k === 'fPreset') { ui.fEdit.presetId = v; bindPreset(); paintFormEditor(); }
  if (k === 'fSystem') { editPreset().system = v; }
  if (k === 'fRules') { editPreset().rules = v; paintFormEditor(); }
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
  if (k === 'matchFormat') { const format = pickFormat(v); call(async () => setMatch(await api('PATCH', `/api/matches/${ui.match.id}`, { format }))); }
  if (k === 'matchPreset') { const pr = presetById(v); call(async () => setMatch(await api('PATCH', `/api/matches/${ui.match.id}`, { preset: v, system: pr.system || ui.match.system }))); }
  if (k === 'eres') updateEvent(ui.edit, { res: v });
  if (k === 'ep') updateEvent(ui.edit, { p: v || null });
  if (k === 'etempo') updateEvent(ui.edit, { tempo: v });
});
document.addEventListener('input', e => {
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
  if (modalOpen()) {
    if (e.key === 'Escape') { modal(''); ui.fEdit = null; }
    if (e.key === 'Enter' && ui.lineupDraft?.order.length === 6 && $('modal').querySelector('[data-a=lstart]')) H.lstart();
    return;
  }
  if (e.ctrlKey || e.metaKey) { if (e.code === 'KeyZ') { e.preventDefault(); undo(); } return; }
  const c = e.code;
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
  if (c === 'ArrowLeft' || c === 'ArrowRight') { e.preventDefault(); seekTo(video.currentTime + (c === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 15 : 5)); return; }
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
window.studio = { ui, court };

// ---------- Старт ----------
setLayout(store.get('layout', 'split'));
paintSyncUi();
$('viewport').style.setProperty('--split', store.get('split', 58) + '%');
call(async () => {
  await loadAll();
  const id = location.hash.match(/m=([a-z0-9]+)/)?.[1] ?? store.get('lastMatch', null) ?? ui.matches[0]?.id;
  pollVideos();
  if (id && ui.matches.some(m => m.id === id)) await openMatch(id);
  else ui.tab = 'match';
});
// Дашборд и телефон могут менять данные — подтягиваем список матчей, когда окно снова в фокусе.
addEventListener('focus', () => { if (!ui.busy) loadAll().then(() => ui.match && api('GET', `/api/matches/${ui.match.id}`)).then(m => { if (m) setMatch(m); render(); }).catch(() => {}); });
