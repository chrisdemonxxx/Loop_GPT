import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { Providers } from './providers'
import { ErrorBoundary } from './components/ErrorBoundary'
import Analytics from './components/Analytics'
import { THEME_BOOT_SCRIPT } from './lib/theme'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Loop GPT - AI Chat Assistant',
  description: 'A modern ChatGPT-like interface',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: '/icon.svg',
    apple: '/apple-touch-icon.png',
  },
}

// viewport-fit=cover exposes the real iOS safe-area insets (notch/status bar +
// home indicator) so env(safe-area-inset-*) works in the fixed mobile drawers.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0b0b12',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        {/* No-flash theme bootstrap (§8-35): applies the stored choice before
            first paint. Default is dark (no attribute) — zero change for
            existing users until they opt in. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <Analytics />
        <ErrorBoundary>
          <Providers>{children}</Providers>
        </ErrorBoundary>
      </body>
    </html>
  )
}

