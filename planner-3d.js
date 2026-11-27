/* Wayward Palms 3D walkthrough.
 *
 * Every mesh comes from PlanCore.buildScene(plan); this file holds no dimensions of the
 * house. Furniture is the 2D planner's own item list (window.WPPlanner), so moving a piece
 * in either view moves it in both.
 */
(function () {
  'use strict';
  const API = window.WPPlanner, Core = window.PlanCore, T = window.THREE;
  const host = document.getElementById('stage3d');
  if (!API || !Core || !T || !host) return;

  const FURN_COLORS = { sage: 0x7fae92, sand: 0xd2b688, clay: 0xc98b6d, slate: 0x7d9bbf, plum: 0xa184a8 };
  const PREF_KEY = 'wayward-palms-3d-v1';
  const prefs = { ceiling: false, walls: 'full', cut: 4, snapWalls: false, eye: null, avatar: null };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch (e) {}
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {} };

  // ------------------------------------------------------------------ DOM
  const css = document.createElement('style');
  css.textContent = `
  .v3-canvas { position:absolute; inset:0; touch-action:none; }
  .v3-canvas canvas { display:block; width:100%; height:100%; outline:none; }
  .v3-bar { position:absolute; left:max(10px, env(safe-area-inset-left,0px)); right:max(10px, env(safe-area-inset-right,0px)); top:10px; display:flex; flex-wrap:wrap; gap:6px; align-items:flex-start; pointer-events:none; }
  .v3-bar > * { pointer-events:auto; }
  .v3-group { display:flex; flex-wrap:wrap; gap:6px; align-items:center; background:color-mix(in srgb, var(--panel) 92%, transparent); border:1px solid var(--rule); border-radius:8px; padding:5px 6px; }
  .v3-group .lbl { padding:0 2px; }
  .v3-bar select, .v3-bar input[type=number] { border:1px solid var(--rule); background:var(--sheet); border-radius:6px; padding:4px 6px; font-size:13px; }
  .v3-bar input[type=number] { width:64px; font-family:var(--font-mono); }
  .v3-hud { position:absolute; left:max(12px, env(safe-area-inset-left,0px)); bottom:12px; font-family:var(--font-mono); font-size:12px; color:var(--ink); background:color-mix(in srgb, var(--panel) 90%, transparent); border:1px solid var(--rule); border-radius:8px; padding:6px 9px; pointer-events:none; max-width:min(520px, calc(100% - 24px)); }
  .v3-hud b { font-family:var(--font-ui); font-weight:600; }
  .v3-warn { position:absolute; right:max(12px, env(safe-area-inset-right,0px)); bottom:12px; max-width:min(360px, calc(100% - 24px)); }
  .v3-warn details { background:var(--panel); border:1px solid var(--rule); border-radius:8px; padding:6px 10px; font-size:12px; }
  .v3-warn summary { cursor:pointer; color:var(--danger); font-weight:600; }
  .v3-warn ul { margin:6px 0 0; padding-left:16px; max-height:30vh; overflow:auto; color:var(--muted); line-height:1.45; }
  .v3-edit { background:var(--panel); border:1px solid var(--rule); border-radius:8px; font-size:13px; max-width:min(380px, calc(100vw - 32px)); }
  .v3-edit > summary { cursor:pointer; padding:6px 10px; color:var(--muted); }
  .v3-edit[open] > summary { color:var(--ink); border-bottom:1px solid var(--rule); }
  .v3-edit .body { padding:10px; display:flex; flex-direction:column; gap:8px; max-height:58vh; overflow:auto; }
  .v3-edit .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
  .v3-edit label { display:flex; flex-direction:column; gap:3px; font-size:11px; color:var(--muted); min-width:0; }
  .v3-edit input, .v3-edit select, .v3-edit textarea { border:1px solid var(--rule); background:var(--sheet); border-radius:6px; padding:5px 7px; font-size:12px; font-family:var(--font-mono); min-width:0; width:100%; }
  .v3-edit textarea { height:180px; resize:vertical; }
  .v3-edit .op { border-top:1px dashed var(--rule); padding-top:6px; display:flex; flex-direction:column; gap:4px; }
  .v3-edit .op-h { font-size:12px; font-weight:600; }
  .v3-edit .msgs { font-size:12px; line-height:1.4; }
  .v3-edit .msgs .err { color:var(--danger); } .v3-edit .msgs .ok { color:var(--accent); } .v3-edit .msgs .wrn { color:var(--muted); }
  .v3-edit .row { display:flex; flex-wrap:wrap; gap:6px; }
  .v3-joy { position:absolute; left:max(18px, env(safe-area-inset-left,0px)); bottom:64px; width:120px; height:120px; border-radius:50%; border:2px solid color-mix(in srgb, var(--ink) 30%, transparent); background:color-mix(in srgb, var(--panel) 45%, transparent); touch-action:none; }
  .v3-knob { position:absolute; left:50%; top:50%; width:46px; height:46px; margin:-23px 0 0 -23px; border-radius:50%; background:color-mix(in srgb, var(--accent) 70%, transparent); }
  .v3-cross { position:absolute; left:50%; top:50%; width:14px; height:14px; margin:-7px 0 0 -7px; pointer-events:none; }
  .v3-cross::before, .v3-cross::after { content:""; position:absolute; background:color-mix(in srgb, var(--ink) 65%, transparent); }
  .v3-cross::before { left:6px; top:0; width:2px; height:14px; } .v3-cross::after { top:6px; left:0; height:2px; width:14px; }
  .v3-only-over, .v3-only-fp { display:contents; }`;
  document.head.appendChild(css);

  host.innerHTML = `
    <div class="v3-canvas" id="v3-canvas"></div>
    <div class="v3-cross" id="v3-cross" hidden></div>
    <div class="v3-bar">
      <div class="v3-group" role="group" aria-label="Camera">
        <button class="seg-btn btn" id="v3-mode" title="Switch view (V)">Walk (first person)</button>
        <span class="v3-only-over" id="v3-over-tools">
          <button class="btn" id="v3-top" title="Look straight down, north up">Top-down</button>
          <button class="btn" id="v3-fit">Fit</button>
        </span>
      </div>
      <div class="v3-group" id="v3-look" role="group" aria-label="Overhead display">
        <label class="toggle"><input type="checkbox" id="v3-ceil"> Ceiling</label>
        <label class="lbl" for="v3-walls">Walls</label>
        <select id="v3-walls"><option value="full">Full height</option><option value="fade">Faded</option><option value="cut">Cut away</option></select>
        <label class="toggle" title="When you drop a piece near a wall, turn it to face the room and push it flush"><input type="checkbox" id="v3-snapw"> Snap to walls</label>
      </div>
      <div class="v3-group" id="v3-fp-tools" hidden role="group" aria-label="Walk settings">
        <label class="lbl" for="v3-eye">Eye height</label><input type="number" id="v3-eye" step="1" min="36" max="84"><span class="lbl">in</span>
      </div>
      <details class="v3-edit" id="v3-edit">
        <summary>Edit dimensions</summary>
        <div class="body" id="v3-edit-body"></div>
      </details>
    </div>
    <div class="v3-hud" id="v3-hud"></div>
    <div class="v3-warn" id="v3-warn"></div>
    <div class="v3-joy" id="v3-joy" hidden><div class="v3-knob" id="v3-knob"></div></div>`;
  const $ = id => document.getElementById(id);

  // ------------------------------------------------------------------ renderer and scene
  let renderer = null, scene, camera, raycaster, staticGroup, furnGroup, avatarMesh, clipPlane;
  let built = null;                 // output of Core.buildScene for the active plan
  let plan = API.plan();
  const mats = {};
  const unitBox = new T.BoxGeometry(1, 1, 1); unitBox.translate(0, 0.5, 0);
  const unitCyl = new T.CylinderGeometry(0.5, 0.5, 1, 28); unitCyl.translate(0, 0.5, 0);

  function initRenderer() {
    renderer = new T.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.localClippingEnabled = true;
    renderer.outputEncoding = T.sRGBEncoding;
    $('v3-canvas').appendChild(renderer.domElement);
    renderer.domElement.tabIndex = 0;
    scene = new T.Scene();
    camera = new T.PerspectiveCamera(55, 1, 0.1, 600);
    raycaster = new T.Raycaster();
    scene.add(new T.HemisphereLight(0xffffff, 0x8a7f70, 0.85));
    const sun = new T.DirectionalLight(0xffffff, 0.55); sun.position.set(-30, 80, -20); scene.add(sun);
    const fill = new T.DirectionalLight(0xffffff, 0.2); fill.position.set(40, 30, 60); scene.add(fill);
    clipPlane = new T.Plane(new T.Vector3(0, -1, 0), prefs.cut);
    mats.wall = new T.MeshLambertMaterial({ color: 0xefebe4, side: T.DoubleSide });
    mats.floor = new T.MeshLambertMaterial({ vertexColors: true });
    mats.ceil = new T.MeshLambertMaterial({ color: 0xf7f5f0, side: T.FrontSide });
    mats.glass = new T.MeshPhongMaterial({ color: 0x9cc6e4, transparent: true, opacity: 0.28, side: T.DoubleSide, depthWrite: false, shininess: 80 });
    mats.door = new T.MeshLambertMaterial({ color: 0xa98461 });
    mats.furn = {};
    for (const [k, c] of Object.entries(FURN_COLORS)) {
      mats.furn[k] = new T.MeshLambertMaterial({ color: c });
      mats.furn[k + ':sel'] = new T.MeshLambertMaterial({ color: c, emissive: 0xc9661f, emissiveIntensity: 0.45 });
      mats.furn[k + ':hit'] = new T.MeshLambertMaterial({ color: c, emissive: 0xd0302a, emissiveIntensity: 0.55 });
    }
    staticGroup = new T.Group(); furnGroup = new T.Group(); scene.add(staticGroup, furnGroup);
    ground = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshLambertMaterial({ color: 0xcfd5cc }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.03; scene.add(ground);
    themeColors();
    if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeColors);
    const av = new T.Group();
    const body = new T.Mesh(new T.CylinderGeometry(0.75, 0.75, 0.25, 24), new T.MeshLambertMaterial({ color: 0x2c6a50 }));
    body.position.y = 0.13;
    const nose = new T.Mesh(new T.ConeGeometry(0.45, 1.1, 16), new T.MeshLambertMaterial({ color: 0x2c6a50 }));
    nose.rotation.x = -Math.PI / 2; nose.position.set(0, 0.2, -1.0);
    const pole = new T.Mesh(new T.CylinderGeometry(0.06, 0.06, 1, 8), new T.MeshLambertMaterial({ color: 0x2c6a50 }));
    av.add(body, nose, pole); avatarMesh = av; avatarMesh.userData.pole = pole; scene.add(av);
    new ResizeObserver(resize).observe(host);
    bindInput();
  }

  let ground = null;
  function themeColors() {
    const cs = getComputedStyle(document.documentElement);
    const bg = (cs.getPropertyValue('--sheet') || '#fdfdfb').trim();
    scene.background = new T.Color(bg);
    const dark = new T.Color(bg).getHSL({}).l < 0.4;
    ground.material.color.set(dark ? 0x232a26 : 0xa9b3a6);
    dirty = true;
  }
  function geometryFrom(m) {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(m.positions, 3));
    g.setAttribute('normal', new T.BufferAttribute(m.normals, 3));
    if (m.colors) {                                   // tones are authored in sRGB; lighting works in linear
      const c = new Float32Array(m.colors.length);
      for (let i = 0; i < c.length; i++) c[i] = Math.pow(m.colors[i], 2.2);
      g.setAttribute('color', new T.BufferAttribute(c, 3));
    }
    g.setIndex(new T.BufferAttribute(m.indices, 1));
    g.computeBoundingSphere();
    return g;
  }

  /** Rebuild every static mesh from the plan data. Returns the validation result. */
  function rebuild(newPlan) {
    if (newPlan) plan = newPlan;
    let out;
    try { out = Core.buildScene(plan); }
    catch (e) { return e.validation || { errors: [String(e.message || e)], warnings: [] }; }
    built = out;
    if (!renderer) return { errors: [], warnings: out.warnings };
    for (const ch of staticGroup.children.slice()) { ch.geometry.dispose(); staticGroup.remove(ch); }
    const add = (m, mat, name) => { const mesh = new T.Mesh(geometryFrom(m), mat); mesh.name = name; staticGroup.add(mesh); return mesh; };
    meshes.walls = add(out.meshes.walls, mats.wall, 'walls');
    meshes.floors = add(out.meshes.floors, mats.floor, 'floors');
    meshes.ceilings = add(out.meshes.ceilings, mats.ceil, 'ceilings');
    meshes.doors = add(out.meshes.doors, mats.door, 'doors');
    meshes.glass = add(out.meshes.glass, mats.glass, 'glass'); meshes.glass.renderOrder = 2;
    const b = out.bounds, span = Math.max(b[2] - b[0], b[3] - b[1]) * 3;
    ground.scale.set(span, span, 1); ground.position.x = (b[0] + b[2]) / 2; ground.position.z = (b[1] + b[3]) / 2;
    applyLook();
    syncFurniture();
    dirty = true;
    return { errors: [], warnings: out.warnings };
  }
  const meshes = {};

  // ------------------------------------------------------------------ furniture
  const furnMeshes = new Map();
  let furnColliders = [], hitIds = new Set();
  function syncFurniture() {
    if (!renderer) return;
    const items = API.items(), sel = API.selected(), seen = new Set();
    // flag pieces that overlap walls (never per frame: only when items or walls change)
    hitIds = new Set();
    if (built) {
      const wallsC = built.colliders.filter(c => c.kind !== 'glass');
      for (const it of items) {
        if (it.shape === 'rug') continue;
        const r = Core.furnitureRect(it);
        if (wallsC.some(c => Core.polygonsOverlap(r, c.poly))) hitIds.add(it.id);
      }
    }
    for (const it of items) {
      seen.add(it.id);
      let m = furnMeshes.get(it.id);
      const round = it.shape === 'round' || it.shape === 'plant';
      if (!m || m.userData.round !== round) {
        if (m) furnGroup.remove(m);
        m = new T.Mesh(round ? unitCyl : unitBox, mats.furn.sage); m.userData = { id: it.id, round };
        furnGroup.add(m); furnMeshes.set(it.id, m);
      }
      const h = Math.max(0.02, API.heightOf(it));
      m.scale.set(it.w, h, it.d);
      m.position.set(it.x, 0, it.y);                  // snapped to the floor: base at height 0
      m.rotation.y = -it.rot * Math.PI / 180;         // plan rotation (y south) -> rotation about +Y
      const c = FURN_COLORS[it.color] ? it.color : 'sage';
      m.material = mats.furn[c + (it.id === sel ? ':sel' : hitIds.has(it.id) ? ':hit' : '')];
    }
    for (const [id, m] of furnMeshes) if (!seen.has(id)) { furnGroup.remove(m); furnMeshes.delete(id); }
    furnColliders = Core.furnitureColliders(items, API.heightOf);
    updateWarnings();
    dirty = true;
  }

  function updateWarnings() {
    const items = API.items();
    const v = Core.validate(plan, items);
    const list = v.errors.concat(v.warnings);
    $('v3-warn').innerHTML = list.length ? `<details><summary>${list.length} warning${list.length === 1 ? '' : 's'}</summary><ul>${list.map(t => `<li>${esc(t)}</li>`).join('')}</ul></details>` : '';
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ------------------------------------------------------------------ views
  let mode = 'over', active = false, dirty = true;
  const orbit = { tx: 30, tz: 40, r: 95, theta: Math.PI / 2, phi: 0.55 };
  const avatar = { x: 0, y: 0, yaw: 0, pitch: 0 };
  const eyeH = () => (prefs.eye != null ? prefs.eye : plan.defaults.eyeHeight);
  const AV_R = 0.75;                       // walker radius (ft): fits a 1'-8" closet door

  function placeAvatarDefault() {
    if (prefs.avatar) { Object.assign(avatar, prefs.avatar); return; }
    const foyer = plan.rooms.find(r => /foyer/i.test(r.name) && !/closet/i.test(r.name)) || plan.rooms[0];
    const c = centroid(foyer.polygon); avatar.x = c[0]; avatar.y = c[1]; avatar.yaw = 0; avatar.pitch = 0;
  }
  function centroid(p) { let x = 0, y = 0; for (const q of p) { x += q[0]; y += q[1]; } return [x / p.length, y / p.length]; }

  function fitOverhead() {
    const b = built.bounds;
    orbit.tx = (b[0] + b[2]) / 2; orbit.tz = (b[1] + b[3]) / 2;
    const span = Math.max(b[2] - b[0], b[3] - b[1]);
    orbit.r = span / (2 * Math.tan(camera.fov * Math.PI / 360)) * 1.08 / Math.max(0.6, Math.min(1, camera.aspect)) + 10;
    dirty = true;
  }
  function applyCamera() {
    if (mode === 'over') {
      const sp = Math.sin(orbit.phi);
      camera.position.set(orbit.tx + orbit.r * sp * Math.cos(orbit.theta), orbit.r * Math.cos(orbit.phi), orbit.tz + orbit.r * sp * Math.sin(orbit.theta));
      camera.up.set(0, 1, 0);
      camera.lookAt(orbit.tx, 0, orbit.tz);
      camera.near = 0.5; camera.far = 1200;
    } else {
      const e = eyeH();
      camera.position.set(avatar.x, e, avatar.y);
      const cp = Math.cos(avatar.pitch);
      camera.up.set(0, 1, 0);
      camera.lookAt(avatar.x + Math.sin(avatar.yaw) * cp, e + Math.sin(avatar.pitch), avatar.y - Math.cos(avatar.yaw) * cp);
      camera.near = 0.1; camera.far = 400;
    }
    camera.updateProjectionMatrix();
    avatarMesh.visible = mode === 'over';
    avatarMesh.position.set(avatar.x, 0, avatar.y);
    avatarMesh.rotation.y = -avatar.yaw;
    const pole = avatarMesh.userData.pole; pole.scale.y = eyeH(); pole.position.y = eyeH() / 2;
  }
  function applyLook() {
    if (!renderer) return;
    const over = mode === 'over';
    const wallsMode = over ? prefs.walls : 'full';
    const clip = wallsMode === 'cut' ? [clipPlane] : [];
    clipPlane.constant = prefs.cut;
    for (const k of ['wall', 'door', 'glass']) { mats[k].clippingPlanes = clip; mats[k].needsUpdate = true; }
    mats.wall.transparent = wallsMode === 'fade'; mats.wall.opacity = wallsMode === 'fade' ? 0.28 : 1; mats.wall.depthWrite = wallsMode !== 'fade';
    if (meshes.ceilings) meshes.ceilings.visible = over ? prefs.ceiling : true;
    $('v3-look').hidden = !over; $('v3-over-tools').style.display = over ? '' : 'none';
    $('v3-fp-tools').hidden = over;
    $('v3-mode').textContent = over ? 'Walk (first person)' : 'Overhead view';
    $('v3-cross').hidden = over;
    $('v3-joy').hidden = over || !coarse;
    dirty = true;
  }

  /** Switch views, keeping the walker's location. */
  function setMode(m) {
    if (m === mode) return;
    if (m === 'fp') {
      // start from the walker; if it sits inside something, nudge it free
      Core.moveCircle(avPos(), 0, 0, AV_R, [built.colliders, furnColliders]); avatar.x = _pos[0]; avatar.y = _pos[1];
      avatar.pitch = 0;
    } else {
      // overhead: put the camera above the walker, looking the way it faces
      orbit.tx = avatar.x; orbit.tz = avatar.y;
      orbit.r = Math.min(orbit.r, 45); orbit.phi = Math.min(orbit.phi, 0.75);
      orbit.theta = Math.PI / 2 + avatar.yaw;
      if (document.pointerLockElement) document.exitPointerLock();
    }
    mode = m; applyLook(); updateHud();
  }
  const _pos = [0, 0];
  const avPos = () => { _pos[0] = avatar.x; _pos[1] = avatar.y; return _pos; };

  // ------------------------------------------------------------------ input
  const keys = Object.create(null);
  const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  const ndc = new T.Vector2(), floorPlane = new T.Plane(new T.Vector3(0, 1, 0), 0), hitPt = new T.Vector3();
  let drag = null;               // {kind:'orbit'|'pan'|'item'|'look', ...}
  const touches = new Map();
  let pinch = null;

  function setNdc(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
  }
  function floorAt(e) { setNdc(e); return raycaster.ray.intersectPlane(floorPlane, hitPt) ? hitPt : null; }

  function bindInput() {
    const el = renderer.domElement;
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('pointerdown', e => {
      el.focus({ preventScroll: true });
      el.setPointerCapture(e.pointerId);
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2 && mode === 'over') {
        const [a, b] = [...touches.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), r: orbit.r, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        drag = null; return;
      }
      if (mode === 'fp') {
        if (!coarse && e.pointerType === 'mouse' && el.requestPointerLock && !document.pointerLockElement) {
          try { const p = el.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (err) {}
        }
        drag = { kind: 'look', x: e.clientX, y: e.clientY };
        return;
      }
      setNdc(e);
      if ($('v3-edit').open && e.button === 0) {
        const hit = raycaster.intersectObject(meshes.walls, false)[0];
        if (hit) { pickWall(wallAtFace(hit.faceIndex)); return; }
      }
      const fh = e.button === 0 && !e.shiftKey ? raycaster.intersectObjects(furnGroup.children, false)[0] : null;
      if (fh) {
        const id = fh.object.userData.id; API.select(id);
        const it = API.items().find(i => i.id === id), p = floorAt(e);
        drag = { kind: 'item', id, dx: p ? it.x - p.x : 0, dy: p ? it.y - p.z : 0, moved: false };
        return;
      }
      drag = { kind: (e.button === 2 || e.button === 1 || e.shiftKey) ? 'pan' : 'orbit', x: e.clientX, y: e.clientY, moved: false };
    });
    el.addEventListener('pointermove', e => {
      if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size >= 2) {
        const [a, b] = [...touches.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        orbit.r = clamp(pinch.r * pinch.d / Math.max(d, 1), 6, 400);
        panBy(mx - pinch.mx, my - pinch.my); pinch.mx = mx; pinch.my = my; dirty = true; return;
      }
      if (!drag) { if (mode === 'over') hover(e); return; }
      if (drag.kind === 'look') {
        if (document.pointerLockElement === el) return;          // handled by mousemove
        look(e.clientX - drag.x, e.clientY - drag.y); drag.x = e.clientX; drag.y = e.clientY; return;
      }
      if (drag.kind === 'item') {
        const p = floorAt(e); if (!p) return;
        if (!drag.moved) { API.begin(); drag.moved = true; }
        let x = p.x + drag.dx, y = p.z + drag.dy;
        if (!e.altKey) { x = Math.round(x * 12) / 12; y = Math.round(y * 12) / 12; }
        API.update(drag.id, { x, y });
        return;
      }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 0) drag.moved = true;
      if (drag.kind === 'orbit') { orbit.theta += dx * 0.006; orbit.phi = clamp(orbit.phi - dy * 0.005, 0.02, 1.48); }
      else panBy(dx, dy);
      dirty = true;
    });
    const end = e => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
      if (drag && drag.kind === 'item' && drag.moved) {
        if (prefs.snapWalls) snapToWall(drag.id);
        API.commit();
      }
      drag = null;
    };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', e => {
      e.preventDefault();
      if (mode !== 'over') return;
      orbit.r = clamp(orbit.r * Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0012)), 6, 400); dirty = true;
    }, { passive: false });
    el.addEventListener('dblclick', e => {
      if (mode !== 'over') return;
      const p = floorAt(e); if (!p) return;
      avatar.x = p.x; avatar.y = p.z; prefs.avatar = { ...avatar }; savePrefs(); dirty = true; updateHud();
    });
    document.addEventListener('mousemove', e => {
      if (active && mode === 'fp' && document.pointerLockElement === el) look(e.movementX, e.movementY);
    });
    document.addEventListener('keydown', e => {
      if (!active) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'v') { setMode(mode === 'over' ? 'fp' : 'over'); e.preventDefault(); return; }
      if (mode === 'fp') {
        if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(k)) { keys[k] = true; e.preventDefault(); }
        return;
      }
      const sel = API.selected();
      if (sel && k === 'r') { API.rotate(sel, e.shiftKey ? -90 : 90); e.preventDefault(); }
      if (sel && (k === 'delete' || k === 'backspace')) { API.remove(sel); e.preventDefault(); }
      if (k === 'escape') API.select(null);
    });
    document.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; if (e.key === 'Shift') keys.shift = false; });
    window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
    // touch joystick
    const joy = $('v3-joy'), knob = $('v3-knob');
    joy.addEventListener('pointerdown', e => { joy.setPointerCapture(e.pointerId); joyMove(e); });
    joy.addEventListener('pointermove', e => { if (e.buttons || e.pointerType === 'touch') joyMove(e); });
    const joyEnd = () => { stick.x = stick.y = 0; knob.style.transform = ''; };
    joy.addEventListener('pointerup', joyEnd); joy.addEventListener('pointercancel', joyEnd);
    function joyMove(e) {
      const r = joy.getBoundingClientRect();
      let x = (e.clientX - r.left - r.width / 2) / (r.width / 2), y = (e.clientY - r.top - r.height / 2) / (r.height / 2);
      const L = Math.hypot(x, y); if (L > 1) { x /= L; y /= L; }
      stick.x = x; stick.y = y; knob.style.transform = `translate(${x * 37}px, ${y * 37}px)`;
    }
  }
  const stick = { x: 0, y: 0 };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function look(dx, dy) {
    avatar.yaw += dx * 0.0032; avatar.pitch = clamp(avatar.pitch - dy * 0.0032, -1.2, 1.2); dirty = true;
  }
  function panBy(dx, dy) {
    const k = orbit.r * 0.0016 / Math.max(0.4, renderer.domElement.clientHeight / 900);
    const lx = -Math.sin(orbit.theta), lz = Math.cos(orbit.theta);          // camera left, on the floor
    const fx = -Math.cos(orbit.theta), fz = -Math.sin(orbit.theta);         // camera forward, on the floor
    orbit.tx += (dx * lx + dy * fx) * k; orbit.tz += (dx * lz + dy * fz) * k; // grab-and-drag feel
  }
  let hoverId = null;
  function hover(e) {
    setNdc(e);
    const fh = raycaster.intersectObjects(furnGroup.children, false)[0];
    const id = fh ? fh.object.userData.id : null;
    if (id !== hoverId) { hoverId = id; renderer.domElement.style.cursor = id ? 'move' : ($('v3-edit').open ? 'crosshair' : 'grab'); }
  }
  function wallAtFace(fi) {
    for (const w of built.walls) if (fi >= w.tri[0] && fi < w.tri[1]) return w.id;
    return null;
  }

  /** Optional: turn a piece to face away from the nearest wall and push its back flush. */
  function snapToWall(id) {
    const it = API.items().find(i => i.id === id); if (!it) return;
    const f = Core.nearestWallFace(plan, [it.x, it.y]);
    if (!f || f.dist > it.d / 2 + 0.75) return;
    const rot = Math.round(((Math.atan2(-f.normal[0], f.normal[1]) * 180 / Math.PI) + 360) % 360);
    const along = [it.x - f.point[0], it.y - f.point[1]];
    const t = [-f.normal[1], f.normal[0]], s = along[0] * t[0] + along[1] * t[1];
    const base = [f.point[0] + t[0] * s, f.point[1] + t[1] * s];
    API.update(id, { rot, x: base[0] + f.normal[0] * (it.d / 2 + 0.01), y: base[1] + f.normal[1] * (it.d / 2 + 0.01) });
  }

  // ------------------------------------------------------------------ frame loop
  let last = 0, raf = 0;
  const colliderLists = [null, null];
  function frame(t) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (t - (last || t)) / 1000); last = t;
    if (mode === 'fp') {
      let f = 0, s = 0;
      if (keys.w || keys.arrowup) f += 1; if (keys.s || keys.arrowdown) f -= 1;
      if (keys.d) s += 1; if (keys.a) s -= 1;
      if (keys.arrowleft) { avatar.yaw -= 1.8 * dt; dirty = true; }
      if (keys.arrowright) { avatar.yaw += 1.8 * dt; dirty = true; }
      f -= stick.y; s += stick.x;
      if (f || s) {
        const sp = (keys.shift ? 10 : 4.5) * dt, sy = Math.sin(avatar.yaw), cy = Math.cos(avatar.yaw);
        const dx = (sy * f + cy * s) * sp, dy = (-cy * f + sy * s) * sp;
        colliderLists[0] = built.colliders; colliderLists[1] = furnColliders;
        Core.moveCircle(avPos(), dx, dy, AV_R, colliderLists);
        avatar.x = _pos[0]; avatar.y = _pos[1]; dirty = true; hudDirty = true;
      }
    }
    if (!dirty) { if (hudDirty && t - hudAt > 200) { hudDirty = false; hudAt = t; updateHud(); } return; }
    dirty = false;
    applyCamera();
    renderer.render(scene, camera);
    if (hudDirty && t - hudAt > 200) { hudDirty = false; hudAt = t; updateHud(); }
  }
  let hudDirty = true, hudAt = 0;
  function updateHud() {
    const room = plan.rooms.find(r => Core.pointInPolygon([avatar.x, avatar.y], r.polygon));
    const where = `${Core.formatFtIn(avatar.x, 1)} E · ${Core.formatFtIn(avatar.y, 1)} S`;
    $('v3-hud').innerHTML = mode === 'over'
      ? `<b>Overhead</b> · drag to orbit, right-drag or Shift-drag to pan, scroll to zoom · drag furniture to move it, R rotates · double-click the floor to place the walker · V walks`
      : `<b>${room ? esc(room.name) : 'Outside'}</b> · ${where} · eye ${Core.formatFtIn(eyeH(), 1)} · ${coarse ? 'left pad moves, drag to look' : 'W A S D to walk, Shift to run, mouse to look (click to capture), Esc releases'} · V for overhead`;
    prefs.avatar = { x: avatar.x, y: avatar.y, yaw: avatar.yaw, pitch: 0 };
  }
  let prefTimer = 0;
  setInterval(() => { if (active && mode === 'fp') { clearTimeout(prefTimer); prefTimer = setTimeout(savePrefs, 50); } }, 2000);

  function resize() {
    if (!renderer) return;
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true;
  }

  // ------------------------------------------------------------------ toolbar
  function bindToolbar() {
    $('v3-mode').onclick = () => setMode(mode === 'over' ? 'fp' : 'over');
    $('v3-top').onclick = () => { orbit.phi = 0.02; orbit.theta = Math.PI / 2; dirty = true; };
    $('v3-fit').onclick = () => { fitOverhead(); orbit.phi = 0.55; orbit.theta = Math.PI / 2; };
    $('v3-ceil').checked = prefs.ceiling;
    $('v3-ceil').onchange = e => { prefs.ceiling = e.target.checked; savePrefs(); applyLook(); };
    $('v3-walls').value = prefs.walls;
    $('v3-walls').onchange = e => { prefs.walls = e.target.value; savePrefs(); applyLook(); };
    $('v3-snapw').checked = prefs.snapWalls;
    $('v3-snapw').onchange = e => { prefs.snapWalls = e.target.checked; savePrefs(); };
    $('v3-eye').value = Math.round(eyeH() * 12);
    $('v3-eye').onchange = e => {
      const v = parseFloat(e.target.value);
      if (v >= 36 && v <= 84) { prefs.eye = v / 12; savePrefs(); dirty = true; updateHud(); } else e.target.value = Math.round(eyeH() * 12);
    };
    $('v3-edit').addEventListener('toggle', () => { if ($('v3-edit').open) renderEditor(); });
  }

  // ------------------------------------------------------------------ edit dimensions
  let editWall = null, jsonOpen = false, editMsgs = '';
  function pickWall(id) { editWall = id; renderEditor(); }
  function renderEditor() {
    const body = $('v3-edit-body');
    const fmt = v => Core.formatFtIn(v);
    const w = plan.walls.find(x => x.id === editWall);
    const H = Core.wallHeights(plan)[plan.walls.indexOf(w)];
    const ops = w ? plan.openings.filter(o => o.wall === w.id).sort((a, b) => a.offset - b.offset) : [];
    body.innerHTML = `
      <p class="empty" style="font-size:12px;margin:0">Lengths take feet-inches (5' 7 1/2") or decimal feet. Positions are measured from the house's NW exterior corner (east, south). Openings stay attached to their wall by their offset from the wall's start.</p>
      <label>Wall (or click one in the view)
        <select id="ed-wall"><option value="">Choose a wall…</option>${plan.walls.map(x => `<option value="${x.id}" ${x.id === editWall ? 'selected' : ''}>${x.id} · ${fmt(Math.hypot(x.b[0] - x.a[0], x.b[1] - x.a[1]))}${x.exterior ? ' · exterior' : ''}</option>`).join('')}</select>
      </label>
      ${w ? `
      <div class="grid2">
        <label>Start east<input id="ed-ax" value="${fmt(w.a[0])}"></label><label>Start south<input id="ed-ay" value="${fmt(w.a[1])}"></label>
        <label>End east<input id="ed-bx" value="${fmt(w.b[0])}"></label><label>End south<input id="ed-by" value="${fmt(w.b[1])}"></label>
        <label>Thickness<input id="ed-t" value="${fmt(w.thickness)}"></label><label>Height${w.height == null ? ` (auto ${fmt(H)})` : ''}<input id="ed-h" value="${w.height == null ? '' : fmt(w.height)}" placeholder="auto"></label>
      </div>
      ${ops.map(o => `<div class="op"><span class="op-h">${o.id} · ${o.kind}${o.style ? ' (' + o.style + ')' : ''}${o.swing ? ' · swings ' + o.swing + ', hinge ' + o.hinge : ''}</span>
        <div class="grid2">
          <label>Offset to center<input data-op="${o.id}" data-k="offset" value="${fmt(o.offset)}"></label><label>Width<input data-op="${o.id}" data-k="width" value="${fmt(o.width)}"></label>
          <label>Height<input data-op="${o.id}" data-k="height" value="${o.height == null ? '' : fmt(o.height)}" placeholder="full"></label><label>Sill<input data-op="${o.id}" data-k="sill" value="${fmt(o.sill || 0)}"></label>
        </div></div>`).join('')}
      <div class="row"><button class="btn primary" id="ed-apply">Apply and rebuild</button></div>` : ''}
      <div class="msgs" id="ed-msgs">${editMsgs}</div>
      <div class="row">
        <button class="btn" id="ed-json-t">${jsonOpen ? 'Hide JSON' : 'Edit as JSON'}</button>
        <button class="btn" id="ed-copy">Copy plan JSON</button>
        <button class="btn danger" id="ed-revert" ${plan === API.filePlan() ? 'disabled' : ''}>Revert to plan-data.js</button>
      </div>
      ${jsonOpen ? `<textarea id="ed-json" spellcheck="false">${esc(JSON.stringify(plan, null, 1))}</textarea><div class="row"><button class="btn primary" id="ed-json-apply">Validate and rebuild</button></div>` : ''}`;
    $('ed-wall').onchange = e => pickWall(e.target.value || null);
    if (w) $('ed-apply').onclick = () => {
      const next = clone(plan), nw = next.walls.find(x => x.id === w.id);
      const P = id => { const v = Core.parseLength($(id).value); if (!isFinite(v)) throw new Error(`"${$(id).value}" is not a length`); return v; };
      try {
        nw.a = [P('ed-ax'), P('ed-ay')]; nw.b = [P('ed-bx'), P('ed-by')]; nw.thickness = P('ed-t');
        nw.height = $('ed-h').value.trim() ? P('ed-h') : null;
        if (nw.height == null) delete nw.height;
        body.querySelectorAll('[data-op]').forEach(inp => {
          const o = next.openings.find(x => x.id === inp.dataset.op), k = inp.dataset.k, raw = inp.value.trim();
          if (k === 'height' && !raw) { o.height = null; return; }
          const v = Core.parseLength(raw); if (!isFinite(v)) throw new Error(`${o.id} ${k}: "${raw}" is not a length`);
          o[k] = v;
        });
      } catch (err) { editMsgs = `<div class="err">${esc(err.message)}</div>`; renderEditor(); return; }
      applyPlan(next);
    };
    $('ed-json-t').onclick = () => { jsonOpen = !jsonOpen; renderEditor(); };
    $('ed-copy').onclick = () => {
      const txt = JSON.stringify(plan, null, 1);
      navigator.clipboard && navigator.clipboard.writeText(txt).then(() => { editMsgs = '<div class="ok">Copied. Paste it over the PLAN object in plan-data.js to keep these edits.</div>'; renderEditor(); },
        () => { jsonOpen = true; renderEditor(); const t = $('ed-json'); t.focus(); t.select(); });
    };
    $('ed-revert').onclick = () => { applyPlan(API.filePlan(), true); };
    if (jsonOpen) $('ed-json-apply').onclick = () => {
      let next;
      try { next = JSON.parse($('ed-json').value); } catch (err) { editMsgs = `<div class="err">JSON error: ${esc(err.message)}</div>`; renderEditor(); return; }
      applyPlan(next);
    };
  }
  const clone = o => JSON.parse(JSON.stringify(o));
  /** Validate, then rebuild. A plan with errors is rejected and the current scene stays. */
  function applyPlan(next, isFile) {
    const v = Core.validate(next, API.items());
    if (v.errors.length) {
      editMsgs = `<div class="err"><b>Not applied.</b> Fix these first:</div>` + v.errors.map(e => `<div class="err">• ${esc(e)}</div>`).join('');
      renderEditor(); return v;
    }
    const r = rebuild(next);
    if (r.errors && r.errors.length) { editMsgs = r.errors.map(e => `<div class="err">• ${esc(e)}</div>`).join(''); renderEditor(); return r; }
    API.setPlan(isFile ? API.filePlan() : next);
    editMsgs = `<div class="ok">Rebuilt: ${built.stats.walls} walls, ${built.stats.openings} openings.</div>` + v.warnings.map(e => `<div class="wrn">• ${esc(e)}</div>`).join('');
    renderEditor(); updateWarnings();
    return v;
  }

  // ------------------------------------------------------------------ lifecycle
  function activate() {
    if (!renderer) {
      initRenderer(); bindToolbar();
      const r = rebuild(plan);
      if (r.errors && r.errors.length) { $('v3-hud').textContent = 'The plan data has errors: ' + r.errors.join(' · '); }
      placeAvatarDefault(); resize(); fitOverhead();
      API.onChange(() => { if (active) syncFurniture(); });
      API.setAddPoint(() => mode === 'over' ? { x: orbit.tx, y: orbit.tz } : { x: avatar.x + Math.sin(avatar.yaw) * 4, y: avatar.y - Math.cos(avatar.yaw) * 4 });
    }
    active = true; resize(); syncFurniture(); applyLook(); updateHud(); dirty = true;
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function deactivate() {
    active = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (document.pointerLockElement) document.exitPointerLock();
    for (const k in keys) keys[k] = false;
    savePrefs();
  }

  window.WP3D = {
    activate, deactivate, rebuild: p => applyPlan(p || plan), setMode,
    // read-only state for tests and debugging
    state: () => ({ mode, avatar: { ...avatar }, orbit: { ...orbit }, walls: built && built.stats.walls, openings: built && built.stats.openings,
                    triangles: built && built.stats.triangles, drawCalls: renderer ? renderer.info.render.calls : 0, hits: [...hitIds] }),
    built: () => built,
    screenOf(x, y, h = 0) {                 // plan point -> canvas-relative pixel, for tests
      applyCamera(); const v = new T.Vector3(x, h, y).project(camera), r = renderer.domElement.getBoundingClientRect();
      return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
    },
    meshOf(id) { const m = furnMeshes.get(id); return m && { x: m.position.x, z: m.position.z, rotY: m.rotation.y, w: m.scale.x, h: m.scale.y, d: m.scale.z }; },
    walkTo(x, y, yaw) { avatar.x = x; avatar.y = y; if (yaw != null) avatar.yaw = yaw; dirty = true; hudDirty = true; },
    press(k, down) { keys[k] = down; },
  };
})();
