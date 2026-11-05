// Карточка матча: эмблемы, счёт по партиям, счёт каждой партии, режимы статистики.
// Одна на главной и в аналитике. Раскрытая показывает таблицу «режим × партия»: партии идут строго по порядку.
import { MODES, MODE_KEYS } from './modes.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function emblem(src, title, cls = '') {
  if (src) return `<img class="emb ${cls}" src="${src}" alt="">`;
  const ini = String(title || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  let h = 0; for (const ch of String(title)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `<span class="emb ini ${cls}" style="background:hsl(${h} 45% 32%)">${esc(ini)}</span>`;
}
// Сколько партий может быть в этом формате: до 2 побед — три, до 3 побед — пять.
export const setSlots = m => (m.format?.sets ?? 2) * 2 - 1;
const score = s => `${s.us}:${s.them}`;
const fullDate = m => new Date(m.created).toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' });

// Что в ячейке партии у этого режима: сыграна, идёт, следующая по порядку или ещё недоступна.
export function setState(x, i) {
  const s = x.sets[i];
  if (s) return s.over ? 'done' : 'live';
  if (x.over) return 'none';
  const prev = x.sets[i - 1];
  return i === x.sets.length && (i === 0 || prev?.over) ? 'next' : 'none';
}
const cellText = s => (s ? score(s) : '—');

// Закрытая часть карточки. ctx: { team, teamEmblem, oppEmblem, tourName }.
export function matchHead(m, ctx) {
  const x = m.modes[m.main], won = x.setsWon;
  const slots = Array.from({ length: setSlots(m) }, (_, i) => x.sets[i]);
  const tour = ctx.tourName?.(m.tournament);
  return `<span class="mc-top">
      <span class="mc-team">${emblem(ctx.teamEmblem, ctx.team, 'lg')}<b>${esc(ctx.team)}</b></span>
      <span class="mc-score"><b>${won.us}<i>:</i>${won.them}</b><small>${x.over ? 'матч окончен' : x.events ? 'идёт' : 'не начат'}</small></span>
      <span class="mc-team them">${emblem(ctx.oppEmblem(m), m.opponent, 'lg')}<b>${esc(m.opponent)}</b></span>
    </span>
    <span class="mc-sets">${slots.map((s, i) => `<span class="mc-set ${s ? (s.over ? (s.us > s.them ? 'won' : 'lost') : 'live') : ''}"><small>${i + 1}</small>${cellText(s)}</span>`).join('')}</span>
    <span class="mc-foot"><span class="mc-date">${fullDate(m)}${tour ? ' · ' + esc(tour) : ''}</span>
      <span class="mc-modes">${MODE_KEYS.map(k => `<span class="mc-mode ${m.modes[k].events ? 'on' : ''} ${k === m.main && m.modes[k].events ? 'main' : ''}" title="${MODES[k].name}: ${m.modes[k].events ? 'есть статистика' : 'статистики нет'}">${MODES[k].name}</span>`).join('')}</span></span>`;
}

// Раскрытая часть: строки — режимы, столбцы — партии.
export function matchGrid(m) {
  const n = setSlots(m);
  const head = Array.from({ length: n }, (_, i) => `<span class="mg-h">Партия ${i + 1}</span>`).join('');
  const row = k => {
    const x = m.modes[k], url = `${MODES[k].page}#m=${m.id}`;
    const cell = i => {
      const st = setState(x, i), s = x.sets[i];
      if (st === 'done') return `<a class="mg-c done" href="#analytics/${m.id}/${k}/${i}" title="Аналитика партии">${score(s)}</a>`;
      if (st === 'live') return `<a class="mg-c live" href="${url}" title="Продолжить ввод">${score(s)}<small>идёт</small></a>`;
      if (st === 'next') return `<a class="mg-c next" href="${url}" title="${MODES[k].hint}">▶ Начать</a>`;
      return `<span class="mg-c none" title="Партии идут по порядку">—</span>`;
    };
    return `<span class="mg-n" title="${MODES[k].hint}">${MODES[k].name}</span>${Array.from({ length: n }, (_, i) => cell(i)).join('')}
      ${x.events ? `<a class="mg-a" href="#analytics/${m.id}/${k}">Аналитика</a>` : '<span class="mg-a off">нет данных</span>'}`;
  };
  return `<div class="mgrid" style="--sets:${n}"><span></span>${head}<span></span>${MODE_KEYS.map(row).join('')}</div>`;
}
