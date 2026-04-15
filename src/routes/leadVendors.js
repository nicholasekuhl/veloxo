const express = require('express')
const router = express.Router()
const {
  getLeadVendors,
  createLeadVendor,
  updateLeadVendor,
  deleteLeadVendor,
  regenerateApiKey,
  sendSetupEmail
} = require('../controllers/leadVendorsController')

router.get('/', getLeadVendors)
router.post('/', createLeadVendor)
router.patch('/:id', updateLeadVendor)
router.delete('/:id', deleteLeadVendor)
router.post('/:id/regenerate-key', regenerateApiKey)
router.post('/:id/send-setup-email', sendSetupEmail)

module.exports = router
