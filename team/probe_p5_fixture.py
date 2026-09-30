#!/usr/bin/env python3
"""Orchestrator probe: verify hr-bot's disposable P5 fixture live, and prove it is empty."""
import hashlib, json, os, subprocess, sys

WS = os.environ.get("LOCALAPPDATA", ".").replace(chr(92), "/") + "/Temp"
body_path = WS + "/lg_body.json"
raw = open(body_path, "rb").read()
print("A. login response: bytes=%d sha256=%s" % (len(raw), hashlib.sha256(raw).hexdigest()))
d = json.loads(raw)
print("   keys=%s" % sorted(d.keys()))
print("   user.email=%s  token_len=%d" % (d["user"].get("email"), len(d.get("token", ""))))
tok = d["token"]

def curl(*args):
    return subprocess.run(["curl", "-s", "-w", "\nHTTP=%{http_code} bytes=%{size_download}"]
                         + list(args), capture_output=True, text=True).stdout.strip()

print("B. authed reads with that token (fixture should carry no data):")
for path in ("/api/account/me", "/api/conversations"):
    print("   --- %s ---" % path)
    print("   " + curl("https://loop-gpt.cyou" + path, "-H", "Authorization: Bearer " + tok)[:400])

print("C. same credential, wrong password (negative control):")
print("   " + curl("-X", "POST", "https://loop-gpt.cyou/api/auth/login",
                   "-H", "Content-Type: application/json",
                   "--data", '{"email":"hr.mobile.probe.20260929@example.com","password":"wrong-2941-aa"}')[:300])

print("D. the revision these probes hit (so the evidence ties to served bytes):")
print("   /api/version -> " + curl("https://loop-gpt.cyou/api/version")[:200])
