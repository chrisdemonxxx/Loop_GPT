
import json, base64

recs = [json.loads(l) for l in open('axe-results.json').read()..strip().splitlines()]

def srgb(h):
    out = []
    for x in h[1:]:
        c = int(x, 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return out

def L(h):
    r, g, b = srgb(h)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b

out = []
for r in recs:
    byId, crit, ratios = {}, [], {}
    for n in r['nodes']:
        e = byId.setdefault(n['id'], [None, 0])
        e[0] = n['impact']; e[1] += 1
        if n['impact'] == 'critical':
            crit.append(n)
        c = next((a for a in n['any'] if a.get('id') == 'color-contrast'), None)
        if c:
            d = c.get('data') or {}
            f = (d.get('fgColor') or {}).get('computed')
            b = (d.get('bgColor') or {}).get('computed')
            if f:
                v = ratios.setdefault(f + '/' + b, [0, None])
                v[0] += 1
                if v[1] is None:
                    lf, lb = L(f), L(b)
                    v[1] = round((max(lf, lb) + .05) / (min(lf, lb) + .05), 2)
    o = {
        'route': r['route'], 'theme': r['theme'],
        'status': r['status'], 'ms': r['ms'],
        'counts': r['counts'],
        'crit': [(n['id'], (n['target'][0] or '').replace('\\', '\\')) for n in crit],
        'ratios': {k: [v[0], v[1]] for k, v in ratios.items()},
        'byId': byId,
    }
    out.append(o)

for o in out:
    print(o['route'], o['theme'], 'st=' + str(o['status']), 'ms=' + str(o['ms']), o['counts'])
    for c in o['crit']:
        print('  CRIT', c)
    for k, v in o['ratios'].items():
        print('  RAT', k, v)
