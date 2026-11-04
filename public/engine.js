// Вся логика матча. Матч хранится как список событий; счёт, подача и статистика
// каждый раз пересчитываются из этого списка — поэтому «отмена» = удалить последнее событие,
// а правка по видео = заменить или вставить событие в любом месте.
// Файл общий: его использует телефон, студия, дашборд и сервер.
import { slotZones, rotationOf, guessSetter, setDir, zoneOf } from './court.js';

// Исход действия: 'us' — очко нам, 'them' — сопернику, null — розыгрыш продолжается.
export const ACTIONS = {
  // good — сложная подача (соперник принял плохо), in — просто в игру. Без отметки подача считается «в игру» сама.
  serve: { ace: 'us', good: null, in: null, error: 'them' },
  // over — перекид: приняли так, что мяч сразу ушёл к сопернику.
  rec: { pp: null, pm: null, p: null, over: null, error: 'them' },
  // Пас связующего: качество паса для нападающего.
  set: { perfect: null, good: null, poor: null, error: 'them' },
  att: { kill: 'us', bo: 'us', play: null, error: 'them', blocked: 'them' },
  blk: { point: 'us', touch: null, out: 'them' },
  dig: { plus: null, minus: null, over: null, error: 'them' },
  fault: { error: 'them' },
  // over/back — статист вручную говорит, где мяч, без статистики игрока.
  team: { oppError: 'us', oppKill: 'them', oppAce: 'them', over: null, back: null },
};

// Где мяч после действия, если розыгрыш продолжается:
// 'ours' — мяч у нас (ждём пас и атаку), 'their' — мяч у них (ждём защиту или блок).
const NEXT_PHASE = {
  'serve.good': 'their', 'serve.in': 'their',
  'rec.pp': 'ours', 'rec.pm': 'ours', 'rec.p': 'ours', 'rec.over': 'their',
  'att.play': 'their', 'blk.touch': 'their',
  'dig.plus': 'ours', 'dig.minus': 'ours', 'dig.over': 'their',
  'team.over': 'their', 'team.back': 'ours',
};

export const LABELS = {
  serve: { ace: 'Эйс', good: 'Подача: сложная', in: 'Подача в игру', error: 'Ошибка подачи' },
  rec: { pp: 'Приём ++', pm: 'Приём +', p: 'Приём −', over: 'Приём: перекид', error: 'Ошибка приёма' },
  set: { perfect: 'Пас: идеальный', good: 'Пас: хороший', poor: 'Пас: неудобный', error: 'Пас: ошибка' },
  att: { kill: 'Атака: забил', bo: 'Атака: блок-аут', play: 'Атака в игру', error: 'Атака: аут/сетка', blocked: 'Атака: заблокирован' },
  blk: { point: 'Блок: очко', touch: 'Блок: касание', out: 'Блок: блок-аут' },
  dig: { plus: 'Защита +', minus: 'Защита −', over: 'Защита: перекид', error: 'Защита: не поднял' },
  fault: { error: 'Ошибка (сетка/заступ/касания)' },
  team: { oppError: 'Ошибка соперника', oppKill: 'Соперник забил', oppAce: 'Эйс соперника', over: 'Мяч ушёл к ним', back: 'Мяч у нас' },
};

export const SKILLS = { serve: 'Подача', rec: 'Приём', set: 'Пас', att: 'Атака', blk: 'Блок', dig: 'Защита', fault: 'Ошибки', team: 'Команда' };

// Оценка приёма по шкале 0–3 (как «pass rating» в американской статистике).
export const REC_RATING = { pp: 3, pm: 2, p: 1, over: 0.5, error: 0 };

const counter = () => ({ n: 0, won: 0 });

export const newPlayer = () => ({
  serve: { tot: 0, ace: 0, good: 0, err: 0 },
  rec: { tot: 0, pp: 0, pm: 0, p: 0, over: 0, err: 0 },
  set: { tot: 0, perfect: 0, good: 0, poor: 0, err: 0 },
  att: { tot: 0, kill: 0, bo: 0, err: 0, blk: 0 },
  blk: { point: 0, touch: 0, out: 0 },
  dig: { tot: 0, plus: 0, minus: 0, over: 0, err: 0 },
  fault: 0,
  court: { n: 0, us: 0 }, // розыгрышей на площадке и сколько из них выиграли — для «±, пока игрок на площадке»
});

const newTeam = () => ({
  sideout: counter(), // подавал соперник: как часто мы выигрываем розыгрыш
  brk: counter(), // подавали мы: как часто выигрываем розыгрыш
  afterRec: { pp: counter(), pm: counter(), p: counter(), over: counter(), error: counter() },
  rot: {}, // по расстановкам: { 1: { so, brk, us, them } … }
  oppError: 0, oppKill: 0, oppAce: 0,
  noStats: 0, // очки, внесённые без статистики
  links: {}, // связка «связующий > нападающий»
});

// Форматы матча. sets — сколько партий нужно выиграть, points — до скольки партия, tiebreak — решающая партия.
// По умолчанию — до двух побед (максимум 2:1), третья партия — тай-брейк до 15.
export const FORMATS = {
  bo3: { sets: 2, points: 25, tiebreak: 15, name: 'До 2 побед (25 · 25 · 15)' },
  bo5: { sets: 3, points: 25, tiebreak: 15, name: 'До 3 побед (25 × 4 · 15)' },
  one25: { sets: 1, points: 25, tiebreak: 25, name: 'Одна партия до 25' },
  one15: { sets: 1, points: 15, tiebreak: 15, name: 'Одна партия до 15' },
};
export const DEFAULT_FORMAT = FORMATS.bo3;
export const SETS_TO_WIN = DEFAULT_FORMAT.sets;
export const formatOf = m => { const { sets, points, tiebreak } = DEFAULT_FORMAT; return { sets, points, tiebreak, ...(m?.format || {}) }; };
export const formatName = f => Object.values(FORMATS).find(x => x.sets === f.sets && x.points === f.points && x.tiebreak === f.tiebreak)?.name
  ?? `До ${f.sets} ${f.sets === 1 ? 'победы' : 'побед'}, партия до ${f.points}${f.sets > 1 ? `, решающая до ${f.tiebreak}` : ''}`;
// n — номер партии с нуля; решающая — последняя возможная (2 × побед − 1).
export const setTarget = (n, f = DEFAULT_FORMAT) => (n === f.sets * 2 - 2 ? f.tiebreak : f.points);
// У партии своя цель (target): можно вручную поставить «эта партия до 15».
export const isSetOver = s => Math.max(s.us, s.them) >= (s.target ?? setTarget(s.n)) && Math.abs(s.us - s.them) >= 2;
export function countSetsWon(sets) {
  const won = side => sets.filter(s => s.over && (side === 'us' ? s.us > s.them : s.them > s.us)).length;
  return { us: won('us'), them: won('them') };
}
// Название партии для кнопок и заголовков: «Партия 2», «Партия 3 (до 15)», «Тай-брейк (до 15)».
export function setTitle(n, f = DEFAULT_FORMAT, target = setTarget(n, f)) {
  if (n === f.sets * 2 - 2 && f.sets > 1) return `Тай-брейк (до ${target})`;
  return `Партия ${n + 1}${target !== 25 ? ` (до ${target})` : ''}`;
}
// Разбор выбора формата из списка: ключ FORMATS или «custom» — спросить параметры.
export function pickFormat(key) {
  if (FORMATS[key]) { const { sets, points, tiebreak } = FORMATS[key]; return { sets, points, tiebreak }; }
  const sets = Math.max(1, Math.min(5, Number(prompt('Сколько партий нужно выиграть? (1–5)', '2')) || 2));
  const points = Math.max(5, Math.min(50, Number(prompt('До скольки очков партия?', '25')) || 25));
  const tiebreak = sets > 1 ? Math.max(5, Math.min(50, Number(prompt('Решающая партия до?', '15')) || 15)) : points;
  return { sets, points, tiebreak };
}
export const formatKey = f => Object.keys(FORMATS).find(k => FORMATS[k].sets === f?.sets && FORMATS[k].points === f?.points && FORMATS[k].tiebreak === f?.tiebreak) ?? (f ? 'custom' : 'bo3');
export const formatOptions = sel => [...Object.entries(FORMATS).map(([k, v]) => [k, v.name]), ['custom', 'Своя настройка…']]
  .map(([k, v]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${v}</option>`).join('');

export const isMatchOver = (setsWon, f = DEFAULT_FORMAT) => Math.max(setsWon.us, setsWon.them) >= f.sets;

// opts.system — схема игры ('5-1', '4-2', '6-2', 'hybrid'), влияет только на автоподстановку связующего.
export function replay(match, opts = {}) {
  const system = opts.system || match.system || '5-1';
  const setters = new Set(match.roster.filter(p => p.setter).map(p => p.id));
  const fmt = formatOf(match);
  const players = {}, teams = {}, sets = [], log = [], plays = [];
  let set = null, rally = null, rallyNo = 0;

  const scopes = () => ['all', set.n];
  const player = (s, id) => ((players[s] ??= {})[id] ??= newPlayer());
  const team = s => (teams[s] ??= newTeam());
  const eachPlayer = (id, fn) => id && scopes().forEach(s => fn(player(s, id)));
  const eachTeam = fn => scopes().forEach(s => fn(team(s)));

  // z1 — слот (индекс в порядке подачи), который стоит в зоне 1.
  // Подаём мы — в зоне 1 подающий; подают они — тот, кто подавал последним (в начале партии — шестой).
  const z1 = () => (set.srv + 6) % 6;

  const newRally = () => {
    const weServe = set.serving === 'us';
    const zones = slotZones(z1());
    rally = {
      no: rallyNo++, weServe, server: weServe ? set.lineup[set.srv] : null, serveRes: null, rec: null, acts: 0,
      // phase: 'serve' — подаём мы, 'rec' — подают они, дальше 'ours' / 'their' (см. NEXT_PHASE).
      phase: weServe ? 'serve' : 'rec',
      zones, rot: rotationOf(set.mainSlot, z1()),
      // poss — наше владение мячом: откуда оно началось (приём или переход), каким был приём и чей был пас.
      poss: null, plays: [],
    };
  };

  const curSetter = () => guessSetter({ system, lineup: set.lineup, zones: rally.zones, setters, main: set.main });
  const zoneOfPlayer = id => { const k = set.lineup.indexOf(id); return k >= 0 ? rally.zones[k] : null; };

  const endRally = (winner, withStats) => {
    // Плюс-минус на площадке: каждый из шестерых получает розыгрыш (и победу, если выиграли).
    for (const id of set.lineup) eachPlayer(id, p => { p.court.n++; if (winner === 'us') p.court.us++; });
    // Подача в игру считается сама: каждый наш розыгрыш на своей подаче — это подача.
    if (withStats && rally.weServe) {
      eachPlayer(rally.server, p => {
        p.serve.tot++;
        if (rally.serveRes === 'ace') p.serve.ace++;
        if (rally.serveRes === 'good') p.serve.good++;
        if (rally.serveRes === 'error') p.serve.err++;
      });
    }
    const won = winner === 'us' ? 1 : 0;
    eachTeam(t => {
      const c = rally.weServe ? t.brk : t.sideout;
      c.n++; c.won += won;
      if (rally.rec) { t.afterRec[rally.rec].n++; t.afterRec[rally.rec].won += won; }
      const r = (t.rot[rally.rot] ??= { so: counter(), brk: counter(), us: 0, them: 0 });
      const rc = rally.weServe ? r.brk : r.so;
      rc.n++; rc.won += won;
      r[winner]++;
      if (!withStats) t.noStats++;
    });
    for (const pl of rally.plays) pl.won = winner === 'us';
    set[winner]++;
    set.flow.push(winner);
    // Переход подачи: выиграли на чужой подаче — переход и подаёт следующий по порядку.
    if (winner === 'us' && set.serving === 'them') { set.srv = (set.srv + 1) % 6; set.serving = 'us'; }
    if (winner === 'them') set.serving = 'them';
    set.over = isSetOver(set);
    newRally();
  };

  // Запись «розыгрыш по касаниям» с контекстом — из неё дашборд строит тепловые карты и отчёты связующего.
  const addPlay = (ev, i) => {
    const pl = {
      i, set: set.n, rally: rally.no, skill: ev.skill, res: ev.res, p: ev.p ?? null,
      from: ev.from ?? null, to: ev.to ?? null, v: ev.v ?? null, vt: ev.vt ?? null, opp: ev.opp ?? null, // opp — номер игрока соперника (скаутинг)
      rot: rally.rot, weServe: rally.weServe, score: [set.us, set.them], zone: zoneOfPlayer(ev.p), won: null,
    };
    if (ev.skill === 'serve' && !pl.p) pl.p = rally.server;
    plays.push(pl);
    rally.plays.push(pl);
    return pl;
  };

  const applyAct = (ev, pl) => {
    switch (ev.skill) {
      case 'serve': rally.serveRes = ev.res; break; // сама подача считается в endRally
      case 'rec':
        rally.rec = ev.res;
        eachPlayer(ev.p, p => { p.rec.tot++; p.rec[ev.res === 'error' ? 'err' : ev.res]++; });
        if (ev.res !== 'error' && ev.res !== 'over') rally.poss = { type: 'rec', q: ev.res, set: null };
        break;
      case 'set': {
        const key = ev.res === 'error' ? 'err' : ev.res;
        eachPlayer(ev.p, p => { p.set.tot++; p.set[key]++; });
        rally.poss ??= { type: 'trans', q: null, set: null };
        Object.assign(pl, { poss: rally.poss.type, recQ: rally.poss.q, tempo: ev.tempo ?? null, h: ev.h ?? null, target: null, attRes: null, dir: null });
        rally.poss.set = pl;
        break;
      }
      case 'att': {
        const key = { kill: 'kill', bo: 'bo', error: 'err', blocked: 'blk' }[ev.res];
        eachPlayer(ev.p, p => { p.att.tot++; if (key) p.att[key]++; });
        rally.poss ??= { type: 'trans', q: null, set: null };
        const sp = rally.poss.set;
        // Связующий: из отмеченного паса, иначе — по схеме игры среди отмеченных «связ.» на площадке.
        let setter = sp?.p ?? curSetter();
        // Атака самого связующего без паса перед ней — это скидка (вторым касанием).
        const dump = !sp && setters.has(ev.p) && setter === ev.p;
        if (setter === ev.p && !dump) setter = null;
        Object.assign(pl, { poss: rally.poss.type, recQ: rally.poss.q, setter, tempo: sp?.tempo ?? null, dump });
        if (sp) {
          sp.target = ev.p;
          sp.attRes = ev.res;
          sp.dir = setDir(sp.to, zoneOfPlayer(ev.p));
        }
        if (!dump) {
          eachTeam(t => {
            const l = (t.links[`${setter}>${ev.p}`] ??= { setter, attacker: ev.p, tot: 0, kill: 0, err: 0 });
            l.tot++;
            if (ev.res === 'kill' || ev.res === 'bo') l.kill++;
            if (ev.res === 'error' || ev.res === 'blocked') l.err++;
          });
        }
        // Пас без отметки: дописываем «виртуальный» пас, чтобы распределение связующего считалось и без кликов.
        if (!sp && setter && !dump) {
          plays.push({
            i: pl.i, set: set.n, rally: rally.no, skill: 'set', res: null, p: setter, virtual: true, from: null, to: null, v: null, vt: null,
            rot: rally.rot, weServe: rally.weServe, score: pl.score, zone: zoneOfPlayer(setter), won: null,
            poss: rally.poss.type, recQ: rally.poss.q, tempo: null, target: ev.p, attRes: ev.res, dir: setDir(null, zoneOfPlayer(ev.p)),
          });
          rally.plays.push(plays.at(-1));
        }
        if (dump) pl.dir = 'dump';
        break;
      }
      case 'blk': eachPlayer(ev.p, p => p.blk[ev.res]++); break;
      case 'dig':
        eachPlayer(ev.p, p => { p.dig.tot++; p.dig[ev.res === 'error' ? 'err' : ev.res]++; });
        if (ev.res !== 'error' && ev.res !== 'over') rally.poss = { type: 'trans', q: ev.res, set: null };
        break;
      case 'fault': eachPlayer(ev.p, p => p.fault++); break;
      case 'team':
        if (ev.res === 'oppAce') rally.rec = 'error';
        if (ev.res === 'back') rally.poss = { type: 'trans', q: null, set: null };
        if (ACTIONS.team[ev.res]) eachTeam(t => t[ev.res]++); // over/back в статистику не идут
        break;
    }
    const next = NEXT_PHASE[`${ev.skill}.${ev.res}`];
    if (next === 'their') rally.poss = null;
    rally.phase = next ?? rally.phase;
    // Атака на чужой подаче, когда приём не отмечен: мяч был у нас, значит, приём состоялся.
    if (rally.phase === 'ours' && !rally.poss && ev.skill !== 'team') rally.poss = { type: 'trans', q: null, set: null };
  };

  const score = () => `${set.us}:${set.them}`;

  match.events.forEach((ev, i) => {
    if (ev.t === 'set') {
      // Новая партия — только после окончания предыдущей и пока матч не выигран.
      if ((set && !set.over) || isMatchOver(countSetsWon(sets), fmt)) return;
      const main = ev.setter && ev.lineup.includes(ev.setter) ? ev.setter : ev.lineup.find(id => setters.has(id)) ?? null;
      set = {
        n: sets.length, us: 0, them: 0, lineup: [...ev.lineup], start: [...ev.lineup],
        serving: ev.weServe ? 'us' : 'them', srv: ev.weServe ? 0 : -1, over: false,
        main, mainSlot: main ? ev.lineup.indexOf(main) : -1, flow: [], startIdx: i,
        target: ev.target || setTarget(sets.length, fmt),
      };
      sets.push(set);
      newRally();
      log.push({ i, text: `Партия ${set.n + 1} началась` });
      return;
    }
    if (!set || set.over) return;
    if (ev.t === 'sub') {
      const k = set.lineup.indexOf(ev.out);
      if (k >= 0) set.lineup[k] = ev.in;
      if (rally.acts === 0 && rally.weServe) rally.server = set.lineup[set.srv];
      log.push({ i, text: `Замена: ${playerName(match, ev.in)} вместо ${playerName(match, ev.out)}` });
      return;
    }
    // Тайм-аут: метка в партии (счёт и номер розыгрыша) — для анализа «до и после тайм-аута».
    if (ev.t === 'timeout') {
      (set.timeouts ??= []).push({ side: ev.side, i, at: set.flow.length, score: [set.us, set.them] });
      log.push({ i, text: `Тайм-аут ${ev.side === 'us' ? 'наш' : 'соперника'} · ${score()}`, timeout: ev.side });
      return;
    }
    if (ev.t === 'pt') {
      endRally(ev.side, false);
      log.push({ i, side: ev.side, text: `Очко ${ev.side === 'us' ? 'нам' : 'им'} (без статистики) · ${score()}` });
      return;
    }
    if (ev.t !== 'act') return;
    const outcome = ACTIONS[ev.skill]?.[ev.res];
    if (outcome === undefined) return;
    if (ev.skill === 'serve' && !rally.weServe) return;
    const pl = addPlay(ev, i);
    applyAct(ev, pl);
    rally.acts++;
    const who = pl.p && ev.skill !== 'team' ? `${playerName(match, pl.p)} — ` : '';
    if (outcome) endRally(outcome, true);
    log.push({ i, side: outcome, text: `${who}${LABELS[ev.skill][ev.res]}${outcome ? ' · ' + score() : ''}` });
  });

  const setsWon = countSetsWon(sets);
  return { sets, set, rally, players, teams, log, plays, setsWon, matchOver: isMatchOver(setsWon, fmt), format: fmt };
}

export function playerName(match, id) {
  const p = match.roster.find(r => r.id === id);
  if (!p) return '?';
  return p.num ? `#${p.num} ${p.name}` : p.name;
}

export function totals(p) {
  const points = p.serve.ace + p.att.kill + p.att.bo + p.blk.point;
  const errors = p.serve.err + p.rec.err + p.att.err + p.att.blk + p.blk.out + p.fault + (p.set?.err || 0);
  return { points, errors, diff: points - errors };
}

// Эффективность атаки: (очки − ошибки − заблокированные) / все атаки.
export const attEff = a => (a.tot ? (a.kill + a.bo - a.err - a.blk) / a.tot : null);
// Средняя оценка приёма 0–3.
export const recRating = r => (r.tot ? (3 * r.pp + 2 * r.pm + r.p + 0.5 * (r.over || 0)) / r.tot : null);

// Складывает статистику (игрока, команды, нескольких матчей): числа суммируются, остальное копируется.
export function addStats(target, src) {
  for (const k in src) {
    if (typeof src[k] === 'number') target[k] = (target[k] || 0) + src[k];
    else if (src[k] && typeof src[k] === 'object') addStats((target[k] ??= {}), src[k]);
    else target[k] ??= src[k];
  }
  return target;
}

export const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '–');

export { zoneOf };

// Тайм-ауты: сколько розыгрышей выиграли сразу после (следующие n) и прервали ли серию соперника.
export function timeoutEffect(sets, side = 'us', n = 3) {
  const out = { count: 0, nextWon: 0, nextTot: 0, firstWon: 0, brokeRun: 0, runs: 0 };
  for (const s of sets) for (const t of s.timeouts ?? []) {
    if (t.side !== side) continue;
    out.count++;
    const next = s.flow.slice(t.at, t.at + n);
    out.nextTot += next.length; out.nextWon += next.filter(w => w === 'us').length;
    if (next[0] === 'us') out.firstWon++;
    // Серия соперника перед тайм-аутом (2+ подряд) — прервали ли её первым же розыгрышем.
    let run = 0; for (let k = t.at - 1; k >= 0 && s.flow[k] === 'them'; k--) run++;
    if (run >= 2) { out.runs++; if (next[0] === 'us') out.brokeRun++; }
  }
  return out;
}
