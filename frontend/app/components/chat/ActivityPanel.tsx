'use client'

import { motion } from 'framer-motion'
import AgentComputer, { type LiveStep } from '../AgentComputer'
import { type ArtifactRef } from '../../lib/stream'

interface ActivityPanelProps {
  running: boolean
  status: string
  steps: LiveStep[]
  artifacts: ArtifactRef[]
  toolCount: number
  onClose: () => void
}

export default function ActivityPanel({ running, status, steps, artifacts, toolCount, onClose }: ActivityPanelProps) {
  return (
    <motion.aside
      initial={{ x: 400, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 400, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 320, damping: 34 }}
      className="fixed lg:relative inset-y-0 right-0 z-40 lg:z-auto flex w-full max-w-[92vw] sm:max-w-[440px] lg:w-[380px] lg:max-w-none shrink-0 px-2.5 sm:px-3 lg:p-3 h-full pt-[max(0.625rem,env(safe-area-inset-top))] pb-[max(0.625rem,env(safe-area-inset-bottom))] lg:pt-3 lg:pb-3"
    >
      <AgentComputer
        running={running}
        status={status}
        steps={steps}
        artifacts={artifacts}
        toolCount={toolCount}
        onClose={onClose}
      />
    </motion.aside>
  )
}
