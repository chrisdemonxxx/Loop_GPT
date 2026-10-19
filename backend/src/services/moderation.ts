/**
 * Content Moderation & CSAM Safety Service (Tier 2-5).
 *
 * Enforces:
 *   1. Absolute limits on BOTH Mainstream and Adult editions:
 *      - CSAM / minor sexual exploitation (`csam`)
 *      - Step-by-step synthesis/acquisition of chemical, biological, radiological, or nuclear weapons (`wmd`)
 *      - Actionable plans for imminent murder, kidnapping, or severe physical harm against a named living person (`imminent_violence`)
 *   2. Mainstream Edition additional rules (`isMainstreamEdition()`):
 *      - Explicit pornographic / erotica / NSFW sexual generation (`nsfw_sexual`)
 *      - Non-consensual intimate imagery (`ncii`)
 *   3. SHA-256 CSAM hash blocklist matching for image/file uploads and outputs.
 */
import crypto from 'crypto'
import { isMainstreamEdition } from './edition'

export type ModerationCategory =
  | 'csam'
  | 'wmd'
  | 'imminent_violence'
  | 'ncii'
  | 'nsfw_sexual'

export interface ModerationVerdict {
  flagged: boolean
  category: ModerationCategory | null
  reason: string | null
  edition: 'mainstream' | 'adult'
}

// Absolute patterns prohibited on BOTH Mainstream and Adult editions.
const CSAM_PATTERNS = [
  /\b(?:csam|child\s+porn(?:ography)?|cp\s+links?|underage\s+(?:sex|nude|naked|erotic|porn)|minor\s+(?:sex|nude|naked|erotic|porn)|preteen\s+(?:sex|nude)|loli(?:con)?\s+(?:sex|nude|nsfw)|shota(?:con)?\s+(?:sex|nude|nsfw))\b/i,
  /\b(?:1[0-7]|[4-9])\s*(?:year|yr|y\/o)[\s-]*old\s+(?:nude|naked|sex|explicit|erotic|porn)\b/i,
]

const WMD_PATTERNS = [
  /\b(?:step[\s-]*by[\s-]*step|synthesize|manufacture|home[\s-]*brew|recipe\s+for)\b[^.!?\n]{0,80}\b(?:sarin|vx\s+nerve|novichok|ricin\s+toxin|weaponized\s+anthrax|smallpox\s+culture|mustard\s+gas|improvised\s+nuclear)\b/i,
]

const IMMINENT_VIOLENCE_PATTERNS = [
  /\b(?:how\s+to\s+assassinate|hire\s+a\s+hitman\s+for|plan\s+to\s+kidnap\s+and\s+kill|bomb\s+making\s+instructions\s+to\s+attack)\b/i,
]

const NCII_PATTERNS = [
  /\b(?:revenge\s+porn|non[\s-]*consensual\s+(?:nude|intimate|deepfake|undress)|deepfake\s+porn\s+of|undress\s+this\s+(?:photo|person|girl|woman|coworker|classmate)\s+without\s+consent)\b/i,
]

// Mainstream-only NSFW sexual patterns (permitted on Adult Edition when consensual & adult).
const MAINSTREAM_NSFW_PATTERNS = [
  /\b(?:hardcore\s+porn(?:ography)?|explicit\s+erotica|nsfw\s+explicit\s+sex|write\s+pornographic|generate\s+pornographic|nude\s+porn\s+scene|uncensored\s+hentai\s+sex)\b/i,
]

/**
 * Evaluate text (prompt or completion) against edition-aware safety rules.
 */
export function moderateText(text: string): ModerationVerdict {
  const edition = isMainstreamEdition() ? 'mainstream' : 'adult'
  const normalized = String(text || '').trim()
  if (!normalized) {
    return { flagged: false, category: null, reason: null, edition }
  }

  for (const re of CSAM_PATTERNS) {
    if (re.test(normalized)) {
      return {
        flagged: true,
        category: 'csam',
        reason: 'Content involving minors in sexual or suggestive contexts is strictly prohibited.',
        edition,
      }
    }
  }

  for (const re of WMD_PATTERNS) {
    if (re.test(normalized)) {
      return {
        flagged: true,
        category: 'wmd',
        reason: 'Actionable synthesis or acquisition instructions for chemical, biological, radiological, or nuclear weapons are prohibited.',
        edition,
      }
    }
  }

  for (const re of IMMINENT_VIOLENCE_PATTERNS) {
    if (re.test(normalized)) {
      return {
        flagged: true,
        category: 'imminent_violence',
        reason: 'Actionable plans for imminent severe harm or assassination are prohibited.',
        edition,
      }
    }
  }

  for (const re of NCII_PATTERNS) {
    if (re.test(normalized)) {
      return {
        flagged: true,
        category: 'ncii',
        reason: 'Non-consensual intimate imagery (NCII) is strictly prohibited.',
        edition,
      }
    }
  }

  if (edition === 'mainstream') {
    for (const re of MAINSTREAM_NSFW_PATTERNS) {
      if (re.test(normalized)) {
        return {
          flagged: true,
          category: 'nsfw_sexual',
          reason: 'Explicit pornographic or NSFW sexual content is not available on the Mainstream Edition.',
          edition,
        }
      }
    }
  }

  return { flagged: false, category: null, reason: null, edition }
}

/**
 * Check a file/image buffer or SHA-256 hex digest against the configured CSAM hash blocklist.
 * `LOOP_CSAM_HASH_BLOCKLIST` can be configured as a comma-separated list of lower-case SHA-256 digests.
 */
export function checkCsamFileHash(input: Buffer | string): { matched: boolean; sha256: string } {
  const sha256 = Buffer.isBuffer(input)
    ? crypto.createHash('sha256').update(input).digest('hex').toLowerCase()
    : String(input).trim().toLowerCase()

  const rawList = process.env.LOOP_CSAM_HASH_BLOCKLIST || ''
  const blockSet = new Set(
    rawList
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length === 64),
  )

  return {
    matched: blockSet.has(sha256),
    sha256,
  }
}
