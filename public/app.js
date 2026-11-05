// Ручной PRO: экраны «Порядок подачи» и «Матч», открывается из карточки матча на главной.
// Всё состояние матча вычисляет engine.js из списка событий, который хранится на сервере.
import { replay, playerName, LABELS, setTitle } from './engine.js';
import { createSync, statusBadge } from './offline.js';

const $app = document.getElementById('app');
const ui = { view: 'home', matches: [], roster: [], settings: { teamName: 'Мы', opponents: [] }, match: null, st: null, sel: null, sub: null, lineup: [], weServe: true, busy: false };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

// Любой запрос к серверу: блокируем повторные нажатия и громко сообщаем, если не сохранилось.
async function call(fn) {
  if (ui.busy) return;
  ui.busy = true;
  try { await fn(); } catch (e) { alert('Не удалось связаться с компьютером. Действие НЕ сохранено.\n' + e.message); }
  ui.busy = false;
  render();
}

function setMatch(match) {
  const changed = ui.match?.id !== match.id;
  ui.match = match;
  ui.st = replay(match);
  if (changed) sync.attach(match); // другой матч — подхватываем его очередь (если что-то не ушло)
}

// Выбор игрока сбрасываем сразу, а не после ответа — иначе следующее нажатие могло бы потеряться.
const clearSel = () => { ui.sel = null; ui.sub = null; };
// Нажатия идут через очередь: без связи с ноутбуком применяются на экране и досылаются, когда связь вернётся.
const sync = createSync({ src: 'manual', getMatch: () => ui.match && { ...ui.match, events: [...ui.match.events] }, setMatch: m => { setMatch(m); render(); }, onStatus: statusBadge });
const sendEvent = ev => { clearSel(); sync.post(ev); };
const undo = () => {
  clearSel();
  sync.undo();
  if (!ui.st.set) { prepareLineup(); render(); } // отменили начало первой партии
};

const name = id => playerName(ui.match, id);
// Плитка игрока: крупно номер и мелко имя; если номера нет — крупно имя.
const face = p => (p.num ? `<span class="n">${esc(p.num)}</span><span class="nm">${esc(p.name)}</span>` : `<span class="n nm-big">${esc(p.name)}</span>`);
const byNum = (a, b) => a.num - b.num;

// ---------- Экраны ----------

function viewLineup() {
  const n = ui.st.sets.length + 1;
  return `
    <h1>${setTitle(n - 1, ui.st.format)} — ${esc(ui.match.opponent)}</h1>
    <p class="hint">Нажимайте игроков <b>в порядке подачи</b>: 1 — подаёт первым. Повторное нажатие убирает.</p>
    <div class="grid3">${[...ui.match.roster].sort(byNum).map(p => {
      const k = ui.lineup.indexOf(p.id);
      return `<button class="tile ${k >= 0 ? 'on' : ''}" data-a="pick" data-id="${p.id}">
        ${k >= 0 ? `<span class="ord">${k + 1}</span>` : ''}${face(p)}</button>`;
    }).join('')}</div>
    <h2>Кто подаёт первым?</h2>
    <div class="row">
      <button class="${ui.weServe ? 'on' : ''}" data-a="weServe" data-v="1">Мы</button>
      <button class="${!ui.weServe ? 'on' : ''}" data-a="weServe" data-v="0">Соперник</button>
    </div>
    <div class="row"><button data-a="${ui.st.sets.length ? 'live' : 'home'}">Назад</button>
      <button class="primary" data-a="startSet" ${ui.lineup.length === 6 ? '' : 'disabled'}>Начать (${ui.lineup.length}/6)</button></div>`;
}

// Цвета «светофора»: g — очко нам, y — в игре, но плохо, r — очко им, n — нейтрально, в игре.
function btn(cls, skill, res, text, p = null) {
  return `<button class="${cls}" data-a="act" data-skill="${skill}" data-res="${res}" ${p ? `data-p="${p}"` : ''}>${text}</button>`;
}

// Группы действий игрока. Главная группа зависит от фазы, остальные — под «Другое».
const GROUPS = {
  rec: p => ['Приём', [btn('g', 'rec', 'pp', '++', p), btn('y', 'rec', 'pm', '+', p), btn('n', 'rec', 'p', '−', p), btn('y', 'rec', 'over', 'Перекид', p), btn('r', 'rec', 'error', 'Не принял', p)]],
  att: p => ['Атака', [btn('g', 'att', 'kill', 'Забил', p), btn('g', 'att', 'bo', 'От блока', p), btn('n', 'att', 'play', 'В игре', p),
    btn('r', 'att', 'error', 'Аут / сетка', p), btn('r', 'att', 'blocked', 'Заблокир.', p)]],
  def: p => ['Защита и блок', [btn('g', 'blk', 'point', 'Блок: очко', p), btn('n', 'dig', 'plus', 'Защита +', p), btn('y', 'dig', 'minus', 'Защита −', p),
    btn('y', 'blk', 'touch', 'Касание блоком', p), btn('r', 'blk', 'out', 'Блок-аут', p), btn('r', 'dig', 'error', 'Не поднял', p)]],
  set: p => ['Пас', [btn('g', 'set', 'perfect', 'Идеальный', p), btn('n', 'set', 'good', 'Хороший', p), btn('y', 'set', 'poor', 'Неудобный', p), btn('n', 'set', 'over', 'Перевод к ним', p), btn('r', 'set', 'error', 'Ошибка паса', p)]],
  fault: p => ['Ошибки игры', [btn('r', 'fault', 'net', 'Сетка', p), btn('r', 'fault', 'line', 'Заступ', p), btn('r', 'fault', 'reach', 'На их стороне', p), btn('r', 'fault', 'four', 'Четыре касания', p), btn('r', 'fault', 'double', 'Двойное', p), btn('r', 'fault', 'catch', 'Захват', p), btn('r', 'fault', 'rot', 'Переход', p), btn('r', 'fault', 'back', 'Атака задней линии', p), btn('r', 'fault', 'error', 'Прочее', p)]],
};
const MAIN_GROUP = { rec: 'rec', ours: 'att', their: 'def', serve: 'def' };

const PHASES = {
  serve: { title: 'Наша подача', flip: 'over' },
  rec: { title: 'Приём', hint: 'Подают они — кто принял?', flip: 'back' },
  ours: { title: 'Мяч у нас', hint: 'Кто атакует?', flip: 'over' },
  their: { title: 'Мяч у них', hint: 'Кто защитил или блокировал?', flip: 'back' },
};

function viewLive() {
  const { set, rally, setsWon, log } = ui.st;
  const ph = PHASES[rally.phase];
  const last = log.at(-1);

  const team = [];
  if (rally.phase === 'serve') team.push(btn('g', 'serve', 'ace', 'Эйс', rally.server), btn('r', 'serve', 'error', 'Ошибка подачи', rally.server));
  // На приёме соперник может забить только эйсом, поэтому «Соперник забил» там не нужен.
  if (rally.phase === 'rec') team.push(btn('r', 'team', 'oppAce', 'Эйс соперника'), btn('g', 'team', 'oppError', 'Ошибка соперника'));
  else team.push(btn('g', 'team', 'oppError', 'Ошибка соперника'), btn('r', 'team', 'oppKill', 'Соперник забил'));

  const court = set.lineup.map(id => {
    const p = ui.match.roster.find(r => r.id === id) || {};
    const on = ui.sel === id || ui.sub?.out === id;
    return `<button class="tile ${on ? 'on' : ''}" data-a="${ui.sub ? 'subOut' : 'sel'}" data-id="${id}">
      ${rally.server === id ? '<span class="ball">🏐</span>' : ''}${face(p)}</button>`;
  }).join('');

  return `
    <div class="score">
      <div><div class="num">${set.us}</div>${esc(ui.settings.teamName)}</div>
      <div class="mid">Партия ${set.n + 1}<br>сеты ${setsWon.us}:${setsWon.them}</div>
      <div style="text-align:right"><div class="num">${set.them}</div>${esc(ui.match.opponent)}</div>
    </div>
    <button class="phase ph-${rally.phase}" data-a="flip">
      <span><b>${ph.title}</b><small>${rally.phase === 'serve' ? `Подаёт ${esc(name(rally.server))}` : ph.hint}</small></span>
      <span class="flip">⇄</span>
    </button>
    <div class="last ${last?.side || ''}">${last ? esc(last.text) : '&nbsp;'}</div>
    <div class="team">${team.join('')}</div>
    ${ui.sub ? '<p class="hint">Замена: выберите, <b>кто уходит</b></p>' : ''}
    <div class="grid3">${court}</div>
    ${ui.sel ? viewSheet(MAIN_GROUP[rally.phase]) : ''}
    ${ui.sub?.out ? viewBench() : ''}
    <div class="tools">
      <button data-a="undo" ${ui.match.events.length ? '' : 'disabled'}>↶ Отмена</button>
      <button data-a="sub" class="${ui.sub ? 'on' : ''}">⇄ Замена</button>
      <button data-a="pt" data-side="us">+1 нам</button>
      <button data-a="pt" data-side="them">+1 им</button>
      <button data-a="home">Главная</button>
    </div>
    <div class="row"><button data-a="timeout" data-side="us">⏸ Тайм-аут наш</button><button data-a="timeout" data-side="them">⏸ Тайм-аут их</button></div>
    <p class="hint">⇄ на плашке фазы — поменять сторону мяча, если программа ошиблась. «+1» — очко без статистики.</p>
    <div class="log">${log.slice(-5, -1).reverse().map(l => `<div class="${l.side || ''}">${esc(l.text)}</div>`).join('')}</div>
    ${set.over ? viewSetOver() : ''}`;
}

function viewSheet(main) {
  const p = ui.sel;
  const group = key => {
    const [lbl, items] = GROUPS[key](p);
    return `<div class="lbl">${lbl}</div><div class="acts ${items.length === 4 ? 'two' : ''}">${items.join('')}</div>`;
  };
  const others = Object.keys(GROUPS).filter(k => k !== main);
  return `<div class="card sheet">
    <h3>${esc(name(p))}</h3>
    ${group(main)}
    ${ui.more ? others.map(group).join('') : ''}
    <div class="row"><button data-a="more">${ui.more ? 'Скрыть' : 'Другое…'}</button><button data-a="unsel">Закрыть</button></div>
  </div>`;
}

function viewBench() {
  const bench = ui.match.roster.filter(p => !ui.st.set.lineup.includes(p.id)).sort(byNum);
  return `<div class="card"><p class="hint">Кто выходит вместо ${esc(name(ui.sub.out))}?</p>
    <div class="grid3">${bench.map(p => `<button class="tile" data-a="subIn" data-id="${p.id}">${face(p)}</button>`).join('')}</div></div>`;
}

function viewSetOver() {
  const { set, setsWon, matchOver } = ui.st;
  return `<div class="overlay"><div class="card">
    <div>${matchOver ? `Матч окончен · сеты ${setsWon.us}:${setsWon.them}` : `Партия ${set.n + 1} окончена`}</div>
    <div class="big">${set.us} : ${set.them}</div>
    <div class="col">
      ${matchOver ? '' : `<button class="primary" data-a="nextSet">${setTitle(set.n + 1, ui.st.format)}</button>`}
      <button data-a="undo">↶ Отменить последнее очко</button>
      <button data-a="home">На главную</button>
    </div></div></div>`;
}

function render() {
  if (!ui.match) { $app.innerHTML = ''; return; }
  const views = { lineup: viewLineup, live: viewLive };
  $app.innerHTML = views[ui.view]();
}

// ---------- Обработка нажатий ----------

const goHome = () => { location.href = '/'; };

function prepareLineup() {
  const last = ui.st.sets.at(-1);
  ui.lineup = last ? last.start.filter(id => ui.match.roster.some(p => p.id === id)) : [];
  ui.weServe = true;
  ui.view = 'lineup';
}

async function openMatch(id) {
  const match = await api('GET', `/api/matches/${id}?src=manual`);
  if (!match) return goHome();
  setMatch(match);
  ui.sel = null; ui.sub = null;
  if (ui.st.set) ui.view = 'live';
  else prepareLineup();
}

const handlers = {
  home: goHome,
  live: () => { ui.view = 'live'; render(); },
  pick: d => {
    const k = ui.lineup.indexOf(d.id);
    if (k >= 0) ui.lineup.splice(k, 1);
    else if (ui.lineup.length < 6) ui.lineup.push(d.id);
    render();
  },
  weServe: d => { ui.weServe = d.v === '1'; render(); },
  startSet: () => { sync.post({ t: 'set', lineup: ui.lineup, weServe: ui.weServe }); ui.view = 'live'; render(); },
  nextSet: () => { prepareLineup(); render(); },
  sel: d => { ui.sel = ui.sel === d.id ? null : d.id; ui.more = false; render(); },
  unsel: () => { ui.sel = null; render(); },
  more: () => { ui.more = !ui.more; render(); },
  flip: () => sendEvent({ t: 'act', skill: 'team', res: PHASES[ui.st.rally.phase].flip, p: null }),
  act: d => sendEvent({ t: 'act', skill: d.skill, res: d.res, p: d.p || null }),
  pt: d => sendEvent({ t: 'pt', side: d.side }),
  timeout: d => sendEvent({ t: 'timeout', side: d.side }),
  undo: () => undo(),
  sub: () => { ui.sub = ui.sub ? null : { out: null }; ui.sel = null; render(); },
  subOut: d => { ui.sub.out = d.id; render(); },
  subIn: d => sendEvent({ t: 'sub', out: ui.sub.out, in: d.id }),
};

$app.addEventListener('click', e => {
  const el = e.target.closest('[data-a]');
  if (el && !el.disabled) handlers[el.dataset.a](el.dataset);
});

// Ручной PRO открывается из карточки матча; без матча — на главную.
const hashId = location.hash.match(/m=([a-z0-9]+)/)?.[1];
if (!hashId) goHome();
else call(async () => {
  [ui.settings] = await Promise.all([api('GET', '/api/settings')]);
  await openMatch(hashId);
});
