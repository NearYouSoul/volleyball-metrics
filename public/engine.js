// Вся логика матча. Матч хранится как список событий; счёт, подача и статистика
// каждый раз пересчитываются из этого списка — поэтому «отмена» = удалить последнее событие.
// Файл общий: его использует и телефон, и страница статистики, и сервер.

// Исход действия: 'us' — очко нам, 'them' — сопернику, null — розыгрыш продолжается.
export const ACTIONS = {
  serve: { ace: 'us', error: 'them' },
  rec: { pp: null, pm: null, p: null, error: 'them' },
  att: { kill: 'us', bo: 'us', play: null, error: 'them', blocked: 'them' },
  blk: { point: 'us', touch: null, out: 'them' },
  dig: { plus: null, minus: null, error: 'them' },
  fault: { error: 'them' },
  // over/back — статист вручную говорит, где мяч, без статистики игрока.
  team: { oppError: 'us', oppKill: 'them', oppAce: 'them', over: null, back: null },
};

// Где мяч после действия, если розыгрыш продолжается:
// 'ours' — мяч у нас (ждём атаку), 'their' — мяч у них (ждём защиту или блок).
const NEXT_PHASE = {
  'rec.pp': 'ours', 'rec.pm': 'ours', 'rec.p': 'ours',
  'att.play': 'their', 'blk.touch': 'their',
  'dig.plus': 'ours', 'dig.minus': 'ours',
  'team.over': 'their', 'team.back': 'ours',
};

export const LABELS = {
  serve: { ace: 'Эйс', error: 'Ошибка подачи' },
  rec: { pp: 'Приём ++', pm: 'Приём +−', p: 'Приём +', error: 'Ошибка приёма' },
  att: { kill: 'Атака: забил', bo: 'Атака: блок-аут', play: 'Атака в игру', error: 'Атака: аут/сетка', blocked: 'Атака: заблокирован' },
  blk: { point: 'Блок: очко', touch: 'Блок: касание', out: 'Блок: блок-аут' },
  dig: { plus: 'Защита +', minus: 'Защита −', error: 'Защита: не поднял' },
  fault: { error: 'Ошибка (сетка/заступ/касания)' },
  team: { oppError: 'Ошибка соперника', oppKill: 'Соперник забил', oppAce: 'Эйс соперника', over: 'Мяч ушёл к ним', back: 'Мяч у нас' },
};

const counter = () => ({ n: 0, won: 0 });

export const newPlayer = () => ({
  serve: { tot: 0, ace: 0, err: 0 },
  rec: { tot: 0, pp: 0, pm: 0, p: 0, err: 0 },
  att: { tot: 0, kill: 0, bo: 0, err: 0, blk: 0 },
  blk: { point: 0, touch: 0, out: 0 },
  dig: { tot: 0, plus: 0, minus: 0, err: 0 },
  fault: 0,
});

const newTeam = () => ({
  sideout: counter(), // подавал соперник: как часто мы выигрываем розыгрыш
  brk: counter(), // подавали мы: как часто выигрываем розыгрыш
  afterRec: { pp: counter(), pm: counter(), p: counter(), error: counter() },
  oppError: 0, oppKill: 0, oppAce: 0,
  noStats: 0, // очки, внесённые без статистики
  links: {}, // связка «связующий > нападающий»
});

// Формат турнира: матч до двух побед в партиях (максимум 2:1), решающая третья партия — тай-брейк до 15.
export const SETS_TO_WIN = 2;
// n — номер партии с нуля.
export const setTarget = n => (n === SETS_TO_WIN * 2 - 2 ? 15 : 25);
export const isSetOver = s => Math.max(s.us, s.them) >= setTarget(s.n) && Math.abs(s.us - s.them) >= 2;
export function countSetsWon(sets) {
  const won = side => sets.filter(s => s.over && (side === 'us' ? s.us > s.them : s.them > s.us)).length;
  return { us: won('us'), them: won('them') };
}
export const isMatchOver = setsWon => Math.max(setsWon.us, setsWon.them) >= SETS_TO_WIN;

export function replay(match) {
  const setters = new Set(match.roster.filter(p => p.setter).map(p => p.id));
  const players = {}, teams = {}, sets = [], log = [];
  let set = null, rally = null;

  const scopes = () => ['all', set.n];
  const player = (s, id) => ((players[s] ??= {})[id] ??= newPlayer());
  const team = s => (teams[s] ??= newTeam());
  const eachPlayer = (id, fn) => scopes().forEach(s => fn(player(s, id)));
  const eachTeam = fn => scopes().forEach(s => fn(team(s)));

  const newRally = () => {
    const weServe = set.serving === 'us';
    // phase: 'serve' — подаём мы, 'rec' — подают они, дальше 'ours' / 'their' (см. NEXT_PHASE).
    rally = { weServe, server: weServe ? set.lineup[set.srv] : null, serveRes: null, rec: null, acts: 0, phase: weServe ? 'serve' : 'rec' };
  };

  const endRally = (winner, withStats) => {
    // Подача в игру считается сама: каждый наш розыгрыш на своей подаче — это подача.
    if (withStats && rally.weServe) {
      eachPlayer(rally.server, p => {
        p.serve.tot++;
        if (rally.serveRes === 'ace') p.serve.ace++;
        if (rally.serveRes === 'error') p.serve.err++;
      });
    }
    const won = winner === 'us' ? 1 : 0;
    eachTeam(t => {
      const c = rally.weServe ? t.brk : t.sideout;
      c.n++; c.won += won;
      if (rally.rec) { t.afterRec[rally.rec].n++; t.afterRec[rally.rec].won += won; }
      if (!withStats) t.noStats++;
    });
    set[winner]++;
    // Переход подачи: выиграли на чужой подаче — переход и подаёт следующий по порядку.
    if (winner === 'us' && set.serving === 'them') { set.srv = (set.srv + 1) % 6; set.serving = 'us'; }
    if (winner === 'them') set.serving = 'them';
    set.over = isSetOver(set);
    newRally();
  };

  const applyAct = ev => {
    switch (ev.skill) {
      case 'serve': rally.serveRes = ev.res; break; // сама подача считается в endRally
      case 'rec':
        rally.rec = ev.res;
        eachPlayer(ev.p, p => { p.rec.tot++; p.rec[ev.res === 'error' ? 'err' : ev.res]++; });
        break;
      case 'att': {
        const key = { kill: 'kill', bo: 'bo', error: 'err', blocked: 'blk' }[ev.res];
        eachPlayer(ev.p, p => { p.att.tot++; if (key) p.att[key]++; });
        // Связующий не вводится руками: берём того, кто отмечен связующим и стоит на площадке.
        const setter = set.lineup.find(id => setters.has(id) && id !== ev.p) ?? null;
        eachTeam(t => {
          const l = (t.links[`${setter}>${ev.p}`] ??= { setter, attacker: ev.p, tot: 0, kill: 0, err: 0 });
          l.tot++;
          if (ev.res === 'kill' || ev.res === 'bo') l.kill++;
          if (ev.res === 'error' || ev.res === 'blocked') l.err++;
        });
        break;
      }
      case 'blk': eachPlayer(ev.p, p => p.blk[ev.res]++); break;
      case 'dig':
        eachPlayer(ev.p, p => { p.dig.tot++; p.dig[ev.res === 'error' ? 'err' : ev.res]++; });
        break;
      case 'fault': eachPlayer(ev.p, p => p.fault++); break;
      case 'team':
        if (ev.res === 'oppAce') rally.rec = 'error';
        if (ACTIONS.team[ev.res]) eachTeam(t => t[ev.res]++); // over/back в статистику не идут
        break;
    }
    rally.phase = NEXT_PHASE[`${ev.skill}.${ev.res}`] ?? rally.phase;
  };

  const score = () => `${set.us}:${set.them}`;

  match.events.forEach((ev, i) => {
    if (ev.t === 'set') {
      // Новая партия — только после окончания предыдущей и пока матч не выигран.
      if ((set && !set.over) || isMatchOver(countSetsWon(sets))) return;
      set = {
        n: sets.length, us: 0, them: 0, lineup: [...ev.lineup], start: [...ev.lineup],
        serving: ev.weServe ? 'us' : 'them', srv: ev.weServe ? 0 : -1, over: false,
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
    if (ev.t === 'pt') {
      endRally(ev.side, false);
      log.push({ i, side: ev.side, text: `Очко ${ev.side === 'us' ? 'нам' : 'им'} (без статистики) · ${score()}` });
      return;
    }
    if (ev.t !== 'act') return;
    const outcome = ACTIONS[ev.skill]?.[ev.res];
    if (outcome === undefined) return;
    if (ev.skill === 'serve' && !rally.weServe) return;
    applyAct(ev);
    rally.acts++;
    const who = ev.p ? `${playerName(match, ev.p)} — ` : '';
    if (outcome) endRally(outcome, true);
    log.push({ i, side: outcome, text: `${who}${LABELS[ev.skill][ev.res]}${outcome ? ' · ' + score() : ''}` });
  });

  const setsWon = countSetsWon(sets);
  return { sets, set, rally, players, teams, log, setsWon, matchOver: isMatchOver(setsWon) };
}

export function playerName(match, id) {
  const p = match.roster.find(r => r.id === id);
  if (!p) return '?';
  return p.num ? `#${p.num} ${p.name}` : p.name;
}

export function totals(p) {
  const points = p.serve.ace + p.att.kill + p.att.bo + p.blk.point;
  const errors = p.serve.err + p.rec.err + p.att.err + p.att.blk + p.blk.out + p.fault;
  return { points, errors, diff: points - errors };
}

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
