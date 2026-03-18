const express = require('express')
const router = express.Router()
const { getConversations, getConversation, updateConversation } = require('../controllers/conversationsController')

router.get('/', getConversations)
router.get('/:id', getConversation)
router.patch('/:id', updateConversation)

module.exports = router