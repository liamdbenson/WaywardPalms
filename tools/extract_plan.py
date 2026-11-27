#!/usr/bin/env python3
"""Build plan-data.js (the semantic wall / opening / room model) from the plan PDFs.

Usage:
  python3 tools/extract_plan.py FINAL.pdf MEASURED.pdf > plan-data.js

FINAL.pdf    "Final ... Clean" plan: walls, door arcs, window symbols, room badges.
MEASURED.pdf first plan with the blue field-measurement tags (opening width x height).

Requires: pdftocairo (poppler), pdfplumber, shapely.

The output is the single source of truth for the 2D model and the 3D walkthrough.
Re-running this script overwrites hand edits to plan-data.js, so edit plan-data.js
directly once you start adjusting measurements.
"""
import json, math, os, re, subprocess, sys, tempfile
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from geom_extract import (flatten_svg, wall_polygons, strips, path_points, path_endpoints, masks, hidden,
                          ARC_STROKE, LEAF_STROKE, WINDOW_FILL)
import pdfplumber
from shapely.geometry import Polygon, LineString, Point, MultiPolygon
from shapely.ops import unary_union

PT = 9.0                          # PDF points per foot (1/8" = 1'-0")
O = (117.49, 119.89)              # exterior NW corner of the house, in PDF points
EXT_T = 3.0                       # walls at least this thick (pt) are exterior walls

# Room key (Final PDF): number -> (name, key SF or None, ceiling height ft)
ROOM_KEY = {
    1: ('Back Left Bedroom', 195, 10), 2: ('Closet 1', 14, 10), 3: ('Back Left Bedroom Bath', 71, 10),
    4: ('Closet 2', 4, 10), 6: ('Dining Room', 308, 10), 7: ('Mid Left Bedroom', 156, 10),
    8: ('Closet 2', 10, 10), 9: ('Closet 1', 10, 10), 10: ('Hall Closet', 4, 10),
    11: ('Left Hallway', 48, 10), 12: ('Kitchen', 327, 10), 13: ('Left Hall Bathroom', 72, 10),
    14: ('Front Left Bedroom Closet', 18, 10), 15: ('Front Left Bedroom', 171, 10), 16: ('Stairs', None, 10),
    17: ('Laundry Room', 58, 10), 18: ('Garage', None, 10), 19: ('Living Room', 400, 10),
    20: ('Office', 125, 13), 21: ('Foyer', 78, 15), 22: ('Foyer Closet', 6, 10),
    23: ('Right Front Bedroom', 261, 10), 24: ('Closet 3', 36, 10), 25: ('Closet 2', 32, 10),
    26: ('Closet 1', 14, 10), 27: ('Front Right Bedroom Bath', 142, 10),
}
# Badges the Final PDF draws smaller than the rest (positions read from the plan).
EXTRA_BADGES = {4: (249.0, 198.0), 26: (579.0, 713.0)}
DEFAULTS = dict(wallHeight=10.0, interiorDoorHeight=82/12, exteriorDoorHeight=8.0,
                windowHead=8.0, garageDoorHeight=7.0, passthroughHead=8.0)

ft = lambda v: round(v, 4)
def to_ft(p):
    return [ft((p[0]-O[0])/PT), ft((p[1]-O[1])/PT)]


def parse_ftin(s):
    m = re.match(r"\s*(\d+)'-(\d+)(?:\s+(\d+)/(\d+))?\"", s)
    if not m:
        return None
    v = int(m.group(1))*12 + int(m.group(2))
    if m.group(3):
        v += int(m.group(3))/int(m.group(4))
    return v


def svg_of(pdf):
    out = tempfile.NamedTemporaryFile(suffix='.svg', delete=False).name
    subprocess.run(['pdftocairo', '-svg', pdf, out], check=True)
    return out


def blue_tags(pdf, flat):
    """Opening tags (blue boxes) from the measured PDF: width x height in inches."""
    def bbox(d, M):
        pts = [p for sub in path_points(d, M) for p in sub]
        return (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))
    boxes = [bbox(d, M) for d, st, M in flat if st.get('fill') == 'rgb(100%, 100%, 100%)'
             and '29.998779%' in (st.get('stroke') or '')]
    pg = pdfplumber.open(pdf).pages[0]
    ch = [c for c in pg.chars if c.get('non_stroking_color') and
          tuple(round(v, 2) for v in c['non_stroking_color']) == (0.1, 0.3, 0.75)]
    tags = []
    for b in boxes:
        inside = sorted([c for c in ch if b[0]-.3 <= (c['x0']+c['x1'])/2 <= b[2]+.3 and
                         b[1]-.3 <= (c['top']+c['bottom'])/2 <= b[3]+.3], key=lambda c: c['x0'])
        text = ''.join(c['text'] for c in inside)
        parts = text.split('×')
        tags.append(dict(text=text, w=parse_ftin(parts[0]), h=parse_ftin(parts[1]) if len(parts) > 1 else None,
                         open='open' in text, c=((b[0]+b[2])/2, (b[1]+b[3])/2)))
    return tags


def badges(pdf):
    pg = pdfplumber.open(pdf).pages[0]
    ch = sorted([c for c in pg.chars if c['top'] < 960 and c.get('non_stroking_color') == (1.0, 1.0, 1.0)
                 and c['size'] > 5], key=lambda c: (round(c['top']), c['x0']))
    groups = []
    for c in ch:
        for g in groups:
            if abs(g[-1]['top']-c['top']) < 1 and c['x0']-g[-1]['x1'] < 1.5:
                g.append(c); break
        else:
            groups.append([c])
    B = {}
    for g in groups:
        n = int(''.join(c['text'] for c in g))
        B[n] = ((g[0]['x0']+g[-1]['x1'])/2, (min(c['top'] for c in g)+max(c['bottom'] for c in g))/2)
    B.update(EXTRA_BADGES)
    return B


def merge_strips(S, wallU):
    def canon(p0, p1):
        dx, dy = p1[0]-p0[0], p1[1]-p0[1]; L = math.hypot(dx, dy); ux, uy = dx/L, dy/L
        if ux < -1e-9 or (abs(ux) < 1e-9 and uy < 0):
            ux, uy = -ux, -uy
        return ux, uy
    segs = []
    for s in S:
        ux, uy = canon(s['p0'], s['p1']); nx, ny = -uy, ux
        a = s['p0'][0]*ux+s['p0'][1]*uy; b = s['p1'][0]*ux+s['p1'][1]*uy
        segs.append(dict(u=(ux, uy), c=s['p0'][0]*nx+s['p0'][1]*ny, s0=min(a, b), s1=max(a, b), t=s['t']))
    groups = []
    for s in sorted(segs, key=lambda s: (round(math.atan2(s['u'][1], s['u'][0]), 3), s['c'])):
        for g in groups:
            if abs(g['u'][0]*s['u'][1]-g['u'][1]*s['u'][0]) < 0.005 and abs(g['c']-s['c']) < 0.5 and abs(g['t']-s['t']) < 0.45:
                g['m'].append(s); break
        else:
            groups.append(dict(u=s['u'], c=s['c'], t=s['t'], m=[s]))
    wb = wallU.buffer(0.05)

    def filled(g, a, b):
        ux, uy = g['u']; nx, ny = -uy, ux
        return all(wb.contains(Point(nx*g['c']+ux*(a+(b-a)*f), ny*g['c']+uy*(a+(b-a)*f))) for f in (.2, .5, .8))
    W = []
    for g in groups:
        cur = None
        for a, b, t, c in sorted((m['s0'], m['s1'], m['t'], m['c']) for m in g['m']):
            if cur and (a <= cur[1]+0.8 or (a <= cur[1]+6.5 and filled(g, cur[1], a))):
                cur[1] = max(cur[1], b); cur[2].append((b-a, t, c))
            else:
                if cur:
                    W.append((g, cur))
                cur = [a, b, [(b-a, t, c)]]
        W.append((g, cur))
    out = []
    for g, (a, b, parts) in W:
        L = sum(p[0] for p in parts)
        t = sum(p[0]*p[1] for p in parts)/L
        t = 2.91 if abs(t-2.91) < 0.15 else (3.135 if abs(t-3.135) < 0.12 else round(t, 2))
        c = sum(p[0]*p[2] for p in parts)/L
        ux, uy = g['u']; nx, ny = -uy, ux
        if b-a > 0.5:
            out.append(dict(p0=(nx*c+ux*a, ny*c+uy*a), p1=(nx*c+ux*b, ny*c+uy*b), t=t, u=(ux, uy), j={}))
    return out


def line_t(p, u, q, v):
    d = u[0]*v[1]-u[1]*v[0]
    if abs(d) < 0.2:
        return None
    return ((q[0]-p[0])*v[1]-(q[1]-p[1])*v[0])/d


def extend_to_junctions(W):
    for _ in range(2):
        for i, w in enumerate(W):
            for end in (0, 1):
                P = w['p0'] if end == 0 else w['p1']
                out = (-w['u'][0], -w['u'][1]) if end == 0 else w['u']
                best = None
                for j, o in enumerate(W):
                    if j == i:
                        continue
                    t = line_t(P, out, o['p0'], o['u'])
                    if t is None:
                        continue
                    lim = w['t']/2+o['t']/2+0.9
                    if not (-lim <= t <= lim):
                        continue
                    X = (P[0]+out[0]*t, P[1]+out[1]*t)
                    L = math.dist(o['p0'], o['p1'])
                    s = (X[0]-o['p0'][0])*o['u'][0]+(X[1]-o['p0'][1])*o['u'][1]
                    if not (-(w['t']/2+0.9) <= s <= L+w['t']/2+0.9):
                        continue
                    if best is None or abs(t) < abs(best[0]):
                        best = (t, X, j)
                if best and best[0] > -0.05:
                    if end == 0:
                        w['p0'] = best[1]
                    else:
                        w['p1'] = best[1]
                    w['j'][end] = W[best[2]]


def rect(w, e0=0, e1=0, h=None):
    (x0, y0), (x1, y1) = w['p0'], w['p1']; ux, uy = w['u']; nx, ny = -uy, ux
    h = w['t']/2 if h is None else h
    a = (x0-ux*e0, y0-uy*e0); b = (x1+ux*e1, y1+uy*e1)
    return Polygon([(a[0]+nx*h, a[1]+ny*h), (b[0]+nx*h, b[1]+ny*h), (b[0]-nx*h, b[1]-ny*h), (a[0]-nx*h, a[1]-ny*h)])


def symbols(flat, MK):
    arcs, leaves, wins, dashes, panels, ticks = [], [], [], [], [], []
    for k, (d, st, M) in enumerate(flat):
        s = st.get('stroke') or ''; f = st.get('fill') or ''
        pts = [p for sub in path_points(d, M) for p in sub]
        if not pts or max(p[1] for p in pts) > 960:
            continue
        geom = LineString(pts) if len(pts) > 1 else Point(pts[0])
        if (s or f) and hidden(k, geom if not (f and f != 'none' and len(pts) > 2) else Polygon(pts).buffer(0), MK):
            continue
        if s.startswith(ARC_STROKE) and 'C' in d:
            nums = [float(t) for t in re.findall(r'-?\d+\.?\d*(?:e-?\d+)?', d)]
            tr = lambda x, y: (M[0]*x+M[2]*y+M[4], M[1]*x+M[3]*y+M[5])
            P = tr(nums[0], nums[1]); C1 = tr(nums[2], nums[3]); C2 = tr(nums[-4], nums[-3]); Q = tr(nums[-2], nums[-1])
            t1 = (C1[0]-P[0], C1[1]-P[1]); t2 = (Q[0]-C2[0], Q[1]-C2[1])
            n1 = (-t1[1], t1[0]); n2 = (-t2[1], t2[0])
            den = n1[0]*n2[1]-n1[1]*n2[0]
            if abs(den) < 1e-9:
                continue
            k = ((Q[0]-P[0])*n2[1]-(Q[1]-P[1])*n2[0])/den
            C = (P[0]+n1[0]*k, P[1]+n1[1]*k)
            mid = tr(*[(nums[2]+nums[-4])/2, (nums[3]+nums[-3])/2])
            arcs.append(dict(P=P, Q=Q, C=C, r=math.dist(C, P), mid=mid))
        elif s.startswith(LEAF_STROKE) and st.get('stroke-width') == '0.675' and 'C' not in d:
            e = path_endpoints(d, M)
            if len(e) >= 2:
                leaves.append(LineString(e))
                panels.append(LineString(e))
        elif s.startswith(LEAF_STROKE) and st.get('stroke-width') == '0.3' and 'C' not in d:
            e = path_endpoints(d, M)
            if len(e) == 2 and 1.5 < math.dist(*e) < 4.5:
                ticks.append(LineString(e))
        elif f == WINDOW_FILL and s.startswith(LEAF_STROKE) and st.get('stroke-width') == '0.525':
            for p in path_points(d, M):
                if len(p) >= 3:
                    wins.append(Polygon(p).buffer(0))
        elif s and st.get('stroke-dasharray'):
            e = path_endpoints(d, M)
            if len(e) >= 2:
                dashes.append(LineString(e))
    # A panel is a single line along the wall with a jamb tick across each end.
    panels = [l for l in panels if all(any(t.distance(Point(l.coords[i])) < 0.4 for t in ticks) for i in (0, -1))]
    return arcs, leaves, wins, dashes, panels


def main(final_pdf, measured_pdf):
    flat = flatten_svg(svg_of(final_pdf))
    mflat = flatten_svg(svg_of(measured_pdf))
    MK = masks(flat)
    polys = wall_polygons(flat, MK)
    wallU = unary_union([Polygon(p).buffer(0) for p in polys])
    W = merge_strips(strips(polys, 1.3, 6.3), wallU)
    # Drop slivers: short pieces read across the end of another wall, lying inside it.
    for w in sorted(W, key=lambda w: math.dist(w['p0'], w['p1'])):
        if math.dist(w['p0'], w['p1']) >= PT:
            continue
        others = unary_union([rect(o) for o in W if o is not w])
        r = rect(w)
        if r.intersection(others).area > 0.6*r.area:
            W.remove(w)
    extend_to_junctions(W)
    # Parallel pieces read from one polygon whose thickness steps (e.g. a thick plumbing wall
    # continuing as a normal wall): keep the thicker piece, trim the thinner one beyond it.
    for w in sorted(W, key=lambda w: w['t']):
        for o in W:
            if o is w or o['t'] <= w['t'] or abs(w['u'][0]*o['u'][1]-w['u'][1]*o['u'][0]) > 0.01:
                continue
            if rect(w).intersection(rect(o)).area < 0.3*min(rect(w).area, rect(o).area):
                continue
            u = w['u']; pw = sorted(p[0]*u[0]+p[1]*u[1] for p in (w['p0'], w['p1'])); po = sorted(p[0]*u[0]+p[1]*u[1] for p in (o['p0'], o['p1']))
            keep = [(pw[0], min(pw[1], po[0])), (max(pw[0], po[1]), pw[1])]
            keep = [k for k in keep if k[1]-k[0] > PT]
            if not keep:
                W.remove(w); break
            a, b = max(keep, key=lambda k: k[1]-k[0])
            c = w['p0'][0]*(-u[1])+w['p0'][1]*u[0]
            w['p0'] = (-u[1]*c+u[0]*a, u[0]*c+u[1]*a); w['p1'] = (-u[1]*c+u[0]*b, u[0]*c+u[1]*b); w['j'] = {}
            break
    # Short pieces that end up inside other walls after joining add nothing but overlap.
    for w in sorted(W, key=lambda w: math.dist(w['p0'], w['p1'])):
        if math.dist(w['p0'], w['p1']) >= PT:
            continue
        r = rect(w)
        if r.intersection(unary_union([rect(o) for o in W if o is not w])).area > 0.45*r.area:
            W.remove(w)
            for o in W:
                for e in list(o['j']):
                    if o['j'][e] is w:
                        del o['j'][e]
    arcs, leaves, wins, dashes, panels = symbols(flat, MK)
    # Window / threshold symbols drawn on top of a continuous wall: cut the wall there.
    for wn in wins:
        for w in list(W):
            r = rect(w)
            if r.intersection(wn).area < 0.5*wn.area:
                continue
            u = w['u']; s0 = w['p0'][0]*u[0]+w['p0'][1]*u[1]
            pr = [x*u[0]+y*u[1]-s0 for x, y in wn.exterior.coords]
            lo, hi = min(pr), max(pr); L = math.dist(w['p0'], w['p1'])
            if lo > 0.5 and hi < L-0.5:
                at = lambda d: (w['p0'][0]+u[0]*d, w['p0'][1]+u[1]*d)
                W.append(dict(p0=at(hi), p1=w['p1'], t=w['t'], u=u, j={1: w['j'][1]} if 1 in w['j'] else {}))
                w['p1'] = at(lo); w['j'].pop(1, None)
            break
    # wall poché under door/window symbols is not solid wall
    wallU = wallU.difference(unary_union([wn.buffer(0.15) for wn in wins]))
    foot = [rect(w, w['t']/2 if 0 in w['j'] else 0, w['t']/2 if 1 in w['j'] else 0) for w in W]
    tags = blue_tags(measured_pdf, mflat)
    notes = []

    # ---- openings: gaps at free wall ends ------------------------------------------
    found = {}
    for i, w in enumerate(W):
        for end in (0, 1):
            if end in w['j']:
                continue
            P = w['p0'] if end == 0 else w['p1']
            out = (-w['u'][0], -w['u'][1]) if end == 0 else w['u']
            ray = LineString([P, (P[0]+out[0]*200, P[1]+out[1]*200)])
            best = None
            for j, o in enumerate(W):
                if j == i:
                    continue
                x = ray.intersection(foot[j])
                if x.is_empty:
                    continue
                dd = min(math.dist(P, c) for g in getattr(x, 'geoms', [x]) for c in g.coords)
                if dd >= 0.3 and (best is None or dd < best[0]):
                    best = (dd, j)
            if not best:
                continue
            g, j = best; o = W[j]
            col = (abs(w['u'][0]*o['u'][1]-w['u'][1]*o['u'][0]) < 0.03 and
                   abs((P[0]-o['p0'][0])*(-o['u'][1])+(P[1]-o['p0'][1])*o['u'][0]) < 1.5)
            H = (P[0]+out[0]*g, P[1]+out[1]*g)
            key = ('c', min(i, j), max(i, j)) if col else ('p', i, end)
            if key in found:
                continue
            gin = g/PT*12
            region = LineString([P, H]).buffer(w['t']/2+0.6, cap_style=2)
            core = LineString([P, H]).buffer(w['t']/2-0.2, cap_style=2)
            if core.intersection(wallU).area > 0.3*core.area:
                notes.append(f'Gap of {gin:.1f}" near ({P[0]:.0f},{P[1]:.0f}) pt is filled by other wall/fireplace geometry; no opening.')
                continue
            darcs = []
            for a in arcs:
                for J in (P, H):
                    if math.dist(a['C'], J) < 2.5 and (abs(a['r']-g) < 0.25*g or abs(a['r']-g/2) < 0.2*g):
                        darcs.append((a, J))
            pv = []
            for l in panels:
                (x0, y0), (x1, y1) = l.coords[0], l.coords[-1]
                if l.length < 6 or abs((x1-x0)*w['u'][1]-(y1-y0)*w['u'][0])/l.length > 0.05:
                    continue
                if l.within(core.buffer(0.8)):
                    pv.append(l)
            if pv:
                for a in arcs:
                    if region.buffer(2.5).contains(Point(a['C'])) and a['r'] > PT and all(a is not b for b, _ in darcs):
                        darcs.append((a, a['C']))
            win = any(wn.intersection(region).area > 0.25*min(wn.area, region.area) for wn in wins)
            dash = any(dl.intersection(region).length > 0.4*g for dl in dashes)
            lv = [l for l in leaves if l.intersection(region.buffer(4)).length > 1]
            cen = ((P[0]+H[0])/2, (P[1]+H[1])/2)
            tg = sorted([t for t in tags if t['w'] and abs(t['w']-gin) < 3 and math.dist(t['c'], cen) < 60],
                        key=lambda t: math.dist(t['c'], cen))
            tag = tg[0] if tg else None
            if not col and not (darcs or dash or pv or (win and gin < 100)):
                continue
            if not col and gin > 170:
                continue
            if col and not (darcs or dash or win or tag or pv):
                if gin < 14:
                    found[key] = dict(i=i, j=j, end=end, col=True, bridge=True)
                    notes.append(f'{gin:.1f}" gap with no door/window symbol at ({P[0]:.0f},{P[1]:.0f}) pt treated as solid wall.')
                else:
                    notes.append(f'{gin:.1f}" gap with no symbol or tag at ({P[0]:.0f},{P[1]:.0f}) pt left open (no wall, no header).')
                continue
            if any(f2.get('core') is not None and f2['core'].intersection(core).area > 0.5*min(core.area, f2['core'].area)
                   for f2 in found.values()):
                notes.append(f'Duplicate reading of the opening at ({cen[0]:.0f},{cen[1]:.0f}) pt from a parallel wall piece ignored.')
                continue
            found[key] = dict(core=core, i=i, j=j, end=end, col=col, P=P, H=H, g=g, gin=gin, arcs=darcs, win=win,
                              dash=dash, leaves=lv, tag=tag, panels=pv, bridge=False)

    # ---- merge collinear chains into single walls ----------------------------------
    parent = list(range(len(W)))
    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    for k, f in found.items():
        if f['col']:
            parent[find(f['i'])] = find(f['j'])
    # perpendicular openings extend the wall end to the partner centerline
    for k, f in found.items():
        if not f['col']:
            w, o = W[f['i']], W[f['j']]
            P = w['p0'] if f['end'] == 0 else w['p1']
            out = (-w['u'][0], -w['u'][1]) if f['end'] == 0 else w['u']
            t = line_t(P, out, o['p0'], o['u'])
            X = f['H'] if t is None else (P[0]+out[0]*t, P[1]+out[1]*t)
            if f['end'] == 0:
                w['p0'] = X
            else:
                w['p1'] = X
    comps = defaultdict(list)
    for i in range(len(W)):
        comps[find(i)].append(i)
    walls = []
    wall_of = {}
    for root, idx in comps.items():
        u = W[idx[0]]['u']; nx, ny = -u[1], u[0]
        pts = [p for i in idx for p in (W[i]['p0'], W[i]['p1'])]
        proj = [p[0]*u[0]+p[1]*u[1] for p in pts]
        L = {i: math.dist(W[i]['p0'], W[i]['p1']) for i in idx}
        c = sum(L[i]*(W[i]['p0'][0]*nx+W[i]['p0'][1]*ny) for i in idx)/sum(L.values())
        t = max(idx, key=lambda i: L[i]); t = W[t]['t']
        s0, s1 = min(proj), max(proj)
        a = (nx*c+u[0]*s0, ny*c+u[1]*s0); b = (nx*c+u[0]*s1, ny*c+u[1]*s1)
        if math.dist(a, b) < 1.0:
            continue
        wid = len(walls)
        walls.append(dict(a=a, b=b, t=t, u=u, s0=s0, openings=[]))
        for i in idx:
            wall_of[i] = wid

    # ---- solids: wall poché the strip model does not cover (fireplace, chase) --------
    covered = unary_union([rect(w, w['t']/2+0.2 if 0 in w['j'] else 0, w['t']/2+0.2 if 1 in w['j'] else 0) for w in W])
    solids = []
    for g in getattr(wallU.difference(covered.buffer(0.05)), 'geoms', []):
        if g.area > 15:
            r = g.minimum_rotated_rectangle
            solids.append([to_ft(p) for p in list(r.exterior.coords)[:-1]])

    # ---- rooms: holes of the closed wall footprint ---------------------------------
    B = badges(final_pdf)
    closed = [rect(dict(p0=w['a'], p1=w['b'], u=w['u'], t=w['t']), w['t']/2, w['t']/2) for w in walls]
    dash_lines = [d.buffer(0.2) for d in dashes]
    # Kitchen / dining split line (assumption): pick y so Dining ~ key area
    base = unary_union(closed+[Polygon([(p[0]*PT+O[0], p[1]*PT+O[1]) for p in s]) for s in solids]+dash_lines)
    def rooms_for(split_y):
        extra = [LineString([(236, split_y), (406, split_y)]).buffer(0.2)]
        U = unary_union([base]+extra)
        holes = [Polygon(h) for g in getattr(U, 'geoms', [U]) for h in g.interiors]
        return holes
    def area_of(holes, n):
        p = Point(B[n])
        for h in holes:
            if h.contains(p):
                return h.area/PT/PT, h
        return None, None
    best = None
    for yy in [330 + k*0.25 for k in range(0, 240)]:
        hs = rooms_for(yy)
        a6, _ = area_of(hs, 6); a12, _ = area_of(hs, 12)
        if a6 and a12 and a6 != a12:
            err = abs(a6-ROOM_KEY[6][1])
            if best is None or err < best[0]:
                best = (err, yy)
    split_y = best[1]
    notes.append(f'Kitchen/Dining have no wall between them; boundary assumed as an east-west line '
                 f'{(split_y-O[1])/PT:.2f} ft south of the NW corner so Dining matches its key area.')
    holes = rooms_for(split_y)
    # Unnamed pockets split off by a dashed line (e.g. a shower) join the room they open into.
    named = [h for h in holes if any(h.contains(Point(B[n])) for n in ROOM_KEY if n in B)]
    if os.environ.get('WP_DEBUG'):
        for h in holes:
            print('HOLE', round(h.area/81, 1), [round(v) for v in h.bounds], h in named, file=sys.stderr)
    for h in holes:
        if any(h.equals(r) for r in named) or h.area < 4:
            continue
        for k2, r in enumerate(named):
            links = [f for f in found.values() if not f.get('bridge') and f['dash'] and not f['arcs']
                     and h.distance(Point((f['P'][0]+f['H'][0])/2, (f['P'][1]+f['H'][1])/2)) < 3
                     and r.distance(Point((f['P'][0]+f['H'][0])/2, (f['P'][1]+f['H'][1])/2)) < 3]
            if links:
                f = links[0]
                bridge = LineString([f['P'], f['H']]).buffer(3.5, cap_style=2)
                named[k2] = unary_union([r, h, bridge.intersection(unary_union([r, h]).convex_hull)]).buffer(0.05).buffer(-0.05)
                notes.append(f'Unnamed {h.area/PT/PT:.1f} SF space (e.g. shower) opening into room via a dashed opening merged into that room.')
                break
    holes = named
    rooms = []
    for n, (name, sf, clg) in sorted(ROOM_KEY.items()):
        if n not in B:
            continue
        a, h = area_of(holes, n)
        if h is None:
            notes.append(f'Room {n} ({name}) badge is not inside a closed region.'); continue
        h = h.simplify(0.05)
        rooms.append(dict(id=f'R{n:02d}', num=n, name=name, keyArea=sf, ceiling=clg,
                          polygon=[to_ft(p) for p in list(h.exterior.coords)[:-1]]))
    used = defaultdict(list)
    for r in rooms:
        used[tuple(map(tuple, r['polygon']))].append(r['num'])
    for k, v in used.items():
        if len(v) > 1:
            notes.append(f'Rooms {v} share one closed region (open plan); each keeps the shared outline.')

    # ---- exterior walls: one side of the wall faces outside every room --------------
    house = unary_union([base]+[h for h in holes])
    for w in walls:
        ux, uy = w['u']; nx, ny = -uy, ux
        m = ((w['a'][0]+w['b'][0])/2, (w['a'][1]+w['b'][1])/2)
        L = math.dist(w['a'], w['b'])
        outside = 0
        for f in (0.2, 0.5, 0.8):
            q = (w['a'][0]+ux*L*f, w['a'][1]+uy*L*f)
            for sgn in (1, -1):
                pt = Point(q[0]+sgn*nx*(w['t']/2+2.0), q[1]+sgn*ny*(w['t']/2+2.0))
                if not house.buffer(0.3).contains(pt):
                    outside += 1
        w['ext'] = outside >= 2

    # ---- describe each opening relative to its parent wall ------------------------
    def side_of(wall, pt):
        # 'left' = left-hand side when walking from wall start to wall end, plan north up
        ux, uy = wall['u']; lx, ly = uy, -ux
        return 'left' if (pt[0]-wall['a'][0])*lx+(pt[1]-wall['a'][1])*ly > 0 else 'right'
    for k, f in found.items():
        if f.get('bridge'):
            continue
        wid = wall_of.get(f['i'])
        if wid is None:
            continue
        wall = walls[wid]; u = wall['u']
        proj = lambda q: (q[0]*u[0]+q[1]*u[1])-wall['s0']
        sa = proj(f['P']); sb = proj(f['H'])
        lo, hi = min(sa, sb), max(sa, sb)
        if f.get('panels'):
            # A run of fixed glass panels and doors (single-line panels with jamb ticks).
            pan = sorted((min(proj(l.coords[0]), proj(l.coords[-1])), max(proj(l.coords[0]), proj(l.coords[-1]))) for l in f['panels'])
            cen = ((f['P'][0]+f['H'][0])/2, (f['P'][1]+f['H'][1])/2)
            ptag = sorted([t for t in tags if 'panel' in t['text'] and math.dist(t['c'], cen) < 80], key=lambda t: math.dist(t['c'], cen))
            ph = ptag[0]['h']/12 if ptag and ptag[0]['h'] else DEFAULTS['exteriorDoorHeight']
            for a0, b0 in pan:
                wall['openings'].append(dict(offset=ft((a0+b0)/2/PT), width=ft((b0-a0)/PT), kind='window', style='panel',
                                             height=ft(ph), sill=0.0,
                                             source=f'Final PDF panel line; height from tag "{ptag[0]["text"]}"' if ptag else 'Final PDF panel line; height default'))
            cuts = [lo] + [v for ab in pan for v in ab] + [hi]
            for a0, b0 in zip(cuts[0::2], cuts[1::2]):
                if b0-a0 < 0.4*PT:
                    continue
                sub = [(a, a['C']) for a, J in f['arcs'] if a0-2.5 <= proj(a['C']) <= b0+2.5]
                op = dict(offset=ft((a0+b0)/2/PT), width=ft((b0-a0)/PT), sill=0.0, source='Final PDF door swing')
                if sub:
                    jambs = {'start' if abs(proj(J)-a0) < abs(proj(J)-b0) else 'end' for a, J in sub}
                    op.update(kind='door', style='swing', leaves=2 if len(jambs) == 2 else 1,
                              hinge='both' if len(jambs) == 2 else jambs.pop(), swing=side_of(wall, sub[0][0]['mid']),
                              height=ft(DEFAULTS['exteriorDoorHeight'] if wall['ext'] else DEFAULTS['interiorDoorHeight']))
                else:
                    op.update(kind='open', height=None)
                wall['openings'].append(op)
            notes.append(f'Final PDF redraws the opening run at ({cen[0]:.0f},{cen[1]:.0f}) pt as single-line panels plus a door; '
                         f'panels modelled as full-height fixed glass ({ph:.2f} ft).')
            continue
        width_in = f['gin']; tag = f['tag']
        op = dict(offset=ft((lo+hi)/2/PT), width=ft((hi-lo)/PT))
        h_tag = tag['h']/12 if tag and tag['h'] else None
        src = f'tag "{tag["text"]}"' if tag else 'default'
        if f['arcs']:
            jambs = {('start' if abs((J[0]*u[0]+J[1]*u[1])-wall['s0']-lo) < abs((J[0]*u[0]+J[1]*u[1])-wall['s0']-hi) else 'end')
                     for a, J in f['arcs']}
            swing = side_of(wall, f['arcs'][0][0]['mid'])
            op.update(kind='door', style='swing', leaves=2 if len(jambs) == 2 else 1,
                      hinge='both' if len(jambs) == 2 else jambs.pop(), swing=swing,
                      height=ft(h_tag or (DEFAULTS['exteriorDoorHeight'] if wall['ext'] else DEFAULTS['interiorDoorHeight'])),
                      sill=0.0)
        elif f['dash'] and width_in >= 90 and wall['ext']:
            op.update(kind='garage', height=ft(h_tag or DEFAULTS['garageDoorHeight']), sill=0.0)
            if not h_tag:
                notes.append(f'Garage door {width_in/12:.1f} ft wide: height not measured, assumed {DEFAULTS["garageDoorHeight"]:.0f} ft.')
        elif f['dash'] and not f['win']:
            op.update(kind='open', height=ft(h_tag) if h_tag else None, sill=0.0)
        elif f['win'] and tag and tag['open']:
            h = h_tag or 4.0
            op.update(kind='passthrough', height=ft(h), sill=ft(DEFAULTS['passthroughHead']-h))
            notes.append(f'Pass-through "{tag["text"]}": sill not measured, head assumed at {DEFAULTS["passthroughHead"]:.0f} ft.')
        elif f['win'] and wall['ext']:
            h = h_tag or 6.0
            op.update(kind='window', height=ft(h), sill=ft(max(0.0, DEFAULTS['windowHead']-h)))
        elif f['win'] and width_in < 28:
            h = h_tag or 6.0
            op.update(kind='window', height=ft(h), sill=ft(max(0.0, DEFAULTS['windowHead']-h)))
            notes.append(f'Window symbol {width_in:.1f}" wide in an interior wall at ({f["P"][0]:.0f},{f["P"][1]:.0f}) pt modelled as interior glazing (sidelight).')
        elif f['win']:
            notes.append(f'Window symbol {width_in:.1f}" wide in an interior wall at ({f["P"][0]:.0f},{f["P"][1]:.0f}) pt modelled as a pocket door.')
            op.update(kind='door', style='pocket', leaves=1, hinge=None, swing=None,
                      height=ft(h_tag or DEFAULTS['interiorDoorHeight']), sill=0.0)
        elif f['leaves'] and tag:
            op.update(kind='door', style='bifold', leaves=2, hinge='both', swing=side_of(wall, f['leaves'][0].interpolate(0.5, normalized=True).coords[0]),
                      height=ft(h_tag or DEFAULTS['interiorDoorHeight']), sill=0.0)
        else:
            op.update(kind='open', height=ft(h_tag) if h_tag else ft(DEFAULTS['interiorDoorHeight']), sill=0.0)
            notes.append(f'Opening {width_in:.1f}" at ({f["P"][0]:.0f},{f["P"][1]:.0f}) pt has no door symbol; modelled as a cased opening.')
        op['source'] = src
        dup = [o for o in wall['openings'] if min(o['offset']+o['width']/2, op['offset']+op['width']/2)
               - max(o['offset']-o['width']/2, op['offset']-op['width']/2) > 0.5*min(o['width'], op['width'])]
        if dup:
            continue
        wall['openings'].append(op)

    used_arcs = {id(a) for f in found.values() if not f.get('bridge') for a, J in f['arcs']}
    notes[:] = list(dict.fromkeys(notes))
    for a in arcs:
        if id(a) not in used_arcs:
            notes.append(f'Door swing arc at ({a["C"][0]:.0f},{a["C"][1]:.0f}) pt (r={a["r"]/PT*12:.0f}") is not attached to any opening.')
    # fidelity: wall model footprint (minus openings) vs PDF wall poché
    model = unary_union(closed).difference(unary_union([
        LineString([f['P'], f['H']]).buffer(max(W[f['i']]['t'], 1)/2+0.3, cap_style=2)
        for f in found.values() if not f.get('bridge')]))
    pdf_walls = wallU.difference(unary_union([Polygon([(p[0]*PT+O[0], p[1]*PT+O[1]) for p in sd]) for sd in solids]))
    inter = model.intersection(pdf_walls).area; uni = model.union(pdf_walls).area
    print(f'wall footprint IoU vs PDF poché: {inter/uni:.3f} (model {model.area/81:.1f} SF, PDF {pdf_walls.area/81:.1f} SF)', file=sys.stderr)

    # ---- emit ------------------------------------------------------------------------
    # Posts read as tiny walls that sit inside a neighbouring wall's end add only overlap.
    for w in walls:
        L = math.dist(w['a'], w['b'])
        if L >= PT or w['openings']:
            continue
        mid = Point((w['a'][0]+w['b'][0])/2, (w['a'][1]+w['b'][1])/2)
        if any(o is not w and rect(dict(p0=o['a'], p1=o['b'], u=o['u'], t=o['t'])).buffer(0.05).contains(mid) for o in walls):
            w['drop'] = True
            notes.append(f'A {L/PT*12:.1f}" post at ({mid.x:.0f},{mid.y:.0f}) pt is absorbed into the adjoining wall.')
    walls = [w for w in walls if not w.get('drop')]
    walls.sort(key=lambda w: (round(min(w['a'][1], w['b'][1])), round(min(w['a'][0], w['b'][0]))))
    out_walls, out_open = [], []
    n_op = 0
    for k, w in enumerate(walls):
        wid = f'W{k+1:03d}'
        out_walls.append(dict(id=wid, a=to_ft(w['a']), b=to_ft(w['b']), thickness=ft(w['t']/PT),
                              exterior=w['ext']))
        for op in sorted(w['openings'], key=lambda o: o['offset']):
            n_op += 1
            d = dict(id=f'O{n_op:03d}', wall=wid, kind=op['kind'], offset=op['offset'], width=op['width'],
                     height=op['height'], sill=op['sill'])
            for key in ('style', 'leaves', 'hinge', 'swing'):
                if op.get(key) is not None:
                    d[key] = op[key]
            d['source'] = op['source']
            out_open.append(d)
    data = dict(
        schema='wayward-palms-plan/1',
        units='ft',
        unitsNote='All lengths are decimal feet. Origin is the exterior NW corner of the house; '
                  '+x runs east, +y runs south (plan view, north up). Heights are measured up from the floor.',
        drawing=dict(ptPerFoot=PT, originPt=list(O), note='2D drawing is the Final PDF at 1/8" = 1\'-0" (9 pt = 1 ft).'),
        defaults=dict(wallHeight=DEFAULTS['wallHeight'], eyeHeight=5+7/12, wallThicknessInterior=ft(2.91/PT),
                      wallThicknessExterior=ft(3.135/PT)),
        walls=out_walls, openings=out_open,
        solids=[dict(id=f'S{i+1:02d}', polygon=s, height=None, note='fireplace mass' if i == 0 else 'wall chase')
                for i, s in enumerate(solids)],
        rooms=rooms,
        assumptions=notes,
    )
    js = json.dumps(data, indent=1)
    js = re.sub(r'\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]', r'[\1, \2]', js)
    print('/* Wayward Palms main level: semantic plan model (single source of truth).\n'
          ' * Units: decimal FEET. Origin: exterior NW corner. +x east, +y south. Heights up from floor.\n'
          ' * Generated by tools/extract_plan.py, then edited by hand where noted. Validate with\n'
          ' *   node tests/verify-3d.js\n'
          ' * after any change. See README.md "Changing a measurement". */')
    print('(function (root) {\nconst PLAN = ' + js + ';\n'
          'if (typeof module !== "undefined" && module.exports) module.exports = PLAN; else root.WP_PLAN = PLAN;\n'
          '})(typeof self !== "undefined" ? self : this);')
    print(f'walls={len(out_walls)} openings={len(out_open)} rooms={len(rooms)} solids={len(solids)}', file=sys.stderr)
    for n in notes:
        print('NOTE', n, file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
