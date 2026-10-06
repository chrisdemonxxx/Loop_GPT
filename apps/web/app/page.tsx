'use client'

import ChatPage from './chat/page'

/**
 * The chat workspace IS the home page: visitors land directly in the product
 * with zero marketing detour — unauthenticated users get the login/signup
 * panel docked beside the chat (AuthSidePanel), signed-in users go straight
 * to work. The marketing page lives at /welcome.
 */
export default function HomePage() {
  return <ChatPage />
}