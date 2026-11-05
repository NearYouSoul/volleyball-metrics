// Отчёт игрока: всё про одного человека на одной странице — итоги, атака и приём на площадке,
// динамика по матчам, лучшие моменты. Открывается из аналитики (клик по игроку) или ?p=<id>.
import { replay, totals, newPlayer, addStats, playerName, LABELS, REC_RATING, attEff, recRating } from './engine.js';
import { ROLES, roleOf, NET, zoneOf } from './court.js';
import { courtBase, heat, svgWrap, sx, sy } from './studio/court2d.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pc = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '–');
const sgn = v => (v > 0 ? '+' : '') + v;
const dt = m => new Date(m.created).toLocaleDateString('ru');
const params = new URLSearchParams(location.search);
let F = { p: params.get('p'), tour: params.get('t') ?? 'all', opp: 'all' };
let D = null;

async function load() {
  const [settings, matches, roster] = await Promise.all([fetch('/api/settings').then(r => r.json()), fetch('/api/matches?full').then(r => r.json()), fetch('/api/roster').then(r => r.json())]);
  D = { settings, matches: matches.reverse(), roster }; // по времени: старые → новые
}

function render() {
  const { settings, roster } = D;
  const tours = settings.tournaments ?? [];
  const matches = D.matches.filter(m => (F.tour === 'all' || m.tournament === F.tour) && (F.opp === 'all' || m.opponentId === F.opp) && m.roster.some(p => p.id === F.p));
  const people = [...roster].sort((a, b) => (a.active === false) - (b.active === false) || a.num - b.num);
  if (!F.p) F.p = people[0]?.id;
  $('filters').innerHTML = `<label>Игрок<select data-f="p">${people.map(p => `<option value="${p.id}" ${p.id === F.p ? 'selected' : ''}>${p.num ? `#${esc(p.num)} ` : ''}${esc(p.name)}${p.active === false ? ' (в запасе)' : ''}</option>`).join('')}</select></label>
    ${tours.length ? `<label>Турнир<select data-f="tour"><option value="all">Все</option>${tours.map(t => `<option value="${t.id}" ${F.tour === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>` : ''}
    <label>Соперник<select data-f="opp"><option value="all">Все</option>${settings.opponents.map(o => `<option value="${o.id}" ${F.opp === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>`;
  const me = roster.find(p => p.id === F.p) ?? {};
  // Итоги по матчам и вместе.
  const per = matches.map(m => { const st = replay(m); return { m, st, p: st.players.all?.[F.p] }; }).filter(x => x.p);
  const sum = per.reduce((a, x) => addStats(a, x.p), newPlayer());
  const plays = per.flatMap(x => x.st.plays.filter(pl => pl.p === F.p && !pl.virtual).map(pl => ({ ...pl, mid: x.m.id })));
  const t = totals(sum);
  const k = sum.att.kill + sum.att.bo;
  const kpi = (title, v, s2) => `<div class="kpi"><div class="t">${title}</div><div class="v">${v}</div><div class="s">${s2}</div></div>`;
  const role = ROLES[roleOf(me)]?.name ?? '';
  // Тепловые: атака (их половина) и приём (наша).
  const hm = (skill, half, okFn, title) => {
    const pts = plays.filter(p => p.skill === skill && p.to);
    if (!pts.length) return `<div class="panel"><h3>${title}</h3><div class="empty">Нет касаний с точками</div></div>`;
    const color = p => (okFn(p) ? '#59d499' : p.res === 'error' || p.res === 'blocked' ? '#ff6363' : '#a0a3aa');
    const svg = svgWrap(half, courtBase(half).svg + heat(pts.map(p => p.to), half) + pts.map(p => `<circle class="dot" cx="${sx(p.to)}" cy="${sy(p.to)}" r=".2" fill="${color(p)}" data-tip="${esc(LABELS[p.skill][p.res])}"/>`).join(''));
    const byZone = {}; for (const p of pts) { const z = zoneOf(p.to); const c = (byZone[z] ??= { n: 0, ok: 0 }); c.n++; if (okFn(p)) c.ok++; }
    const zl = Object.entries(byZone).sort((a, b) => b[1].n - a[1].n).slice(0, 3).map(([z, c]) => `зона ${z}: ${pc(c.n, pts.length)} (успех ${pc(c.ok, c.n)})`).join(' · ');
    return `<div class="panel"><h3>${title}<span class="grow"></span><small>${pts.length}</small></h3>${svg}<p class="muted" style="font-size:12px;margin:8px 0 0">${zl}</p></div>`;
  };
  // Динамика по матчам: реализация атаки и приём.
  const W = 1000, H = 190, padL = 30, padB = 26;
  const series = per.map(x => ({ m: x.m, kp: x.p.att.tot ? (x.p.att.kill + x.p.att.bo) / x.p.att.tot : null, rr: recRating(x.p.rec), pts: totals(x.p).points }));
  const X = i => padL + (series.length < 2 ? (W - padL) / 2 : (i / (series.length - 1)) * (W - padL - 14));
  const line = (vals, max, color, name) => {
    const pts = vals.map((v, i) => (v == null ? null : [X(i), 10 + (1 - v / max) * (H - padB - 10)])).filter(Boolean);
    return pts.length ? `<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts.map(p => p.join(',')).join(' ')}"/>${pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`).join('')}<text x="${pts.at(-1)[0] + 6}" y="${pts.at(-1)[1] + 4}" style="fill:${color};font-size:11px">${name}</text>` : '';
  };
  const dyn = series.length ? `<svg viewBox="0 0 ${W + 70} ${H}" class="dyn">
      ${[0, 0.5, 1].map(f => `<line x1="${padL}" x2="${W}" y1="${10 + (1 - f) * (H - padB - 10)}" y2="${10 + (1 - f) * (H - padB - 10)}" stroke="rgb(255 255 255 / .06)"/>`).join('')}
      ${line(series.map(s => s.kp), 1, '#59d499', 'атака, %')}${line(series.map(s => (s.rr == null ? null : s.rr / 3)), 1, '#63a1ff', 'приём /3')}
      ${series.map((s, i) => `<text x="${X(i)}" y="${H - 8}" text-anchor="middle" style="font-size:10px;fill:#6c7078">${esc(s.m.opponent.slice(0, 8))}</text><rect x="${X(i) - 14}" y="0" width="28" height="${H}" fill="transparent" data-tip="<b>${esc(s.m.opponent)}</b> ${dt(s.m)}<br>атака ${s.kp == null ? '–' : Math.round(s.kp * 100) + '%'} · приём ${s.rr == null ? '–' : s.rr.toFixed(2)} · очки ${s.pts}"/>`).join('')}
    </svg>` : '<div class="empty">Матчей нет</div>';
  // Лучшие моменты: избранные розыгрыши, где игрок касался мяча.
  const best = per.flatMap(x => {
    const rallies = {};
    for (const pl of x.st.plays) (rallies[`${pl.set}:${pl.rally}`] ??= []).push(pl);
    return Object.entries(rallies).filter(([, pls]) => x.m.events[pls[0].i]?.star && pls.some(p => p.p === F.p))
      .map(([key, pls]) => ({ m: x.m, key, note: x.m.events[pls[0].i].note, pls, won: pls[0].won }));
  });
  const rows = per.map(x => { const tt = totals(x.p); return `<tr><td class="l">${dt(x.m)}</td><td class="l">${esc(x.m.opponent)}</td><td>${tt.points}</td><td class="${tt.diff > 0 ? 'pos' : tt.diff < 0 ? 'neg' : ''}">${sgn(tt.diff)}</td>
    <td>${x.p.att.tot ? `${x.p.att.kill + x.p.att.bo}/${x.p.att.tot}` : '·'}</td><td>${x.p.att.tot ? sgn(Math.round(attEff(x.p.att) * 100)) + '%' : '·'}</td><td>${x.p.rec.tot ? recRating(x.p.rec).toFixed(2) : '·'}</td>
    <td>${x.p.serve.tot ? `${x.p.serve.ace}/${x.p.serve.err}` : '·'}</td><td>${x.p.blk.point || '·'}</td><td>${x.p.court?.n ? sgn(2 * x.p.court.us - x.p.court.n) : '·'}</td></tr>`; }).join('');

  $('app').innerHTML = `
    <section class="dsec phead">
      <div class="pnum">${esc(me.num || '')}</div>
      <div><h2>${esc(me.name ?? 'Игрок')}</h2><p class="sub">${esc(role)} · ${esc(settings.teamName)} · матчей ${per.length}${me.active === false ? ' · в запасе' : ''}</p></div>
    </section>
    <div class="kpis">
      ${kpi('Очки', t.points, `ошибок ${t.errors} · ± ${sgn(t.diff)}`)}
      ${kpi('Атака', pc(k, sum.att.tot), `${k} из ${sum.att.tot} · эфф ${sum.att.tot ? sgn(Math.round(attEff(sum.att) * 100)) + '%' : '–'}`)}
      ${kpi('Приём', sum.rec.tot ? recRating(sum.rec).toFixed(2) : '–', `позитив ${pc(sum.rec.pp + sum.rec.pm, sum.rec.tot)} · ош ${sum.rec.err}`)}
      ${kpi('Подача', `${sum.serve.ace}<small> эйс</small>`, `ошибок ${sum.serve.err} из ${sum.serve.tot}`)}
      ${kpi('Блок', sum.blk.point, `касаний ${sum.blk.touch}`)}
      ${kpi('± на площадке', sum.court?.n ? sgn(2 * sum.court.us - sum.court.n) : '–', `розыгрышей ${sum.court?.n ?? 0}`)}
    </div>
    <section class="dsec"><h2>На площадке</h2><div class="grid g2">${hm('att', 'them', p => p.res === 'kill' || p.res === 'bo', 'Атака: куда бьёт')}${hm('rec', 'us', p => p.res === 'pp' || p.res === 'pm', 'Приём: где принимает')}</div></section>
    <section class="dsec"><h2>Динамика по матчам</h2><div class="panel">${dyn}</div></section>
    <section class="dsec"><h2>По матчам</h2><div class="panel tw"><table class="t">
      <tr><th class="l">Дата</th><th class="l">Соперник</th><th>Очки</th><th>±</th><th>Атака</th><th>Эфф</th><th>Приём</th><th>Подача эйс/ош</th><th>Блок</th><th>± на площ.</th></tr>${rows || '<tr><td colspan="10">—</td></tr>'}</table></div></section>
    <section class="dsec"><h2>Лучшие моменты</h2>${best.length ? `<div class="grid g3">${best.map(b => `<a class="panel bm" href="studio.html#m=${b.m.id}&r=${b.key}">
      <b>${esc(b.m.opponent)} · ${dt(b.m)}</b><small>${b.won ? 'очко нам' : 'очко им'} · партия ${b.pls[0].set + 1}</small>${b.note ? `<em>${esc(b.note)}</em>` : ''}<span>Открыть в студии с видео →</span></a>`).join('')}</div>`
      : '<div class="empty">Отметьте розыгрыши ★ в студии — здесь появятся моменты с участием игрока.</div>'}</section>`;
}

// Подсказки и фильтры.
const tip = $('tip');
document.addEventListener('mousemove', e => {
  const el = e.target.closest('[data-tip]');
  if (!el) return tip.classList.remove('on');
  tip.innerHTML = el.dataset.tip; tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px'; tip.classList.add('on');
});
document.addEventListener('change', e => {
  const f = e.target.dataset.f;
  if (!f) return;
  F[f] = e.target.value;
  history.replaceState(null, '', `?p=${F.p}${F.tour !== 'all' ? '&t=' + F.tour : ''}`);
  render();
});
await load();
render();
