const express = require('express')
const cors = require('cors')
const path = require('path')
const cookieParser = require('cookie-parser')
const compression = require('compression')
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
const bucketsRouter = require('./routes/buckets')
const phoneNumbersRouter = require('./routes/phoneNumbers')
const scheduledMessagesRouter = require('./routes/scheduledMessages')
const appointmentsRouter = require('./routes/appointments')
const notificationsRouter = require('./routes/notifications')
const { authMiddleware, adminMiddleware } = require('./middleware/auth')
const adminRouter = require('./routes/admin')
const { startScheduler } = require('./scheduler')
const { smsQueue } = require('./smsQueue')

const app = express()
const PORT = process.env.PORT || 3000

app.use(compression())
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(cookieParser())
app.use(express.static(path.join(__dirname, '../public'), { maxAge: '1h' }))

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
app.use('/scheduled-messages', authMiddleware, scheduledMessagesRouter)
app.use('/notifications', authMiddleware, notificationsRouter)
app.use('/buckets', authMiddleware, bucketsRouter)
app.use('/admin', authMiddleware, adminMiddleware, adminRouter)

app.get('/health', (req, res) => {
  res.json({ status: 'server is running' })
})

app.get('/health/scheduler', async (_req, res) => {
  try {
    const supabase = require('./db')
    const { data, error } = await supabase
      .from('scheduler_health')
      .select('last_heartbeat, messages_sent_last_run, errors_last_run, updated_at')
      .eq('id', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890')
      .single()

    if (error || !data) return res.json({ status: 'unknown', last_heartbeat: null })

    const ageMs = Date.now() - new Date(data.last_heartbeat).getTime()
    const status = ageMs < 3 * 60 * 1000 ? 'healthy' : 'down'
    const queueStats = smsQueue.getStats()
    res.json({ status, last_heartbeat: data.last_heartbeat, age_seconds: Math.round(ageMs / 1000), messages_sent_last_run: data.messages_sent_last_run, errors_last_run: data.errors_last_run, sms_queue: queueStats })
  } catch (err) {
    res.json({ status: 'unknown', error: err.message })
  }
})

startScheduler()
smsQueue.start()

const server = app.listen(PORT, () => {
  console.log(`TextApp server running on port ${PORT}`)
})

process.on('SIGTERM', () => {
  console.log('SIGTERM received — draining queue and shutting down gracefully')
  server.close(() => {
    console.log('HTTP server closed')
  })
  let waited = 0
  const checkDrain = setInterval(() => {
    const { inQueue } = smsQueue.getStats()
    waited += 500
    if (inQueue === 0 || waited >= 30000) {
      clearInterval(checkDrain)
      console.log(`Queue drained, exiting. Remaining: ${inQueue}`)
      process.exit(0)
    }
  }, 500)
})

const bracketRouter = require('./routes/bracket')
// add with your other routes:
app.use('/bracket', bracketRouter)