// 3D-площадка: клик по полу → точка в метрах площадки, вращение и зум мышью,
// фишки игроков по зонам текущей расстановки, траектории мяча (пас, атака, подача).
// Координаты площадки (x 0…9, y 0…18, сетка на y=9) переводятся в мир three.js так:
//   X = x − 4.5,  Z = 9 − y  (наша половина ближе к камере),  Y — вверх.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/three/OrbitControls.js';
import { NET_H, zoneOf } from '../court.js';
import { SPEED, GRAVITY, READY, ACTIONS, sampleAction, jumpAt, actTime, gait, arcAt, arcVelocity, flightTime } from './motion.js';
import { buildFigure, applyPose, anchorOf, figureMaterials, sharedFigureGeometries } from './figure3d.js';

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
function labelTexture(text, { bg = 'rgba(14,16,20,.55)', fg = '#f2f3f5', ring = null } = {}) {
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
  controls.maxDistance = 80;

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
  const players = new Map(); // id → { group, target, vel, yaw, … }
  // Игрок — фигура с суставами (figure3d.js): «реалистичная» или «простая» (переключатель на панели).
  // Смотрит на сетку (−Z), поэтому с нашей камеры виден номер на спине. Движения — ключевые позы (motion.js):
  // стойка, бег и приставной шаг, приём, пас, нападающий удар с разбега в три шага, блок, подача.
  const FM = figureMaterials();
  const G = {
    hit: new THREE.CylinderGeometry(0.36, 0.36, 2.0, 10), blob: new THREE.PlaneGeometry(1, 1),
    glow: new THREE.RingGeometry(0.42, 0.62, 40), ring: new THREE.RingGeometry(0.45, 0.55, 40),
  };
  const MAT = {
    hit: new THREE.MeshBasicMaterial({ visible: false }),
    blob: new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false }),
  };
  for (const m of Object.values(MAT)) m.userData.shared = true;
  let kit = { ...KIT_DEFAULT };
  // Форма команды из настроек. Цифры «запечены» в текстуру — при смене их цвета фигуры пересоздаются сами (ключ фигуры).
  function setKit(k = {}) {
    kit = { ...KIT_DEFAULT, ...Object.fromEntries(Object.entries(k).filter(([, v]) => v)) };
    for (const m of [FM.shorts, FM.shortsReal, FM.trim]) m.color.set(kit.shorts);
  }
  let detail = 'real';

  // Номер на форме: настоящий (0 — тоже номер), а если поле пустое — порядковый в составе. Номер есть всегда.
  const numberOf = p => (p.num != null && p.num !== '' ? p.num : p.seq ?? '');
  // Подписи: 'num' — номер, 'name' — три буквы имени, 'full' — номер и три буквы, 'none' — без подписи.
  let labelMode = 'num';
  const labelText = info => {
    const num = String(numberOf(info)), name = (info.name || '').trim().slice(0, 3); // на плашке — первые три буквы
    if (labelMode === 'none') return '';
    if (labelMode === 'name') return name || num;
    if (labelMode === 'full') return [num, name].filter(Boolean).join(' ');
    return num;
  };
  function paintLabel(g, info) {
    const u = g.userData, text = labelText(info);
    u.sprite.visible = !!text;
    if (!text || text === u.labelText) return;
    u.labelText = text;
    u.sprite.material.map?.dispose();
    const { tex, aspect } = labelTexture(text);
    u.sprite.material.map = tex; u.sprite.material.needsUpdate = true;
    const h = 0.026; // размер на экране, не зависит от близости к камере
    u.sprite.scale.set(h * aspect, h, 1);
  }

  function playerToken(p) {
    const g = new THREE.Group();
    const hit = new THREE.Mesh(G.hit, MAT.hit); // невидимый «корпус» для клика
    hit.position.y = 1.0; hit.userData.pid = p.id;
    g.add(hit);
    const numTex = numberTexture(numberOf(p), kit.number);
    const rig = buildFigure(g, { detail, M: FM, numTex, id: p.id });
    // Пятно-тень под ногами: на полу всегда, в прыжке — бледнее и меньше.
    const bm = MAT.blob.clone(); bm.userData = {};
    const blob = new THREE.Mesh(G.blob, bm); blob.rotation.x = -Math.PI / 2; blob.position.y = 0.007; blob.scale.setScalar(0.9);
    g.add(blob);
    // Подсветка «скорее всего этот игрок»: пульсирующее янтарное кольцо.
    const glow = new THREE.Mesh(G.glow, new THREE.MeshBasicMaterial({ color: COLORS.amber, transparent: true, opacity: 0, depthWrite: false }));
    glow.rotation.x = -Math.PI / 2; glow.position.y = 0.012;
    g.add(glow);
    const ring = new THREE.Mesh(G.ring, new THREE.MeshBasicMaterial({ color: COLORS.coral, transparent: true, opacity: 0 }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.01;
    g.add(ring);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, sizeAttenuation: false, transparent: true }));
    sprite.position.y = 2.32; sprite.renderOrder = 10;
    g.add(sprite);
    g.userData = { body: hit, rig, jersey: rig.jersey, ring, glow, sprite, blob, key: tokenKey(p), phase: Math.random() * 6, act: null, actKey: null, seed: Math.random() * 10, P: { ...READY } };
    paintLabel(g, p);
    scene.add(g);
    return g;
  }
  const tokenKey = p => `${numberOf(p)}|${kit.number}|${detail}`;
  // Удаление фигуры: свои материалы и текстуры освобождаем, общие геометрии и материалы — нет.
  const shared = new Set([...sharedFigureGeometries(), ...Object.values(G)]);
  function disposeToken(g) {
    g.traverse(o => {
      if (o.isSkinnedMesh) o.skeleton.dispose();
      if (o.geometry && !shared.has(o.geometry)) o.geometry.dispose();
      if (o.material && !o.material.userData.shared) { if (o.material.map !== MAT.blob.map) o.material.map?.dispose(); o.material.dispose(); }
    });
  }

  // Время: движения в motion.js — в секундах «как в жизни», на экране — в SPEED раз быстрее.
  const ms = s => (s / SPEED) * 1000;
  const TMP = {};
  const JUMP = { att: 0.75, blk: 0.6, serve: 0.5 };
  function startAct(rec, type, t0, extra = {}) {
    const A = ACTIONS[type];
    rec.group.userData.act = { type, t0, tc: ms(A.tc), dur: ms(A.dur), hold: false, rel: null, ...extra };
    return rec.group.userData.act;
  }
  const forwardOf = yaw => new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const rotY = (v, yaw) => new THREE.Vector3(v.x * Math.cos(yaw) + v.z * Math.sin(yaw), v.y, -v.x * Math.sin(yaw) + v.z * Math.cos(yaw));
  // Где мяч в момент касания относительно ступней игрока (лицом к сетке): считаем один раз на «пробной» фигуре.
  const offCache = new Map();
  function contactOffset(type) {
    const key = `${detail}:${type}`;
    if (!offCache.has(key)) {
      const root = new THREE.Group();
      const rig = buildFigure(root, { detail, M: FM, numTex: null, id: '' });
      rig.fig.scale.setScalar(1);
      applyPose(rig, sampleAction(type, ACTIONS[type].tc), 0);
      root.updateMatrixWorld(true);
      offCache.set(key, anchorOf(rig, ACTIONS[type].anchor).clone());
      root.traverse(o => { if (o.isSkinnedMesh) o.skeleton.dispose(); if (o.material && !o.material.userData.shared) o.material.dispose(); });
    }
    return offCache.get(key);
  }

  // Перемещение по площадке: разгон и торможение (не «телепорт» и не равномерное скольжение).
  // На шаге розыгрыша игрок бежит к точке касания (goal); на разбеге и подаче позицию задаёт само движение (path).
  const VMAX = 6.5, ACC = 22;
  function updateMotion(rec, dt, now) {
    const u = rec.group.userData, pos = rec.group.position, a = u.act;
    rec.vel ??= new THREE.Vector3();
    if (a?.path && now >= a.t0) {
      const f = sampleAction(a.type, actTime(a, now), TMP).fwd;
      // Если к началу разбега игрок не совсем добежал — подтягиваем плавно, без скачка.
      a.path.blend ??= { x: pos.x - a.path.o.x - a.path.d.x * f, z: pos.z - a.path.o.z - a.path.d.z * f, t: now };
      const k = Math.max(0, 1 - (now - a.path.blend.t) / 300);
      const nx = a.path.o.x + a.path.d.x * f + a.path.blend.x * k, nz = a.path.o.z + a.path.d.z * f + a.path.blend.z * k;
      // На редких кадрах шаг большой, а dt ограничен: без предела скорость «выстреливает» и игрока уносит за площадку.
      rec.vel.set((nx - pos.x) / Math.max(dt, 1e-3), 0, (nz - pos.z) / Math.max(dt, 1e-3)).clampLength(0, VMAX);
      pos.x = nx; pos.z = nz;
      rec.driven = true;
      return;
    }
    rec.driven = false;
    // Цель «добежать к касанию» держится, пока игрок держит мяч, и ещё немного после.
    const holding = a?.scripted && a.hold && (a.rel == null || now < a.rel);
    if (rec.goal && !holding && now > rec.goal.t + 600) rec.goal = null;
    const to = rec.goal?.to ?? rec.target;
    const dx = to.x - pos.x, dz = to.z - pos.z, dist = Math.hypot(dx, dz);
    const v = dist < 0.01 ? 0 : Math.min(VMAX, Math.sqrt(2 * ACC * dist));
    const wx = dist > 1e-4 ? (dx / dist) * v : 0, wz = dist > 1e-4 ? (dz / dist) * v : 0;
    let ex = wx - rec.vel.x, ez = wz - rec.vel.z;
    const el = Math.hypot(ex, ez), lim = ACC * dt * 1.6;
    if (el > lim) { ex *= lim / el; ez *= lim / el; }
    rec.vel.x += ex; rec.vel.z += ez;
    pos.x += rec.vel.x * dt; pos.z += rec.vel.z * dt;
  }

  // Поза на кадр: движение (если идёт) или стойка, поверх — бег по скорости; разворот — плавно.
  function animate(rec, dt, now) {
    const u = rec.group.userData, rig = u.rig, P = u.P;
    let a = u.act, s = 0;
    if (a && now >= a.t0) {
      s = actTime(a, now);
      if (s >= ACTIONS[a.type].dur) { u.act = a = null; rec.yawOverride = null; }
    }
    const active = !!a && now >= a.t0;
    if (active) sampleAction(a.type, s, P);
    else {
      Object.assign(P, READY);
      const br = Math.sin(now / 520 + u.seed); // дыхание и лёгкое покачивание в стойке
      P.kL += 0.05 * br; P.hL += 0.025 * br; P.kR += 0.05 * br; P.hR += 0.025 * br; P.lean += 0.015 * Math.sin(now / 900 + u.seed);
    }
    // Разворот: плавно к нужному углу (по кратчайшей дуге).
    const ry0 = rig.fig.rotation.y;
    let dy = (rec.yawOverride ?? rec.yaw ?? 0) - ry0;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    rig.fig.rotation.y += dy * Math.min(1, dt * (active ? 10 : 7));
    const ry = rig.fig.rotation.y;
    // Бег: скорость в системе игрока — вперёд/назад и вбок (приставной шаг).
    const vx = rec.vel?.x ?? 0, vz = rec.vel?.z ?? 0, sp = Math.hypot(vx, vz);
    const vf = -(vx * Math.sin(ry) + vz * Math.cos(ry)), vs = vx * Math.cos(ry) - vz * Math.sin(ry);
    u.phase += dt * (4 + sp * 2.4);
    if (!rec.driven) gait(P, u.phase, vf, vs, active ? (a.type === 'blk' ? 0 : 0.8) : 1, active ? 0 : 1);
    const jump = active ? jumpAt(a.type, s, a.H ?? JUMP[a.type] ?? 0) : 0;
    applyPose(rig, P, jump);
    u.sprite.position.y = 2.32 + jump; // подпись прыгает вместе с игроком и не закрывает его
    // Движение «на месте» (повтор по видео): разбег/подача рисуются со смещением назад и приходят в точку.
    let ox = 0, oz = 0;
    if (active && a.local) { const f = P.fwd - a.local; ox = -Math.sin(ry) * f; oz = -Math.cos(ry) * f; }
    rig.fig.position.x = ox; rig.fig.position.z = oz;
    // Тень под ногами: в прыжке меньше и бледнее.
    const sc = 0.9 - jump * 0.25;
    u.blob.scale.set(sc, sc, sc); u.blob.position.x = ox; u.blob.position.z = oz; u.blob.material.opacity = 1 - jump * 0.45;
  }
  // Перенести состояние со старой фигуры на новую (сменилась детализация или номер).
  function carry(from, to) {
    to.position.copy(from.position);
    const a = from.userData, b = to.userData;
    Object.assign(b, { act: a.act, actKey: a.actKey, phase: a.phase });
    b.rig.fig.rotation.y = a.rig.fig.rotation.y;
  }
  function setPlayers(list) {
    const seen = new Set();
    for (const p of list) {
      seen.add(p.id);
      let rec = players.get(p.id);
      if (!rec || rec.group.userData.key !== tokenKey(p)) {
        const g = playerToken(p);
        if (rec) { carry(rec.group, g); scene.remove(rec.group); disposeToken(rec.group); rec.group = g; }
        else { rec = { group: g, vel: new THREE.Vector3() }; g.position.copy(toWorld(p.spot)); players.set(p.id, rec); }
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
      // Движение по ключу (повтор по видео): разбег и подача — «на месте», со смещением.
      if (p.act && p.act.key !== u.actKey) {
        u.actKey = p.act.key;
        const t = p.act.type;
        if (ACTIONS[t]) startAct(rec, t, clock(), t === 'att' || t === 'serve' ? { local: ACTIONS[t].keys.at(-1)[1].fwd } : {});
      }
      rec.group.userData.ring.material.opacity = p.selected ? 1 : p.server ? 0.55 : 0;
      rec.group.userData.ring.material.color.set(p.selected ? COLORS.coral : COLORS.mint);
    }
    for (const [id, rec] of players) if (!seen.has(id)) { scene.remove(rec.group); disposeToken(rec.group); players.delete(id); }
  }
  // Детализация фигур: 'real' — реалистичные, 'simple' — минималистичные (легче для слабых ноутбуков).
  function setDetail(mode) {
    mode = mode === 'simple' ? 'simple' : 'real';
    if (mode === detail) return;
    detail = mode;
    setPlayers([...players.values()].map(r => r.info).filter(Boolean));
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
      if (t.ball && !D.on) { pv.tip.visible = true; pv.tip.position.copy(t.ballAtEnd ? pts.at(-1) : pts[Math.round(pts.length * 0.35)]); }
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
  function spinBall(dt, held = false) {
    ballBlob.visible = ball.visible;
    if (!ball.visible) return;
    const d = ball.position.clone().sub(ballPrev), dist = d.length();
    ballPrev.copy(ball.position);
    if (held) { ballBlob.position.x = ball.position.x; ballBlob.position.z = ball.position.z; return; } // в руках не крутится
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
    if (p && !manualBall && D.on) resetScript(); // повтор по видео: шаги ввода сбрасываем, потом — заново с итога
    manualBall = !!p;
    if (p) { flight = null; ball.visible = true; ball.position.copy(toWorld(p, p.h ?? 0.5)); }
    else if (!flight && !D.on) ball.visible = false;
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
    if (D.on) return; // во время ввода мячом управляет сценарий шагов
    flight = animate && curves.length && !manualBall ? { curves, k: 0, t: 0 } : null;
    ball.visible = !!flight || manualBall;
  }

  // ---------- Мяч по шагам розыгрыша ----------
  // Во время ввода мяч ведёт «сценарий» из студии: список полётов розыгрыша [{ id, kind, from, to, y0, y1, apex,
  // by — кто отдаёт, byAct — его движение (подача), catcher — кто ловит, catchAs — как (rec/dig/set/att/blk) }].
  // Новый полёт начинается только когда его добавили (выбрали игрока): мяч летит по физике, а ловящий
  // успевает к нему — разбег и прыжок рассчитаны от момента касания. Пока следующий шаг не отмечен,
  // мяч ждёт у игрока (в «площадке» приёма, в ладонях связующего, у руки нападающего в прыжке).
  const HOLDS = { rec: 1, dig: 1, set: 1, att: 1 };
  const D = { on: false, rally: null, segs: [], queue: [], cur: null, hold: null, free: null, pending: null, pendingAt: 0 };
  const _anc = new THREE.Vector3(), _hold = new THREE.Vector3();
  const smooth01 = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
  const busy = now => !!(D.cur || D.queue.length || (D.free && !D.free.rest && now - D.free.t0 < 2200));
  function cancelScripted() {
    for (const rec of players.values()) {
      const u = rec.group.userData;
      if (u.act?.scripted) u.act = null;
      rec.goal = null; rec.yawOverride = null;
    }
  }
  function resetScript() { cancelScripted(); Object.assign(D, { rally: null, segs: [], queue: [], cur: null, hold: null, free: null, pending: null }); }
  function setScript(s) {
    if (!s) {
      if (D.on) { resetScript(); ball.visible = !!flight || manualBall; }
      D.on = false;
      return;
    }
    if (!D.on) flight = null; // вместо «пролёта» всего розыгрыша — по шагам
    D.on = true;
    if (manualBall) return; // идёт повтор по видео — сценарий применится, когда он закончится
    if (D.rally !== s.rally) {
      // Новый розыгрыш: даём долететь последнему мячу (удар, эйс), потом — расстановка нового.
      if (D.rally !== null && busy(clock())) { D.pending = s; D.pendingAt = clock(); return; }
      return snap(s);
    }
    D.pending = null;
    const old = D.segs;
    let n = 0;
    while (n < old.length && n < s.segs.length && old[n].id === s.segs[n].id) n++;
    if (n === old.length) {
      D.queue.push(...s.segs.slice(n));
      D.segs = s.segs;
      return;
    }
    snap(s); // шаг отменили или переписали — сразу к итогу, без полёта
  }
  // Сразу показать итог сценария: кто держит мяч (в позе касания) или где мяч лежит.
  function snap(s) {
    cancelScripted();
    Object.assign(D, { rally: s.rally, segs: s.segs, queue: [], cur: null, hold: null, free: null, pending: null });
    const last = s.segs.at(-1);
    if (!last) {
      const r = s.start?.hold && players.get(s.start.hold);
      D.hold = r ? { pid: s.start.hold, part: 'handL' } : null;
      ball.visible = !!r;
      return;
    }
    const rec = last.catcher && players.get(last.catcher);
    if (rec && HOLDS[last.catchAs]) {
      const plan = catchPlan(rec, last);
      scheduleCatch(rec, plan, clock());
      D.hold = { pid: last.catcher, part: ACTIONS[plan.type].anchor };
      ball.visible = true;
      return;
    }
    ball.visible = true;
    ball.position.copy(toWorld(last.to, BALL_R));
    D.free = { v: new THREE.Vector3(), rest: true, t0: clock() };
  }

  // Как игрок встретит мяч: куда встать (root), куда смотреть, где будет мяч в момент касания.
  function catchPlan(rec, seg) {
    const type = seg.catchAs, P = toWorld(seg.to);
    let yaw = rec.yaw ?? 0;
    if ((type === 'rec' || type === 'dig') && seg.from) { const f = toWorld(seg.from); yaw = Math.atan2(-(f.x - P.x), -(f.z - P.z)); }
    if (type === 'att') {
      // Разбег — к мячу со стороны игрока, в основном от сетки к ней (как в жизни: из-за трёхметровой и с края).
      const c = rec.group.position;
      let bx = c.x - P.x, bz = c.z - P.z;
      const bl = Math.hypot(bx, bz) || 1;
      bx = (bx / bl) * 0.6; bz = (bz / bl) * 0.6 + 1;
      const vl = Math.hypot(bx, bz);
      yaw = Math.atan2(bx / vl, bz / vl);
    }
    const off = rotY(contactOffset(type), yaw);
    const plan = { type, yaw, off, root: new THREE.Vector3(P.x - off.x, 0, P.z - off.z), H: 0 };
    if (type === 'att') plan.H = THREE.MathUtils.clamp((seg.y1 ?? 3) - off.y, 0.4, 1.0);
    if (type === 'blk') plan.H = JUMP.blk;
    plan.ballAt = new THREE.Vector3(P.x, off.y + jumpAt(type, ACTIONS[type].tc, plan.H), P.z);
    return plan;
  }
  const fwdAt = (type, s) => sampleAction(type, s, TMP).fwd;
  // Сколько времени (мс) нужно игроку до касания: добежать и выполнить подготовку (у нападающего — весь разбег).
  function leadTime(rec, plan) {
    const A = ACTIONS[plan.type], pos = rec.group.position;
    if (plan.type === 'att') {
      const F = fwdAt('att', A.tc), f = forwardOf(plan.yaw);
      const jd = Math.hypot(pos.x - (plan.root.x - f.x * F), pos.z - (plan.root.z - f.z * F));
      return (jd > 0.25 ? (jd / VMAX + 0.35) * 1000 : 0) + ms(A.tc);
    }
    const d = Math.hypot(pos.x - plan.root.x, pos.z - plan.root.z);
    return Math.max(ms(A.tc), d > 0.2 ? (d / VMAX + 0.3) * 1000 + 80 : 0);
  }
  // Поставить движение ловящего так, чтобы касание пришлось ровно на момент прилёта мяча.
  function scheduleCatch(rec, plan, arrival) {
    const A = ACTIONS[plan.type], t0 = arrival - ms(A.tc);
    const extra = { scripted: true, hold: !!HOLDS[plan.type], H: plan.H };
    if (plan.type === 'att') {
      const f = forwardOf(plan.yaw), F = fwdAt('att', A.tc);
      const o = new THREE.Vector3(plan.root.x - f.x * F, 0, plan.root.z - f.z * F);
      extra.path = { o, d: f };
      rec.goal = { to: o, t: t0 };
    } else if (plan.type !== 'blk') rec.goal = { to: plan.root, t: arrival };
    rec.yawOverride = plan.type === 'set' || plan.type === 'blk' ? null : plan.yaw;
    return startAct(rec, plan.type, t0, extra);
  }

  function launchNext(now) {
    const seg = D.queue.shift();
    const cur = { seg, launchAt: now, p0: null, apex: seg.apex ?? 3 };
    const holder = D.hold && players.get(D.hold.pid);
    const thrower = seg.by && players.get(seg.by);
    if (seg.byAct === 'serve' && thrower) {
      // Подача: мяч в левой руке → подброс → удар правой в прыжке; мяч уходит в момент удара.
      const a = startAct(thrower, 'serve', now, { scripted: true, path: { o: thrower.group.position.clone(), d: forwardOf(thrower.yaw ?? 0) } });
      D.hold = { pid: seg.by, part: 'handL' };
      cur.launchAt = now + a.tc;
      cur.toss = { pid: seg.by, at: now + ms(ACTIONS.serve.toss) };
    } else if (holder) {
      cur.launchAt = now + (D.hold.part === 'hands' ? 40 : 0);
    } else {
      cur.p0 = toWorld(seg.from, seg.y0 ?? 1); // мяч от соперника — из точки, откуда его ударили
      D.hold = null; D.free = null;
    }
    const p0 = cur.p0 ?? (holder ? anchorOf(holder.group.userData.rig, D.hold.part, new THREE.Vector3()) : toWorld(seg.from, seg.y0 ?? 1));
    const catcher = seg.catcher && players.get(seg.catcher);
    let p1 = toWorld(seg.to, seg.y1 ?? 0.1);
    if (catcher && ACTIONS[seg.catchAs]) { cur.plan = catchPlan(catcher, seg); p1 = cur.plan.ballAt; cur.catcher = seg.catcher; }
    cur.T = ms(flightTime(seg.kind, Math.hypot(p1.x - p0.x, p1.z - p0.z), p0.y, p1.y, cur.apex));
    if (cur.plan) {
      // Игрок не успевает — мяч задерживается в руках у отдающего (нападающий успевает разбежаться).
      const arrival = Math.max(cur.launchAt + cur.T, now + leadTime(catcher, cur.plan));
      cur.launchAt = arrival - cur.T;
      scheduleCatch(catcher, cur.plan, arrival);
    }
    const ha = holder?.group.userData.act;
    if (ha?.scripted && ha.hold) ha.rel = cur.launchAt; // держал мяч — движение продолжается с момента броска
    cur.p1 = p1;
    D.cur = cur;
  }
  function holdBall() {
    const r = D.hold && players.get(D.hold.pid);
    if (!r) { ball.visible = false; return; }
    ball.visible = true;
    ball.position.copy(anchorOf(r.group.userData.rig, D.hold.part, _hold));
  }
  // После полёта без ловящего мяч летит сам: сила тяжести, отскок от пола, сетка, качение.
  function freeBall(dt) {
    const f = D.free;
    if (f.rest) return;
    const h = dt * SPEED, p = ball.position, z0 = p.z;
    f.v.y -= GRAVITY * h;
    p.addScaledVector(f.v, h);
    if (Math.sign(z0) !== Math.sign(p.z) && Math.abs(p.x) < 4.6 && p.y < NET_H) { p.z = z0; f.v.z *= -0.25; f.v.x *= 0.5; }
    if (Math.abs(p.x) > 9.6) { p.x = Math.sign(p.x) * 9.6; f.v.x *= -0.4; }
    if (p.z < -15.6) { p.z = -15.6; f.v.z *= -0.4; }
    if (p.y < BALL_R) {
      p.y = BALL_R;
      if (Math.abs(f.v.y) > 0.9) { f.v.y = -f.v.y * 0.55; f.v.x *= 0.78; f.v.z *= 0.78; }
      else {
        f.v.y = 0;
        const k = Math.max(0, 1 - 1.4 * h);
        f.v.x *= k; f.v.z *= k;
        if (Math.hypot(f.v.x, f.v.z) < 0.05) f.rest = true;
      }
    }
  }
  function stepScript(now, dt) {
    if (D.pending && (!busy(now) || now - D.pendingAt > 3500)) { const s = D.pending; D.pending = null; snap(s); }
    if (!D.cur && D.queue.length) launchNext(now);
    const c = D.cur;
    if (c) {
      ball.visible = true;
      if (now < c.launchAt) {
        if (c.toss && now >= c.toss.at) {
          // Подброс: из левой руки вверх к месту удара правой.
          const r = players.get(c.toss.pid);
          if (!r) return;
          c.toss.p0 ??= ball.position.clone();
          const k = (now - c.toss.at) / Math.max(1, c.launchAt - c.toss.at);
          anchorOf(r.group.userData.rig, 'spike', _anc);
          ball.position.lerpVectors(c.toss.p0, _anc, k).y += 1.1 * 4 * k * (1 - k);
        } else holdBall();
        return;
      }
      if (!c.p0) c.p0 = ball.position.clone();
      const u = Math.min(1, (now - c.launchAt) / c.T);
      const q = arcAt(c.p0, c.p1, c.apex, u);
      ball.position.set(q.x, q.y, q.z);
      // Под конец мяч «притягивается» к рукам ловящего — касание точно в ладони/на предплечья.
      const r = c.catcher && players.get(c.catcher);
      if (r) { anchorOf(r.group.userData.rig, ACTIONS[c.plan.type].anchor, _anc); ball.position.addScaledVector(_anc.sub(c.p1), smooth01((u - 0.5) / 0.5)); }
      if (u >= 1) {
        D.cur = null;
        if (r && HOLDS[c.plan.type]) { D.hold = { pid: c.catcher, part: ACTIONS[c.plan.type].anchor }; D.free = null; return; }
        D.hold = null;
        const v = arcVelocity(c.p0, c.p1, c.apex, (c.T / 1000) * SPEED);
        const fv = new THREE.Vector3(v.x, v.y, v.z);
        // Блок: очко — мяч отскакивает к сопернику; касание — мягко к нам, вверх; блок-аут — в сторону.
        if (c.plan?.type === 'blk') {
          if (c.seg.deflect === 'touch') fv.set(fv.x * 0.3, 2.5, fv.z * 0.25);
          else if (c.seg.deflect === 'out') fv.set(fv.x * 0.6 + Math.sign(ball.position.x || 1) * 3, 1.2, fv.z * 0.5);
          else fv.set(fv.x * 0.3, -1, -fv.z * 0.35);
        }
        D.free = { v: fv, rest: false, t0: now };
      }
      return;
    }
    if (D.hold) holdBall();
    else if (D.free) freeBall(dt);
  }

  // ---------- Камера ----------
  const VIEWS = {
    persp: { pos: [0, 10.5, 16.5], target: [0, 0, 2.2] },
    top: { pos: [0, 27, 0.01], target: [0, 0, 0] },
    side: { pos: [17, 6.5, 0], target: [0, 1, 0] },
    behind: { pos: [0, 4.2, 14.5], target: [0, 1.6, -3] },
    their: { pos: [0, 12.5, -19], target: [0, 0, -1] },
  };
  let camAnim = null, viewName = 'persp', userCam = false;
  controls.addEventListener('start', () => { userCam = true; camAnim = null; }); // повернули или приблизили сами — кадр больше не подгоняем
  // Кадр: вся площадка и подающий за лицевой — между инструментами сверху и кнопками снизу, при любой форме окна.
  const FRAME = [[-4.8, 0, -9.3], [4.8, 0, -9.3], [-4.8, 0, 10.5], [4.8, 0, 10.5], [3.1, 2.5, 10.1], [-4.6, 3.3, 0], [4.6, 3.3, 0]].map(a => new THREE.Vector3(...a));
  const INSET = { top: 46, bottom: 58 };
  const fitCam = new THREE.PerspectiveCamera();
  function frameBox(target, dir, d) {
    fitCam.position.copy(target).addScaledVector(dir, d);
    fitCam.lookAt(target);
    fitCam.updateMatrixWorld();
    const b = { x0: 9, x1: -9, y0: 9, y1: -9 }, v = new THREE.Vector3();
    for (const p of FRAME) {
      v.copy(p).project(fitCam);
      b.x0 = Math.min(b.x0, v.x); b.x1 = Math.max(b.x1, v.x); b.y0 = Math.min(b.y0, v.y); b.y1 = Math.max(b.y1, v.y);
    }
    return b;
  }
  // Подбираем расстояние по направлению ракурса, потом сдвигаем картинку в свободную часть окна (без смены угла).
  function fitView(v) {
    const w = el.clientWidth, h = el.clientHeight;
    const target = new THREE.Vector3(...v.target), pos = new THREE.Vector3(...v.pos);
    if (!w || !h || v === VIEWS.behind) { camera.clearViewOffset(); scene.fog.near = 40; scene.fog.far = 75; return { pos, target }; }
    Object.assign(fitCam, { fov: camera.fov, aspect: w / h, near: 0.1, far: 300 });
    fitCam.updateProjectionMatrix();
    const dir = pos.clone().sub(target).normalize(), free = (h - INSET.top - INSET.bottom) / h;
    let lo = 6, hi = 75;
    for (let i = 0; i < 18; i++) {
      const d = (lo + hi) / 2, b = frameBox(target, dir, d);
      if (b.x1 - b.x0 <= 1.94 && (b.y1 - b.y0) / 2 <= free * 0.985) hi = d; else lo = d;
    }
    const b = frameBox(target, dir, hi);
    const centerPx = (h / 2) * (1 - (b.y0 + b.y1) / 2), wantPx = INSET.top + (h - INSET.top - INSET.bottom) / 2;
    camera.setViewOffset(w, h, ((b.x0 + b.x1) / 2) * (w / 2), centerPx - wantPx, w, h);
    scene.fog.near = hi + 14; scene.fog.far = hi + 55;
    return { pos: target.clone().addScaledVector(dir, hi), target };
  }
  function setView(name) {
    const v = VIEWS[name] || VIEWS.persp;
    viewName = name; userCam = false;
    camAnim = { ...fitView(v), k: 0 };
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
    if (userCam) return;
    const f = fitView(VIEWS[viewName] || VIEWS.persp);
    if (camAnim) Object.assign(camAnim, { pos: f.pos, target: f.target });
    else { camera.position.copy(f.pos); controls.target.copy(f.target); }
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
    // Перемещения игроков: разгон и торможение к своей точке (или к мячу), разбег — по движению.
    for (const rec of players.values()) updateMotion(rec, dt, now);
    // Простая физика: фишки не входят друг в друга. Игрок у мяча (pinned) и игрок на разбеге не сдвигаются — расталкивают остальных.
    const recs = [...players.values()], R = 0.72;
    for (let it = 0; it < 3; it++) for (let i = 0; i < recs.length; i++) for (let j = i + 1; j < recs.length; j++) {
      const a = recs[i].group.position, b = recs[j].group.position;
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
      if (d >= R || d === 0) continue;
      const push = R - d, nx = dx / d, nz = dz / d;
      const fa = recs[i].pinned || recs[i].driven, fb = recs[j].pinned || recs[j].driven;
      if (fa && fb) continue;
      const wa = fa ? 0 : fb ? 1 : 0.5, wb = 1 - wa;
      a.x -= nx * push * wa; a.z -= nz * push * wa;
      b.x += nx * push * wb; b.z += nz * push * wb;
    }
    // Пульс подсветки.
    const pulse = 0.55 + 0.4 * Math.sin(now / 160);
    for (const rec of players.values()) { rec.group.userData.glow.material.opacity = rec.hl ? pulse : 0; animate(rec, dt, now); }
    if (D.on && !manualBall) stepScript(now, dt);
    else if (flight) {
      flight.t += dt * 1.6;
      // Мяч пролетает розыгрыш один раз и остаётся в последней точке.
      if (flight.t >= 1) {
        if (flight.k < flight.curves.length - 1) { flight.t = 0; flight.k++; } else flight.t = 1;
      }
      ball.position.copy(flight.curves[flight.k].getPointAt(Math.min(1, flight.t)));
    }
    spinBall(dt, D.on && D.hold && !D.cur);
    controls.update();
    renderer.render(scene, camera);
  });

  // Экранные координаты точки площадки (для всплывающих меню возле точки).
  function project(p, h = 0) {
    const v = toWorld(p, h).project(camera);
    return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight };
  }

  return {
    setPlayers, setLabelMode, setKit, setDetail, setPending, setDots, setTrails, setView, resize, setHands, setPreview, project, setBall, setScript,
    setWheelCapture: on => { wheelCapture = on; controls.enableZoom = !on; },
    toggleZones: on => { zoneGrid.visible = on ?? !zoneGrid.visible; return zoneGrid.visible; },
    dispose: () => { renderer.setAnimationLoop(null); renderer.dispose(); },
    debug: () => ({ camera, controls, players, scene }), // для проверок и скриншотов
  };
}
