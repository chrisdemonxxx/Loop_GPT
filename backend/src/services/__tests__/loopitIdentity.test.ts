import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  LOOPIT_IDENTITY_SCOPES,
  LOOPIT_IDENTITY_TTL_SECONDS,
  canonicalJson,
  loopitRoleForWorkspace,
  mintLoopitIdentityToken,
  readLoopitIdentityConfig,
  verifyLoopitIdentityToken,
  LoopitIdentityConfigError,
  LoopitIdentityTokenError,
} from '../loopitIdentity'

const config = {
  secret: 'pytest-identity-secret-with-at-least-thirty-two-bytes',
  kid: 'test-kid',
  issuer: 'loopit-gateway',
  audience: 'loopit-control-plane',
}

describe('loopit identity token format', () => {
  it('maps workspace roles onto roles verify_identity accepts', () => {
    expect(loopitRoleForWorkspace('owner')).toBe('owner')
    expect(loopitRoleForWorkspace('editor')).toBe('member')
    expect(loopitRoleForWorkspace('viewer')).toBe('viewer')
  })

  it('fails closed when the signing secret or kid is unset', () => {
    expect(() => readLoopitIdentityConfig({})).toThrow(LoopitIdentityConfigError)
    expect(() => readLoopitIdentityConfig({ LOOPIT_IDENTITY_SECRET: 'x'.repeat(40) })).toThrow(/LOOPIT_IDENTITY_KID/)
    expect(() => readLoopitIdentityConfig({ LOOPIT_IDENTITY_KID: 'local-1' })).toThrow(/LOOPIT_IDENTITY_SECRET/)
    expect(() => readLoopitIdentityConfig({ LOOPIT_IDENTITY_SECRET: '   ', LOOPIT_IDENTITY_KID: '  ' })).toThrow(LoopitIdentityConfigError)
  })

  it('canonical JSON matches Python sort_keys compact encoding', () => {
    expect(canonicalJson({ typ: 'LOOPIT-ID', alg: 'HS256', kid: 'k' })).toBe('{"alg":"HS256","kid":"k","typ":"LOOPIT-ID"}')
    expect(canonicalJson({ sub: 'café', scopes: ['api', 'runs'], n: 1 })).toBe('{"n":1,"scopes":["api","runs"],"sub":"caf\\u00e9"}')
  })

  it('uses a 900 second lifetime and the login scopes by default', () => {
    const token = mintLoopitIdentityToken({
      subject: 'user-1', orgId: 'ws-1', role: 'owner', now: 1_700_000_000, config,
    })
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    expect(payload.exp - payload.iat).toBe(LOOPIT_IDENTITY_TTL_SECONDS)
    expect(payload.scopes).toEqual([...LOOPIT_IDENTITY_SCOPES])
    expect(payload.sub).toBe('user-1')
    expect(payload.org).toBe('ws-1')
    expect(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'))).toEqual({
      alg: 'HS256', typ: 'LOOPIT-ID', kid: 'test-kid',
    })
  })

  it('verifies HMAC, expiry, issuer, and audience', () => {
    const token = mintLoopitIdentityToken({
      subject: 'user-1', orgId: 'ws-1', role: 'member', now: 1_700_000_000, config,
    })
    expect(verifyLoopitIdentityToken(token, { now: 1_700_000_000, config })).toMatchObject({
      subject: 'user-1', org: 'ws-1', role: 'member', issuer: config.issuer, audience: config.audience,
    })
    expect(() => verifyLoopitIdentityToken(token, { now: 1_700_000_000 + 900, config })).toThrow(/expired/)
    const [header, payload, signature] = token.split('.')
    expect(() => verifyLoopitIdentityToken(`${header}.${payload}.${signature.slice(0, -2)}aa`, { now: 1_700_000_000, config })).toThrow(/signature/)
    const mint = (overrides: Partial<typeof config>) => mintLoopitIdentityToken({
      subject: 'user-1', orgId: 'ws-1', role: 'member', now: 1_700_000_000, config: { ...config, ...overrides },
    })
    expect(() => verifyLoopitIdentityToken(mint({ audience: 'other-audience' }), { now: 1_700_000_000, config })).toThrow(/audience/)
    expect(() => verifyLoopitIdentityToken(mint({ issuer: 'other-issuer' }), { now: 1_700_000_000, config })).toThrow(/issuer/)
    expect(() => verifyLoopitIdentityToken(mint({ kid: 'other-kid' }), { now: 1_700_000_000, config })).toThrow(/unknown identity key/)
  })
})

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..')
const authSrc = path.join(repoRoot, 'Loop-it', 'packages', 'auth', 'src')

function findPython(): { command: string; prefix: string[] } | null {
  const venv = path.join(repoRoot, 'Loop-it', '.venv', 'Scripts', 'python.exe')
  const candidates: Array<{ command: string; prefix: string[] }> = []
  if (existsSync(venv)) candidates.push({ command: venv, prefix: [] })
  candidates.push({ command: 'python', prefix: [] }, { command: 'python3', prefix: [] }, { command: 'py', prefix: ['-3'] })
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.prefix, '-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    })
    if (probe.status === 0) return candidate
  }
  return null
}

const python = findPython()

const VERIFY_SCRIPT = `
import importlib.util
import json
import sys
import types
from pathlib import Path

# Load verify_identity without loopit_auth/__init__.py, which imports the rest of the stack.
package_dir = Path(sys.argv[1])
package = types.ModuleType("loopit_auth")
package.__path__ = [str(package_dir)]
package.__package__ = "loopit_auth"
sys.modules["loopit_auth"] = package

def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    module.__package__ = "loopit_auth"
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

_load("loopit_auth.models", str(package_dir / "models.py"))
identity = _load("loopit_auth.identity", str(package_dir / "identity.py"))
TokenSigner = identity.TokenSigner
IdentityTokenError = identity.IdentityTokenError

data = json.loads(sys.stdin.buffer.read().decode("utf-8"))
signer = TokenSigner(
    issuer=data["issuer"],
    audience=data["audience"],
    keys={data["kid"]: data["secret"].encode("utf-8")},
    current_kid=data["kid"],
)
minted = signer.mint_identity(
    subject=data["subject"],
    org_id=data["org"],
    role=data["role"],
    scopes=tuple(data["scopes"]),
    ttl_seconds=int(data["ttl"]),
    now=int(data["now"]),
)
out = {"match": minted == data["token"], "minted": minted}
if data.get("expect_verify", True):
    try:
        identity = signer.verify_identity(data["token"], now=int(data["now"]) + 1)
    except IdentityTokenError as exc:
        out["verify_error"] = str(exc)
    else:
        out["verified"] = {
            "subject": identity.subject,
            "org_id": identity.org_id,
            "role": identity.role,
            "scopes": list(identity.scopes),
            "audience": identity.audience,
            "expires_at": identity.expires_at,
            "kid": identity.kid,
            "issuer": identity.issuer,
        }
else:
    try:
        signer.verify_identity(data["token"], now=int(data["now"]) + 1)
        out["verify_error"] = None
    except IdentityTokenError as exc:
        out["verify_error"] = str(exc)
sys.stdout.write(json.dumps(out))
`

function verifyWithPython(body: Record<string, unknown>) {
  if (!python) throw new Error('python is not available')
  const result = spawnSync(python.command, [...python.prefix, '-c', VERIFY_SCRIPT, path.join(authSrc, 'loopit_auth')], {
    input: JSON.stringify(body),
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(`python verify failed (${result.status}): ${result.stderr || result.stdout}`)
  }
  return JSON.parse(result.stdout) as {
    match: boolean
    minted: string
    verify_error?: string
    verified?: { subject: string; org_id: string; role: string; scopes: string[]; kid: string; issuer: string; audience: string; expires_at: number }
  }
}

describe.skipIf(!python)('python verify_identity accepts the TypeScript token', () => {
  it('matches TokenSigner.mint_identity byte for byte, including non-ascii claims', () => {
    const now = 1_700_000_000
    const subject = 'user-café'
    const org = 'ws-1'
    const token = mintLoopitIdentityToken({
      subject, orgId: org, role: 'member', scopes: ['api', 'runs'], now, ttlSeconds: 900, config,
    })
    const out = verifyWithPython({
      token, subject, org, role: 'member', scopes: ['api', 'runs'], ttl: 900, now,
      secret: config.secret, kid: config.kid, issuer: config.issuer, audience: config.audience,
    })
    expect(out.match, out.minted).toBe(true)
    expect(out.verified).toMatchObject({
      subject, org_id: org, role: 'member', scopes: ['api', 'runs'], kid: config.kid, issuer: config.issuer, audience: config.audience,
      expires_at: now + 900,
    })
  })

  it('is rejected by verify_identity when the signature is tampered', () => {
    const token = mintLoopitIdentityToken({
      subject: 'user-1', orgId: 'ws-1', role: 'owner', now: 1_700_000_000, config,
    })
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')
    const out = verifyWithPython({
      token: tampered, subject: 'user-1', org: 'ws-1', role: 'owner', scopes: [...LOOPIT_IDENTITY_SCOPES],
      ttl: 900, now: 1_700_000_000, secret: config.secret, kid: config.kid, issuer: config.issuer, audience: config.audience,
      expect_verify: false,
    })
    expect(out.verify_error).toBeTruthy()
  })
})
