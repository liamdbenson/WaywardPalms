#!/usr/bin/env node
/* Browser check of the 2D planner + 3D walkthrough. Run: node tests/e2e.js [screenshot-dir]
 * Needs Playwright with Chromium and network access to cdnjs (three.js). */
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.error('Playwright is not installed; skipping browser checks.'); process.exit(0); }
const out = process.argv[2] || null;
const url = 'file://' + path.resolve(__dirname, '..', 'index.html');
const assert = require('assert');

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' || (m.type() === 'warning' && !/GL Driver Message|GPU stall/.test(m.text()))) problems.push(m.type() + ': ' + m.text()); });
  const shot = async name => { if (out) await page.screenshot({ path: path.join(out, name) }); };
  let n = 0; const ok = msg => { n++; console.log('  ok  ' + msg); };

  await page.goto(url); await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await page.reload();
  await page.waitForTimeout(500);
  await shot('01-2d.png');
  const plan = await page.evaluate(() => ({ walls: WP_PLAN.walls.length, openings: WP_PLAN.openings.length }));

  // 3D overhead
  await page.click('#view-3d'); await page.waitForTimeout(1200);
  let st = await page.evaluate(() => WP3D.state());
  assert.strictEqual(st.walls, plan.walls); assert.strictEqual(st.openings, plan.openings); assert.strictEqual(st.mode, 'over');
  ok(`3D scene built from the plan: ${st.walls} walls, ${st.openings} openings, ${st.triangles} triangles, ${st.drawCalls} draw calls`);
  await shot('02-3d-overhead.png');

  // 3D -> 2D sync: drag the sofa in 3D
  const sofa = await page.evaluate(() => WPPlanner.items().find(i => i.name === 'Sofa'));
  const top = await page.evaluate(([x, y, h]) => WP3D.screenOf(x, y, h), [sofa.x, sofa.y, 2.8]);
  const dst = await page.evaluate(([x, y, h]) => WP3D.screenOf(x, y, h), [sofa.x - 2, sofa.y - 1, 2.8]);
  await page.mouse.move(top.x, top.y); await page.mouse.down(); await page.mouse.move(dst.x, dst.y, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(200);
  const moved = await page.evaluate(id => { const it = WPPlanner.items().find(i => i.id === id); const g = document.querySelector(`#furniture [data-id="${id}"]`); return { x: it.x, y: it.y, tr: g.getAttribute('transform') }; }, sofa.id);
  assert.ok(Math.abs(moved.x - sofa.x) > 1, 'sofa moved in 3D');
  const pt = (moved.x * 9 + 117.49).toFixed(2);
  assert.ok(moved.tr.includes(pt), '2D drawing shows the new position');
  ok(`dragging the sofa in 3D moved it in 2D (${sofa.x.toFixed(2)} → ${moved.x.toFixed(2)} ft east)`);

  // 2D -> 3D sync: rotate it from the inspector, then check the mesh
  await page.fill('#i-rot', '90'); await page.dispatchEvent('#i-rot', 'change'); await page.waitForTimeout(100);
  const mesh = await page.evaluate(id => WP3D.meshOf(id), sofa.id);
  assert.ok(Math.abs(mesh.rotY + Math.PI / 2) < 1e-6, 'mesh rotated');
  ok('rotating the sofa in the inspector rotated its 3D model');
  await page.click('#view-2d'); await page.waitForTimeout(200);
  const g2 = await page.evaluate(id => document.querySelector(`#furniture [data-id="${id}"]`).getAttribute('transform'), sofa.id);
  assert.ok(g2.includes('rotate(90)')); ok('2D plan shows the same rotation');
  await page.click('#view-3d'); await page.waitForTimeout(300);

  // optional snap to walls: drop the dresser near a wall, it turns to face the room and sits flush
  await page.check('#v3-snapw');
  const dres = await page.evaluate(() => WPPlanner.items().find(i => i.name === 'Dresser'));
  const a1 = await page.evaluate(([x, y, h]) => WP3D.screenOf(x, y, h), [dres.x, dres.y, 3]);
  const a2 = await page.evaluate(([x, y, h]) => WP3D.screenOf(x, y, h), [dres.x + 0.4, dres.y + 0.6, 3]);
  await page.mouse.move(a1.x, a1.y); await page.mouse.down(); await page.mouse.move(a2.x, a2.y, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(150);
  const snapped = await page.evaluate(id => { const it = WPPlanner.items().find(i => i.id === id); const f = PlanCore.nearestWallFace(WPPlanner.plan(), [it.x, it.y]); return { it, f }; }, dres.id);
  assert.ok(Math.abs(snapped.f.dist - snapped.it.d / 2) < 0.05, `dresser flush to wall (gap ${(snapped.f.dist - snapped.it.d / 2).toFixed(3)} ft)`);
  await page.uncheck('#v3-snapw');
  ok('Snap to walls pushes a dropped piece flush against the nearest wall');

  // cut-away + top-down
  await page.click('#v3-top'); await page.selectOption('#v3-walls', 'cut'); await page.waitForTimeout(300);
  await shot('03-3d-topdown-cutaway.png');
  ok('top-down preset and wall cut-away render');

  // first person: walk through a door, stop at a wall
  const door = await page.evaluate(() => {
    const B = WP3D.built();
    const d = B.openings.find(o => o.kind === 'door' && o.passable && o.s1 - o.s0 > 2.5 && o.id !== 'x');
    const w = WP_PLAN.walls.find(x => x.id === d.wall), f = PlanCore.frame(w);
    return { c: d.center, n: f.n, h: f.h };
  });
  await page.keyboard.press('v'); await page.waitForTimeout(200);
  st = await page.evaluate(() => WP3D.state()); assert.strictEqual(st.mode, 'fp');
  const yawFor = (nx, ny) => Math.atan2(nx, -ny);                    // facing (nx, ny) in plan
  await page.evaluate(([x, y, yaw]) => WP3D.walkTo(x, y, yaw), [door.c[0] + door.n[0] * 2.5, door.c[1] + door.n[1] * 2.5, yawFor(-door.n[0], -door.n[1])]);
  await page.keyboard.down('w'); await page.waitForTimeout(1400); await page.keyboard.up('w');
  st = await page.evaluate(() => WP3D.state());
  const side = (st.avatar.x - door.c[0]) * door.n[0] + (st.avatar.y - door.c[1]) * door.n[1];
  assert.ok(side < -1, `walked through the doorway (side ${side.toFixed(2)})`);
  ok('first person: W walks through a door opening');
  await shot('04-first-person.png');
  const wall = await page.evaluate(() => {
    const B = WP3D.built();
    const w = B.walls.find(x => !WP_PLAN.openings.some(o => o.wall === x.id) && x.length > 8);
    const pw = WP_PLAN.walls.find(x => x.id === w.id), f = PlanCore.frame(pw);
    return { m: [pw.a[0] + f.u[0] * f.L / 2, pw.a[1] + f.u[1] * f.L / 2], n: f.n, h: f.h, id: w.id };
  });
  // stand on the side of the wall that is inside a room
  const inside = await page.evaluate(w => { const p = [w.m[0] + w.n[0] * 2, w.m[1] + w.n[1] * 2]; return WP_PLAN.rooms.some(r => PlanCore.pointInPolygon(p, r.polygon)) ? 1 : -1; }, wall);
  const s0 = inside;
  await page.evaluate(([x, y, yaw]) => WP3D.walkTo(x, y, yaw), [wall.m[0] + wall.n[0] * 2 * s0, wall.m[1] + wall.n[1] * 2 * s0, yawFor(-wall.n[0] * s0, -wall.n[1] * s0)]);
  await page.keyboard.down('w'); await page.waitForTimeout(1500); await page.keyboard.up('w');
  st = await page.evaluate(() => WP3D.state());
  const d2 = ((st.avatar.x - wall.m[0]) * wall.n[0] + (st.avatar.y - wall.m[1]) * wall.n[1]) * s0;
  assert.ok(d2 >= wall.h + 0.7, `stopped by wall ${wall.id} (${d2.toFixed(2)} ft from its centre line)`);
  ok(`first person: solid wall ${wall.id} stops the walker`);

  // switch back: overhead centres on the walker
  await page.keyboard.press('v'); await page.waitForTimeout(200);
  const st2 = await page.evaluate(() => WP3D.state());
  assert.strictEqual(st2.mode, 'over');
  assert.ok(Math.abs(st2.orbit.tx - st.avatar.x) < 1e-6 && Math.abs(st2.orbit.tz - st.avatar.y) < 1e-6);
  ok('V switches to overhead above the walker; V again walks from the same spot');

  // edit dimensions: change a wall thickness (valid), then an impossible opening (rejected)
  await page.click('#v3-edit summary');
  const target = await page.evaluate(() => WP_PLAN.openings.find(o => o.kind === 'window').wall);
  await page.selectOption('#ed-wall', target);
  await page.fill('#ed-t', `6"`); await page.click('#ed-apply'); await page.waitForTimeout(300);
  const thick = await page.evaluate(id => WP3D.built().walls.find(w => w.id === id), target);
  const tw = await page.evaluate(id => WPPlanner.plan().walls.find(w => w.id === id).thickness, target);
  assert.ok(Math.abs(tw - 0.5) < 1e-9, 'thickness applied');
  assert.ok(await page.locator('#ed-msgs .ok').count(), 'rebuild confirmed');
  ok(`Edit dimensions: wall ${target} set to 6″ thick and rebuilt`);
  await page.fill('[data-k="width"] >> nth=0', `80'`); await page.click('#ed-apply'); await page.waitForTimeout(200);
  assert.ok(await page.locator('#ed-msgs .err').count(), 'error shown');
  const still = await page.evaluate(id => WPPlanner.plan().walls.find(w => w.id === id).thickness, target);
  assert.ok(Math.abs(still - 0.5) < 1e-9);
  ok('an opening wider than its wall is rejected and the scene keeps the last good plan');
  await shot('05-edit-panel.png');
  await page.click('#ed-revert'); await page.waitForTimeout(200);
  assert.ok(await page.evaluate(() => WPPlanner.plan() === WP_PLAN)); ok('Revert restores plan-data.js');

  if (problems.length) { console.error('Console problems:\n  ' + problems.join('\n  ')); process.exitCode = 1; }
  else ok('no console errors or warnings');
  console.log(`\n${n} browser checks passed${process.exitCode ? ', with console problems' : ''}.`);
  await browser.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
