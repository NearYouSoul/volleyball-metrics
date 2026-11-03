// 3D-площадка: клик по полу → точка в метрах площадки, вращение и зум мышью,
// фишки игроков по зонам текущей расстановки, траектории мяча (пас, атака, подача).
// Координаты площадки (x 0…9, y 0…18, сетка на y=9) переводятся в мир three.js так:
//   X = x − 4.5,  Z = 9 − y  (наша половина ближе к камере),  Y — вверх.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/three/OrbitControls.js';
import { NET_H, zoneOf } from '../court.js';

const toWorld = (p, h = 0) => new THREE.Vector3(p.x - 4.5, h, 9 - p.y);
const toCourt = v => ({ x: +(v.x + 4.5).toFixed(2), y: +(9 - v.z).toFixed(2) });

const COLORS = {
  floorOut: 0x14161a, courtUs: 0x2b5d8a, courtThem: 0x3a4d6b, line: 0xf2f2f2,
  coral: 0xff6363, mint: 0x59d499, sky: 0x63a1ff, amber: 0xf0c85a, white: 0xffffff,
};

// Текстура-надпись (номер игрока) для спрайта.
function labelTexture(text, { bg = '#e6e6e6', fg = '#111', ring = null } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.fillStyle = bg; g.fill();
  if (ring) { g.lineWidth = 8; g.strokeStyle = ring; g.stroke(); }
  g.fillStyle = fg;
  g.font = `600 ${text.length > 2 ? 44 : 60}px Inter, system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 64, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// Сетка: полупрозрачная текстура «в клетку».
function netTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 64;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(230,230,230,0.55)'; g.lineWidth = 1.5;
  for (let x = 0; x <= 512; x += 6) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 64); g.stroke(); }
  for (let y = 0; y <= 64; y += 6) { g.beginPath(); g.moveTo(0, y); g.lineTo(512, y); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(4, 1);
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

export function createCourt3D(el, { onPick, onHover } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  el.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0c0e);
  scene.fog = new THREE.Fog(0x0b0c0e, 40, 75);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  camera.position.set(0, 13, 20);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 6;
  controls.maxDistance = 50;

  // Свет: мягкий общий + «прожектор зала» с тенями.
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a1a1a, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-6, 18, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14 });
  scene.add(sun);

  // ---------- Пол, площадка, линии ----------
  const flat = (w, d, color, y = 0, opts = {}) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...opts }));
    m.rotation.x = -Math.PI / 2;
    m.position.y = y;
    m.receiveShadow = true;
    return m;
  };
  const floor = flat(60, 60, COLORS.floorOut, -0.01);
  scene.add(floor);
  const courtUs = flat(9, 9, COLORS.courtUs, 0); courtUs.position.z = 4.5; scene.add(courtUs);
  const courtThem = flat(9, 9, COLORS.courtThem, 0); courtThem.position.z = -4.5; scene.add(courtThem);
  // Зона атаки чуть светлее — как на настоящих площадках.
  const atkUs = flat(9, 3, 0x3a74a8, 0.002); atkUs.position.z = 1.5; scene.add(atkUs);
  const atkThem = flat(9, 3, 0x4a6188, 0.002); atkThem.position.z = -1.5; scene.add(atkThem);

  const lineMat = new THREE.MeshBasicMaterial({ color: COLORS.line });
  const line = (x1, z1, x2, z2) => {
    const len = Math.hypot(x2 - x1, z2 - z1), w = 0.05;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 === x2 ? w : len + w, x1 === x2 ? len + w : w), lineMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set((x1 + x2) / 2, 0.004, (z1 + z2) / 2);
    scene.add(m);
  };
  line(-4.5, -9, -4.5, 9); line(4.5, -9, 4.5, 9); line(-4.5, 9, 4.5, 9); line(-4.5, -9, 4.5, -9);
  line(-4.5, 0, 4.5, 0); line(-4.5, 3, 4.5, 3); line(-4.5, -3, 4.5, -3);

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
  const band = new THREE.Mesh(new THREE.BoxGeometry(10, 0.07, 0.02), new THREE.MeshStandardMaterial({ color: 0xf5f5f5 }));
  band.position.set(0, netH - 0.035, 0); band.castShadow = true; scene.add(band);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x8c8f94, metalness: 0.6, roughness: 0.4 });
  for (const x of [-5.5, 5.5]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, netH + 0.2, 16), postMat);
    post.position.set(x, (netH + 0.2) / 2, 0); post.castShadow = true; scene.add(post);
  }
  for (const x of [-4.5, 4.5]) {
    const ant = new THREE.Group();
    for (let i = 0; i < 8; i++) {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.1, 8), new THREE.MeshBasicMaterial({ color: i % 2 ? 0xffffff : 0xe23b3b }));
      s.position.y = netH - 1 + 0.05 + i * 0.1 + 1; ant.add(s);
    }
    ant.position.x = x; scene.add(ant);
  }

  // ---------- Игроки ----------
  const players = new Map(); // id → { group, target }
  function playerToken(p) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 1.5, 24), new THREE.MeshStandardMaterial({ color: p.color ?? 0xe6e6e6, roughness: 0.6 }));
    body.position.y = 0.75; body.castShadow = true;
    g.add(body);
    const ringMat = new THREE.MeshBasicMaterial({ color: COLORS.coral, transparent: true, opacity: 0 });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.55, 40), ringMat);
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.01;
    g.add(ring);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(String(p.label)), depthTest: false }));
    sprite.scale.set(0.75, 0.75, 1); sprite.position.y = 2.05; sprite.renderOrder = 10;
    g.add(sprite);
    g.userData = { body, ring, sprite, label: p.label, selected: false };
    scene.add(g);
    return g;
  }
  function setPlayers(list) {
    const seen = new Set();
    for (const p of list) {
      seen.add(p.id);
      let rec = players.get(p.id);
      if (!rec || rec.group.userData.label !== p.label) {
        if (rec) scene.remove(rec.group);
        rec = { group: playerToken(p), target: toWorld(p.spot) };
        rec.group.position.copy(rec.target);
        players.set(p.id, rec);
      }
      rec.target = toWorld(p.spot);
      rec.group.userData.body.material.color.set(p.setter ? 0xf0c85a : 0xe6e6e6);
      rec.group.userData.ring.material.opacity = p.selected ? 1 : p.server ? 0.55 : 0;
      rec.group.userData.ring.material.color.set(p.selected ? COLORS.coral : COLORS.mint);
    }
    for (const [id, rec] of players) if (!seen.has(id)) { scene.remove(rec.group); players.delete(id); }
  }

  // ---------- Метки: отмеченные точки и следы ----------
  const marks = new THREE.Group(); scene.add(marks);
  const dots = new THREE.Group(); scene.add(dots);
  const trails = new THREE.Group(); scene.add(trails);
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
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.11, 24, 24), new THREE.MeshStandardMaterial({ color: 0xf6e7a1, roughness: 0.5 }));
  ball.castShadow = true; ball.visible = false; scene.add(ball);
  let flight = null;
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
    flight = animate && curves.length ? { curves, k: 0, t: 0 } : null;
    ball.visible = !!flight;
  }

  // ---------- Камера ----------
  const VIEWS = {
    persp: { pos: [0, 12.5, 19], target: [0, 0, 1] },
    top: { pos: [0, 27, 0.01], target: [0, 0, 0] },
    side: { pos: [17, 6.5, 0], target: [0, 1, 0] },
    behind: { pos: [0, 4.2, 14.5], target: [0, 1.6, -3] },
    their: { pos: [0, 12.5, -19], target: [0, 0, -1] },
  };
  let camAnim = null;
  function setView(name) {
    const v = VIEWS[name] || VIEWS.persp;
    camAnim = { pos: new THREE.Vector3(...v.pos), target: new THREE.Vector3(...v.target), k: 0 };
  }

  // ---------- Мышь: клик по полу ----------
  const ray = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ndc = new THREE.Vector2();
  const hover = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.26, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
  hover.rotation.x = -Math.PI / 2; hover.visible = false; scene.add(hover);
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
    if (p) onPick?.(p, e);
  });
  renderer.domElement.addEventListener('pointermove', e => {
    const p = pick(e);
    hover.visible = !!p;
    if (p) { hover.position.copy(toWorld(p)); hover.position.y = 0.014; }
    onHover?.(p && { ...p, zone: zoneOf(p) }, e);
  });
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
  renderer.setAnimationLoop(now => {
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
    if (flight) {
      flight.t += dt * 1.1;
      if (flight.t >= 1) { flight.t = 0; flight.k = (flight.k + 1) % flight.curves.length; if (flight.k === 0) flight.pause = 0.6; }
      if (flight.pause > 0) flight.pause -= dt;
      else ball.position.copy(flight.curves[flight.k].getPointAt(Math.min(1, flight.t)));
    }
    controls.update();
    renderer.render(scene, camera);
  });

  return {
    setPlayers, setPending, setDots, setTrails, setView, resize,
    toggleZones: on => { zoneGrid.visible = on ?? !zoneGrid.visible; return zoneGrid.visible; },
    dispose: () => { renderer.setAnimationLoop(null); renderer.dispose(); },
  };
}
