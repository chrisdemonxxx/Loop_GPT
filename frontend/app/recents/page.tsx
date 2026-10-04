'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import axios from 'axios'
import Sidebar from '../components/chat/Sidebar'
import { API_URL, authHeaders } from '../lib/api'
import { useConversationsData, useConversationSearch } from '../chat/hooks'
import type { Conversation } from '../components/chat/types'

/** /recents hosts the same session list. Incognito rows stay out. */
export default function RecentsPage() {
  const router = useRouter()
  const data = useConversationsData(null, () => {})
  const [search, setSearch] = useState('')
  const found = useConversationSearch(search)
  const conversations = data.conversations.filter((c) => (c as Conversation & { incognito?: boolean }).incognito !== true)

  async function onShare(id: string): Promise<string | { error: 'share' | 'copy' } | null> {
    let link = ''
    try {
      const res = await axios.post(`${API_URL}/api/conversations/${id}/share`, {}, { headers: authHeaders() })
      if (!res.data?.url) return { error: 'share' }
      link = `${window.location.origin}${res.data.url}`
    } catch {
      return { error: 'share' }
    }
    try {
      if (!navigator.clipboard?.writeText) return { error: 'copy' }
      await navigator.clipboard.writeText(link)
      return link
    } catch {
      return { error: 'copy' }
    }
  }

  return (
    <div className="min-h-screen bg-[#08080a] text-slate-200">
      <div className="max-w-md mx-auto h-[100dvh]">
        <Sidebar
          conversations={conversations}
          currentConversationId={null}
          user={null}
          projects={[]}
          activeProjectId={null}
          onSelectConversation={(id) => {
            if (id) router.push(`/chat?conversation=${encodeURIComponent(id)}`)
            else router.push('/chat')
          }}
          onClose={() => {}}
          onOpenSettings={() => router.push('/customize')}
          onLogout={() => {}}
          onRenameConversation={async (id, title) => {
            try { await data.updateConv.mutateAsync({ id, title }) } catch { return false }
          }}
          onDeleteConversation={(id) => { data.deleteConv.mutate(id) }}
          onPinConversation={(id, pinned) => { data.updateConv.mutate({ id, pinned }) }}
          onShareConversation={onShare}
          searchQuery={search}
          onSearchChange={setSearch}
          messageHits={found.hits}
          sessionsError={data.sessionsError}
          sessionsPending={data.sessionsPending}
          onRetrySessions={data.retrySessions}
          searchError={found.error}
          onRetrySearch={found.retry}
          onOpenProjects={() => router.push('/projects')}
          onSelectProject={() => {}}
        />
      </div>
    </div>
  )
}
