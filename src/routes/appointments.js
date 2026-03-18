const express = require('express')
const router = express.Router()
const { getAppointments, getTodayAppointments, createAppointment, updateAppointment, deleteAppointment, getLeadAppointments } = require('../controllers/appointmentsController')

router.get('/', getAppointments)
router.get('/today', getTodayAppointments)
router.get('/lead/:leadId', getLeadAppointments)
router.post('/', createAppointment)
router.put('/:id', updateAppointment)
router.delete('/:id', deleteAppointment)

module.exports = router
