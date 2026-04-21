const express = require('express')
const router = express.Router()
const {
  getStatus,
  connect,
  callback,
  disconnectGoogle,
  updateSettings,
  getExternalEvents,
  syncNow
} = require('../controllers/googleController')

// NOTE: /callback is registered without authMiddleware in server.js
// because Google redirects the browser here without a session cookie in
// some flows. User identity comes from the signed state param.
router.get('/status', getStatus)
router.get('/connect', connect)
router.get('/external-events', getExternalEvents)
router.post('/sync-now', syncNow)
router.post('/disconnect', disconnectGoogle)
router.patch('/settings', updateSettings)

module.exports = router