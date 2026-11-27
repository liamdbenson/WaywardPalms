#!/usr/bin/env python3
"""Regenerate the 2D plan drawing embedded in index.html from the Final plan PDF.

Usage: python3 tools/build_drawing.py FINAL.pdf index.html

Keeps walls, doors, windows, fixtures and outer dimensions as vector paths, drops text,
room badges and the legend, and maps the PDF's greys onto theme colour tokens. Paths keep
their PDF paint order, so the Final PDF's corrections (floor-coloured and white masks
painted over old walls and door swings) still read correctly.
The drawing is written between the <!--DRAWING:...--> markers in index.html.
"""
import os, re, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from geom_extract import flatten_svg

RED, BLUE = '79.998779%', '9.999084%, 29.998779%'


def pct(c):
    return float(re.search(r'rgb\(([\d.]+)%', c).group(1))


def fill_token(f, stroked):
    if not f or f == 'none':
        return 'none'
    p = pct(f)
    if 96 < p < 99:
        return 'var(--floor)'
    if p >= 99:
        return 'var(--paper)' if stroked else 'var(--sheet)'   # unstroked white = eraser mask
    if p < 25:
        return 'var(--wall)'
    return 'var(--fixture)'


def stroke_token(s):
    if not s or s == 'none':
        return None
    p = pct(s)
    if p < 25:
        return 'var(--wall)'
    if p < 35:
        return 'var(--line-strong)'
    if p < 62:
        return 'var(--line)'
    return 'var(--line-soft)'


def rnd(d):
    return re.sub(r'-?\d+\.\d+', lambda m: ('%.2f' % float(m.group(0))).rstrip('0').rstrip('.'), d).strip()


def first_y(d, M):
    n = list(map(float, re.findall(r'-?\d+\.?\d*(?:e-?\d+)?', d)))[:2]
    return M[1]*n[0]+M[3]*n[1]+M[5]


def main(pdf, html):
    svg = tempfile.NamedTemporaryFile(suffix='.svg', delete=False).name
    subprocess.run(['pdftocairo', '-svg', pdf, svg], check=True)
    flat = flatten_svg(svg)
    floor, plan, clip = [], [], []
    seen_wall = False
    for d, st, M in flat:
        f, s = st.get('fill'), st.get('stroke')
        if any(c and (RED in c or BLUE in c) for c in (f, s)):
            continue
        if f and ('16.899109%' in f or '11.999512%' in f):          # room badges
            continue
        y = first_y(d, M)
        if y > 960 or y < 20:                                         # legend, title, logo
            continue
        ft_ = fill_token(f, bool(s)); stt = stroke_token(s)
        style = 'fill:' + ft_
        if stt:
            style += ';stroke:' + stt + ';stroke-width:' + ('%.3g' % float(st.get('stroke-width', '1')))
            if st.get('stroke-dasharray'):
                style += ';stroke-dasharray:' + st['stroke-dasharray']
        tr = '' if M == (1, 0, 0, 1, 0, 0) else ' transform="matrix(%s)"' % ','.join('%.4g' % v for v in M)
        el = '<path d="%s" style="%s"%s/>' % (rnd(d), style, tr)
        if ft_ == 'var(--wall)':
            seen_wall = True
        if ft_ == 'var(--floor)' and not seen_wall and not stt:
            floor.append(el); clip.append('<path d="%s"%s/>' % (rnd(d), tr))
        else:
            plan.append(el)
    src = open(html).read()
    for key, body in (('CLIP', clip), ('FLOOR', floor), ('PLAN', plan)):
        pat = re.compile(r'(<!--DRAWING:%s-->).*?(<!--/DRAWING:%s-->)' % (key, key), re.S)
        if not pat.search(src):
            sys.exit('marker DRAWING:%s not found in %s' % (key, html))
        src = pat.sub(lambda m: m.group(1) + '\n' + '\n'.join(body) + '\n' + m.group(2), src)
    open(html, 'w').write(src)
    print('drawing: %d floor, %d plan paths' % (len(floor), len(plan)), file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
