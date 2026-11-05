// Экспорт и импорт: пакет команды (без матчей), один матч, таблица статистики для Excel.
// Чистые функции над данными — сервер только читает/пишет файлы. Архивы — обычный ZIP (zip.js).
import { MODES, MODE_KEYS, migrate } from './public/modes.js';
import { makeZip, readZip } from './zip.js';
import { replay, newPlayer, addStats, totals, attEff, recRating } from './public/engine.js';

export const TEAM_FORMAT = 'volleyball-metrics/team';
export const MATCH_FORMAT = 'volleyball-metrics/match';
// Части пакета команды — что можно выбрать при экспорте и импорте.
export const TEAM_PARTS = {
  roster: 'Состав: игроки, номера, роли',
  kit: 'Название, эмблема, форма',
  play: 'Схема игры, расстановки, зоны доводки',
  opps: 'Соперники и их эмблемы',
};
const PLAY_KEYS = ['system', 'formations', 'presets', 'activePreset', 'qualityZones'];

const slug = s => String(s || 'team').trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').slice(0, 40) || 'team';
const stamp = (d = new Date()) => d.toISOString().slice(0, 10);
// data:image/png;base64,… → { ext, buf } (эмблемы лежат в настройках как data URL).
function fromDataUrl(url) {
  const m = /^data:image\/([a-z+]+);base64,(.+)$/i.exec(url || '');
  if (!m) return null;
  return { ext: m[1] === 'svg+xml' ? 'svg' : m[1] === 'jpeg' ? 'jpg' : m[1], buf: Buffer.from(m[2], 'base64') };
}
const csvCell = v => { const s = v == null ? '' : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
// Excel в русской локали: разделитель «;», дробные — с запятой, BOM — чтобы кириллица открылась сразу.
export const toCsv = rows => '\uFEFF' + rows.map(r => r.map(v => csvCell(typeof v === 'number' && !Number.isInteger(v) ? String(+v.toFixed(2)).replace('.', ',') : v)).join(';')).join('\r\n') + '\r\n';

// ---------- Пакет команды ----------
export function buildTeamPackage({ roster, settings }, parts = Object.keys(TEAM_PARTS), when = new Date()) {
  const has = k => parts.includes(k);
  const team = { format: TEAM_FORMAT, version: 1, exported: when.toISOString(), teamName: settings.teamName, parts: parts.filter(k => TEAM_PARTS[k]) };
  if (has('kit')) Object.assign(team, { kit: settings.kit ?? null, emblem: settings.emblem ?? null });
  if (has('roster')) team.roster = roster;
  if (has('play')) team.play = Object.fromEntries(PLAY_KEYS.filter(k => settings[k] !== undefined).map(k => [k, settings[k]]));
  if (has('opps')) team.opponents = settings.opponents ?? [];
  const files = [{ name: 'team.json', data: JSON.stringify(team, null, 2) }];
  // Для человека: состав таблицей и эмблемы картинками (при импорте берутся из team.json).
  if (team.roster) files.push({ name: 'Состав.csv', data: toCsv([['№', 'Имя', 'Роль', 'В составе'], ...team.roster.map(p => [p.num ?? '', p.name ?? '', p.role ?? (p.setter ? 's' : ''), p.active === false ? 'нет' : 'да'])]) });
  const us = has('kit') && fromDataUrl(settings.emblem);
  if (us) files.push({ name: `Эмблемы/${slug(settings.teamName)}.${us.ext}`, data: us.buf });
  if (has('opps')) for (const o of team.opponents) { const e = fromDataUrl(o.emblem); if (e) files.push({ name: `Эмблемы/${slug(o.name)}.${e.ext}`, data: e.buf }); }
  files.push({ name: 'ПРОЧТИ.txt', data: `Пакет команды «${settings.teamName}» из программы «Волей Метрика» (${stamp(when)}).\r\n\r\nВнутри: ${team.parts.map(k => TEAM_PARTS[k].toLowerCase()).join('; ')}.\r\nМатчи сюда не входят.\r\n\r\nКак загрузить: Студия → Настройки → Данные → «Загрузить пакет команды», выбрать этот файл.\r\n` });
  return { name: `Команда_${slug(settings.teamName)}_${stamp(when)}.zip`, data: makeZip(files, when) };
}

// Прочитать пакет (ZIP или голый team.json) → объект team.
export function readTeamPackage(buf) {
  const text = buf[0] === 0x50 && buf[1] === 0x4b ? readZip(buf).find(f => f.name === 'team.json')?.data.toString('utf8') : buf.toString('utf8');
  if (!text) throw new Error('В архиве нет team.json — это не пакет команды');
  let team;
  try { team = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('Это не пакет команды «Волей Метрики»'); }
  if (team.format !== TEAM_FORMAT) throw new Error('Это не пакет команды «Волей Метрики»');
  return team;
}

// Применить выбранные части пакета. Игроки и соперники — слиянием (по id, иначе по номеру и имени / названию):
// никого не удаляем — на удалённых ссылались бы старые матчи.
export function applyTeamPackage({ roster, settings }, team, parts = team.parts ?? []) {
  const has = k => parts.includes(k) && (team.parts ?? []).includes(k);
  const outRoster = roster.map(p => ({ ...p }));
  const patch = {};
  const report = { roster: { added: 0, updated: 0 }, opps: { added: 0, updated: 0 }, parts: [] };
  if (has('roster')) {
    for (const p of team.roster ?? []) {
      const cur = outRoster.find(x => x.id === p.id) ?? outRoster.find(x => p.num != null && p.num !== '' && String(x.num) === String(p.num) && (x.name || '').trim().toLowerCase() === (p.name || '').trim().toLowerCase());
      if (cur) { Object.assign(cur, { ...p, id: cur.id }); report.roster.updated++; }
      else { outRoster.push({ ...p, id: outRoster.some(x => x.id === p.id) || !p.id ? `p${Date.now().toString(36)}${outRoster.length}` : p.id }); report.roster.added++; }
    }
    report.parts.push('roster');
  }
  if (has('kit')) { Object.assign(patch, { teamName: team.teamName ?? settings.teamName, kit: team.kit ?? settings.kit, emblem: team.emblem ?? null }); report.parts.push('kit'); }
  if (has('play')) { Object.assign(patch, team.play ?? {}); report.parts.push('play'); }
  if (has('opps')) {
    const opps = (settings.opponents ?? []).map(o => ({ ...o }));
    for (const o of team.opponents ?? []) {
      const cur = opps.find(x => x.id === o.id) ?? opps.find(x => (x.name || '').trim().toLowerCase() === (o.name || '').trim().toLowerCase());
      if (cur) { Object.assign(cur, { ...o, id: cur.id }); report.opps.updated++; } else { opps.push({ ...o }); report.opps.added++; }
    }
    patch.opponents = opps;
    report.parts.push('opps');
  }
  return { roster: outRoster, settingsPatch: patch, report };
}

// ---------- Один матч ----------
// Матч целиком (события, состав на матч, привязка видео по имени файла) + соперник с эмблемой + события таблицей.
export function buildMatchPackage(raw, { settings }, labels = {}, when = new Date()) {
  const match = migrate(raw);
  const opp = settings.opponents?.find(o => o.id === match.opponentId) ?? null;
  const pkg = { format: MATCH_FORMAT, version: 1, exported: when.toISOString(), teamName: settings.teamName, opponent: opp ? { id: opp.id, name: opp.name, emblem: opp.emblem ?? null } : { name: match.opponent }, match };
  const events = MODE_KEYS.flatMap(k => match.stats[k].events.map(e => ({ ...e, mode: MODES[k].name })));
  const name = id => { const p = match.roster.find(x => x.id === id); return p ? `${p.num ?? ''} ${p.name ?? ''}`.trim() : ''; };
  const rows = [['№', 'Режим', 'Время видео, с', 'Действие', 'Результат', 'Игрок', 'Откуда x', 'Откуда y', 'Куда x', 'Куда y']];
  events.forEach((e, i) => rows.push([i + 1, e.mode, e.vt ?? '', e.t === 'act' ? e.skill : e.t, e.t === 'act' ? labels[e.skill]?.[e.res] ?? e.res : '', name(e.p), e.from?.x ?? '', e.from?.y ?? '', e.to?.x ?? '', e.to?.y ?? '']));
  const title = `${slug(settings.teamName)}-${slug(pkg.opponent.name)}_${(match.created || '').slice(0, 10)}`;
  const files = [
    { name: 'match.json', data: JSON.stringify(pkg, null, 2) },
    { name: 'События.csv', data: toCsv(rows) },
    { name: 'ПРОЧТИ.txt', data: `Матч ${settings.teamName} — ${pkg.opponent.name} (${(match.created || '').slice(0, 10)}) из «Волей Метрики».\r\nСобытий: ${events.length}. Видео в архив не входит — его можно привязать заново в студии.\r\n\r\nКак загрузить: Студия → Настройки → Данные → «Загрузить матч».\r\n` },
  ];
  return { name: `Матч_${title}.zip`, data: makeZip(files, when) };
}
export function readMatchPackage(buf) {
  const text = buf[0] === 0x50 && buf[1] === 0x4b ? readZip(buf).find(f => f.name === 'match.json')?.data.toString('utf8') : buf.toString('utf8');
  if (!text) throw new Error('В архиве нет match.json — это не файл матча');
  let pkg;
  try { pkg = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('Это не файл матча «Волей Метрики»'); }
  if (pkg.format !== MATCH_FORMAT || !(pkg.match?.events || pkg.match?.stats)) throw new Error('Это не файл матча «Волей Метрики»');
  return pkg;
}
// Добавить матч: новый id, если такой уже есть; соперник — найти по id/названию или добавить;
// игроки из состава матча, которых нет в команде, добавляются «в запас» (чтобы имена в отчётах были).
export function importMatch({ roster, settings, ids }, pkg) {
  const m = migrate(structuredClone(pkg.match));
  if (ids.has(m.id)) m.id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const opps = (settings.opponents ?? []).map(o => ({ ...o }));
  let opp = opps.find(o => o.id === pkg.opponent?.id) ?? opps.find(o => (o.name || '').trim().toLowerCase() === (pkg.opponent?.name || '').trim().toLowerCase());
  if (!opp && pkg.opponent?.name) { opp = { id: pkg.opponent.id || `o${Date.now().toString(36)}`, name: pkg.opponent.name, ...(pkg.opponent.emblem && { emblem: pkg.opponent.emblem }) }; opps.push(opp); }
  if (opp) { m.opponentId = opp.id; m.opponent = opp.name; }
  m.videos = []; // видео — на другом компьютере; привязывается заново
  const outRoster = roster.map(p => ({ ...p }));
  for (const p of m.roster ?? []) if (!outRoster.some(x => x.id === p.id)) outRoster.push({ ...p, active: false });
  return { match: m, roster: outRoster, opponents: opps };
}

// ---------- Таблица статистики игроков (все детальные матчи) ----------
export function statsCsv(matches) {
  const players = {}, seen = {};
  for (const m of matches) {
    const st = replay(m);
    for (const [id, p] of Object.entries(st.players.all || {})) { addStats((players[id] ??= newPlayer()), p); (seen[id] ??= new Set()).add(m.id); }
  }
  const who = id => { for (const m of matches) { const p = m.roster.find(x => x.id === id); if (p) return p; } return {}; };
  const pc = (a, b) => (b ? Math.round((100 * a) / b) : '');
  const rows = [['№', 'Игрок', 'Матчей', 'Очки', 'Ошибки', '+/−', 'Атак', 'Атака: очки', 'Атака: ошибки', 'Атака: блок', 'Эффективность атаки, %', 'Подач', 'Эйсы', 'Ошибки подачи', 'Приёмов', 'Приём ++', 'Приём +', 'Приём −', 'Ошибки приёма', 'Рейтинг приёма (из 3)', 'Позитив приёма, %', 'Блок: очки', 'Защит', 'Ошибки игры']];
  for (const [id, p] of Object.entries(players).sort((a, b) => (+who(a[0]).num || 99) - (+who(b[0]).num || 99))) {
    const t = totals(p), w = who(id), eff = attEff(p.att);
    rows.push([w.num ?? '', w.name ?? id, seen[id].size, t.points, t.errors, t.diff, p.att.tot, p.att.kill + p.att.bo, p.att.err, p.att.blk, eff == null ? '' : Math.round(eff * 100),
      p.serve.tot, p.serve.ace, p.serve.err, p.rec.tot, p.rec.pp, p.rec.pm, p.rec.p, p.rec.err, recRating(p.rec) ?? '', pc(p.rec.pp + p.rec.pm, p.rec.tot), p.blk.point, p.dig.tot, p.fault]);
  }
  return toCsv(rows);
}
