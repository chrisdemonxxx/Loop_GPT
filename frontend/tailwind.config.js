/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1400px',
      },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        // Anthropic Claude brand colors
        claude: {
          purple: '#6E3AFF',
          'purple-dark': '#5d2fe6',
          'purple-light': '#8B5FFF',
        },
        // Futuristic "Loop" workspace palette (dark-first)
        ink: {
          950: '#07070c',
          900: '#0b0b12',
          850: '#0f0f18',
          800: '#14141f',
          700: '#1c1c2b',
          600: '#262637',
        },
        // Calm, Claude-aligned accents (was neon). Terracotta primary + soft neutrals.
        neon: {
          violet: '#c96442',
          indigo: '#b5593a',
          cyan: '#d8a08a',
          fuchsia: '#c96442',
          green: '#6ee7a0',
          amber: '#e0a458',
        },
      },
      boxShadow: {
        // Soft neutral elevation instead of colored glow.
        glow: '0 0 0 1px rgba(255,255,255,0.06), 0 10px 30px -12px rgba(0,0,0,0.6)',
        'glow-cyan': '0 0 0 1px rgba(255,255,255,0.06), 0 10px 30px -12px rgba(0,0,0,0.6)',
        panel: '0 8px 40px -12px rgba(0,0,0,0.7)',
      },
      keyframes: {
        blink: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0' } },
        fadeUp: { '0%': { opacity: '0', transform: 'translateY(8px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        shimmer: { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
        pulseGlow: { '0%,100%': { opacity: '0.6' }, '50%': { opacity: '1' } },
        gradientShift: { '0%,100%': { backgroundPosition: '0% 50%' }, '50%': { backgroundPosition: '100% 50%' } },
      },
      animation: {
        blink: 'blink 1s step-end infinite',
        fadeUp: 'fadeUp 0.35s ease-out',
        shimmer: 'shimmer 2s linear infinite',
        pulseGlow: 'pulseGlow 2s ease-in-out infinite',
        gradientShift: 'gradientShift 8s ease infinite',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}

