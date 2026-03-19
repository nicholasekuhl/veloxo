const express = require('express')
const router = express.Router()
const { getNotifications, getUnreadCount, markAllRead, markOneRead } = require('../notifications')

router.get('/', getNotifications)
router.get('/unread-count', getUnreadCount)
router.post('/read', markAllRead)
router.post('/read/:id', markOneRead)

module.exports = router
