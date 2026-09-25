/** Shared chat-domain types (message + conversation rows as served by the API). */
export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  messageType?: string
  imageUrl?: string
  attachmentId?: string
  toolUsed?: string
  metadata?: any
}

export interface Conversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}
