// Стартовый экран программы (корневая страница): как в Figma / Adobe — боковая панель и главная.
// Главная: продолжить последний матч, новый матч, режимы (студия, пульт, быстрая статистика), недавние матчи.
// «Все матчи» — детальные и быстрые, по турнирам, с поиском. «Команда» — состав и переход к настройкам.
// «Телефон» — адрес и QR для пульта. Клавиши 1 / 2 / 3 — быстрая, пульт, студия (как раньше).
import { ROLES, roleOf } from './court.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = id => `<svg><use href="#${id}"/></svg>`;
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem('home.' + k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('home.' + k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};
const lastStudioMatch = () => { try { return JSON.parse(localStorage.getItem('studio.lastMatch')); } catch { return null; } };

const S = { view: store.get('view', 'recent'), q: '', settings: { teamName: '', opponents: [], tournaments: [] }, roster: [], detail: [], quick: [], qr: null };

function emblem(src, title, cls = '') {
  if (src) return `<img class="emb ${cls}" src="${src}" alt="">`;
  const ini = String(title || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  let h = 0; for (const ch of String(title)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `<span class="emb ini ${cls}" style="background:hsl(${h} 45% 32%)">${esc(ini)}</span>`;
}
const ours = cls => emblem(S.settings.emblem, S.settings.teamName, cls);
const theirs = (m, cls) => emblem(S.settings.opponents.find(o => o.id === m.opponentId)?.emblem, m.opponent, cls);
const tourName = id => (id ? S.settings.tournaments?.find(t => t.id === id)?.name ?? '' : '');
function greet() { const h = new Date().getHours(); return h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер'; }
const state = m => (m.over ? 'окончен' : m.events ? 'идёт' : 'не начат');
// Детальный матч открывается в студии, быстрый — в быстрой статистике.
const openUrl = m => (m.quick ? `quick.html#m=${m.id}` : `studio.html#m=${m.id}`);

function card(m) {
  const st = state(m), tour = tourName(m.tournament);
  return `<a class="hcard" href="${openUrl(m)}">
    <span class="hc-top">${ours('lg')}<span class="hc-score">${m.setsWon?.us ?? 0}<i>:</i>${m.setsWon?.them ?? 0}</span>${theirs(m, 'lg')}</span>
    <span class="hc-name"><b>${esc(S.settings.teamName)} — ${esc(m.opponent)}</b><small>${new Date(m.created).toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' })}${tour ? ' · ' + esc(tour) : ''}</small></span>
    <span class="hc-meta"><span class="pill ${st === 'идёт' ? 'live' : st === 'окончен' ? 'done' : ''}">${st}</span><span class="pill">${m.quick ? 'быстрая' : 'детальная'}</span><span>событий ${m.events}</span>${m.videos?.length ? `<span>${icon('i-film')} ${m.videos.length}</span>` : ''}</span>
  </a>`;
}
const act = (href, ic, title, sub, cls = '', key = '') => `<a class="hact ${cls}" href="${href}">${icon(ic)}<b>${title}${key ? `<span class="kbd">${key}</span>` : ''}</b><small>${sub}</small></a>`;
const search = () => `<input class="hsearch" id="q" placeholder="Поиск: соперник или турнир" value="${esc(S.q)}">`;

function view() {
  const all = [...S.detail.map(m => ({ ...m, quick: false })), ...S.quick.map(m => ({ ...m, quick: true }))].sort((a, b) => b.created.localeCompare(a.created));
  const q = S.q.trim().toLowerCase();
  const found = q ? all.filter(m => (m.opponent || '').toLowerCase().includes(q) || tourName(m.tournament).toLowerCase().includes(q)) : all;
  if (S.view === 'team') {
    const on = S.roster.filter(p => p.active !== false);
    return `<div class="hhead"><h1>Команда</h1></div>
      <div class="hteam">${ours('xl')}<span><b>${esc(S.settings.teamName)}</b><small>в составе ${on.length} · в запасе ${S.roster.length - on.length} · соперников ${S.settings.opponents.length}</small></span></div>
      <div class="hroster">${on.sort((a, b) => (+a.num || 99) - (+b.num || 99)).map(p => `<span class="hplayer"><b>${esc(p.num ?? '')}</b>${esc(p.name)}<small>${ROLES[roleOf(p)]?.name ?? ''}</small></span>`).join('') || '<p class="muted">Игроков пока нет.</p>'}</div>
      <div class="hactions">
        ${act('studio.html#settings=team', 'i-users', 'Состав, форма, расстановки', 'игроки, цвета формы, Р1–Р6, зоны доводки')}
        ${act('studio.html#settings=data', 'i-upload', 'Пакет команды', 'скачать или загрузить: состав, форма, расстановки, соперники')}
      </div>`;
  }
  if (S.view === 'phone') {
    const urls = S.qr?.urls ?? [];
    return `<div class="hhead"><h1>Пульт для телефона</h1></div>
      <p class="muted" style="max-width:560px">Телефон и ноутбук — в одной Wi-Fi сети. Откройте на телефоне адрес или наведите камеру на код: пульт быстрой или детальной статистики работает без установки.</p>
      <div class="hphone">${S.qr?.qr ? `<img src="${S.qr.qr}" alt="QR-код адреса">` : ''}<span>${urls.map(u => `<b class="mono">${esc(u)}</b>`).join('') || '<b>Нет сети для телефона</b><small>Подключите ноутбук к Wi-Fi или точке доступа.</small>'}<small>На этом компьютере: ${esc(location.host)}</small></span></div>
      <div class="hactions">
        ${act('detailed.html', 'i-list', 'Пульт детальной статистики', 'каждое касание с телефона', '', '2')}
        ${act('quick.html', 'i-bolt', 'Быстрая статистика', 'кто закончил розыгрыш и чем — для игры вживую', '', '1')}
        ${act('detailed.html#settings', 'i-gear', 'Настройки пульта', 'состав, соперники, QR')}
      </div>`;
  }
  if (S.view === 'all') {
    const groups = new Map();
    for (const m of found) { const k = m.tournament ?? ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
    return `<div class="hhead"><h1>Все матчи</h1>${search()}<a class="btn primary" href="studio.html#new">${icon('i-plus')}Новый матч</a></div>
      ${[...groups].map(([k, list]) => `<h3 class="hsec">${esc(k ? tourName(k) || 'Турнир' : 'Без турнира')} <small>${list.length}</small></h3><div class="hgrid">${list.map(card).join('')}</div>`).join('') || `<p class="muted">${q ? 'Ничего не нашлось.' : 'Матчей пока нет.'}</p>`}`;
  }
  const lastId = lastStudioMatch();
  const last = S.detail.find(m => m.id === lastId) ?? S.detail[0];
  return `<div class="hhead"><h1>${greet()}${S.settings.teamName ? `, «${esc(S.settings.teamName)}»` : ''}</h1>${search()}</div>
    <div class="hactions">
      ${act('studio.html#new', 'i-plus', 'Новый матч', 'в студии: видео, 3D, каждое касание', 'primary')}
      ${last ? act(`studio.html#m=${last.id}`, 'i-play', 'Продолжить', `${esc(last.opponent)} · ${new Date(last.created).toLocaleDateString('ru')} · ${state(last)}`, '', '3') : act('studio.html#home', 'i-film', 'Студия', 'видео и 3D-площадка', '', '3')}
      ${act('quick.html', 'i-bolt', 'Быстрая статистика', 'кто закончил розыгрыш и чем — вживую', 'mfirst', '1')}
      ${act('detailed.html', 'i-phone', 'Пульт для телефона', 'детальная статистика с телефона', 'mfirst', '2')}
      ${act('stats.html', 'i-chart', 'Аналитика', 'дашборд детальной статистики')}
    </div>
    <h3 class="hsec">${q ? 'Найдено' : 'Недавние'} <small>${found.length}</small>${!q && all.length > 8 ? '<button class="btn sm ghost" data-v="all">Все матчи</button>' : ''}</h3>
    <div class="hgrid">${(q ? found : found.slice(0, 8)).map(card).join('') || `<div class="hempty"><b>${q ? 'Ничего не нашлось' : 'Матчей пока нет'}</b><small>${q ? 'Попробуйте другое название.' : 'Создайте первый матч — в студии по видео или быстрой статистикой вживую.'}</small></div>`}</div>`;
}

const VIEWS = [['recent', 'Главная', 'i-cube'], ['all', 'Все матчи', 'i-list'], ['team', 'Команда', 'i-users'], ['phone', 'Телефон', 'i-phone']];
function paint() {
  const focus = document.activeElement?.id === 'q' ? document.activeElement.selectionStart : null;
  $('home').innerHTML = `<aside class="hside">
      <div class="hbrand"><img src="img/logo.svg" alt=""><span><b>Волей Метрика</b><small>${esc(S.settings.teamName || 'статистика волейбола')}</small></span></div>
      ${VIEWS.map(([k, l, ic]) => `<button class="${S.view === k ? 'on' : ''}" data-v="${k}">${icon(ic)}${l}</button>`).join('')}
      <a href="stats.html">${icon('i-chart')}Аналитика</a>
      <a href="quick-stats.html">${icon('i-bolt')}Дашборд быстрой</a>
      <span class="grow"></span>
      <a href="studio.html#settings">${icon('i-gear')}Настройки</a>
    </aside>
    <main class="hmain">${view()}</main>`;
  if (focus != null) { const q = $('q'); q.focus(); q.setSelectionRange(focus, focus); }
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  S.view = b.dataset.v; store.set('view', S.view); paint();
});
document.addEventListener('input', e => { if (e.target.id === 'q') { S.q = e.target.value; paint(); } });
addEventListener('keydown', e => {
  if (e.target.matches?.('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Digit1') location.href = 'quick.html';
  if (e.code === 'Digit2') location.href = 'detailed.html';
  if (e.code === 'Digit3') location.href = document.querySelector('.hact[href^="studio.html#m="]')?.getAttribute('href') ?? 'studio.html#home';
});

const get = url => fetch(url).then(r => r.json()).catch(() => null);
paint();
Promise.all([get('/api/settings'), get('/api/roster'), get('/api/matches'), get('/api/matches?mode=quick'), get('/api/qr')]).then(([settings, roster, detail, quick, qr]) => {
  Object.assign(S, { settings: { opponents: [], tournaments: [], ...(settings ?? {}) }, roster: roster ?? [], detail: detail ?? [], quick: quick ?? [], qr });
  paint();
});
// Вернулись на вкладку (матч ввели на телефоне или в студии) — обновляем список.
addEventListener('focus', () => Promise.all([get('/api/matches'), get('/api/matches?mode=quick')]).then(([d, q]) => { S.detail = d ?? S.detail; S.quick = q ?? S.quick; paint(); }));
