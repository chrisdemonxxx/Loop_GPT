/**
 * Deployment edition. One backend, two editions:
 *
 *   mainstream (default) — Stripe / app-store safe: standard assistant prompt,
 *                          moderation on, face-lock only with user consent.
 *   adult                — only when LOOP_EDITION=adult is set explicitly:
 *                          unrestricted prompt, face-lock hard-disabled.
 *
 * Unset or unrecognised values resolve to mainstream, so a deployment that
 * forgets the variable fails safe.
 */
export function isAdultEdition(): boolean {
  return process.env.LOOP_EDITION === 'adult'
}

export function isMainstreamEdition(): boolean {
  return !isAdultEdition()
}
