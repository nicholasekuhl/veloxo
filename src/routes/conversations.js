const express = require('express')
const router = express.Router()
const {
  getConversations,
  getConversation,
  updateConversation,
  starConversation,
  getScheduledMessages,
  createScheduledMessage,
  getConversationMessages
} = require('../controllers/conversationsController')

router.get('/', getConversations)
router.get('/:id', getConversation)
router.patch('/:id', updateConversation)
router.patch('/:id/star', starConversation)
router.get('/:id/messages', getConversationMessages)
router.get('/:id/scheduled', getScheduledMessages)
router.post('/:id/scheduled', createScheduledMessage)

module.exports = router
