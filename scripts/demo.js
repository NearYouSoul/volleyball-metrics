// Демо-данные: команда, соперники и два правдоподобных матча детальной статистики
// с точками на площадке, пасами и темпами — чтобы посмотреть студию и дашборд без настоящей игры.
//   node scripts/demo.js            — в папку data/ (существующие файлы НЕ трогает, если там уже есть состав)
//   DATA_DIR=/tmp/x node scripts/demo.js --force
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay } from '../public/engine.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const force = process.argv.includes('--force');

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (arr, w) => {
  if (!w) return arr[Math.floor(rnd() * arr.length)];
  let r = rnd() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < arr.length; i++) if ((r -= w[i]) < 0) return arr[i];
  return arr.at(-1);
};
const jitter = (p, s = 0.9) => ({ x: +(p.x + (rnd() - 0.5) * 2 * s).toFixed(2), y: +(p.y + (rnd() - 0.5) * 2 * s).toFixed(2) });

const roster = [
  { id: 'p01', num: 7, name: 'Андрей', setter: true },
  { id: 'p02', num: 11, name: 'Максим', setter: false },
  { id: 'p03', num: 3, name: 'Илья', setter: false },
  { id: 'p04', num: 14, name: 'Дима', setter: false },
  { id: 'p05', num: 9, name: 'Саша', setter: false },
  { id: 'p06', num: 5, name: 'Костя', setter: false },
  { id: 'p07', num: 1, name: 'Женя', setter: true },
  { id: 'p08', num: 18, name: 'Рома', setter: false },
];
const opponents = [{ id: 'o1', name: 'Буревестник' }, { id: 'o2', name: 'Северные' }, { id: 'o3', name: 'Тайфун' }];
// Порядок подачи: связующий 7, доигровщик 11, центр 3, диагональ 14, доигровщик 9, центр 5.
const lineup = ['p01', 'p02', 'p03', 'p04', 'p05', 'p06'];

// Куда обычно отдаёт пас связующий и куда бьют нападающие (точки — на их половине).
const SET_SPOTS = { 4: { x: 0.9, y: 8.1 }, 3: { x: 4.2, y: 8.6 }, 2: { x: 8.1, y: 8.2 }, pipe: { x: 4.5, y: 5.6 }, 1: { x: 7.6, y: 5.4 } };
const ATT_TARGETS = [{ x: 1.5, y: 16.5 }, { x: 7.5, y: 16.5 }, { x: 4.5, y: 14 }, { x: 2, y: 11 }, { x: 7.8, y: 12.5 }, { x: 4.5, y: 17.2 }];

function simulate(opponentId, created, video, strength) {
  const match = { id: created.getTime().toString(36), opponentId, opponent: opponents.find(o => o.id === opponentId).name, created: created.toISOString(), roster, system: '5-1', videos: video ? [video] : [], events: [] };
  let vt = 30;
  const push = ev => { vt += 1.5 + rnd() * 3; if (video) { ev.v = video; ev.vt = +vt.toFixed(2); } match.events.push(ev); };
  for (let s = 0; s < 3; s++) {
    let st = replay(match);
    if (st.matchOver) break;
    vt += 60;
    push({ t: 'set', lineup, weServe: s % 2 === 0, setter: 'p01' });
    for (let guard = 0; guard < 400; guard++) {
      st = replay(match);
      if (!st.set || st.set.over) break;
      const r = st.rally, ids = st.set.lineup, zones = r.zones;
      const at = z => ids[zones.indexOf(z)];
      vt += 6 + rnd() * 10;
      if (r.phase === 'serve') {
        const res = pick(['ace', 'good', 'in', 'error'], [0.07, 0.25, 0.58, 0.1]);
        push({ t: 'act', skill: 'serve', res, p: r.server, to: jitter(pick([{ x: 1.5, y: 16 }, { x: 7.5, y: 16 }, { x: 4.5, y: 15 }]), 1.3) });
        if (res === 'ace' || res === 'error') continue;
        // Соперник атакует → мы защищаемся или нет.
        const def = pick(['dig', 'kill', 'oppError', 'blk'], [0.48, 0.32 - strength * 0.05, 0.12, 0.08]);
        if (def === 'kill') { push({ t: 'act', skill: 'team', res: 'oppKill', p: null }); continue; }
        if (def === 'oppError') { push({ t: 'act', skill: 'team', res: 'oppError', p: null }); continue; }
        if (def === 'blk') { push({ t: 'act', skill: 'blk', res: pick(['point', 'out'], [0.6, 0.4]), p: at(pick([2, 3, 4])) }); continue; }
        const digger = at(pick([1, 6, 5, 4]));
        const dres = pick(['plus', 'minus', 'error'], [0.5, 0.3, 0.2]);
        push({ t: 'act', skill: 'dig', res: dres, p: digger, to: jitter({ x: 1 + rnd() * 7, y: 1 + rnd() * 5 }, 0.5) });
        if (dres === 'error') continue;
      } else if (r.phase === 'rec') {
        const recv = at(pick([5, 6, 1, 4], [0.32, 0.36, 0.22, 0.1]));
        const res = pick(['pp', 'pm', 'p', 'over', 'error'], [0.3 + strength * 0.05, 0.32, 0.2, 0.06, 0.07]);
        const spot = { 5: { x: 1.7, y: 2.4 }, 6: { x: 4.5, y: 2.6 }, 1: { x: 7.3, y: 2.4 }, 4: { x: 1.5, y: 5 } }[zones[ids.indexOf(recv)]] || { x: 4.5, y: 3 };
        push({ t: 'act', skill: 'rec', res, p: recv, to: jitter(spot, 1.1) });
        if (res === 'error' || res === 'over') {
          if (res === 'over') push({ t: 'act', skill: 'team', res: pick(['oppKill', 'oppError'], [0.7, 0.3]), p: null });
          continue;
        }
      } else if (r.phase === 'their') {
        push({ t: 'act', skill: 'team', res: pick(['oppKill', 'oppError', 'back'], [0.3, 0.2, 0.5]), p: null });
        continue;
      }
      // Мяч у нас: пас и атака.
      st = replay(match);
      if (!st.set || st.set.over) continue;
      const lastQ = st.rally.poss?.q ?? 'p';
      const front = [4, 3, 2].map(z => st.set.lineup[st.rally.zones.indexOf(z)]).filter(id => id !== 'p01');
      // Плохой приём — чаще высокий пас на край; хороший — комбинация.
      const dirs = lastQ === 'pp' ? ['4', '3', '2', 'pipe'] : ['4', '2', '3', 'pipe'];
      const w = lastQ === 'pp' ? [0.32, 0.3, 0.26, 0.12] : lastQ === 'pm' ? [0.48, 0.28, 0.14, 0.1] : [0.62, 0.3, 0.04, 0.04];
      const dir = pick(dirs, w);
      const zoneOfDir = dir === 'pipe' ? 6 : Number(dir);
      let attacker = st.set.lineup[st.rally.zones.indexOf(zoneOfDir)];
      if (attacker === 'p01' || !attacker) attacker = pick(front);
      const tempo = dir === '3' ? 'q' : dir === 'pipe' ? 'f' : lastQ === 'pp' ? pick(['f', 'h'], [0.6, 0.4]) : 'h';
      const sres = pick(['perfect', 'good', 'poor', 'error'], [0.35, 0.45, 0.17, 0.03]);
      // Иногда связующий скидывает сам — вторым касанием.
      if (lastQ === 'pp' && rnd() < 0.06 && st.rally.zones[st.set.lineup.indexOf('p01')] <= 4 && st.rally.zones[st.set.lineup.indexOf('p01')] >= 2) {
        push({ t: 'act', skill: 'att', res: pick(['kill', 'play', 'error'], [0.6, 0.3, 0.1]), p: 'p01', to: jitter({ x: 5, y: 11 }, 1) });
        continue;
      }
      const setter = st.set.lineup.includes('p01') ? 'p01' : 'p07';
      push({ t: 'act', skill: 'set', res: sres, p: setter, tempo, to: jitter(SET_SPOTS[dir], 0.45), from: jitter({ x: 6, y: 8 }, 0.6) });
      if (sres === 'error') continue;
      const kp = (sres === 'perfect' ? 0.55 : sres === 'good' ? 0.45 : 0.3) + strength * 0.04 + (tempo === 'q' ? 0.06 : 0);
      const ares = pick(['kill', 'bo', 'play', 'error', 'blocked'], [kp, 0.07, 0.62 - kp, 0.12, 0.1]);
      push({ t: 'act', skill: 'att', res: ares, p: attacker, to: jitter(pick(ATT_TARGETS), 1.2) });
      if (ares === 'play') push({ t: 'act', skill: 'team', res: pick(['oppKill', 'oppError'], [0.6, 0.4]), p: null });
    }
  }
  return match;
}

const roster_file = path.join(DATA, 'roster.json');
await mkdir(DATA, { recursive: true });
const exists = await access(roster_file).then(() => true, () => false);
if (exists && !force) {
  console.log(`В ${DATA} уже есть состав. Чтобы не испортить настоящие данные, демо не записано.\nЗапустите с --force или укажите другую папку: DATA_DIR=demo-data node scripts/demo.js`);
  process.exit(0);
}
await writeFile(roster_file, JSON.stringify(roster, null, 1));
await writeFile(path.join(DATA, 'settings.json'), JSON.stringify({ teamName: 'Звезда', opponents, system: '5-1' }, null, 1));
const now = Date.now();
const m1 = simulate('o1', new Date(now - 864e5 * 2), null, 1);
seed = 99;
const m2 = simulate('o2', new Date(now - 864e5), null, -3);
for (const m of [m1, m2]) await writeFile(path.join(DATA, `match-${m.id}.json`), JSON.stringify(m, null, 1));
for (const m of [m1, m2]) { const st = replay(m); console.log(`${m.opponent}: ${st.setsWon.us}:${st.setsWon.them} (${st.sets.map(s => `${s.us}:${s.them}`).join(', ')}), событий ${m.events.length}`); }
