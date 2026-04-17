const express = require('express')
const router = express.Router()
const multer = require('multer')
const { parseHeaders, uploadLeads, riskCheck, getLeads, getLeadStats, getBuckets, exportLeads, getLeadById, updateAutopilot, updateNotes, updateQuotes, updateProduct, updateCommissionStatus, updateLeadBucket, createLead, resumeCampaigns, blockLead, unblockLead, markSold, unmarkSold, deleteLead, skipToday, pauseDrips, markCalled, bulkAction, optOut, undoOptOut, checkQuietHours, logComplianceOverride, getPipelineLeads, updatePipelineStage, patchLead, getHouseholdMembers, addHouseholdMember, deleteHouseholdMember } = require('../controllers/leadsController')
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
router.get('/pipeline', getPipelineLeads)
router.get('/stats', getLeadStats)
router.get('/buckets', getBuckets)
router.get('/export', exportLeads)
router.post('/bulk', bulkAction)
router.post('/', createLead)
router.post('/parse-headers', upload.single('file'), parseHeaders)
router.post('/risk-check', upload.single('file'), riskCheck)
router.post('/upload', upload.single('file'), uploadLeads)
router.get('/:id/household', getHouseholdMembers)
router.post('/:id/household', addHouseholdMember)
router.delete('/:id/household/:memberId', deleteHouseholdMember)
router.patch('/:id/product', updateProduct)
router.patch('/:id/autopilot', updateAutopilot)
router.patch('/:id/notes', updateNotes)
router.patch('/:id/quotes', updateQuotes)
router.post('/:id/resume-campaigns', resumeCampaigns)
router.patch('/:id/block', blockLead)
router.patch('/:id/unblock', unblockLead)
router.patch('/:id/bucket', updateLeadBucket)
router.patch('/:id/commission-status', updateCommissionStatus)
router.patch('/:id/pipeline-stage', updatePipelineStage)
router.patch('/:id/lead-info', patchLead)
router.patch('/:id/sold', markSold)
router.patch('/:id/unsold', unmarkSold)
router.patch('/:id/skip-today', skipToday)
router.patch('/:id/pause-drips', pauseDrips)
router.patch('/:id/mark-called', markCalled)
router.post('/:id/opt-out', optOut)
router.post('/:id/undo-opt-out', undoOptOut)
router.delete('/:id', deleteLead)
router.get('/:id/quiet-hours-check', checkQuietHours)
router.post('/compliance-override-log', logComplianceOverride)
router.get('/:id', getLeadById)

module.exports = router