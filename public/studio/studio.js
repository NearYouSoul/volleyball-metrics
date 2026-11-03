// Студия — десктопная программа для разбора матча по видео и детальной статистики.
// Состояние матча, как и везде, вычисляет engine.js из списка событий на сервере;
// здесь — только интерфейс: видео, 3D-площадка, ввод касаний, правка и вставка событий.
import { replay, playerName, LABELS, ACTIONS, SKILLS } from '../engine.js';
import { ZONE_SPOT, DEFAULT_SPOT, TEMPOS, SYSTEMS, guessSetter, zoneOf, SET_DIRS, setDir, NET } from '../court.js';
import { createCourt3D } from './court3d.js';

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
  if (ui.pending.to) ev.to = ui.pending.to;
  if (ui.pending.from) ev.from = ui.pending.from;
  if (skill === 'set') { ev.tempo = ui.tempo; if (ui.h) ev.h = ui.h; }
  ui.sel = null; ui.pending = {}; ui.group = null; ui.h = null;
  postEvent(ev).then(resume);
}
const sendRaw = ev => { ui.sel = null; ui.pending = {}; ui.group = null; postEvent(stamp(ev)).then(resume); };
function resume() { if (ui.resumeAfter) { ui.resumeAfter = false; video.play().catch(() => {}); } }
function pauseForInput() {
  if ($('autoPause').checked && video.src && !video.paused) { video.pause(); ui.resumeAfter = true; }
}

function undo() {
  if (!ui.match?.events.length) return;
  if (ui.insertAt !== null) {
    if (ui.insertAt === 0) return;
    const k = ui.insertAt - 1;
    return call(async () => { setMatch(await api('DELETE', `/api/matches/${ui.match.id}/events/${k}`)); ui.insertAt = k; recompute(); });
  }
  ui.sel = null; ui.pending = {};
  call(async () => setMatch(await api('DELETE', `/api/matches/${ui.match.id}/events/last`)));
}

// ---------- 3D-площадка ----------
const court = createCourt3D($('court3d'), {
  onPick: (p, e) => {
    if (!ui.match) return;
    const key = e.shiftKey || e.altKey ? 'from' : 'to';
    // Правка точек выбранного события.
    if (ui.editPoints && ui.edit !== null) {
      const ev = { ...ui.match.events[ui.edit], [key]: p };
      return call(async () => setMatch(await api('PUT', `/api/matches/${ui.match.id}/events/${ui.edit}`, ev)));
    }
    pauseForInput();
    ui.pending = { ...ui.pending, [key]: p };
    // Касание на нашей половине без выбранного игрока: подставляем ближайшего (приём, защита).
    if (key === 'to' && !ui.sel && live() && p.y < NET && ['rec', 'def'].includes(group())) {
      let best = null, bd = 1e9;
      ui.st.set.lineup.forEach((id, k) => {
        const s = ZONE_SPOT[ui.st.rally.zones[k]];
        const d = Math.hypot(s.x - p.x, s.y - p.y);
        if (d < bd) { bd = d; best = id; }
      });
      ui.sel = best;
    }
    render();
  },
  onHover: p => {
    const el = $('courtHover');
    if (!p) return el.classList.remove('on');
    el.classList.add('on');
    el.textContent = `${p.y < NET ? 'наша' : 'их'} зона ${p.zone ?? '—'} · x ${p.x.toFixed(1)} · y ${p.y.toFixed(1)}`;
  },
});

const RES_COLOR = { us: 0x59d499, them: 0xff6363, null: 0xf2f2f2 };
const outcomeOf = pl => ACTIONS[pl.skill]?.[pl.res] ?? null;
const colorOf = pl => (pl.skill === 'set' ? (pl.won === true ? 0x59d499 : pl.won === false ? 0xff6363 : 0xf0c85a) : RES_COLOR[outcomeOf(pl)]);

// Точка, где игрок стоит по расстановке (для траекторий без кликов).
function spotOf(pl) { return pl.zone ? ZONE_SPOT[pl.zone] : null; }

// Траектории розыгрыша по касаниям. Для пропущенных точек берём разумные значения по умолчанию.
function trailsFor(plays) {
  const out = [];
  let lastSetTo = null;
  for (const pl of plays) {
    const c = colorOf(pl);
    if (pl.skill === 'serve' && pl.to) out.push({ from: pl.from ?? DEFAULT_SPOT.serveUs, to: pl.to, y0: 2.7, y1: 0.4, apex: 4.4, color: 0x63a1ff });
    if (pl.skill === 'rec' && pl.to) out.push({ from: pl.from ?? DEFAULT_SPOT.serveThem, to: pl.to, y0: 2.7, y1: 0.7, apex: 4.2, color: 0xf0c85a, opacity: 0.55 });
    if (pl.skill === 'dig' && pl.to && pl.from) out.push({ from: pl.from, to: pl.to, y0: 3.0, y1: 0.6, apex: 3.2, color: 0xf0c85a, opacity: 0.55 });
    if (pl.skill === 'set') {
      const to = pl.to ?? (pl.target ? spotOfTarget(pl) : null);
      if (to) {
        out.push({ from: pl.from ?? DEFAULT_SPOT.setter, to, y0: 2.5, y1: 3.0, apex: pl.h ?? TEMPOS[pl.tempo]?.h ?? 4.2, color: c, opacity: pl.virtual ? 0.35 : 0.9, width: 0.03 });
        lastSetTo = to;
      }
    }
    if (pl.skill === 'att' && pl.to) {
      const from = pl.from ?? lastSetTo ?? spotOf(pl) ?? { x: 4.5, y: 7.5 };
      out.push({ from, to: pl.to, y0: 3.1, y1: 0.12, apex: 3.25, color: c, width: 0.045 });
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

// Какой розыгрыш показывать на площадке: выбранного события, текущий или последний сыгранный.
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

function paintCourt() {
  const st = ui.st;
  if (live()) {
    const gs = guessedSetter();
    court.setPlayers(st.set.lineup.map((id, k) => {
      const zone = st.rally.zones[k];
      const server = st.rally.phase === 'serve' && st.rally.server === id;
      const p = person(id);
      return { id, label: p.num || (p.name || '?').slice(0, 2), spot: server ? { x: 7.6, y: -0.9 } : ZONE_SPOT[zone], setter: id === gs, selected: ui.sel === id, server };
    }));
  } else court.setPlayers([]);
  court.setPending(ui.editPoints && ui.edit !== null ? { from: ui.match.events[ui.edit]?.from, to: ui.match.events[ui.edit]?.to } : ui.pending);
  const trails = trailsFor(focusPlays());
  // Предпросмотр паса: траектория из точки связующего в отмеченную точку с выбранной высотой.
  if (live() && group() === 'set' && ui.pending.to) {
    trails.push({ from: ui.pending.from ?? DEFAULT_SPOT.setter, to: ui.pending.to, y0: 2.5, y1: 3.0, apex: ui.h ?? TEMPOS[ui.tempo].h, color: 0xffffff, width: 0.04 });
  }
  court.setTrails(trails);
  // Точки прошлых касаний того же навыка в этом матче — видно, куда обычно летит.
  const sk = DISPLAY_SKILL[group()];
  court.setDots(sk && ui.full ? ui.full.plays.filter(p => p.skill === sk && p.to && !p.virtual).map(p => ({ ...p.to, color: colorOf(p), opacity: 0.55 })) : []);
}

// ---------- Отрисовка ----------
function paintTop() {
  const m = ui.match, st = ui.st;
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
      <span>Клик по площадке — <b>куда</b>, Shift+клик — <b>откуда</b></span>
    </div>
  </div>`;

  // Справа: точки, пас, команда.
  const pt = (k, cls, label) => ui.pending[k] ? `<span class="${cls}"><i></i>${label}: зона ${zoneOf(ui.pending[k]) ?? '—'}${ui.pending[k].y >= NET ? ' (их)' : ''}<button data-a="clearPt" data-k="${k}">${icon('i-x')}</button></span>` : '';
  const points = pt('to', 'to', 'Куда') + pt('from', 'from', 'Откуда');
  const setCtl = g === 'set' ? `
    <div class="lbl">Темп паса</div>
    <div class="tempo">${Object.entries(TEMPOS).map(([k, t]) => `<button class="${ui.tempo === k ? 'on' : ''}" data-a="tempo" data-v="${k}" title="${t.label}">${t.short} · ${t.label.split(' (')[0]}</button>`).join('')}</div>
    <div class="lbl">Высота траектории <b>${(ui.h ?? TEMPOS[ui.tempo].h).toFixed(1)} м</b></div>
    <input type="range" min="2.6" max="9" step="0.1" value="${ui.h ?? TEMPOS[ui.tempo].h}" data-k="setH">
    ${ui.pending.to ? `<div class="muted" style="margin-top:6px">Направление: <b>${SET_DIRS[setDir(ui.pending.to)] ?? '—'}</b></div>` : '<div class="muted" style="margin-top:6px;font-size:12px;color:var(--smoke)">Кликните по площадке, куда отдан пас — появится траектория.</div>'}` : '';
  const teamActs = st.rally.phase === 'rec'
    ? `<button class="act r" data-a="act" data-skill="team" data-res="oppAce">Эйс соперника</button><button class="act g" data-a="act" data-skill="team" data-res="oppError">Ошибка соперника <span class="kbd">+</span></button>`
    : `<button class="act g" data-a="act" data-skill="team" data-res="oppError">Ошибка соперника <span class="kbd">+</span></button><button class="act r" data-a="act" data-skill="team" data-res="oppKill">Соперник забил <span class="kbd">−</span></button>`;
  const right = `<div class="ctx">
    <h4>Точки и траектория</h4>
    <div class="points">${points || '<span>Точки не отмечены — не обязательно</span>'}</div>
    ${setCtl}
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
    <span style="min-width:0"><b title="${esc(v.name)}">${esc(v.name)}</b><small>${v.duration ? fmtShort(v.duration) + ' · ' : ''}${mb(v.size)} · ${new Date(v.created).toLocaleDateString('ru')}</small></span>
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
    <div class="dropzone" data-a="pickFile">${icon('i-upload')}<b>Добавить видео</b>Перетащите файл сюда или в любое место окна. Файл копируется в data/videos — исходник можно удалить.</div>
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
  if (ui.editPoints && ui.edit !== null) hint.push('<span><b>Правка точек</b> события №' + (ui.edit + 1) + ' — клик: куда, Shift+клик: откуда</span>');
  else if (live()) {
    const g = GROUPS[group()];
    hint.push(`<span>Сейчас: <b>${g.label}</b></span>`);
    if (ui.sel) hint.push(`<span><b>${esc(name(ui.sel))}</b></span>`);
  }
  $('courtHint').innerHTML = hint.join('');
}

function render() {
  paintTop();
  paintDock();
  paintSide();
  paintTimeline();
  paintHud();
  if (ui.match) paintCourt(); else { court.setPlayers([]); court.setTrails([]); court.setDots([]); court.setPending({}); }
}

// ---------- Модальные окна ----------
function modal(html) { $('modal').innerHTML = html ? `<div class="modal-bg" data-a="modalBg"><div class="modal">${html}</div></div>` : ''; }
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
      ${k(['←', '→'], 'назад / вперёд 2 с (с Shift — 5 с)')}
      ${k([',', '.'], 'кадр назад / вперёд')}
      ${k(['1', '…', '6'], 'выбрать игрока по номеру зоны')}
      ${k(['A', 'S', 'D', 'F', 'G', 'H'], 'группа: подача, приём, пас, атака, защита/блок, ошибка')}
      ${k(['Q', 'W', 'E', 'R', 'T', 'Y'], 'действие в группе (подсказка на кнопке)')}
      ${k(['+', '−'], 'ошибка соперника / соперник забил')}
      ${k(['Z'], 'темп паса по кругу: 1т → 2т → 3т')}
      ${k(['⌫'], 'отменить последнее (в режиме вставки — последнее вставленное)')}
      ${k(['Esc'], 'снять выбор, точки, правку')}
      ${k(['V'], 'раскладка: видео / обе / площадка')}
      ${k(['?'], 'эта справка')}
    </div>
    <div class="foot"><button class="btn primary" data-a="modalClose">Понятно</button></div>`);
}

// ---------- Видео ----------
function openVideo(id, { keepTime = false } = {}) {
  const v = ui.videos.find(x => x.id === id);
  if (!v) return;
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
      toast(`Видео «${file.name}» в библиотеке`);
      if (ui.match) { await linkVideo(res.id); openVideo(res.id); } else render();
    };
    xhr.onerror = () => { u.err = 'Не удалось скопировать'; render(); };
    xhr.send(file);
  }
  ui.tab = 'video';
  render();
}
async function linkVideo(id) {
  const videos = [...new Set([...(ui.match.videos || []), id])];
  setMatch(await api('PATCH', `/api/matches/${ui.match.id}`, { videos }));
}

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
  speed: d => { video.playbackRate = Number(d.v); document.querySelectorAll('[data-a=speed]').forEach(b => b.classList.toggle('on', b.dataset.v === d.v)); },
  layout: d => setLayout(d.v),
  sel: d => { pauseForInput(); ui.sel = ui.sel === d.id ? null : d.id; render(); },
  group: d => { ui.group = d.g === mainGroup() ? null : d.g; render(); },
  act: d => sendAct(d.skill, d.res),
  tempo: d => { ui.tempo = d.v; ui.h = null; render(); },
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
  createMatch: d => call(async () => { modal(''); setMatch(await api('POST', '/api/matches', { opponentId: d.id })); ui.matches = await api('GET', '/api/matches'); recompute(); openLineup(); }),
  createNewOpp: () => {
    const nm = $('newOpp').value.trim();
    if (!nm) return;
    const same = ui.settings.opponents.find(o => o.name.trim().toLowerCase() === nm.toLowerCase());
    if (same) return H.createMatch({ id: same.id });
    const opp = { id: newId(), name: nm };
    call(async () => {
      ui.settings = await api('PUT', '/api/settings', { opponents: [...ui.settings.opponents, opp] });
      modal('');
      setMatch(await api('POST', '/api/matches', { opponentId: opp.id }));
      ui.matches = await api('GET', '/api/matches');
      recompute();
      openLineup();
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
    ui.h = Number(e.target.value);
    e.target.previousElementSibling.querySelector('b').textContent = ui.h.toFixed(1) + ' м';
    paintCourt();
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
  if (c === 'ArrowLeft' || c === 'ArrowRight') { e.preventDefault(); seekTo(video.currentTime + (c === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 2)); return; }
  if (c === 'Comma' || c === 'Period') { H.frame({ d: c === 'Comma' ? -1 : 1 }); return; }
  if (c === 'Escape') { ui.sel = null; ui.pending = {}; ui.group = null; ui.edit = null; ui.editPoints = false; ui.sub = null; render(); return; }
  if (c === 'Backspace' || c === 'Delete') { e.preventDefault(); undo(); return; }
  if (c === 'KeyV') { const order = ['split', 'video', 'court']; setLayout(order[(order.indexOf($('viewport').dataset.layout) + 1) % 3]); return; }
  if (e.key === '?' || (c === 'Slash' && e.shiftKey)) { openHelp(); return; }
  if (!live()) return;
  const digit = /^(Digit|Numpad)([1-6])$/.exec(c);
  if (digit) {
    const z = Number(digit[2]);
    const id = ui.st.set.lineup[ui.st.rally.zones.indexOf(z)];
    if (ui.sub) { if (!ui.sub.out) H.subOut({ id }); return; }
    H.sel({ id });
    return;
  }
  if (c === 'Equal' || c === 'NumpadAdd') { sendAct('team', 'oppError'); return; }
  if (c === 'Minus' || c === 'NumpadSubtract') { sendAct('team', ui.st.rally.phase === 'rec' ? 'oppAce' : 'oppKill'); return; }
  if (c === 'KeyZ') { const ks = Object.keys(TEMPOS); ui.tempo = ks[(ks.indexOf(ui.tempo) + 1) % ks.length]; ui.h = null; render(); return; }
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

// ---------- Старт ----------
setLayout(store.get('layout', 'split'));
$('viewport').style.setProperty('--split', store.get('split', 58) + '%');
call(async () => {
  await loadAll();
  const id = location.hash.match(/m=([a-z0-9]+)/)?.[1] ?? store.get('lastMatch', null) ?? ui.matches[0]?.id;
  if (id && ui.matches.some(m => m.id === id)) await openMatch(id);
  else ui.tab = 'match';
});
// Дашборд и телефон могут менять данные — подтягиваем список матчей, когда окно снова в фокусе.
addEventListener('focus', () => { if (!ui.busy) loadAll().then(() => ui.match && api('GET', `/api/matches/${ui.match.id}`)).then(m => { if (m) setMatch(m); render(); }).catch(() => {}); });
