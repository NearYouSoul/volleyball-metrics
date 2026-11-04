// Пульт: экраны «Меню», «Состав», «Порядок подачи», «Матч».
// Всё состояние матча вычисляет engine.js из списка событий, который хранится на сервере.
import { replay, playerName, LABELS, setTitle, formatOptions, formatKey, pickFormat } from './engine.js';
import { SYSTEMS, ROLES, roleOf } from './court.js';
import { createSync, statusBadge } from './offline.js';

const $app = document.getElementById('app');
const ui = { view: 'home', matches: [], roster: [], settings: { teamName: 'Мы', opponents: [] }, match: null, st: null, sel: null, sub: null, lineup: [], weServe: true, busy: false };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// crypto.randomUUID недоступен по http в локальной сети, поэтому простой id.
const newId = () => Math.random().toString(36).slice(2, 8);

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
  location.hash = 'm=' + match.id;
  if (changed) sync.attach(match); // другой матч — подхватываем его очередь (если что-то не ушло)
}

// Выбор игрока сбрасываем сразу, а не после ответа — иначе следующее нажатие могло бы потеряться.
const clearSel = () => { ui.sel = null; ui.sub = null; };
// Нажатия идут через очередь: без связи с ноутбуком применяются на экране и досылаются, когда связь вернётся.
const sync = createSync({ getMatch: () => ui.match && { ...ui.match, events: [...ui.match.events] }, setMatch: m => { setMatch(m); render(); }, onStatus: statusBadge });
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

function viewHome() {
  return `
    <a href="/" class="hint">← Выбор режима</a>
    <h1>📋 ${esc(ui.settings.teamName)} · детальная</h1>
    <div class="col">
      <button class="primary" data-a="pickOpponent">Новый матч</button>
      <button data-a="settings">Настройки · игроков ${ui.roster.length} · соперников ${ui.settings.opponents.length}</button>
      <a class="btn" href="stats.html">📊 Аналитика</a>
      <a class="btn" href="studio.html">🎬 Студия (ноутбук): видео и 3D</a>
    </div>
    <h2>Матчи</h2>
    <div class="col">${ui.matches.map(m => `
      <div class="row" style="margin:0">
        <button data-a="open" data-id="${m.id}" style="text-align:left;flex:5">
          ${esc(m.opponent)} · ${new Date(m.created).toLocaleDateString('ru')} · ${m.setsWon.us}:${m.setsWon.them}
        </button>
        <button data-a="delMatch" data-id="${m.id}" aria-label="Удалить матч">✕</button>
      </div>`).join('') || '<p class="hint">Пока нет матчей</p>'}
    </div>`;
}

function viewQr() {
  const { urls, qr } = ui.qr;
  if (!qr) return `<div class="card"><p class="hint">Сеть не найдена. Подключите компьютер к Wi-Fi или к раздаче с телефона и откройте настройки снова.</p></div>`;
  return `<div class="card qr">
    <p class="hint">Телефон должен быть в той же Wi-Fi сети, что и компьютер. Наведите камеру на код:</p>
    <img src="${qr}" alt="QR-код пульта">
    <code>${esc(urls[0])}</code>
    ${urls.length > 1 ? `<p class="hint">Если не открывается, попробуйте: ${urls.slice(1).map(esc).join(', ')}</p>` : ''}
  </div>`;
}

function viewSettings() {
  return `
    <h1>Настройки</h1>
    <h2>Подключить телефон</h2>
    ${viewQr()}
    <h2>Наша команда</h2>
    <input value="${esc(ui.settings.teamName)}" data-k="teamName" placeholder="Название команды" style="width:100%">
    <h2>Схема игры</h2>
    <select data-k="system" style="width:100%;padding:12px;border-radius:8px;background:rgb(255 255 255 / .05);color:#fff;border:0;font:inherit">
      ${Object.entries(SYSTEMS).map(([k, v]) => `<option value="${k}" ${(ui.settings.system || '5-1') === k ? 'selected' : ''}>${v}</option>`).join('')}
    </select>
    <p class="hint">Схема подсказывает, кто пасует, если пас не отмечен: в 4-2 — связующий из передней линии, в гибриде — основной, если он на площадке.
      Для новых матчей; у начатых меняется в студии.</p>
    <h2>Игроки</h2>
    <p class="hint">Роль: связующий, диагональный, доигровщик, центральный, либеро. Связующий подставляется в статистику связок автоматически, когда стоит на площадке.
      Имена можно менять — статистика старых матчей сохранится.</p>
    ${ui.roster.map((p, i) => `
      <div class="rost">
        <input type="number" inputmode="numeric" value="${esc(p.num)}" data-list="roster" data-i="${i}" data-k="num" placeholder="№">
        <input value="${esc(p.name)}" data-list="roster" data-i="${i}" data-k="name" placeholder="Имя">
        <select data-list="roster" data-i="${i}" data-k="role" style="border-radius:8px;background:rgb(255 255 255 / .05);color:#fff;border:0;padding:10px 4px;font:inherit;font-size:13px">
          <option value="">Роль</option>${Object.entries(ROLES).map(([k, r]) => `<option value="${k}" ${roleOf(p) === k ? 'selected' : ''}>${r.name}</option>`).join('')}
        </select>
        <button data-a="delRow" data-list="roster" data-i="${i}">✕</button>
      </div>`).join('')}
    <div class="row"><button data-a="addPlayer">+ Игрок</button></div>
    <h2>Соперники</h2>
    ${ui.settings.opponents.map((o, i) => `
      <div class="row">
        <input value="${esc(o.name)}" data-list="opponents" data-i="${i}" data-k="name" placeholder="Название">
        <button data-a="delRow" data-list="opponents" data-i="${i}" style="flex:0 0 44px">✕</button>
      </div>`).join('')}
    <div class="row"><button data-a="addOpponent">+ Соперник</button></div>
    <div class="row"><button data-a="home">Отмена</button><button class="primary" data-a="saveSettings">Сохранить</button></div>
    <h2>Дашборд</h2>
    <a class="btn" href="quick-stats.html#config">Настроить блоки и колонки дашборда быстрой статистики</a>
    <h2>Данные</h2>
    <p class="hint">Перед турниром удалите тестовые матчи, чтобы они не портили статистику.
      Игроки и соперники останутся. Удалённые матчи не стираются, а переезжают в папку <code>data/trash</code>.</p>
    <div class="col">
      <button class="r" data-a="clearMatches" data-mode="quick">Удалить все матчи быстрой статистики (${ui.counts.quick})</button>
      <button class="r" data-a="clearMatches" data-mode="detail">Удалить все матчи детальной статистики (${ui.counts.detail})</button>
    </div>`;
}

// Данные для экрана настроек: QR-код и сколько матчей в каждом режиме.
async function loadSettingsView() {
  const [qr, quick, detail] = await Promise.all([api('GET', '/api/qr'), api('GET', '/api/matches?mode=quick'), api('GET', '/api/matches')]);
  ui.qr = qr;
  ui.counts = { quick: quick.length, detail: detail.length };
  ui.view = 'settings';
}

function viewPickOpponent() {
  return `
    <h1>С кем играем?</h1>
    <h2>Формат матча</h2>
    <select id="fmt" style="width:100%;padding:12px;border-radius:8px;background:rgb(255 255 255 / .05);color:#fff;border:0;font:inherit">${formatOptions(formatKey(ui.settings.lastFormat))}</select>
    <h2>Соперник</h2>
    <div class="col">${ui.settings.opponents.map(o => `<button data-a="newMatch" data-id="${o.id}">${esc(o.name)}</button>`).join('')}</div>
    <h2>Новый соперник</h2>
    <div class="row"><input id="newOpp" placeholder="Название команды" style="flex:2"><button class="primary" data-a="newOpponentMatch">Добавить и начать</button></div>
    <div class="row"><button data-a="home">Назад</button></div>`;
}

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
  rec: p => ['Приём', [btn('g', 'rec', 'pp', '++', p), btn('y', 'rec', 'pm', '+−', p), btn('n', 'rec', 'p', '+', p), btn('y', 'rec', 'over', 'Перекид', p), btn('r', 'rec', 'error', 'Не принял', p)]],
  att: p => ['Атака', [btn('g', 'att', 'kill', 'Забил', p), btn('g', 'att', 'bo', 'От блока', p), btn('n', 'att', 'play', 'В игре', p),
    btn('r', 'att', 'error', 'Аут / сетка', p), btn('r', 'att', 'blocked', 'Заблокир.', p)]],
  def: p => ['Защита и блок', [btn('g', 'blk', 'point', 'Блок: очко', p), btn('n', 'dig', 'plus', 'Защита +', p), btn('y', 'dig', 'minus', 'Защита −', p),
    btn('y', 'blk', 'touch', 'Касание блоком', p), btn('r', 'blk', 'out', 'Блок-аут', p), btn('r', 'dig', 'error', 'Не поднял', p)]],
  set: p => ['Пас', [btn('g', 'set', 'perfect', 'Идеальный', p), btn('n', 'set', 'good', 'Хороший', p), btn('y', 'set', 'poor', 'Неудобный', p), btn('r', 'set', 'error', 'Ошибка паса', p)]],
  fault: p => ['Прочее', [btn('r', 'fault', 'error', 'Ошибка: сетка / заступ / касания', p)]],
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
      <button data-a="home">Меню</button>
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
      <button data-a="home">${matchOver ? 'К матчам' : 'Выйти к матчам'}</button>
    </div></div></div>`;
}

function render() {
  const views = { home: viewHome, settings: viewSettings, pickOpponent: viewPickOpponent, lineup: viewLineup, live: viewLive };
  $app.innerHTML = views[ui.view]();
}

// ---------- Обработка нажатий ----------

async function goHome() {
  ui.view = 'home';
  ui.match = null;
  history.replaceState(null, '', location.pathname);
  [ui.matches, ui.roster, ui.settings] = await Promise.all([api('GET', '/api/matches'), api('GET', '/api/roster'), api('GET', '/api/settings')]);
}

function prepareLineup() {
  const last = ui.st.sets.at(-1);
  ui.lineup = last ? last.start.filter(id => ui.match.roster.some(p => p.id === id)) : [];
  ui.weServe = true;
  ui.view = 'lineup';
}

async function openMatch(id) {
  const match = await api('GET', `/api/matches/${id}`);
  if (!match || match.mode === 'quick') return; // матч быстрого режима — не наш
  setMatch(match);
  ui.sel = null; ui.sub = null;
  if (ui.st.set) ui.view = 'live';
  else prepareLineup();
}

const handlers = {
  home: () => call(goHome),
  live: () => { ui.view = 'live'; render(); },
  // Правим копии: «Отмена» перечитывает настройки с сервера и выбрасывает изменения.
  settings: () => call(loadSettingsView),
  clearMatches: d => {
    const what = d.mode === 'quick' ? 'быстрой' : 'детальной';
    if (!confirm(`Удалить ВСЕ матчи ${what} статистики? Игроки и соперники останутся.`)) return;
    call(async () => {
      const { deleted } = await api('DELETE', `/api/matches?mode=${d.mode}`);
      alert(`Удалено матчей: ${deleted}. Файлы лежат в data/trash.`);
      await loadSettingsView();
    });
  },
  delMatch: d => {
    const m = ui.matches.find(x => x.id === d.id);
    if (!confirm(`Удалить матч с «${m.opponent}»?`)) return;
    call(async () => { await api('DELETE', `/api/matches/${d.id}`); await goHome(); });
  },
  addPlayer: () => { ui.roster.push({ id: newId(), num: '', name: '', role: '', setter: false }); render(); },
  addOpponent: () => { ui.settings.opponents.push({ id: newId(), name: '' }); render(); },
  delRow: d => {
    const list = d.list === 'roster' ? ui.roster : ui.settings.opponents;
    list.splice(+d.i, 1);
    render();
  },
  saveSettings: () => call(async () => {
    // «Связующий» в движке — по роли; галочку оставляем для совместимости со старыми матчами.
    const roster = ui.roster.filter(p => p.num !== '' || p.name.trim()).map(p => ({ ...p, num: Number(p.num), name: p.name.trim(), role: roleOf(p), setter: roleOf(p) === 's' }));
    const opponents = ui.settings.opponents.filter(o => o.name.trim()).map(o => ({ ...o, name: o.name.trim() }));
    const settings = { teamName: ui.settings.teamName.trim() || 'Мы', opponents, system: ui.settings.system || '5-1' };
    [ui.roster, ui.settings] = await Promise.all([api('PUT', '/api/roster', roster), api('PUT', '/api/settings', settings)]);
    ui.view = 'home';
  }),
  pickOpponent: () => {
    if (!ui.roster.length) return alert('Сначала добавьте игроков в настройках');
    ui.view = 'pickOpponent';
    render();
  },
  newMatch: d => { const format = pickFormat(document.getElementById('fmt')?.value ?? 'bo3'); call(async () => { setMatch(await api('POST', '/api/matches', { opponentId: d.id, format })); prepareLineup(); }); },
  newOpponentMatch: () => {
    const name = document.getElementById('newOpp').value.trim();
    if (!name) return alert('Введите название соперника');
    // Если такой соперник уже есть — берём его, а не плодим дубль.
    const same = ui.settings.opponents.find(o => o.name.trim().toLowerCase() === name.toLowerCase());
    if (same) return handlers.newMatch({ id: same.id });
    const opp = { id: newId(), name };
    call(async () => {
      ui.settings = await api('PUT', '/api/settings', { ...ui.settings, opponents: [...ui.settings.opponents, opp] });
      setMatch(await api('POST', '/api/matches', { opponentId: opp.id, format: pickFormat(document.getElementById('fmt')?.value ?? 'bo3') }));
      prepareLineup();
    });
  },
  open: d => call(() => openMatch(d.id)),
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

// Поля настроек меняют данные сразу, без перерисовки (иначе пропадает фокус).
$app.addEventListener('input', e => {
  const { list, i, k } = e.target.dataset;
  if (!k) return;
  const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  if (list === 'roster') ui.roster[i][k] = value;
  else if (list === 'opponents') ui.settings.opponents[i][k] = value;
  else ui.settings[k] = value;
});

// Если страницу перезагрузили посреди матча — открываем его снова.
const hashId = location.hash.match(/m=([a-z0-9]+)/)?.[1];
// #settings — сразу открыть настройки (ссылка со стартовой страницы). Запоминаем до goHome: он чистит адрес.
const openSettings = location.hash === '#settings';
call(async () => {
  await goHome();
  if (hashId) await openMatch(hashId);
  else if (openSettings) await loadSettingsView();
});

// Ссылка на настройки, когда пульт уже открыт (смена #settings без перезагрузки).
addEventListener('hashchange', () => { if (location.hash === '#settings') call(loadSettingsView); });
