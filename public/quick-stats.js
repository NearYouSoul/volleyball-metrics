// Дашборд быстрой статистики. Собирается из блоков; какие блоки и колонки показывать —
// настраивается кнопкой «Настроить дашборд» и хранится в настройках на сервере (settings.quickDash).
// Обновляется сам каждые 3 секунды, фильтры — по сопернику и матчу.
import { replayQuick, quickTotals, newQuickPlayer, newQuickTeam, RESULTS, PLAYER_POINTS, PLAYER_ERRORS } from './quick-engine.js';
import { playerName, addStats, pct } from './engine.js';

const $app = document.getElementById('app');
// oppFilter: 'all' или id соперника; matchSel: 'all' или id матча (по умолчанию — последний матч).
let oppFilter = 'all', matchSel = null, scope = 'all', sortKey = 'points';
let settings = null, draft = null; // draft — настройка дашборда, пока открыта панель «Настроить»

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const z = v => (v ? v : '<span class="text-smoke">·</span>'); // ноль показываем тихой точкой, чтобы цифры читались
const signed = v => `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v > 0 ? '+' : ''}${v}</span>`;
const date = m => new Date(m.created).toLocaleDateString('ru');
const kpi = (t, v, s = '') => `<div class="kpi"><div class="t">${t}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
const sum = list => list.reduce(addStats, newQuickPlayer());

// ---------- Колонки таблицы игроков ----------

const COLUMNS = [
  { id: 'points', title: 'Очков принёс', kind: 'g', get: p => quickTotals(p).points, bold: true },
  ...PLAYER_POINTS.map(k => ({ id: k, title: RESULTS[k].label, kind: 'g', get: p => p[k] })),
  { id: 'errors', title: 'Ошибок всего', kind: 'r', get: p => quickTotals(p).errors, bold: true },
  ...PLAYER_ERRORS.map(k => ({ id: k, title: RESULTS[k].label, kind: 'r', get: p => p[k] })),
  { id: 'diff', title: 'Разница (+/−)', kind: '', get: p => quickTotals(p).diff, fmt: signed },
  { id: 'share', title: 'Доля очков команды', kind: '', get: (p, c) => (c.teamPoints ? quickTotals(p).points / c.teamPoints : 0), fmt: v => (v ? Math.round(v * 100) + '%' : '·') },
];

// ---------- Блоки ----------

// Цветная полоса «из чего состоит число» с подписями.
function bar(parts) {
  const total = parts.reduce((a, p) => a + p.v, 0);
  if (!total) return '<p class="muted small">Пока нет данных</p>';
  return `<div class="bar">${parts.filter(p => p.v).map(p => `<span style="flex:${p.v};background:${p.c}" title="${p.t}: ${p.v}"></span>`).join('')}</div>
    <div class="legend">${parts.map(p => `<div><i style="background:${p.c}"></i>${p.t}<b>${p.v}</b><span>${pct(p.v, total)}</span></div>`).join('')}</div>`;
}

// Топ игроков по показателю.
function top(c, get, n = 3) {
  return Object.entries(c.players).map(([id, p]) => ({ id, v: get(p) })).filter(x => x.v > 0).sort((a, b) => b.v - a.v).slice(0, n);
}
const nameOf = (c, id) => esc(playerName({ roster: c.people }, id));

const BLOCKS = {
  summary: {
    title: 'Итог', hint: 'Матчи, партии и очки',
    render: c => `<div class="kpis">
      ${c.rows.length > 1 ? kpi('Матчи', `${c.w} : ${c.l}`, `победы : поражения из ${c.rows.length}`) : ''}
      ${kpi('Партии', `${c.setsUs} : ${c.setsThem}`, 'выиграно : проиграно')}
      ${kpi('Очки', `${c.won} : ${c.lost}`, `разница ${c.won - c.lost > 0 ? '+' : ''}${c.won - c.lost}`)}
    </div>`,
  },
  serve: {
    title: 'Подача и приём', hint: 'Эйсы, ошибки подачи и приёма, сайд-аут и брейк',
    render: c => `<div class="kpis">
      ${kpi('Эйсы', c.total.ace, 'очков прямо с подачи')}
      ${kpi('Ошибки подачи', c.total.srvErr, c.total.ace + c.total.srvErr ? `на 1 эйс — ${(c.total.srvErr / Math.max(c.total.ace, 1)).toFixed(1)} ошибки` : '')}
      ${kpi('Ошибки приёма', c.total.recErr, 'эйсы соперника по нам')}
      ${kpi('Сайд-аут', pct(c.team.sideout.won, c.team.sideout.n), `взяли ${c.team.sideout.won} из ${c.team.sideout.n} розыгрышей на подаче соперника`)}
      ${kpi('Брейк', pct(c.team.brk.won, c.team.brk.n), `взяли ${c.team.brk.won} из ${c.team.brk.n} розыгрышей на своей подаче`)}
    </div>`,
  },
  sources: {
    title: 'Откуда наши очки', hint: 'Атака, блок, эйсы и ошибки соперника',
    render: c => bar([
      { t: 'Атака', v: c.total.kill, c: '#59d499' }, { t: 'Блок', v: c.total.block, c: '#3b8f6a' },
      { t: 'Эйс', v: c.total.ace, c: '#63a1ff' }, { t: 'Ошибки соперника', v: c.team.oppErr, c: '#454647' },
    ]),
  },
  losses: {
    title: 'Как мы отдали очки', hint: 'Наши ошибки по видам и очки, которые соперник забил сам',
    render: c => bar([
      ...PLAYER_ERRORS.map((k, i) => ({ t: RESULTS[k].label, v: c.total[k], c: ['#ff6363', '#ff8f73', '#e0a458', '#c9576f', '#f2b0a8', '#8f4a4a', '#d4766a'][i] })),
      { t: 'Соперник забил', v: c.team.oppKill, c: '#454647' },
    ]),
  },
  leaders: {
    title: 'Лидеры', hint: 'Топ-3 по очкам, атаке, блоку и эйсам',
    render: c => `<div class="leaders">${[
      ['Больше всего очков', p => quickTotals(p).points], ['Атака', p => p.kill], ['Блок', p => p.block], ['Эйсы', p => p.ace],
    ].map(([t, get]) => `<div class="kpi"><div class="t">${t}</div>
      ${top(c, get).map((x, i) => `<div class="lead"><span><span class="meta mr-2">${i + 1}</span>${nameOf(c, x.id)}</span><b>${x.v}</b></div>`).join('') || '<div class="muted small">—</div>'}
    </div>`).join('')}</div>`,
  },
  errors: {
    title: 'Больше всего ошибок', hint: 'Кто чаще отдаёт очки и какими ошибками',
    render: c => {
      const list = top(c, p => quickTotals(p).errors, 5);
      if (!list.length) return '<p class="muted small">Ошибок нет 👏</p>';
      return `<div class="kpi">${list.map(x => {
        const p = c.players[x.id];
        const detail = PLAYER_ERRORS.filter(k => p[k]).map(k => `${RESULTS[k].label.toLowerCase()} ${p[k]}`).join(', ');
        return `<div class="lead"><span>${nameOf(c, x.id)} <small class="muted">${detail}</small></span><b class="neg">${x.v}</b></div>`;
      }).join('')}</div>`;
    },
  },
  players: {
    title: 'Таблица игроков', hint: 'Все показатели по каждому игроку; колонки настраиваются',
    render: c => {
      const cols = COLUMNS.filter(col => c.dash.columns.includes(col.id));
      const sortCol = COLUMNS.find(col => col.id === sortKey) || COLUMNS[0];
      const ids = Object.keys(c.players).sort((a, b) => sortCol.get(c.players[b], c) - sortCol.get(c.players[a], c));
      const cell = (col, p) => `<td class="${col.bold ? 'b' : ''}">${col.fmt ? col.fmt(col.get(p, c)) : z(col.get(p, c))}</td>`;
      return `<p class="muted small" style="margin:0 0 8px"><span class="pos">Зелёные</span> — очки, которые игрок принёс.
        <span class="neg">Красные</span> — очки, отданные сопернику ошибкой. Нажмите на заголовок, чтобы отсортировать.</p>
        <div class="tablewrap"><table class="table">
        <thead><tr><th class="l">Игрок</th>${cols.map(col => `<th class="sort ${col.kind} ${col.id === sortKey ? 'on' : ''}" data-sort="${col.id}">${col.title}</th>`).join('')}</tr></thead>
        <tbody>${ids.map(id => `<tr><td class="l">${nameOf(c, id)}</td>${cols.map(col => cell(col, c.players[id])).join('')}</tr>`).join('')
          || `<tr><td colspan="${cols.length + 1}" class="muted">Пока нет розыгрышей с игроками</td></tr>`}</tbody>
        <tfoot><tr class="total"><td class="l">Команда</td>${cols.map(col => cell(col, c.total)).join('')}</tr></tfoot>
      </table></div>`;
    },
  },
  breakdown: {
    title: 'По партиям / по матчам', hint: 'Один матч — по партиям, несколько — по матчам',
    render: c => {
      const head = '<th>Счёт</th><th class="g">Атака</th><th class="g">Блок</th><th class="g">Эйс</th><th class="g">Ошибки соперника</th><th class="r">Наши ошибки</th><th class="r">Соперник забил</th>';
      const line = (label, score, st, key) => {
        const p = sum(Object.values(st.players[key] || {}));
        const t = st.teams[key] || newQuickTeam();
        return `<tr><td class="l">${label}</td><td><b>${score}</b></td><td>${z(p.kill)}</td><td>${z(p.block)}</td><td>${z(p.ace)}</td>
          <td>${z(t.oppErr)}</td><td>${z(quickTotals(p).errors)}</td><td>${z(t.oppKill)}</td></tr>`;
      };
      const body = c.single
        ? c.single.st.sets.map(s => line(`Партия ${s.n + 1}${s.n === 2 ? ' (тай-брейк)' : ''}`, `${s.us}:${s.them}`, c.single.st, s.n)).join('')
        : c.rows.map(({ m, st }) => line(`${esc(m.opponent)}, ${date(m)}`, `${st.setsWon.us}:${st.setsWon.them}`, st, 'all')).join('');
      return `<div class="tablewrap"><table class="table"><thead><tr><th class="l">${c.single ? 'Партия' : 'Матч'}</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    },
  },
  runs: {
    title: 'Серии', hint: 'Самые длинные серии очков подряд — у нас и у соперника',
    render: c => {
      const best = side => {
        let cur = 0, max = 0, at = null;
        for (const r of c.rallies) {
          cur = r.side === side ? cur + 1 : 0;
          if (cur > max) { max = cur; at = r; }
        }
        return { max, at };
      };
      const us = best('us'), them = best('them');
      const where = r => (r ? `партия ${r.set + 1}, до счёта ${r.us}:${r.them}` : '');
      return `<div class="kpis">${kpi('Наша лучшая серия', us.max, where(us.at))}${kpi('Серия соперника', them.max, where(them.at))}</div>`;
    },
  },
  recent: {
    title: 'Последние розыгрыши', hint: 'Лента последних 10 очков (только для одного матча)',
    render: c => {
      if (!c.single) return '<p class="muted small">Выберите один матч в фильтре.</p>';
      const log = c.single.st.log.filter(l => l.side).slice(-10).reverse();
      return `<div class="kpi feed">${log.map(l => `<div class="${l.side === 'us' ? 'pos' : 'neg'}">${esc(l.text)}</div>`).join('') || '<div class="muted">Пока пусто</div>'}</div>`;
    },
  },
  matches: {
    title: 'Список матчей', hint: 'Когда выбрано несколько матчей — с кнопкой «Открыть»',
    render: c => (c.single ? '' : `<div class="tablewrap"><table class="table">
      <thead><tr><th class="l">Дата</th><th class="l">Соперник</th><th>Партии</th><th class="l">Счёт по партиям</th><th></th></tr></thead>
      <tbody>${c.rows.map(({ m, st }) => `<tr>
        <td class="l">${date(m)}</td><td class="l">${esc(m.opponent)}</td><td><b>${st.setsWon.us} : ${st.setsWon.them}</b></td>
        <td class="l">${st.sets.map(s => `${s.us}:${s.them}`).join(', ') || '—'}</td>
        <td><button class="btn btn-sm" data-match="${m.id}">Открыть</button></td></tr>`).join('')}</tbody>
    </table></div>`),
  },
};

const DEFAULT_DASH = {
  blocks: ['summary', 'serve', 'sources', 'losses', 'leaders', 'players', 'breakdown', 'errors', 'matches'],
  columns: ['points', 'kill', 'block', 'ace', 'errors', 'srvErr', 'attErr', 'blocked', 'recErr', 'digErr', 'fault', 'lost', 'diff'],
};
// Сохранённая настройка + защита от неизвестных id (если блок переименуют в новой версии).
// Колонки, появившиеся уже после сохранения настройки, включаем сами — иначе новую статистику никто не увидит.
// known — какие колонки существовали при сохранении; у настроек до этого правила его нет — тогда берём список того времени.
const ALL_COLUMNS = COLUMNS.map(c => c.id);
const KNOWN_BEFORE_RULE = ['points', 'kill', 'block', 'ace', 'errors', 'srvErr', 'attErr', 'blocked', 'recErr', 'fault', 'diff', 'share'];
function dashConfig() {
  const d = settings?.quickDash || DEFAULT_DASH;
  const known = d.known || KNOWN_BEFORE_RULE;
  const on = new Set([...d.columns, ...ALL_COLUMNS.filter(id => !known.includes(id))]);
  return { blocks: d.blocks.filter(id => BLOCKS[id]), columns: ALL_COLUMNS.filter(id => on.has(id)) };
}

// ---------- Панель «Настроить» ----------

function viewConfig() {
  const all = [...draft.blocks, ...Object.keys(BLOCKS).filter(id => !draft.blocks.includes(id))];
  return `<div class="card config">
    <h2 style="margin-top:0">Блоки дашборда</h2>
    <p class="muted small">Галочка — показывать. Стрелки — порядок на странице.</p>
    ${all.map(id => {
      const on = draft.blocks.includes(id);
      const k = draft.blocks.indexOf(id);
      return `<div class="cfg-row ${on ? '' : 'off'}">
        <label><input type="checkbox" data-block="${id}" ${on ? 'checked' : ''}><span><b>${BLOCKS[id].title}</b><small>${BLOCKS[id].hint}</small></span></label>
        ${on ? `<button class="btn btn-sm" data-move="${id}" data-dir="-1" ${k === 0 ? 'disabled' : ''}>↑</button>
                <button class="btn btn-sm" data-move="${id}" data-dir="1" ${k === draft.blocks.length - 1 ? 'disabled' : ''}>↓</button>` : ''}
      </div>`;
    }).join('')}
    <h2>Колонки таблицы игроков</h2>
    <div class="cfg-cols">${COLUMNS.map(col => `<label class="${col.kind}"><input type="checkbox" data-col="${col.id}" ${draft.columns.includes(col.id) ? 'checked' : ''}>${col.title}</label>`).join('')}</div>
    <div class="pair" style="margin-top:16px">
      <button class="btn btn-primary" data-cfg="save">Сохранить</button>
      <button class="btn" data-cfg="cancel">Отмена</button>
    </div>
    <button class="btn btn-ghost" data-cfg="reset" style="margin-top:6px">Вернуть как было по умолчанию</button>
  </div>`;
}

// ---------- Отрисовка ----------

async function refresh() {
  // Не перерисовываем, пока открыт выпадающий список или панель настройки — иначе они закроются под рукой.
  if (draft || document.activeElement?.tagName === 'SELECT') return;
  const [s, matches] = await Promise.all([fetch('/api/settings').then(r => r.json()), fetch('/api/matches?full&mode=quick').then(r => r.json())]);
  settings = s;

  const candidates = matches.filter(m => oppFilter === 'all' || m.opponentId === oppFilter);
  if (matchSel === null) matchSel = candidates[0]?.id ?? 'all';
  if (matchSel !== 'all' && !candidates.some(m => m.id === matchSel)) matchSel = 'all';
  const rows = candidates.filter(m => matchSel === 'all' || m.id === matchSel).map(m => ({ m, st: replayQuick(m) }));
  const single = rows.length === 1 ? rows[0] : null;
  if (!single || (scope !== 'all' && !single.st.sets[scope])) scope = 'all';

  // Собираем всё, что нужно блокам, один раз.
  const players = {}, team = newQuickTeam(), rallies = [];
  let w = 0, l = 0, setsUs = 0, setsThem = 0;
  for (const { st } of rows) {
    for (const [id, p] of Object.entries(st.players[scope] || {})) addStats((players[id] ??= newQuickPlayer()), p);
    if (st.teams[scope]) addStats(team, st.teams[scope]);
    rallies.push(...st.rallies.filter(r => scope === 'all' || r.set === scope), { side: null }); // null — разрыв между матчами для серий
    if (st.setsWon.us > st.setsWon.them) w++;
    if (st.setsWon.them > st.setsWon.us) l++;
    setsUs += st.setsWon.us; setsThem += st.setsWon.them;
  }
  const total = sum(Object.values(players));
  const won = PLAYER_POINTS.reduce((a, k) => a + total[k], 0) + team.oppErr;
  const lost = PLAYER_ERRORS.reduce((a, k) => a + total[k], 0) + team.oppKill;
  const people = Object.values(Object.fromEntries(rows.flatMap(({ m }) => m.roster).map(p => [p.id, p])));
  const ctx = {
    rows, single, players, team, total, won, lost, w, l, setsUs, setsThem, people, rallies,
    teamPoints: quickTotals(total).points, dash: dashConfig(),
  };

  const title = single
    ? `${esc(settings.teamName)} ${single.st.setsWon.us} : ${single.st.setsWon.them} ${esc(single.m.opponent)}`
    : `${esc(settings.teamName)}: быстрая статистика`;

  paint(`
    <div class="topbar">
      <a class="btn btn-ghost btn-sm -ml-3 gap-2" href="/"><img src="img/logo.svg" alt="" class="size-5 rounded-[5px]">Режимы</a>
      <span class="flex gap-2"><a class="btn btn-ghost btn-sm" href="quick.html">Пульт</a><button class="btn btn-sm" data-cfg="open">Настроить дашборд</button></span>
    </div>
    <h1>${title}</h1>
    <div class="filters">
      <select id="opp"><option value="all">Все соперники</option>
        ${settings.opponents.map(o => `<option value="${o.id}" ${o.id === oppFilter ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>
      <select id="match"><option value="all">Все матчи (${candidates.length})</option>
        ${candidates.map(m => `<option value="${m.id}" ${m.id === matchSel ? 'selected' : ''}>${esc(m.opponent)}, ${date(m)}</option>`).join('')}</select>
    </div>
    ${single ? `<div class="tabs">
        <button class="btn btn-sm ${scope === 'all' ? 'btn-primary' : ''}" data-scope="all">Весь матч</button>
        ${single.st.sets.map(s => `<button class="btn btn-sm ${scope === s.n ? 'btn-primary' : ''}" data-scope="${s.n}">${s.n === 2 ? 'Тай-брейк' : `Партия ${s.n + 1}`} <span class="num text-ash">${s.us}:${s.them}</span></button>`).join('')}
      </div>` : ''}
    ${!rows.length ? '<p class="muted">Пока нет матчей быстрой статистики.</p>'
      : ctx.dash.blocks.map(id => {
        const html = BLOCKS[id].render(ctx);
        return html ? `<section><h2>${BLOCKS[id].title}</h2>${html}</section>` : '';
      }).join('')}`);
}

// Перерисовываем, только если что-то изменилось, и сохраняем горизонтальную прокрутку таблиц —
// иначе автообновление каждые 3 секунды сбрасывало бы прокрученную таблицу в начало.
let lastHtml = '';
function paint(html) {
  if (html === lastHtml) return;
  const scrolls = [...$app.querySelectorAll('.tablewrap')].map(el => el.scrollLeft);
  $app.innerHTML = lastHtml = html;
  $app.querySelectorAll('.tablewrap').forEach((el, i) => { el.scrollLeft = scrolls[i] ?? 0; });
}

function renderConfig() {
  lastHtml = ''; // после закрытия панели дашборд должен нарисоваться заново
  $app.innerHTML = `<div class="topbar"><a class="btn btn-ghost btn-sm -ml-3 gap-2" href="/"><img src="img/logo.svg" alt="" class="size-5 rounded-[5px]">Режимы</a></div><h1>Настройка дашборда</h1>${viewConfig()}`;
}

async function saveDash(dash) {
  settings = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quickDash: { ...dash, known: ALL_COLUMNS } }) }).then(r => r.json());
}

// ---------- События ----------

$app.addEventListener('change', e => {
  const t = e.target;
  if (draft && t.dataset.block) {
    const id = t.dataset.block;
    draft.blocks = t.checked ? [...draft.blocks, id] : draft.blocks.filter(x => x !== id);
    return renderConfig();
  }
  if (draft && t.dataset.col) {
    // Колонки держим в порядке каталога, а не в порядке нажатий.
    const on = new Set(draft.columns);
    t.checked ? on.add(t.dataset.col) : on.delete(t.dataset.col);
    draft.columns = COLUMNS.map(c => c.id).filter(id => on.has(id));
    return;
  }
  if (t.id === 'opp') { oppFilter = t.value; matchSel = 'all'; }
  if (t.id === 'match') matchSel = t.value;
  scope = 'all';
  t.blur();
  refresh();
});

$app.addEventListener('click', async e => {
  const el = e.target.closest('[data-scope],[data-match],[data-sort],[data-move],[data-cfg]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  if (d.scope !== undefined) { scope = d.scope === 'all' ? 'all' : Number(d.scope); return refresh(); }
  if (d.match) { matchSel = d.match; scope = 'all'; return refresh(); }
  if (d.sort) { sortKey = d.sort; return refresh(); }
  if (d.move) {
    const k = draft.blocks.indexOf(d.move), j = k + Number(d.dir);
    [draft.blocks[k], draft.blocks[j]] = [draft.blocks[j], draft.blocks[k]];
    return renderConfig();
  }
  if (d.cfg === 'open') { draft = structuredClone(dashConfig()); return renderConfig(); }
  if (d.cfg === 'reset') { draft = structuredClone(DEFAULT_DASH); return renderConfig(); }
  if (d.cfg === 'cancel') { draft = null; history.replaceState(null, '', location.pathname); return refresh(); }
  if (d.cfg === 'save') {
    try { await saveDash(draft); } catch { return alert('Не удалось сохранить — нет связи с компьютером'); }
    draft = null;
    history.replaceState(null, '', location.pathname);
    return refresh();
  }
});

// #config — сразу открыть настройку (ссылка из «Настроек»).
(async () => {
  await refresh();
  if (location.hash === '#config') { draft = structuredClone(dashConfig()); renderConfig(); }
})();
setInterval(refresh, 3000);
