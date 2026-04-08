const express = require('express')
const router = express.Router()
const { sendInitialOutreach, handleIncomingMessage, sendManualMessage, suggestReply, handleStatusCallback, getMessagesByLead } = require('../controllers/messagesController')
const { authMiddleware } = require('../middleware/auth')

// Public Twilio webhooks — no auth
router.post('/incoming', handleIncomingMessage)
router.post('/status-callback', handleStatusCallback)
router.post('/status', handleStatusCallback)

// Protected routes
router.get('/', authMiddleware, getMessagesByLead)
router.post('/send/:leadId', authMiddleware, sendInitialOutreach)
router.post('/send-manual', authMiddleware, sendManualMessage)
router.post('/suggest', authMiddleware, suggestReply)

module.exports = router
