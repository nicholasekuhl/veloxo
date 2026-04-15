const express = require('express')
const router = express.Router()
const {
  getDispositionTags,
  createDispositionTag,
  updateDispositionTag,
  deleteDispositionTag,
  applyDisposition,
  applyMultiDisposition,
  getLeadDispositionHistory,
  reorderDispositionTags,
  getAutomatedActions,
  createAutomatedAction,
  updateAutomatedAction,
  deleteAutomatedAction
} = require('../controllers/dispositionsController')

router.get('/', getDispositionTags)
router.post('/reorder', reorderDispositionTags)
router.post('/', createDispositionTag)
router.put('/:id', updateDispositionTag)
router.delete('/:id', deleteDispositionTag)
router.post('/apply', applyDisposition)
router.post('/apply-multi', applyMultiDisposition)
router.get('/history/:leadId', getLeadDispositionHistory)

// Automated actions
router.get('/actions', getAutomatedActions)
router.post('/actions', createAutomatedAction)
router.put('/actions/:id', updateAutomatedAction)
router.delete('/actions/:id', deleteAutomatedAction)

module.exports = router