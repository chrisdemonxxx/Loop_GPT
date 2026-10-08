/** @type {import('next').NextConfig} */
function loopitEnabledFlag() {
  const raw = String(process.env.LOOPIT_ENABLED || process.env.NEXT_PUBLIC_LOOPIT_ENABLED || '')
    .trim()
    .toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' ? '1' : ''
}

const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  // Workspace packages ship raw TS/TSX sources; Next compiles them so the
  // NEXT_PUBLIC_* defines and 'use client' boundaries apply inside them.
  transpilePackages: ['@loop/shared', '@loop/api-client', '@loop/ui', '@loop/loopit-contracts', '@loop/loopit-client'],
  trailingSlash: true,
  images: { unoptimized: true },
  env: {
    // Empty by default => the client uses same-origin relative URLs and relies
    // on the serving proxy (nginx `/api` upstream). Set an absolute URL only
    // when the API lives on a different origin.
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || '',
    // Optional separate origin for Canvas HTML previews. Empty keeps srcdoc
    // inside a sandboxed iframe (opaque origin, scripts allowed, no parent access).
    NEXT_PUBLIC_ARTIFACT_ORIGIN: process.env.NEXT_PUBLIC_ARTIFACT_ORIGIN || '',
    // LOOPIT_ENABLED is read at build time (static export). '1' shows Build.
    NEXT_PUBLIC_LOOPIT_ENABLED: loopitEnabledFlag(),
  },
}

module.exports = nextConfig

