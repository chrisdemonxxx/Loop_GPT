/** CORS is browser isolation, not authentication. Non-browser callers still
 * require route-level authentication even though they may omit Origin. */
export function createCorsOriginPolicy(frontendUrls: string): (origin?: string) => boolean {
  const allowed = new Set(frontendUrls.split(',').map((value) => value.trim())
    .filter(Boolean).map((value) => new URL(value).origin))
  return (origin) => origin === undefined || allowed.has(origin)
}
