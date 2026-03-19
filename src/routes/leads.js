const express = require('express')
const router = express.Router()
const multer = require('multer')
const { uploadLeads, getLeads, getBuckets, exportLeads, getLeadById, updateAutopilot, updateNotes, createLead, resumeCampaigns, blockLead, unblockLead, markSold, unmarkSold } = require('../controllers/leadsController')
const storage = multer.memoryStorage()
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ]
    if (allowed.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Only CSV and Excel files are allowed'))
    }
  }
})

router.get('/', getLeads)
router.get('/buckets', getBuckets)
router.get('/export', exportLeads)
router.post('/', createLead)
router.post('/upload', upload.single('file'), uploadLeads)
router.patch('/:id/autopilot', updateAutopilot)
router.patch('/:id/notes', updateNotes)
router.post('/:id/resume-campaigns', resumeCampaigns)
router.patch('/:id/block', blockLead)
router.patch('/:id/unblock', unblockLead)
router.patch('/:id/sold', markSold)
router.patch('/:id/unsold', unmarkSold)
router.get('/:id', getLeadById)

module.exports = router