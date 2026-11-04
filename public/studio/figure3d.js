// Фигура игрока на 3D-площадке: «простая» (минималистичный человечек из примитивов)
// и «реалистичная» (анатомические пропорции, цельные руки, ноги и корпус на скелете — колени и локти
// гнутся плавно, кисти с пальцами, лицо, волосы, кроссовки). Обе фигуры — с одинаковыми суставами,
// поэтому движения (motion.js) одни и те же. Фигура смотрит на сетку (−Z), стоит на полу (y = 0).
import * as THREE from 'three';
import { monotone, legDrop } from './motion.js';

export const THIGH = 0.44, SHIN = 0.48; // от тазобедренного до колена, от колена до подошвы
export const LEG = THIGH + SHIN;
const HIP_Y = 0.06; // таз над тазобедренными суставами

// Номер на майке — чуть изогнутая пластина по форме корпуса (rx, rz — полуоси корпуса на этой высоте).
function numGeo(w, rx, rz) {
  const g = new THREE.PlaneGeometry(w, w, 8, 1), pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setZ(i, rz * Math.sqrt(Math.max(0, 1 - (pos.getX(i) / rx) ** 2)) + 0.006);
  g.computeVertexNormals();
  return g;
}

const shadowed = o => { o.castShadow = true; return o; };
const mesh = (geo, mat, parent, x = 0, y = 0, z = 0) => { const m = shadowed(new THREE.Mesh(geo, mat)); m.position.set(x, y, z); parent.add(m); return m; };
const anchor = (parent, x, y, z) => { const o = new THREE.Object3D(); o.position.set(x, y, z); parent.add(o); return o; };

// ---------------------------------------------------------------- простая фигура
let SG = null;
function simpleGeos() {
  return SG ??= {
    thigh: new THREE.CapsuleGeometry(0.088, 0.3, 4, 12), shin: new THREE.CapsuleGeometry(0.066, 0.3, 4, 12),
    pad: new THREE.CylinderGeometry(0.094, 0.094, 0.13, 16), sock: new THREE.CylinderGeometry(0.07, 0.064, 0.16, 14),
    shoe: new THREE.CapsuleGeometry(0.058, 0.15, 4, 10), sole: new THREE.BoxGeometry(0.1, 0.018, 0.25),
    delt: new THREE.SphereGeometry(0.074, 14, 10),
    shorts: new THREE.CylinderGeometry(0.205, 0.195, 0.24, 18), torso: new THREE.CapsuleGeometry(0.17, 0.34, 6, 18),
    neck: new THREE.CylinderGeometry(0.05, 0.056, 0.1, 12), head: new THREE.SphereGeometry(0.108, 22, 16),
    hair: new THREE.SphereGeometry(0.114, 22, 12, 0, Math.PI * 2, 0, Math.PI * 0.52),
    upper: new THREE.CapsuleGeometry(0.05, 0.19, 4, 10), sleeve: new THREE.CylinderGeometry(0.072, 0.064, 0.15, 14),
    fore: new THREE.CapsuleGeometry(0.043, 0.19, 4, 10), hand: new THREE.SphereGeometry(0.05, 12, 10),
    back: numGeo(0.22, 0.2, 0.124), front: numGeo(0.13, 0.2, 0.124),
  };
}

function buildSimple(root, { M, jersey, numMat }) {
  const G = simpleGeos();
  const joint = (parent, x = 0, y = 0, z = 0) => { const j = new THREE.Group(); j.position.set(x, y, z); parent.add(j); return j; };
  const fig = joint(root);
  const hips = joint(fig, 0, HIP_Y + LEG, 0);
  mesh(G.shorts, M.shorts, hips, 0, 0.0, 0).scale.set(1, 1, 0.82);
  const leg = side => {
    const hip = joint(hips, side * 0.1, -HIP_Y, 0);
    mesh(G.thigh, M.skin, hip, 0, -THIGH / 2, 0);
    const knee = joint(hip, 0, -THIGH, 0);
    mesh(G.pad, M.pad, knee, 0, -0.01, -0.01).scale.set(1, 1, 0.95);
    mesh(G.shin, M.skin, knee, 0, -0.2, 0);
    mesh(G.sock, M.sock, knee, 0, -0.33, 0);
    const ankle = joint(knee, 0, -SHIN + 0.06, 0);
    const shoe = mesh(G.shoe, M.shoe, ankle, 0, -0.01, -0.045); shoe.rotation.x = Math.PI / 2; shoe.scale.set(1, 1, 0.8);
    mesh(G.sole, M.sole, ankle, 0, -0.052, -0.045);
    return { hip, knee, ankle };
  };
  const legL = leg(-1), legR = leg(1);
  const torso = joint(hips, 0, 0.08, 0);
  const chest = mesh(G.torso, jersey, torso, 0, 0.27, 0); chest.scale.set(1.18, 1, 0.73);
  mesh(G.neck, M.skin, torso, 0, 0.66, 0);
  const head = joint(torso, 0, 0.79, 0);
  mesh(G.head, M.skin, head);
  const hair = mesh(G.hair, M.hair, head, 0, 0.012, 0.008); hair.rotation.x = -0.25;
  if (numMat) {
    const back = new THREE.Mesh(G.back, numMat); back.position.y = 0.33; torso.add(back);
    const front = new THREE.Mesh(G.front, numMat); front.position.set(0, 0.4, 0); front.rotation.y = Math.PI; torso.add(front);
  }
  const arm = side => {
    const sh = joint(torso, side * 0.235, 0.5, 0);
    mesh(G.upper, M.skin, sh, 0, -0.14, 0);
    mesh(G.sleeve, jersey, sh, 0, -0.07, 0);
    mesh(G.delt, jersey, sh, 0, -0.01, 0).scale.set(1, 1.1, 1);
    const el = joint(sh, 0, -0.29, 0);
    mesh(G.fore, M.skin, el, 0, -0.13, 0);
    mesh(G.hand, M.skin, el, 0, -0.29, 0).scale.set(0.8, 1.15, 0.55);
    return { sh, el, wrist: anchor(el, 0, -0.25, 0), palm: anchor(el, 0, -0.29, 0) };
  };
  const armL = arm(-1), armR = arm(1);
  return { fig, hips, torso, head, legL, legR, armL, armR, fingers: null, arm: 0.6 };
}

// ---------------------------------------------------------------- реалистичная фигура
// Цельные части тела — «трубки» с переменным сечением (эллипс), привязанные к костям с плавными весами.
// Координаты — в стойке «смирно», в метрах от пола.
const BONES = ['hips', 'torso', 'head', 'hipL', 'kneeL', 'ankleL', 'hipR', 'kneeR', 'ankleR', 'shL', 'elL', 'shR', 'elR'];
const B = Object.fromEntries(BONES.map((n, i) => [n, i]));
const R = {
  hipX: 0.095, kneeY: 0.48, ankleY: 0.06, hipsY: HIP_Y + LEG,
  torsoY: HIP_Y + LEG + 0.08, shX: 0.205, shY: HIP_Y + LEG + 0.08 + 0.5, upper: 0.31, fore: 0.26, headY: HIP_Y + LEG + 0.08 + 0.79,
};
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Профиль: [[y, rx, rz, ox, oz], …] сверху вниз → функция y → сечение (монотонная кривая между точками).
function profile(rows) {
  const asc = [...rows].sort((a, b) => a[0] - b[0]);
  const ys = asc.map(r => r[0]);
  const col = k => asc.map(r => r[k] ?? 0);
  const c = [1, 2, 3, 4].map(col);
  return y => c.map(v => monotone(ys, v, y));
}

class SkinBuilder {
  constructor() { this.pos = []; this.idx = []; this.si = []; this.sw = []; }
  vert(x, y, z, w) {
    this.pos.push(x, y, z);
    const s = [...w].sort((a, b) => b[1] - a[1]).slice(0, 2);
    const sum = s.reduce((a, b) => a + b[1], 0) || 1;
    this.si.push(s[0]?.[0] ?? 0, s[1]?.[0] ?? 0, 0, 0);
    this.sw.push((s[0]?.[1] ?? 1) / sum, (s[1]?.[1] ?? 0) / sum, 0, 0);
    return this.pos.length / 3 - 1;
  }
  // Трубка вдоль вертикали: центр (cx, cz), от yTop до yBot. prof(y) → [rx, rz, ox, oz]; w(y) → [[кость, вес], …].
  tube({ cx = 0, cz = 0, yTop, yBot, rings = 24, rad = 16, prof, w, mirror = 1, capTop = false, capBot = false }) {
    const start = this.pos.length / 3;
    for (let r = 0; r <= rings; r++) {
      const y = yTop + (yBot - yTop) * (r / rings);
      const [rx, rz, ox, oz] = prof(y), ww = w(y);
      for (let k = 0; k < rad; k++) {
        const a = (k / rad) * Math.PI * 2;
        this.vert(cx + ox * mirror + Math.cos(a) * rx, y, cz + oz + Math.sin(a) * rz, ww);
      }
    }
    for (let r = 0; r < rings; r++) for (let k = 0; k < rad; k++) {
      const a = start + r * rad + k, b = start + r * rad + ((k + 1) % rad), c = a + rad, d = b + rad;
      this.idx.push(a, c, b, b, c, d);
    }
    const cap = (ring, y, top) => {
      const [, , ox, oz] = prof(y);
      const c = this.vert(cx + ox * mirror, y + (top ? 0.004 : -0.004), cz + oz, w(y));
      for (let k = 0; k < rad; k++) {
        const a = start + ring * rad + k, b = start + ring * rad + ((k + 1) % rad);
        if (top) this.idx.push(c, a, b); else this.idx.push(c, b, a);
      }
    };
    if (capTop) cap(0, yTop, true);
    if (capBot) cap(rings, yBot, false);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

// Вес между двумя костями: выше y1 — первая, ниже y0 — вторая, между — плавно.
const blend = (upper, lower, y1, y0) => y => { const t = smooth(y1, y0, y); return [[upper, 1 - t], [lower, t]]; };

let RG = null;
function realGeos() {
  if (RG) return RG;
  // Нога: бедро с рельефом квадрицепса, колено с чашечкой, икра сзади, тонкая лодыжка.
  const legProf = profile([
    [1.0, 0.096, 0.098, 0, 0], [0.86, 0.09, 0.094, 0, -0.006], [0.74, 0.08, 0.084, 0, -0.01], [0.62, 0.064, 0.068, 0, -0.006],
    [0.54, 0.054, 0.058, 0, -0.004], [0.49, 0.052, 0.058, 0, -0.012], [0.44, 0.05, 0.052, 0, 0.002], [0.37, 0.054, 0.06, 0, 0.013],
    [0.29, 0.048, 0.052, 0, 0.009], [0.2, 0.036, 0.038, 0, 0.003], [0.1, 0.03, 0.032, 0, 0],
  ]);
  // Рука: дельта, бицепс спереди, локоть, предплечье, плоское запястье.
  const top = R.shY;
  const armProf = profile([
    [top + 0.085, 0.018, 0.018, 0.004, 0], [top + 0.07, 0.05, 0.052, 0.008, 0], [top + 0.035, 0.068, 0.07, 0.01, 0], [top - 0.04, 0.06, 0.064, 0.006, 0],
    [top - 0.12, 0.05, 0.056, 0, -0.006], [top - 0.22, 0.044, 0.048, 0, -0.004], [top - 0.3, 0.038, 0.04, 0, 0],
    [top - 0.37, 0.043, 0.046, 0, 0], [top - 0.46, 0.035, 0.032, 0, 0], [top - 0.56, 0.026, 0.02, 0, 0],
  ]);
  const elY = top - R.upper;
  const skin = new SkinBuilder();
  for (const [side, hip, knee] of [[-1, B.hipL, B.kneeL], [1, B.hipR, B.kneeR]]) {
    skin.tube({ cx: side * R.hipX, yTop: 1.0, yBot: 0.1, rings: 34, prof: legProf, w: y => (y > R.kneeY + 0.04 ? blend(B.hips, hip, 0.99, 0.9)(y) : blend(hip, knee, R.kneeY + 0.06, R.kneeY - 0.05)(y)) });
  }
  for (const [side, sh, el] of [[-1, B.shL, B.elL], [1, B.shR, B.elR]]) {
    skin.tube({ cx: side * R.shX, yTop: top + 0.085, yBot: top - 0.56, rings: 30, mirror: side, prof: armProf, w: blend(sh, el, elY + 0.05, elY - 0.05), capTop: true });
  }
  // Шея: от корпуса к голове.
  skin.tube({ yTop: R.headY - 0.04, yBot: R.torsoY + 0.58, rings: 6, rad: 14, prof: () => [0.05, 0.055, 0, 0.006], w: blend(B.head, B.torso, R.headY - 0.07, R.torsoY + 0.64) });
  // Майка: талия, широкая грудь и спина, покатые плечи к вороту; ниже талии — вместе с тазом. Короткие рукава.
  const jer = new SkinBuilder();
  const ty = R.torsoY;
  jer.tube({ yTop: ty + 0.66, yBot: ty - 0.17, rings: 30, rad: 22, prof: profile([
    [ty + 0.66, 0.064, 0.058, 0, 0.004], [ty + 0.62, 0.1, 0.075, 0, 0.004], [ty + 0.57, 0.16, 0.098, 0, 0.002], [ty + 0.52, 0.2, 0.118, 0, 0],
    [ty + 0.44, 0.205, 0.13, 0, -0.006], [ty + 0.36, 0.198, 0.134, 0, -0.008], [ty + 0.26, 0.178, 0.124, 0, -0.004],
    [ty + 0.14, 0.158, 0.114, 0, 0], [ty + 0.02, 0.16, 0.114, 0, 0], [ty - 0.1, 0.172, 0.12, 0, 0], [ty - 0.17, 0.176, 0.124, 0, 0],
  ]), w: blend(B.torso, B.hips, ty + 0.12, ty - 0.04) });
  for (const [side, sh] of [[-1, B.shL], [1, B.shR]]) {
    jer.tube({ cx: side * R.shX, yTop: top + 0.06, yBot: top - 0.13, rings: 5, rad: 16, mirror: side, prof: profile([[top + 0.06, 0.06, 0.062, 0.008, 0], [top + 0.02, 0.076, 0.078, 0.01, 0], [top - 0.13, 0.068, 0.072, 0.006, 0]]), w: () => [[sh, 1]] });
  }
  // Шорты: таз и две штанины до середины бедра — штанины следуют за бедром, верх — за тазом.
  const sho = new SkinBuilder();
  const hy = R.hipsY;
  sho.tube({ yTop: hy + 0.12, yBot: hy - 0.15, rings: 10, rad: 22, prof: profile([[hy + 0.12, 0.17, 0.122, 0, 0], [hy + 0.02, 0.19, 0.135, 0, 0.004], [hy - 0.08, 0.2, 0.14, 0, 0.008], [hy - 0.15, 0.17, 0.12, 0, 0.004]]), w: () => [[B.hips, 1]], capBot: true });
  for (const [side, hip] of [[-1, B.hipL], [1, B.hipR]]) {
    sho.tube({ cx: side * R.hipX, yTop: hy - 0.02, yBot: hy - 0.25, rings: 8, rad: 18, prof: profile([[hy - 0.02, 0.112, 0.118, 0, 0], [hy - 0.25, 0.108, 0.112, 0, -0.004]]), w: blend(B.hips, hip, hy - 0.06, hy - 0.14) });
  }
  // Кроссовка: профиль сбоку (пятка — носок), выдавлен по ширине со скруглением; подошва — отдельно.
  const s = new THREE.Shape();
  s.moveTo(-0.07, 0.012); s.lineTo(0.2, 0.012); s.quadraticCurveTo(0.236, 0.014, 0.236, 0.04); s.quadraticCurveTo(0.232, 0.066, 0.17, 0.074);
  s.lineTo(0.07, 0.096); s.lineTo(0.0, 0.118); s.lineTo(-0.058, 0.124); s.quadraticCurveTo(-0.084, 0.1, -0.078, 0.05); s.quadraticCurveTo(-0.078, 0.012, -0.07, 0.012);
  const shoe = new THREE.ExtrudeGeometry(s, { depth: 0.074, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.01, bevelSegments: 3, curveSegments: 8 });
  shoe.translate(0, 0, -0.037); shoe.rotateY(Math.PI / 2);
  const so = new THREE.Shape();
  so.moveTo(-0.075, 0); so.lineTo(0.205, 0); so.quadraticCurveTo(0.245, 0, 0.245, 0.016); so.lineTo(0.245, 0.022); so.lineTo(-0.082, 0.022); so.quadraticCurveTo(-0.088, 0, -0.075, 0);
  const sole = new THREE.ExtrudeGeometry(so, { depth: 0.09, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2, curveSegments: 6 });
  sole.translate(0, 0, -0.045); sole.rotateY(Math.PI / 2);
  const hairCap = new THREE.SphereGeometry(0.107, 26, 14, 0, Math.PI * 2, 0, Math.PI * 0.6);
  RG = {
    skin: skin.geometry(), jersey: jer.geometry(), shorts: sho.geometry(), shoe, sole,
    skull: new THREE.SphereGeometry(0.1, 28, 20), jaw: new THREE.SphereGeometry(0.072, 20, 14), nose: new THREE.CapsuleGeometry(0.012, 0.026, 3, 8),
    ear: new THREE.SphereGeometry(0.026, 10, 8), eye: new THREE.SphereGeometry(0.011, 10, 8), brow: new THREE.BoxGeometry(0.03, 0.006, 0.008),
    hair: hairCap, collar: new THREE.TorusGeometry(0.066, 0.011, 8, 28),
    pad: new THREE.CylinderGeometry(0.063, 0.06, 0.12, 20, 1, true), sock: new THREE.CylinderGeometry(0.037, 0.034, 0.15, 16, 1, true),
    palm: new THREE.CapsuleGeometry(0.031, 0.045, 4, 10), finger: new THREE.CapsuleGeometry(0.0092, 0.05, 3, 6), thumb: new THREE.CapsuleGeometry(0.011, 0.04, 3, 6),
    back: numGeo(0.24, 0.2, 0.124), front: numGeo(0.13, 0.205, 0.132),
  };
  return RG;
}

function buildReal(root, { M, jersey, numMat, look }) {
  const G = realGeos();
  const bones = {};
  // Кость: позиция задаётся в мировых координатах стойки «смирно», внутри — относительно родителя.
  const bone = (name, parent, wx, wy, wz) => {
    const b = new THREE.Bone(); b.name = name;
    const p = parent ? parent.userData.w : new THREE.Vector3();
    b.position.set(wx - p.x, wy - p.y, wz - p.z);
    b.userData.w = new THREE.Vector3(wx, wy, wz);
    (parent ?? root).add(b);
    bones[name] = b;
    return b;
  };
  const fig = new THREE.Group(); root.add(fig);
  const hips = bone('hips', null, 0, R.hipsY, 0); fig.add(hips);
  const torso = bone('torso', hips, 0, R.torsoY, 0);
  const head = bone('head', torso, 0, R.headY, 0);
  const legs = side => {
    const n = side < 0 ? 'L' : 'R';
    const hip = bone('hip' + n, hips, side * R.hipX, R.hipsY - HIP_Y, 0);
    const knee = bone('knee' + n, hip, side * R.hipX, R.kneeY, 0);
    const ankle = bone('ankle' + n, knee, side * R.hipX, R.ankleY, 0);
    // Наколенник, гетра, кроссовка — на кости колена/стопы.
    mesh(G.pad, M.pad, knee, 0, -0.005, -0.008).scale.set(1, 1, 0.95);
    mesh(G.sock, M.sock, knee, 0, -(R.kneeY - 0.16), 0.004);
    mesh(G.shoe, M.shoe, ankle, 0, -R.ankleY, 0);
    mesh(G.sole, M.sole, ankle, 0, -R.ankleY, 0);
    return { hip, knee, ankle };
  };
  const legL = legs(-1), legR = legs(1);
  const fingers = [];
  const arms = side => {
    const n = side < 0 ? 'L' : 'R';
    const sh = bone('sh' + n, torso, side * R.shX, R.shY, 0);
    const el = bone('el' + n, sh, side * R.shX, R.shY - R.upper, 0);
    // Кисть: ладонь (плоская), четыре пальца и большой — пальцы раскрываются веером (блок, пас).
    const hand = new THREE.Group(); hand.position.set(0, -R.fore, 0); el.add(hand);
    mesh(G.palm, look.skin, hand, 0, -0.035, 0).scale.set(1.45, 1, 0.55);
    const fan = [];
    for (let i = 0; i < 4; i++) {
      const pv = new THREE.Group(); pv.position.set((i - 1.5) * 0.019, -0.07, 0); hand.add(pv);
      mesh(G.finger, look.skin, pv, 0, -0.03 - (i === 1 || i === 2 ? 0.004 : 0), 0);
      fan.push({ pv, k: i - 1.5 });
    }
    const th = new THREE.Group(); th.position.set(side * 0.038, -0.03, -0.008); hand.add(th);
    mesh(G.thumb, look.skin, th, 0, -0.024, 0);
    fan.push({ pv: th, k: side * 3, thumb: true });
    fingers.push(fan);
    return { sh, el, wrist: anchor(el, 0, -R.fore + 0.01, 0), palm: anchor(el, 0, -R.fore - 0.05, 0) };
  };
  const armL = arms(-1), armR = arms(1);
  // Голова: череп, челюсть, нос, уши, глаза, брови, волосы. Лицо смотрит на −Z.
  mesh(G.skull, look.skin, head, 0, 0.012, 0.004).scale.set(0.93, 1.07, 1.02);
  mesh(G.jaw, look.skin, head, 0, -0.05, -0.024).scale.set(0.92, 0.78, 0.95);
  const nose = mesh(G.nose, look.skin, head, 0, -0.012, -0.1); nose.rotation.x = -0.3;
  for (const sx of [-1, 1]) {
    mesh(G.ear, look.skin, head, sx * 0.094, -0.004, 0.006).scale.set(0.45, 1, 0.75);
    mesh(G.eye, M.eye, head, sx * 0.034, 0.01, -0.09);
    mesh(G.brow, look.hair, head, sx * 0.035, 0.03, -0.094).rotation.z = sx * -0.12;
  }
  const hair = mesh(G.hair, look.hair, head, 0, 0.03, 0.01); hair.rotation.x = -0.32; hair.scale.set(0.97, 1.0, 1.06);
  // Ворот и номера — на кости корпуса.
  const collar = mesh(G.collar, M.trim, torso, 0, 0.645, 0.004); collar.rotation.x = Math.PI / 2; collar.scale.set(1, 0.9, 1);
  if (numMat) {
    const back = new THREE.Mesh(G.back, numMat); back.position.y = 0.34; torso.add(back);
    const front = new THREE.Mesh(G.front, numMat); front.position.set(0, 0.42, -0.006); front.rotation.y = Math.PI; torso.add(front);
  }
  // Кожа, майка и шорты — на общем скелете.
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(BONES.map(n => bones[n]));
  for (const [geo, mat] of [[G.skin, look.skin], [G.jersey, jersey], [G.shorts, M.shortsReal]]) {
    const sm = shadowed(new THREE.SkinnedMesh(geo, mat));
    sm.frustumCulled = false;
    fig.add(sm);
    sm.bind(skeleton, sm.matrixWorld);
  }
  return { fig, hips, torso, head, legL, legR, armL, armR, fingers, arm: R.upper + R.fore + 0.05 };
}

// Внешность (реалистичная фигура): оттенок кожи и цвет волос — по игроку, всегда одинаковые.
const SKIN = ['#efc4a1', '#e3b08c', '#d29a74', '#b97f58', '#93603f', '#6e4630'];
const HAIR = ['#1f1a17', '#2e2119', '#4a3222', '#6b4a2b', '#a37b4a', '#cfae72'];
const hash = s => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

// Общие материалы для всех фигур (создаются один раз в сцене).
export function figureMaterials() {
  const M = {
    skin: new THREE.MeshStandardMaterial({ color: 0xd9a77f, roughness: 0.62 }),
    hair: new THREE.MeshStandardMaterial({ color: 0x2a1f19, roughness: 0.9 }),
    shorts: new THREE.MeshStandardMaterial({ color: 0x1b2a4a, roughness: 0.75 }),
    shortsReal: new THREE.MeshStandardMaterial({ color: 0x1b2a4a, roughness: 0.82, side: THREE.DoubleSide }),
    trim: new THREE.MeshStandardMaterial({ color: 0x1b2a4a, roughness: 0.7 }),
    pad: new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.85, side: THREE.DoubleSide }),
    sock: new THREE.MeshStandardMaterial({ color: 0xf2f3f5, roughness: 0.8, side: THREE.DoubleSide }),
    shoe: new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.45 }),
    sole: new THREE.MeshStandardMaterial({ color: 0x2c3a52, roughness: 0.7 }),
    eye: new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 0.3 }),
  };
  for (const m of Object.values(M)) m.userData.shared = true;
  return M;
}
export const sharedFigureGeometries = () => new Set([...Object.values(simpleGeos()), ...Object.values(realGeos())]);

// Собрать фигуру. detail: 'simple' | 'real'. Возвращает суставы, точки ладоней и запястий, материал майки.
export function buildFigure(root, { detail, M, numTex, id }) {
  const real = detail === 'real';
  const jersey = new THREE.MeshStandardMaterial({ color: 0xe9eaec, roughness: real ? 0.78 : 0.55, side: real ? THREE.DoubleSide : THREE.FrontSide });
  const numMat = numTex ? new THREE.MeshStandardMaterial({ map: numTex, transparent: true, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 }) : null;
  let look = null;
  if (real) {
    const h = hash(id);
    look = {
      skin: new THREE.MeshStandardMaterial({ color: SKIN[h % SKIN.length], roughness: 0.52 }),
      hair: new THREE.MeshStandardMaterial({ color: HAIR[(h >>> 8) % HAIR.length], roughness: 0.85 }),
    };
  }
  const rig = real ? buildReal(root, { M, jersey, numMat, look }) : buildSimple(root, { M, jersey, numMat });
  if (real) rig.fig.scale.setScalar(0.97 + ((hash(id) >>> 16) % 7) * 0.01); // рост чуть разный
  rig.jersey = jersey;
  rig.real = real;
  return rig;
}

// Применить позу (P — поля из motion.js) и высоту прыжка y. Таз ставится так, чтобы опорная нога стояла на полу;
// в прыжке — по траектории прыжка.
export function applyPose(rig, P, y = 0) {
  const dL = legDrop(P.hL, P.abL, P.kL, P.fL, THIGH, SHIN), dR = legDrop(P.hR, P.abR, P.kR, P.fR, THIGH, SHIN);
  const ground = Math.max(dL, dR), air = Math.min(1, y / 0.12);
  rig.hips.position.y = HIP_Y + ground + (LEG * 0.95 - ground) * air;
  rig.fig.position.y = y;
  const leg = (L, h, ab, k, f, s) => {
    L.hip.rotation.set(h, 0, s * ab);
    L.knee.rotation.set(-k, 0, 0);
    L.ankle.rotation.set(-(h - k) - f, 0, -s * ab);
  };
  leg(rig.legL, P.hL, P.abL, P.kL, P.fL, -1);
  leg(rig.legR, P.hR, P.abR, P.kR, P.fR, 1);
  rig.torso.rotation.set(-P.lean, P.twist, P.roll);
  rig.head.rotation.set(P.head, -P.twist * 0.4, 0);
  rig.armL.sh.rotation.set(P.sL, 0, -P.szL); rig.armR.sh.rotation.set(P.sR, 0, P.szR);
  rig.armL.el.rotation.x = P.eL; rig.armR.el.rotation.x = P.eR;
  if (rig.fingers) for (const fan of rig.fingers) for (const f of fan) f.pv.rotation.z = f.thumb ? f.k * 0.12 * (0.6 + P.fing) : f.k * 0.12 * P.fing;
}

// Где мяч у игрока: 'platform' — на предплечьях (приём), 'hands' — над лбом в ладонях (пас),
// 'spike' — у правой ладони (удар, подача), 'block' — у ладоней над сеткой, 'handL' — в левой руке (перед подачей).
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _f = new THREE.Vector3();
export function anchorOf(rig, part, out = new THREE.Vector3()) {
  rig.fig.getWorldDirection(_f).multiplyScalar(-1); // вперёд — к −Z фигуры
  if (part === 'platform') {
    // На предплечьях, ближе к запястьям, — сверху.
    rig.armL.wrist.getWorldPosition(_a); rig.armR.wrist.getWorldPosition(_b);
    out.copy(_a).add(_b).multiplyScalar(0.5);
    rig.armL.el.getWorldPosition(_a); rig.armR.el.getWorldPosition(_b);
    out.lerp(_a.add(_b).multiplyScalar(0.5), 0.25);
    return out.setY(out.y + 0.11);
  }
  if (part === 'hands' || part === 'block') {
    rig.armL.palm.getWorldPosition(_a); rig.armR.palm.getWorldPosition(_b);
    out.copy(_a).add(_b).multiplyScalar(0.5);
    return part === 'hands' ? out.addScaledVector(_f, 0.03).setY(out.y + 0.1) : out.addScaledVector(_f, 0.12);
  }
  if (part === 'handL') return rig.armL.palm.getWorldPosition(out).setY(out.y + 0.08).addScaledVector(_f, 0.03);
  return rig.armR.palm.getWorldPosition(out).addScaledVector(_f, 0.1).setY(out.y + 0.05);
}
