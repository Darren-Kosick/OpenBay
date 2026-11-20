// The flat 2D plan of one lot: the real outline, grass islands and nearby buildings, and every spot
// where it really is. Scroll or pinch to zoom, drag to pan, tap a spot to select it.
// Colours come from the CSS variables, so light and dark mode need nothing extra here.

const NS = 'http://www.w3.org/2000/svg';
const TYPE_LABEL = { standard: 'Standard', accessible: 'Accessible', ev: 'EV charging' };

const path = (rings) => rings.map((r) => 'M' + r.map(([x, y]) => `${x.toFixed(2)},${(-y).toFixed(2)}`).join('L') + 'Z').join('');

/** Builds the plan inside `el`. Returns { sync(spots, selectedId), setTheme(), dispose() }. */
export function createPlan2D(el, plan, spots, { onPick = () => {} } = {}) {
  const { extent, spotW: W, spotD: D } = plan;
  el.innerHTML = '';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'plan2d');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Plan of the lot');

  const html = [
    ...plan.buildings.map((r) => `<path class="p-building" d="${path([r])}"/>`),
    `<path class="p-lot" d="${path(plan.outline)}" fill-rule="evenodd"/>`,
    ...plan.islands.map((r) => `<path class="p-island" d="${path([r])}"/>`),
  ];
  for (const s of plan.spots) {
    const deg = (-s.heading * 180) / Math.PI;
    html.push(`<g class="bay" data-spot="${s.id}" transform="translate(${s.x.toFixed(2)},${(-s.y).toFixed(2)}) rotate(${deg.toFixed(1)})">`
      + `<rect class="glow" x="${-W / 2 - 0.6}" y="${-D / 2 - 0.6}" width="${W + 1.2}" height="${D + 1.2}" rx="1.2"/>`
      + `<rect class="pad" x="${-W / 2 + 0.15}" y="${-D / 2 + 0.15}" width="${W - 0.3}" height="${D - 0.3}" rx="0.45"/>`
      + '<rect class="car" x="-0.9" y="-2.2" width="1.8" height="4.4" rx="0.6"/><rect class="cabin" x="-0.75" y="-1.0" width="1.5" height="2.3" rx="0.5"/>'
      + `<text class="code" transform="rotate(${-deg.toFixed(1)})" y="0.45">${s.id}</text></g>`);
  }
  svg.innerHTML = html.join('');
  el.appendChild(svg);

  const tip = document.createElement('div'); tip.className = 'tip'; el.appendChild(tip);
  const zoomUi = document.createElement('div'); zoomUi.className = 'zoom';
  zoomUi.innerHTML = '<button class="btn" type="button" aria-label="Zoom in">+</button><button class="btn" type="button" aria-label="Zoom out">−</button>';
  el.appendChild(zoomUi);

  const nodes = new Map([...svg.querySelectorAll('.bay')].map((g) => [g.dataset.spot, g]));
  let current = new Map(spots.map((s) => [s.id, s]));

  // ---------- view: centre and width in metres ----------
  const fullW = extent.maxX - extent.minX + 16, fullH = extent.maxY - extent.minY + 16;
  const view = { cx: (extent.minX + extent.maxX) / 2, cy: -(extent.minY + extent.maxY) / 2, w: fullW };
  const aspect = () => (el.clientHeight || 400) / (el.clientWidth || 600);
  const fit = () => { view.w = Math.max(fullW, fullH / aspect()); };
  const apply = () => {
    const h = view.w * aspect();
    svg.setAttribute('viewBox', `${view.cx - view.w / 2} ${view.cy - h / 2} ${view.w} ${h}`);
    // Show spot codes once a spot is wide enough on screen to read them.
    svg.classList.toggle('labels', (el.clientWidth || 600) / view.w * W > 22);
  };
  const zoomBy = (factor, px = 0.5, py = 0.5) => {
    const h = view.w * aspect();
    const mx = view.cx - view.w / 2 + px * view.w, my = view.cy - h / 2 + py * h;
    const w = Math.min(fullW * 3, Math.max(12, view.w * factor));
    view.cx = mx - (mx - view.cx) * (w / view.w);
    view.cy = my - (my - view.cy) * (w / view.w);
    view.w = w;
    apply();
  };

  // ---------- gestures ----------
  const points = new Map();
  let drag = null, moved = 0, pinch = 0;
  const spread = () => { const [a, b] = [...points.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  svg.addEventListener('pointerdown', (e) => {
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { svg.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (points.size === 1) { drag = { x: e.clientX, y: e.clientY }; moved = 0; }
    else { drag = null; moved = 99; pinch = spread(); }
  });
  svg.addEventListener('pointermove', (e) => {
    if (points.has(e.pointerId)) points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size >= 2) {
      const d = spread();
      if (pinch && d) zoomBy(pinch / d);
      pinch = d;
      return;
    }
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      moved += Math.abs(dx) + Math.abs(dy);
      drag = { x: e.clientX, y: e.clientY };
      const k = view.w / (el.clientWidth || 600);
      view.cx -= dx * k; view.cy -= dy * k;
      apply();
      tip.style.display = 'none';
      return;
    }
    if (e.pointerType !== 'mouse') return;
    const g = e.target.closest?.('.bay');
    const s = g && current.get(g.dataset.spot);
    if (s) {
      const box = el.getBoundingClientRect();
      tip.textContent = `${s.id} · ${s.mine ? 'yours' : s.status}${s.type !== 'standard' ? ' · ' + TYPE_LABEL[s.type] : ''}`;
      tip.style.left = `${e.clientX - box.left}px`;
      tip.style.top = `${e.clientY - box.top}px`;
      tip.style.display = 'block';
    } else {
      tip.style.display = 'none';
    }
  });
  const lift = (e, tap) => {
    points.delete(e.pointerId);
    if (points.size < 2) pinch = 0;
    if (tap && drag && moved < 8 && points.size === 0) {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const g = target?.closest?.('.bay');
      if (g) onPick(g.dataset.spot);
    }
    drag = null;
  };
  svg.addEventListener('pointerup', (e) => lift(e, true));
  svg.addEventListener('pointercancel', (e) => lift(e, false));
  svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const box = svg.getBoundingClientRect();
    zoomBy(e.deltaY > 0 ? 1.15 : 0.87, (e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height);
  }, { passive: false });
  zoomUi.children[0].onclick = () => zoomBy(0.7);
  zoomUi.children[1].onclick = () => zoomBy(1.4);

  const observer = window.ResizeObserver ? new ResizeObserver(apply) : null;
  observer?.observe(el);
  fit();
  apply();

  function sync(list, selectedId) {
    current = new Map(list.map((s) => [s.id, s]));
    for (const [id, g] of nodes) {
      const s = current.get(id);
      const state = !s ? 'occupied' : s.mine ? 'mine' : s.status;
      g.setAttribute('class', `bay s-${state}${s && s.type !== 'standard' ? ` k-${s.type}` : ''}${id === selectedId ? ' sel' : ''}${s?.occupied ? ' parked' : ''}`);
    }
  }
  sync(spots, null);

  return {
    sync,
    setTheme() {},
    dispose() { observer?.disconnect(); el.innerHTML = ''; },
  };
}
