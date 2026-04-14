const express = require('express')
const router = express.Router()
const { authMiddleware, authMiddlewareBasic, authMiddlewareNoTos } = require('../middleware/auth')
const {
  login, logout, getMe, updateProfile, signup, authCallback,
  inviteAgent, validateToken, signupWithToken, getInvites,
  cancelInvite, forgotPassword, resetPassword, agreeTos,
  verifyInvite, acceptInvite
} = require('../controllers/authController')

router.post('/login', login)
router.post('/logout', logout)
// authMiddlewareBasic: /me must work during onboarding (profile_complete = false)
router.get('/me', authMiddlewareBasic, getMe)
router.patch('/me', authMiddlewareBasic, updateProfile)
router.post('/signup', signup)
router.get('/callback', authCallback)
router.post('/invite', authMiddleware, inviteAgent)
// /invite/verify must be declared before /invite/:token to avoid route conflict
router.get('/invite/verify', verifyInvite)
router.post('/invite/accept', acceptInvite)
router.get('/invite/:token', validateToken)
router.post('/signup-with-token', signupWithToken)
router.get('/invites', authMiddleware, getInvites)
router.delete('/invites/:id', authMiddleware, cancelInvite)
router.post('/forgot-password', forgotPassword)
router.post('/reset-password', resetPassword)
router.post('/agree-tos', authMiddlewareNoTos, agreeTos)

module.exports = router
