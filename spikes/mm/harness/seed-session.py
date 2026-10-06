#!/usr/bin/env python3
"""TEST HARNESS ONLY: write a JWT-shaped *fake* mm session into an isolated HOME so the
real mm 7.0.0 binary passes its local auth gate and talks to harness/stub-backend.mjs.
The token is unsigned (alg none) and is only ever sent to the localhost stub.
Usage: seed-session.py <isolated HOME> [projectId]"""
import base64, json, os, sys, time
home = sys.argv[1]
pid = sys.argv[2] if len(sys.argv) > 2 else "isotherm-local"
b = lambda o: base64.urlsafe_b64encode(json.dumps(o, separators=(",", ":")).encode()).decode().rstrip("=")
now = int(time.time())
tok = b({"alg": "none", "typ": "JWT"}) + "." + b({"sub": "isotherm-local-stub", "projectId": pid, "jti": "stub-1", "iat": now, "exp": now + 30 * 86400}) + ".stub"
d = os.path.join(home, ".metamask"); os.makedirs(d, mode=0o700, exist_ok=True)
p = os.path.join(d, "session.json")
json.dump({"schemaVersion": "1.0.0", "data": {"cliToken": tok, "cliRefreshToken": tok, "projectId": pid,
          "chain": None, "walletMode": None, "tradingMode": None, "authMethod": None, "loginMethod": None, "consent": None}},
          open(p, "w"), indent=1)
os.chmod(p, 0o600)
print(f"seeded stub session at {p}")
