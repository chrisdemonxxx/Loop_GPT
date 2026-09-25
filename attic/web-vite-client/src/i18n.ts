import { ClientError } from './security'

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

const english = {
  language: 'Language and region', skip: 'Skip to main content', foundation: 'Owned web client · Foundation',
  welcome: 'A little space for your next big idea.', intro: 'Sign in to your Loop account to start a hosted conversation.',
  email: 'Email', password: 'Password', login: 'Sign in', logout: 'Sign out', signingIn: 'Signing in…',
  memory: 'Your session stays in this tab’s memory. Reloading or closing the page signs you out.',
  workspace: 'Workspace', refresh: 'Refresh workspaces', loading: 'Loading…', emptyWorkspaces: 'No workspaces yet.',
  personal: 'Create personal workspace', selectWorkspace: 'Select a workspace', owner: 'Owner', editor: 'Editor', viewer: 'Viewer',
  viewerNote: 'This workspace is read-only. An owner or editor role is required to send messages.',
  newChat: 'New conversation', conversation: 'Conversation', emptyChat: 'What would you like to explore?',
  emptyHint: 'Your next message starts a conversation in the selected workspace.',
  message: 'Message', placeholder: 'Ask Loop…', send: 'Send message', stop: 'Stop response',
  mode: 'Conversation mode', chat: 'Chat', agent: 'Agent', research: 'Research',
  chatHint: 'Hosted text conversation. No tools.', agentHint: 'Enables the backend’s reviewed built-in tools. No workspace connectors selected.',
  researchHint: 'Enables the backend’s web search and fetch tools.',
  you: 'You', assistant: 'Loop', working: 'Generating response…', warming: 'Preparing hosted model…',
  tool: 'Using a tool…', complete: 'Response complete.', stopped: 'Response stopped. The server may have saved part of this turn.',
  failed: 'Response interrupted. A partial turn may have been saved. Retry is never automatic.',
  download: 'Download', downloading: 'Downloading…', downloaded: 'Download handed to your browser.',
  offline: 'You are offline. Only the app shell is available; sign-in and conversations need a connection.',
  online: 'Online', ready: 'Ready', unavailable: 'Service unavailable. Check your connection and try again.',
  credentials: 'Sign-in failed. Check your email and password.', expired: 'Your session expired. Please sign in again.',
  forbidden: 'Access denied. Refresh workspaces to check your current permissions.',
  missing: 'This resource is no longer available.', credit: 'The account has insufficient credits for this request.',
  conflict: 'The workspace changed. Refresh workspaces before trying again.', rate: 'Too many requests. Wait before trying again.',
  protocol: 'The server returned an incomplete or unsupported response.', tooLarge: 'The response exceeded this client’s size limit.',
  config: 'Invalid API origin configuration. Check the web client setup.', invalid: 'The server rejected this request.',
  developer: 'Developer usage', loadUsage: 'Load developer overview', balance: 'API balance (USD)',
  requests: 'Requests · last 30 days', spend: 'API spend · last 30 days (USD)', tokens: 'Tokens · last 30 days',
  usageNote: 'Account-wide developer API usage, separate from hosted chat credits.',
  privacy: 'Messages render as plain text. Downloads are never previewed in the app.',
  sessionChat: 'Active conversation only. New conversation and workspace changes clear the view; server records may remain.',
  limit: 'Maximum 100,000 characters.', dismiss: 'Dismiss message',
} as const
export type Copy = { [Key in keyof typeof english]: string }
const french: Copy = {
  language: 'Langue et région', skip: 'Aller au contenu principal', foundation: 'Client Web propriétaire · Fondation',
  welcome: 'Un petit espace pour votre prochaine grande idée.', intro: 'Connectez-vous à votre compte Loop pour démarrer une conversation hébergée.',
  email: 'Courriel', password: 'Mot de passe', login: 'Se connecter', logout: 'Se déconnecter', signingIn: 'Connexion…',
  memory: 'Votre session reste dans la mémoire de cet onglet. Recharger ou fermer la page vous déconnecte.',
  workspace: 'Espace de travail', refresh: 'Actualiser les espaces', loading: 'Chargement…', emptyWorkspaces: 'Aucun espace de travail.',
  personal: 'Créer un espace personnel', selectWorkspace: 'Choisir un espace', owner: 'Propriétaire', editor: 'Éditeur', viewer: 'Lecteur',
  viewerNote: 'Cet espace est en lecture seule. Le rôle de propriétaire ou d’éditeur est requis pour envoyer des messages.',
  newChat: 'Nouvelle conversation', conversation: 'Conversation', emptyChat: 'Que souhaitez-vous explorer?',
  emptyHint: 'Votre prochain message démarrera une conversation dans l’espace sélectionné.',
  message: 'Message', placeholder: 'Demandez à Loop…', send: 'Envoyer le message', stop: 'Arrêter la réponse',
  mode: 'Mode de conversation', chat: 'Clavardage', agent: 'Agent', research: 'Recherche',
  chatHint: 'Conversation textuelle hébergée. Aucun outil.', agentHint: 'Active les outils intégrés examinés du serveur. Aucun connecteur d’espace sélectionné.',
  researchHint: 'Active les outils de recherche et de consultation Web du serveur.',
  you: 'Vous', assistant: 'Loop', working: 'Génération de la réponse…', warming: 'Préparation du modèle hébergé…',
  tool: 'Utilisation d’un outil…', complete: 'Réponse terminée.', stopped: 'Réponse arrêtée. Le serveur pourrait avoir enregistré une partie de cet échange.',
  failed: 'Réponse interrompue. Un échange partiel pourrait avoir été enregistré. Aucune nouvelle tentative automatique.',
  download: 'Télécharger', downloading: 'Téléchargement…', downloaded: 'Téléchargement transmis à votre navigateur.',
  offline: 'Vous êtes hors ligne. Seule l’interface est disponible; la connexion et les conversations nécessitent Internet.',
  online: 'En ligne', ready: 'Prêt', unavailable: 'Service indisponible. Vérifiez votre connexion, puis réessayez.',
  credentials: 'Échec de connexion. Vérifiez votre courriel et votre mot de passe.', expired: 'Votre session a expiré. Veuillez vous reconnecter.',
  forbidden: 'Accès refusé. Actualisez les espaces pour vérifier vos permissions.', missing: 'Cette ressource n’est plus disponible.',
  credit: 'Le compte n’a pas assez de crédits pour cette demande.', conflict: 'L’espace a changé. Actualisez les espaces avant de réessayer.',
  rate: 'Trop de demandes. Veuillez patienter avant de réessayer.', protocol: 'Le serveur a renvoyé une réponse incomplète ou non prise en charge.',
  tooLarge: 'La réponse dépasse la limite de taille de ce client.', config: 'Configuration de l’origine API invalide. Vérifiez la configuration du client Web.',
  invalid: 'Le serveur a refusé cette demande.', developer: 'Utilisation développeur', loadUsage: 'Charger le sommaire développeur',
  balance: 'Solde API (USD)', requests: 'Demandes · 30 derniers jours', spend: 'Dépenses API · 30 derniers jours (USD)', tokens: 'Jetons · 30 derniers jours',
  usageNote: 'Utilisation de l’API développeur pour tout le compte, distincte des crédits de clavardage hébergé.',
  privacy: 'Les messages s’affichent en texte brut. Aucun aperçu des fichiers téléchargés dans l’application.',
  sessionChat: 'Conversation active seulement. Changer de conversation ou d’espace efface l’affichage; les données peuvent rester sur le serveur.',
  limit: 'Maximum de 100 000 caractères.', dismiss: 'Fermer le message',
}

// Shared English wording is intentional; regional Intl formatting uses the exact locale.
export const translations: Record<Locale, Copy> = {
  'en-US': { ...english }, 'en-GB': { ...english }, 'en-CA': { ...english }, 'fr-CA': french,
  'en-AU': { ...english }, 'en-NZ': { ...english }, 'en-IE': { ...english },
}
export type CopyKey = keyof Copy
export function errorKey(error: unknown, login = false): CopyKey {
  if (!(error instanceof ClientError)) return 'unavailable'
  if (error.code === 'config' || error.code === 'protocol' || error.code === 'tooLarge') return error.code
  if (error.status === 401) return login ? 'credentials' : 'expired'
  return ({ 400: 'invalid', 402: 'credit', 403: 'forbidden', 404: 'missing', 409: 'conflict', 429: 'rate' } as Record<number, CopyKey>)[error.status ?? 0] ?? 'unavailable'
}
