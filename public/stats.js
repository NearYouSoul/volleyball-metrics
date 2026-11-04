// Дашборд детальной статистики: обзор, ход партии, тепловые карты, отчёт связующего,
// расстановки, игроки. Всё считается из «розыгрыша по касаниям» (plays) движка — с фильтрами.
import { replay, totals, newPlayer, playerName, addStats, ACTIONS, LABELS, REC_RATING, attEff, recRating, SKILLS, timeoutEffect } from './engine.js';
import { slotZones, zoneOfSlot, SYSTEMS, zoneOf, TEMPOS, NET } from './court.js';
import { courtBase, heat, svgWrap, sx, sy } from './studio/court2d.js';

const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const P = (a, b) => (b ? Math.round((100 * a) / b) : null);
const pc = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
const sgn = v => (v > 0 ? '+' : '') + v;
const dt = m => new Date(m.created).toLocaleDateString('ru');
const z = v => v || '·';
const emb = src => (src ? `<img class="emb" src="${src}" alt="">` : '');

// Цвета. Категории (направления паса) — проверенная палитра для тёмного фона; исходы — «наш/их» с подписью.
const DIRS = { 4: 'Край (4)', 3: 'Центр (3)', 2: 'Диагональ (2)', pipe: 'Пайп', back: 'Задняя линия', dump: 'Скидка' };
const DIR_ORDER = ['4', '3', '2', 'pipe', 'back', 'dump'];
const DIR_COLOR = { 4: '#3f86e8', 3: '#b8892a', 2: '#8a6ee0', pipe: '#1f9b90', back: '#d06a28', dump: '#7d8089' };
const dirKey = d => (d === 1 || d === 5 || d === '1' || d === '5' ? 'back' : d == null ? null : String(d));
const OUT_COLOR = { us: '#59d499', them: '#ff6363', null: '#a0a3aa' };
const REC_LABEL = { pp: '++', pm: '+−', p: '+', trans: 'Переход' };

let F = { tour: 'all', opp: 'all', match: null, set: 'all', player: 'all', rot: 'all', phase: 'all', skill: 'att', dots: true, heat: true, traj: false, setter: null, sort: 'points' };
let DATA = null;

// ---------- Данные ----------
async function load() {
  const [settings, matches] = await Promise.all([fetch('/api/settings').then(r => r.json()), fetch('/api/matches?full').then(r => r.json())]);
  DATA = { settings, matches, sig: sig(matches) };
}
const sig = ms => ms.map(m => m.id + ':' + (m.events?.length ?? m.events)).join('|');

function view() {
  const { matches, settings } = DATA;
  const cands = matches.filter(m => (F.opp === 'all' || m.opponentId === F.opp) && (F.tour === 'all' || (F.tour === 'none' ? !m.tournament : m.tournament === F.tour)));
  const hashM = location.hash.match(/m=([a-z0-9]+)/)?.[1];
  if (F.match === null) F.match = hashM && cands.some(m => m.id === hashM) ? hashM : cands[0]?.id ?? 'all';
  if (F.match !== 'all' && !cands.some(m => m.id === F.match)) F.match = 'all';
  const rows = cands.filter(m => F.match === 'all' || m.id === F.match).map(m => ({ m, st: replay(m) }));
  const people = Object.values(Object.fromEntries(rows.flatMap(({ m }) => m.roster).map(p => [p.id, p])));
  const nm = id => esc(playerName({ roster: people }, id));
  const scope = F.set === 'all' ? 'all' : Number(F.set);
  const plays = rows.flatMap(({ m, st }) => st.plays.map(p => ({ ...p, mid: m.id })))
    .filter(p => scope === 'all' || p.set === scope)
    .filter(p => F.rot === 'all' || p.rot === Number(F.rot))
    .filter(p => F.phase === 'all' || (F.phase === 'so' ? !p.weServe : p.weServe));
  return { settings, cands, rows, people, nm, scope, plays };
}

// ---------- Подсказки ----------
const tip = document.getElementById('tip');
document.addEventListener('mousemove', e => {
  const el = e.target.closest('[data-tip]');
  if (!el) return tip.classList.remove('on');
  tip.innerHTML = el.dataset.tip;
  tip.style.left = e.clientX + 'px';
  tip.style.top = e.clientY + 'px';
  tip.classList.add('on');
});

// ---------- Фильтры ----------
function filters(v) {
  const { settings, cands, rows } = v;
  const sel = (k, opts, label) => `<label>${label}<select data-f="${k}">${opts.map(([val, t]) => `<option value="${val}" ${String(F[k]) === String(val) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
  const maxSets = Math.max(0, ...rows.map(r => r.st.sets.length));
  const people = [...v.people].sort((a, b) => a.num - b.num);
  const tours = settings.tournaments ?? [];
  return [
    ...(tours.length ? [sel('tour', [['all', 'Все турниры'], ...tours.map(t => [t.id, t.name]), ['none', 'Без турнира']], 'Турнир')] : []),
    sel('opp', [['all', 'Все соперники'], ...settings.opponents.map(o => [o.id, o.name])], 'Соперник'),
    sel('match', [['all', `Все матчи (${cands.length})`], ...cands.map(m => [m.id, `${dt(m)} · ${m.opponent}`])], 'Матч'),
    sel('set', [['all', 'Все партии'], ...Array.from({ length: maxSets }, (_, i) => [i, `Партия ${i + 1}`])], 'Партия'),
    sel('rot', [['all', 'Все'], ...[1, 2, 3, 4, 5, 6].map(r => [r, `Р${r}`])], 'Расстановка'),
    sel('phase', [['all', 'Все розыгрыши'], ['so', 'Сайд-аут (подают они)'], ['brk', 'Брейк (подаём мы)']], 'Фаза'),
    sel('player', [['all', 'Вся команда'], ...people.map(p => [p.id, playerName({ roster: people }, p.id)])], 'Игрок'),
    '<span class="grow"></span><span class="muted" style="font-size:12px">обновляется само</span>',
  ].join('');
}

// ---------- Обзор ----------
function teamAgg(v) {
  const t = {};
  for (const { st } of v.rows) if (st.teams[v.scope]) addStats(t, st.teams[v.scope]);
  return t;
}
function kpi(title, value, sub, extra = '') {
  return `<div class="kpi"><div class="t">${title}</div><div class="v">${value}</div><div class="s">${sub}</div>${extra}</div>`;
}
function bar(parts) {
  const tot = parts.reduce((a, p) => a + p.n, 0) || 1;
  return `<div class="bar">${parts.filter(p => p.n).map(p => `<i style="width:${(100 * p.n) / tot}%;background:${p.c}" data-tip="<b>${esc(p.t)}</b>: ${p.n} (${Math.round((100 * p.n) / tot)}%)"></i>`).join('')}</div>`;
}
function overview(v) {
  const t = teamAgg(v);
  const rc = F.rot !== 'all' ? t.rot?.[F.rot] : null;
  const so = rc ? rc.so : t.sideout || { n: 0, won: 0 }, brk = rc ? rc.brk : t.brk || { n: 0, won: 0 };
  const pl = v.plays.filter(p => F.player === 'all' || p.p === F.player);
  const att = pl.filter(p => p.skill === 'att');
  const k = att.filter(p => p.res === 'kill' || p.res === 'bo').length, e = att.filter(p => p.res === 'error').length, b = att.filter(p => p.res === 'blocked').length;
  const rec = pl.filter(p => p.skill === 'rec');
  const rcnt = r => rec.filter(p => p.res === r).length;
  const rr = rec.length ? rec.reduce((a, p) => a + REC_RATING[p.res], 0) / rec.length : null;
  const sets = pl.filter(p => p.skill === 'set' && !p.virtual);
  const scnt = r => sets.filter(p => p.res === r).length;
  const players = {};
  for (const { st } of v.rows) for (const [id, p] of Object.entries(st.players[v.scope] || {})) if (F.player === 'all' || id === F.player) addStats((players[id] ??= newPlayer()), p);
  const sum = Object.values(players).reduce(addStats, newPlayer());
  const pts = totals(sum);
  return `<section class="dsec" id="overview">
    <h2>Обзор</h2>
    <p class="sub">${v.rows.length === 1 ? `${emb(v.settings.emblem)}${esc(v.settings.teamName)} ${v.rows[0].st.setsWon.us}:${v.rows[0].st.setsWon.them} ${emb(v.settings.opponents.find(o => o.id === v.rows[0].m.opponentId)?.emblem)}${esc(v.rows[0].m.opponent)} · ${v.rows[0].st.sets.map(s => `${s.us}:${s.them}`).join(', ')}` : `${emb(v.settings.emblem)}Матчей: ${v.rows.length}`}${F.rot !== 'all' ? ` · только расстановка Р${F.rot}` : ''}</p>
    <div class="kpis">
      ${kpi('Сайд-аут', pc(so.won, so.n), `выиграли ${so.won} из ${so.n} на их подаче`)}
      ${kpi('Брейк', pc(brk.won, brk.n), `выиграли ${brk.won} из ${brk.n} на своей подаче`)}
      ${kpi('Атака', pc(k, att.length), att.length ? `эфф ${sgn(Math.round((100 * (k - e - b)) / att.length))}% · ${k} очков, ${e} ош, ${b} блок из ${att.length}` : 'атак нет',
        bar([{ n: k, c: OUT_COLOR.us, t: 'Очко' }, { n: att.length - k - e - b, c: '#3a3d44', t: 'В игре' }, { n: e + b, c: OUT_COLOR.them, t: 'Ошибка / блок' }]))}
      ${kpi('Приём', rr == null ? '–' : `${rr.toFixed(2)}<small>из 3</small>`, `позитив ${pc(rcnt('pp') + rcnt('pm'), rec.length)} · идеал ${pc(rcnt('pp'), rec.length)} · ош ${rcnt('error')}`,
        bar([{ n: rcnt('pp'), c: '#59d499', t: '++' }, { n: rcnt('pm'), c: '#3f86e8', t: '+−' }, { n: rcnt('p') + rcnt('over'), c: '#b8892a', t: '+ / перекид' }, { n: rcnt('error'), c: '#ff6363', t: 'Ошибка' }]))}
      ${kpi('Пас', sets.length ? pc(scnt('perfect') + scnt('good'), sets.length) : '–', `хороший и идеальный · отмечено пасов ${sets.length}`,
        bar([{ n: scnt('perfect'), c: '#59d499', t: 'Идеальный' }, { n: scnt('good'), c: '#3f86e8', t: 'Хороший' }, { n: scnt('poor'), c: '#b8892a', t: 'Неудобный' }, { n: scnt('error'), c: '#ff6363', t: 'Ошибка' }]))}
      ${kpi('Подача', `${sum.serve.ace}<small>эйс</small> ${sum.serve.err}<small>ош</small>`, `сложных ${sum.serve.good} · всего ${sum.serve.tot}`)}
      ${kpi('Очки игроков', `${pts.points}<small>/ ${pts.errors} ош</small>`, `разница ${sgn(pts.diff)} · блок ${sum.blk.point}`)}
      ${kpi('Подарки', `${t.oppError || 0}<small>от них</small>`, `соперник забил ${t.oppKill || 0} · эйсов ${t.oppAce || 0}`)}
    </div></section>`;
}

// ---------- Ход партии: разница в счёте по розыгрышам ----------
function flow(v) {
  if (v.rows.length !== 1) return `<section class="dsec" id="flow"><h2>Ход партии</h2><div class="empty">Выберите один матч в фильтре — покажем, как менялся счёт.</div></section>`;
  const { st } = v.rows[0];
  const sets = st.sets.filter(s => v.scope === 'all' || s.n === v.scope);
  const charts = sets.map(s => {
    const W = 640, H = 200, pad = { l: 28, r: 10, t: 14, b: 22 };
    let us = 0, th = 0;
    const pts = [{ d: 0, us: 0, th: 0 }];
    for (const w of s.flow) { w === 'us' ? us++ : th++; pts.push({ d: us - th, us, th, w }); }
    const max = Math.max(4, ...pts.map(p => Math.abs(p.d)));
    const X = i => pad.l + (i / Math.max(1, pts.length - 1)) * (W - pad.l - pad.r);
    const Y = d => pad.t + ((max - d) / (2 * max)) * (H - pad.t - pad.b);
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p.d).toFixed(1)}`).join('');
    const area = `${path}L${X(pts.length - 1)} ${Y(0)}L${X(0)} ${Y(0)}Z`;
    // Самая длинная серия — подписываем прямо на графике.
    let best = null, cur = null;
    pts.slice(1).forEach((p, i) => {
      if (cur && cur.w === p.w) cur.n++; else cur = { w: p.w, n: 1, start: i + 1 };
      if (!best || cur.n > best.n) best = { ...cur };
    });
    const runLbl = best && best.n >= 3 ? (() => { const end = best.start + best.n - 1; return `<text x="${X(end)}" y="${Y(pts[end].d) + (best.w === 'us' ? -8 : 16)}" text-anchor="middle" style="fill:var(--ash)">серия ${best.n}:0 ${best.w === 'us' ? 'наша' : 'их'}</text>`; })() : '';
    const hits = pts.map((p, i) => `<rect class="hit" x="${X(i) - (W / pts.length) / 2}" y="${pad.t}" width="${W / pts.length}" height="${H - pad.t - pad.b}" data-tip="<b>Розыгрыш ${i}</b><br>счёт ${p.us}:${p.th}${p.w ? ` · очко ${p.w === 'us' ? 'нам' : 'им'}` : ''}"/>`).join('');
    const id = `c${s.n}`;
    return `<div class="panel flowchart"><h3>Партия ${s.n + 1}<small>${s.us}:${s.them}</small><span class="grow"></span><small>выше нуля — ведём</small></h3>
      <svg viewBox="0 0 ${W} ${H}">
        <defs><clipPath id="${id}a"><rect x="0" y="0" width="${W}" height="${Y(0)}"/></clipPath><clipPath id="${id}b"><rect x="0" y="${Y(0)}" width="${W}" height="${H}"/></clipPath></defs>
        ${[-max, -max / 2, max / 2, max].map(d => `<line class="gl" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(d)}" y2="${Y(d)}"/><text x="${pad.l - 6}" y="${Y(d) + 4}" text-anchor="end">${sgn(Math.round(d))}</text>`).join('')}
        <line class="ax" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(0)}" y2="${Y(0)}"/><text x="${pad.l - 6}" y="${Y(0) + 4}" text-anchor="end">0</text>
        <path d="${area}" fill="rgb(89 212 153 / .18)" clip-path="url(#${id}a)"/><path d="${area}" fill="rgb(255 99 99 / .18)" clip-path="url(#${id}b)"/>
        <path class="ln" d="${path}"/>
        ${(s.timeouts ?? []).map(t => `<line x1="${X(t.at)}" x2="${X(t.at)}" y1="${pad.t}" y2="${H - pad.b}" stroke="${t.side === 'us' ? '#f0c85a' : '#a0a3aa'}" stroke-dasharray="3 3"/><text x="${X(t.at) + 3}" y="${pad.t + 9}" style="fill:${t.side === 'us' ? '#f0c85a' : 'var(--smoke)'}">ТА ${t.side === 'us' ? 'наш' : 'их'}</text>`).join('')}
        ${runLbl}
        <text x="${pad.l}" y="${H - 4}">1</text><text x="${W - pad.r}" y="${H - 4}" text-anchor="end">${pts.length - 1} розыгр.</text>
        ${hits}
      </svg></div>`;
  });
  return `<section class="dsec" id="flow"><h2>Ход партии</h2><p class="sub">Разница в счёте после каждого розыгрыша. Наведите на график — увидите счёт. Пунктир — тайм-ауты.</p>
    <div class="grid g2">${charts.join('') || '<div class="empty">Партий ещё нет</div>'}</div>${timeoutsBlock(v)}</section>`;
}

// Тайм-ауты: что было сразу после (по всем выбранным матчам).
function timeoutsBlock(v) {
  const sets = v.rows.flatMap(r => r.st.sets.filter(s => v.scope === 'all' || s.n === v.scope));
  const us = timeoutEffect(sets, 'us'), them = timeoutEffect(sets, 'them');
  if (!us.count && !them.count) return '';
  const card = (title, e, who) => `<div class="kpi"><div class="t">${title}</div><div class="v">${e.count}</div>
    <div class="s">${e.count ? `первый розыгрыш после — наш в ${pc(e.firstWon, e.count)} · следующие 3: ${pc(e.nextWon, e.nextTot)}${who === 'us' && e.runs ? ` · серию соперника прервали ${e.brokeRun} из ${e.runs}` : ''}` : 'не брали'}</div></div>`;
  return `<div class="kpis" style="margin-top:12px">${card('Наши тайм-ауты', us, 'us')}${card('Тайм-ауты соперника', them, 'them')}</div>`;
}

// ---------- Тепловые карты ----------
const HEAT_SKILLS = {
  att: { t: 'Атака: куда бьём', half: 'them', ok: p => p.res === 'kill' || p.res === 'bo', okT: 'очко' },
  serve: { t: 'Подача: куда подаём', half: 'them', ok: p => p.res === 'ace', okT: 'эйс' },
  rec: { t: 'Приём: где принимаем', half: 'us', ok: p => p.res === 'pp' || p.res === 'pm', okT: 'позитив' },
  dig: { t: 'Защита: где поднимаем', half: 'us', ok: p => p.res !== 'error', okT: 'подняли' },
  set: { t: 'Пас: куда отдаём', half: 'us', ok: p => p.won === true, okT: 'розыгрыш наш' },
};
function colorOf(p) {
  if (p.skill === 'set') return p.won === true ? OUT_COLOR.us : p.won === false ? OUT_COLOR.them : OUT_COLOR.null;
  return OUT_COLOR[ACTIONS[p.skill]?.[p.res] ?? null];
}
function heatSection(v) {
  const H = HEAT_SKILLS[F.skill];
  const pts = v.plays.filter(p => p.skill === F.skill && p.to && !p.virtual && (F.player === 'all' || p.p === F.player));
  const inHalf = pts.filter(p => (H.half === 'them' ? p.to.y >= NET - 0.5 : p.to.y < NET + 0.5));
  const base = courtBase(H.half);
  let inner = base.svg;
  if (F.heat) inner += heat(inHalf.map(p => p.to), H.half, { color: '#63a1ff' });
  if (F.traj && F.skill === 'att') {
    // Атака: откуда (точка паса или клик «откуда») → куда.
    const setTo = new Map(v.plays.filter(p => p.skill === 'set' && p.to).map(p => [`${p.mid}:${p.set}:${p.rally}`, p.to]));
    inner += pts.map(p => { const f = p.from ?? setTo.get(`${p.mid}:${p.set}:${p.rally}`); return f ? `<line class="traj" x1="${sx(f)}" y1="${sy(f)}" x2="${sx(p.to)}" y2="${sy(p.to)}" stroke="${colorOf(p)}"/>` : ''; }).join('');
  }
  if (F.dots) inner += pts.map(p => `<circle class="dot" cx="${sx(p.to)}" cy="${sy(p.to)}" r=".2" fill="${colorOf(p)}" data-tip="<b>${v.nm(p.p)}</b><br>${esc(LABELS[p.skill][p.res])}<br>партия ${p.set + 1} · счёт ${p.score[0]}:${p.score[1]} · Р${p.rot}"/>`).join('');
  const svg = svgWrap(H.half, inner);
  // Зоны: сколько касаний и какой процент успешных.
  const byZone = {};
  for (const p of pts) { const zz = zoneOf(p.to); const c = (byZone[zz] ??= { n: 0, ok: 0 }); c.n++; if (H.ok(p)) c.ok++; }
  const layout = H.half === 'them' ? [1, 6, 5, 2, 3, 4] : [4, 3, 2, 5, 6, 1];
  const zcells = layout.map(zz => { const c = byZone[zz] || { n: 0, ok: 0 }; return `<div class="zcell"><div class="z">зона ${zz}</div><b>${pc(c.n, pts.length)}</b><small>${c.n} · ${H.okT} ${pc(c.ok, c.n)}</small></div>`; }).join('');
  const seg = Object.entries(HEAT_SKILLS).map(([k, s]) => `<button class="${F.skill === k ? 'on' : ''}" data-set="skill" data-v="${k}">${s.t.split(':')[0]}</button>`).join('');
  const tg = (k, t) => `<label class="toggle"><input type="checkbox" data-toggle="${k}" ${F[k] ? 'checked' : ''}><span>${t}</span></label>`;
  return `<section class="dsec" id="heat"><h2>Тепловые карты</h2>
    <p class="sub">Точки появляются, когда в студии кликаете по площадке. Цвет точки — исход: <span class="pos">зелёный — очко нам</span>, <span class="neg">красный — им</span>, серый — мяч в игре.</p>
    <div class="panel">
      <h3><div class="seg">${seg}</div><span class="grow"></span>${tg('heat', 'Тепло')}${tg('dots', 'Точки')}${F.skill === 'att' ? tg('traj', 'Траектории') : ''}</h3>
      ${pts.length ? `<div class="heatwrap"><div>${svg}</div>
        <div><h3>${H.t} · ${pts.length} касаний</h3><div class="zgrid">${zcells}</div>
        <p class="muted" style="font-size:12px;margin-top:10px">${H.half === 'them' ? 'Половина соперника сверху вниз: у сетки — их зоны 2·3·4 (слева направо с нашей стороны).' : 'Наша половина: у сетки — зоны 4·3·2.'}</p>
        <div class="legend"><span><i style="background:${OUT_COLOR.us}"></i>очко нам</span><span><i style="background:${OUT_COLOR.null}"></i>в игре</span><span><i style="background:${OUT_COLOR.them}"></i>очко им</span><span><i style="background:#63a1ff"></i>плотность касаний</span></div></div></div>`
        : '<div class="empty">Нет касаний с точками для этих фильтров. Отмечайте точки кликом по 3D-площадке в студии.</div>'}
    </div></section>`;
}

// ---------- Отчёт связующего ----------
function setterSection(v) {
  const setterIds = [...new Set(v.plays.filter(p => p.skill === 'set' && p.p).map(p => p.p))];
  const flagged = v.people.filter(p => p.setter).map(p => p.id);
  const ids = [...new Set([...flagged.filter(id => setterIds.includes(id)), ...setterIds])];
  if (!ids.length) return `<section class="dsec" id="setter"><h2>Связующий</h2><div class="empty">Пока нет пасов. Отметьте игрока «Связ.» в настройках — пасы посчитаются сами по атакам, а точнее — если отмечать пас в студии.</div></section>`;
  if (!ids.includes(F.setter)) F.setter = ids[0];
  const S = F.setter;
  const sets = v.plays.filter(p => p.skill === 'set' && p.p === S && p.target !== undefined);
  const dumps = v.plays.filter(p => p.skill === 'att' && p.dump && p.p === S);
  const all = [...sets.map(p => ({ ...p, key: dirKey(p.dir) })), ...dumps.map(p => ({ ...p, key: 'dump', attRes: p.res }))].filter(p => p.key);
  const killed = p => p.attRes === 'kill' || p.attRes === 'bo';
  const errd = p => p.attRes === 'error' || p.attRes === 'blocked';
  const stat = list => { const n = list.length, k = list.filter(killed).length, e = list.filter(errd).length; return { n, k, e, kp: P(k, n), eff: n ? Math.round((100 * (k - e)) / n) : null }; };
  const marked = sets.filter(p => !p.virtual);
  const q = r => marked.filter(p => p.res === r).length;
  const total = stat(all);
  const opts = ids.map(id => `<option value="${id}" ${id === S ? 'selected' : ''}>${v.nm(id)}</option>`).join('');

  // Площадка распределения: пузыри по направлениям.
  const spot = { 4: { x: 1.1, y: 7.8 }, 3: { x: 4.5, y: 8.1 }, 2: { x: 7.9, y: 7.8 }, pipe: { x: 4.5, y: 4.6 }, back: { x: 7.4, y: 4.2 }, dump: { x: 6, y: 8.6 } };
  const byDir = Object.fromEntries(DIR_ORDER.map(d => [d, stat(all.filter(p => p.key === d))]));
  const base = courtBase('us');
  const bubbles = DIR_ORDER.filter(d => byDir[d].n).map(d => {
    const s = byDir[d], share = s.n / (total.n || 1), r = 0.45 + 1.25 * Math.sqrt(share);
    const c = spot[d];
    return `<g data-tip="<b>${DIRS[d]}</b><br>${s.n} пасов (${Math.round(share * 100)}%)<br>атака: очки ${s.kp ?? '–'}% · эфф ${s.eff == null ? '–' : sgn(s.eff) + '%'}">
      <circle class="bub" cx="${sx(c)}" cy="${sy(c)}" r="${r}" fill="${DIR_COLOR[d]}" fill-opacity=".85"/>
      <text class="zlabel" x="${sx(c)}" y="${sy(c) + 0.2}">${Math.round(share * 100)}%</text>
      <text class="zsub" x="${sx(c)}" y="${sy(c) + r + 0.5}">${d === 'dump' ? 'скидка' : 'атака ' + (s.kp ?? '–') + '%'}</text></g>`;
  }).join('');
  // Отмеченные точки паса — мелкими точками под пузырями.
  const setDots = sets.filter(p => p.to && p.to.y < NET + 0.3).map(p => `<circle cx="${sx(p.to)}" cy="${sy(p.to)}" r=".09" fill="#fff" fill-opacity=".35"/>`).join('');
  const distSvg = svgWrap('us', base.svg + setDots + bubbles);

  // Таблица «качество приёма → куда пас».
  const crossRow = (label, list) => {
    const st = stat(list);
    const cells = DIR_ORDER.map(d => { const s = stat(list.filter(p => p.key === d)); const sh = P(s.n, st.n); return `<td class="cellbar" data-tip="<b>${DIRS[d]}</b> · ${label}<br>${s.n} из ${st.n} · очки ${s.kp ?? '–'}%">${sh ? `<i style="width:${sh * 0.8}%"></i>` : ''}<span>${sh == null || !s.n ? '·' : sh + '%'}</span></td>`; }).join('');
    return `<tr><td class="l">${label}</td><td>${st.n}</td>${cells}<td class="b">${st.kp ?? '–'}${st.kp == null ? '' : '%'}</td><td>${st.eff == null ? '–' : sgn(st.eff) + '%'}</td></tr>`;
  };
  const head = `<tr><th class="l"></th><th>Пасов</th>${DIR_ORDER.map(d => `<th><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${DIR_COLOR[d]};margin-right:5px"></span>${DIRS[d]}</th>`).join('')}<th class="b">Очки атаки</th><th>Эфф</th></tr>`;
  const byRec = ['pp', 'pm', 'p'].map(r => crossRow(`После приёма ${REC_LABEL[r]}`, all.filter(p => p.poss === 'rec' && p.recQ === r))).join('')
    + crossRow('В переходе (после защиты)', all.filter(p => p.poss === 'trans'))
    + crossRow('Концовка партии (20+)', all.filter(p => Math.max(...p.score) >= 20))
    + crossRow('Всего', all);
  // По расстановкам: доли направлений.
  const rotRows = [1, 2, 3, 4, 5, 6].map(r => {
    const list = all.filter(p => p.rot === r), st = stat(list);
    if (!st.n) return `<tr><td class="l">Р${r}</td><td colspan="4" class="muted">нет пасов</td></tr>`;
    const parts = DIR_ORDER.map(d => ({ n: list.filter(p => p.key === d).length, c: DIR_COLOR[d], t: DIRS[d] }));
    const top = parts.reduce((a, b) => (b.n > a.n ? b : a));
    return `<tr><td class="l">Р${r}</td><td>${st.n}</td><td style="min-width:220px">${bar(parts)}</td><td class="l">${esc(top.t)} · ${P(top.n, st.n)}%</td><td>${st.kp}%</td></tr>`;
  }).join('');
  // Темп и нападающие.
  const tempoRows = [...Object.entries(TEMPOS).map(([k, t]) => [k, t.label]), [null, 'Не указан']].map(([k, label]) => {
    const st = stat(all.filter(p => p.key !== 'dump' && (p.tempo ?? null) === k));
    return st.n ? `<tr><td class="l">${label}</td><td>${st.n}</td><td>${pc(st.n, total.n)}</td><td>${st.kp}%</td><td>${sgn(st.eff)}%</td></tr>` : '';
  }).join('');
  const targets = Object.entries(Object.groupBy ? Object.groupBy(sets, p => p.target ?? '?') : sets.reduce((a, p) => ((a[p.target ?? '?'] ??= []).push(p), a), {}))
    .map(([id, list]) => ({ id, ...stat(list) })).sort((a, b) => b.n - a.n)
    .map(t => `<tr><td class="l">${t.id === '?' ? '—' : v.nm(t.id)}</td><td>${t.n}</td><td>${pc(t.n, sets.length)}</td><td>${t.kp}%</td><td>${t.e}</td><td>${sgn(t.eff)}%</td></tr>`).join('');
  const qOut = ['perfect', 'good', 'poor'].map(r => { const st = stat(marked.filter(p => p.res === r)); return `<tr><td class="l">${esc(LABELS.set[r].replace('Пас: ', ''))}</td><td>${st.n}</td><td>${st.n ? st.kp + '%' : '–'}</td><td>${st.n ? sgn(st.eff) + '%' : '–'}</td></tr>`; }).join('');
  const ds = stat(dumps.map(p => ({ ...p, attRes: p.res })));

  return `<section class="dsec" id="setter"><h2>Связующий</h2>
    <p class="sub">Куда и как пасует связующий, от чего это зависит и что получается у нападающих. Пасы без отметки в студии считаются автоматически по атаке (направление — по зоне нападающего), а качество и темп — только по отмеченным.</p>
    <div class="panel" style="margin-bottom:12px"><h3>Связующий <select data-f="setter">${opts}</select><span class="grow"></span><small>пасов ${total.n} · отмечено вручную ${marked.length} · скидок ${dumps.length}</small></h3>
      <div class="kpis">
        ${kpi('Атака после паса', total.kp == null ? '–' : total.kp + '%', `очков ${total.k} из ${total.n} · эфф ${total.eff == null ? '–' : sgn(total.eff) + '%'}`)}
        ${kpi('Качество паса', marked.length ? pc(q('perfect') + q('good'), marked.length) : '–', `идеальных ${q('perfect')} · неудобных ${q('poor')} · ошибок ${q('error')}`,
          bar([{ n: q('perfect'), c: '#59d499', t: 'Идеальный' }, { n: q('good'), c: '#3f86e8', t: 'Хороший' }, { n: q('poor'), c: '#b8892a', t: 'Неудобный' }, { n: q('error'), c: '#ff6363', t: 'Ошибка' }]))}
        ${kpi('Скидки', ds.n ? `${ds.n}<small>очки ${ds.kp}%</small>` : '0', 'атака вторым касанием')}
        ${kpi('На край (4)', pc(byDir['4'].n, total.n), `очки ${byDir['4'].kp ?? '–'}% — чем выше доля, тем предсказуемее`)}
      </div></div>
    <div class="grid g2">
      <div class="panel"><h3>Распределение по направлениям<span class="grow"></span><small>размер — доля пасов</small></h3>${distSvg}
        <div class="legend">${DIR_ORDER.filter(d => byDir[d].n).map(d => `<span><i style="background:${DIR_COLOR[d]}"></i>${DIRS[d]} <b>${byDir[d].n}</b></span>`).join('')}</div></div>
      <div class="panel"><h3>Распределение по расстановкам</h3>
        <div class="tw"><table class="t"><tr><th class="l">Расст.</th><th>Пасов</th><th>Доли направлений</th><th class="l">Чаще всего</th><th>Очки</th></tr>${rotRows}</table></div>
        <div class="legend">${DIR_ORDER.map(d => `<span><i style="background:${DIR_COLOR[d]}"></i>${DIRS[d]}</span>`).join('')}</div></div>
    </div>
    <div class="panel" style="margin-top:12px"><h3>Куда пас в зависимости от ситуации<span class="grow"></span><small>доля пасов в строке</small></h3>
      <div class="tw"><table class="t">${head}${byRec}</table></div></div>
    <div class="grid g3" style="margin-top:12px">
      <div class="panel"><h3>Нападающие</h3><div class="tw"><table class="t"><tr><th class="l">Кому</th><th>Пасов</th><th>Доля</th><th>Очки</th><th>Ош</th><th>Эфф</th></tr>${targets || '<tr><td colspan="6">—</td></tr>'}</table></div></div>
      <div class="panel"><h3>Темп</h3><div class="tw"><table class="t"><tr><th class="l">Темп</th><th>Пасов</th><th>Доля</th><th>Очки</th><th>Эфф</th></tr>${tempoRows || '<tr><td colspan="5">—</td></tr>'}</table></div></div>
      <div class="panel"><h3>Качество паса → атака</h3><div class="tw"><table class="t"><tr><th class="l">Пас</th><th>Пасов</th><th>Очки</th><th>Эфф</th></tr>${qOut}</table></div>
        <p class="muted" style="font-size:12px;margin:10px 0 0">Только пасы, отмеченные в студии кнопками «Пас».</p></div>
    </div></section>`;
}

// ---------- Расстановки ----------
function rotSection(v) {
  const t = teamAgg(v);
  const last = v.rows.map(r => r.st.sets[0]).find(Boolean);
  const pl = v.plays;
  const cards = [1, 2, 3, 4, 5, 6].map(r => {
    const rc = t.rot?.[r] || { so: { n: 0, won: 0 }, brk: { n: 0, won: 0 }, us: 0, them: 0 };
    let mini = '';
    if (last) {
      const slot = last.mainSlot < 0 ? 0 : last.mainSlot;
      const z1 = [0, 1, 2, 3, 4, 5].find(k => zoneOfSlot(slot, k) === r);
      const zones = slotZones(z1);
      const at = zz => last.start[zones.indexOf(zz)];
      mini = `<div class="mini">${[4, 3, 2, 5, 6, 1].map(zz => { const id = at(zz); const p = v.people.find(x => x.id === id); return `<span class="${id === last.main ? 's' : ''}">${esc(p?.num || p?.name || '?')}</span>`; }).join('')}</div>`;
    }
    const att = pl.filter(p => p.rot === r && p.skill === 'att');
    const k = att.filter(p => p.res === 'kill' || p.res === 'bo').length;
    const rec = pl.filter(p => p.rot === r && p.skill === 'rec');
    const rr = rec.length ? (rec.reduce((a, p) => a + REC_RATING[p.res], 0) / rec.length).toFixed(2) : '–';
    return { r, rc, html: (cls, tag) => `<div class="rcard ${cls}"><h4>Р${r}<small>связующий в зоне ${r}</small>${tag}</h4>${mini}
      <div class="rstat">
        <span>Сайд-аут</span><b>${pc(rc.so.won, rc.so.n)} <small class="muted">${rc.so.won}/${rc.so.n}</small></b><div class="meter"><i style="width:${P(rc.so.won, rc.so.n) ?? 0}%"></i></div>
        <span>Брейк</span><b>${pc(rc.brk.won, rc.brk.n)} <small class="muted">${rc.brk.won}/${rc.brk.n}</small></b><div class="meter"><i style="width:${P(rc.brk.won, rc.brk.n) ?? 0}%;background:var(--sky)"></i></div>
        <span>Очки</span><b>${rc.us}:${rc.them} <span class="${rc.us - rc.them >= 0 ? 'pos' : 'neg'}">${sgn(rc.us - rc.them)}</span></b>
        <span>Атака</span><b>${pc(k, att.length)} <small class="muted">из ${att.length}</small></b>
        <span>Приём</span><b>${rr}</b>
      </div></div>` };
  });
  const withData = cards.filter(c => c.rc.so.n >= 3);
  const so = c => c.rc.so.won / c.rc.so.n;
  const weak = withData.length > 1 ? withData.reduce((a, b) => (so(b) < so(a) ? b : a)).r : null;
  const strong = withData.length > 1 ? withData.reduce((a, b) => (so(b) > so(a) ? b : a)).r : null;
  return `<section class="dsec" id="rot"><h2>Расстановки</h2>
    <p class="sub">Р1…Р6 — по зоне, где стоит основной связующий (его выбирают при старте партии). Схема: ${esc(SYSTEMS[v.rows[0]?.m.system] || '—')}. Площадки — стартовая шестёрка первой партии.</p>
    <div class="rots">${cards.map(c => c.html(c.r === weak ? 'weak' : c.r === strong ? 'strong' : '', c.r === weak ? '<span class="tag neg">слабая</span>' : c.r === strong ? '<span class="tag pos">сильная</span>' : '')).join('')}</div></section>`;
}

// ---------- Игроки ----------
const COLS = [
  ['points', 'Очки', p => totals(p).points], ['diff', '+/−', p => totals(p).diff], ['court', '± на площ.', p => (p.court?.n ? 2 * p.court.us - p.court.n : null)],
  ['srv', 'Подач', p => p.serve.tot], ['ace', 'Эйс', p => p.serve.ace], ['serr', 'Ош', p => p.serve.err],
  ['rec', 'Приём', p => p.rec.tot], ['rr', 'Рейтинг', p => recRating(p.rec)], ['rpos', 'Позитив', p => (p.rec.tot ? (p.rec.pp + p.rec.pm) / p.rec.tot : null)], ['rerr', 'Ош', p => p.rec.err],
  ['att', 'Атак', p => p.att.tot], ['kill', 'Очки', p => p.att.kill + p.att.bo], ['aplay', 'В игре', p => p.att.tot - p.att.kill - p.att.bo - p.att.err - p.att.blk], ['aerr', 'Ош+Бл', p => p.att.err + p.att.blk], ['kp', 'Реализ.', p => (p.att.tot ? (p.att.kill + p.att.bo) / p.att.tot : null)], ['eff', 'Эфф', p => attEff(p.att)],
  ['set', 'Пасов', p => p.set.tot], ['setq', 'Хорош.', p => (p.set.tot ? (p.set.perfect + p.set.good) / p.set.tot : null)],
  ['blk', 'Блок', p => p.blk.point], ['dig', 'Защита', p => p.dig.tot], ['dplus', 'Подн.', p => (p.dig.tot ? (p.dig.plus + p.dig.minus) / p.dig.tot : null)],
];
const GROUPS = [['Итог', 3], ['Подача', 3], ['Приём', 4], ['Атака', 6], ['Пас', 2], ['Защита', 3]];
const fmtCol = (k, v) => {
  if (v == null) return '–';
  if (k === 'rr') return v.toFixed(2);
  if (['rpos', 'kp', 'setq', 'dplus'].includes(k)) return Math.round(v * 100) + '%';
  if (k === 'eff') return `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${sgn(Math.round(v * 100))}%</span>`;
  if (k === 'diff' || k === 'court') return `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${sgn(v)}</span>`;
  return z(v);
};
function playersSection(v) {
  const stats = {};
  for (const { st } of v.rows) for (const [id, p] of Object.entries(st.players[v.scope] || {})) addStats((stats[id] ??= newPlayer()), p);
  const col = COLS.find(c => c[0] === F.sort) || COLS[0];
  const rows = Object.entries(stats).sort((a, b) => (col[2](b[1]) ?? -1e9) - (col[2](a[1]) ?? -1e9));
  const firstOf = new Set(); let i = 0; for (const [, n] of GROUPS) { firstOf.add(COLS[i][0]); i += n; }
  const tr = (label, p, cls = '') => `<tr class="${cls}"><td class="l">${label}</td>${COLS.map(([k, , f]) => `<td class="${firstOf.has(k) ? 'b' : ''}">${fmtCol(k, f(p))}</td>`).join('')}</tr>`;
  const team = Object.values(stats).reduce(addStats, newPlayer());
  const links = Object.values(teamAgg(v).links || {}).sort((a, b) => b.tot - a.tot).slice(0, 14);
  return `<section class="dsec" id="players"><h2>Игроки</h2>
    <p class="sub">Нажмите на заголовок колонки — сортировка. Фильтры расстановки и фазы на таблицу не действуют (только матч и партия). Эффективность атаки = (очки − ошибки − блоки) / атаки. «± на площ.» — сколько розыгрышей команда выиграла минус проиграла, пока игрок был на площадке.</p>
    <div class="panel tw"><table class="t">
      <tr><th></th>${GROUPS.map(([g, n]) => `<th class="grp" colspan="${n}">${g}</th>`).join('')}</tr>
      <tr><th class="l">Игрок</th>${COLS.map(([k, t]) => `<th class="sort ${F.sort === k ? 'on' : ''} ${firstOf.has(k) ? 'b' : ''}" data-sort="${k}">${t}</th>`).join('')}</tr>
      ${rows.map(([id, p]) => tr(`<a class="plink" href="player.html?p=${id}" title="Отчёт игрока">${v.nm(id)}</a>`, p)).join('')}
      ${tr('Команда', team, 'total')}
    </table></div>
    <div class="grid g2" style="margin-top:12px">
      <div class="panel"><h3>Связки «связующий → нападающий»</h3><div class="tw"><table class="t">
        <tr><th class="l">Связующий</th><th class="l">Нападающий</th><th>Атак</th><th>Очки</th><th>Ош+Бл</th><th>Очки %</th></tr>
        ${links.map(l => `<tr><td class="l">${l.setter ? v.nm(l.setter) : '—'}</td><td class="l">${v.nm(l.attacker)}</td><td>${l.tot}</td><td>${z(l.kill)}</td><td>${z(l.err)}</td><td>${pc(l.kill, l.tot)}</td></tr>`).join('') || '<tr><td colspan="6">Пока нет атак</td></tr>'}
      </table></div></div>
      <div class="panel"><h3>Матчи</h3><div class="tw"><table class="t">
        <tr><th class="l">Дата</th><th class="l">Соперник</th><th>Партии</th><th class="l">Счёт</th><th></th></tr>
        ${v.cands.map(m => { const st = replay(m); return `<tr><td class="l">${dt(m)}</td><td class="l">${esc(m.opponent)}</td><td>${st.setsWon.us}:${st.setsWon.them}</td><td class="l">${st.sets.map(s => `${s.us}:${s.them}`).join(', ') || '—'}</td><td><a class="btn sm" href="studio.html#m=${m.id}">Студия</a></td></tr>`; }).join('')}
      </table></div></div>
    </div></section>`;
}

// ---------- Турниры: прогресс команды ----------
function toursSection(v) {
  const tours = v.settings.tournaments ?? [];
  if (!tours.length) return '';
  const stat = ms => {
    const t = {}, pl = newPlayer();
    let w = 0, l = 0;
    for (const m of ms) {
      const st = replay(m);
      if (st.teams.all) addStats(t, st.teams.all);
      for (const p of Object.values(st.players.all ?? {})) addStats(pl, p);
      if (st.matchOver) st.setsWon.us > st.setsWon.them ? w++ : l++;
    }
    const so = t.sideout ?? { n: 0, won: 0 }, br = t.brk ?? { n: 0, won: 0 };
    return { n: ms.length, w, l, so: so.n ? so.won / so.n : null, br: br.n ? br.won / br.n : null,
      kp: pl.att.tot ? (pl.att.kill + pl.att.bo) / pl.att.tot : null, rr: recRating(pl.rec) };
  };
  const list = tours.map(t => ({ t, s: stat(DATA.matches.filter(m => m.tournament === t.id)) })).filter(x => x.s.n)
    .sort((a, b) => (a.t.created ?? '').localeCompare(b.t.created ?? ''));
  if (!list.length) return '';
  const W = 900, H = 200, L = 34, B = 30;
  const X = i => L + (list.length < 2 ? (W - L) / 2 : (i / (list.length - 1)) * (W - L - 90));
  const Y = f => 12 + (1 - f) * (H - B - 12);
  const labels = [];
  const line = (key, color, name, max = 1) => {
    const pts = list.map((x, i) => (x.s[key] == null ? null : [X(i), Y(x.s[key] / max)])).filter(Boolean);
    if (pts.length) labels.push({ x: pts.at(-1)[0] + 8, y: pts.at(-1)[1] + 4, color, name });
    return pts.length ? `<polyline fill="none" stroke="${color}" stroke-width="2.2" points="${pts.map(p => p.join(',')).join(' ')}"/>${pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="4" fill="${color}"/>`).join('')}` : '';
  };
  // Подписи линий справа — раздвигаем, чтобы не налезали друг на друга.
  const placeLabels = () => { labels.sort((a, b) => a.y - b.y); for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 14); return labels.map(l => `<text x="${l.x}" y="${l.y}" style="fill:${l.color}">${l.name}</text>`).join(''); };
  const chart = `<svg viewBox="0 0 ${W} ${H}" class="dyn">
    ${[0, 0.25, 0.5, 0.75, 1].map(f => `<line x1="${L}" x2="${W - 90}" y1="${Y(f)}" y2="${Y(f)}" stroke="rgb(255 255 255 / .06)"/><text x="${L - 6}" y="${Y(f) + 4}" text-anchor="end">${f * 100}%</text>`).join('')}
    ${line('so', '#59d499', 'сайд-аут')}${line('br', '#63a1ff', 'брейк')}${line('kp', '#f0c85a', 'атака')}${line('rr', '#b59cff', 'приём /3', 3)}${placeLabels()}
    ${list.map((x, i) => `<text x="${X(i)}" y="${H - 8}" text-anchor="middle">${esc(x.t.name.slice(0, 18))}</text>`).join('')}
  </svg>`;
  const rows = list.map(x => `<tr><td class="l">${esc(x.t.name)}</td><td>${x.s.n}</td><td>${x.s.w}:${x.s.l}</td>
    <td>${x.s.so == null ? '–' : Math.round(x.s.so * 100) + '%'}</td><td>${x.s.br == null ? '–' : Math.round(x.s.br * 100) + '%'}</td>
    <td>${x.s.kp == null ? '–' : Math.round(x.s.kp * 100) + '%'}</td><td>${x.s.rr == null ? '–' : x.s.rr.toFixed(2)}</td></tr>`).join('');
  return `<section class="dsec" id="tours"><h2>Турниры: прогресс команды</h2><p class="sub">Как меняются главные показатели от турнира к турниру (по всем матчам турнира).</p>
    <div class="panel flowchart">${chart}</div>
    <div class="panel tw" style="margin-top:12px"><table class="t"><tr><th class="l">Турнир</th><th>Матчей</th><th>Победы:поражения</th><th>Сайд-аут</th><th>Брейк</th><th>Атака</th><th>Приём</th></tr>${rows}</table></div></section>`;
}

// ---------- Скаутинг соперника ----------
// Их атаки — это наши защиты/блоки и «соперник забил / ошибся» вне приёма; их подачи — наш приём и эйсы/ошибки на подаче.
// Номер бьющего/подающего (p.opp) есть, только если в матче включён скаутинг.
const isTheirServe = p => p.skill === 'rec' || (p.skill === 'team' && (p.res === 'oppAce' || (p.res === 'oppError' && !p.weServe && p.rallyFirst)));
const isTheirAttack = p => !isTheirServe(p) && (p.skill === 'dig' || p.skill === 'blk' || (p.skill === 'team' && (p.res === 'oppKill' || p.res === 'oppError')));
// Линия / диагональ — по смещению удара поперёк площадки.
const lineOrDiag = p => (p.from && p.to ? (Math.abs(p.to.x - p.from.x) < 2.5 ? 'line' : 'diag') : null);
const theirZone = p => (p.from && p.from.y > NET ? (zoneOf(p.from) <= 4 && zoneOf(p.from) >= 2 ? String(zoneOf(p.from)) : 'back') : null);
// Исход их атаки: очко им / очко нам / мяч в игре.
const attOut = p => (p.skill === 'team' ? (p.res === 'oppKill' ? 'them' : 'us') : p.skill === 'blk' ? (p.res === 'point' ? 'us' : p.res === 'error' ? 'them' : null) : p.res === 'error' ? 'them' : null);

function scoutSection(v) {
  const on = v.rows.some(({ m }) => m.scout) || v.plays.some(p => p.opp);
  if (!on) return '';
  // Первое действие розыгрыша нужно, чтобы отличить ошибку подачи соперника от ошибки атаки.
  const first = new Set();
  const plays = v.plays.map(p => { const k = `${p.mid}:${p.set}:${p.rally}`; const f = !first.has(k); first.add(k); return { ...p, rallyFirst: f }; });
  const att = plays.filter(isTheirAttack), srv = plays.filter(isTheirServe);
  const OUTC = { them: OUT_COLOR.them, us: OUT_COLOR.us, null: OUT_COLOR.null };
  // Площадка целиком: откуда (их половина) → куда (наша).
  const drawn = att.filter(p => p.to);
  let inner = courtBase('full').svg;
  inner += drawn.map(p => (p.from ? `<line class="traj" x1="${sx(p.from)}" y1="${sy(p.from)}" x2="${sx(p.to)}" y2="${sy(p.to)}" stroke="${OUTC[attOut(p)]}"/>` : '')).join('');
  inner += drawn.map(p => `<circle class="dot" cx="${sx(p.to)}" cy="${sy(p.to)}" r=".2" fill="${OUTC[attOut(p)]}" data-tip="${p.opp ? `<b>№${esc(p.opp)}</b><br>` : ''}${esc(LABELS[p.skill][p.res])}${lineOrDiag(p) ? ` · ${lineOrDiag(p) === 'line' ? 'по линии' : 'по диагонали'}` : ''}<br>партия ${p.set + 1} · ${p.score[0]}:${p.score[1]}"/>`).join('');
  // По зонам, откуда бьют.
  const zrow = (key, title) => {
    const a = att.filter(p => (key === 'all' ? true : theirZone(p) === key));
    if (!a.length) return '';
    const k = a.filter(p => attOut(p) === 'them').length, ld = a.map(lineOrDiag), l = ld.filter(x => x === 'line').length, d = ld.filter(x => x === 'diag').length;
    return `<tr${key === 'all' ? ' class="total"' : ''}><td class="l">${title}</td><td>${a.length}</td><td class="neg">${pc(k, a.length)}</td><td>${l + d ? pc(l, l + d) : '–'}</td><td>${l + d ? pc(d, l + d) : '–'}</td></tr>`;
  };
  const zones = [['4', 'Зона 4 (их левый край)'], ['3', 'Зона 3 (центр)'], ['2', 'Зона 2 (их правый край)'], ['back', 'Задняя линия']].map(([k, t]) => zrow(k, t)).join('') + zrow('all', 'Всего');
  // По игрокам (номерам).
  const nums = [...new Set(plays.filter(p => p.opp).map(p => String(p.opp)))].sort((a, b) => a - b);
  const prow = n => {
    const a = att.filter(p => String(p.opp) === n), s = srv.filter(p => String(p.opp) === n);
    const k = a.filter(p => attOut(p) === 'them').length, ld = a.map(lineOrDiag), l = ld.filter(x => x === 'line').length, d = ld.filter(x => x === 'diag').length;
    const zs = a.map(theirZone).filter(Boolean), zt = Object.entries(zs.reduce((o, z) => ((o[z] = (o[z] || 0) + 1), o), {})).sort((x, y) => y[1] - x[1])[0];
    const rec = s.filter(p => p.skill === 'rec'), ace = s.filter(p => p.res === 'oppAce' || (p.skill === 'rec' && p.res === 'error')).length, se = s.filter(p => p.skill === 'team' && p.res === 'oppError').length;
    const pos = rec.filter(p => p.res === 'pp' || p.res === 'pm').length, so = s.filter(p => p.won === true).length;
    return `<tr><td class="l"><b>№${esc(n)}</b></td><td class="b">${a.length || '–'}</td><td class="neg">${pc(k, a.length)}</td><td>${zt ? (zt[0] === 'back' ? 'сзади' : 'зоны ' + zt[0]) : '–'}</td><td>${l + d ? `${pc(l, l + d)} / ${pc(d, l + d)}` : '–'}</td>
      <td class="b">${s.length || '–'}</td><td class="neg">${ace || '–'}</td><td class="pos">${se || '–'}</td><td>${pc(pos, rec.length)}</td><td>${pc(so, s.length)}</td></tr>`;
  };
  const ptable = nums.length ? `<div class="panel tw" style="margin-top:12px"><h3>Игроки соперника <small>по номерам, которые отмечали в студии</small></h3><table class="t">
    <tr><th></th><th class="grp" colspan="4">Атака</th><th class="grp" colspan="5">Подача</th></tr>
    <tr><th class="l">Номер</th><th class="b">Ударов</th><th>Очков</th><th>Чаще из</th><th>Линия / диаг.</th><th class="b">Подач</th><th>Эйсов</th><th>Ошибок</th><th>Наш позитив</th><th>Наш сайд-аут</th></tr>
    ${nums.map(prow).join('')}</table></div>` : '';
  return `<section class="dsec" id="scout"><h2>Соперник</h2>
    <p class="sub">Их атаки и подачи. Номера появляются, если в матче включён скаутинг и в студии отмечать «Подаёт № / Бьёт №». Линия или диагональ — по тому, откуда и куда пришёлся удар.</p>
    <div class="grid g2">
      <div class="panel"><h3>Их атаки: откуда → куда <small>${drawn.length}</small></h3>${drawn.length ? `<div style="max-width:340px;margin:0 auto">${svgWrap('full', inner)}</div>` : '<div class="empty">Нет точек: отмечайте, куда пришёлся их удар.</div>'}
        <div class="legend"><span><i style="background:${OUT_COLOR.them}"></i>очко им</span><span><i style="background:${OUT_COLOR.null}"></i>подняли</span><span><i style="background:${OUT_COLOR.us}"></i>очко нам</span></div></div>
      <div class="panel tw"><h3>Откуда бьют</h3>${att.length ? `<table class="t"><tr><th class="l">Зона</th><th>Ударов</th><th>Очков им</th><th>Линия</th><th>Диагональ</th></tr>${zones}</table>` : '<div class="muted">Атак соперника пока нет.</div>'}</div>
    </div>${ptable}</section>`;
}

// ---------- Отрисовка ----------
function render() {
  if (!DATA.matches.length) {
    document.getElementById('filters').innerHTML = '';
    $app.innerHTML = '<div class="empty" style="margin-top:40px">Матчей детальной статистики пока нет. Создайте матч в <a href="studio.html" style="color:var(--sky)">студии</a> или на пульте телефона.</div>';
    return;
  }
  const v = view();
  document.getElementById('filters').innerHTML = filters(v);
  const y = scrollY;
  $app.innerHTML = overview(v) + flow(v) + heatSection(v) + setterSection(v) + rotSection(v) + playersSection(v) + scoutSection(v) + toursSection(v);
  scrollTo(0, y);
}

document.addEventListener('change', e => {
  const f = e.target.dataset.f, tg = e.target.dataset.toggle;
  if (f) { F[f] = e.target.value; if (f === 'opp' || f === 'tour') F.match = null; if (f === 'match' && e.target.value !== 'all') history.replaceState(null, '', '#m=' + e.target.value); render(); }
  if (tg) { F[tg] = e.target.checked; render(); }
});
document.addEventListener('click', e => {
  const b = e.target.closest('[data-set]');
  if (b) { F[b.dataset.set] = b.dataset.v; render(); }
  const s = e.target.closest('[data-sort]');
  if (s) { F.sort = s.dataset.sort; render(); }
});

await load();
render();
// Обновляемся, только если матчи поменялись (новые события с пульта или из студии).
setInterval(async () => {
  if (document.hidden || document.activeElement?.tagName === 'SELECT') return;
  const list = await fetch('/api/matches').then(r => r.json()).catch(() => null);
  if (!list || sig(list) === DATA.sig) return;
  await load();
  render();
}, 4000);

// ---------- Экспорт: касания по текущим фильтрам в CSV (Excel открывает с разделителем «;») ----------
document.getElementById('csvBtn').addEventListener('click', () => {
  const v = view();
  const head = ['Матч', 'Соперник', 'Партия', 'Розыгрыш', 'Счёт', 'Расстановка', 'Подача', 'Игрок', 'Навык', 'Результат', 'Темп', 'Куда пас', 'Кому пас', 'Откуда x', 'Откуда y', 'Куда x', 'Куда y', 'Время видео', 'Розыгрыш выигран'];
  const byId = Object.fromEntries(v.rows.map(r => [r.m.id, r.m]));
  const rows = v.plays.filter(p => !p.virtual && (F.player === 'all' || p.p === F.player)).map(p => [
    dt(byId[p.mid]), byId[p.mid].opponent, p.set + 1, p.rally + 1, `${p.score[0]}:${p.score[1]}`, 'Р' + p.rot, p.weServe ? 'наша' : 'их',
    p.p ? playerName({ roster: v.people }, p.p) : '', SKILLS[p.skill] ?? p.skill, LABELS[p.skill]?.[p.res] ?? p.res, p.tempo ? TEMPOS[p.tempo]?.short ?? p.tempo : '', p.dir ? DIRS[dirKey(p.dir)] ?? p.dir : '', p.target ? playerName({ roster: v.people }, p.target) : '',
    p.from?.x ?? '', p.from?.y ?? '', p.to?.x ?? '', p.to?.y ?? '', p.vt ?? '', p.won == null ? '' : p.won ? 'да' : 'нет',
  ]);
  const cell = x => { const t = String(x).replace(/\./g, typeof x === 'number' ? ',' : '.'); return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const csv = '\ufeff' + [head, ...rows].map(r => r.map(cell).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `volleyball-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
