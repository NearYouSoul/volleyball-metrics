// Раздел «Аналитика» в основном окне программы. Фильтры общие: режим, турнир, соперник, матч, партия.
// Статистика считается только внутри выбранного режима: режимы не суммируются. Режим без данных не подсвечен.
import { MODES, MODE_KEYS } from './modes.js';
import { matchHead } from './match-card.js';
import * as detail from './stats.js';
import * as express from './quick-stats.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const part = src => (src === 'express' ? express : detail);
const dt = m => new Date(m.created).toLocaleDateString('ru');

// ctx: { matches, settings, cardCtx, onSections } — от главной; route: { match, src, set } из адреса.
export function createAnalytics(ctx) {
  const A = { src: 'studio', tour: 'all', opp: 'all', match: 'all', set: 'all', pickMatch: id => pick({ match: id }) };
  let host = null;

  const inScope = () => ctx.matches().filter(m => (A.opp === 'all' || m.opponentId === A.opp) && (A.tour === 'all' || (A.tour === 'none' ? !m.tournament : m.tournament === A.tour)));
  const hasData = k => (A.match === 'all' ? inScope() : inScope().filter(m => m.id === A.match)).some(m => m.modes[k].events);

  function pick(patch) {
    Object.assign(A, patch);
    if (patch.match !== undefined || patch.src) A.set = patch.set ?? 'all';
    if (A.match !== 'all' && !inScope().some(m => m.id === A.match)) A.match = 'all';
    // Выбранный матч без статистики этого режима: открываем режим, где она есть.
    if (!hasData(A.src)) A.src = MODE_KEYS.find(hasData) ?? A.src;
    paint();
  }

  function filterBar() {
    const { settings } = ctx, list = inScope(), tours = settings().tournaments ?? [];
    const sel = (id, value, opts, label) => `<label>${label}<select data-af="${id}">${opts.map(([v, t]) => `<option value="${v}" ${String(value) === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
    return `<div class="seg amodes">${MODE_KEYS.map(k => `<button class="${A.src === k ? 'on' : ''}" data-amode="${k}" ${hasData(k) ? '' : 'disabled'} title="${hasData(k) ? MODES[k].hint : 'В этом режиме статистики нет'}">${MODES[k].name}</button>`).join('')}</div>
      ${sel('match', A.match, [['all', `Все матчи (${list.length})`], ...list.map(m => [m.id, `${dt(m)} · ${m.opponent}`])], 'Матч')}
      ${sel('opp', A.opp, [['all', 'Все соперники'], ...settings().opponents.map(o => [o.id, o.name])], 'Соперник')}
      ${tours.length ? sel('tour', A.tour, [['all', 'Все турниры'], ...tours.map(t => [t.id, t.name]), ['none', 'Без турнира']], 'Турнир') : ''}`;
  }
  function setTabs(m) {
    const sets = m.modes[A.src].sets;
    if (!sets.length) return '';
    return `<div class="seg asets"><button class="${A.set === 'all' ? 'on' : ''}" data-aset="all">Весь матч</button>${sets.map(s => `<button class="${A.set === s.n ? 'on' : ''}" data-aset="${s.n}">Партия ${s.n + 1} <small>${s.us}:${s.them}</small></button>`).join('')}</div>`;
  }

  async function paint() {
    if (!host?.isConnected) return;
    const m = A.match === 'all' ? null : ctx.matches().find(x => x.id === A.match);
    const any = MODE_KEYS.some(hasData);
    host.innerHTML = `<div class="hhead"><h1>Аналитика</h1>${A.src !== 'express' && any ? '<button class="btn sm" data-acsv title="Все касания по фильтрам — таблица для Excel">⤓ CSV</button>' : ''}</div>
      <div class="afilters">${filterBar()}<span class="aextras" id="aExtras"></span></div>
      ${m ? `<div class="mcard flat">${matchHead(m, ctx.cardCtx())}</div>${setTabs(m)}` : ''}
      <div id="aBody"></div>`;
    const body = host.querySelector('#aBody'), extras = host.querySelector('#aExtras');
    MODE_KEYS.forEach(k => part(k).stop());
    if (!any) { body.innerHTML = '<div class="hempty"><b>Статистики пока нет</b><small>Откройте матч на главной и начните партию в любом режиме.</small></div>'; ctx.onSections([]); return; }
    await part(A.src).show(body, extras, A);
    ctx.onSections(part(A.src).sections(A.src));
  }

  const onClick = e => {
    const b = e.target.closest('[data-amode],[data-aset],[data-acsv]');
    if (!b || b.disabled) return;
    if (b.dataset.amode) pick({ src: b.dataset.amode });
    else if (b.dataset.aset !== undefined) pick({ set: b.dataset.aset === 'all' ? 'all' : +b.dataset.aset });
    else detail.exportCsv();
  };
  const onChange = e => {
    const k = e.target.dataset.af;
    if (k) pick({ [k]: e.target.value, ...(k !== 'match' && { match: 'all' }) });
  };

  return {
    // Показать раздел; route — матч, режим и партия из адреса (необязательны).
    show(el, route = {}) {
      if (host !== el) { el.addEventListener('click', onClick); el.addEventListener('change', onChange); }
      host = el;
      pick({ match: route.match ?? A.match, ...(route.src && { src: route.src }), set: route.set ?? 'all' });
    },
    stop() { MODE_KEYS.forEach(k => part(k).stop()); },
  };
}
