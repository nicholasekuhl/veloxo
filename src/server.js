const express = require('express')
const cors = require('cors')
const path = require('path')
const cookieParser = require('cookie-parser')
require('dotenv').config()

const leadsRouter = require('./routes/leads')
const messagesRouter = require('./routes/messages')
const campaignsRouter = require('./routes/campaigns')
const conversationsRouter = require('./routes/conversations')
const dispositionsRouter = require('./routes/dispositions')
const templatesRouter = require('./routes/templates')
const tasksRouter = require('./routes/tasks')
const statsRouter = require('./routes/stats')
const authRouter = require('./routes/auth')
const phoneNumbersRouter = require('./routes/phoneNumbers')
const appointmentsRouter = require('./routes/appointments')
const notificationsRouter = require('./routes/notifications')
const { authMiddleware } = require('./middleware/auth')
const { startScheduler } = require('./scheduler')

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(cookieParser())
app.use(express.static(path.join(__dirname, '../public')))

app.use('/auth', authRouter)

app.use('/leads', authMiddleware, leadsRouter)
app.use('/messages', messagesRouter)
app.use('/campaigns', authMiddleware, campaignsRouter)
app.use('/conversations', authMiddleware, conversationsRouter)
app.use('/dispositions', authMiddleware, dispositionsRouter)
app.use('/templates', authMiddleware, templatesRouter)
app.use('/tasks', authMiddleware, tasksRouter)
app.use('/stats', authMiddleware, statsRouter)
app.use('/phone-numbers', authMiddleware, phoneNumbersRouter)
app.use('/appointments', authMiddleware, appointmentsRouter)
app.use('/notifications', authMiddleware, notificationsRouter)

app.get('/health', (req, res) => {
  res.json({ status: 'server is running' })
})

startScheduler()

app.listen(PORT, () => {
  console.log(`TextApp server running on port ${PORT}`)
})
