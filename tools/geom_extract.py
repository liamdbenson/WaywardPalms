"""Shared helpers for extracting a semantic wall model from the plan PDF's vector paths.

All PDF coordinates are in points; the drawing scale is 1/8" = 1'-0", so 9 pt = 1 ft.
"""
import math, re, xml.etree.ElementTree as ET

NS = '{http://www.w3.org/2000/svg}'
PT_PER_FT = 9.0
WALL_FILL = 'rgb(18.431091%'          # solid wall poché
ARC_STROKE = 'rgb(47.842407%'          # door swing arcs
LEAF_STROKE = 'rgb(18.431091%'         # door leaves (0.675 wide)
WINDOW_FILL = 'rgb(100%, 100%, 100%)'  # window symbol: white fill + dark 0.525 stroke
DASH_STROKES = ('rgb(60.391235%',)     # "open / missing wall" dashed lines


def _mat(tr):
    if not tr:
        return (1, 0, 0, 1, 0, 0)
    m = re.match(r'matrix\(([^)]*)\)', tr)
    return tuple(map(float, re.split(r'[ ,]+', m.group(1).strip())))


def _mul(a, b):
    return (a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
            a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5])


def flatten_svg(fn):
    """Return [(d, style, matrix)] for every <path>, with inherited presentation attributes."""
    keys = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray']
    out = []

    def walk(el, st, M):
        st = dict(st)
        for k in keys:
            if el.get(k) is not None:
                st[k] = el.get(k)
        M = _mul(M, _mat(el.get('transform')))
        tag = el.tag.replace(NS, '')
        if tag == 'defs':
            return
        if tag == 'path':
            out.append((el.get('d'), st, M))
        for c in el:
            walk(c, st, M)
    walk(ET.parse(fn).getroot(), {'fill': 'rgb(0%, 0%, 0%)'}, (1, 0, 0, 1, 0, 0))
    return out


def path_points(d, M):
    """Subpaths as point lists (Bezier control points included; fine for bbox / endpoints)."""
    subs = []
    for sub in re.split(r'(?=M)', d):
        toks = re.findall(r'[MLCZ]|-?\d+\.?\d*(?:e-?\d+)?', sub)
        pts, cmd, buf = [], None, []
        for t in toks:
            if t in 'MLCZ':
                cmd = t
                continue
            buf.append(float(t))
            if len(buf) == 2:
                x, y = buf
                pts.append((M[0]*x+M[2]*y+M[4], M[1]*x+M[3]*y+M[5]))
                buf = []
        if pts:
            subs.append(pts)
    return subs


def path_endpoints(d, M):
    """Start and end on-curve points of a path (skips Bezier control points)."""
    toks = re.findall(r'[MLCZ]|-?\d+\.?\d*(?:e-?\d+)?', d)
    on = []
    cmd, buf = None, []
    for t in toks:
        if t in 'MLCZ':
            cmd = t
            buf = []
            continue
        buf.append(float(t))
        need = 6 if cmd == 'C' else 2
        if len(buf) == need:
            x, y = buf[-2], buf[-1]
            on.append((M[0]*x+M[2]*y+M[4], M[1]*x+M[3]*y+M[5]))
            buf = []
    return on


FLOOR_FILL = 'rgb(96.861267%'


def masks(flat, ymax=960):
    """Opaque floor-colour or white fills, with paint order. Anything painted earlier and
    lying under one of these is hidden in the drawing (the Final PDF erases changed walls,
    old panels and old door swings this way)."""
    from shapely.geometry import Polygon
    out = []
    for k, (d, st, M) in enumerate(flat):
        f = st.get('fill') or ''
        if st.get('stroke') or not (f.startswith(FLOOR_FILL) or f == 'rgb(100%, 100%, 100%)'):
            continue
        for p in path_points(d, M):
            if len(p) >= 3 and max(q[1] for q in p) < ymax:
                g = Polygon(p).buffer(0)
                if g.area > 0.5:
                    out.append((k, g))
    return out


def hidden(k, geom, mask_list, frac=0.6):
    """True when geom (painted at index k) is mostly covered by masks painted after it."""
    later = [g for j, g in mask_list if j > k and g.intersects(geom)]
    if not later:
        return False
    from shapely.ops import unary_union
    cover = unary_union(later)
    if geom.area > 0:
        return geom.intersection(cover).area > frac*geom.area
    return geom.intersection(cover).length > frac*geom.length


def wall_polygons(flat, mask_list=()):
    """Wall poché polygons, minus anything painted over them later."""
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    polys = []
    for k, (d, st, M) in enumerate(flat):
        if st.get('fill', '').startswith(WALL_FILL) and not st.get('stroke'):
            later = [g for j, g in mask_list if j > k]
            cut = unary_union(later) if later else None
            for p in path_points(d, M):
                if p[0] == p[-1]:
                    p = p[:-1]
                q = []
                for pt in p:
                    if not q or math.dist(pt, q[-1]) > 1e-3:
                        q.append(pt)
                if len(q) < 3:
                    continue
                if cut is not None and Polygon(q).buffer(0).intersects(cut):
                    rest = Polygon(q).buffer(0).difference(cut)
                    for g in getattr(rest, 'geoms', [rest]):
                        if g.area > 0.3:
                            polys.append(list(g.exterior.coords)[:-1])
                else:
                    polys.append(q)
    return polys


def strips(polys, tmin=2.4, tmax=3.7):
    """Pair antiparallel edges of each wall polygon that face each other across the wall."""
    from shapely.geometry import Polygon, Point
    out = []
    for poly in polys:
        P = Polygon(poly).buffer(0)
        E = [(poly[i], poly[(i+1) % len(poly)]) for i in range(len(poly))]
        E = [e for e in E if math.dist(*e) > 1e-3]
        for i, (a, b) in enumerate(E):
            L = math.dist(a, b); ux, uy = (b[0]-a[0])/L, (b[1]-a[1])/L
            nx, ny = -uy, ux
            for j in range(i+1, len(E)):
                c, d = E[j]
                L2 = math.dist(c, d); vx, vy = (d[0]-c[0])/L2, (d[1]-c[1])/L2
                if ux*vx+uy*vy > -0.9995:
                    continue
                dist = (c[0]-a[0])*nx+(c[1]-a[1])*ny
                if not (tmin <= abs(dist) <= tmax):
                    continue
                s0 = (c[0]-a[0])*ux+(c[1]-a[1])*uy; s1 = (d[0]-a[0])*ux+(d[1]-a[1])*uy
                lo, hi = max(0, min(s0, s1)), min(L, max(s0, s1))
                if hi-lo < 0.3:
                    continue
                mx, my = a[0]+nx*dist/2, a[1]+ny*dist/2
                p0 = (mx+ux*lo, my+uy*lo); p1 = (mx+ux*hi, my+uy*hi)
                mid = ((p0[0]+p1[0])/2, (p0[1]+p1[1])/2)
                if not P.buffer(0.05).contains(Point(mid)):
                    continue
                out.append({'p0': p0, 'p1': p1, 't': abs(dist)})
    return out
