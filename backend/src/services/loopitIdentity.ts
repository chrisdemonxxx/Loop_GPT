/**
 * Mint Loop-IT gateway identity tokens (typ LOOPIT-ID).
 *
 * The bytes must match packages/auth TokenSigner.mint_identity:
 * HS256 over base64url(canonical header) + "." + base64url(canonical payload),
 * where canonical JSON is Python json.dumps(..., sort_keys=True, separators=(",", ":"))
 * (ensure_ascii, no padding on the base64url segments). Downstream
 * verify_identity accepts role owner|admin|member|viewer only.
 */
import { createHmac, timingSafeEqual } from 'crypto'

export const LOOPIT_IDENTITY_TTL_SECONDS = 900
/** Same scopes AuthService.login puts on a customer token. */
export const LOOPIT_IDENTITY_SCOPES = ['api', 'runs'] as const

export type WorkspaceMemberRole = 'owner' | 'editor' | 'viewer'
export type LoopitRole = 'owner' | 'admin' | 'member' | 'viewer'

export class LoopitIdentityConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoopitIdentityConfigError'
  }
}

export interface LoopitIdentityConfig {
  secret: string
  kid: string
  issuer: string
  audience: string
}

export interface MintLoopitIdentityInput {
  subject: string
  orgId: string
  role: LoopitRole
  scopes?: readonly string[]
  ttlSeconds?: number
  /** Unix seconds. Defaults to the current time. */
  now?: number
  config?: LoopitIdentityConfig
}

/**
 * Loop-GPT editor can change workspace content and cannot manage membership.
 * Loop-IT member can write projects and start runs, and cannot manage the team.
 * owner and viewer pass through. editor is not a token role verify_identity accepts.
 */
export function loopitRoleForWorkspace(role: WorkspaceMemberRole): LoopitRole {
  switch (role) {
    case 'owner': return 'owner'
    case 'editor': return 'member'
    case 'viewer': return 'viewer'
    default: {
      const unexpected: never = role
      throw new LoopitIdentityConfigError(`Unsupported workspace role: ${String(unexpected)}`)
    }
  }
}

/** Fail closed. Called when a token is requested, not at process start. */
export function readLoopitIdentityConfig(env: NodeJS.ProcessEnv = process.env): LoopitIdentityConfig {
  const secret = env.LOOPIT_IDENTITY_SECRET?.trim() ?? ''
  const kid = env.LOOPIT_IDENTITY_KID?.trim() ?? ''
  if (!secret || !kid) {
    throw new LoopitIdentityConfigError('LOOPIT_IDENTITY_SECRET and LOOPIT_IDENTITY_KID must be set')
  }
  return {
    secret,
    kid,
    issuer: env.LOOPIT_IDENTITY_ISSUER ?? 'loopit-gateway',
    audience: env.LOOPIT_IDENTITY_AUDIENCE ?? 'loopit-control-plane',
  }
}

export function mintLoopitIdentityToken(input: MintLoopitIdentityInput): string {
  const config = input.config ?? readLoopitIdentityConfig()
  const subject = input.subject
  const orgId = input.orgId
  if (!subject || !orgId) throw new LoopitIdentityConfigError('Identity subject and org are required')
  if (input.role !== 'owner' && input.role !== 'admin' && input.role !== 'member' && input.role !== 'viewer') {
    throw new LoopitIdentityConfigError('Unsupported identity role')
  }
  const ttl = input.ttlSeconds ?? LOOPIT_IDENTITY_TTL_SECONDS
  if (!Number.isInteger(ttl) || ttl <= 0) throw new LoopitIdentityConfigError('Identity lifetime must be a positive integer')
  const issued = input.now ?? Math.floor(Date.now() / 1000)
  if (!Number.isInteger(issued)) throw new LoopitIdentityConfigError('Identity issued-at must be an integer')
  const scopes = [...(input.scopes ?? LOOPIT_IDENTITY_SCOPES)]
  if (scopes.some((scope) => typeof scope !== 'string')) throw new LoopitIdentityConfigError('Identity scopes must be strings')

  const header = { alg: 'HS256', typ: 'LOOPIT-ID', kid: config.kid }
  const payload = {
    iss: config.issuer,
    aud: config.audience,
    sub: subject,
    org: orgId,
    role: input.role,
    scopes,
    iat: issued,
    exp: issued + ttl,
  }
  const signingInput = b64url(canonicalJson(header)) + '.' + b64url(canonicalJson(payload))
  const signature = createHmac('sha256', Buffer.from(config.secret, 'utf8')).update(signingInput, 'ascii').digest()
  return signingInput + '.' + b64url(signature)
}

/** Python json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True). */
export function canonicalJson(value: unknown): string {
  return encodeCanonical(value)
}

function encodeCanonical(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new LoopitIdentityConfigError('Identity JSON numbers must be integers')
    return String(value)
  }
  if (typeof value === 'string') return encodeString(value)
  if (Array.isArray(value)) return '[' + value.map((item) => encodeCanonical(item)).join(',') + ']'
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return '{' + keys.map((key) => encodeString(key) + ':' + encodeCanonical(record[key])).join(',') + '}'
  }
  throw new LoopitIdentityConfigError('Unsupported identity JSON value')
}

function encodeString(value: string): string {
  let out = '"'
  for (const char of value) {
    const code = char.codePointAt(0) as number
    if (char === '"') out += '\\"'
    else if (char === '\\') out += '\\\\'
    else if (char === '\b') out += '\\b'
    else if (char === '\f') out += '\\f'
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (char === '\t') out += '\\t'
    else if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0')
    else if (code > 0xffff) {
      const shifted = code - 0x10000
      const high = 0xd800 + (shifted >> 10)
      const low = 0xdc00 + (shifted & 0x3ff)
      out += '\\u' + high.toString(16).padStart(4, '0') + '\\u' + low.toString(16).padStart(4, '0')
    } else if (code > 0x7f) out += '\\u' + code.toString(16).padStart(4, '0')
    else out += char
  }
  return out + '"'
}

function b64url(data: string | Buffer): string {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  return bytes.toString('base64url')
}

export class LoopitIdentityTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoopitIdentityTokenError'
  }
}

export interface VerifiedLoopitIdentity {
  subject: string
  org: string
  role: LoopitRole
  scopes: string[]
  issuer: string
  audience: string
  expiresAt: number
  kid: string
}

const LOOPIT_ROLES = new Set<LoopitRole>(['owner', 'admin', 'member', 'viewer'])

/**
 * Verify a LOOPIT-ID token the same way Loop-IT verify_identity does:
 * HS256 over the raw signing input, then iss, aud, and exp.
 * The caller must scope every read and charge to `org` and ignore any
 * workspace id in the request.
 */
export function verifyLoopitIdentityToken(
  token: string,
  options: { now?: number; config?: LoopitIdentityConfig } = {},
): VerifiedLoopitIdentity {
  const config = options.config ?? readLoopitIdentityConfig()
  const parts = typeof token === 'string' ? token.split('.') : []
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new LoopitIdentityTokenError('malformed identity token')
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts
  let header: unknown
  let payload: unknown
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'))
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
  } catch {
    throw new LoopitIdentityTokenError('malformed identity token')
  }
  if (!isRecord(header) || header.alg !== 'HS256' || header.typ !== 'LOOPIT-ID') {
    throw new LoopitIdentityTokenError('unsupported identity token')
  }
  const kid = typeof header.kid === 'string' ? header.kid : ''
  if (kid !== config.kid) throw new LoopitIdentityTokenError('unknown identity key')

  const expected = createHmac('sha256', Buffer.from(config.secret, 'utf8'))
    .update(encodedHeader + '.' + encodedPayload, 'ascii')
    .digest()
  const actual = Buffer.from(encodedSignature, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new LoopitIdentityTokenError('bad identity signature')
  }
  if (!isRecord(payload)) throw new LoopitIdentityTokenError('bad identity claims')
  if (payload.iss !== config.issuer) throw new LoopitIdentityTokenError('bad identity issuer')
  if (payload.aud !== config.audience) throw new LoopitIdentityTokenError('bad identity audience')

  const now = options.now ?? Math.floor(Date.now() / 1000)
  if (typeof payload.exp !== 'number' || !Number.isInteger(payload.exp) || payload.exp <= now) {
    throw new LoopitIdentityTokenError('identity token expired')
  }
  if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.org !== 'string' || !payload.org) {
    throw new LoopitIdentityTokenError('bad identity claims')
  }
  if (typeof payload.role !== 'string' || !LOOPIT_ROLES.has(payload.role as LoopitRole)) {
    throw new LoopitIdentityTokenError('bad identity role')
  }
  if (!Array.isArray(payload.scopes) || payload.scopes.some((scope) => typeof scope !== 'string')) {
    throw new LoopitIdentityTokenError('bad identity scopes')
  }
  return {
    subject: payload.sub,
    org: payload.org,
    role: payload.role as LoopitRole,
    scopes: payload.scopes as string[],
    issuer: config.issuer,
    audience: config.audience,
    expiresAt: payload.exp,
    kid,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
