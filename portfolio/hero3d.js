/*
 * Hero: a timber frame, half oak beams and half drafting lines, with a
 * wire core inside. Each capability is pinned to a corner. It assembles
 * on load, follows the pointer, can be dragged, and opens up as you scroll.
 */
(() => {
  const stage = document.querySelector("[data-hero-stage]");
  if (!stage) return;
  const canvas = stage.querySelector("canvas");
  const pinLayer = stage.querySelector("[data-hero-pins]");
  const fallbackEl = stage.querySelector("[data-hero-fallback]");
  const caps = (window.PORTFOLIO && window.PORTFOLIO.capabilities) || [];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const S = 1.25; // half the frame size
  // Corners that carry a pin, as sign triplets. Spread so pins never stack.
  const PIN_CORNERS = [[-1, 1, 1], [1, 1, -1], [1, -1, 1], [-1, -1, -1], [1, 1, 1], [-1, -1, 1]];
  // Edges drawn as drafting lines instead of oak (axis, a, b).
  const DRAFT = new Set(["x,1,-1", "y,1,-1", "z,-1,1", "x,-1,-1"]);

  /* pins (shared by the 3D view and the static fallback) */
  const pins = caps.slice(0, PIN_CORNERS.length).map((c, i) => {
    const a = document.createElement("a");
    a.className = "pin";
    a.href = `#cap-${c.id}`;
    a.dataset.cap = c.id;
    a.innerHTML = `<span class="pin-dot"></span><span class="pin-text">${c.pin}</span>`;
    pinLayer.appendChild(a);
    return { el: a, id: c.id, corner: PIN_CORNERS[i] };
  });

  /* place a pin beside its corner: point outward, flip when there is no room, stay on the stage */
  function placePin(p, x, y, W) {
    const w = p.w || (p.w = p.el.offsetWidth);
    let left = x < W / 2;
    if (left && x - w < 4) left = false;
    else if (!left && x + w > W - 4) left = true;
    const tx = Math.max(4, Math.min(W - w - 4, left ? x - w + 4.5 : x - 4.5));
    p.el.classList.toggle("is-left", left);
    p.el.style.transform = `translate(${tx}px, ${y}px) translateY(-50%)`;
  }

  /* ── static fallback: an oblique drawing of the same frame ── */
  function fallback() {
    stage.classList.remove("is-live");
    const proj = ([x, y, z]) => [200 + (x * 0.95 - z * 0.6) * 100, 215 + (z * 0.4 + x * 0.18) * 100 - y * 105];
    let lines = "";
    for (const [axis, a, b] of edges()) {
      const [p, q] = ends(axis, a, b).map(proj);
      const draft = DRAFT.has(`${axis},${a},${b}`);
      lines += `<line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" stroke="${draft ? "#b4c9ea" : "#9a6a3e"}" stroke-width="${draft ? 1.2 : 9}" stroke-linecap="square" ${draft ? 'stroke-dasharray="6 5"' : ""}/>`;
    }
    fallbackEl.innerHTML = `<svg viewBox="0 0 400 430" width="100%" height="100%" role="img" aria-label="A timber frame drawing">${lines}<circle cx="200" cy="215" r="40" fill="none" stroke="#e2a55e" stroke-opacity=".6"/></svg>`;
    const svg = fallbackEl.firstChild;
    const layout = () => {
      const m = svg.getScreenCTM(), sr = stage.getBoundingClientRect();
      if (!m) return;
      pins.forEach((p) => {
        p.w = 0;
        const [x, y] = proj(p.corner);
        const pt = new DOMPoint(x, y).matrixTransform(m);
        placePin(p, pt.x - sr.left, pt.y - sr.top, sr.width);
      });
    };
    layout();
    addEventListener("resize", layout);
    if (document.fonts) document.fonts.ready.then(layout);
    stage.classList.add("is-ready");
  }
  function edges() {
    const out = [];
    for (const axis of ["x", "y", "z"]) for (const a of [-1, 1]) for (const b of [-1, 1]) out.push([axis, a, b]);
    return out;
  }
  function ends(axis, a, b) {
    if (axis === "x") return [[-1, a, b], [1, a, b]];
    if (axis === "y") return [[a, -1, b], [a, 1, b]];
    return [[a, b, -1], [a, b, 1]];
  }

  if (!window.THREE) return fallback();
  const THREE = window.THREE;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    if (!renderer.getContext()) throw new Error("no context");
  } catch (e) {
    return fallback();
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 0.4, 10);
  const root = new THREE.Group();
  scene.add(root);

  /* lights */
  scene.add(new THREE.HemisphereLight(0xdfe7ff, 0x2a1c10, 0.55));
  const key = new THREE.DirectionalLight(0xffd9ad, 2.4);
  key.position.set(4, 6, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9ab9ff, 1.5);
  rim.position.set(-6, 2, -5);
  scene.add(rim);
  const inner = new THREE.PointLight(0xffaa5c, 1.6, 5, 2);
  root.add(inner);

  /* wood grain drawn once on a canvas */
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  function woodCanvas() {
    const c = document.createElement("canvas");
    c.width = 1024; c.height = 256;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, "#6f4a2b"); grad.addColorStop(0.5, "#8f643e"); grad.addColorStop(1, "#6a4528");
    g.fillStyle = grad; g.fillRect(0, 0, 1024, 256);
    for (let i = 0; i < 170; i++) {
      const y = rnd() * 256, amp = 1.5 + rnd() * 7, freq = 0.003 + rnd() * 0.01, ph = rnd() * 6.28;
      g.strokeStyle = rnd() < 0.55 ? `rgba(48,28,12,${0.08 + rnd() * 0.25})` : `rgba(196,140,86,${0.06 + rnd() * 0.2})`;
      g.lineWidth = 0.5 + rnd() * 2;
      g.beginPath();
      for (let x = 0; x <= 1024; x += 12) {
        const yy = y + Math.sin(x * freq + ph) * amp + Math.sin(x * 0.0007 + i) * 6;
        x ? g.lineTo(x, yy) : g.moveTo(x, yy);
      }
      g.stroke();
    }
    for (let k = 0; k < 4; k++) {
      const x = rnd() * 1024, y = 50 + rnd() * 156;
      for (let r = 20; r > 2; r -= 2.5) {
        g.strokeStyle = `rgba(40,22,10,${0.1 + (20 - r) / 140})`;
        g.beginPath(); g.ellipse(x, y, r * 2.6, r * 0.75, 0, 0, Math.PI * 2); g.stroke();
      }
    }
    return c;
  }
  const woodImg = woodCanvas();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  function woodMaterial() {
    const t = new THREE.CanvasTexture(woodImg);
    t.encoding = THREE.sRGBEncoding;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = maxAniso;
    t.offset.set(rnd(), rnd());
    return new THREE.MeshStandardMaterial({ map: t, bumpMap: t, bumpScale: 0.012, roughness: 0.58, metalness: 0.04, emissive: 0xe2a55e, emissiveIntensity: 0 });
  }

  /* the frame */
  const T = 0.2, L = 2 * S + T;
  const beamGeo = new THREE.BoxGeometry(L, T, T);
  const beamEdges = new THREE.EdgesGeometry(beamGeo);
  const draftColor = new THREE.Color(0xb4c9ea);
  const oak = new THREE.Color(0xe2a55e);
  const beams = [];
  const cornerKey = (c) => c.join(",");

  for (const [axis, a, b] of edges()) {
    const id = `${axis},${a},${b}`;
    const draft = DRAFT.has(id);
    let obj;
    if (draft) {
      obj = new THREE.Group();
      const lineMat = new THREE.LineBasicMaterial({ color: draftColor, transparent: true, opacity: 0.85 });
      obj.add(new THREE.LineSegments(beamEdges, lineMat));
      const fillMat = new THREE.MeshBasicMaterial({ color: draftColor, transparent: true, opacity: 0.05, depthWrite: false });
      obj.add(new THREE.Mesh(beamGeo, fillMat));
      // drafting overshoot: construction lines running past each end
      const ext = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-L / 2 - 0.5, 0, 0), new THREE.Vector3(-L / 2, 0, 0),
        new THREE.Vector3(L / 2, 0, 0), new THREE.Vector3(L / 2 + 0.5, 0, 0),
      ]);
      const dash = new THREE.LineSegments(ext, new THREE.LineDashedMaterial({ color: draftColor, dashSize: 0.06, gapSize: 0.05, transparent: true, opacity: 0.6 }));
      dash.computeLineDistances();
      obj.add(dash);
      obj.userData.mats = [lineMat, fillMat];
    } else {
      const mat = woodMaterial();
      obj = new THREE.Mesh(beamGeo, mat);
      obj.userData.mats = [mat];
    }
    const pos = axis === "x" ? new THREE.Vector3(0, a * S, b * S) : axis === "y" ? new THREE.Vector3(a * S, 0, b * S) : new THREE.Vector3(a * S, b * S, 0);
    const rot = new THREE.Euler(0, axis === "z" ? Math.PI / 2 : 0, axis === "y" ? Math.PI / 2 : 0);
    const dir = pos.clone().normalize();
    const spread = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(2.4);
    obj.userData = {
      ...obj.userData,
      draft,
      home: pos,
      dir,
      start: pos.clone().add(dir.clone().multiplyScalar(5)).add(spread),
      rot,
      spin: new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(3),
      delay: beams.length * 0.07,
      corners: ends(axis, a, b).map(cornerKey),
      heat: 0,
    };
    root.add(obj);
    beams.push(obj);
  }

  /* bronze joints at the corners */
  const jointGeo = new THREE.BoxGeometry(T * 1.18, T * 1.18, T * 1.18);
  const jointMat = new THREE.MeshStandardMaterial({ color: 0x3a3029, metalness: 0.85, roughness: 0.32 });
  const joints = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    const j = new THREE.Mesh(jointGeo, jointMat);
    j.userData.home = new THREE.Vector3(x * S, y * S, z * S);
    j.position.copy(j.userData.home);
    root.add(j);
    joints.push(j);
  }

  pins.forEach((p) => { p.joint = joints.find((j) => cornerKey(j.userData.home.toArray().map(Math.sign)) === cornerKey(p.corner)); });

  /* the core: wire icosahedron, vertex nodes, glow, an orbiting packet */
  const core = new THREE.Group();
  root.add(core);
  const ico = new THREE.IcosahedronGeometry(0.62, 1);
  const coreLines = new THREE.LineSegments(new THREE.EdgesGeometry(ico), new THREE.LineBasicMaterial({ color: oak, transparent: true, opacity: 0.7 }));
  core.add(coreLines);
  const nodes = new THREE.Points(ico, new THREE.PointsMaterial({ color: 0xffd7a3, size: 0.07, transparent: true, opacity: 0.95 }));
  core.add(nodes);
  const glowC = document.createElement("canvas");
  glowC.width = glowC.height = 128;
  const gg = glowC.getContext("2d");
  const rg = gg.createRadialGradient(64, 64, 0, 64, 64, 64);
  rg.addColorStop(0, "rgba(255,190,120,.9)"); rg.addColorStop(0.35, "rgba(226,165,94,.28)"); rg.addColorStop(1, "rgba(226,165,94,0)");
  gg.fillStyle = rg; gg.fillRect(0, 0, 128, 128);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(glowC), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  glow.scale.set(2.4, 2.4, 1);
  core.add(glow);
  const orbit = new THREE.Group();
  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(Array.from({ length: 96 }, (_, i) => new THREE.Vector3(Math.cos((i / 96) * Math.PI * 2) * 0.95, 0, Math.sin((i / 96) * Math.PI * 2) * 0.95))),
    new THREE.LineBasicMaterial({ color: draftColor, transparent: true, opacity: 0.35 })
  );
  orbit.add(ring);
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffe2bc }));
  orbit.add(dot);
  orbit.rotation.set(0.5, 0, 0.35);
  core.add(orbit);

  /* dust in the light */
  const dustN = 280;
  const dustPos = new Float32Array(dustN * 3);
  for (let i = 0; i < dustN; i++) {
    dustPos[i * 3] = (rnd() - 0.5) * 12;
    dustPos[i * 3 + 1] = (rnd() - 0.5) * 8;
    dustPos[i * 3 + 2] = (rnd() - 0.5) * 8;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0xf2d6b0, size: 0.022, transparent: true, opacity: 0.45, depthWrite: false }));
  scene.add(dust);

  /* ── interaction state ─────────────────────────────── */
  let pointerX = 0, pointerY = 0, tiltX = 0, tiltY = 0;
  let dragYaw = 0, dragVel = 0, dragging = false, lastX = 0, lastPitch = 0, dragPitch = 0;
  let hot = null, scrollK = 0, corePulse = 1;

  addEventListener("pointermove", (e) => {
    pointerX = (e.clientX / innerWidth) * 2 - 1;
    pointerY = (e.clientY / innerHeight) * 2 - 1;
  }, { passive: true });
  stage.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".pin")) return;
    dragging = true; lastX = e.clientX; lastPitch = e.clientY;
    stage.classList.add("is-dragging");
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastPitch;
    lastX = e.clientX; lastPitch = e.clientY;
    dragVel = dx * 0.006;
    dragYaw += dragVel;
    if (e.pointerType === "mouse") dragPitch = Math.max(-0.5, Math.min(0.5, dragPitch + dy * 0.004));
  });
  const endDrag = () => { dragging = false; stage.classList.remove("is-dragging"); };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  const setHot = (id) => {
    hot = id;
    pins.forEach((p) => p.el.classList.toggle("is-hot", p.id === id));
  };
  pins.forEach((p) => {
    p.el.addEventListener("pointerenter", () => setHot(p.id));
    p.el.addEventListener("pointerleave", () => setHot(null));
    p.el.addEventListener("focus", () => setHot(p.id));
    p.el.addEventListener("blur", () => setHot(null));
  });
  addEventListener("cap:hot", (e) => setHot(e.detail));

  /* ── sizing ────────────────────────────────────────── */
  let W = 1, H = 1;
  function size() {
    W = stage.clientWidth || 1; H = stage.clientHeight || 1;
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    camera.position.z = W / H < 1 ? 10 / Math.max(W / H, 0.62) * 0.92 : 10;
    camera.updateProjectionMatrix();
    pins.forEach((p) => { p.w = 0; });
  }
  size();
  if (document.fonts) document.fonts.ready.then(() => pins.forEach((p) => { p.w = 0; }));
  if ("ResizeObserver" in window) new ResizeObserver(size).observe(stage);
  else addEventListener("resize", size);

  /* ── loop ──────────────────────────────────────────── */
  const ease = (t) => 1 - Math.pow(1 - t, 4);
  const v = new THREE.Vector3();
  let t0 = performance.now(), last = t0, autoYaw = 0, running = false, readyMarked = false;

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = reduce ? 99 : (now - t0) / 1000;

    // scroll: how far the hero has left the screen
    const r = stage.getBoundingClientRect();
    scrollK = Math.max(0, Math.min(1, -r.top / (r.height * 0.9)));
    const open = scrollK * 1.1;

    if (!reduce) autoYaw += dt * 0.16;
    if (!dragging) { dragVel *= 0.94; dragYaw += dragVel; }
    tiltX += (pointerX - tiltX) * 0.05;
    tiltY += (pointerY - tiltY) * 0.05;
    root.rotation.y = -0.65 + autoYaw + dragYaw + tiltX * 0.3 + scrollK * 0.9;
    root.rotation.x = 0.42 + tiltY * 0.14 + dragPitch + scrollK * 0.25;
    root.position.y = reduce ? 0 : Math.sin(t * 0.8) * 0.05;

    const hotPin = hot ? pins.find((p) => p.id === hot) : null;
    const hotKey = hotPin ? cornerKey(hotPin.corner) : null;

    beams.forEach((b) => {
      const u = b.userData;
      const k = ease(Math.max(0, Math.min(1, (t - 0.15 - u.delay) / 1.5)));
      b.position.lerpVectors(u.start, u.home, k).addScaledVector(u.dir, open);
      b.rotation.set(u.rot.x + u.spin.x * (1 - k), u.rot.y + u.spin.y * (1 - k), u.rot.z + u.spin.z * (1 - k));
      const target = hotKey && u.corners.includes(hotKey) ? 1 : 0;
      u.heat += (target - u.heat) * 0.12;
      if (u.draft) {
        u.mats[0].color.copy(draftColor).lerp(oak, u.heat);
        u.mats[0].opacity = 0.85 * k + 0.15 * u.heat;
        u.mats[1].opacity = 0.05 + 0.18 * u.heat;
      } else {
        u.mats[0].emissiveIntensity = u.heat * 0.32;
      }
    });
    const jk = ease(Math.max(0, Math.min(1, (t - 1.1) / 0.8)));
    joints.forEach((j) => {
      j.scale.setScalar(Math.max(0.001, jk));
      j.position.copy(j.userData.home).addScaledVector(j.userData.home.clone().normalize(), open);
    });

    const ck = ease(Math.max(0, Math.min(1, (t - 0.6) / 1.4)));
    corePulse += ((hot ? 1.18 : 1) - corePulse) * 0.1;
    core.scale.setScalar(Math.max(0.001, ck * corePulse * (1 + Math.sin(t * 2) * 0.025)));
    core.rotation.y -= dt * 0.35;
    core.rotation.x += dt * 0.12;
    const a = t * 1.6;
    dot.position.set(Math.cos(a) * 0.95, 0, Math.sin(a) * 0.95);
    inner.intensity = 1.2 + Math.sin(t * 2) * 0.3 + (hot ? 1 : 0);

    if (!reduce) dust.rotation.y += dt * 0.02;

    renderer.render(scene, camera);

    // project pins onto the corners
    root.updateMatrixWorld();
    pins.forEach((p) => {
      v.copy(p.joint.position).applyMatrix4(root.matrixWorld);
      const camZ = v.clone().applyMatrix4(camera.matrixWorldInverse).z;
      v.project(camera);
      placePin(p, (v.x + 1) / 2 * W, (1 - v.y) / 2 * H, W);
      const depth = Math.max(0.35, Math.min(1, 1 - (-camZ - camera.position.z + S * 1.6) / (S * 3.2)));
      p.el.style.setProperty("--depth", (depth * (1 - scrollK * 0.8)).toFixed(2));
      p.el.style.zIndex = String(Math.round(depth * 10));
    });

    if (!readyMarked && t > 1.9) { readyMarked = true; stage.classList.add("is-ready"); }
  }

  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  }
  function stop() { running = false; }

  stage.classList.add("is-live");
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([en]) => (en.isIntersecting && !document.hidden ? start() : stop())).observe(stage);
  } else start();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else if (stage.getBoundingClientRect().bottom > 0) start();
  });
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); stop(); fallback(); });
})();
