const express = require('express')
const router = express.Router()
const { getPhoneNumbers, addPhoneNumber, updatePhoneNumber, deletePhoneNumber } = require('../controllers/phoneNumbersController')

router.get('/', getPhoneNumbers)
router.post('/', addPhoneNumber)
router.put('/:id', updatePhoneNumber)
router.delete('/:id', deletePhoneNumber)

module.exports = router
