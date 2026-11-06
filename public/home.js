// Оболочка программы (корневая страница): боковое меню как в Notion и основное окно с разделами.
// Главная, Матчи, Команда, Аналитика — все в одном окне. Настройки и новый матч — окнами поверх него.
// Адрес: #matches, #team, #analytics[/матч[/режим[/партия]]].
import { ROLES, roleOf } from './court.js';
import { MODES, MODE_KEYS } from './modes.js';
import { createSettings } from './settings-ui.js';
import { emblem, matchHead, matchGrid } from './match-card.js';
import { createAnalytics } from './analytics.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = id => `<svg><use href="#${id}"/></svg>`;
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem('home.' + k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('home.' + k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};

const S = { view: 'recent', route: {}, q: '', open: null, settings: { teamName: '', opponents: [], tournaments: [] }, roster: [], matches: [], sections: [], section: null, folded: store.get('folded', false) };

const tourName = id => (id ? S.settings.tournaments?.find(t => t.id === id)?.name ?? '' : '');
const cardCtx = () => ({ team: S.settings.teamName, teamEmblem: S.settings.emblem, oppEmblem: m => S.settings.opponents.find(o => o.id === m.opponentId)?.emblem, tourName });
function greet() { const h = new Date().getHours(); return h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер'; }

function card(m) {
  const open = S.open === m.id;
  return `<article class="mcard ${open ? 'open' : ''}">
    <button class="mc-head" data-card="${m.id}" title="${open ? 'Свернуть' : 'Партии и режимы статистики'}">${matchHead(m, cardCtx())}</button>
    ${open ? `${matchGrid(m)}<div class="mfoot"><button class="btn sm ghost danger" data-del="${m.id}">${icon('i-x')}Удалить матч</button></div>` : ''}
  </article>`;
}
const search = () => `<input class="hsearch" id="q" placeholder="Поиск: соперник или турнир" value="${esc(S.q)}">`;
const found = () => {
  const q = S.q.trim().toLowerCase();
  return q ? S.matches.filter(m => (m.opponent || '').toLowerCase().includes(q) || tourName(m.tournament).toLowerCase().includes(q)) : S.matches;
};
const newBtn = () => `<button class="btn primary" data-new>${icon('i-plus')}Новый матч</button>`;
// Что продолжить: последний открытый экран ввода, а если матча уже нет — самый свежий матч.
function lastInput() {
  const l = store.get('last', null), m = S.matches.find(x => x.id === l?.id);
  if (m && MODES[l.mode]) return { m, mode: l.mode };
  return S.matches[0] ? { m: S.matches[0], mode: S.matches[0].main } : null;
}

function viewRecent() {
  const list = found(), last = lastInput();
  return `<div class="hhead"><h1>${greet()}${S.settings.teamName ? `, «${esc(S.settings.teamName)}»` : ''}</h1>${search()}</div>
    <div class="hactions">
      <button class="hact primary" data-new>${icon('i-plus')}<b>Новый матч</b><small>соперник и формат</small></button>
      ${last ? `<a class="hact" href="${MODES[last.mode].page}#m=${last.m.id}" data-go="${last.mode}">${icon('i-play')}<b>Продолжить</b><small>${esc(last.m.opponent)} · ${MODES[last.mode].name}</small></a>` : ''}
      <a class="hact" href="#analytics">${icon('i-chart')}<b>Аналитика</b><small>по матчу или по всем сразу</small></a>
    </div>
    <h3 class="hsec">${S.q ? 'Найдено' : 'Недавние'} <small>${list.length}</small>${!S.q && list.length > 6 ? '<a class="btn sm ghost" href="#matches">Все матчи</a>' : ''}</h3>
    <div class="mlist2">${(S.q ? list : list.slice(0, 6)).map(card).join('') || `<div class="hempty"><b>${S.q ? 'Ничего не нашлось' : 'Матчей пока нет'}</b><small>${S.q ? 'Попробуйте другое название.' : 'Создайте первый матч: соперник, формат, дальше выберете режим статистики.'}</small></div>`}</div>`;
}
function viewMatches() {
  const groups = new Map();
  for (const m of found()) { const k = m.tournament ?? ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
  return `<div class="hhead"><h1>Матчи</h1>${search()}${newBtn()}</div>
    ${[...groups].map(([k, list]) => `<h3 class="hsec">${esc(k ? tourName(k) || 'Турнир' : 'Без турнира')} <small>${list.length}</small></h3><div class="mlist2">${list.map(card).join('')}</div>`).join('') || `<p class="muted">${S.q ? 'Ничего не нашлось.' : 'Матчей пока нет.'}</p>`}`;
}
function viewTeam() {
  const on = S.roster.filter(p => p.active !== false);
  return `<div class="hhead"><h1>Команда</h1></div>
    <div class="hteam">${emblem(S.settings.emblem, S.settings.teamName, 'xl')}<span><b>${esc(S.settings.teamName)}</b><small>в составе ${on.length} · в запасе ${S.roster.length - on.length} · соперников ${S.settings.opponents.length}</small></span></div>
    <div class="hroster">${[...on].sort((a, b) => (+a.num || 99) - (+b.num || 99)).map(p => `<span class="hplayer"><b>${esc(p.num ?? '')}</b>${esc(p.name)}<small>${ROLES[roleOf(p)]?.name ?? ''}</small></span>`).join('') || '<p class="muted">Игроков пока нет.</p>'}</div>
    <div class="hactions">
      <button class="hact" data-set="team">${icon('i-users')}<b>Состав, форма, расстановки</b><small>игроки, цвета формы, Р1–Р6, зоны доводки</small></button>
      <button class="hact" data-set="data">${icon('i-upload')}<b>Пакет команды</b><small>скачать или загрузить: состав, форма, расстановки, соперники</small></button>
    </div>`;
}

const NAV = [['recent', 'Главная', 'i-cube', ''], ['matches', 'Матчи', 'i-list', '#matches'], ['team', 'Команда', 'i-users', '#team'], ['analytics', 'Аналитика', 'i-chart', '#analytics']];
function paintSide() {
  $('home').classList.toggle('folded', S.folded);
  $('hside').innerHTML = `<div class="hbrand"><img src="img/logo.svg" alt=""><span><b>Волей Метрика</b><small>${esc(S.settings.teamName || 'статистика волейбола')}</small></span>
      <button class="hfold" data-fold title="${S.folded ? 'Закрепить меню' : 'Свернуть меню'}">${icon('i-panel')}</button></div>
    ${NAV.map(([k, l, ic, h]) => `<a class="${S.view === k ? 'on' : ''}" href="${h || '#'}">${icon(ic)}${l}</a>${k === 'analytics' && S.view === k && S.sections.length ? `<div class="hsub">${S.sections.map(([id, t]) => `<a href="#" class="${S.section === id ? 'on' : ''}" data-sec="${id}">${esc(t)}</a>`).join('')}</div>` : ''}`).join('')}
    <span class="grow"></span>
    <button data-set="general">${icon('i-gear')}Настройки</button>`;
}
function paintMain() {
  const el = $('hmain');
  if (S.view === 'analytics') return;
  const focus = document.activeElement?.id === 'q' ? document.activeElement.selectionStart : null;
  el.innerHTML = { recent: viewRecent, matches: viewMatches, team: viewTeam }[S.view]();
  if (focus != null) { const q = $('q'); q.focus(); q.setSelectionRange(focus, focus); }
}
const paint = () => { paintSide(); paintMain(); };

const analytics = createAnalytics({
  matches: () => S.matches, settings: () => S.settings, cardCtx,
  onSections: list => { S.sections = list; S.section = list[0]?.[0] ?? null; paintSide(); },
});

// ---------- Адрес ----------
function route() {
  const [name, id, src, set] = location.hash.slice(1).split('/');
  const was = S.view;
  S.view = ['matches', 'team', 'analytics'].includes(name) ? name : 'recent';
  if (was === 'analytics' && S.view !== 'analytics') { analytics.stop(); S.sections = []; }
  paintSide();
  if (S.view === 'analytics') {
    const el = $('hmain');
    if (was !== 'analytics') el.innerHTML = '';
    analytics.show(el, { ...(id && { match: id }), ...(MODES[src] && { src }), ...(set !== undefined && { set: +set }) });
  } else paintMain();
  $('hmain').scrollTop = 0;
}
addEventListener('hashchange', route);

// ---------- Действия ----------
document.addEventListener('click', e => {
  const t = e.target;
  const fold = t.closest('[data-fold]');
  if (fold) { S.folded = !S.folded; store.set('folded', S.folded); $('home').classList.remove('peek'); return paintSide(); }
  const c = t.closest('[data-card]');
  if (c) { S.open = S.open === c.dataset.card ? null : c.dataset.card; return paintMain(); }
  if (t.closest('[data-new]')) return settings.newMatch();
  const st = t.closest('[data-set]');
  if (st && st.tagName === 'BUTTON' && st.closest('#home')) return settings.open(st.dataset.set);
  const sec = t.closest('[data-sec]');
  if (sec) { e.preventDefault(); S.section = sec.dataset.sec; paintSide(); return document.getElementById(sec.dataset.sec)?.scrollIntoView({ behavior: 'smooth' }); }
  const del = t.closest('[data-del]');
  if (del) {
    const m = S.matches.find(x => x.id === del.dataset.del);
    if (confirm(`Удалить матч с «${m.opponent}»? Вся его статистика переедет в корзину (data/trash).`)) fetch(`/api/matches/${m.id}`, { method: 'DELETE' }).then(refresh);
    return;
  }
  // Запоминаем, где вводили, для «Продолжить».
  const a = t.closest('a[href*="#m="]');
  if (a) { const mode = MODE_KEYS.find(k => a.getAttribute('href').startsWith(MODES[k].page)), id = a.getAttribute('href').split('#m=')[1]; if (mode) store.set('last', { id, mode }); }
});
document.addEventListener('input', e => { if (e.target.id === 'q') { S.q = e.target.value; paintMain(); } });
// Подсветка раздела аналитики при прокрутке.
$('hmain').addEventListener('scroll', () => {
  if (S.view !== 'analytics' || !S.sections.length) return;
  const top = $('hmain').getBoundingClientRect().top + 130;
  const cur = S.sections.filter(([id]) => { const el = document.getElementById(id); return el && el.getBoundingClientRect().top <= top; }).at(-1)?.[0] ?? S.sections[0][0];
  if (cur !== S.section) { S.section = cur; document.querySelectorAll('.hsub a').forEach(a => a.classList.toggle('on', a.dataset.sec === cur)); }
}, { passive: true });
// Свёрнутое меню выезжает, когда мышь у левого края, и уезжает, когда она ушла.
$('hedge').addEventListener('mouseenter', () => $('home').classList.add('peek'));
document.addEventListener('mousemove', e => { if (e.clientX > 250) $('home').classList.remove('peek'); }, { passive: true });
$('hunfold').addEventListener('mouseenter', () => $('home').classList.add('peek'));
$('hunfold').addEventListener('click', () => { S.folded = false; store.set('folded', false); $('home').classList.remove('peek'); paintSide(); });

// Окна настроек и нового матча — общий модуль со студией. Матча на главной нет (match, st = null).
const ui = {
  match: null, st: null,
  get roster() { return S.roster; }, set roster(v) { S.roster = v; },
  get settings() { return S.settings; }, set settings(v) { S.settings = v; },
  get matches() { return S.matches; }, set matches(v) { S.matches = v; },
};
const settings = createSettings({ ui, onChanged: () => refresh().then(() => { if (S.view === 'analytics') route(); }), onMatchCreated: m => { S.open = m.id; refresh(); } });

const get = url => fetch(url).then(r => r.json()).catch(() => null);
async function refresh() {
  const [s, roster, matches] = await Promise.all([get('/api/settings'), get('/api/roster'), get('/api/matches')]);
  Object.assign(S, { settings: { opponents: [], tournaments: [], ...(s ?? {}) }, roster: roster ?? [], matches: matches ?? [] });
  S.view === 'analytics' ? paintSide() : paint();
}
await refresh();
route();
// Вернулись на вкладку (ввели статистику в студии или на телефоне) — обновляем.
addEventListener('focus', refresh);
