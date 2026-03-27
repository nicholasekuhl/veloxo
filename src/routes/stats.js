const express = require('express')
const router = express.Router()
const { getDeliveryStats, getOverview, getMessageStats, getCampaignStats, getLeadFunnel, getActivityStats, getSoldStats, getTwilioDelivery } = require('../controllers/statsController')
const { authMiddleware } = require('../middleware/auth')

router.get('/delivery', getDeliveryStats)
router.get('/overview', authMiddleware, getOverview)
router.get('/messages', authMiddleware, getMessageStats)
router.get('/campaigns', authMiddleware, getCampaignStats)
router.get('/leads', authMiddleware, getLeadFunnel)
router.get('/activity', authMiddleware, getActivityStats)
router.get('/sold', authMiddleware, getSoldStats)
router.get('/twilio-delivery', authMiddleware, getTwilioDelivery)

module.exports = router
