// The 3D lot, drawn with three.js.
// Pale ground, soft grey "ghost" cars on occupied spots, rounded bays:
// blue = available, red = reserved or held, green = yours, deeper blue with a floating P = selected.
// One finger or mouse drag orbits, pinch or wheel zooms, a tap selects a spot.

import * as THREE from 'three';

const PALETTES = {
  light: {
    background: 0xeceef0, ground: 0xf6f7f8, lane: 0xdfe1e5,
    ghost: 0xcdd0d5, ghostWheel: 0xa9adb3, driver: 0x1d1f23, driverWheel: 0x0c0d0f, shadow: 0.09,
    available: [0x3b82f6, 0xb5cdf8], reserved: [0xe5484d, 0xf5b9bb], held: [0xe5484d, 0xf5b9bb],
    occupied: [0xb4b7bc, 0xdcdee1], mine: [0x1f9d55, 0xb0e0c6], selected: [0x1d4ed8, 0x7fa8f5],
  },
  dark: {
    background: 0x0f1012, ground: 0x17181b, lane: 0x2a2c31,
    ghost: 0x50545b, ghostWheel: 0x2e3035, driver: 0xe8eaed, driverWheel: 0x9aa0a8, shadow: 0.35,
    available: [0x4c8dff, 0x1e3a6e], reserved: [0xff5a5f, 0x5e2024], held: [0xff5a5f, 0x5e2024],
    occupied: [0x3a3d43, 0x24262a], mine: [0x30c26e, 0x1c4a33], selected: [0x8fb4ff, 0x2f5fd0],
  },
};

const TYPE_LABEL = { standard: 'Standard', accessible: 'Accessible', ev: 'EV charging' };

function roundRect(w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return new THREE.ShapeGeometry(s);
}

function carGeometry() {
  // Sedan side profile, extruded across the car's width. Length runs along x, nose at +x.
  const s = new THREE.Shape();
  s.moveTo(-2.15, 0.3); s.lineTo(-2.2, 0.85); s.quadraticCurveTo(-2.1, 1.02, -1.6, 1.05);
  s.quadraticCurveTo(-1.0, 1.5, -0.3, 1.5); s.lineTo(0.3, 1.5); s.quadraticCurveTo(0.9, 1.45, 1.3, 1.0);
  s.quadraticCurveTo(2.0, 0.9, 2.2, 0.7); s.lineTo(2.2, 0.3); s.lineTo(-2.15, 0.3);
  const g = new THREE.ExtrudeGeometry(s, { depth: 1.7, bevelEnabled: true, bevelSize: 0.12, bevelThickness: 0.12, bevelSegments: 3, curveSegments: 10 });
  g.translate(0, 0, -0.85);
  return g;
}

function badgeTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const c = canvas.getContext('2d');
  c.fillStyle = '#2f6fed';
  c.beginPath(); c.arc(64, 64, 58, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#fff';
  c.font = 'bold 84px system-ui, -apple-system, Arial, sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('P', 64, 70);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Builds the scene inside `el`. Returns { sync(spots, selectedId), setTheme(dark), dispose() }.
 * Throws if WebGL is unavailable; the caller falls back to the 2D grid.
 */
export function createLot3D(el, lot, spots, { dark = false, onPick = () => {} } = {}) {
  const W = 2.7, D = 5.4, AISLE = 7;
  const rowZ = (r) => r * D + Math.floor((r + 1) / 2) * AISLE;
  const totalW = lot.cols * W, totalD = rowZ(lot.rows - 1) + D;
  let palette = dark ? PALETTES.dark : PALETTES.light;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(palette.background, 50, 200);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 800);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  el.innerHTML = '';
  el.appendChild(renderer.domElement);
  const tip = document.createElement('div'); tip.className = 'tip'; el.appendChild(tip);
  const zoom = document.createElement('div'); zoom.className = 'zoom';
  zoom.innerHTML = '<button class="btn" type="button" aria-label="Zoom in">+</button><button class="btn" type="button" aria-label="Zoom out">−</button>';
  el.appendChild(zoom);

  // three.js r155+ uses physical light units, so these are about π times the old values.
  const hemi = new THREE.HemisphereLight(0xffffff, 0xb4b9c1, 2.9);
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(30, 60, 20);
  scene.add(hemi, sun);

  const flat = (mesh) => { mesh.rotation.x = -Math.PI / 2; return mesh; };
  const basic = (color) => new THREE.MeshBasicMaterial({ color });

  const carGeo = carGeometry();
  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.22, 18);
  const shadowGeo = roundRect(5.0, 2.5, 0.9);
  const ghostMat = new THREE.MeshLambertMaterial();
  const ghostWheel = new THREE.MeshLambertMaterial();
  const driverMat = new THREE.MeshLambertMaterial();
  const driverWheel = new THREE.MeshLambertMaterial();
  const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: palette.shadow, depthWrite: false });

  function makeCar(body, wheel) {
    const car = new THREE.Group();
    car.add(new THREE.Mesh(carGeo, body));
    [[-1.35, 0.95], [-1.35, -0.95], [1.35, 0.95], [1.35, -0.95]].forEach(([x, z]) => {
      const w = new THREE.Mesh(wheelGeo, wheel);
      w.rotation.x = Math.PI / 2; w.position.set(x, 0.34, z);
      car.add(w);
    });
    const shadow = flat(new THREE.Mesh(shadowGeo, shadowMat));
    shadow.position.y = 0.045;
    car.add(shadow);
    return car;
  }

  const root = new THREE.Group();
  root.position.set(-totalW / 2, 0, -totalD / 2);
  scene.add(root);

  const groundMat = basic(palette.ground);
  const ground = flat(new THREE.Mesh(new THREE.PlaneGeometry(totalW + 600, totalD + 600), groundMat));
  ground.position.set(totalW / 2, 0, totalD / 2);
  root.add(ground);

  const laneMat = basic(palette.lane);
  const aisles = [];
  for (let r = 0; r + 1 < lot.rows; r += 2) {
    const z = rowZ(r) + D + AISLE / 2;
    aisles.push(z);
    const lane = flat(new THREE.Mesh(new THREE.PlaneGeometry(totalW + 16, 0.45), laneMat));
    lane.position.set(totalW / 2, 0.01, z);
    root.add(lane);
  }
  if (aisles.length) {                                 // the driver's own car, waiting in the first aisle
    const you = makeCar(driverMat, driverWheel);
    you.position.set(-3.5, 0, aisles[0] + 1.6);
    root.add(you);
  }

  const edgeGeo = roundRect(W - 0.22, D - 0.22, 0.35);
  const fillGeo = roundRect(W - 0.5, D - 0.5, 0.25);
  const tagGeo = new THREE.CircleGeometry(0.42, 24);
  const pads = [];
  const bays = new Map();

  for (const s of spots) {
    const x = s.col * W + W / 2, z = rowZ(s.row) + D / 2;
    const facing = s.row % 2 === 0 ? 1 : -1;          // +1: the aisle is on the +z side
    const edge = flat(new THREE.Mesh(edgeGeo, basic(0xffffff)));
    edge.position.set(x, 0.02, z);
    edge.userData.id = s.id;
    const fill = flat(new THREE.Mesh(fillGeo, basic(0xffffff)));
    fill.position.set(x, 0.03, z);
    root.add(edge, fill);
    pads.push(edge);
    if (s.type !== 'standard') {
      const tag = flat(new THREE.Mesh(tagGeo, basic(s.type === 'ev' ? 0x8b5cf6 : 0x60a5fa)));
      tag.position.set(x, 0.04, z + facing * (D / 2 + 0.75));
      root.add(tag);
    }
    const car = makeCar(ghostMat, ghostWheel);
    car.rotation.y = (-facing * Math.PI) / 2;          // nose towards the aisle
    car.position.set(x, 0, z);
    root.add(car);
    bays.set(s.id, { edge, fill, car, spot: s });
  }

  const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: badgeTexture(), depthTest: false }));
  marker.scale.set(2.4, 2.4, 1);
  marker.visible = false;
  marker.renderOrder = 10;
  root.add(marker);

  let selectedId = null;

  function paint() {
    scene.background = new THREE.Color(palette.background);
    scene.fog.color.setHex(palette.background);
    groundMat.color.setHex(palette.ground);
    laneMat.color.setHex(palette.lane);
    ghostMat.color.setHex(palette.ghost);
    ghostWheel.color.setHex(palette.ghostWheel);
    driverMat.color.setHex(palette.driver);
    driverWheel.color.setHex(palette.driverWheel);
    shadowMat.opacity = palette.shadow;
    hemi.groundColor.setHex(dark ? 0x202226 : 0xb4b9c1);
    hemi.intensity = dark ? 1.6 : 2.9;
  }

  function sync(nextSpots, nextSelected) {
    selectedId = nextSelected;
    marker.visible = false;
    for (const s of nextSpots) {
      const bay = bays.get(s.id);
      if (!bay) continue;
      bay.spot = s;
      const [edgeColor, fillColor] =
        s.id === selectedId ? palette.selected : s.mine ? palette.mine : palette[s.status] || palette.available;
      bay.edge.material.color.setHex(edgeColor);
      bay.fill.material.color.setHex(fillColor);
      bay.car.visible = Boolean(s.occupied);
      if (s.id === selectedId) {
        marker.visible = true;
        marker.position.set(bay.edge.position.x, 3.4, bay.edge.position.z);
      }
    }
  }

  function setTheme(isDarkNow) {
    dark = isDarkNow;
    palette = dark ? PALETTES.dark : PALETTES.light;
    paint();
    sync([...bays.values()].map((b) => b.spot), selectedId);
  }

  // ---------- camera and gestures ----------
  const base = Math.max(totalW + 8, totalD * 1.5) * 0.85 + 12;
  let theta = -0.6, phi = 0.92, radius = base, zoomed = false;
  const minR = 14, maxR = base * 2.6;
  const clampR = (v) => Math.min(maxR, Math.max(minR, v));

  function place() {
    camera.position.set(radius * Math.sin(phi) * Math.sin(theta), radius * Math.cos(phi), radius * Math.sin(phi) * Math.cos(theta));
    camera.lookAt(0, 0, 0);
    scene.fog.near = radius * 1.1;
    scene.fog.far = radius * 3.2 + 60;
  }

  const canvas = renderer.domElement;
  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const points = new Map();
  let drag = null, moved = 0, pinch = 0;

  const spread = () => { const [a, b] = [...points.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  function hit(e) {
    const box = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - box.left) / box.width) * 2 - 1, -((e.clientY - box.top) / box.height) * 2 + 1);
    ray.setFromCamera(pointer, camera);
    const found = ray.intersectObjects(pads)[0];
    return found ? found.object.userData.id : null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (points.size === 1) { drag = { x: e.clientX, y: e.clientY }; moved = 0; canvas.style.cursor = 'grabbing'; }
    else { drag = null; moved = 99; pinch = spread(); }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (points.has(e.pointerId)) points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size >= 2) {
      const d = spread();
      if (pinch && d) { zoomed = true; radius = clampR((radius * pinch) / d); place(); }
      pinch = d;
      return;
    }
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      moved += Math.abs(dx) + Math.abs(dy);
      drag = { x: e.clientX, y: e.clientY };
      theta -= dx * 0.006;
      phi = Math.min(1.42, Math.max(0.12, phi - dy * 0.006));
      place();
      tip.style.display = 'none';
      return;
    }
    if (e.pointerType !== 'mouse') return;
    const id = hit(e);
    if (id) {
      const s = bays.get(id).spot, box = el.getBoundingClientRect();
      const label = s.mine ? 'yours' : s.status;
      tip.textContent = `${id} · ${label}${s.type !== 'standard' ? ' · ' + TYPE_LABEL[s.type] : ''}`;
      tip.style.left = `${e.clientX - box.left}px`;
      tip.style.top = `${e.clientY - box.top}px`;
      tip.style.display = 'block';
      canvas.style.cursor = 'pointer';
    } else {
      tip.style.display = 'none';
      canvas.style.cursor = 'grab';
    }
  });
  function lift(e, tap) {
    points.delete(e.pointerId);
    if (points.size < 2) pinch = 0;
    canvas.style.cursor = 'grab';
    if (tap && drag && moved < 8 && points.size === 0) {
      const id = hit(e);
      if (id) onPick(id);
    }
    drag = null;
  }
  canvas.addEventListener('pointerup', (e) => lift(e, true));
  canvas.addEventListener('pointercancel', (e) => lift(e, false));
  canvas.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomed = true;
    radius = clampR(radius * (e.deltaY > 0 ? 1.1 : 0.9));
    place();
  }, { passive: false });
  zoom.children[0].onclick = () => { zoomed = true; radius = clampR(radius * 0.8); place(); };
  zoom.children[1].onclick = () => { zoomed = true; radius = clampR(radius * 1.25); place(); };

  function resize() {
    const w = el.clientWidth || 600, h = el.clientHeight || 400;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!zoomed) { radius = clampR(base * Math.max(1, 1.15 / camera.aspect)); place(); }
  }
  const observer = window.ResizeObserver ? new ResizeObserver(resize) : null;
  observer?.observe(el);

  paint();
  resize();
  place();
  sync(spots, null);

  let frame;
  const loop = (t) => {
    frame = requestAnimationFrame(loop);
    if (marker.visible) marker.position.y = 3.4 + Math.sin(t / 320) * 0.2;
    renderer.render(scene, camera);
  };
  frame = requestAnimationFrame(loop);

  return {
    sync,
    setTheme,
    dispose() {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      renderer.dispose();
      el.innerHTML = '';
    },
  };
}
