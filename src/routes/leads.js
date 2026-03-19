const express = require('express')
const router = express.Router()
const multer = require('multer')
const { uploadLeads, getLeads, getBuckets, exportLeads, getLeadById, updateAutopilot, updateNotes, createLead } = require('../controllers/leadsController')
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

module.exports = router

router.get('/:id', getLeadById)