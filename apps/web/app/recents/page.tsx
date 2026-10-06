"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import axios from "axios"
import Sidebar from "../components/chat/Sidebar"
import { API_URL, authHeaders, getStoredUser } from "../lib/api"
import { useConversationsData, useConversationSearch, usePanels, useWorkspaceProjects } from "../chat/hooks"
import type { Conversation } from "../components/chat/types"

/** /recents hosts the same session list. Incognito rows stay out. */
export default function RecentsPage() {
  const router = useRouter()
  const panels = usePanels()
  const data = useConversationsData(null, () => {})
  const { projects, activeProjectId, setActiveProjectId } = useWorkspaceProjects()
  const [search, setSearch] = useState("")
  const found = useConversationSearch(search)
  const conversations = data.conversations.filter((c) => (c as Conversation & { incognito?: boolean }).incognito !== true)
  const user = getStoredUser()

  async function onShare(id: string): Promise<string | { error: "share" | "copy" } | null> {
    let link = ""
    try {
      const res = await axios.post(`${API_URL}/api/conversations/${id}/share`, {}, { headers: authHeaders() })
      if (!res.data?.url) return { error: "share" }
      link = `${window.location.origin}${res.data.url}`
    } catch {
      return { error: "share" }
    }
    try {
      if (!navigator.clipboard?.writeText) return { error: "copy" }
      await navigator.clipboard.writeText(link)
      return link
    } catch {
      return { error: "copy" }
    }
  }

  const logout = () => {
    localStorage.removeItem("token"); localStorage.removeItem("user")
    window.location.href = "/login"
  }

  if (!panels.sidebarOpen) {
    return (
      <div className="min-h-screen bg-[#08080a] text-slate-200">
        <button type="button" className="m-4 text-sm text-slate-300" onClick={() => panels.setSidebarOpen(true)}>Show sidebar</button>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#08080a] text-slate-200">
      <div className="max-w-md mx-auto h-[100dvh]">
        <Sidebar
          conversations={conversations}
          currentConversationId={null}
          user={user}
          projects={projects}
          activeProjectId={activeProjectId}
          onSelectConversation={(id) => {
            if (id) router.push(`/chat?conversation=${encodeURIComponent(id)}`)
            else router.push("/chat")
          }}
          onClose={() => panels.setSidebarOpen(false)}
          onOpenSettings={() => router.push("/customize")}
          onLogout={logout}
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
          onOpenProjects={() => router.push("/projects")}
          onSelectProject={(id) => {
            setActiveProjectId(id)
            if (id) localStorage.setItem("activeProjectId", id)
            else localStorage.removeItem("activeProjectId")
          }}
          activeProjectName={activeProjectId ? (projects.find((p) => p.id === activeProjectId)?.name || undefined) : undefined}
        />
      </div>
    </div>
  )
}
