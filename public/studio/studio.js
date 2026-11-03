// Студия — десктопная программа для разбора матча по видео и детальной статистики.
// Состояние матча, как и везде, вычисляет engine.js из списка событий на сервере;
// здесь — только интерфейс: видео, 3D-площадка, ввод касаний, правка и вставка событий.
import { replay, playerName, LABELS, ACTIONS, SKILLS } from '../engine.js';
import { ZONE_SPOT, DEFAULT_SPOT, TEMPOS, SYSTEMS, guessSetter, zoneOf, SET_DIRS, setDir, NET } from '../court.js';
import { createCourt3D } from './court3d.js';
import { gradeAt, digRes, zonesOf, defaultZones, GRADES, COLS, ROWS, CELL } from '../quality.js';

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
function toast(text, err = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast on' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 2600);
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
function stamp(ev) {
  if (ui.activeVideo && video.src && !isNaN(video.currentTime)) { ev.v = ui.activeVideo; ev.vt = +video.currentTime.toFixed(2); }
  return ev;
}
function postEvent(ev) {
  const at = ui.insertAt;
  return call(async () => {
    setMatch(await api('POST', `/api/matches/${ui.match.id}/events${at !== null ? `?at=${at}` : ''}`, ev));
    if (at !== null) { ui.insertAt = at + 1; recompute(); }
  });
}
function sendAct(skill, res) {
  if (!live()) return toast('Партия не идёт — начните партию во вкладке «Матч»', true);
  if (skill === 'serve' && !ui.st.rally.weServe) return toast('Сейчас подаёт соперник', true);
  const p = actor(skill);
  if (!p && skill !== 'team') return toast('Выберите игрока: клик по плитке или клавиши 1–6 (номер зоны)', true);
  const ev = stamp({ t: 'act', skill, res, p: skill === 'team' ? null : p });
  // Кнопка той же группы, что и неоценённое касание на площадке, — ставит оценку вручную (вместо зон доводки).
  const t = ui.draft?.touch;
  if (t && (skill === t.kind || (t.kind === 'dig' && skill === 'blk'))) { ev.p = ui.sel ?? t.p; ev.to = t.at; if (t.from) ev.from = t.from; }
  const c = ctx();
  if (skill === 'set' && c?.stage === 'set') { ev.p = ui.sel ?? c.p; ev.from = c.from; }
  if (skill === 'att' && c?.stage === 'att') { ev.p = ui.sel ?? c.p; ev.from = c.from; }
  if (skill === 'set') { ev.tempo = tempoOfH(curH()); ev.h = curH(); }
  ui.sel = null; ui.pending = {}; ui.group = null; ui.setH = null; ui.draft = null;
  postEvent(ev).then(resume);
}
const sendRaw = ev => { ui.sel = null; ui.pending = {}; ui.group = null; ui.draft = null; postEvent(stamp(ev)).then(resume); };
function resume() { if (ui.resumeAfter) { ui.resumeAfter = false; video.play().catch(() => {}); } }
function pauseForInput() {
  if ($('autoPause').checked && video.src && !video.paused) { video.pause(); ui.resumeAfter = true; }
}

function undo() {
  closeMenu();
  if (ui.draft) { ui.draft = null; ui.setH = null; return render(); } // сначала отменяем неоконченный шаг на площадке
  if (!ui.match?.events.length) return;
  if (ui.insertAt !== null) {
    if (ui.insertAt === 0) return;
    const k = ui.insertAt - 1;
    return call(async () => { setMatch(await api('DELETE', `/api/matches/${ui.match.id}/events/${k}`)); ui.insertAt = k; recompute(); });
  }
  ui.sel = null; ui.pending = {};
  call(async () => setMatch(await api('DELETE', `/api/matches/${ui.match.id}/events/last`)));
}

// ---------- 3D-площадка: розыгрыш по касаниям ----------
// Ввод идёт прямо на площадке. На нашей стороне всегда до трёх касаний:
//   1 — приём или защита: клик, куда пришёл мяч → подсвечен ближайший игрок (можно кликнуть другого);
//   2 — пас: клик, куда мяч пришёл к связующему → оценка приёма по зонам доводки; связующий бежит туда;
//   3 — атака: дуга паса тянется за мышью (колесо — высота), клик — откуда бьют; потом — куда ударили.
// Когда мяч у соперника: клик на их половине — откуда бьют, по рукам — наш блок, по нашей площадке — куда пришёл удар.
// Касание, которое ещё не оценено (ждём следующий клик), хранится в ui.draft и уходит на сервер вместе с оценкой.

const court = createCourt3D($('court3d'), {
  onPick: (p, e, hit) => onCourtPick(p, e, hit),
  onHover: (p, e, hit) => {
    const el = $('courtHover');
    ui.mouse = p;
    if (!p) { el.classList.remove('on'); paintPreview(); return; }
    el.classList.add('on');
    el.textContent = hit?.player ? esc(name(hit.player)) : hit?.hands ? (hit.hands === 'us' ? 'наш блок' : 'блок соперника') : `${p.y < NET ? 'наша' : 'их'} зона ${p.zone ?? '—'} · x ${p.x.toFixed(1)} · y ${p.y.toFixed(1)}`;
    paintPreview();
  },
  onWheel: dir => {
    const c = ctx();
    if (c?.stage !== 'set') return;
    ui.setH = Math.max(2.6, Math.min(9, +(curH() - dir * 0.35).toFixed(2)));
    paintPreview(); paintHud();
  },
});

const inCourtUs = p => p.x >= 0 && p.x <= 9 && p.y >= 0 && p.y < NET;
const inCourtThem = p => p.x >= 0 && p.x <= 9 && p.y >= NET && p.y <= 18;
const rallyKey = () => (ui.st?.set ? `${ui.st.set.n}:${ui.st.rally.no}:${ui.insertAt}` : '');
const curH = () => ui.setH ?? TEMPOS[ui.tempo].h;
const tempoOfH = h => (h < 3.6 ? 'q' : h < 5 ? 'f' : 'h');
const SET_Q = { perfect: 'идеальный', good: 'хороший', poor: 'неудобный' };

// Где сейчас стоит игрок: куда он выбежал к мячу в этом розыгрыше, иначе — зона расстановки.
function posOf(id) {
  const st = ui.st;
  if (ui.moved[id]) return ui.moved[id];
  if (st.rally.phase === 'serve' && st.rally.server === id && !ui.draft) return { x: 7.6, y: -0.9 };
  return ZONE_SPOT[st.rally.zones[st.set.lineup.indexOf(id)]];
}
function nearest(p, { exclude = [], only = null } = {}) {
  let best = null, bd = 1e9;
  for (const id of ui.st.set.lineup) {
    if (exclude.includes(id) || (only && !only.includes(id))) continue;
    const s = posOf(id), d = Math.hypot(s.x - p.x, s.y - p.y);
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}
const frontRow = () => ui.st.set.lineup.filter((id, k) => [2, 3, 4].includes(ui.st.rally.zones[k]));

// Текущий шаг ввода. Если черновика нет — выводим шаг из состояния розыгрыша (так ввод с телефона и правки не ломают поток).
function ctx() {
  if (!live() || ui.editPoints) return null;
  const st = ui.st, r = st.rally, d = ui.draft || {};
  if (d.touch) return { stage: 'touch2', ...d };
  if (r.phase === 'serve') return { stage: 'serve', p: r.server };
  if (r.phase === 'rec') return { stage: 'rec' };
  if (r.phase === 'their') return { stage: 'their', origin: d.origin ?? null };
  const last = rallyPlays().filter(p => !p.virtual).at(-1);
  if (d.att || last?.skill === 'set') {
    const from = d.att?.from ?? last?.to ?? spotOfTarget({ dir: 4 });
    const setter = last?.skill === 'set' ? last.p : null;
    return { stage: 'att', from, p: d.att?.p ?? nearest(from, { exclude: setter ? [setter] : [] }) };
  }
  if (d.set || (last && ['rec', 'dig'].includes(last.skill))) {
    const gs = guessedSetter();
    const from = d.set?.from ?? (gs ? posOf(gs) : DEFAULT_SPOT.setter);
    return { stage: 'set', from, p: d.set?.p ?? gs ?? nearest(from), q: d.set?.q ?? 'good' };
  }
  return { stage: 'free' }; // мяч у нас, но первое касание не отмечено (например, после ⇄)
}

// Номер касания на нашей стороне — для счётчика 1·2·3.
const touchNo = c => ({ rec: 1, their: 1, free: 1, touch2: 2, set: 3, att: 3 })[c?.stage] ?? 0;

function postAct(ev) { return postEvent(stamp({ t: 'act', ...ev })); }
function moveTo(id, p) { if (id && p) ui.moved[id] = { x: p.x, y: p.y }; }

async function onCourtPick(p, e, hit) {
  if (!ui.match || ui.busy) return;
  closeMenu();
  // Правка точек выбранного события (кнопка «Точки» в карточке события).
  if (ui.editPoints && ui.edit !== null) {
    const key = e.shiftKey || e.button === 2 ? 'from' : 'to';
    const ev = { ...ui.match.events[ui.edit], [key]: p };
    return call(async () => setMatch(await api('PUT', `/api/matches/${ui.match.id}/events/${ui.edit}`, ev)));
  }
  const c = ctx();
  if (!c) return;
  pauseForInput();
  const right = e.button === 2;

  // Клик по игроку — «это был он»: меняем исполнителя текущего шага.
  if (hit?.player) {
    const id = hit.player;
    if (c.stage === 'touch2') { ui.draft.touch.p = id; moveTo(id, ui.draft.touch.at); }
    else if (c.stage === 'set') { ui.draft = { ...ui.draft, set: { ...ui.draft?.set, p: id, from: c.from } }; moveTo(id, c.from); }
    else if (c.stage === 'att') { ui.draft = { ...ui.draft, att: { p: id, from: c.from } }; moveTo(id, c.from); }
    else if (['rec', 'their', 'free'].includes(c.stage)) {
      // Первое касание кликом по игроку: он принял мяч там, где стоит.
      ui.draft = { touch: { kind: c.stage === 'rec' ? 'rec' : 'dig', p: id, at: posOf(id), from: c.stage === 'their' ? c.origin ?? null : null } };
      ui.sel = null;
    } else ui.sel = ui.sel === id ? null : id;
    return render();
  }

  switch (c.stage) {
    case 'serve': {
      if (p.y < NET) return toast('Подача: кликните на их половине. Ошибка — клик за их линиями или ПКМ'); // случайный клик по своей половине
      if (!inCourtThem(p)) return postAct({ skill: 'serve', res: 'error', p: c.p, to: p }).then(resume); // аут
      if (right) return openMenu(p, 0, [
        ['Сложная подача', 'g', () => postAct({ skill: 'serve', res: 'good', p: c.p, to: p })],
        ['Эйс', 'g', () => postAct({ skill: 'serve', res: 'ace', p: c.p, to: p })],
        ['В игру', 'n', () => postAct({ skill: 'serve', res: 'in', p: c.p, to: p })],
        ['Ошибка (аут)', 'r', () => postAct({ skill: 'serve', res: 'error', p: c.p, to: p })],
      ]);
      return postAct({ skill: 'serve', res: 'in', p: c.p, to: p }).then(resume);
    }
    case 'rec':
    case 'free':
    case 'their': {
      if (p.y >= NET) { // их половина: откуда бьют (для защиты и траектории)
        if (c.stage === 'their') { ui.draft = { origin: p }; return render(); }
        return;
      }
      if (hit?.hands === 'us') return ourBlockMenu(p);
      if (!inCourtUs(p)) { // мяч ушёл в аут на нашей стороне
        if (right) return;
        return postAct({ skill: 'team', res: 'oppError', p: null, to: p }).then(resume);
      }
      if (right) { // мяч упал, никто не достал
        return postAct({ skill: 'team', res: c.stage === 'rec' ? 'oppAce' : 'oppKill', p: null, to: p }).then(resume);
      }
      const kind = c.stage === 'rec' ? 'rec' : 'dig';
      const who = ui.sel ?? nearest(p);
      ui.sel = null;
      ui.draft = { touch: { kind, p: who, at: p, from: c.stage === 'their' ? c.origin ?? null : null } };
      moveTo(who, p);
      return render();
    }
    case 'touch2': { // куда мяч пришёл ко второму касанию → оценка первого
      const t = c.touch;
      const grade = gradeAt(ui.zones, p);
      const res = t.kind === 'rec' ? grade : digRes(grade);
      const base = { skill: t.kind, p: t.p, to: t.at, ...(t.from && { from: t.from }) };
      ui.draft = null;
      if (grade === 'over') return postAct({ ...base, res: t.kind === 'rec' ? 'over' : 'over' }).then(resume);
      await postAct({ ...base, res });
      const gs = guessedSetter();
      const setter = gs && gs !== t.p ? gs : nearest(p, { exclude: [t.p] });
      ui.draft = { set: { p: setter, from: p, q: 'good' } };
      moveTo(setter, p);
      toast(`${esc(name(t.p))} — ${LABELS[t.kind][res]}`);
      return render();
    }
    case 'set': {
      if (p.y >= NET) return attackLanding(p, right, { p: c.p, from: c.from, dump: true });
      const setter = c.p;
      await postAct({ skill: 'set', res: c.q, p: setter, from: c.from, to: p, tempo: tempoOfH(curH()), h: curH() });
      ui.setH = null;
      const attacker = nearest(p, { exclude: [setter] });
      ui.draft = { att: { p: attacker, from: p } };
      moveTo(attacker, p);
      return render();
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

// Атака приземлилась на их стороне. ЛКМ в площадке — очко, ПКМ — подняли, за линиями — аут.
function attackLanding(p, right, c) {
  ui.draft = null;
  const ev = { skill: 'att', p: c.p, from: c.from, to: p };
  if (!inCourtThem(p)) return postAct({ ...ev, res: 'error' }).then(resume);
  return postAct({ ...ev, res: right ? 'play' : 'kill' }).then(resume);
}
function blockMenu(p, c) {
  const at = { x: p.x, y: NET + 0.1 };
  openMenu(at, 2.9, [
    ['Блок-аут — очко нам', 'g', () => postAct({ skill: 'att', res: 'bo', p: c.p, from: c.from, to: at })],
    ['В пол от блока — очко им', 'r', () => postAct({ skill: 'att', res: 'blocked', p: c.p, from: c.from, to: { x: p.x, y: NET - 1.2 } })],
    ['Отскок к нам — играем дальше', 'n', () => postAct({ skill: 'att', res: 'play', p: c.p, from: c.from, to: at, cover: true })],
  ]);
}
// Наш блок, когда атакует соперник.
function ourBlockMenu(p) {
  const bl = ourBlockers(ui.draft?.origin ?? p);
  const blocker = bl.length ? bl.reduce((a, b) => (Math.abs(b.x - p.x) < Math.abs(a.x - p.x) ? b : a)).id : nearest({ x: p.x, y: NET - 0.5 }, { only: frontRow() });
  const at = { x: p.x, y: NET - 0.1 };
  const from = ui.draft?.origin;
  openMenu(at, 2.9, [
    ['Блок: очко', 'g', () => postAct({ skill: 'blk', res: 'point', p: blocker, to: at, ...(from && { from }) })],
    ['Касание — мяч у нас', 'y', async () => { await postAct({ skill: 'blk', res: 'touch', p: blocker, to: at, ...(from && { from }) }); ui.draft = { origin: from }; render(); }],
    ['Блок-аут — очко им', 'r', () => postAct({ skill: 'blk', res: 'out', p: blocker, to: at, ...(from && { from }) })],
  ], `Блок: ${esc(name(blocker))}`);
}

// ---------- Всплывающее меню возле точки ----------
function openMenu(p, h, items, title = '') {
  const pos = court.project(p, h);
  ui.menu = { items };
  const el = $('courtMenu');
  el.innerHTML = (title ? `<div class="cm-title">${title}</div>` : '') + items.map(([label, cls], k) =>
    `<button class="cm-item ${cls}" data-a="menuPick" data-k="${k}"><span class="kbd">${k + 1}</span>${label}</button>`).join('');
  const pane = el.parentElement.getBoundingClientRect();
  el.style.left = Math.min(pos.x + 12, pane.width - 240) + 'px';
  el.style.top = Math.min(Math.max(8, pos.y - 20), pane.height - 40 * items.length - 20) + 'px';
  el.classList.add('on');
}
function closeMenu() { ui.menu = null; $('courtMenu').classList.remove('on'); }
function menuPick(k) {
  const it = ui.menu?.items[k];
  closeMenu();
  if (!it) return;
  ui.draft = null;
  Promise.resolve(it[2]()).then(resume);
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
function focusPlays() {
  const plays = ui.full?.plays ?? [];
  if (ui.edit !== null) {
    const pl = plays.find(p => p.i === ui.edit);
    if (pl) return plays.filter(p => p.set === pl.set && p.rally === pl.rally);
  }
  if (rallyPlays().length) return rallyPlays();
  const last = ui.st?.plays.at(-1);
  return last ? ui.st.plays.filter(p => p.set === last.set && p.rally === last.rally) : [];
}

// Наш блок на удар соперника: двое из передней линии ближе всего к месту удара выходят к сетке.
function ourBlockers(origin) {
  if (!origin) return [];
  const fr = frontRow().sort((a, b) => Math.abs(posOf(a).x - origin.x) - Math.abs(posOf(b).x - origin.x)).slice(0, 2);
  return fr.map(id => ({ id, x: Math.max(0.5, Math.min(8.5, posOf(id).x * 0.4 + origin.x * 0.6)) }));
}

// Линии за мышью: подача соперника, доводка к связующему, дуга паса, удар; руки блока.
function paintPreview() {
  const c = ctx(), m = ui.mouse;
  const pv = [];
  let hands = [];
  if (c) {
    if (c.stage === 'att') {
      const bx = Math.max(0.6, Math.min(8.4, (m && m.y >= NET ? m.x : c.from.x)));
      hands = [{ x: Math.max(0.5, Math.min(8.5, c.from.x - 0.45)), side: 'them' }, { x: Math.max(0.5, Math.min(8.5, c.from.x + 0.45)), side: 'them' }];
      void bx;
      if (m) pv.push({ from: c.from, to: m, y0: 3.1, y1: 0.12, apex: 3.25, color: m.y >= NET && inCourtThem(m) ? 0x59d499 : 0xff6363, ball: true });
    }
    if (c.stage === 'set' && m) pv.push({ from: c.from, to: m, y0: 2.5, y1: 3.0, apex: curH(), color: 0xffffff, ball: true });
    if (c.stage === 'touch2' && m) pv.push({ from: c.touch.at, to: m, y0: 0.8, y1: 2.5, apex: Math.max(3.4, 2.5 + Math.hypot(m.x - c.touch.at.x, m.y - c.touch.at.y) * 0.35), color: 0xf0c85a, dashed: true, ball: true });
    if ((c.stage === 'rec') && m && m.y < NET) pv.push({ from: DEFAULT_SPOT.serveThem, to: m, y0: 2.7, y1: 0.7, apex: 4.2, color: 0xf0c85a, dashed: true, ball: true, ballAtEnd: false });
    if (c.stage === 'serve' && m && m.y >= NET) pv.push({ from: DEFAULT_SPOT.serveUs, to: m, y0: 2.7, y1: 0.3, apex: 4.4, color: inCourtThem(m) ? 0x63a1ff : 0xff6363, dashed: true, ball: true });
    if (c.stage === 'their') {
      const origin = c.origin ?? (m && m.y >= NET ? m : null);
      if (origin) {
        // Наш блок: двое из передней линии ближе всего к месту удара.
        hands = ourBlockers(origin).map(b => ({ x: b.x, side: 'us' }));
        if (c.origin && m && m.y < NET) pv.push({ from: c.origin, to: m, y0: 3.1, y1: 0.4, apex: 3.3, color: 0xff9f8a, ball: true });
      }
    }
  }
  court.setPreview(pv);
  court.setHands(hands);
  court.setWheelCapture(c?.stage === 'set');
}

function paintCourt() {
  const st = ui.st;
  if (rallyKey() !== ui.movedKey) { ui.moved = {}; ui.movedKey = rallyKey(); if (ui.draft && !ui.draft.keep) ui.draft = null; }
  const c = ctx();
  // Блокирующие выходят к сетке, когда известно, откуда бьёт соперник.
  const blk = c?.stage === 'their' && c.origin ? Object.fromEntries(ourBlockers(c.origin).map(b => [b.id, { x: b.x, y: NET - 0.55 }])) : {};
  if (live()) {
    const gs = guessedSetter();
    const hl = c && ['touch2', 'set', 'att'].includes(c.stage) ? (c.stage === 'touch2' ? c.touch.p : c.p) : null;
    court.setPlayers(st.set.lineup.map(id => {
      const p = person(id);
      return { id, label: p.num || (p.name || '?').slice(0, 2), spot: blk[id] ?? posOf(id), setter: id === gs, selected: ui.sel === id, server: st.rally.phase === 'serve' && st.rally.server === id, hl: id === hl, pinned: !!ui.moved[id] };
    }));
  } else court.setPlayers([]);
  court.setPending(ui.editPoints && ui.edit !== null ? { from: ui.match.events[ui.edit]?.from, to: ui.match.events[ui.edit]?.to } : c?.stage === 'their' && c.origin ? { from: c.origin } : {});
  court.setTrails(trailsFor(focusPlays()));
  const sk = DISPLAY_SKILL[group()];
  court.setDots(sk && ui.full ? ui.full.plays.filter(p => p.skill === sk && p.to && !p.virtual).map(p => ({ ...p.to, color: colorOf(p), opacity: 0.4 })) : []);
  paintPreview();
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
    <span class="n">${esc(p.num || p.name)}</span>${p.num ? `<span class="nm">${esc(p.name)}</span>` : ''}</button>`;
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
      ${over ? '' : `<button class="btn sm primary" data-a="lineup" style="margin-left:10px">${n === 2 ? 'Тай-брейк (до 15)' : `Начать партию ${n + 1}`}</button>`}
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
  const acts = GROUPS[g].acts.map(([sk, res, label, cls], k) =>
    `<button class="act ${cls}" data-a="act" data-skill="${sk}" data-res="${res}" ${serveDisabled ? 'disabled' : ''}>${label}<span class="kbd">${ACT_KEYS[k]}</span></button>`).join('');
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
      <button class="btn sm" data-a="undo">${icon('i-undo')}Отмена <span class="kbd">⌫</span></button>
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
    items.push(`<div class="ev ${cls}" data-a="pickEv" data-i="${r.i}">
      <span class="t ${r.ev.vt == null ? 'none' : ''}">${r.ev.vt == null ? '—' : fmtShort(r.ev.vt)}</span>
      <span class="sc">${r.i + 1}</span>
      <span class="tx">${esc(r.l.text)}</span><span class="ic">${ic}</span></div>`);
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
    <span class="sc">${x.setsWon.us}:${x.setsWon.them}</span></div>`).join('');
  const sys = m ? Object.entries(SYSTEMS).map(([k, v]) => `<option value="${k}" ${m.system === k ? 'selected' : ''}>${v}</option>`).join('') : '';
  return `
    ${m ? `<h3>Текущий матч</h3>
    <div class="card">
      <div class="kv">
        <span>Соперник</span><b>${esc(m.opponent)}</b>
        <span>Партии</span><b class="mono">${st.sets.map(s => `${s.us}:${s.them}`).join(', ') || '—'}</b>
        <span>Событий</span><b class="mono">${m.events.length}</b>
      </div>
      <div class="field" style="display:grid;gap:6px;margin-top:12px;font-size:12.5px;color:var(--smoke)">Схема игры
        <select data-k="system">${sys}</select>
        <span>Схема только подсказывает, кто пасует. В любом касании можно выбрать другого игрока — нестандартные перемещения не мешают.</span>
      </div>
      <label class="toggle" style="margin-top:12px"><input type="checkbox" data-k="trackSets" ${ui.trackSets ? 'checked' : ''}><span>Отмечать каждый пас (статистика связующего)</span></label>
      <div class="btns" style="display:flex;gap:6px;margin-top:12px;flex-wrap:wrap">
        ${!st.matchOver && (!st.set || st.set.over) ? `<button class="btn sm primary" data-a="lineup">Начать партию ${st.sets.length + 1}</button>` : ''}
        <a class="btn sm" href="stats.html#m=${m.id}" target="_blank">${icon('i-chart')}Дашборд матча</a>
      </div>
    </div>` : ''}
    <h3>Матчи <span class="grow"></span><button class="btn sm" data-a="newMatch">${icon('i-plus')}Новый</button></h3>
    <div class="mlist">${list || '<p class="muted">Матчей пока нет.</p>'}</div>
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
  $('playBtn').innerHTML = icon(video.paused ? 'i-play' : 'i-pause');
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
const STEP_HINT = {
  serve: c => `Подача ${who(c.p)}: клик на их половине — <b>в игру</b> · ПКМ — эйс / сложная · за линией или в сетку — ошибка`,
  rec: () => `<b>Приём</b>: клик, куда пришла подача — подсветится ближайший · ПКМ — эйс соперника · <span class="kbd">X</span> эйс`,
  their: c => c.origin
    ? `<b>Удар соперника</b>: клик по нашей площадке — куда пришёл (защита) · по рукам — <b>наш блок</b> · ПКМ — не подняли · за линией — аут`
    : `<b>Мяч у них</b>: клик на их половине — откуда бьют (можно пропустить) · по нашей площадке — куда пришёл мяч`,
  free: () => `<b>Мяч у нас</b>: клик, где первое касание`,
  touch2: c => `${who(c.touch.p)} — ${c.touch.kind === 'rec' ? 'приём' : 'защита'}. Клик — <b>куда пришёл мяч к пасующему</b>: оценка по зонам доводки · на их сторону — перекид · <span class="kbd">X</span> не ${c.touch.kind === 'rec' ? 'принял' : 'поднял'}`,
  set: c => `Пас ${who(c.p)} · <b>${SET_Q[c.q] || c.q}</b> <span class="kbd">Q</span><span class="kbd">W</span><span class="kbd">E</span> · колесо — высота <b>${curH().toFixed(1)} м · ${{ q: '1 темп', f: '2 темп', h: '3 темп' }[tempoOfH(curH())]}</b> · клик — <b>откуда бьют</b> · на их сторону — скидка`,
  att: c => `Атака ${who(c.p)}: ЛКМ на их площадке — <b>очко</b> · ПКМ — подняли · за линией — аут · по рукам — блок · <span class="kbd">N</span> сетка`,
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
  ui.lineupDraft = { order: last ? last.start.filter(id => ui.match.roster.some(p => p.id === id)) : [], weServe: true, setter: last?.main ?? null };
  paintLineup();
}
function paintLineup() {
  const d = ui.lineupDraft, n = ui.st.sets.length + 1;
  const roster = [...ui.match.roster].sort((a, b) => a.num - b.num);
  const chosen = d.order.map(id => person(id));
  const setterOpts = chosen.map(p => `<option value="${p.id}" ${(d.setter ?? chosen.find(c => c.setter)?.id) === p.id ? 'selected' : ''}>${esc(playerName(ui.match, p.id))}${p.setter ? ' · связ.' : ''}</option>`).join('');
  modal(`<h2>${n === 3 ? 'Тай-брейк (до 15)' : `Партия ${n}`} — ${esc(ui.match.opponent)}</h2>
    <p>Нажимайте игроков <b>в порядке подачи</b>: 1 — подаёт первым. Повторное нажатие убирает.</p>
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
  modal(`<h2>Новый матч</h2><p>С кем играем?</p>
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
      ${k([',', '.'], 'кадр назад / вперёд')}
      ${k(['1', '…', '6'], 'выбрать игрока по номеру зоны')}
      ${k(['A', 'S', 'D', 'F', 'G', 'H'], 'группа: подача, приём, пас, атака, защита/блок, ошибка')}
      ${k(['Q', 'W', 'E', 'R', 'T', 'Y'], 'действие в группе (подсказка на кнопке)')}
      ${k(['+', '−'], 'ошибка соперника / соперник забил')}
      ${k(['Z'], 'темп паса по кругу: 1т → 2т → 3т (или колесо мыши над площадкой)')}
      ${k(['X'], 'мяч упал: не принял / не поднял')}
      ${k(['N'], 'атака в сетку')}
      ${k(['ПКМ'], 'на площадке — второй вариант: «подняли» вместо «очко», меню подачи, «не подняли»')}
      ${k(['⌫'], 'отменить последнее (в режиме вставки — последнее вставленное)')}
      ${k(['Esc'], 'снять выбор, точки, правку')}
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
  modal('');
  ui.insertAt = null; ui.edit = null; ui.sel = null; ui.pending = {}; ui.playlist = null;
  setMatch(await api('POST', '/api/matches', { opponentId }));
  ui.matches = await api('GET', '/api/matches');
  if (ui.activeVideo) { await linkVideo(ui.activeVideo); store.set('video.' + ui.match.id, ui.activeVideo); toast('Открытое видео привязано к новому матчу'); }
  recompute();
  openLineup();
}

const H = {
  tab: d => { ui.tab = d.tab; render(); },
  help: openHelp,
  modalClose: () => modal(''),
  modalBg: (d, e) => { if (e.target.classList.contains('modal-bg')) modal(''); },
  pickFile: () => $('fileInput').click(),
  view: d => { court.setView(d.v); document.querySelectorAll('[data-a=view]').forEach(b => b.classList.toggle('on', b.dataset.v === d.v)); },
  zones: (d, e) => { const on = court.toggleZones(); e.target.closest('button').classList.toggle('on', on); },
  play: () => (video.paused ? video.play() : video.pause()),
  seek: d => seekTo(video.currentTime + Number(d.d)),
  frame: d => { video.pause(); seekTo(video.currentTime + Number(d.d) / 25); },
  vzoom: d => zoomAt(+d.d > 0 ? 1.25 : 0.8, vstage.clientWidth / 2, vstage.clientHeight / 2),
  speed: d => { video.playbackRate = Number(d.v); document.querySelectorAll('[data-a=speed]').forEach(b => b.classList.toggle('on', b.dataset.v === d.v)); },
  layout: d => setLayout(d.v),
  sel: d => { pauseForInput(); ui.sel = ui.sel === d.id ? null : d.id; render(); },
  group: d => { ui.group = d.g === mainGroup() ? null : d.g; render(); },
  act: d => sendAct(d.skill, d.res),
  tempo: d => { ui.tempo = d.v; ui.setH = null; render(); },
  menuPick: d => menuPick(+d.k),
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
    const o = ui.lineupDraft.order, k = o.indexOf(d.id);
    if (k >= 0) o.splice(k, 1); else if (o.length < 6) o.push(d.id);
    paintLineup();
  },
  lserve: d => { ui.lineupDraft.weServe = d.v === '1'; paintLineup(); },
  lstart: () => {
    const d = ui.lineupDraft;
    const setter = d.order.includes(d.setter) ? d.setter : d.order.find(id => person(id).setter) ?? null;
    modal('');
    sendRaw({ t: 'set', lineup: d.order, weServe: d.weServe, ...(setter && { setter }) });
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
    if (e.key === 'Escape') modal('');
    if (e.key === 'Enter' && ui.lineupDraft?.order.length === 6 && $('modal').querySelector('[data-a=lstart]')) H.lstart();
    return;
  }
  if (e.ctrlKey || e.metaKey) { if (e.code === 'KeyZ') { e.preventDefault(); undo(); } return; }
  const c = e.code;
  if (c === 'Space') { e.preventDefault(); H.play(); return; }
  if (c === 'ArrowLeft' || c === 'ArrowRight') { e.preventDefault(); seekTo(video.currentTime + (c === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 15 : 5)); return; }
  if (c === 'Comma' || c === 'Period') { H.frame({ d: c === 'Comma' ? -1 : 1 }); return; }
  if (c === 'Escape') { closeMenu(); ui.draft = null; ui.setH = null; ui.sel = null; ui.pending = {}; ui.group = null; ui.edit = null; ui.editPoints = false; ui.sub = null; render(); return; }
  if (c === 'Backspace' || c === 'Delete') { e.preventDefault(); undo(); return; }
  if (c === 'KeyV') { const order = ['split', 'video', 'court']; setLayout(order[(order.indexOf($('viewport').dataset.layout) + 1) % 3]); return; }
  if (e.key === '?' || (c === 'Slash' && e.shiftKey)) { openHelp(); return; }
  if (!live()) return;
  if (ui.menu) { const d = /^(Digit|Numpad)([1-9])$/.exec(c); if (d) { menuPick(+d[2] - 1); return; } if (c === 'Enter') { menuPick(0); return; } }
  const cx = ctx();
  // X — мяч упал: не принял / не поднял (с игроком из отмеченного касания) или эйс/атака соперника без касания.
  if (c === 'KeyX') {
    const t = ui.draft?.touch;
    if (t) { ui.draft = null; postAct({ skill: t.kind, res: 'error', p: t.p, to: t.at, ...(t.from && { from: t.from }) }).then(resume); }
    else if (cx?.stage === 'rec') sendAct('team', 'oppAce');
    else if (cx?.stage === 'their') sendAct('team', 'oppKill');
    return;
  }
  // На шаге паса Q/W/E — качество паса (уйдёт вместе с точкой), R — ошибка паса сразу.
  if (cx?.stage === 'set' && ['KeyQ', 'KeyW', 'KeyE'].includes(c)) {
    ui.draft = { ...ui.draft, set: { ...ui.draft?.set, p: cx.p, from: cx.from, q: { KeyQ: 'perfect', KeyW: 'good', KeyE: 'poor' }[c] } };
    render(); return;
  }
  if (cx?.stage === 'att' && c === 'KeyN') { ui.draft = null; postAct({ skill: 'att', res: 'error', p: cx.p, from: cx.from }).then(resume); return; }
  const digit = /^(Digit|Numpad)([1-6])$/.exec(c);
  if (digit) {
    const z = Number(digit[2]);
    const id = ui.st.set.lineup[ui.st.rally.zones.indexOf(z)];
    if (ui.sub) { if (!ui.sub.out) H.subOut({ id }); return; }
    if (cx && ['touch2', 'set', 'att'].includes(cx.stage)) { onCourtPick(posOf(id), { button: 0 }, { player: id }); return; }
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
