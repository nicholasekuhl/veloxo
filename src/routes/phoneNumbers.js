const express = require('express')
const router = express.Router()
const { getPhoneNumbers, searchPhoneNumbers, purchasePhoneNumber, updatePhoneNumber, deletePhoneNumber, setDefaultPhoneNumber, getPhoneNumberHealth, updatePhoneNumberState } = require('../controllers/phoneNumbersController')

router.get('/', getPhoneNumbers)
router.get('/search', searchPhoneNumbers)
router.get('/health', getPhoneNumberHealth)
router.post('/purchase', purchasePhoneNumber)
router.post('/:id/set-default', setDefaultPhoneNumber)
router.patch('/:id/state', updatePhoneNumberState)
router.put('/:id', updatePhoneNumber)
router.delete('/:id', deletePhoneNumber)

module.exports = router
