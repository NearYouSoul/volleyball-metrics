// Пульт быстрой статистики: сначала КТО закончил розыгрыш, потом ЧЕМ. Счёт и подача считаются сами.
// Экраны: «Матчи», «Соперник», «Кто подаёт первым», «Матч».
// На ноутбуке всё можно делать с клавиатуры: цифра — игрок, буква — результат, Backspace — отмена.
import { replayQuick, RESULTS, PLAYER_POINTS, PLAYER_ERRORS } from './quick-engine.js';
import { playerName, setTitle, formatOptions, formatKey, pickFormat } from './engine.js';
import { createSync, statusBadge } from './offline.js';

const $app = document.getElementById('app');
const ui = { view: 'home', matches: [], roster: [], settings: { teamName: 'Мы', opponents: [] }, match: null, st: null, sel: null, busy: false };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// crypto.randomUUID недоступен по http в локальной сети, поэтому простой id.
const newId = () => Math.random().toString(36).slice(2, 8);

// Клавиши результатов. Физические клавиши (e.code), чтобы работало и в русской раскладке.
const KEYS = { kill: 'Q', block: 'W', ace: 'E', srvErr: 'A', attErr: 'S', blocked: 'D', recErr: 'F', digErr: 'G', fault: 'H', lost: 'J', oppErr: '+', oppKill: '−' };
const CODE_TO_RES = { KeyQ: 'kill', KeyW: 'block', KeyE: 'ace', KeyA: 'srvErr', KeyS: 'attErr', KeyD: 'blocked', KeyF: 'recErr', KeyG: 'digErr', KeyH: 'fault', KeyJ: 'lost' };

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

// Любой запрос к серверу: блокируем повторные нажатия и громко сообщаем, если не сохранилось.
async function call(fn) {
  if (ui.busy) return;
  ui.busy = true;
  try { await fn(); } catch (e) { alert('Нет связи с ноутбуком — действие не сохранено. Проверьте Wi-Fi и нажмите ещё раз.\n' + e.message); }
  ui.busy = false;
  render();
}

let pushed = false; // запись истории «матч» создали мы — выходить из матча можно кнопкой «Назад» браузера
function setMatch(match) {
  const changed = ui.match?.id !== match.id;
  ui.match = match;
  ui.st = replayQuick(match);
  if (location.hash !== '#m=' + match.id) { location.hash = 'm=' + match.id; pushed = true; }
  if (changed) sync.attach(match);
}

// Нажатия идут через очередь: без связи с ноутбуком очки считаются на экране и досылаются, когда связь вернётся.
const sync = createSync({ getMatch: () => ui.match && { ...ui.match, events: [...ui.match.events] }, setMatch: m => { setMatch(m); render(); }, onStatus: statusBadge });
const send = ev => { ui.sel = null; sync.post(ev); };
const undo = () => {
  ui.sel = null;
  sync.undo();
  if (!ui.st.set) { ui.view = 'serveFirst'; render(); } // отменили начало первой партии
};

const date = iso => new Date(iso).toLocaleDateString('ru', { day: 'numeric', month: 'long' });
const sortedRoster = () => [...ui.match.roster].sort((a, b) => a.num - b.num || a.name.localeCompare(b.name));
const kbd = k => `<span class="kbd">${k}</span>`;

// Что может случиться в этом розыгрыше: эйс и ошибка подачи — только на нашей подаче,
// ошибка приёма — только на подаче соперника.
const SERVE_ONLY = { ace: 'us', srvErr: 'us', recErr: 'them' };
const possible = res => !!RESULTS[res] && (!SERVE_ONLY[res] || SERVE_ONLY[res] === ui.st.set.serving);
const back = (action, text) => `<button class="btn btn-ghost btn-sm -ml-3 gap-1" data-a="${action}">
  <svg viewBox="0 0 20 20" class="size-4" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m12 5-5 5 5 5"/></svg>${text}</button>`;

function result(key, p = null, cls = '') {
  const r = RESULTS[key];
  return `<button class="btn ${r.side === 'us' ? 'btn-us' : 'btn-them'} min-h-14 px-3 font-semibold justify-center pointer-fine:justify-between ${cls}"
    data-a="end" data-res="${key}" ${p ? `data-p="${p}"` : ''}><span>${r.label}</span>${kbd(KEYS[key])}</button>`;
}

// ---------- Экраны ----------

function viewHome() {
  return `
    <nav class="flex items-center justify-between">
      <a class="btn btn-ghost btn-sm -ml-3 gap-2" href="/"><img src="img/logo.svg" alt="" class="size-5 rounded-[5px]">Режимы</a>
      <a class="btn btn-ghost btn-sm -mr-3" href="quick-stats.html">Дашборд</a>
    </nav>
    <h1 class="mt-6 text-[32px] leading-tight font-normal">Быстрая статистика</h1>
    <p class="mt-1 text-ash">${esc(ui.settings.teamName)}, в составе ${ui.roster.length} ${plural(ui.roster.length, 'игрок', 'игрока', 'игроков')}</p>
    <button class="btn btn-primary mt-6 w-full min-h-14 text-base" data-a="pickOpponent">Начать матч</button>
    <h2 class="mt-10 mb-3 text-sm font-medium text-ash">Матчи</h2>
    <div class="grid gap-2">
      ${ui.matches.map(m => `
        <div class="surface flex items-center gap-2 py-1.5 pr-1.5 pl-4">
          <button class="min-w-0 flex-1 cursor-pointer py-2 text-left" data-a="open" data-id="${m.id}">
            <span class="block truncate font-medium">${esc(m.opponent)}</span>
            <span class="block text-[13px] text-smoke">${date(m.created)}${m.over ? '' : ', идёт'}</span>
          </button>
          <span class="num px-2 text-xl ${m.over ? (m.setsWon.us > m.setsWon.them ? 'text-mint' : 'text-coral') : 'text-white'}">${m.setsWon.us}:${m.setsWon.them}</span>
          <button class="btn btn-ghost btn-sm w-9 px-0" data-a="del" data-id="${m.id}" aria-label="Удалить матч">
            <svg viewBox="0 0 20 20" class="size-4" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>
          </button>
        </div>`).join('') || '<p class="text-sm text-smoke">Матчей пока нет. Нажмите «Начать матч» перед первой подачей.</p>'}
    </div>`;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

function viewPickOpponent() {
  return `
    <nav>${back('home', 'Матчи')}</nav>
    <h1 class="mt-6 text-[32px] leading-tight font-normal">С кем играем?</h1>
    <label class="mt-4 grid gap-1.5 text-sm text-ash">Формат матча
      <select id="fmt" class="field">${formatOptions(formatKey(ui.settings.lastFormat))}</select></label>
    <div class="mt-6 grid gap-2">
      ${ui.settings.opponents.map(o => `<button class="btn min-h-14 justify-start px-5 text-base" data-a="newMatch" data-id="${o.id}">${esc(o.name)}</button>`).join('')}
    </div>
    <h2 class="mt-8 mb-3 text-sm font-medium text-ash">Новая команда</h2>
    <div class="grid gap-2">
      <input id="newOpp" class="field" placeholder="Название команды" autocomplete="off">
      <button class="btn btn-primary min-h-12" data-a="newOpponentMatch">Добавить и начать матч</button>
    </div>`;
}

function viewServeFirst() {
  const n = ui.st.sets.length;
  return `
    <nav>${back('home', 'Матчи')}</nav>
    <p class="mt-6 text-sm text-ash">${esc(ui.settings.teamName)} против ${esc(ui.match.opponent)}</p>
    <h1 class="mt-1 text-[32px] leading-tight font-normal">${setTitle(n, ui.st.format)}</h1>
    <p class="mt-6 mb-3 text-ash">Кто подаёт первым?</p>
    <div class="grid grid-cols-2 gap-3">
      <button class="btn btn-primary min-h-24 flex-col gap-1 text-lg" data-a="startSet" data-v="1">Мы ${kbd('1')}</button>
      <button class="btn min-h-24 flex-col gap-1 text-lg" data-a="startSet" data-v="0">Соперник ${kbd('2')}</button>
    </div>`;
}

function viewBoard() {
  const { set, setsWon, sets } = ui.st;
  // У подающей команды — светлая плашка «Подача» с мячом; у второй на её месте пусто, чтобы счёт не прыгал.
  const ball = `<svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
    <circle cx="8" cy="8" r="6.5"/><path d="M8 1.5c-1.8 2-2.2 5-.6 7.4M2.2 5.5c2.6-.6 5.3.3 7 2.5M5 13.9c.4-2.8 2.4-5 5-5.9"/></svg>`;
  const side = (name, pts, serving, align) => `
    <div class="min-w-0 ${align}">
      <div class="truncate text-sm ${serving ? 'text-white' : 'text-ash'}">${name}</div>
      <div class="num mt-1 text-[76px] leading-[0.9] font-normal tracking-[0.004em] ${serving ? '' : 'text-white/70'}">${pts}</div>
      <div class="mt-3 h-7">${serving ? `<span class="inline-flex h-7 items-center gap-1.5 rounded-full bg-mist px-3 text-[13px] font-semibold text-iron">${ball}Подача</span>` : ''}</div>
    </div>`;
  const done = sets.filter(s => s.over && s !== set).map(s => `<span class="${s.us > s.them ? 'text-mint' : 'text-coral'}">${s.us}:${s.them}</span>`).join(' ');
  return `
    <section class="surface px-5 pt-4 pb-5" aria-label="Счёт">
      <div class="flex items-center justify-between text-[13px] text-smoke">
        <span>${setTitle(set.n, ui.st.format, set.target).replace(/ \(до \d+\)/, '')}, до ${set.target}</span>
        <span class="num">${done || `сеты ${setsWon.us}:${setsWon.them}`}</span>
      </div>
      <div class="mt-3 grid grid-cols-2 gap-4">
        ${side(esc(ui.settings.teamName), set.us, set.serving === 'us', '')}
        ${side(esc(ui.match.opponent), set.them, set.serving === 'them', 'text-right')}
      </div>
    </section>`;
}

function viewLive() {
  const { set, log } = ui.st;
  const last = log.at(-1);
  const tiles = sortedRoster().map((p, i) => `
    <button class="relative flex min-h-16 cursor-pointer flex-col items-center justify-center rounded-xl px-1 py-2 transition-transform duration-75 active:translate-y-px
      ${ui.sel === p.id ? 'bg-mist text-iron shadow-[var(--shadow-lift)]' : 'bg-well shadow-[var(--shadow-key)]'}" data-a="sel" data-id="${p.id}" aria-pressed="${ui.sel === p.id}">
      ${i < 10 ? `<span class="kbd absolute top-1.5 left-1.5">${(i + 1) % 10}</span>` : ''}
      ${p.num ? `<span class="num text-2xl font-medium leading-tight">${esc(p.num)}</span><span class="max-w-full truncate text-xs ${ui.sel === p.id ? 'text-iron' : 'text-ash'}">${esc(p.name)}</span>`
              : `<span class="max-w-full truncate text-[17px] font-semibold">${esc(p.name)}</span>`}
    </button>`).join('');

  const dock = ui.sel
    ? `<div class="flex items-baseline justify-between">
         <span class="text-lg font-medium">${esc(playerName(ui.match, ui.sel))}</span>
         <button class="btn btn-ghost btn-sm -mr-2 gap-2" data-a="sel" data-id="${ui.sel}">Другой игрок ${kbd('Esc')}</button>
       </div>
       <p class="mt-3 mb-2 flex items-center gap-2 text-[13px] text-ash"><span class="size-1.5 rounded-full bg-mint"></span>Очко нам</p>
       <div class="grid ${PLAYER_POINTS.filter(possible).length === 2 ? 'grid-cols-2' : 'grid-cols-3'} gap-2">${PLAYER_POINTS.filter(possible).map(k => result(k, ui.sel)).join('')}</div>
       <p class="mt-3 mb-2 flex items-center gap-2 text-[13px] text-ash"><span class="size-1.5 rounded-full bg-coral"></span>Очко им</p>
       <div class="grid grid-cols-3 gap-2">${PLAYER_ERRORS.filter(possible).map(k => result(k, ui.sel)).join('')}</div>`
    : `<p class="text-lg font-medium">Кто закончил розыгрыш?</p>
       <p class="mt-1 mb-3 text-sm text-ash">Выберите игрока выше. Если игрок ни при чём:</p>
       <div class="grid grid-cols-2 gap-2">${result('oppErr', null, 'min-h-16 text-base')}${result('oppKill', null, 'min-h-16 text-base')}</div>`;

  return `
    <nav class="mb-3 flex items-center justify-between">
      ${back('home', 'Матчи')}
      <a class="btn btn-ghost btn-sm -mr-3" href="quick-stats.html#m=${ui.match.id}">Дашборд</a>
    </nav>
    ${viewBoard()}
    <div class="my-3 flex min-h-11 items-center gap-3">
      <p class="min-w-0 flex-1 truncate text-[15px] font-medium ${last?.side === 'us' ? 'text-mint' : last?.side === 'them' ? 'text-coral' : 'text-smoke'}">${last ? esc(last.text) : ''}</p>
      <button class="btn btn-sm gap-2" data-a="undo" ${ui.match.events.length ? '' : 'disabled'}>Отменить ${kbd('⌫')}</button>
    </div>
    <div class="grid grid-cols-3 gap-2">${tiles}</div>
    <div class="${ui.sel ? 'h-80' : 'h-56'}"></div>
    <div class="fixed inset-x-0 bottom-0 z-[5] rounded-t-[20px] bg-card/90 px-4 pt-4 pb-[calc(16px+env(safe-area-inset-bottom))] backdrop-blur-xl shadow-[var(--shadow-sheet)]">
      <div class="mx-auto max-w-xl">${dock}</div>
    </div>
    ${set.over ? viewSetOver() : ''}`;
}

function viewSetOver() {
  const { set, setsWon, matchOver, sets } = ui.st;
  const scores = sets.map(s => `<span class="${s.us > s.them ? 'text-mint' : 'text-coral'}">${s.us}:${s.them}</span>`).join('<span class="text-smoke">, </span>');
  const box = (title, big, buttons) => `
    <div class="fixed inset-0 z-10 grid place-items-center bg-black/75 p-4 backdrop-blur-sm">
      <div class="surface w-full max-w-sm p-6 text-center shadow-[var(--shadow-key-hi)]">
        <p class="text-sm text-ash">${title}</p>
        <p class="num my-3 text-[64px] leading-none font-normal">${big}</p>
        <p class="num mb-6 text-sm">${scores}</p>
        <div class="grid gap-2">${buttons}</div>
      </div>
    </div>`;
  if (matchOver) {
    return box(setsWon.us > setsWon.them ? 'Матч выигран' : 'Матч проигран', `${setsWon.us}:${setsWon.them}`, `
      <button class="btn btn-primary min-h-12 justify-between" data-a="home">К списку матчей ${kbd('Enter')}</button>
      <button class="btn min-h-12 justify-between" data-a="undo">Отменить последнее очко ${kbd('⌫')}</button>`);
  }
  return box(`Партия ${set.n + 1} окончена`, `${set.us}:${set.them}`, `
    <button class="btn btn-primary min-h-12 justify-between" data-a="nextSet">${setTitle(set.n + 1, ui.st.format)} ${kbd('Enter')}</button>
    <button class="btn min-h-12 justify-between" data-a="undo">Отменить последнее очко ${kbd('⌫')}</button>
    <button class="btn btn-ghost min-h-11" data-a="home">Выйти к списку матчей</button>`);
}

function render() {
  const views = { home: viewHome, pickOpponent: viewPickOpponent, serveFirst: viewServeFirst, live: viewLive };
  $app.innerHTML = views[ui.view]();
}

// ---------- Обработка нажатий ----------

async function goHome() {
  ui.view = 'home';
  ui.match = null;
  ui.sel = null;
  history.replaceState(null, '', location.pathname);
  [ui.matches, ui.roster, ui.settings] = await Promise.all([
    api('GET', '/api/matches?mode=quick'), api('GET', '/api/roster'), api('GET', '/api/settings'),
  ]);
}

async function openMatch(id) {
  const match = await api('GET', `/api/matches/${id}`);
  if (match?.mode !== 'quick') return; // матч детального режима — не наш
  setMatch(match);
  ui.view = ui.st.set ? 'live' : 'serveFirst';
}

const createMatch = async opponentId => {
  const sel = document.getElementById('fmt')?.value ?? formatKey(ui.settings.lastFormat);
  setMatch(await api('POST', '/api/matches', { opponentId, mode: 'quick', format: pickFormat(sel) }));
  ui.view = 'serveFirst';
};

const handlers = {
  // Из матча выходим «Назад» браузера, чтобы не копить записи истории; переход на список делает hashchange.
  home: () => { if (pushed && ui.match && location.hash.includes('m=')) { pushed = false; history.back(); } else call(goHome); },
  pickOpponent: () => {
    if (!ui.roster.length) {
      if (confirm('В составе нет игроков. Открыть настройки?')) location.href = 'detailed.html#settings';
      return;
    }
    ui.view = 'pickOpponent';
    render();
  },
  newMatch: d => call(() => createMatch(d.id)),
  newOpponentMatch: () => {
    const name = document.getElementById('newOpp').value.trim();
    if (!name) return alert('Введите название команды соперника');
    // Если такой соперник уже есть (матчи с одной командой повторяются) — берём его, а не плодим дубль.
    const same = ui.settings.opponents.find(o => o.name.trim().toLowerCase() === name.toLowerCase());
    if (same) return call(() => createMatch(same.id));
    const opp = { id: newId(), name };
    call(async () => {
      ui.settings = await api('PUT', '/api/settings', { ...ui.settings, opponents: [...ui.settings.opponents, opp] });
      await createMatch(opp.id);
    });
  },
  open: d => call(() => openMatch(d.id)),
  del: d => {
    const m = ui.matches.find(x => x.id === d.id);
    if (!confirm(`Удалить матч с «${m.opponent}» (${date(m.created)})? Он исчезнет из статистики (файл уедет в data/trash).`)) return;
    call(async () => { await api('DELETE', `/api/matches/${d.id}`); await goHome(); });
  },
  startSet: d => { sync.post({ t: 'set', weServe: d.v === '1' }); ui.view = 'live'; render(); },
  nextSet: () => { ui.view = 'serveFirst'; render(); },
  sel: d => { ui.sel = ui.sel === d.id ? null : d.id; render(); },
  end: d => send({ t: 'end', res: d.res, p: d.p || null }),
  undo: () => undo(),
};

$app.addEventListener('click', e => {
  const el = e.target.closest('[data-a]');
  if (el && !el.disabled) handlers[el.dataset.a](el.dataset);
});

// Клавиатура (для ноутбука). В поле ввода не перехватываем.
addEventListener('keydown', e => {
  if (e.target.closest?.('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  const { view } = ui;
  const over = view === 'live' && ui.st.set.over;
  let handled = true;
  if (view === 'serveFirst' && (e.code === 'Digit1' || e.code === 'Digit2')) handlers.startSet({ v: e.code === 'Digit1' ? '1' : '0' });
  else if (over && e.code === 'Enter') ui.st.matchOver ? handlers.home() : handlers.nextSet();
  else if (view === 'live' && e.code === 'Backspace') undo();
  else if (view === 'live' && !over && e.code === 'Escape') handlers.sel({ id: ui.sel });
  else if (view === 'live' && !over && /^(Digit|Numpad)\d$/.test(e.code) && !ui.sel) {
    const p = sortedRoster()[(Number(e.code.at(-1)) + 9) % 10]; // 1 — первый игрок, 0 — десятый
    if (p) handlers.sel({ id: p.id });
  } else if (view === 'live' && !over && ui.sel && possible(CODE_TO_RES[e.code])) send({ t: 'end', res: CODE_TO_RES[e.code], p: ui.sel });
  else if (view === 'live' && !over && !ui.sel && ['Equal', 'NumpadAdd'].includes(e.code)) send({ t: 'end', res: 'oppErr', p: null });
  else if (view === 'live' && !over && !ui.sel && ['Minus', 'NumpadSubtract'].includes(e.code)) send({ t: 'end', res: 'oppKill', p: null });
  else handled = false;
  if (handled) e.preventDefault();
});

// Если пульт открыт на нескольких устройствах (телефон + ноутбук) — раз в 3 секунды подтягиваем свежий счёт.
// Пока выбран игрок или идёт запрос, не трогаем экран, чтобы не сбить нажатие.
setInterval(async () => {
  if (ui.view !== 'live' || ui.busy || ui.sel || document.hidden) return;
  try {
    const m = await api('GET', `/api/matches/${ui.match.id}`);
    if (ui.view !== 'live' || ui.busy || ui.sel || !m || m.id !== ui.match.id) return;
    if (JSON.stringify(m.events) !== JSON.stringify(ui.match.events)) { setMatch(m); render(); }
  } catch { /* сеть моргнула — попробуем в следующий раз */ }
}, 3000);

// «Назад»/«Вперёд» браузера: адрес с m= открывает матч, без него — список матчей.
addEventListener('hashchange', () => {
  const id = location.hash.match(/m=([a-z0-9]+)/)?.[1];
  if (id && id !== ui.match?.id) call(() => openMatch(id));
  else if (!id && ui.match) call(goHome);
});

// Если страницу перезагрузили посреди матча — открываем его снова.
const hashId = location.hash.match(/m=([a-z0-9]+)/)?.[1];
call(async () => { await goHome(); if (hashId) await openMatch(hashId); });
