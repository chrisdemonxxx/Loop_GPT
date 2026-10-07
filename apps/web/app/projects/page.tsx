'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import ProjectsPanel from '../components/ProjectsPanel'
import { useWorkspaceProjects } from '../chat/hooks'
import { listNamedBots } from '../lib/namedBots'

/** /projects hosts the same projects panel the chat dialog uses. */
export default function ProjectsPage() {
  const router = useRouter()
  const { workspaceId, activeProjectId, setActiveProjectId } = useWorkspaceProjects()
  const [bots, setBots] = useState<Array<{ id: string; name: string }>>([])
  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    listNamedBots()
      .then((roster) => { if (!cancelled) setBots((roster.bots || []).map((bot) => ({ id: bot.id, name: bot.name }))) })
      .catch(() => { if (!cancelled) setBots([]) })
    return () => { cancelled = true }
  }, [workspaceId])
  return (
    <ProjectsPanel
      asPage
      workspaceId={workspaceId}
      activeProjectId={activeProjectId}
      bots={bots}
      onSelect={(id) => {
        setActiveProjectId(id)
        if (typeof window === 'undefined') return
        if (id) localStorage.setItem('activeProjectId', id)
        else localStorage.removeItem('activeProjectId')
      }}
      onClose={() => router.push('/chat')}
      onOpenRoom={(room) => router.push(`/chat?conversation=${room.id}`)}
    />
  )
}
