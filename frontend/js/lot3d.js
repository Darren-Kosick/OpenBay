// The 3D lot, drawn with three.js from the lot's real plan (outline, islands, nearby buildings, spots).
// Soft grey "ghost" cars on occupied spots, rounded bays, a green glow under yours:
// blue = available, red = reserved or held, green = yours, deeper blue with a floating P = selected.
// One finger or mouse drag orbits, pinch or wheel zooms, a tap selects a spot.

import * as THREE from 'three';

const PALETTES = {
  light: {
    background: 0xeceee9, ground: 0xf6f7f8, lane: 0xdfe1e5, island: 0xcfe5c4, building: 0xdcd8d0,
    ghost: 0xcdd0d5, ghostWheel: 0xa9adb3, driver: 0x1d1f23, driverWheel: 0x0c0d0f, shadow: 0.09,
    available: [0x3b82f6, 0xb5cdf8], reserved: [0xe5484d, 0xf5b9bb], held: [0xe5484d, 0xf5b9bb],
    occupied: [0xb4b7bc, 0xdcdee1], mine: [0x1f9d55, 0xb0e0c6], selected: [0x1d4ed8, 0x7fa8f5],
  },
  dark: {
    background: 0x22252f, ground: 0x2c3040, lane: 0x2a2c31, island: 0x2b4337, building: 0x4a4762,
    ghost: 0x7a7f8c, ghostWheel: 0x2e3035, driver: 0xe8eaed, driverWheel: 0x9aa0a8, shadow: 0.35,
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
 * Builds the scene inside `el` from a lot plan (see lotplan.js): the real outline, grass islands,
 * nearby buildings, and every spot where it really is. Returns { sync(spots, selectedId), setTheme(dark), dispose() }.
 * Throws if WebGL is unavailable; the caller falls back to the 2D plan.
 */
export function createLot3D(el, plan, spots, { dark = false, onPick = () => {} } = {}) {
  const W = plan.spotW, D = plan.spotD;
  const N = plan.spots.length;
  let palette = dark ? PALETTES.dark : PALETTES.light;
  const { extent } = plan;
  const cx = (extent.minX + extent.maxX) / 2, cy = (extent.minY + extent.maxY) / 2;
  const sizeX = extent.maxX - extent.minX, sizeY = extent.maxY - extent.minY;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(palette.background, 80, 400);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 2000);
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
  sun.position.set(60, 120, 40);
  scene.add(hemi, sun);

  // Local plan metres (x right, y up the plan) become world x and -z; everything centred on the lot.
  const root = new THREE.Group();
  root.position.set(-cx, 0, cy);
  scene.add(root);
  const shapeOf = (ring) => new THREE.Shape(ring.map(([x, y]) => new THREE.Vector2(x, y)));
  const flatGeo = (geo, lift) => { geo.rotateX(-Math.PI / 2); geo.translate(0, lift, 0); return geo; };

  const groundMat = new THREE.MeshBasicMaterial();
  const ground = new THREE.Mesh(flatGeo(new THREE.PlaneGeometry(sizeX + 1200, sizeY + 1200), 0), groundMat);
  ground.position.set(cx, 0, -cy);
  root.add(ground);

  const lotMat = new THREE.MeshBasicMaterial();
  const lotShape = shapeOf(plan.outline[0]);
  plan.outline.slice(1).forEach((hole) => lotShape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y)))));
  root.add(new THREE.Mesh(flatGeo(new THREE.ShapeGeometry(lotShape), 0.01), lotMat));
  const edgeMat = new THREE.LineBasicMaterial();
  const edgePts = plan.outline[0].map(([x, y]) => new THREE.Vector3(x, 0.02, -y));
  root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(edgePts), edgeMat));

  const islandMat = new THREE.MeshBasicMaterial();
  for (const ring of plan.islands) root.add(new THREE.Mesh(flatGeo(new THREE.ShapeGeometry(shapeOf(ring)), 0.025), islandMat));

  // Buildings: extruded footprints with a rounded bevel, so they read soft rather than boxy.
  const buildingMat = new THREE.MeshLambertMaterial();
  for (const ring of plan.buildings) {
    const geo = new THREE.ExtrudeGeometry(shapeOf(ring), { depth: 8, bevelEnabled: true, bevelSize: 0.9, bevelThickness: 0.9, bevelSegments: 3, curveSegments: 6 });
    geo.rotateX(-Math.PI / 2);
    root.add(new THREE.Mesh(geo, buildingMat));
  }

  // ---------- spots and cars, instanced ----------
  const padGeo = flatGeo(roundRect(W - 0.3, D - 0.3, 0.35), 0.04);
  const padMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const pads = new THREE.InstancedMesh(padGeo, padMat, N);
  const carGeo = carGeometry();
  const carMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const cars = new THREE.InstancedMesh(carGeo, carMat, N);
  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.22, 14);
  wheelGeo.rotateX(Math.PI / 2);
  const wheelMat = new THREE.MeshLambertMaterial();
  const wheels = new THREE.InstancedMesh(wheelGeo, wheelMat, N * 4);
  const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, depthWrite: false });
  const shadows = new THREE.InstancedMesh(flatGeo(roundRect(5.0, 2.5, 0.9), 0.05), shadowMat, N);
  root.add(pads, shadows, cars, wheels);

  const dummy = new THREE.Object3D();
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  const carMatrix = [], wheelLocal = [[-1.35, 0.34, 0.95], [-1.35, 0.34, -0.95], [1.35, 0.34, 0.95], [1.35, 0.34, -0.95]]
    .map(([x, y, z]) => new THREE.Matrix4().makeTranslation(x, y, z));
  const index = new Map();
  plan.spots.forEach((s, i) => {
    index.set(s.id, i);
    dummy.position.set(s.x, 0, -s.y);
    dummy.rotation.set(0, s.heading, 0);
    dummy.updateMatrix();
    pads.setMatrixAt(i, dummy.matrix);
    // The car points across its row, nose to the aisle.
    dummy.rotation.set(0, s.heading + Math.PI / 2, 0);
    dummy.updateMatrix();
    carMatrix.push(dummy.matrix.clone());
  });

  // Your spots get a soft green glow underneath.
  const glowMat = new THREE.MeshBasicMaterial({ color: 0x30c26e, transparent: true, opacity: 0.5, depthWrite: false });
  const glowGeo = flatGeo(roundRect(W + 1.4, D + 1.4, 1.1), 0.035);
  const glows = [];

  const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: badgeTexture(), depthTest: false }));
  marker.scale.set(2.4, 2.4, 1);
  marker.visible = false;
  marker.renderOrder = 10;
  root.add(marker);

  let selectedId = null;
  let current = new Map(spots.map((s) => [s.id, s]));
  const color = new THREE.Color();

  function paint() {
    scene.background = new THREE.Color(palette.background);
    scene.fog.color.setHex(palette.background);
    groundMat.color.setHex(palette.background);
    lotMat.color.setHex(palette.ground);
    edgeMat.color.setHex(palette.available[0]);
    islandMat.color.setHex(palette.island);
    buildingMat.color.setHex(palette.building);
    wheelMat.color.setHex(palette.ghostWheel);
    shadowMat.opacity = palette.shadow;
    hemi.groundColor.setHex(dark ? 0x202226 : 0xb4b9c1);
    hemi.intensity = dark ? 1.6 : 2.9;
  }

  function sync(list, nextSelected) {
    selectedId = nextSelected;
    current = new Map(list.map((s) => [s.id, s]));
    marker.visible = false;
    let glowCount = 0;
    plan.spots.forEach((p, i) => {
      const s = current.get(p.id);
      const state = !s ? 'occupied' : s.id === selectedId && !s.mine ? 'selected' : s.mine ? 'mine' : s.status;
      pads.setColorAt(i, color.setHex((palette[state] || palette.available)[0]));
      const parked = Boolean(s?.occupied);
      cars.setMatrixAt(i, parked ? carMatrix[i] : hidden);
      cars.setColorAt(i, color.setHex(s?.mine ? palette.mine[0] : palette.ghost));
      shadows.setMatrixAt(i, parked ? carMatrix[i] : hidden);
      wheelLocal.forEach((w, k) => wheels.setMatrixAt(i * 4 + k, parked ? new THREE.Matrix4().multiplyMatrices(carMatrix[i], w) : hidden));
      if (s?.mine) {
        let glow = glows[glowCount];
        if (!glow) { glow = new THREE.Mesh(glowGeo, glowMat); root.add(glow); glows.push(glow); }
        glow.position.set(p.x, 0, -p.y);
        glow.rotation.set(0, p.heading, 0);
        glow.visible = true;
        glowCount += 1;
      }
      if (s && s.id === selectedId) {
        marker.visible = true;
        marker.position.set(p.x, 3.4, -p.y);
      }
    });
    glows.slice(glowCount).forEach((g) => { g.visible = false; });
    for (const mesh of [pads, cars, shadows, wheels]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  function setTheme(isDarkNow) {
    dark = isDarkNow;
    palette = dark ? PALETTES.dark : PALETTES.light;
    paint();
    sync([...current.values()], selectedId);
  }

  // ---------- camera and gestures ----------
  const base = Math.max(sizeX, sizeY * 1.4) * 0.75 + 20;
  let theta = 0, phi = 0.85, radius = base, zoomed = false;
  const minR = 14, maxR = base * 2.6;
  const clampR = (v) => Math.min(maxR, Math.max(minR, v));

  function place() {
    camera.position.set(radius * Math.sin(phi) * Math.sin(theta), radius * Math.cos(phi), radius * Math.sin(phi) * Math.cos(theta));
    camera.lookAt(0, 0, 0);
    scene.fog.near = radius * 1.2;
    scene.fog.far = radius * 3.5 + 80;
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
    const found = ray.intersectObject(pads)[0];
    return found && found.instanceId != null ? plan.spots[found.instanceId].id : null;
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
    const s = id && current.get(id);
    if (s) {
      const box = el.getBoundingClientRect();
      tip.textContent = `${id} · ${s.mine ? 'yours' : s.status}${s.type !== 'standard' ? ' · ' + TYPE_LABEL[s.type] : ''}`;
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
    glowMat.opacity = 0.35 + Math.sin(t / 420) * 0.18;
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
