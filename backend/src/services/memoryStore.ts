/**
 * In-memory store for development when database is not available
 */

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: Date
  messageType?: string
  imageUrl?: string
  imagePath?: string
  toolUsed?: string
  metadata?: any
  conversationId: string
  authorBotId?: string
}

interface Conversation {
  id: string
  title: string
  userId: string
  createdAt: Date
  updatedAt: Date
}

class MemoryStore {
  private conversations: Map<string, Conversation> = new Map()
  private messages: Map<string, Message[]> = new Map()
  private users: Set<string> = new Set()

  ensureUser(userId: string) {
    this.users.add(userId)
  }

  createConversation(userId: string, title: string): Conversation {
    const id = `conv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const conversation: Conversation = {
      id,
      title,
      userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    this.conversations.set(id, conversation)
    this.messages.set(id, [])
    return conversation
  }

  getConversation(id: string): Conversation | undefined {
    return this.conversations.get(id)
  }

  getConversations(userId: string): Conversation[] {
    return Array.from(this.conversations.values())
      .filter(c => c.userId === userId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  }

  updateConversation(id: string, updates: Partial<Conversation>) {
    const conv = this.conversations.get(id)
    if (conv) {
      Object.assign(conv, updates, { updatedAt: new Date() })
    }
  }

  deleteConversation(id: string) {
    this.conversations.delete(id)
    this.messages.delete(id)
  }

  addMessage(conversationId: string, message: Omit<Message, 'id' | 'createdAt'>): Message {
    const id = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const fullMessage: Message = {
      ...message,
      id,
      createdAt: new Date(),
    }
    
    const messages = this.messages.get(conversationId) || []
    messages.push(fullMessage)
    this.messages.set(conversationId, messages)
    
    // Update conversation timestamp
    const conv = this.conversations.get(conversationId)
    if (conv) {
      conv.updatedAt = new Date()
    }
    
    return fullMessage
  }

  getMessages(conversationId: string): Message[] {
    return this.messages.get(conversationId) || []
  }
}

export const memoryStore = new MemoryStore()

