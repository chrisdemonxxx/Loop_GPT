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
} from './authToken'
export type { MintedToken, TokenStore, TokenStoreOptions } from './authToken'

export {
  TERMINAL_SCOPE,
  PREVIEW_TTL_SECONDS,
  buildPtyWebSocketUrl,
  createLoopitClient,
  parsePreviewExpiresAt,
  parseSseChunk,
  resolvePreviewUrl,
} from './api'
export type {
  ApprovalGate,
  AuditStreamEvent,
  BrowserTestBody,
  BrowserTestRun,
  BrowserTestStep,
  BuildTemplate,
  ChatChunkStreamEvent,
  ChatStreamEvent,
  CheckpointView,
  CostStreamEvent,
  DagStreamEvent,
  DomainClaim,
  ErrorStreamEvent,
  FileChange,
  FileChangeOp,
  FileChangeStreamEvent,
  GateStreamEvent,
  GitSyncStatus,
  BuildNotification,
  Health,
  LogStreamEvent,
  LoopitClient,
  LoopitClientOptions,
  Me,
  PendingReview,
  NodeStatus,
  PreviewUrl,
  ProjectDetail,
  ProjectSummary,
  ProjectVisibility,
  PublicShare,
  RunCost,
  RunDetail,
  RunMode,
  RunStatus,
  RunStreamEvent,
  RunSummary,
  RunTier,
  SecurityFinding,
  SecurityScanBody,
  SecurityScanResult,
  StreamEvent,
  StreamRunOptions,
  TaskDagView,
  TaskNodeView,
  VisualEditBody,
  VisualEditKind,
  VisualEditResult,
  ApplyPatchBody,
  ApplyPatchResult,
  PreviewMeta,
  PtyInfo,
  ProjectLeaseInfo,
  ProjectConnector,
  ProjectConnectorKind,
  ProjectAnalytics,
  ProjectCollab,
  PresencePeer,
  CollabChatMessage,
} from './api'

export {
  EFFORT_OPTIONS,
  CREDITS_PER_TURN_HINT,
  effortOption,
  shouldEstimateBeforeRun,
  formatCreditEstimate,
} from './effort'
export type { EffortOption, EffortTier } from './effort'

export { toActivity } from './activity'
export type { Activity } from './activity'

export {
  cleanPromptTitle,
  emptyRunUiState,
  extractCost,
  extractDag,
  extractGates,
  formatTokens,
  isCompletedNode,
  orderedDagNodes,
  pickPreviewFile,
  reduceRunEvent,
  runTitle,
} from './runState'
export type { RunUiState } from './runState'

const client = createLoopitClient()

export const getLoopitToken = client.getToken
export const clearLoopitToken = client.clearToken
export const getHealth = client.getHealth
export const getMe = client.getMe
export const listRuns = client.listRuns
export const getRun = client.getRun
export const startRun = client.startRun
export const listNotifications = client.listNotifications
export const markNotificationsRead = client.markNotificationsRead
export const listReviews = client.listReviews
export const getReview = client.getReview
export const applyReview = client.applyReview
export const dismissReview = client.dismissReview
export const sendRunMessage = client.sendRunMessage
export const cancelRun = client.cancelRun
export const listProjects = client.listProjects
export const getProject = client.getProject
export const renameProject = client.renameProject
export const archiveProject = client.archiveProject
export const restoreProject = client.restoreProject
export const duplicateProject = client.duplicateProject
export const putProjectKnowledge = client.putProjectKnowledge
export const setProjectVisibility = client.setProjectVisibility
export const getGitStatus = client.getGitStatus
export const bindGitRemote = client.bindGitRemote
export const unbindGitRemote = client.unbindGitRemote
export const pushGitCheckpoint = client.pushGitCheckpoint
export const pullGitWebhook = client.pullGitWebhook
export const listProjectDomains = client.listProjectDomains
export const claimProjectDomain = client.claimProjectDomain
export const verifyProjectDomain = client.verifyProjectDomain
export const getPublicShare = client.getPublicShare
export const remixPublicShare = client.remixPublicShare
export const listTemplates = client.listTemplates
export const getTemplate = client.getTemplate
export const remixTemplate = client.remixTemplate
export const getCheckpointFile = client.getCheckpointFile
export const execCommand = client.execCommand
export const deployProject = client.deployProject
export const unpublishProject = client.unpublishProject
export const republishProject = client.republishProject
export const rollbackDeployment = client.rollbackDeployment
export const listDeployments = client.listDeployments
export const listProjectSecrets = client.listProjectSecrets
export const putProjectSecret = client.putProjectSecret
export const deleteProjectSecret = client.deleteProjectSecret
export const getProjectDatabase = client.getProjectDatabase
export const getProjectDatabaseTable = client.getProjectDatabaseTable
export const approveGate = client.approveGate
export const rejectGate = client.rejectGate
export const rollbackCheckpoint = client.rollbackCheckpoint
export const forkCheckpoint = client.forkCheckpoint
export const createPreviewUrl = client.createPreviewUrl
export const reportConsoleError = client.reportConsoleError
export const applyVisualEdit = client.applyVisualEdit
export const applyProjectPatch = client.applyProjectPatch
export const getPreviewMeta = client.getPreviewMeta
export const getPtyInfo = client.getPtyInfo
export const getProjectLease = client.getProjectLease
export const startBrowserTest = client.startBrowserTest
export const listBrowserTests = client.listBrowserTests
export const getBrowserTest = client.getBrowserTest
export const runSecurityScan = client.runSecurityScan
export const getSecurityScan = client.getSecurityScan
export const listProjectConnectors = client.listProjectConnectors
export const setProjectConnector = client.setProjectConnector
export const getProjectAnalytics = client.getProjectAnalytics
export const seedProjectAnalytics = client.seedProjectAnalytics
export const getProjectCollab = client.getProjectCollab
export const heartbeatProjectPresence = client.heartbeatProjectPresence
export const postProjectCollabChat = client.postProjectCollabChat
export const getFile = client.getFile
export const streamRunEvents = client.streamRunEvents
