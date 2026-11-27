#!/usr/bin/env node
/* Verification for the 3D walkthrough's data pipeline. Run: node tests/verify-3d.js
 *
 * 1. Loads plan-data.js and builds the 3D scene with plan-core.js (the same code the browser runs).
 * 2. Asserts wall count, opening count and per-room floor areas match the 2D data.
 * 3. Changes dimensions (moves a wall end, thickens a wall, widens an opening) and checks the
 *    rebuild reflects them and openings stay attached to their wall.
 * 4. Checks that validation rejects zero-length walls, openings past their wall, overlapping
 *    openings, and flags furniture outside the footprint.
 * 5. Checks first-person collision: blocked by a solid wall, free through a door opening.
 */
const assert = require('assert');
const path = require('path');
const Core = require(path.join(__dirname, '..', 'plan-core.js'));
const PLAN = require(path.join(__dirname, '..', 'plan-data.js'));
const clone = o => JSON.parse(JSON.stringify(o));
let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const len = w => Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);

console.log('plan-data.js: %d walls, %d openings, %d rooms, units=%s', PLAN.walls.length, PLAN.openings.length, PLAN.rooms.length, PLAN.units);

test('schema states its unit and every number is finite', () => {
  assert.strictEqual(PLAN.units, 'ft');
  for (const w of PLAN.walls) for (const v of [...w.a, ...w.b, w.thickness]) assert.ok(Number.isFinite(v), w.id);
  for (const o of PLAN.openings) for (const v of [o.offset, o.width]) assert.ok(Number.isFinite(v), o.id);
});

test('plan validates with no errors', () => {
  const v = Core.validate(PLAN);
  assert.deepStrictEqual(v.errors, []);
});

const S = Core.buildScene(PLAN);
test('3D wall count matches the 2D data', () => assert.strictEqual(S.stats.walls, PLAN.walls.length));
test('3D opening count matches the 2D data, by id and kind', () => {
  assert.strictEqual(S.stats.openings, PLAN.openings.length);
  const ids = new Set(S.openings.map(o => o.id));
  for (const o of PLAN.openings) assert.ok(ids.has(o.id), `missing ${o.id}`);
  const kinds = k => PLAN.openings.filter(o => o.kind === k).length;
  for (const k of ['door', 'window', 'open', 'garage', 'passthrough']) assert.strictEqual(S.openings.filter(o => o.kind === k).length, kinds(k), k);
});
test('every room floor in 3D has the room polygon area', () => {
  for (const r of PLAN.rooms) near(S.roomFloorArea[r.id], Math.abs(Core.polygonArea(r.polygon)), 1e-6, r.name);
});
test('room areas agree with the measured room key (within 6% or 2 SF, approximate rooms 12%)', () => {
  const approx = new Set(['Kitchen', 'Foyer', 'Living Room', 'Right Front Bedroom']);
  for (const r of PLAN.rooms) {
    if (!r.keyArea) continue;
    const a = Math.abs(Core.polygonArea(r.polygon)), tol = Math.max(2, (approx.has(r.name) ? 0.12 : 0.06) * r.keyArea);
    near(a, r.keyArea, tol, r.name);
  }
});
test('every opening is cut through its wall: jambs at offset ± width/2, with header/sill where set', () => {
  for (const o of PLAN.openings) {
    const w = PLAN.walls.find(x => x.id === o.wall), f = Core.frame(w), so = S.openings.find(x => x.id === o.id);
    near(so.s1 - so.s0, o.width, 1e-9, o.id + ' width');
    near(so.center[0], w.a[0] + f.u[0] * o.offset, 1e-9, o.id + ' x'); near(so.center[1], w.a[1] + f.u[1] * o.offset, 1e-9, o.id + ' y');
    near(so.z0, o.sill || 0, 1e-9, o.id + ' sill');
  }
});
test('static geometry is merged into a handful of meshes', () => {
  assert.strictEqual(Object.keys(S.meshes).length, 5);
  for (const [k, m] of Object.entries(S.meshes)) {
    assert.strictEqual(m.positions.length, m.normals.length, k);
    for (const i of m.indices) assert.ok(i < m.positions.length / 3, k + ' index in range');
  }
});
test('walls have no exactly coincident top faces (no z-fighting at joints)', () => {
  // tops of neighbouring walls must not overlap: compare footprint areas with their union proxy
  const H = Core.wallHeights(PLAN);
  let sum = 0; for (const w of S.walls) sum += Math.abs(Core.polygonArea(w.footprint));
  // a joint double-counts if two footprints overlap; sample overlap pairwise
  let overlaps = 0;
  for (let i = 0; i < S.walls.length; i++) for (let j = i + 1; j < S.walls.length; j++) {
    const A = S.walls[i].footprint, B = S.walls[j].footprint;
    if (Math.abs(H[i] - H[j]) > 1e-6) continue;
    const c = A.reduce((s, p) => [s[0] + p[0] / A.length, s[1] + p[1] / A.length], [0, 0]);
    if (Core.pointInPolygon(c, B)) overlaps++;
  }
  assert.strictEqual(overlaps, 0);
});

// ---- measurement changes ---------------------------------------------------------------
test('moving a wall end re-positions its openings (attached by offset) and rebuilds', () => {
  const p = clone(PLAN);
  const o = p.openings.find(x => x.kind === 'door');
  const w = p.walls.find(x => x.id === o.wall);
  const before = S.openings.find(x => x.id === o.id).center;
  // translate the whole wall 6" along its normal (a typical "wall was measured wrong" fix)
  const f = Core.frame(w); const dx = f.n[0] * 0.5, dy = f.n[1] * 0.5;
  w.a = [w.a[0] + dx, w.a[1] + dy]; w.b = [w.b[0] + dx, w.b[1] + dy];
  const S2 = Core.buildScene(p);
  const after = S2.openings.find(x => x.id === o.id).center;
  near(after[0] - before[0], dx, 1e-9, 'opening moved with wall x'); near(after[1] - before[1], dy, 1e-9, 'opening moved with wall y');
  assert.strictEqual(S2.stats.openings, PLAN.openings.length);
});
test('lengthening a wall keeps opening offsets from its start', () => {
  const p = clone(PLAN);
  const w = p.walls.find(x => p.openings.some(o => o.wall === x.id) && Core.analyzeJoins(p.walls)[p.walls.indexOf(x)].ends[1].kind === 'free')
         || p.walls.find(x => p.openings.some(o => o.wall === x.id));
  const f = Core.frame(w); w.b = [w.b[0] + f.u[0] * 1.5, w.b[1] + f.u[1] * 1.5];
  const S2 = Core.buildScene(p);
  near(S2.walls.find(x => x.id === w.id).length, len(w), 1e-9, 'new length');
  for (const o of p.openings.filter(o => o.wall === w.id)) {
    const c = S2.openings.find(x => x.id === o.id).center;
    near(c[0], w.a[0] + f.u[0] * o.offset, 1e-9, o.id);
  }
});
test('thickness, height, door width and sill changes show up after rebuild', () => {
  const p = clone(PLAN);
  const win = p.openings.find(x => x.kind === 'window' && x.sill > 0);
  const w = p.walls.find(x => x.id === win.wall);
  w.thickness = 0.5; w.height = 11; win.sill = win.sill + 0.25; win.width = win.width - 0.2;
  const S2 = Core.buildScene(p);
  const wi = S2.walls.find(x => x.id === w.id);
  assert.strictEqual(wi.height, 11);
  const so = S2.openings.find(x => x.id === win.id);
  near(so.z0, win.sill, 1e-9, 'sill'); near(so.s1 - so.s0, win.width, 1e-9, 'width');
  // footprint width across the wall equals the new thickness at mid-length
  const fp = wi.footprint, f = Core.frame(w);
  const proj = fp.map(q => (q[0] - w.a[0]) * f.n[0] + (q[1] - w.a[1]) * f.n[1]);
  near(Math.max(...proj) - Math.min(...proj), 0.5, 1e-6, 'thickness');
  assert.notStrictEqual(S2.meshes.walls.positions.length, 0);
});
test('room dimension change changes the 3D floor area', () => {
  const p = clone(PLAN); const r = p.rooms.find(x => x.name === 'Office');
  const a0 = Math.abs(Core.polygonArea(r.polygon));
  r.polygon = r.polygon.map(q => [q[0], q[1] * 1.0]); r.polygon[0] = [r.polygon[0][0] - 0.5, r.polygon[0][1]];
  const S2 = Core.buildScene(p);
  near(S2.roomFloorArea[r.id], Math.abs(Core.polygonArea(r.polygon)), 1e-6, 'floor follows polygon');
  assert.ok(Math.abs(S2.roomFloorArea[r.id] - a0) > 1e-3);
});

// ---- validation ------------------------------------------------------------------------
test('rejects a zero-length wall', () => {
  const p = clone(PLAN); p.walls[0].b = p.walls[0].a.slice();
  assert.ok(Core.validate(p).errors.some(e => /zero length/.test(e)));
  assert.throws(() => Core.buildScene(p));
});
test('rejects an opening wider than its wall', () => {
  const p = clone(PLAN); const o = p.openings[0]; o.width = 60;
  assert.ok(Core.validate(p).errors.some(e => e.includes(o.id) && /runs past/.test(e)));
});
test('rejects an opening left behind when its wall is shortened', () => {
  const p = clone(PLAN); const o = p.openings.find(x => x.offset > 3); const w = p.walls.find(x => x.id === o.wall);
  const f = Core.frame(w); const keep = o.offset - o.width; w.b = [w.a[0] + f.u[0] * keep, w.a[1] + f.u[1] * keep];
  assert.ok(Core.validate(p).errors.some(e => e.includes(o.id)));
});
test('rejects overlapping openings', () => {
  const p = clone(PLAN);
  const wid = Object.entries(p.openings.reduce((m, o) => (m[o.wall] = (m[o.wall] || 0) + 1, m), {})).find(([, n]) => n >= 2)[0];
  const [a, b] = p.openings.filter(o => o.wall === wid).sort((x, y) => x.offset - y.offset);
  b.offset = a.offset + a.width / 4;
  assert.ok(Core.validate(p).errors.some(e => /overlap/.test(e)));
});
test('warns about furniture outside the footprint and overlapping walls', () => {
  const v = Core.validate(PLAN, [
    { id: 'x', name: 'Lost sofa', shape: 'sofa', x: -20, y: -20, w: 7, d: 3, rot: 0 },
    { id: 'y', name: 'Wall desk', shape: 'desk', x: PLAN.walls[0].a[0] + 3, y: PLAN.walls[0].a[1], w: 4, d: 2, rot: 0 },
  ]);
  assert.ok(v.warnings.some(w => /Lost sofa is outside/.test(w)));
  assert.ok(v.warnings.some(w => /Wall desk/.test(w)));
});

// ---- first-person collision ------------------------------------------------------------
test('walker cannot pass through a solid wall but can walk through a doorway', () => {
  const door = S.openings.find(o => o.kind === 'door' && o.passable && (o.s1 - o.s0) > 2.4);
  const w = PLAN.walls.find(x => x.id === door.wall), f = Core.frame(w);
  const lists = [S.colliders];
  // through the door: start 2 ft on one side of the centre, walk 4 ft across
  const pos = [door.center[0] + f.n[0] * 2, door.center[1] + f.n[1] * 2];
  Core.moveCircle(pos, -f.n[0] * 4, -f.n[1] * 4, 0.75, lists);
  near((pos[0] - door.center[0]) * f.n[0] + (pos[1] - door.center[1]) * f.n[1], -2, 0.05, 'crossed the doorway');
  // into solid wall: pick a wall stretch with no opening
  const solid = S.walls.find(x => !PLAN.openings.some(o => o.wall === x.id) && x.length > 6);
  const ws = PLAN.walls.find(x => x.id === solid.id), g = Core.frame(ws);
  const mid = [ws.a[0] + g.u[0] * g.L / 2, ws.a[1] + g.u[1] * g.L / 2];
  const p2 = [mid[0] + g.n[0] * 2, mid[1] + g.n[1] * 2];
  Core.moveCircle(p2, -g.n[0] * 4, -g.n[1] * 4, 0.75, lists);
  const side = (p2[0] - mid[0]) * g.n[0] + (p2[1] - mid[1]) * g.n[1];
  assert.ok(side >= g.h + 0.75 - 0.02, `stopped in front of ${solid.id} (side=${side.toFixed(3)})`);
});

console.log(`\n${passed} checks passed${process.exitCode ? ', some FAILED' : ''}. Scene: ${S.stats.walls} walls, ${S.stats.openings} openings, ${S.stats.triangles} triangles, ${Object.keys(S.meshes).length} static meshes.`);
