'use client'

import { useRouter } from 'next/navigation'
import ProjectsPanel from '../components/ProjectsPanel'
import { useWorkspaceProjects } from '../chat/hooks'

/** /projects hosts the same projects panel the chat dialog uses. */
export default function ProjectsPage() {
  const router = useRouter()
  const { workspaceId, activeProjectId, setActiveProjectId } = useWorkspaceProjects()
  return (
    <ProjectsPanel
      asPage
      workspaceId={workspaceId}
      activeProjectId={activeProjectId}
      onSelect={(id) => {
        setActiveProjectId(id)
        if (typeof window === 'undefined') return
        if (id) localStorage.setItem('activeProjectId', id)
        else localStorage.removeItem('activeProjectId')
      }}
      onClose={() => router.push('/chat')}
    />
  )
}
