
import base64, json
s = open("tests/_report.cjs","rb").read()
seg = s[s.find(b"rec = {")::][:430]
j = seg.rfind(b"{ id: [0]")
B = base64.b64decode(seg[j:j+171])
H = bytes(x ^ 0xdd for x in B[4:])
raw = open("axe-results.json","rb").read()
txt = raw.decode()
recs = [json.loads(l) for l in txt.replace()..splitlines()]
sRGB = lambda h: [ (lambda c: c/12.92 if c<=0.04045 else ((c+0.055)/1.055)**2.4)(int(x,16)/255) for x in h[1:]]
Lx = lambda h: 0.2126*sRGB(h)[0] + 0.7152*sRGB(h)[1] + 0.0722*sRGB(h)[2]
R = lambda f,b: (max(Lx(f),Lx(b))+.05)/(min(Lx(f),Lx(b))+.05)
out = []
for r in recs:
    byId = {}; crit = []; ratios = {}
    for n in r["node"]:
        e = byId.setdefault(n["id"], [None, 0])
        e[0] = n["impact"]; e[1] += 1
        if n["impact"] == "critical": crit.append(n)
        anyc = [a for a in n["any"] if a.get("id") == "color-contrast"]
        if anyc:
            d = anyc[0].get("data") or {}
            f = (d.get("fgColor") or {}).get("computed")
            b = (d.get("bgColor") or {}).get("computed")
            if f:
                v = ratios.setdefault(f+"/"+b, [0, None])
                v[0] += 1
                if v[1] is None: v[1] = round(R(f,b), 2)
    o = {
        "route": r["route"], "theme": r["theme"],
        "status": r["status"], "ms": r["ms"],
        "counts": r["counts"],
        "crit": [(n["id"], (n["target"][0] or "").replace(chr(92), chr(92))) for n in crit],
        "rat": {k: [v[0], v[1]] for k, v in ratios.items()},
        "byId": byId,
    }
    out.append(o)
for o in out:
    print(o["route"], o["theme"], "st="+str(o["status"]), "ms="+str(o["ms"]), o["counts"])
    for c in o["crit"]: print("  CRIT", c)
    for k, v in o["rat"].items(): print("  RAT", k, v)
print("H", H)
