/* Wayward Palms plan core: units, validation, wall joins, and mesh / collider generation.
 *
 * Pure JavaScript with no rendering dependency, so the same code drives the browser 3D view
 * and the Node verification script (tests/verify-3d.js).
 *
 * Units: every length is decimal FEET (plan.units === 'ft'). Plan coordinates are x east,
 * y south, origin at the exterior NW corner. 3D coordinates are X = x, Y = height, Z = y.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlanCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const UNIT = 'ft';
  const JOIN_TOL = 0.06;          // ft (~3/4"): endpoints closer than this share a joint
  const OPEN_TOL = 0.02;          // ft: slack when checking openings against their wall
  const PASS_SILL = 0.25;         // an opening is walkable if its sill is at most this...
  const PASS_HEAD = 6.0;          // ...and its head at least this (ft)
  const DOOR_LEAF_T = 1.75 / 12;  // door slab thickness (ft)

  // ---------------------------------------------------------------- units
  function gcd(a, b) { while (b) { const t = b; b = a % b; a = t; } return a; }
  /** Format decimal feet as feet-inches, rounded to 1/denom inch: 5.625 -> 5′-7 1/2″ */
  function formatFtIn(ft, denom = 16) {
    if (ft == null || !isFinite(ft)) return '—';
    const neg = ft < 0; let n = Math.round(Math.abs(ft) * 12 * denom);
    const f = Math.floor(n / (12 * denom)); n -= f * 12 * denom;
    const inch = Math.floor(n / denom), frac = n - inch * denom;
    let fr = '';
    if (frac) { const g = gcd(frac, denom); fr = ` ${frac / g}/${denom / g}`; }
    return `${neg ? '-' : ''}${f}′-${inch}${fr}″`;
  }
  /** Parse a length to decimal feet. Accepts 5.5, 5'6", 5' 6 1/2", 66in, 66", 5ft 6in. */
  function parseLength(s) {
    if (typeof s === 'number') return s;
    const t = String(s).trim().replace(/[′’]/g, "'").replace(/[″”]/g, '"').toLowerCase();
    if (!t) return NaN;
    if (/^-?\d*\.?\d+$/.test(t)) return parseFloat(t);
    const m = t.match(/^(-?\d*\.?\d+)\s*(?:'|ft|feet)?\s*-?\s*(?:(\d*\.?\d+)(?:\s+(\d+)\/(\d+))?\s*(?:"|in|inch|inches)?)?$/);
    const mi = t.match(/^(\d*\.?\d+)(?:\s+(\d+)\/(\d+))?\s*(?:"|in|inch|inches)$/);
    if (mi) return (parseFloat(mi[1]) + (mi[2] ? mi[2] / mi[3] : 0)) / 12;
    if (m && /'|ft|feet/.test(t)) return parseFloat(m[1]) + ((m[2] ? parseFloat(m[2]) : 0) + (m[3] ? m[3] / m[4] : 0)) / 12;
    return NaN;
  }

  // ---------------------------------------------------------------- 2D helpers
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
  const mul = (a, k) => [a[0] * k, a[1] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function polygonArea(p) {
    let s = 0;
    for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
    return s / 2;
  }
  function pointInPolygon(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function lineIntersect(p, d, q, e) {          // p + t d  ∩  q + s e
    const den = cross(d, e);
    if (Math.abs(den) < 1e-9) return null;
    const t = cross(sub(q, p), e) / den;
    return add(p, mul(d, t));
  }
  function segIntersect(a, b, c, d) {
    const r = sub(b, a), s = sub(d, c), den = cross(r, s);
    if (Math.abs(den) < 1e-12) return false;
    const t = cross(sub(c, a), s) / den, u = cross(sub(c, a), r) / den;
    return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
  }
  function polygonsOverlap(A, B) {
    for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++)
      if (segIntersect(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return true;
    return pointInPolygon(A[0], B) || pointInPolygon(B[0], A);
  }
  /** Clip polygon to the half-plane dot(p - o, nrm) >= 0 (Sutherland–Hodgman). */
  function clipHalf(poly, o, nrm) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const da = dot(sub(a, o), nrm), db = dot(sub(b, o), nrm);
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    }
    return out;
  }
  /** Ear-clipping triangulation of a simple polygon (no holes). Returns index triples. */
  function triangulate(poly) {
    const n = poly.length; if (n < 3) return [];
    const idx = []; for (let i = 0; i < n; i++) idx.push(i);
    if (polygonArea(poly) < 0) idx.reverse();
    const tris = []; let guard = 0;
    const inTri = (p, a, b, c) => cross(sub(b, a), sub(p, a)) >= -1e-12 && cross(sub(c, b), sub(p, b)) >= -1e-12 && cross(sub(a, c), sub(p, c)) >= -1e-12;
    while (idx.length > 3 && guard++ < 10000) {
      let clipped = false;
      for (let k = 0; k < idx.length; k++) {
        const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
        const a = poly[i0], b = poly[i1], c = poly[i2];
        const cr = cross(sub(b, a), sub(c, b));
        if (cr <= 1e-12) { if (Math.abs(cr) <= 1e-12 && idx.length > 3) { idx.splice(k, 1); clipped = true; break; } continue; }
        let ok = true;
        for (const j of idx) { if (j === i0 || j === i1 || j === i2) continue; if (inTri(poly[j], a, b, c)) { ok = false; break; } }
        if (!ok) continue;
        tris.push([i0, i1, i2]); idx.splice(k, 1); clipped = true; break;
      }
      if (!clipped) break;
    }
    if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
    else for (let k = 1; k + 1 < idx.length; k++) tris.push([idx[0], idx[k], idx[k + 1]]);   // degenerate fallback
    return tris;
  }

  // ---------------------------------------------------------------- wall frames and joins
  function frame(w) {
    const d = sub(w.b, w.a), L = Math.hypot(d[0], d[1]);
    const u = L > 0 ? [d[0] / L, d[1] / L] : [1, 0];
    return { L, u, n: [-u[1], u[0]], h: w.thickness / 2 };
  }
  /** Resolve how every wall end meets its neighbours: free end, shared joint, or T into a wall. */
  function analyzeJoins(walls) {
    const F = walls.map(frame);
    const ends = [];
    walls.forEach((w, i) => {
      ends.push({ wi: i, e: 0, p: w.a, d: F[i].u });
      ends.push({ wi: i, e: 1, p: w.b, d: mul(F[i].u, -1) });
    });
    // cluster coincident endpoints into joints
    const nodes = [];
    for (const en of ends) {
      let node = nodes.find(nd => dist(nd.p, en.p) < JOIN_TOL);
      if (!node) { node = { p: en.p.slice(), ends: [] }; nodes.push(node); }
      node.ends.push(en); en.node = node;
    }
    const res = walls.map(() => [null, null]);
    for (const node of nodes) {
      if (node.ends.length === 1) {
        const en = node.ends[0], fr = F[en.wi];
        // T: the end touches the interior of another wall
        let tee = null;
        walls.forEach((o, j) => {
          if (j === en.wi || tee) return;
          const fo = F[j]; const s = dot(sub(en.p, o.a), fo.u), off = Math.abs(dot(sub(en.p, o.a), fo.n));
          if (s > JOIN_TOL && s < fo.L - JOIN_TOL && off < Math.max(JOIN_TOL, fo.h * 0.6)) tee = j;
        });
        const nd = [-en.d[1], en.d[0]];
        if (tee !== null) {
          const fo = F[tee], o = walls[tee];
          const sg = Math.sign(dot(en.d, fo.n)) || 1;
          const faceO = add(o.a, mul(fo.n, fo.h * sg));
          const cp = lineIntersect(add(en.p, mul(nd, fr.h)), en.d, faceO, fo.u) || add(en.p, mul(nd, fr.h));
          const cm = lineIntersect(add(en.p, mul(nd, -fr.h)), en.d, faceO, fo.u) || add(en.p, mul(nd, -fr.h));
          res[en.wi][en.e] = { kind: 'tee', other: tee, plus: cp, minus: cm, node: null, nd };
        } else {
          res[en.wi][en.e] = { kind: 'free', plus: add(en.p, mul(nd, fr.h)), minus: add(en.p, mul(nd, -fr.h)), node: null, nd };
        }
        continue;
      }
      // shared joint: sort by direction angle and miter neighbouring faces
      const E = node.ends.slice().sort((a, b) => Math.atan2(a.d[1], a.d[0]) - Math.atan2(b.d[1], b.d[0]));
      const corner = (ei, ej) => {           // +side face of ei meets −side face of ej
        const fi = F[ei.wi], fj = F[ej.wi];
        const ni = [-ei.d[1], ei.d[0]], nj = [-ej.d[1], ej.d[0]];
        const pi = add(node.p, mul(ni, fi.h)), pj = add(node.p, mul(nj, -fj.h));
        const x = Math.abs(cross(ei.d, ej.d)) < 0.02 ? null : lineIntersect(pi, ei.d, pj, ej.d);
        if (!x || dist(x, node.p) > 4 * (fi.h + fj.h)) return { ci: pi, cj: pj };
        return { ci: x, cj: x };
      };
      for (let k = 0; k < E.length; k++) {
        const ei = E[k], ej = E[(k + 1) % E.length];
        const c = E.length === 1 ? null : corner(ei, ej);
        ei.plusC = c.ci; ej.minusC = c.cj;
      }
      for (const en of E) {
        res[en.wi][en.e] = { kind: 'node', plus: en.plusC, minus: en.minusC, node: node.p, nd: [-en.d[1], en.d[0]],
                             neighbours: E.filter(x => x !== en).map(x => x.wi) };
      }
    }
    // Express each end on the wall's own sides: +n (P) and −n (M), with distance s along u.
    return walls.map((w, i) => {
      const f = F[i];
      const [ja, jb] = res[i];
      // end a: d = u, nd = n  -> plus is +n.   end b: d = -u, nd = -n -> plus is -n.
      const aP = ja.plus, aM = ja.minus, bP = jb.minus, bM = jb.plus;
      const s = p => dot(sub(p, w.a), f.u);
      return { frame: f, ends: [ja, jb], P: [aP, bP], M: [aM, bM], sP: [s(aP), s(bP)], sM: [s(aM), s(bM)],
               clear: [Math.max(s(aP), s(aM)), Math.min(s(bP), s(bM))] };
    });
  }
  function footprint(w, J) {
    const pts = [J.P[0], J.P[1]];
    if (J.ends[1].kind === 'node') pts.push(J.ends[1].node);
    pts.push(J.M[1], J.M[0]);
    if (J.ends[0].kind === 'node') pts.push(J.ends[0].node);
    return pts;
  }
  /** Part of a wall footprint between s0 and s1 along the wall. */
  function footprintSlab(w, J, poly, s0, s1) {
    const f = J.frame;
    let p = clipHalf(poly, add(w.a, mul(f.u, s0)), f.u);
    if (p.length) p = clipHalf(p, add(w.a, mul(f.u, s1)), mul(f.u, -1));
    return p;
  }

  // ---------------------------------------------------------------- derived values
  function wallHeights(plan) {
    const def = plan.defaults.wallHeight;
    return plan.walls.map(w => {
      if (w.height != null) return w.height;
      const f = frame(w); let hmax = 0;
      const steps = Math.max(2, Math.ceil(f.L / 2));
      for (let k = 0; k <= steps; k++) {
        const s = f.L * (k / steps);
        for (const sg of [1, -1]) {
          const q = add(add(w.a, mul(f.u, s)), mul(f.n, sg * (f.h + 0.35)));
          for (const r of plan.rooms) if (r.ceiling && pointInPolygon(q, r.polygon)) hmax = Math.max(hmax, r.ceiling);
        }
      }
      return hmax || def;
    });
  }
  function openingSpan(o, H) {
    const z0 = o.sill || 0;
    const z1 = o.height == null ? H : Math.min(H, z0 + o.height);
    return [z0, z1];
  }
  function isPassable(o, H) {
    if (o.kind === 'window') return false;
    const [z0, z1] = openingSpan(o, H);
    return z0 <= PASS_SILL && z1 >= Math.min(PASS_HEAD, H);
  }

  // ---------------------------------------------------------------- validation
  /**
   * Validate a plan (and optionally furniture). Returns { errors, warnings }; a plan with
   * errors must not be rebuilt. Furniture items: { id, name, x, y, w, d, rot } in feet.
   */
  function validate(plan, furniture) {
    const errors = [], warnings = [];
    const num = v => typeof v === 'number' && isFinite(v);
    if (plan.units !== UNIT) errors.push(`plan.units must be "${UNIT}" (got ${JSON.stringify(plan.units)})`);
    const ids = new Set();
    plan.walls.forEach(w => {
      if (ids.has(w.id)) errors.push(`Duplicate wall id ${w.id}`); ids.add(w.id);
      if (![w.a[0], w.a[1], w.b[0], w.b[1], w.thickness].every(num)) { errors.push(`Wall ${w.id}: coordinates and thickness must be numbers`); return; }
      const L = dist(w.a, w.b);
      if (L < 0.05) errors.push(`Wall ${w.id} has zero length (${formatFtIn(L)})`);
      if (!(w.thickness > 0.05 && w.thickness < 3)) errors.push(`Wall ${w.id}: thickness ${formatFtIn(w.thickness)} is out of range`);
      if (w.height != null && !(w.height > 1 && w.height < 40)) errors.push(`Wall ${w.id}: height ${w.height} ft is out of range`);
    });
    if (errors.length) return { errors, warnings };
    const J = analyzeJoins(plan.walls), H = wallHeights(plan);
    const byWall = new Map(plan.walls.map((w, i) => [w.id, i]));
    const perWall = new Map();
    const oids = new Set();
    plan.openings.forEach(o => {
      if (oids.has(o.id)) errors.push(`Duplicate opening id ${o.id}`); oids.add(o.id);
      const i = byWall.get(o.wall);
      if (i === undefined) { errors.push(`Opening ${o.id}: wall ${o.wall} does not exist`); return; }
      if (![o.offset, o.width].every(num) || !(o.width > 0.1)) { errors.push(`Opening ${o.id}: offset and width must be positive numbers`); return; }
      const [c0, c1] = J[i].clear, s0 = o.offset - o.width / 2, s1 = o.offset + o.width / 2;
      if (s0 < c0 - OPEN_TOL || s1 > c1 + OPEN_TOL)
        errors.push(`Opening ${o.id} (${formatFtIn(o.width)} wide at ${formatFtIn(o.offset)}) runs past wall ${o.wall}, whose clear length is ${formatFtIn(c0)} to ${formatFtIn(c1)}`);
      const [z0, z1] = openingSpan(o, H[i]);
      if (!(z0 >= 0)) errors.push(`Opening ${o.id}: sill must be ≥ 0`);
      if (o.height != null && !(o.height > 0)) errors.push(`Opening ${o.id}: height must be > 0`);
      if (o.height != null && z0 + o.height > H[i] + OPEN_TOL) warnings.push(`Opening ${o.id}: top (${formatFtIn(z0 + o.height)}) is above wall ${o.wall} height ${formatFtIn(H[i])}; clipped to the wall`);
      if (!perWall.has(o.wall)) perWall.set(o.wall, []);
      perWall.get(o.wall).push([s0, s1, o.id]);
    });
    perWall.forEach((list, wid) => {
      list.sort((a, b) => a[0] - b[0]);
      for (let k = 1; k < list.length; k++)
        if (list[k][0] < list[k - 1][1] - OPEN_TOL) errors.push(`Openings ${list[k - 1][2]} and ${list[k][2]} overlap on wall ${wid}`);
    });
    // crossing walls (would overlap in 3D)
    for (let i = 0; i < plan.walls.length; i++) for (let j = i + 1; j < plan.walls.length; j++) {
      const a = plan.walls[i], b = plan.walls[j];
      if (segIntersect(a.a, a.b, b.a, b.b)) {
        const x = lineIntersect(a.a, sub(a.b, a.a), b.a, sub(b.b, b.a));
        const nearEnd = x && [a.a, a.b, b.a, b.b].some(p => dist(p, x) < Math.max(a.thickness, b.thickness));
        if (!nearEnd) warnings.push(`Walls ${a.id} and ${b.id} cross; split one at the crossing to avoid overlapping geometry`);
      }
    }
    plan.rooms.forEach(r => {
      if (!Array.isArray(r.polygon) || r.polygon.length < 3 || Math.abs(polygonArea(r.polygon)) < 0.5)
        errors.push(`Room ${r.id} (${r.name}) needs a polygon with at least 3 points and some area`);
      else if (r.keyArea && Math.abs(Math.abs(polygonArea(r.polygon)) - r.keyArea) > Math.max(2, 0.12 * r.keyArea))
        warnings.push(`Room ${r.name}: drawn area ${Math.abs(polygonArea(r.polygon)).toFixed(1)} SF differs from the measured ${r.keyArea} SF`);
    });
    if (furniture && !errors.length) {
      const fp = plan.walls.map((w, i) => footprint(w, J[i]));
      for (const it of furniture) {
        if (![it.x, it.y, it.w, it.d].every(num) || it.w <= 0 || it.d <= 0) { errors.push(`Furniture ${it.name}: invalid size or position`); continue; }
        const rect = furnitureRect(it);
        const inRooms = p => plan.rooms.some(r => pointInPolygon(p, r.polygon)) || fp.some(f => pointInPolygon(p, f));
        if (!inRooms([it.x, it.y]) || rect.filter(p => !inRooms(p)).length > 1)
          warnings.push(`${it.name} is outside the house footprint`);
        else if (it.shape !== 'rug' && fp.some(f => polygonsOverlap(rect, f)))
          warnings.push(`${it.name} overlaps a wall`);
      }
    }
    return { errors, warnings };
  }
  function furnitureRect(it) {
    const a = (it.rot || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), hw = it.w / 2, hd = it.d / 2;
    return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, y]) => [it.x + x * c - y * s, it.y + x * s + y * c]);
  }

  // ---------------------------------------------------------------- mesh building
  function MeshBuf() { this.pos = []; this.nrm = []; this.idx = []; this.col = null; }
  MeshBuf.prototype.poly3 = function (pts, n) {      // planar convex-or-simple polygon in 3D, given 2D tris
    const base = this.pos.length / 3;
    for (const p of pts) { this.pos.push(p[0], p[1], p[2]); this.nrm.push(n[0], n[1], n[2]); }
    return base;
  };
  MeshBuf.prototype.quad = function (a, b, c, d, n) {
    const base = this.poly3([a, b, c, d], n);
    // orient so the winding matches n
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
    if (cx * n[0] + cy * n[1] + cz * n[2] >= 0) this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  MeshBuf.prototype.flat = function (poly2, y, up, color) {   // horizontal polygon at height y
    const tris = triangulate(poly2); if (!tris.length) return 0;
    const base = this.pos.length / 3;
    for (const p of poly2) {
      this.pos.push(p[0], y, p[1]); this.nrm.push(0, up ? 1 : -1, 0);
      if (this.col) this.col.push(color[0], color[1], color[2]);
    }
    let area = 0;
    for (const [i, j, k] of tris) {
      const a = poly2[i], b = poly2[j], c = poly2[k];
      const ccw = cross(sub(b, a), sub(c, a));              // plan coords (x east, y south)
      area += Math.abs(ccw) / 2;
      // 3D up = +Y. With X = x, Z = y, a triangle faces +Y when its plan winding is clockwise
      // as seen with +y down, i.e. cross < 0 here.
      const faceUp = ccw < 0;
      if (faceUp === !!up) this.idx.push(base + i, base + j, base + k); else this.idx.push(base + i, base + k, base + j);
    }
    return area;
  };
  MeshBuf.prototype.box = function (cx, cy, cz, sx, sy, sz, ang) {  // oriented box, ang about Y (plan rotation)
    const c = Math.cos(ang), s = Math.sin(ang);
    const P = (x, y, z) => [cx + x * c - z * s, cy + y, cz + x * s + z * c];
    const hx = sx / 2, hz = sz / 2;
    const v = [P(-hx, 0, -hz), P(hx, 0, -hz), P(hx, 0, hz), P(-hx, 0, hz), P(-hx, sy, -hz), P(hx, sy, -hz), P(hx, sy, hz), P(-hx, sy, hz)];
    const N = (x, z) => [x * c - z * s, 0, x * s + z * c];
    this.quad(v[4], v[5], v[6], v[7], [0, 1, 0]); this.quad(v[0], v[3], v[2], v[1], [0, -1, 0]);
    this.quad(v[0], v[1], v[5], v[4], N(0, -1)); this.quad(v[2], v[3], v[7], v[6], N(0, 1));
    this.quad(v[1], v[2], v[6], v[5], N(1, 0)); this.quad(v[3], v[0], v[4], v[7], N(-1, 0));
  };
  MeshBuf.prototype.out = function () {
    return { positions: new Float32Array(this.pos), normals: new Float32Array(this.nrm),
             indices: new Uint32Array(this.idx), colors: this.col ? new Float32Array(this.col) : null };
  };

  const FLOOR_TONES = { garage: [0.62, 0.62, 0.6], bath: [0.86, 0.87, 0.86], closet: [0.74, 0.66, 0.55], default: [0.78, 0.67, 0.52] };
  function floorTone(r) {
    const n = r.name.toLowerCase();
    if (n.includes('garage')) return FLOOR_TONES.garage;
    if (n.includes('bath') || n.includes('laundry')) return FLOOR_TONES.bath;
    if (n.includes('closet')) return FLOOR_TONES.closet;
    return FLOOR_TONES.default;
  }

  /**
   * Build all static geometry and colliders from the plan. Throws if the plan has errors.
   * Returns { meshes:{walls,floors,ceilings,glass,doors}, walls:[...], openings:[...],
   *           roomFloorArea:{id:SF}, colliders:[{poly,kind,id}], bounds, stats }.
   */
  function buildScene(plan) {
    const v = validate(plan);
    if (v.errors.length) { const e = new Error('Plan has errors:\n' + v.errors.join('\n')); e.validation = v; throw e; }
    const J = analyzeJoins(plan.walls), H = wallHeights(plan);
    const wallsM = new MeshBuf(), glassM = new MeshBuf(), doorsM = new MeshBuf(), floorsM = new MeshBuf(), ceilM = new MeshBuf();
    floorsM.col = [];
    const openingsBy = new Map();
    plan.openings.forEach(o => { if (!openingsBy.has(o.wall)) openingsBy.set(o.wall, []); openingsBy.get(o.wall).push(o); });
    const wallInfo = [], openInfo = [], colliders = [];
    const X = (p, y) => [p[0], y, p[1]];

    plan.walls.forEach((w, i) => {
      const Ji = J[i], f = Ji.frame, Hi = H[i];
      const tri0 = wallsM.idx.length / 3;
      const ops = (openingsBy.get(w.id) || []).slice().sort((a, b) => a.offset - b.offset);
      const spans = ops.map(o => { const [z0, z1] = openingSpan(o, Hi); return { o, s0: o.offset - o.width / 2, s1: o.offset + o.width / 2, z0, z1 }; });
      const at = (s, side) => add(add(w.a, mul(f.u, s)), mul(f.n, side * f.h));
      // long faces, split around openings
      for (const side of [1, -1]) {
        const s0 = side > 0 ? Ji.sP[0] : Ji.sM[0], s1 = side > 0 ? Ji.sP[1] : Ji.sM[1];
        const nrm = [f.n[0] * side, 0, f.n[1] * side];
        let cur = s0;
        const solid = (a, b, z0, z1) => { if (b - a > 1e-4 && z1 - z0 > 1e-4) wallsM.quad(X(at(a, side), z0), X(at(b, side), z0), X(at(b, side), z1), X(at(a, side), z1), nrm); };
        for (const sp of spans) {
          solid(cur, sp.s0, 0, Hi);
          solid(sp.s0, sp.s1, 0, sp.z0);
          solid(sp.s0, sp.s1, sp.z1, Hi);
          cur = sp.s1;
        }
        solid(cur, s1, 0, Hi);
      }
      // opening reveals: jambs, sill tops, head soffits
      for (const sp of spans) {
        const jam = (s, dir) => wallsM.quad(X(at(s, -1), sp.z0), X(at(s, 1), sp.z0), X(at(s, 1), sp.z1), X(at(s, -1), sp.z1), [f.u[0] * dir, 0, f.u[1] * dir]);
        jam(sp.s0, 1); jam(sp.s1, -1);
        if (sp.z0 > 1e-4) wallsM.quad(X(at(sp.s0, -1), sp.z0), X(at(sp.s1, -1), sp.z0), X(at(sp.s1, 1), sp.z0), X(at(sp.s0, 1), sp.z0), [0, 1, 0]);
        if (sp.z1 < Hi - 1e-4) wallsM.quad(X(at(sp.s0, -1), sp.z1), X(at(sp.s1, -1), sp.z1), X(at(sp.s1, 1), sp.z1), X(at(sp.s0, 1), sp.z1), [0, -1, 0]);
      }
      // top face: footprint minus full-height openings
      const fp = footprint(w, Ji);
      const topCuts = spans.filter(sp => sp.z1 >= Hi - 1e-4);
      let segs = [[-1e9, 1e9]];
      for (const c of topCuts) segs = segs.flatMap(([a, b]) => [[a, Math.min(b, c.s0)], [Math.max(a, c.s1), b]]).filter(([a, b]) => b - a > 1e-4);
      for (const [a, b] of segs) { const piece = footprintSlab(w, Ji, fp, a, b); if (piece.length >= 3) wallsM.flat(piece, Hi, true); }
      // end caps: free ends fully; joints where this wall rises above its neighbours
      Ji.ends.forEach((en, e) => {
        const outward = e === 0 ? mul(f.u, -1) : f.u;
        let zLow = 0;
        if (en.kind === 'tee') zLow = H[en.other];
        if (en.kind === 'node') zLow = en.neighbours.length ? Math.min(...en.neighbours.map(k => H[k])) : 0;
        if (zLow >= Hi - 1e-4) return;
        const chain = en.kind === 'node' ? [Ji.M[e], en.node, Ji.P[e]] : [Ji.M[e], Ji.P[e]];
        for (let k = 0; k + 1 < chain.length; k++) {
          const a = chain[k], b = chain[k + 1], ed = sub(b, a);
          let nn = [ed[1], -ed[0]]; const L = Math.hypot(nn[0], nn[1]) || 1; nn = [nn[0] / L, nn[1] / L];
          if (dot(nn, outward) < 0) nn = mul(nn, -1);
          wallsM.quad(X(a, zLow), X(b, zLow), X(b, Hi), X(a, Hi), [nn[0], 0, nn[1]]);
        }
      });
      // door leaves (shown open, as drawn on the plan) and glass
      for (const sp of spans) {
        const o = sp.o, wdt = sp.s1 - sp.s0, zTop = sp.z1 - 0.02;
        if (o.kind === 'window') {
          const m0 = add(w.a, mul(f.u, sp.s0)), m1 = add(w.a, mul(f.u, sp.s1));
          glassM.quad(X(m0, sp.z0), X(m1, sp.z0), X(m1, sp.z1), X(m0, sp.z1), [f.n[0], 0, f.n[1]]);
        } else if (o.kind === 'door' && (o.style === 'swing' || o.style === 'bifold')) {
          const sideSign = o.swing === 'left' ? -1 : 1;              // 'left' of a→b is −n
          const hinges = o.hinge === 'both' ? ['start', 'end'] : [o.hinge || 'start'];
          const leafW = o.style === 'bifold' ? wdt / 4 : wdt / hinges.length;
          for (const hg of hinges) {
            const s = hg === 'start' ? sp.s0 + DOOR_LEAF_T / 2 : sp.s1 - DOOR_LEAF_T / 2;
            const base = add(add(w.a, mul(f.u, s)), mul(f.n, sideSign * (f.h + leafW / 2)));
            const ang = Math.atan2(f.n[1], f.n[0]);
            doorsM.box(base[0], 0.02, base[1], leafW, zTop - 0.02, DOOR_LEAF_T, ang);
          }
        }
      }
      // colliders: footprint pieces between walkable openings
      let cuts = [[-1e9, 1e9]];
      for (const sp of spans) if (isPassable(sp.o, Hi)) cuts = cuts.flatMap(([a, b]) => [[a, Math.min(b, sp.s0)], [Math.max(a, sp.s1), b]]).filter(([a, b]) => b - a > 1e-4);
      for (const [a, b] of cuts) { const piece = footprintSlab(w, Ji, fp, a, b); if (piece.length >= 3) colliders.push({ poly: piece, kind: 'wall', id: w.id }); }
      wallInfo.push({ id: w.id, height: Hi, length: f.L, clear: Ji.clear, footprint: fp, joins: Ji.ends.map(e => e.kind),
                      tri: [tri0, wallsM.idx.length / 3] });
      for (const sp of spans) {
        const c = add(w.a, mul(f.u, sp.o.offset));
        openInfo.push({ id: sp.o.id, wall: w.id, kind: sp.o.kind, center: c, s0: sp.s0, s1: sp.s1, z0: sp.z0, z1: sp.z1,
                        passable: isPassable(sp.o, Hi), jambs: [add(w.a, mul(f.u, sp.s0)), add(w.a, mul(f.u, sp.s1))] });
        if (sp.z0 <= 1e-4) {          // threshold floor under walk-through openings
          const slab = footprintSlab(w, Ji, fp, sp.s0, sp.s1);
          if (slab.length >= 3) floorsM.flat(slab, 0, true, FLOOR_TONES.default);
        }
      }
    });
    // solids (fireplace mass, chases): prisms
    for (const sd of plan.solids || []) {
      const Hs = sd.height || plan.defaults.wallHeight, p = sd.polygon;
      wallsM.flat(p, Hs, true);
      for (let k = 0; k < p.length; k++) {
        const a = p[k], b = p[(k + 1) % p.length], ed = sub(b, a);
        let nn = [ed[1], -ed[0]]; const L = Math.hypot(nn[0], nn[1]) || 1; nn = [nn[0] / L, nn[1] / L];
        const mid = mul(add(a, b), 0.5); if (pointInPolygon(add(mid, mul(nn, 0.01)), p)) nn = mul(nn, -1);
        wallsM.quad(X(a, 0), X(b, 0), X(b, Hs), X(a, Hs), [nn[0], 0, nn[1]]);
      }
      colliders.push({ poly: p, kind: 'solid', id: sd.id });
    }
    for (const sp of openInfo) if (sp.kind === 'window' && sp.z0 <= PASS_SILL) {
      const w = plan.walls.find(x => x.id === sp.wall), i = plan.walls.indexOf(w);
      const piece = footprintSlab(w, J[i], footprint(w, J[i]), sp.s0, sp.s1);
      if (piece.length >= 3) colliders.push({ poly: piece, kind: 'glass', id: sp.id });
    }
    // floors and ceilings per room
    const roomFloorArea = {}, roomCeilingArea = {};
    for (const r of plan.rooms) {
      roomFloorArea[r.id] = floorsM.flat(r.polygon, 0, true, floorTone(r));
      roomCeilingArea[r.id] = ceilM.flat(r.polygon, r.ceiling || plan.defaults.wallHeight, false);
    }
    for (const c of colliders) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of c.poly) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      c.bbox = [x0, y0, x1, y1];
    }
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const w of plan.walls) for (const p of [w.a, w.b]) { bx0 = Math.min(bx0, p[0]); by0 = Math.min(by0, p[1]); bx1 = Math.max(bx1, p[0]); by1 = Math.max(by1, p[1]); }
    const meshes = { walls: wallsM.out(), glass: glassM.out(), doors: doorsM.out(), floors: floorsM.out(), ceilings: ceilM.out() };
    return {
      meshes, walls: wallInfo, openings: openInfo, roomFloorArea, roomCeilingArea, colliders,
      warnings: v.warnings, bounds: [bx0, by0, bx1, by1], maxHeight: Math.max(...H),
      stats: { walls: wallInfo.length, openings: openInfo.length,
               triangles: Object.values(meshes).reduce((s, m) => s + m.indices.length / 3, 0) },
    };
  }

  // ---------------------------------------------------------------- collision
  /** Colliders for furniture items (rugs and very low pieces are walkable). */
  function furnitureColliders(items, heights) {
    const out = [];
    for (const it of items) {
      const h = heights ? heights(it) : 2;
      if (it.shape === 'rug' || h < 0.3) continue;
      const poly = furnitureRect(it);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of poly) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      out.push({ poly, kind: 'furniture', id: it.id, bbox: [x0, y0, x1, y1] });
    }
    return out;
  }
  const _cp = [0, 0];
  function closestOnPoly(px, py, poly, out) {
    let best = Infinity;
    for (let i = 0, n = poly.length; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      const ex = b[0] - a[0], ey = b[1] - a[1], L2 = ex * ex + ey * ey || 1e-12;
      let t = ((px - a[0]) * ex + (py - a[1]) * ey) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = a[0] + ex * t, qy = a[1] + ey * t, d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy);
      if (d2 < best) { best = d2; out[0] = qx; out[1] = qy; }
    }
    return Math.sqrt(best);
  }
  /**
   * Move a circle (pos = [x, y], radius r) by (dx, dy), sliding along colliders.
   * Mutates pos; allocation-free so it can run every frame.
   */
  function moveCircle(pos, dx, dy, r, colliderLists) {
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (r * 0.5)));
    for (let s = 0; s < steps; s++) {
      pos[0] += dx / steps; pos[1] += dy / steps;
      for (let iter = 0; iter < 3; iter++) {
        let pushed = false;
        for (let L = 0; L < colliderLists.length; L++) {
          const list = colliderLists[L];
          for (let k = 0; k < list.length; k++) {
            const c = list[k], bb = c.bbox;
            if (pos[0] < bb[0] - r || pos[0] > bb[2] + r || pos[1] < bb[1] - r || pos[1] > bb[3] + r) continue;
            const inside = pointInPolygon(pos, c.poly);
            const d = closestOnPoly(pos[0], pos[1], c.poly, _cp);
            if (!inside && d >= r) continue;
            let nx = pos[0] - _cp[0], ny = pos[1] - _cp[1];
            const L2 = Math.hypot(nx, ny) || 1e-9; nx /= L2; ny /= L2;
            if (inside) { nx = -nx; ny = -ny; }
            const push = inside ? d + r : r - d;
            pos[0] += nx * (push + 1e-4); pos[1] += ny * (push + 1e-4); pushed = true;
          }
        }
        if (!pushed) break;
      }
    }
    return pos;
  }
  function circleHits(pos, r, colliderLists) {
    for (const list of colliderLists) for (const c of list) {
      if (pointInPolygon(pos, c.poly) || closestOnPoly(pos[0], pos[1], c.poly, _cp) < r) return c;
    }
    return null;
  }

  // ---------------------------------------------------------------- snapping
  /** Nearest wall face to a point: { wall, point, normal (pointing away from the wall), dist, angle }. */
  function nearestWallFace(plan, pt) {
    let best = null;
    for (const w of plan.walls) {
      const f = frame(w); const s = Math.max(0, Math.min(f.L, dot(sub(pt, w.a), f.u)));
      const side = Math.sign(dot(sub(pt, w.a), f.n)) || 1;
      const q = add(add(w.a, mul(f.u, s)), mul(f.n, side * f.h));
      const d = dist(q, pt);
      if (!best || d < best.dist) best = { wall: w.id, point: q, normal: mul(f.n, side), dist: d, angle: Math.atan2(f.u[1], f.u[0]) * 180 / Math.PI };
    }
    return best;
  }

  return {
    UNIT, formatFtIn, parseLength, polygonArea, pointInPolygon, polygonsOverlap, triangulate,
    frame, analyzeJoins, footprint, wallHeights, openingSpan, isPassable,
    validate, buildScene, furnitureRect, furnitureColliders, moveCircle, circleHits, nearestWallFace,
  };
});
