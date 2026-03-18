const express = require('express')
const router = express.Router()
const { getDeliveryStats } = require('../controllers/statsController')

router.get('/delivery', getDeliveryStats)

module.exports = router
