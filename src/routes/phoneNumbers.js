const express = require('express')
const router = express.Router()
const { getPhoneNumbers, searchPhoneNumbers, purchasePhoneNumber, updatePhoneNumber, deletePhoneNumber } = require('../controllers/phoneNumbersController')

router.get('/', getPhoneNumbers)
router.get('/search', searchPhoneNumbers)
router.post('/purchase', purchasePhoneNumber)
router.put('/:id', updatePhoneNumber)
router.delete('/:id', deletePhoneNumber)

module.exports = router
