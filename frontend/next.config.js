/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  env: {
    // Empty by default => the client uses same-origin relative URLs and relies
    // on the serving proxy (nginx `/api` upstream). Set an absolute URL only
    // when the API lives on a different origin.
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || '',
  },
}

module.exports = nextConfig

