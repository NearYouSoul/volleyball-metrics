// Настройки и создание матча: один модуль для главной и студии.
// Окно открывается поверх текущего экрана (#modal), без перехода на другую страницу.
// Состояние (ui) общее с экраном, который подключил модуль: на главной матча нет (ui.match, ui.st = null) —
// всё, что зависит от открытого матча («Из матча» и т. п.), тогда просто скрыто.
import { formatOptions, formatKey, pickFormat } from './engine.js';
import { ZONE_SPOT, SYSTEMS, ROLES, roleOf, zoneOfSlot } from './court.js';
import { zonesOf, defaultZones, GRADES, COLS, ROWS, CELL } from './quality.js';
import { SITUATIONS, tableFor, defaultSpot, defenseLayout, overlapIssues, frontByRole } from './formations.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (id, cls = '') => `<svg class="${cls}"><use href="#${id}"/></svg>`;
const newId = () => Math.random().toString(36).slice(2, 8);
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem('studio.' + k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('studio.' + k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};
// Цвета формы по умолчанию — те же, что в court3d.js (там three.js, на главной он не нужен).
const KIT_DEFAULT = { main: '#e9eaec', shorts: '#1b2a4a', number: '#16233f', setter: '#f0c85a', libero: '#e8613c' };

// Эмблема команды: картинка или кружок с инициалами (цвет — от названия, всегда один и тот же).
export function emblem(src, title, cls = '') {
  if (src) return `<img class="emb ${cls}" src="${src}" alt="">`;
  const ini = String(title || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  let h = 0; for (const ch of String(title)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `<span class="emb ini ${cls}" style="background:hsl(${h} 45% 32%)">${esc(ini)}</span>`;
}

// Перерисовка открытого окна меняет только содержимое — без повторной анимации появления.
export function modal(html) {
  const box = $('modal').querySelector('.modal');
  if (html && box) { box.className = 'modal'; box.innerHTML = html; }
  else $('modal').innerHTML = html ? `<div class="modal-bg" data-a="modalBg"><div class="modal">${html}</div></div>` : '';
}
const modalOpen = () => !!$('modal').innerHTML;

let toastTimer;
export function toast(text, err = false, action = null) {
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

// Пресеты команды: если их ещё нет — один «Основной» из старых настроек.
export function presetsOf(ui) {
  const list = ui.settings.presets;
  if (list?.length) return list;
  return [{ id: 'main', name: 'Основной', system: ui.settings.system || '5-1', formations: ui.settings.formations ?? {} }];
}

// ui — общий объект экрана. toast / onChanged(info) / onMatchCreated(match) / render — колбэки вызывающего.
// court и tips — только в студии; studio = { opt(k, v) } — то, что настройки плеера меняют на экране студии.
// onChanged вызывается после сохранения (info.match — обновлённый открытый матч, если он менялся).
export function createSettings({ ui, toast: say = toast, onChanged = () => {}, onMatchCreated = () => {}, court = null, tips = null, render = () => {}, studio = null }) {
  const toast = say;
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
  // Команда, настройки и список матчей — свежие с сервера.
  async function reload() {
    [ui.roster, ui.settings, ui.matches] = await Promise.all([api('GET', '/api/roster'), api('GET', '/api/settings'), api('GET', '/api/matches')]);
    ui.zones = zonesOf(ui.settings);
  }
  const person = id => ui.match?.roster.find(p => p.id === id) || {};
  const presets = () => presetsOf(ui);
  const presetById = id => presets().find(p => p.id === id);
  const roleIn = id => ui.match?.roles?.[id] || roleOf(person(id)?.id ? person(id) : ui.roster.find(p => p.id === id));
  const curPreset = () => presetById(ui.match?.preset) ?? presetById(ui.settings.activePreset) ?? presets()[0];
  const ourEmblem = (cls = '') => emblem(ui.settings.emblem, ui.settings.teamName, cls);
  const H = {};

  // ---------- Новый матч ----------
  async function openNewMatch() {
    modal(`<h2>Новый матч</h2>
      <div class="field">Формат матча<select id="fmt">${formatOptions(formatKey(ui.settings.lastFormat))}</select></div>
      <p style="margin-top:14px">С кем играем?</p>
      <div class="mlist">${ui.settings.opponents.map(o => `<div class="mitem" data-a="createMatch" data-id="${o.id}">${emblem(o.emblem, o.name, 'sm')}<span class="grow"><b>${esc(o.name)}</b></span></div>`).join('') || '<p class="muted">Соперников пока нет.</p>'}</div>
      <div class="field">Новый соперник<div style="display:flex;gap:8px"><input id="newOpp" placeholder="Название команды" style="flex:1"><button class="btn primary" data-a="createNewOpp">Создать</button></div></div>
      <div class="foot"><button class="btn ghost" data-a="modalClose">Отмена</button></div>`);
    setTimeout(() => $('newOpp')?.focus(), 30);
  }
  async function createMatch(opponentId) {
    const format = pickFormat($('fmt')?.value ?? formatKey(ui.settings.lastFormat));
    modal('');
    const match = await api('POST', '/api/matches', { opponentId, format });
    ui.settings.lastFormat = format;
    ui.matches = await api('GET', '/api/matches');
    await onMatchCreated(match);
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
        <select data-k="fSlot" data-slot="${sl}">${roster.map(p => `<option value="${p.id}" ${p.id === cur ? 'selected' : ''}>${p.num ? '#' + esc(p.num) + ' ' : ''}${esc(p.name)}${ROLES[roleOf(p)] ? ' · ' + ROLES[roleOf(p)].short : ''}</option>`).join('')}</select></label>`;
    };
    return `<div class="rpanel"><p class="muted" style="margin:0 0 8px"><span class="tip-inline">Кто где стоит в Р${f.rot}. Задайте один раз — в остальных переходах игроки встанут по кругу.</span>
        Связующий (по нему считаются Р1–Р6): <select data-k="fMain">${lu.start.filter(Boolean).map(id => { const p = roster.find(x => x.id === id); return `<option value="${id}" ${id === lu.main ? 'selected' : ''}>${p?.num ? '#' + esc(p.num) + ' ' : ''}${esc(p?.name)}</option>`; }).join('')}</select></p>
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
  const SET_TABS = [['general', 'Общие'], ['player', 'Плеер'], ['court', '3D-площадка'], ['team', 'Команда'], ['remote', 'Пульт'], ['data', 'Данные']];
  const VIEW_NAMES = { persp: 'Перспектива', top: 'Сверху', behind: 'Из-за спины', side: 'Сбоку' };
  const LABEL_NAMES = { num: 'Номер', name: 'Имя', full: 'Номер и имя', none: 'Без подписи' };
  function openSettings(tab = ui.setTab ?? 'general') {
    ui.setTab = tab;
    if (tab === 'data') return call(async () => { await loadDataView(); paintSettings(); });
    if (tab === 'remote') return call(async () => { ui.qr = await api('GET', '/api/qr'); paintSettings(); });
    paintSettings();
  }
  const optRow = (title, sub, ctl) => `<div class="srow"><span class="grow"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</span>${ctl}</div>`;
  const segCtl = (k, cur, opts) => `<div class="seg">${opts.map(([v, l]) => `<button class="${String(cur) === String(v) ? 'on' : ''}" data-a="setOpt" data-k="${k}" data-v="${v}">${l}</button>`).join('')}</div>`;
  const switchCtl = (k, on) => `<label class="switch"><input type="checkbox" data-k="${k}" ${on ? 'checked' : ''}><i></i></label>`;
  function settingsBody(tab) {
    if (tab === 'remote') return `<h3 class="mh">Пульт для телефона</h3>
      <p class="tip-inline">Телефон и этот компьютер должны быть в одной сети. Наведите камеру на код, выберите матч и нажимайте кнопки: статистика «Экспресс stat» запишется на компьютер. Смотреть её можно только здесь.</p>
      ${ui.qr?.qr ? `<div class="hphone"><img src="${ui.qr.qr}" alt="QR-код пульта"><span>${ui.qr.urls.map(u => `<b class="mono" style="font-size:14px">${esc(u)}</b>`).join('')}</span></div>` : '<p class="muted">Сеть не найдена. Подключите компьютер к Wi-Fi или к раздаче с телефона.</p>'}`;
    if (tab === 'general') return `<h3 class="mh">Общие</h3>
      ${optRow('Режим подсказок', 'Задержите курсор на кнопке — появится пояснение. То же — кнопка «?» в верхней панели.', switchCtl('optTips', tips ? tips.on : store.get('tips', false)))}
      ${studio ? optRow('Обучение', 'Короткий тур по окну студии.', '<button class="btn sm" data-a="tourStart">Пройти снова</button>') : ''}
      ${studio ? optRow('Горячие клавиши', 'Все сочетания на одной странице. Клавиша ?', '<button class="btn sm" data-a="help">Открыть</button>') : ''}`;
    if (tab === 'player') return `<h3 class="mh">Плеер</h3>
      ${optRow('Пауза при вводе', 'Видео останавливается, пока вводите касание; после конца розыгрыша продолжится само.', switchCtl('optAutoPause', $('autoPause') ? $('autoPause').checked : store.get('autoPause', true)))}
      ${optRow('Скорость в синхронизации', 'Режим «Синхр.»: видео идёт от касания к касанию на этой скорости.', segCtl('syncRate', ui.syncRate ?? store.get('syncRate', 0.75), [[0.5, '0,5×'], [0.75, '0,75×'], [1, '1×']]))}
      ${optRow('Петля синхронизации', 'Если следующее касание не отмечено — через столько секунд видео вернётся к прошлому.', segCtl('loopLen', ui.loopLen ?? store.get('loopLen', 5), [[3, '3 с'], [5, '5 с'], [8, '8 с'], [12, '12 с']]))}
      ${optRow('Перемотка стрелками ← →', 'С Shift — втрое дальше.', segCtl('seekStep', ui.seekStep ?? store.get('seekStep', 5), [[2, '2 с'], [5, '5 с'], [10, '10 с']]))}`;
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
  // В студии настройка сразу применяется (studio.opt); на главной — только запоминается (те же ключи studio.*).
  function applyOpt(k, v) {
    if (k === 'detail') { store.set('detail', v); court?.setDetail(v); }
    else if (k === 'labelMode') { store.set('labelMode', v); court?.setLabelMode(v); }
    else if (k === 'view3d') store.set('view3d', v);
    else if (!studio) store.set(k, +v);
    studio?.opt(k, v);
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
  // Экспорт: пакет команды (без матчей), один матч, таблица статистики; импорт — пакет команды и матч.
  const TEAM_PARTS = { roster: 'Состав: игроки, номера, роли', kit: 'Название, эмблема, форма', play: 'Схема игры, расстановки, зоны доводки', opps: 'Соперники и их эмблемы' };
  function exportBody() {
    const ex = (ui.exportParts ??= Object.keys(TEAM_PARTS));
    const imp = ui.teamImport;
    const matches = ui.matches ?? [];
    const sel = ui.exportMatch ?? ui.match?.id ?? matches[0]?.id ?? '';
    return `<h3 class="mh">Пакет команды</h3>
      <p class="muted" style="margin:0 0 8px">Всё, что касается команды, без матчей — передать помощнику или перенести на другой компьютер. Архив ZIP: внутри ещё состав таблицей и эмблемы картинками.</p>
      <div class="chkgrid">${Object.entries(TEAM_PARTS).map(([k, l]) => `<label class="toggle"><input type="checkbox" data-k="expPart" data-v="${k}" ${ex.includes(k) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      <div class="dbtns"><a class="btn primary ${ex.length ? '' : 'disabled'}" href="/api/export/team?parts=${ex.join(',')}" download>⤓ Скачать пакет команды</a>
        <label class="btn">⤒ Загрузить пакет команды<input type="file" accept=".zip,.json,application/zip,application/json" hidden data-k="teamPkgFile"></label></div>
      ${imp ? `<div class="card impcard"><b>${esc(imp.info.teamName)}</b><small>файл от ${new Date(imp.info.exported).toLocaleDateString('ru')} · игроков ${imp.info.players} · соперников ${imp.info.opponents}</small>
        <div class="chkgrid">${imp.info.parts.map(k => `<label class="toggle"><input type="checkbox" data-k="impPart" data-v="${k}" ${imp.parts.includes(k) ? 'checked' : ''}><span>${TEAM_PARTS[k] ?? k}</span></label>`).join('')}</div>
        <small>Игроки и соперники добавятся или обновятся (по номеру и имени), никто не удалится. Перед загрузкой делается резервная копия.</small>
        <div class="dbtns"><button class="btn primary" data-a="teamImport">Загрузить выбранное</button><button class="btn ghost" data-a="teamImportCancel">Отмена</button></div></div>` : ''}
      <h3 class="mh">Матч</h3>
      <p class="muted" style="margin:0 0 8px">Один матч: события, состав, соперник, плюс события таблицей. Видео не входит — его привязывают заново.</p>
      <div class="dbtns"><select data-k="expMatch">${matches.map(m => `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${esc(m.opponent)} · ${new Date(m.created).toLocaleDateString('ru')}</option>`).join('')}</select>
        <a class="btn ${sel ? '' : 'disabled'}" href="/api/export/match/${sel}" download>⤓ Скачать матч</a>
        <label class="btn">⤒ Загрузить матч<input type="file" accept=".zip,.json,application/zip,application/json" hidden data-k="matchPkgFile"></label></div>
      <h3 class="mh">Статистика игроков</h3>
      <div class="dbtns"><a class="btn" href="/api/export/stats.csv" download>⤓ Таблица по всем матчам (CSV для Excel)</a></div>
      <h3 class="mh">Все данные</h3>`;
  }
  async function uploadPkg(url, file) {
    const r = await fetch(url, { method: 'POST', body: file });
    const out = await r.json();
    if (out?.error) throw new Error(out.error);
    return out;
  }
  function dataBody() {
    const { backups, trash } = ui.dataView;
    const when = iso => (iso ? new Date(iso).toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
    return `${exportBody()}
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
    await reload();
    await onChanged();
    await openDataModal();
    toast(msg);
  }

  // ---------- Обработчики ----------
  Object.assign(H, {
    modalClose: () => { ui.fEdit = null; ui.team = null; modal(''); },
    modalBg: (d, e) => { if (e.target.classList.contains('modal-bg')) H.modalClose(); },
    dataModal: () => call(openDataModal),
    settings: d => openSettings(d.tab),
    setTab: d => openSettings(d.v),
    setOpt: d => applyOpt(d.k, d.v),
    settingsClose: () => { ui.dataView = null; modal(''); },
    teamImportCancel: () => { ui.teamImport = null; paintSettings(); },
    teamImport: () => call(async () => {
      const t = ui.teamImport;
      if (!t.parts.length) return toast('Отметьте, что загрузить', true);
      const r = await uploadPkg(`/api/import/team?parts=${t.parts.join(',')}`, t.file);
      ui.teamImport = null;
      await reload(); await onChanged(); await loadDataView(); paintSettings();
      toast(`Пакет загружен${r.parts.includes('roster') ? ` · игроков: новых ${r.roster.added}, обновлено ${r.roster.updated}` : ''}${r.parts.includes('opps') ? ` · соперников: новых ${r.opps.added}` : ''}`);
    }),
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
      ui.team = null; modal('');
      ui.matches = await api('GET', '/api/matches');
      await onChanged();
      toast('Команда сохранена');
    }),
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
      const match = ui.match && ui.match.preset !== f.presetId ? await api('PATCH', `/api/matches/${ui.match.id}`, { preset: f.presetId, system: editPreset().system }) : null;
      ui.fEdit = null;
      modal('');
      await onChanged({ match });
      toast('Расстановки сохранены — игроки на площадке встают по ним');
    }),
    zBrush: d => { ui.zEdit.brush = +d.g; document.querySelectorAll('.zbrush').forEach(b => b.classList.toggle('on', b.dataset.g === d.g)); },
    zReset: () => { ui.zEdit.z = [...defaultZones()]; paintZones(); },
    zSave: () => call(async () => {
      ui.settings = await api('PUT', '/api/settings', { qualityZones: ui.zEdit.z.join('') });
      ui.zones = zonesOf(ui.settings);
      modal('');
      await onChanged();
      toast('Зоны доводки сохранены — оценка приёма считается по ним');
    }),
    zonesEditor: () => openZonesEditor(),
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
  });

  // ---------- Изменения полей ----------
  function onChange(e) {
    const k = e.target.dataset.k;
    if (!k) return;
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (k === 'optTips') { if (tips) { if (v !== tips.on) tips.toggle(); } else store.set('tips', v); }
    if (k === 'expPart' || k === 'impPart') {
      const list = k === 'expPart' ? (ui.exportParts ??= []) : ui.teamImport.parts, key = e.target.dataset.v;
      const next = v ? [...new Set([...list, key])] : list.filter(x => x !== key);
      if (k === 'expPart') ui.exportParts = next; else ui.teamImport.parts = next;
      paintSettings();
    }
    if (k === 'expMatch') { ui.exportMatch = v; paintSettings(); }
    if (k === 'teamPkgFile' && e.target.files[0]) {
      const file = e.target.files[0];
      call(async () => { const info = await uploadPkg('/api/import/team/preview', file); ui.teamImport = { file, info, parts: [...info.parts] }; paintSettings(); });
    }
    if (k === 'matchPkgFile' && e.target.files[0]) {
      const file = e.target.files[0];
      call(async () => {
        const r = await uploadPkg('/api/import/match', file);
        await reload(); await onChanged(); await loadDataView(); paintSettings();
        toast(`Матч загружен: ${r.opponent} · событий ${r.events}`);
      });
    }
    if (k === 'optAutoPause') { if ($('autoPause')) $('autoPause').checked = v; store.set('autoPause', v); }
    if (k === 'optZones') { store.set('zonesOn', v); court?.toggleZones(v); document.querySelector('[data-a=zones]')?.classList.toggle('on', v); }
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
    if (k === 'embFile' && e.target.files[0]) {
      const who = e.target.dataset.who;
      fileToEmblem(e.target.files[0]).then(src => { if (who === 'us') ui.team.emblem = src; else ui.team.opponents[+who].emblem = src; paintTeamModal(); }).catch(err => toast(err.message, true));
    }
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
  }
  function onInput(e) {
    if (ui.team && e.target.dataset.k === 'teamName') ui.team.teamName = e.target.value;
    if (ui.team && e.target.dataset.k === 'kitColor') { ui.team.kit[e.target.dataset.key] = e.target.value; document.querySelector('.kitprev').innerHTML = kitPreview(ui.team.kit); }
    if (ui.team && e.target.dataset.k === 'oppName') ui.team.opponents[+e.target.dataset.i].name = e.target.value;
    if (ui.team && e.target.dataset.k === 'plName') ui.team.roster[+e.target.dataset.i].name = e.target.value;
    if (ui.team && e.target.dataset.k === 'plNum') ui.team.roster[+e.target.dataset.i].num = e.target.value;
  }
  function onKey(e) {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') { if (e.key === 'Enter' && e.target.id === 'newOpp') H.createNewOpp(); return; }
    if (!studio && e.key === 'Escape' && modalOpen()) H.modalClose();
  }

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-a]');
    if (!el || el.disabled) return;
    const fn = H[el.dataset.a];
    if (!fn) return;
    // Кнопка не держит фокус — иначе пробел «нажимает» её второй раз вместе с горячей клавишей.
    if (el.tagName === 'BUTTON') el.blur();
    fn(el.dataset, e);
  });
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  document.addEventListener('keydown', onKey);

  return {
    open: tab => openSettings(tab),
    newMatch: openNewMatch,
    openFormEditor,
    openZonesEditor,
    handlers: H,
    onChange,
    onInput,
  };
}
