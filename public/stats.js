// Дашборд для компьютера: фильтры по сопернику и матчу, обновляется сам каждые 3 секунды.
import { replay, totals, pct, newPlayer, playerName, addStats } from './engine.js';

const $app = document.getElementById('app');
// oppFilter: 'all' или id соперника; matchSel: 'all' или id матча (по умолчанию — последний матч).
let oppFilter = 'all', matchSel = null, scope = 'all';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const z = v => (v ? v : '·');
const signed = v => `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v > 0 ? '+' : ''}${v}</span>`;
const date = m => new Date(m.created).toLocaleDateString('ru');

function playerRow(label, p, cls = '') {
  const { points, diff } = totals(p);
  const a = p.att;
  return `<tr class="${cls}">
    <td class="l">${label}</td>
    <td class="b">${z(points)}</td><td>${signed(diff)}</td>
    <td class="b">${z(p.serve.tot)}</td><td>${z(p.serve.err)}</td><td>${z(p.serve.ace)}</td>
    <td class="b">${z(p.rec.tot)}</td><td>${z(p.rec.err)}</td><td>${pct(p.rec.pp + p.rec.pm, p.rec.tot)}</td><td>${pct(p.rec.pp, p.rec.tot)}</td>
    <td class="b">${z(a.tot)}</td><td>${z(a.kill + a.bo)}</td><td>${z(a.bo)}</td><td>${z(a.err)}</td><td>${z(a.blk)}</td><td>${pct(a.kill + a.bo, a.tot)}</td>
    <td class="b">${z(p.blk.point)}</td><td>${z(p.blk.touch)}</td><td>${z(p.blk.out)}</td>
    <td class="b">${z(p.dig.tot)}</td><td>${z(p.dig.plus)}</td><td>${z(p.dig.minus)}</td><td>${z(p.dig.err)}</td>
    <td class="b">${z(p.fault)}</td>
  </tr>`;
}

// people — общий состав выбранных матчей (с актуальными именами от сервера).
function playersTable(people, stats) {
  const rows = [...people].sort((a, b) => a.num - b.num).filter(p => stats[p.id])
    .map(p => playerRow(esc(playerName({ roster: people }, p.id)), stats[p.id]));
  return `<div class="wrap"><table>
    <tr><th></th><th class="grp" colspan="2">Очки</th><th class="grp" colspan="3">Подача</th><th class="grp" colspan="4">Приём</th>
      <th class="grp" colspan="6">Атака</th><th class="grp" colspan="3">Блок</th><th class="grp" colspan="4">Защита</th><th class="grp">Проч.</th></tr>
    <tr><th class="l">Игрок</th><th>Всего</th><th>+/−</th><th>Всего</th><th>Ош</th><th>Эйс</th>
      <th>Всего</th><th>Ош</th><th>Поз (++,+−)</th><th>Идеал (++)</th>
      <th>Всего</th><th>Очки</th><th>из них блок-аут</th><th>Ош</th><th>Заблок</th><th>Эфф</th>
      <th>Очки</th><th>Касание</th><th>Блок-аут</th><th>Всего</th><th>+</th><th>−</th><th>Не поднял</th><th>Ош</th></tr>
    ${rows.join('')}
    ${playerRow('Итого по команде', Object.values(stats).reduce(addStats, newPlayer()), 'total')}
  </table></div>`;
}

const kpi = (title, v, s) => `<div class="card"><div class="s">${title}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;

function teamBlock(people, team) {
  const r = team.afterRec;
  const links = Object.values(team.links).sort((a, b) => b.tot - a.tot);
  const name = id => esc(playerName({ roster: people }, id));
  return `
    <div class="kpi">
      ${kpi('Сайд-аут', pct(team.sideout.won, team.sideout.n), `выиграли ${team.sideout.won} из ${team.sideout.n} на чужой подаче`)}
      ${kpi('Брейк', pct(team.brk.won, team.brk.n), `выиграли ${team.brk.won} из ${team.brk.n} на своей подаче`)}
      ${kpi('После приёма ++', pct(r.pp.won, r.pp.n), `${r.pp.won} из ${r.pp.n}`)}
      ${kpi('После приёма +−', pct(r.pm.won, r.pm.n), `${r.pm.won} из ${r.pm.n}`)}
      ${kpi('После приёма +', pct(r.p.won, r.p.n), `${r.p.won} из ${r.p.n}`)}
      ${kpi('Подарки от соперника', team.oppError, 'ошибки соперника')}
      ${kpi('Соперник забил', team.oppKill, `эйсов соперника: ${team.oppAce}`)}
      ${kpi('Без статистики', team.noStats, 'очков внесено кнопкой «+1»')}
    </div>
    <h2>Связки «связующий → нападающий»</h2>
    <p class="hint">Связующий подставляется автоматически: тот, кто отмечен «связ.» в составе и стоит на площадке.</p>
    <div class="wrap"><table style="max-width:600px">
      <tr><th class="l">Связующий</th><th class="l">Нападающий</th><th>Атак</th><th>Очки</th><th>Ош+Заблок</th><th>Эфф</th></tr>
      ${links.map(l => `<tr><td class="l">${l.setter ? name(l.setter) : '—'}</td><td class="l">${name(l.attacker)}</td>
        <td>${l.tot}</td><td>${z(l.kill)}</td><td>${z(l.err)}</td><td>${pct(l.kill, l.tot)}</td></tr>`).join('') || '<tr><td colspan="6">Пока нет атак</td></tr>'}
    </table></div>`;
}

// Итоги по выбранным матчам: победы, партии, очки.
function summary(rows) {
  let w = 0, l = 0, su = 0, st = 0, pu = 0, pt = 0;
  for (const { st: s } of rows) {
    if (s.setsWon.us > s.setsWon.them) w++;
    if (s.setsWon.them > s.setsWon.us) l++;
    su += s.setsWon.us; st += s.setsWon.them;
    for (const set of s.sets) { pu += set.us; pt += set.them; }
  }
  return `<div class="kpi">
    ${kpi('Матчей', rows.length, `побед ${w} · поражений ${l}`)}
    ${kpi('Партии', `${su} : ${st}`, 'выиграно : проиграно')}
    ${kpi('Очки', `${pu} : ${pt}`, `разница ${pu - pt > 0 ? '+' : ''}${pu - pt}`)}
  </div>`;
}

function matchList(rows) {
  return `<div class="wrap"><table>
    <tr><th class="l">Дата</th><th class="l">Соперник</th><th>Партии</th><th class="l">Счёт по партиям</th><th></th></tr>
    ${rows.map(({ m, st }) => `<tr>
      <td class="l">${date(m)}</td><td class="l">${esc(m.opponent)}</td>
      <td>${st.setsWon.us} : ${st.setsWon.them}</td>
      <td class="l">${st.sets.map(s => `${s.us}:${s.them}`).join(', ') || '—'}</td>
      <td><button data-match="${m.id}" style="min-height:32px;padding:4px 12px">Открыть</button></td></tr>`).join('')}
  </table></div>`;
}

async function refresh() {
  // Не перерисовываем, пока открыт выпадающий список — иначе он закроется под рукой.
  if (document.activeElement?.tagName === 'SELECT') return;
  const [settings, matches] = await Promise.all([fetch('/api/settings').then(r => r.json()), fetch('/api/matches?full').then(r => r.json())]);

  const candidates = matches.filter(m => oppFilter === 'all' || m.opponentId === oppFilter);
  if (matchSel === null) matchSel = candidates[0]?.id ?? 'all';
  if (matchSel !== 'all' && !candidates.some(m => m.id === matchSel)) matchSel = 'all';
  const rows = candidates.filter(m => matchSel === 'all' || m.id === matchSel).map(m => ({ m, st: replay(m) }));
  const single = rows.length === 1 ? rows[0] : null;
  if (!single || (scope !== 'all' && !single.st.sets[scope])) scope = 'all';

  const players = {}, team = {};
  for (const { st } of rows) {
    for (const [id, p] of Object.entries(st.players[scope] || {})) addStats((players[id] ??= newPlayer()), p);
    if (st.teams[scope]) addStats(team, st.teams[scope]);
  }
  const people = Object.values(Object.fromEntries(rows.flatMap(({ m }) => m.roster).map(p => [p.id, p])));

  const title = single
    ? `${esc(settings.teamName)} ${single.st.setsWon.us} : ${single.st.setsWon.them} ${esc(single.m.opponent)}`
    : esc(settings.teamName);

  paint(`
    <a href="/" class="hint">← Пульт и настройки</a>
    <h1>${title}</h1>
    <div class="row" style="flex-wrap:wrap">
      <select id="opp"><option value="all">Все соперники</option>
        ${settings.opponents.map(o => `<option value="${o.id}" ${o.id === oppFilter ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>
      <select id="match"><option value="all">Все матчи (${candidates.length})</option>
        ${candidates.map(m => `<option value="${m.id}" ${m.id === matchSel ? 'selected' : ''}>${esc(m.opponent)} · ${date(m)}</option>`).join('')}</select>
    </div>
    ${single ? `
      <p class="hint">По партиям: ${single.st.sets.map(s => `${s.us}:${s.them}`).join(', ') || '—'}</p>
      <div class="tabs">
        <button class="${scope === 'all' ? 'primary' : ''}" data-scope="all">Весь матч</button>
        ${single.st.sets.map(s => `<button class="${scope === s.n ? 'primary' : ''}" data-scope="${s.n}">Партия ${s.n + 1}</button>`).join('')}
      </div>` : rows.length ? summary(rows) : ''}
    ${team.sideout ? playersTable(people, players) + '<h2>Команда</h2>' + teamBlock(people, team) : '<p class="hint">Пока нет розыгрышей</p>'}
    ${!single && rows.length ? '<h2>Матчи</h2>' + matchList(rows) : ''}`);
}

// Перерисовываем, только если что-то изменилось, и сохраняем горизонтальную прокрутку таблиц —
// иначе автообновление каждые 3 секунды сбрасывало бы прокрученную таблицу в начало.
let lastHtml = '';
function paint(html) {
  if (html === lastHtml) return;
  const scrolls = [...$app.querySelectorAll('.wrap')].map(el => el.scrollLeft);
  $app.innerHTML = lastHtml = html;
  $app.querySelectorAll('.wrap').forEach((el, i) => { el.scrollLeft = scrolls[i] ?? 0; });
}

$app.addEventListener('change', e => {
  if (e.target.id === 'opp') { oppFilter = e.target.value; matchSel = 'all'; }
  if (e.target.id === 'match') matchSel = e.target.value;
  scope = 'all';
  e.target.blur();
  refresh();
});
$app.addEventListener('click', e => {
  const s = e.target.closest('[data-scope]')?.dataset.scope;
  if (s !== undefined) { scope = s === 'all' ? 'all' : Number(s); refresh(); }
  const m = e.target.closest('[data-match]')?.dataset.match;
  if (m) { matchSel = m; scope = 'all'; refresh(); }
});

refresh();
setInterval(refresh, 3000);
