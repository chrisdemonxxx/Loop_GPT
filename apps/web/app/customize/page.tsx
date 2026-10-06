'use client'

import { useRouter } from 'next/navigation'
import SettingsPanel from '../components/SettingsPanel'
import { useWorkspaceProjects } from '../chat/hooks'

/** /customize hosts the same settings tabs as a page, not a second modal. */
export default function CustomizePage() {
  const router = useRouter()
  const { workspaceId } = useWorkspaceProjects()
  return (
    <SettingsPanel
      asPage
      workspaceId={workspaceId}
      onClose={() => router.push('/chat')}
    />
  )
}
