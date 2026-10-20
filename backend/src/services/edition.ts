/**
 * Deployment edition. One backend, two editions:
 *
 *   adult (default)      — full unrestricted adult edition enabled by default
 *                          (unless LOOP_EDITION=mainstream is explicitly set).
 *   mainstream           — Stripe / app-store safe: standard assistant prompt,
 *                          NSFW moderation on, face-lock requires consent.
 */
export function isAdultEdition(): boolean {
  const raw = (process.env.LOOP_EDITION || 'adult').trim().toLowerCase()
  return raw !== 'mainstream'
}

export function isMainstreamEdition(): boolean {
  return !isAdultEdition()
}
