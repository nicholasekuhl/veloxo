const express = require('express')
const router = express.Router()
const { getLeadTasks, createTask, updateTask, deleteTask } = require('../controllers/tasksController')

router.get('/:leadId', getLeadTasks)
router.post('/', createTask)
router.put('/:id', updateTask)
router.delete('/:id', deleteTask)

module.exports = router