// 3D-площадка: клик по полу → точка в метрах площадки, вращение и зум мышью,
// фишки игроков по зонам текущей расстановки, траектории мяча (пас, атака, подача).
// Координаты площадки (x 0…9, y 0…18, сетка на y=9) переводятся в мир three.js так:
//   X = x − 4.5,  Z = 9 − y  (наша половина ближе к камере),  Y — вверх.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/three/OrbitControls.js';
import { NET_H, zoneOf } from '../court.js';

// Часы анимации. Для проверок можно «заморозить» время: window.__vmTime = мс.
const clock = (t = performance.now()) => window.__vmTime ?? t;
const toWorld = (p, h = 0) => new THREE.Vector3(p.x - 4.5, h, 9 - p.y);
const toCourt = v => ({ x: +(v.x + 4.5).toFixed(2), y: +(9 - v.z).toFixed(2) });

const COLORS = {
  floorOut: 0x101215, free: 0x1a2330, courtUs: 0x2b5d8a, courtThem: 0x3a4d6b, line: 0xf2f2f2,
  coral: 0xff6363, mint: 0x59d499, sky: 0x63a1ff, amber: 0xf0c85a, white: 0xffffff,
};
const canvasTex = (c, { srgb = true, aniso = 4 } = {}) => {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
};

// Подпись над игроком: кружок для номера, «таблетка» для имени. Возвращает текстуру и пропорцию.
function labelTexture(text, { bg = '#e9eaec', fg = '#111', ring = null } = {}) {
  const H = 96, c = document.createElement('canvas'), g = c.getContext('2d');
  const font = `600 ${text.length > 2 ? 46 : 58}px Inter, system-ui, sans-serif`;
  g.font = font;
  const w = Math.max(H, Math.min(520, Math.ceil(g.measureText(text).width) + 44));
  c.width = w; c.height = H;
  g.beginPath(); g.roundRect(3, 3, w - 6, H - 6, (H - 6) / 2); g.fillStyle = bg; g.fill();
  if (ring) { g.lineWidth = 6; g.strokeStyle = ring; g.stroke(); }
  g.font = font; g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, w / 2, H / 2 + 3);
  return { tex: canvasTex(c), aspect: w / H };
}

// Номер на майке: крупные цифры с обводкой, фон прозрачный.
// Цвета формы по умолчанию: майка, шорты, цифры, майка связующего, майка либеро.
export const KIT_DEFAULT = { main: '#e9eaec', shorts: '#1b2a4a', number: '#16233f', setter: '#f0c85a', libero: '#e8613c' };
const lum = hex => { const c = new THREE.Color(hex); return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; };
function numberTexture(num, color = KIT_DEFAULT.number) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.font = `800 ${String(num).length > 1 ? 84 : 100}px Inter, system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineJoin = 'round'; g.lineWidth = 10; g.strokeStyle = lum(color) < 0.45 ? 'rgba(255,255,255,.9)' : 'rgba(10,12,18,.85)'; // обводка — контрастная цифрам
  g.strokeText(String(num), 64, 70);
  g.fillStyle = color;
  g.fillText(String(num), 64, 70);
  return canvasTex(c);
}

// Сетка: чёрная ячейка 10 см (одна ячейка на текстуру, текстура повторяется).
function netTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(20,22,26,0.95)'; g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, 29, 29);
  const t = canvasTex(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(100, 10);
  return t;
}

// Волейбольный мяч: 6 панелей по 3 полосы (как у настоящего мяча), соседние панели — поперёк друг друга.
// Рисуем в развёртке сферы попиксельно: для каждой точки берём направление и смотрим, какая грань «куба» ближе.
function ballTexture() {
  const W = 512, H = 256, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d'), img = g.createImageData(W, H), d = img.data;
  const COLS = [[246, 205, 60], [36, 84, 170], [245, 245, 240]]; // жёлтая · синяя · белая
  for (let j = 0; j < H; j++) {
    const th = (j / H) * Math.PI;
    for (let i = 0; i < W; i++) {
      const ph = (i / W) * Math.PI * 2;
      const v = [-Math.cos(ph) * Math.sin(th), Math.cos(th), Math.sin(ph) * Math.sin(th)];
      const ax = v.map(Math.abs), k = ax[0] > ax[1] ? (ax[0] > ax[2] ? 0 : 2) : ax[1] > ax[2] ? 1 : 2;
      const u = v[(k + 1) % 3] / ax[k]; // −1…1 поперёк полос
      const band = Math.min(2, Math.floor((u + 1) * 1.5));
      const edge = Math.abs(((u + 1) * 1.5) % 1 - 0.5) > 0.46 || Math.max(...ax.filter((_, q) => q !== k)) / ax[k] > 0.985;
      const col = COLS[(band + k) % 3], sh = edge ? 0.55 : 1;
      const o = (j * W + i) * 4;
      d[o] = col[0] * sh; d[o + 1] = col[1] * sh; d[o + 2] = col[2] * sh; d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return canvasTex(c, { aniso: 8 });
}

// Покрытие: еле заметные «доски» и шум — чтобы пол не был плоской заливкой.
function floorTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 16) {
    g.fillStyle = `rgba(0,0,0,${0.025 + Math.random() * 0.03})`; g.fillRect(0, y, 256, 16);
    g.fillStyle = 'rgba(0,0,0,.06)'; g.fillRect(0, y, 256, 1);
  }
  for (let k = 0; k < 2500; k++) { g.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,255,255'},.035)`; g.fillRect(Math.random() * 256, Math.random() * 256, 2, 1); }
  const t = canvasTex(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// Мягкая тень-пятно под игроком и мячом.
function blobTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(0,0,0,.55)'); r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  return canvasTex(c, { srgb: false });
}

// Рекламные щиты по краю зала — с названием приложения.
function boardTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 64;
  const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 64);
  gr.addColorStop(0, '#1b2a44'); gr.addColorStop(1, '#0f1726');
  g.fillStyle = gr; g.fillRect(0, 0, 1024, 64);
  g.font = '600 30px Inter, system-ui, sans-serif'; g.textBaseline = 'middle';
  for (let x = 20; x < 1024; x += 340) { g.fillStyle = '#63a1ff'; g.fillText('ВОЛЕЙ', x, 34); g.fillStyle = '#e9eaec'; g.fillText('МЕТРИКА', x + 112, 34); }
  const t = canvasTex(c);
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

// Точки траектории: по горизонтали прямая, по высоте — парабола с вершиной apex.
export function arcPoints(from, to, y0, y1, apex, n = 40) {
  const pts = [];
  const mid = (y0 + y1) / 2;
  const k = Math.max(0, apex - mid);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = from.x + (to.x - from.x) * t, y = from.y + (to.y - from.y) * t;
    pts.push(toWorld({ x, y }, y0 + (y1 - y0) * t + 4 * k * t * (1 - t)));
  }
  return pts;
}

// Очистка группы с освобождением памяти видеокарты: траектории и точки перерисовываются часто,
// без dispose() за долгий разбор матча память бы только росла.
function clearGroup(g) {
  g.traverse(o => {
    if (o === g) return;
    o.geometry?.dispose();
    if (o.material && !o.material.userData.shared) o.material.dispose();
  });
  g.clear();
}

export function createCourt3D(el, { onPick, onHover, onWheel } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  el.appendChild(renderer.domElement);
  // Если видеокарта «отняла» контекст (бывает на слабых ноутбуках при тяжёлом видео) — просим вернуть, а не гаснем навсегда.
  renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); console.warn('3D: контекст WebGL потерян, восстанавливаю…'); });
  renderer.domElement.addEventListener('webglcontextrestored', () => console.warn('3D: контекст WebGL восстановлен'));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0c0e);
  scene.fog = new THREE.Fog(0x0b0c0e, 40, 75);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  camera.position.set(0, 10.5, 16.5);
  // Смотрим чуть ниже центра — наша половина целиком над панелью кнопок.
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 2.2);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 6;
  controls.maxDistance = 50;

  // Свет: мягкий общий + «прожектор зала» с тенями + слабая контровая подсветка с другой стороны.
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a1a1a, 1.25));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.position.set(-6, 18, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14 });
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0xbcd2ff, 0.55);
  rim.position.set(8, 9, -14);
  scene.add(rim);

  // ---------- Пол, свободная зона, площадка, линии ----------
  const fTex = floorTexture();
  const flat = (w, d, color, y = 0, opts = {}) => {
    const map = fTex.clone(); map.needsUpdate = true; map.repeat.set(w / 4, d / 4);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.0, map, ...opts }));
    m.rotation.x = -Math.PI / 2;
    m.position.y = y;
    m.receiveShadow = true;
    return m;
  };
  const floor = flat(70, 70, COLORS.floorOut, -0.012, { roughness: 0.9 });
  scene.add(floor);
  // Свободная зона вокруг площадки — своим цветом, как в настоящем зале.
  const free = flat(19, 31, COLORS.free, -0.006);
  scene.add(free);
  const courtUs = flat(9, 9, COLORS.courtUs, 0); courtUs.position.z = 4.5; scene.add(courtUs);
  const courtThem = flat(9, 9, COLORS.courtThem, 0); courtThem.position.z = -4.5; scene.add(courtThem);
  // Зона атаки чуть светлее — как на настоящих площадках.
  const atkUs = flat(9, 3, 0x3a74a8, 0.002); atkUs.position.z = 1.5; scene.add(atkUs);
  const atkThem = flat(9, 3, 0x4a6188, 0.002); atkThem.position.z = -1.5; scene.add(atkThem);

  const lineMat = new THREE.MeshBasicMaterial({ color: COLORS.line });
  const line = (x1, z1, x2, z2, w = 0.05) => {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 === x2 ? w : len + w, x1 === x2 ? len + w : w), lineMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set((x1 + x2) / 2, 0.004, (z1 + z2) / 2);
    scene.add(m);
  };
  line(-4.5, -9, -4.5, 9); line(4.5, -9, 4.5, 9); line(-4.5, 9, 4.5, 9); line(-4.5, -9, 4.5, -9);
  line(-4.5, 0, 4.5, 0); line(-4.5, 3, 4.5, 3); line(-4.5, -3, 4.5, -3);
  // Пунктир продолжения линий атаки за боковыми (по правилам — 5 штрихов по 15 см).
  for (const z of [3, -3]) for (const sx of [-1, 1]) for (let k = 0; k < 5; k++) { const x = sx * (4.5 + 0.2 + k * 0.35 + 0.075); line(x - 0.075, z, x + 0.075, z); }
  // Зона замен и короткие линии подачи за лицевыми.
  for (const z of [9.1, -9.1]) for (const x of [-4.5, 4.5]) line(x, z, x, z + Math.sign(z) * 0.15);

  // Рекламные щиты по бокам и за дальней лицевой.
  const bTex = boardTexture();
  const board = (w, x, z, ry) => {
    const map = bTex.clone(); map.needsUpdate = true; map.repeat.set(w / 12, 1);
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.9, 0.12), [0, 0, 0, 0, 1, 1].map(k => (k ? new THREE.MeshStandardMaterial({ map, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.35, roughness: 0.6 }) : new THREE.MeshStandardMaterial({ color: 0x0e1420 }))));
    m.position.set(x, 0.45, z); m.rotation.y = ry; m.receiveShadow = true;
    scene.add(m);
  };
  board(31, -9.8, 0, Math.PI / 2); board(31, 9.8, 0, -Math.PI / 2); board(19.6, 0, -15.8, 0);

  // Тонкая сетка зон (3×3 м) — включается кнопкой «Зоны».
  const zoneGrid = new THREE.Group();
  const zMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12 });
  for (const x of [-1.5, 1.5]) { const m = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 18), zMat); m.rotation.x = -Math.PI / 2; m.position.set(x, 0.005, 0); zoneGrid.add(m); }
  for (const z of [-6, 6]) { const m = new THREE.Mesh(new THREE.PlaneGeometry(9, 0.03), zMat); m.rotation.x = -Math.PI / 2; m.position.set(0, 0.005, z); zoneGrid.add(m); }
  scene.add(zoneGrid);

  // ---------- Сетка, стойки, антенны ----------
  const netH = NET_H;
  const net = new THREE.Mesh(new THREE.PlaneGeometry(10, 1), new THREE.MeshBasicMaterial({ map: netTexture(), transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  net.position.set(0, netH - 0.5, 0);
  scene.add(net);
  const tapeMat = new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.5 });
  const band = new THREE.Mesh(new THREE.BoxGeometry(10, 0.07, 0.025), tapeMat);
  band.position.set(0, netH - 0.035, 0); band.castShadow = true; scene.add(band);
  const bottom = new THREE.Mesh(new THREE.BoxGeometry(10, 0.05, 0.02), tapeMat);
  bottom.position.set(0, netH - 0.975, 0); scene.add(bottom);
  // Боковые ленты над боковыми линиями.
  for (const x of [-4.5, 4.5]) { const t = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1, 0.022), tapeMat); t.position.set(x, netH - 0.5, 0); scene.add(t); }
  // Трос до стоек.
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 11, 6), new THREE.MeshStandardMaterial({ color: 0x9a9da3, metalness: 0.7, roughness: 0.35 }));
  cable.rotation.z = Math.PI / 2; cable.position.set(0, netH - 0.02, 0); scene.add(cable);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x8c8f94, metalness: 0.6, roughness: 0.4 });
  const padMat = new THREE.MeshStandardMaterial({ color: 0x1d3f73, roughness: 0.8 });
  for (const x of [-5.5, 5.5]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, netH + 0.2, 16), postMat);
    post.position.set(x, (netH + 0.2) / 2, 0); post.castShadow = true; scene.add(post);
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 1.9, 20), padMat); // защитный чехол
    pad.position.set(x, 0.95, 0); pad.castShadow = true; scene.add(pad);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.06, 24), postMat);
    base.position.set(x, 0.03, 0); scene.add(base);
  }
  // Вышка первого судьи у правой стойки.
  {
    const ref = new THREE.Group(), m = new THREE.MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.7 });
    const plat = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.06, 0.7), m); plat.position.y = 1.45; ref.add(plat);
    for (const [dx, dz] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) { const l = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.45, 8), postMat); l.position.set(dx, 0.72, dz); ref.add(l); }
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.05, 0.04), postMat); rail.position.set(0, 2.25, 0.33); ref.add(rail);
    ref.position.set(6.3, 0, 0); ref.traverse(o => { o.castShadow = true; });
    scene.add(ref);
  }
  const antMat = [new THREE.MeshStandardMaterial({ color: 0xe23b3b, roughness: 0.5 }), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 })];
  for (const x of [-4.5, 4.5]) {
    const ant = new THREE.Group();
    for (let i = 0; i < 18; i++) {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.1, 8), antMat[i % 2]);
      s.position.y = netH - 1 + 0.05 + i * 0.1; ant.add(s);
    }
    ant.position.x = x; scene.add(ant);
  }

  // ---------- Игроки ----------
  const players = new Map(); // id → { group, target }
  // Игрок — фигура с суставами (бедро/колено/стопа, плечо/локоть): майка с номером на спине и груди,
  // шорты, наколенники, гетры, кроссовки. Смотрит на сетку (−Z), поэтому с нашей камеры виден номер на спине.
  // Двигается кодом: стойка, бег, приём, пас, нападающий удар с разбега в прыжке, блок в прыжке, подача.
  const THIGH = 0.44, SHIN = 0.48; // от тазобедренного до колена, от колена до подошвы
  const LEG = THIGH + SHIN;
  // Номер на майке — чуть изогнутая пластина по форме корпуса.
  const numGeo = (w, rx, rz) => {
    const g = new THREE.PlaneGeometry(w, w, 8, 1), pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, rz * Math.sqrt(Math.max(0, 1 - (pos.getX(i) / rx) ** 2)) + 0.006);
    g.computeVertexNormals();
    return g;
  };
  const G = {
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
    hit: new THREE.CylinderGeometry(0.36, 0.36, 2.0, 10), blob: new THREE.PlaneGeometry(1, 1),
  };
  const MAT = {
    skin: new THREE.MeshStandardMaterial({ color: 0xd9a77f, roughness: 0.62 }),
    hair: new THREE.MeshStandardMaterial({ color: 0x2a1f19, roughness: 0.9 }),
    shorts: new THREE.MeshStandardMaterial({ color: 0x1b2a4a, roughness: 0.75 }),
    pad: new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.85 }),
    sock: new THREE.MeshStandardMaterial({ color: 0xf2f3f5, roughness: 0.8 }),
    shoe: new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.45 }),
    sole: new THREE.MeshStandardMaterial({ color: 0x2c3a52, roughness: 0.7 }),
    hit: new THREE.MeshBasicMaterial({ visible: false }),
    blob: new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false }),
  };
  for (const m of Object.values(MAT)) m.userData.shared = true;
  let kit = { ...KIT_DEFAULT };
  // Форма команды из настроек. Цифры «запечены» в текстуру — при смене их цвета фигуры пересоздаются сами (ключ фигуры).
  function setKit(k = {}) {
    kit = { ...KIT_DEFAULT, ...Object.fromEntries(Object.entries(k).filter(([, v]) => v)) };
    MAT.shorts.color.set(kit.shorts);
  }
  const shadowed = o => { o.castShadow = true; return o; };
  const mesh = (geo, mat, parent, x = 0, y = 0, z = 0) => { const m = shadowed(new THREE.Mesh(geo, mat)); m.position.set(x, y, z); parent.add(m); return m; };
  const joint = (parent, x = 0, y = 0, z = 0) => { const j = new THREE.Group(); j.position.set(x, y, z); parent.add(j); return j; };

  // Подписи: 'num' — номер, 'name' — имя, 'full' — как записан в составе (номер и имя), 'none' — без подписи.
  let labelMode = 'num';
  const labelText = info => {
    const num = info.num != null && info.num !== '' ? String(info.num) : '', name = (info.name || '').trim();
    if (labelMode === 'none') return '';
    if (labelMode === 'name') return name.split(/\s+/)[0] || num || String(info.label ?? '');
    if (labelMode === 'full') return [num, name].filter(Boolean).join(' ') || String(info.label ?? '');
    return num || String(info.label ?? '');
  };
  function paintLabel(g, info) {
    const u = g.userData, text = labelText(info);
    u.sprite.visible = !!text;
    if (!text || text === u.labelText) return;
    u.labelText = text;
    u.sprite.material.map?.dispose();
    const { tex, aspect } = labelTexture(text);
    u.sprite.material.map = tex; u.sprite.material.needsUpdate = true;
    const h = aspect > 1.05 ? 0.44 : 0.6;
    u.sprite.scale.set(h * aspect, h, 1);
  }

  function playerToken(p) {
    const g = new THREE.Group();
    const hit = new THREE.Mesh(G.hit, MAT.hit); // невидимый «корпус» для клика
    hit.position.y = 1.0; hit.userData.pid = p.id;
    g.add(hit);
    const jersey = new THREE.MeshStandardMaterial({ color: 0xe9eaec, roughness: 0.55 });
    const fig = joint(g);
    const hips = joint(fig, 0, LEG, 0);
    mesh(G.shorts, MAT.shorts, hips, 0, 0.0, 0).scale.set(1, 1, 0.82);
    const leg = side => {
      const hip = joint(hips, side * 0.1, -0.06, 0);
      mesh(G.thigh, MAT.skin, hip, 0, -THIGH / 2, 0);
      const knee = joint(hip, 0, -THIGH, 0);
      mesh(G.pad, MAT.pad, knee, 0, -0.01, -0.01).scale.set(1, 1, 0.95);
      mesh(G.shin, MAT.skin, knee, 0, -0.2, 0);
      mesh(G.sock, MAT.sock, knee, 0, -0.33, 0);
      const ankle = joint(knee, 0, -SHIN + 0.06, 0);
      const shoe = mesh(G.shoe, MAT.shoe, ankle, 0, -0.01, -0.045); shoe.rotation.x = Math.PI / 2; shoe.scale.set(1, 1, 0.8);
      mesh(G.sole, MAT.sole, ankle, 0, -0.052, -0.045);
      return { hip, knee, ankle };
    };
    const legL = leg(-1), legR = leg(1);
    const torso = joint(hips, 0, 0.08, 0);
    const chest = mesh(G.torso, jersey, torso, 0, 0.27, 0); chest.scale.set(1.18, 1, 0.73);
    mesh(G.neck, MAT.skin, torso, 0, 0.66, 0);
    const head = joint(torso, 0, 0.79, 0);
    mesh(G.head, MAT.skin, head);
    const hair = mesh(G.hair, MAT.hair, head, 0, 0.012, 0.008); hair.rotation.x = -0.25;
    // Номер на спине (к камере) и маленький — на груди.
    const numTex = p.num != null && p.num !== '' ? numberTexture(p.num, kit.number) : null;
    if (numTex) {
      const nm = new THREE.MeshStandardMaterial({ map: numTex, transparent: true, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 });
      const back = new THREE.Mesh(G.back, nm); back.position.y = 0.33; torso.add(back);
      const front = new THREE.Mesh(G.front, nm); front.position.set(0, 0.4, 0); front.rotation.y = Math.PI; torso.add(front);
    }
    const arm = side => {
      const sh = joint(torso, side * 0.235, 0.5, 0);
      mesh(G.upper, MAT.skin, sh, 0, -0.14, 0);
      mesh(G.sleeve, jersey, sh, 0, -0.07, 0);
      mesh(G.delt, jersey, sh, 0, -0.01, 0).scale.set(1, 1.1, 1);
      const el = joint(sh, 0, -0.29, 0);
      mesh(G.fore, MAT.skin, el, 0, -0.13, 0);
      mesh(G.hand, MAT.skin, el, 0, -0.29, 0).scale.set(0.8, 1.15, 0.55);
      return { sh, el };
    };
    const armL = arm(-1), armR = arm(1);
    // Пятно-тень под ногами: на полу всегда, в прыжке — бледнее и меньше.
    const bm = MAT.blob.clone(); bm.userData = {};
    const blob = new THREE.Mesh(G.blob, bm); blob.rotation.x = -Math.PI / 2; blob.position.y = 0.007; blob.scale.setScalar(0.9);
    g.add(blob);
    // Подсветка «скорее всего этот игрок»: пульсирующее янтарное кольцо.
    const glow = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.62, 40), new THREE.MeshBasicMaterial({ color: COLORS.amber, transparent: true, opacity: 0, depthWrite: false }));
    glow.rotation.x = -Math.PI / 2; glow.position.y = 0.012;
    g.add(glow);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.55, 40), new THREE.MeshBasicMaterial({ color: COLORS.coral, transparent: true, opacity: 0 }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.01;
    g.add(ring);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false }));
    sprite.position.y = 2.32; sprite.renderOrder = 10;
    g.add(sprite);
    g.userData = { body: hit, jersey, fig, hips, torso, head, legL, legR, armL, armR, ring, glow, sprite, blob, key: tokenKey(p), phase: Math.random() * 6, act: null, actKey: null, seed: Math.random() * 10 };
    paintLabel(g, p);
    scene.add(g);
    return g;
  }
  const tokenKey = p => `${p.num ?? ''}|${kit.number}`;
  // Удаление фигуры: свои материалы и текстуры освобождаем, общие геометрии и материалы — нет.
  const shared = new Set(Object.values(G));
  function disposeToken(g) {
    g.traverse(o => {
      if (o.geometry && !shared.has(o.geometry)) o.geometry.dispose();
      if (o.material && !o.material.userData.shared) { if (o.material.map !== MAT.blob.map) o.material.map?.dispose(); o.material.dispose(); }
    });
  }

  // Длительность движений, с.
  const ACT_DUR = { rec: 0.8, dig: 0.8, set: 0.75, att: 1.35, blk: 1.05, serve: 1.3 };
  const clamp01 = f => Math.max(0, Math.min(1, f));
  const bell = f => Math.sin(Math.PI * clamp01(f));
  const mix = (a, b, f) => a + (b - a) * clamp01(f);
  const ease = f => { f = clamp01(f); return f * f * (3 - 2 * f); };
  // Поза на кадр. Углы плеча: 0 — рука вниз, π/2 — вперёд (к сетке), π — вверх, больше π — замах за голову.
  // Локоть: 0 — прямая рука, больше — согнута. bend — угол в бедре (колено сгибается вдвое сильнее, стопа на полу).
  function animate(rec, dt, now) {
    const u = rec.group.userData, pos = rec.group.position;
    rec.prev ??= pos.clone();
    const spd = Math.min(8, pos.distanceTo(rec.prev) / Math.max(dt, 1e-3));
    rec.prev.copy(pos);
    rec.spd = mix(rec.spd ?? 0, spd, dt * 8);
    const run = Math.min(1, rec.spd / 2.2);
    u.phase += dt * (5 + rec.spd * 3);
    // Стойка готовности: колени согнуты, руки перед собой.
    let bend = 0.32 + 0.03 * Math.sin(now / 520 + u.seed), jump = 0, tuck = 0, lean = 0.22 + run * 0.15, twist = 0, dz = 0;
    let sw = Math.sin(u.phase) * 0.8 * run;
    let aL = 0.62 - sw * 0.7, aR = 0.62 + sw * 0.7, eL = 0.8 + run * 0.6, eR = 0.8 + run * 0.6, spread = 0.16;
    const a = u.act;
    if (a) {
      const f = (now - a.t0) / 1000 / ACT_DUR[a.type];
      if (f >= 1) u.act = null;
      else {
        sw *= 0.15;
        if (a.type === 'rec' || a.type === 'dig') {
          // Приём снизу: глубокий присед, прямые руки «площадкой», ладони вместе.
          const k = bell(f), deep = a.type === 'dig' ? 0.95 : 0.78;
          bend = mix(bend, deep, k * 1.6); lean = 0.25 + 0.4 * k;
          aL = aR = mix(0.75, (a.type === 'dig' ? 0.75 : 0.95) + lean, f * 4); eL = eR = mix(1.1, 0.05, f * 5); spread = -0.13;
        }
        if (a.type === 'set') {
          // Пас сверху: ладони над лбом, локти согнуты → выпрямление вверх-вперёд.
          bend = mix(0.5, 0.15, (f - 0.35) * 3); jump = 0.08 * bell((f - 0.35) / 0.5); lean = -0.05;
          aL = aR = f < 0.45 ? mix(0.5, 2.1, f * 4) : mix(2.1, 2.75, (f - 0.45) * 4); eL = eR = f < 0.45 ? mix(1.1, 1.25, f * 4) : mix(1.25, 0.15, (f - 0.45) * 4); spread = 0.24;
        }
        if (a.type === 'att') {
          // Разбег (два шага к сетке) → замах обеими руками назад → прыжок → «лук» → удар → приземление.
          dz = mix(1.3, 0, ease(f / 0.32));
          if (f < 0.32) { sw = Math.sin(f * 30) * 0.55 * (1 - clamp01((f - 0.2) * 8)); bend = mix(0.35, 0.75, (f - 0.18) * 8); lean = 0.35 + 0.2 * clamp01((f - 0.18) * 8); }
          aL = aR = f < 0.32 ? mix(0.5, -1.0, (f - 0.12) * 6) : 0;
          if (f >= 0.32) {
            jump = 1.0 * bell((f - 0.32) / 0.56);
            bend = f < 0.36 ? mix(0.8, 0.1, (f - 0.32) * 25) : 0.15; tuck = 0.9 * bell((f - 0.38) / 0.45);
            aL = f < 0.54 ? mix(-1.0, 2.9, (f - 0.32) * 8) : mix(2.9, 0.5, (f - 0.54) * 5);
            aR = f < 0.54 ? mix(-1.0, 3.45, (f - 0.32) * 8) : mix(3.45, 1.1, (f - 0.54) * 10);
            eL = 0.3; eR = f < 0.54 ? mix(0.4, 1.9, (f - 0.4) * 8) : mix(1.9, 0.05, (f - 0.54) * 14);
            lean = f < 0.54 ? mix(0.1, -0.35, (f - 0.32) * 6) : mix(-0.35, 0.5, (f - 0.54) * 8);
            twist = f < 0.54 ? mix(0, 0.45, (f - 0.36) * 6) : mix(0.45, -0.35, (f - 0.54) * 8);
            spread = 0.1;
          }
          if (f > 0.86) { bend = mix(0.15, 0.75, bell((f - 0.86) / 0.14)); lean = mix(0.5, 0.35, (f - 0.86) * 7); }
        }
        if (a.type === 'blk') {
          // Блок: присед → прыжок вертикально, прямые руки вверх и чуть вперёд, ладони широко.
          bend = f < 0.22 ? mix(0.32, 0.7, f * 5) : f > 0.86 ? mix(0.1, 0.6, bell((f - 0.86) / 0.14)) : 0.1;
          jump = f > 0.22 ? 0.78 * bell((f - 0.22) / 0.64) : 0;
          aL = aR = f < 0.22 ? mix(0.5, 1.9, f * 5) : mix(1.9, 2.85, (f - 0.22) * 6);
          eL = eR = f < 0.22 ? 1.5 : mix(1.5, 0, (f - 0.22) * 6);
          spread = f < 0.22 ? 0.1 : 0.2; lean = -0.04; tuck = 0.15 * bell((f - 0.22) / 0.64);
          if (f > 0.75) { aL = aR = mix(2.85, 0.6, (f - 0.75) * 4); eL = eR = mix(0, 1.1, (f - 0.75) * 4); }
        }
        if (a.type === 'serve') {
          // Подача в прыжке: подброс левой, разбег, замах правой, удар над головой.
          dz = mix(0.9, 0, ease((f - 0.1) / 0.35));
          if (f < 0.45) { sw = Math.sin(f * 24) * 0.7 * clamp01((f - 0.1) * 6); }
          aL = f < 0.3 ? mix(0.5, 2.9, f * 5) : mix(2.9, 0.4, (f - 0.55) * 4);
          aR = f < 0.45 ? mix(0.4, 3.4, (f - 0.25) * 6) : mix(3.4, 1.0, (f - 0.58) * 9);
          eL = 0.2; eR = f < 0.58 ? mix(0.6, 1.8, (f - 0.3) * 6) : mix(1.8, 0.05, (f - 0.58) * 12);
          if (f > 0.42) { jump = 0.55 * bell((f - 0.42) / 0.45); tuck = 0.5 * bell((f - 0.45) / 0.38); bend = 0.15; }
          else bend = mix(0.32, 0.6, (f - 0.3) * 8);
          lean = f < 0.58 ? mix(0.1, -0.3, (f - 0.4) * 6) : mix(-0.3, 0.4, (f - 0.58) * 8);
          twist = f < 0.58 ? mix(0, 0.4, (f - 0.35) * 6) : mix(0.4, -0.3, (f - 0.58) * 8);
          if (f > 0.87) bend = mix(0.15, 0.6, bell((f - 0.87) / 0.13));
        }
      }
    }
    // Разворот: плавно к нужному углу (по кратчайшей дуге). Разбег идёт вдоль направления взгляда.
    let dy = (rec.yaw ?? 0) - u.fig.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    u.fig.rotation.y += dy * Math.min(1, dt * 7);
    const ry = u.fig.rotation.y;
    u.fig.position.set(Math.sin(ry) * dz, jump, Math.cos(ry) * dz);
    u.hips.position.y = 0.06 + LEG * Math.cos(bend) + 0.035 * Math.abs(Math.sin(u.phase)) * run;
    // Ноги: бедро вперёд на bend ± мах при беге, колено сгибается (сильнее у ноги, которая сзади), стопа — параллельно полу.
    for (const [L, s] of [[u.legL, sw], [u.legR, -sw]]) {
      const hip = bend + s + tuck * 0.7;
      const knee = -2 * bend - Math.max(0, -s) * 1.1 - tuck * 1.6;
      L.hip.rotation.x = hip; L.knee.rotation.x = knee;
      L.ankle.rotation.x = jump > 0.05 ? -(hip + knee) - 0.5 * clamp01(jump * 4) : -(hip + knee);
    }
    u.torso.rotation.x = -lean;
    u.torso.rotation.y = twist;
    u.head.rotation.x = lean * 0.6 - (aR > 2.4 ? 0.25 : 0); // в прыжке смотрим на мяч
    // Плечо: вращаем вперёд-вверх; локоть сгибает предплечье вперёд.
    u.armL.sh.rotation.x = aL; u.armR.sh.rotation.x = aR;
    u.armL.sh.rotation.z = -spread; u.armR.sh.rotation.z = spread;
    u.armL.el.rotation.x = eL; u.armR.el.rotation.x = eR;
    // Тень под ногами: в прыжке меньше и бледнее.
    const sc = 0.9 - jump * 0.25;
    u.blob.scale.set(sc, sc, sc); u.blob.position.x = Math.sin(ry) * dz; u.blob.position.z = Math.cos(ry) * dz; u.blob.material.opacity = 1 - jump * 0.45;
  }
  function setPlayers(list) {
    const seen = new Set();
    for (const p of list) {
      seen.add(p.id);
      let rec = players.get(p.id);
      if (!rec || rec.group.userData.key !== tokenKey(p)) {
        if (rec) { scene.remove(rec.group); disposeToken(rec.group); }
        rec = { group: playerToken(p), target: toWorld(p.spot) };
        rec.group.position.copy(rec.target);
        players.set(p.id, rec);
      }
      rec.info = p;
      paintLabel(rec.group, p);
      rec.target = toWorld(p.spot);
      // Куда смотрит: yaw (радианы, 0 — на сетку, π/2 — влево, к 4-й зоне) или face — точка площадки.
      if (p.yaw != null) rec.yaw = p.yaw;
      else if (p.face) { const f = toWorld(p.face); rec.yaw = Math.atan2(-(f.x - rec.target.x), -(f.z - rec.target.z)); }
      else rec.yaw = 0;
      rec.pinned = !!p.pinned; // игрок у мяча: его не толкают, он толкает других
      rec.hl = !!p.hl;
      const u = rec.group.userData;
      u.jersey.color.set(p.libero ? kit.libero : p.setter ? kit.setter : kit.main);
      u.jersey.emissive.set(p.hl ? 0x5a4512 : 0x000000);
      // Движение: новое действие запускается, когда меняется его ключ.
      if (p.act && p.act.key !== u.actKey) { u.actKey = p.act.key; u.act = { type: p.act.type, t0: clock() }; }
      rec.group.userData.ring.material.opacity = p.selected ? 1 : p.server ? 0.55 : 0;
      rec.group.userData.ring.material.color.set(p.selected ? COLORS.coral : COLORS.mint);
    }
    for (const [id, rec] of players) if (!seen.has(id)) { scene.remove(rec.group); disposeToken(rec.group); players.delete(id); }
  }
  function setLabelMode(mode) {
    labelMode = mode;
    for (const rec of players.values()) { rec.group.userData.labelText = null; paintLabel(rec.group, rec.info ?? {}); }
  }

  // ---------- Метки: отмеченные точки и следы ----------
  const marks = new THREE.Group(); scene.add(marks);
  const dots = new THREE.Group(); scene.add(dots);
  const trails = new THREE.Group(); scene.add(trails);

  // ---------- Руки блока ----------
  // Блокирующие: две руки над сеткой. side 'them' — блок соперника (перед нашим нападающим), 'us' — наш блок.
  const hands = new THREE.Group(); scene.add(hands);
  const skin = { them: new THREE.MeshStandardMaterial({ color: 0xff8a7a, roughness: 0.55, transparent: true, opacity: 0.92 }),
    us: new THREE.MeshStandardMaterial({ color: 0x8fd8b4, roughness: 0.55, transparent: true, opacity: 0.92 }) };
  skin.them.userData.shared = skin.us.userData.shared = true;
  const armGeo = new THREE.CapsuleGeometry(0.075, 0.75, 4, 12), palmGeo = new THREE.BoxGeometry(0.19, 0.26, 0.06);
  const bodyGeo = new THREE.CapsuleGeometry(0.26, 1.15, 4, 16);
  const ghost = new THREE.MeshStandardMaterial({ color: 0xff6363, roughness: 0.7, transparent: true, opacity: 0.35 });
  ghost.userData.shared = true;
  const hitGeo = new THREE.BoxGeometry(1.0, 1.3, 0.7);
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  let handsKey = '';
  function setHands(list = []) {
    const key = JSON.stringify(list);
    if (key === handsKey) return;
    handsKey = key;
    hands.clear();
    for (const h of list) {
      const g = new THREE.Group();
      const dz = h.side === 'them' ? -0.3 : 0.3; // руки — над своей половиной, чуть за сеткой
      // Блокирующий соперника — полупрозрачный силуэт под руками (своих игроков видно и так).
      if (h.side === 'them') { const b = new THREE.Mesh(bodyGeo, ghost); b.position.set(0, 0.85, -0.55); g.add(b); }
      for (const sx of [-0.2, 0.2]) {
        const arm = new THREE.Mesh(armGeo, skin[h.side]);
        arm.position.set(sx, NET_H + 0.2, dz);
        arm.rotation.x = h.side === 'them' ? 0.28 : -0.28; // руки наклонены над сеткой
        arm.castShadow = true;
        const palm = new THREE.Mesh(palmGeo, skin[h.side]);
        palm.position.set(sx * 1.08, NET_H + 0.68, dz + (h.side === 'them' ? 0.12 : -0.12));
        palm.rotation.x = arm.rotation.x;
        g.add(arm, palm);
      }
      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.position.set(0, NET_H + 0.35, dz);
      hit.userData.hands = h.side;
      g.add(hit);
      g.position.x = h.x - 4.5;
      hands.add(g);
    }
  }

  // ---------- Мяч ----------
  const BALL_R = 0.105;
  const ballGeo = new THREE.SphereGeometry(BALL_R, 40, 28);
  const ballMat = new THREE.MeshStandardMaterial({ map: ballTexture(), roughness: 0.42 });
  ballMat.userData.shared = true;

  // ---------- Предпросмотр: линии за мышью ----------
  // Перерисовываются на каждое движение мыши, поэтому геометрия переиспользуется, а не создаётся заново.
  const previews = [0, 1, 2].map(() => {
    const geo = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 41 }, () => new THREE.Vector3()));
    const solid = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: COLORS.white, transparent: true, opacity: 0.95 }));
    const dashed = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: COLORS.white, dashSize: 0.22, gapSize: 0.14, transparent: true, opacity: 0.9 }));
    const tip = new THREE.Mesh(ballGeo, ballMat);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.3, 32), new THREE.MeshBasicMaterial({ color: COLORS.white, side: THREE.DoubleSide, transparent: true }));
    ring.rotation.x = -Math.PI / 2;
    solid.visible = dashed.visible = tip.visible = ring.visible = false;
    scene.add(solid, dashed, tip, ring);
    return { geo, solid, dashed, tip, ring };
  });
  // list: [{ from, to, y0, y1, apex, color, dashed, ball }]
  function setPreview(list = []) {
    previews.forEach((pv, k) => {
      const t = list[k];
      pv.solid.visible = pv.dashed.visible = pv.tip.visible = pv.ring.visible = false;
      if (!t) return;
      const pts = arcPoints(t.from, t.to, t.y0 ?? 1, t.y1 ?? 0.1, t.apex ?? 2, 40);
      const pos = pv.geo.attributes.position;
      pts.forEach((v, i) => pos.setXYZ(i, v.x, v.y, v.z));
      pos.needsUpdate = true;
      pv.geo.computeBoundingSphere();
      const line = t.dashed ? pv.dashed : pv.solid;
      if (t.dashed) pv.dashed.computeLineDistances();
      line.material.color.set(t.color ?? COLORS.white);
      line.visible = true;
      pv.ring.visible = true;
      pv.ring.material.color.set(t.color ?? COLORS.white);
      pv.ring.position.set(pts.at(-1).x, 0.015, pts.at(-1).z);
      if (t.ball) { pv.tip.visible = true; pv.tip.position.copy(t.ballAtEnd ? pts.at(-1) : pts[Math.round(pts.length * 0.35)]); }
    });
  }
  const marker = (p, color, r = 0.32) => {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.72, r, 40), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.012;
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.2, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6 }));
    pin.position.y = 0.6;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 16), new THREE.MeshBasicMaterial({ color }));
    head.position.y = 1.2;
    g.add(ring, pin, head);
    g.position.copy(toWorld(p));
    return g;
  };
  function setPending({ from, to } = {}) {
    clearGroup(marks);
    if (from) marks.add(marker(from, COLORS.sky));
    if (to) marks.add(marker(to, COLORS.coral));
  }
  // Точки прошлых касаний: мелкие диски на полу.
  const dotGeo = new THREE.CircleGeometry(0.11, 20);
  const dotMats = new Map(); // один материал на цвет — точек бывают сотни
  const dotMat = (color, opacity) => {
    const k = `${color}:${opacity}`;
    if (!dotMats.has(k)) { const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity }); m.userData.shared = true; dotMats.set(k, m); }
    return dotMats.get(k);
  };
  let dotsKey = '';
  function setDots(list = []) {
    const key = JSON.stringify(list);
    if (key === dotsKey) return; // ничего не поменялось — не пересоздаём
    dotsKey = key;
    dots.clear(); // геометрия и материалы общие — их не освобождаем
    for (const d of list) {
      const m = new THREE.Mesh(dotGeo, dotMat(d.color ?? COLORS.white, d.opacity ?? 0.7));
      m.rotation.x = -Math.PI / 2;
      m.position.copy(toWorld(d)); m.position.y = 0.008;
      dots.add(m);
    }
  }

  // Траектории: [{ from, to, y0, y1, apex, color, ball }]. Последняя с ball=true — по ней летит мяч.
  // Мяч вращается по ходу полёта, под ним — пятно тени (по нему легче понять высоту).
  const ball = new THREE.Mesh(ballGeo, ballMat);
  ball.castShadow = true; ball.visible = false; scene.add(ball);
  const ballBlob = new THREE.Mesh(G.blob, MAT.blob.clone()); ballBlob.material.userData = {};
  ballBlob.rotation.x = -Math.PI / 2; ballBlob.position.y = 0.006; ballBlob.visible = false; scene.add(ballBlob);
  const ballPrev = new THREE.Vector3(), spinAxis = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  function spinBall(dt) {
    ballBlob.visible = ball.visible;
    if (!ball.visible) return;
    const d = ball.position.clone().sub(ballPrev), dist = d.length();
    ballPrev.copy(ball.position);
    ballBlob.position.x = ball.position.x; ballBlob.position.z = ball.position.z;
    const s = Math.max(0.12, 0.5 - ball.position.y * 0.08);
    ballBlob.scale.set(s, s, s); ballBlob.material.opacity = Math.max(0.25, 1 - ball.position.y * 0.18);
    if (dist < 1e-4 || dist > 3) return; // стоит на месте или «прыгнул» к новому розыгрышу
    spinAxis.crossVectors(UP, d).normalize(); // катится «вперёд» по направлению полёта (верхнее вращение)
    if (spinAxis.lengthSq() > 0) ball.rotateOnWorldAxis(spinAxis, (dist / BALL_R) * 0.7);
  }
  let flight = null, manualBall = false;
  // Мяч по времени видео (повтор розыгрыша): позицию задаёт студия, анимация полёта выключается.
  function setBall(p) {
    manualBall = !!p;
    if (p) { flight = null; ball.visible = true; ball.position.copy(toWorld(p, p.h ?? 0.5)); }
    else if (!flight) ball.visible = false;
  }
  let trailsKey = '';
  function setTrails(list = [], { animate = true } = {}) {
    const key = JSON.stringify(list);
    if (key === trailsKey) return; // та же картинка — мяч продолжает лететь, а не начинает заново
    trailsKey = key;
    clearGroup(trails);
    const curves = [];
    for (const t of list) {
      const pts = arcPoints(t.from, t.to, t.y0 ?? 0.5, t.y1 ?? 0.1, t.apex ?? 3, 48);
      const curve = new THREE.CatmullRomCurve3(pts);
      curves.push(curve);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 64, t.width ?? 0.035, 8, false),
        new THREE.MeshBasicMaterial({ color: t.color ?? COLORS.white, transparent: true, opacity: t.opacity ?? 0.9 }));
      trails.add(tube);
      // Тень траектории на полу — легче читать направление сверху.
      const shadowPts = pts.map(v => new THREE.Vector3(v.x, 0.006, v.z));
      const sh = new THREE.Line(new THREE.BufferGeometry().setFromPoints(shadowPts), new THREE.LineDashedMaterial({ color: t.color ?? COLORS.white, dashSize: 0.18, gapSize: 0.12, transparent: true, opacity: 0.45 }));
      sh.computeLineDistances();
      trails.add(sh);
      const end = new THREE.Mesh(new THREE.CircleGeometry(0.16, 24), new THREE.MeshBasicMaterial({ color: t.color ?? COLORS.white }));
      end.rotation.x = -Math.PI / 2; end.position.set(pts.at(-1).x, 0.009, pts.at(-1).z);
      trails.add(end);
    }
    flight = animate && curves.length && !manualBall ? { curves, k: 0, t: 0 } : null;
    ball.visible = !!flight || manualBall;
  }

  // ---------- Камера ----------
  const VIEWS = {
    persp: { pos: [0, 10.5, 16.5], target: [0, 0, 2.2] },
    top: { pos: [0, 27, 0.01], target: [0, 0, 0] },
    side: { pos: [17, 6.5, 0], target: [0, 1, 0] },
    behind: { pos: [0, 4.2, 14.5], target: [0, 1.6, -3] },
    their: { pos: [0, 12.5, -19], target: [0, 0, -1] },
  };
  let camAnim = null;
  function setView(name) {
    const v = typeof name === 'object' ? name : VIEWS[name] || VIEWS.persp; // можно передать { pos, target }
    camAnim = { pos: new THREE.Vector3(...v.pos), target: new THREE.Vector3(...v.target), k: 0 };
  }

  // ---------- Мышь: клик по полу ----------
  const ray = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const netPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); // вертикальная плоскость сетки
  const ndc = new THREE.Vector2();
  const hover = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.26, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
  hover.rotation.x = -Math.PI / 2; hover.visible = false; scene.add(hover);
  const pickables = () => [...[...players.values()].map(r => r.group.userData.body), ...hands.children.map(g => g.children.at(-1))];
  // Во что попала мышь: игрок или руки блока (точку пола считаем всегда — она тоже нужна).
  const pickHit = e => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    // Всё, во что попала мышь: игрок, руки блока, сетка. Что важнее — решает студия по шагу ввода.
    const out = {};
    for (const h of ray.intersectObjects(pickables(), false)) {
      const o = h.object;
      if (o.userData.pid && !out.player) out.player = o.userData.pid;
      if (o.userData.hands && !out.hands) out.hands = o.userData.hands;
    }
    const q = new THREE.Vector3();
    if (ray.ray.intersectPlane(netPlane, q) && q.y > 0.4 && q.y < NET_H + 1.4 && q.x > -5.2 && q.x < 5.2) out.net = { x: +(q.x + 4.5).toFixed(2) };
    return out.player || out.hands || out.net ? out : null;
  };
  const pick = e => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(groundPlane, hit)) return null;
    const p = toCourt(hit);
    if (p.x < -4 || p.x > 13 || p.y < -5 || p.y > 23) return null; // мимо зала
    return p;
  };
  // Клик отличаем от вращения: если мышь сдвинулась больше чем на 5 px — это было вращение.
  let down = null;
  renderer.domElement.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    const p = pick(e);
    if (p) onPick?.(p, e, pickHit(e));
  });
  // Правая кнопка — альтернативное действие (например, «мяч подняли» вместо «очко»).
  renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
  renderer.domElement.addEventListener('pointermove', e => {
    const p = pick(e);
    const hit = pickHit(e);
    renderer.domElement.style.cursor = hit?.player || hit?.hands ? 'pointer' : 'crosshair';
    hover.visible = !!p && !hit?.player && !hit?.hands;
    if (p) { hover.position.copy(toWorld(p)); hover.position.y = 0.014; }
    onHover?.(p && { ...p, zone: zoneOf(p) }, e, hit);
  });
  // Колесо: когда идёт ввод паса — меняет высоту дуги, иначе — обычный зум камеры.
  let wheelCapture = false;
  renderer.domElement.addEventListener('wheel', e => {
    if (!wheelCapture) return;
    e.preventDefault(); e.stopImmediatePropagation();
    onWheel?.(Math.sign(e.deltaY), e);
  }, { capture: true, passive: false });
  renderer.domElement.addEventListener('pointerleave', () => { hover.visible = false; onHover?.(null); });

  // ---------- Цикл отрисовки ----------
  function resize() {
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(el);
  resize();

  let last = performance.now();
  renderer.setAnimationLoop(rt => {
    const now = clock(rt);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (camAnim) {
      camAnim.k = Math.min(1, camAnim.k + dt * 2.2);
      const e = 1 - Math.pow(1 - camAnim.k, 3);
      camera.position.lerp(camAnim.pos, e * 0.35);
      controls.target.lerp(camAnim.target, e * 0.35);
      if (camAnim.k >= 1 && camera.position.distanceTo(camAnim.pos) < 0.05) camAnim = null;
    }
    // Переходы игроков: фишки плавно едут в новые зоны при смене расстановки.
    for (const rec of players.values()) rec.group.position.lerp(rec.target, Math.min(1, dt * 5));
    // Простая физика: фишки не входят друг в друга. Игрок у мяча (pinned) не сдвигается — расталкивает остальных.
    const recs = [...players.values()], R = 0.72;
    for (let it = 0; it < 3; it++) for (let i = 0; i < recs.length; i++) for (let j = i + 1; j < recs.length; j++) {
      const a = recs[i].group.position, b = recs[j].group.position;
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
      if (d >= R || d === 0) continue;
      const push = R - d, nx = dx / d, nz = dz / d;
      const wa = recs[i].pinned ? 0 : recs[j].pinned ? 1 : 0.5, wb = 1 - wa;
      a.x -= nx * push * wa; a.z -= nz * push * wa;
      b.x += nx * push * wb; b.z += nz * push * wb;
    }
    // Пульс подсветки.
    const pulse = 0.55 + 0.4 * Math.sin(now / 160);
    for (const rec of players.values()) { rec.group.userData.glow.material.opacity = rec.hl ? pulse : 0; animate(rec, dt, now); }
    if (flight) {
      flight.t += dt * 1.6;
      // Мяч пролетает розыгрыш один раз и остаётся в последней точке.
      if (flight.t >= 1) {
        if (flight.k < flight.curves.length - 1) { flight.t = 0; flight.k++; } else flight.t = 1;
      }
      ball.position.copy(flight.curves[flight.k].getPointAt(Math.min(1, flight.t)));
    }
    spinBall(dt);
    controls.update();
    renderer.render(scene, camera);
  });

  // Экранные координаты точки площадки (для всплывающих меню возле точки).
  function project(p, h = 0) {
    const v = toWorld(p, h).project(camera);
    return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight };
  }

  return {
    setPlayers, setLabelMode, setKit, setPending, setDots, setTrails, setView, resize, setHands, setPreview, project, setBall,
    setWheelCapture: on => { wheelCapture = on; controls.enableZoom = !on; },
    toggleZones: on => { zoneGrid.visible = on ?? !zoneGrid.visible; return zoneGrid.visible; },
    dispose: () => { renderer.setAnimationLoop(null); renderer.dispose(); },
  };
}
