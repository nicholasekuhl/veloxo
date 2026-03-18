const express = require('express')
const router = express.Router()
const {
  getDispositionTags,
  createDispositionTag,
  updateDispositionTag,
  deleteDispositionTag,
  applyDisposition,
  getLeadDispositionHistory
} = require('../controllers/dispositionsController')

router.get('/', getDispositionTags)
router.post('/', createDispositionTag)
router.put('/:id', updateDispositionTag)
router.delete('/:id', deleteDispositionTag)
router.post('/apply', applyDisposition)
router.get('/history/:leadId', getLeadDispositionHistory)

module.exports = router