'use client'

import { createContext, useContext, useEffect, useState } from 'react'

/** Ported from the owned web foundation's i18n system: same 7 supported
 * markets, en variants share wording intentionally (regional Intl formatting
 * uses the exact locale), fr-CA is fully translated. The locale is a
 * non-sensitive preference persisted in localStorage. */
export const locales = ['en-US', 'en-GB', 'en-CA', 'fr-CA', 'en-AU', 'en-NZ', 'en-IE'] as const
export type Locale = typeof locales[number]
export const localeNames: Record<Locale, string> = {
  'en-US': 'English · United States', 'en-GB': 'English · United Kingdom',
  'en-CA': 'English · Canada', 'fr-CA': 'Français · Canada',
  'en-AU': 'English · Australia', 'en-NZ': 'English · New Zealand', 'en-IE': 'English · Ireland',
}

export function selectLocale(saved: unknown, languages: readonly string[]): Locale {
  const exact = (value: unknown) => typeof value === 'string'
    ? locales.find((locale) => locale.toLowerCase() === value.toLowerCase()) : undefined
  const stored = exact(saved)
  if (stored) return stored
  for (const language of languages) {
    const supported = exact(language)
    if (supported) return supported
    if (/^fr(?:-|$)/i.test(language)) return 'fr-CA'
    if (/^en(?:-|$)/i.test(language)) return 'en-US'
  }
  return 'en-US'
}

export const copy = {
  language: 'Language and region', newSession: 'New session', searchChats: 'Search chats…',
  noSessions: 'No sessions yet', anonymous: 'Anonymous', signOut: 'Sign out',
  emptyTitle: 'How can I help you today?',
  emptyHint: 'Ask anything. Type {slash} for commands like deep research.',
  placeholder: 'Message Loop GPT…   ( / for commands )',
  disclaimer: 'Loop GPT can make mistakes. Verify important info.',
  commands: 'Commands', research: 'Deep Research', chat: 'Quick Chat',
  researchHint: 'Search the web and synthesise a cited answer', chatHint: 'Fast reply, no tools',
  auto: 'Auto', plan: 'Plan', accept: 'Accept edits',
  autoHint: 'Agent decides and uses tools', planHint: 'Outline a plan before acting',
  acceptHint: 'Run all steps without pausing', send: 'Send', stop: 'Stop',
  uploadFile: 'Add files or photos', addFiles: 'Add files or photos', takeScreenshot: 'Take a screenshot',
  connectors: 'Connectors', copyAction: 'Copy', editAction: 'Edit', retryAction: 'Retry',
  copied: 'Copied', sources: 'Sources', working: 'working', viewActivity: 'view activity',
  loadingPreview: 'Loading preview…', offline: 'You are offline. Sign-in and conversations need a connection.',
} as const
export type CopyKey = keyof typeof copy
type Dict = Record<CopyKey, string>

const french: Dict = {
  language: 'Langue et région', newSession: 'Nouvelle session', searchChats: 'Rechercher…',
  noSessions: 'Aucune session', anonymous: 'Anonyme', signOut: 'Se déconnecter',
  emptyTitle: 'Comment puis-je vous aider aujourd’hui?',
  emptyHint: 'Posez une question. Tapez {slash} pour les commandes comme la recherche approfondie.',
  placeholder: 'Écrivez à Loop GPT…   ( / pour les commandes )',
  disclaimer: 'Loop GPT peut faire des erreurs. Vérifiez les informations importantes.',
  commands: 'Commandes', research: 'Recherche approfondie', chat: 'Clavardage rapide',
  researchHint: 'Rechercher sur le Web et synthétiser une réponse citée', chatHint: 'Réponse rapide, sans outils',
  auto: 'Auto', plan: 'Plan', accept: 'Accepter les modifications',
  autoHint: 'L’agent décide et utilise les outils', planHint: 'Présenter un plan avant d’agir',
  acceptHint: 'Exécuter toutes les étapes sans pause', send: 'Envoyer', stop: 'Arrêter',
  uploadFile: 'Ajouter des fichiers ou des photos', addFiles: 'Ajouter des fichiers ou des photos', takeScreenshot: 'Prendre une capture d’écran',
  connectors: 'Connecteurs', copyAction: 'Copier', editAction: 'Modifier', retryAction: 'Réessayer',
  copied: 'Copié', sources: 'Sources', working: 'en cours', viewActivity: 'voir l’activité',
  loadingPreview: 'Chargement de l’aperçu…', offline: 'Vous êtes hors ligne. La connexion et les conversations nécessitent Internet.',
}
const english: Dict = { ...copy }
export const translations: Record<Locale, Dict> = {
  'en-US': english, 'en-GB': english, 'en-CA': english, 'fr-CA': french,
  'en-AU': english, 'en-NZ': english, 'en-IE': english,
}

export function translate(locale: Locale, key: CopyKey): string {
  return translations[locale]?.[key] ?? english[key] ?? key
}

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: CopyKey) => string
}
const I18nContext = createContext<I18nContextValue>({
  locale: 'en-US', setLocale: () => {}, t: (key) => translate('en-US', key),
})

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en-US')
  useEffect(() => {
    setLocaleState(selectLocale(localStorage.getItem('locale'), navigator.languages || [navigator.language]))
  }, [])
  const setLocale = (next: Locale) => {
    setLocaleState(next)
    try { localStorage.setItem('locale', next) } catch { /* ignore */ }
  }
  const t = (key: CopyKey) => translate(locale, key)
  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>
}

export function useI18n() {
  return useContext(I18nContext)
}
