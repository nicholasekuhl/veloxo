const express = require('express')
const router = express.Router()
const { login, logout, getMe, updateProfile, signup, authCallback, inviteAgent, validateToken, signupWithToken, getInvites, cancelInvite } = require('../controllers/authController')
const { authMiddleware } = require('../middleware/auth')

router.post('/login', login)
router.post('/signup', signup)
router.post('/signup-invite', signupWithToken)
router.post('/logout', logout)
router.get('/me', authMiddleware, getMe)
router.put('/profile', authMiddleware, updateProfile)
router.post('/invite', authMiddleware, inviteAgent)
router.get('/invites', authMiddleware, getInvites)
router.delete('/invites/:id', authMiddleware, cancelInvite)
router.get('/validate-token/:token', validateToken)
router.get('/callback', authCallback)

module.exports = router
