import express from 'express'
import { authenticateToken } from './auth'
import { chatModelCatalog } from '../services/chatModels'

const router = express.Router()

// Public metadata only: never include upstream URLs, names or credentials.
router.get('/catalog', (_req, res) => {
  res.json({ models: chatModelCatalog() })
})

// Shared process-wide selection is retired, including all verbs/subpaths.
router.use('/selection', authenticateToken, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.status(410).json({ code: 'GLOBAL_MODEL_SELECTION_RETIRED', error: 'Select a hosted model on each request instead' })
})

export default router
