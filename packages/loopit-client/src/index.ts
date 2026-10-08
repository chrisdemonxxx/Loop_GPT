'use client'

import { createLoopitClient } from './api'

export { ApiError, isServiceMissing, isUnreachable, toUserFacingError } from './errors'
export type { ErrorKind, UserFacingError } from './errors'

export {
  LOOPIT_API_BASE,
  LOOPIT_TOKEN_PATH,
  TOKEN_REFRESH_SKEW_MS,
  createTokenStore,
  parseExpiresAt,
  tokenNeedsRefresh,
} from './token'
export type { MintedToken, TokenStore, TokenStoreOptions } from './token'

export { createLoopitClient, resolvePreviewUrl } from './api'
export type {
  ApprovalGate,
  AuditStreamEvent,
  CheckpointView,
  CostStreamEvent,
  DagStreamEvent,
  ErrorStreamEvent,
  GateStreamEvent,
  Health,
  LoopitClient,
  LoopitClientOptions,
  NodeStatus,
  RunCost,
  RunDetail,
  RunStatus,
  RunStreamEvent,
  RunSummary,
  StreamEvent,
  TaskDagView,
  TaskNodeView,
} from './api'

export { toActivity, truncate } from './activity'
export type { Activity } from './activity'

export {
  emptyRunUiState,
  extractCost,
  extractDag,
  extractGates,
  formatTokens,
  isCompletedNode,
  orderedDagNodes,
  pickPreviewFile,
  reduceRunEvent,
} from './runState'
export type { RunUiState } from './runState'

const client = createLoopitClient()

export const getLoopitToken = client.getToken
export const clearLoopitToken = client.clearToken
export const getHealth = client.getHealth
export const listRuns = client.listRuns
export const getRun = client.getRun
export const startRun = client.startRun
export const deployProject = client.deployProject
export const approveGate = client.approveGate
export const rejectGate = client.rejectGate
export const rollbackCheckpoint = client.rollbackCheckpoint
export const forkCheckpoint = client.forkCheckpoint
export const createPreviewUrl = client.createPreviewUrl
export const getFile = client.getFile
export const streamRunEvents = client.streamRunEvents
