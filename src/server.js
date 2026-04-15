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
const numbersRouter = require('./routes/numbers')
const { authMiddleware, authMiddlewareBasic, adminMiddleware } = require('./middleware/auth')
const adminRouter = require('./routes/admin')
const creditsRouter = require('./routes/credits')
const apiLeadsRouter = require('./routes/apiLeads')
const { smsQueue } = require('./smsQueue')

if (!process.env.MAKE_WEBHOOK_SECRET) {
  console.warn('[webhook] MAKE_WEBHOOK_SECRET not set — inbound lead webhook will reject all requests')
}

const app = express()
app.set('trust proxy', 1)
const PORT = process.env.PORT || 3000

// Redirect old Railway URL to custom domain.
// NOTE: Twilio webhook still uses the Railway URL.
// Update to app.veloxo.io/webhook/sms when switching to Telnyx.
app.use((req, res, next) => {
  const host = req.hostname || ''
  if (host.includes('railway.app')) {
    if (req.path.startsWith('/webhook')) return next()
    return res.redirect(301, 'https://app.veloxo.io' + req.originalUrl)
  }
  next()
})

app.use(compression())
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(cookieParser())

// Public webhook — no auth required, registered before static files
app.use('/api/leads', apiLeadsRouter)

// Must run BEFORE express.static — static middleware auto-serves index.html for GET /
// and would bypass this handler entirely if it came after.
app.get('/', (req, res) => {
  const host = (
    req.headers['x-forwarded-host'] ||
    req.headers.host ||
    req.hostname ||
    ''
  ).toLowerCase().split(':')[0]

  console.log('[routing] GET / host:', host)

  // app.veloxo.io → send to app or login depending on session
  if (host === 'app.veloxo.io' || host.startsWith('app.')) {
    const token = req.cookies?.session || req.cookies?.refresh
    if (token) {
      console.log('[routing] Session found, redirecting to leads')
      return res.redirect(302, '/leads.html')
    }
    console.log('[routing] No session, redirecting to login')
    return res.redirect(302, '/login.html')
  }

  // veloxo.io, www.veloxo.io, or anything else → landing page
  console.log('[routing] Serving landing page')
  res.sendFile(path.join(__dirname, '../public/landing.html'))
})

app.use(express.static(path.join(__dirname, '../public'), { maxAge: '5m', etag: true, lastModified: true }))

app.post('/access-requests', async (req, res) => {
  const { createAccessRequest } = require('./controllers/adminController')
  return createAccessRequest(req, res)
})

app.post('/api/waitlist', async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ error: 'Email required' })
  try {
    const supabase = require('./db')
    const { error } = await supabase
      .from('waitlist')
      .insert([{ email, created_at: new Date().toISOString() }])
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    console.error('Waitlist error:', err)
    res.status(500).json({ error: 'Failed to save' })
  }
})

app.use('/auth', authRouter)

// Profile patch — uses authMiddlewareBasic so it works during onboarding (profile_complete = false)
const { updateProfile } = require('./controllers/authController')
app.patch('/profile', authMiddlewareBasic, updateProfile)

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
app.use('/api/numbers', authMiddleware, numbersRouter)
app.use('/admin', authMiddleware, adminMiddleware, adminRouter)
app.use('/api/credits', authMiddleware, creditsRouter)

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
    res.json({ status, last_heartbeat: data.last_heartbeat, age_seconds: Math.round(ageMs / 1000), messages_sent_last_run: data.messages_sent_last_run, errors_last_run: data.errors_last_run, sms_queue: smsQueue.getStats() })
  } catch (err) {
    res.json({ status: 'unknown', error: err.message })
  }
})

const server = app.listen(PORT, () => {
  console.log(`Veloxo server running on port ${PORT}`)
})

process.on('SIGTERM', async () => {
  console.log('SIGTERM received — shutting down gracefully')
  server.close()
  await smsQueue.shutdown(30000)
  process.exit(0)
})

const bracketRouter = require('./routes/bracket')
// add with your other routes:
app.use('/bracket', bracketRouter)