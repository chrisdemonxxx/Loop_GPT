const BLOCKED = /^(chrome|about|edge|brave|opera|vivaldi|chrome-extension|moz-extension|extension|view-source|devtools):/i

export function blockedReason(url, appOrigins) {
  let parsed
  try { parsed = new URL(url) } catch { return 'That address is not a page Loop can open.' }
  if (BLOCKED.test(parsed.protocol)) return 'Loop will not open browser-internal pages.'
  for (const origin of appOrigins || []) {
    if (origin && parsed.origin === origin) return 'Loop will not open its own sign-in storage.'
  }
  return null
}

export function isOnion(url) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'onion' || host.endsWith('.onion')
  } catch {
    return /\.onion\b/i.test(String(url || ''))
  }
}

/** Runs inside the page. Detects a login or captcha and extracts public sitekey metadata when a captcha widget is present. */
export function readPageSignals() {
  const visible = (el) => {
    if (!el || !el.getClientRects) return false
    const rects = el.getClientRects()
    return rects.length > 0 && rects[0].width > 0 && rects[0].height > 0
  }
  const password = [...document.querySelectorAll('input[type="password"]')].some(visible)
  const captchaEl = document.querySelector(
    'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha',
  )
  const captcha = !!captchaEl
  let captchaInfo = null
  if (captcha) {
    const hcapEl = document.querySelector('.h-captcha[data-sitekey]')
    const hcapFrame = document.querySelector('iframe[src*="hcaptcha"]')
    const recapEl = document.querySelector('.g-recaptcha[data-sitekey]')
    const recapFrame = document.querySelector('iframe[src*="recaptcha"]')
    const extractParam = (src, key) => {
      try {
        return new URL(src, location.href).searchParams.get(key) || ''
      } catch {
        return ''
      }
    }
    if (hcapEl || hcapFrame) {
      const sitekey =
        (hcapEl && hcapEl.getAttribute('data-sitekey')) ||
        (hcapFrame && (extractParam(hcapFrame.getAttribute('src') || '', 'sitekey') || extractParam(hcapFrame.getAttribute('src') || '', 'k'))) ||
        ''
      if (sitekey) {
        captchaInfo = { type: 'hcaptcha', sitekey, pageUrl: location.href }
      }
    } else if (recapEl || recapFrame) {
      const src = (recapFrame && recapFrame.getAttribute('src')) || ''
      const sitekey = (recapEl && recapEl.getAttribute('data-sitekey')) || extractParam(src, 'k') || ''
      const invisible =
        (recapEl && recapEl.getAttribute('data-size') === 'invisible') ||
        extractParam(src, 'size') === 'invisible'
      const dataS = (recapEl && recapEl.getAttribute('data-s')) || undefined
      if (sitekey) {
        captchaInfo = {
          type: invisible ? 'recaptcha_v2_invisible' : 'recaptcha_v2',
          sitekey,
          pageUrl: location.href,
          ...(dataS ? { dataS } : {}),
        }
      }
    }
  }
  const text = (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 6000)
  const nodes = [...document.querySelectorAll('a, button, input, textarea, select, [role="button"], h1, h2, h3')]
    .slice(0, 40)
    .map((el) => {
      const label = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 80)
      const tag = el.tagName.toLowerCase()
      return label ? `${tag}: ${label}` : tag
    })
  return {
    password,
    captcha,
    ...(captchaInfo ? { captchaInfo } : {}),
    title: document.title,
    url: location.href,
    text,
    snapshot: nodes.join('\n'),
  }
}

const RISKY_INTENTS = new Set(['submit', 'purchase', 'send', 'credential'])
const SENSITIVE_AUTOCOMPLETE = /\b(cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year|cc-name|new-password|current-password|one-time-code)\b/i
const SENSITIVE_LABEL = /\b(pay|purchase|buy|checkout|place order|send|post|publish|password|change password|delete account|delete|remove|transfer)\b/i

export function isRiskyIntent(intent) {
  return RISKY_INTENTS.has(String(intent || '').trim().toLowerCase())
}

export function looksSensitive(label, intent, meta) {
  if (isRiskyIntent(intent)) return true
  if (meta && typeof meta === 'object') {
    if (meta.sensitiveAutocomplete || SENSITIVE_AUTOCOMPLETE.test(String(meta.autocomplete || ''))) return true
  }
  return SENSITIVE_LABEL.test(String(label || ''))
}
