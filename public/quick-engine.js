// Быстрая статистика: фиксируем только, КТО закончил розыгрыш и ЧЕМ.
// Как и в детальном режиме, матч — список событий; счёт и статистика пересчитываются из него.
import { isSetOver, playerName, countSetsWon, isMatchOver, formatOf, setTarget } from './engine.js';

// side — кому очко; team — действие без игрока.
export const RESULTS = {
  kill: { side: 'us', label: 'Атака' },
  block: { side: 'us', label: 'Блок' },
  ace: { side: 'us', label: 'Эйс' },
  srvErr: { side: 'them', label: 'Ошибка подачи' },
  attErr: { side: 'them', label: 'Аут / сетка' },
  blocked: { side: 'them', label: 'Блок-аут' }, // атака ушла в блок соперника
  recErr: { side: 'them', label: 'Ошибка приёма' }, // не приняли подачу соперника
  digErr: { side: 'them', label: 'Ошибка в защите' }, // коснулись атакованного мяча, но не подняли
  fault: { side: 'them', label: 'Сетка / касания' },
  lost: { side: 'them', label: 'Потеря мяча' }, // мяч упал на нашей стороне по вине игрока (например, неточный пас)
  oppErr: { side: 'us', label: 'Ошибка соперника', team: true },
  oppKill: { side: 'them', label: 'Соперник забил', team: true },
};
// Раньше «Блок-аут» и «В блок» были разными кнопками; это одно и то же, старые записи считаем как blocked.
const LEGACY = { blockOut: 'blocked' };

export const PLAYER_POINTS = ['kill', 'block', 'ace'];
export const PLAYER_ERRORS = ['srvErr', 'attErr', 'blocked', 'recErr', 'digErr', 'fault', 'lost'];

export const newQuickPlayer = () => Object.fromEntries([...PLAYER_POINTS, ...PLAYER_ERRORS].map(k => [k, 0]));
export const newQuickTeam = () => ({ sideout: { n: 0, won: 0 }, brk: { n: 0, won: 0 }, oppErr: 0, oppKill: 0 });

export function replayQuick(match) {
  const sets = [], players = {}, teams = {}, log = [];
  const rallies = []; // { set, side, res, p, us, them } — для серий и хода партии
  let set = null;
  const fmt = formatOf(match);

  for (const ev of match.events) {
    if (ev.t === 'set') {
      // Новая партия — только после окончания предыдущей и пока матч не выигран.
      if ((set && !set.over) || isMatchOver(countSetsWon(sets), fmt)) continue;
      set = { n: sets.length, us: 0, them: 0, serving: ev.weServe ? 'us' : 'them', over: false, target: ev.target || setTarget(sets.length, fmt) };
      sets.push(set);
      log.push({ text: `Партия ${set.n + 1} началась` });
      continue;
    }
    if (!set || set.over || ev.t !== 'end') continue;
    let res = LEGACY[ev.res] ?? ev.res;
    // На своей подаче ошибки приёма подачи не бывает: раньше этой кнопкой отмечали и ошибку в защите.
    if (res === 'recErr' && set.serving === 'us') res = 'digErr';
    const r = RESULTS[res];
    if (!r) continue;

    for (const s of ['all', set.n]) {
      const t = (teams[s] ??= newQuickTeam());
      // Подавали мы — это «брейк», подавал соперник — «сайд-аут».
      const c = set.serving === 'us' ? t.brk : t.sideout;
      c.n++;
      if (r.side === 'us') c.won++;
      if (r.team) t[res]++;
      else ((players[s] ??= {})[ev.p] ??= newQuickPlayer())[res]++;
    }
    set[r.side]++;
    set.serving = r.side; // кто выиграл розыгрыш, тот и подаёт
    set.over = isSetOver(set);
    rallies.push({ set: set.n, side: r.side, res, p: ev.p, us: set.us, them: set.them });
    log.push({ side: r.side, text: `${r.team ? '' : playerName(match, ev.p) + ' — '}${r.label} · ${set.us}:${set.them}` });
  }

  const setsWon = countSetsWon(sets);
  return { sets, set, players, teams, log, rallies, setsWon, matchOver: isMatchOver(setsWon, fmt), format: fmt };
}

export function quickTotals(p) {
  const points = PLAYER_POINTS.reduce((a, k) => a + p[k], 0);
  const errors = PLAYER_ERRORS.reduce((a, k) => a + p[k], 0);
  return { points, errors, diff: points - errors };
}
