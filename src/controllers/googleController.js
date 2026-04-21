const {
  getAuthUrl,
  verifyState,
  exchangeCodeForTokens,
  saveIntegration,
  getIntegration,
  disconnect
} = require('../services/googleAuth')
const { pullExternalEvents } = require('../services/googleCalendar')
const supabase = require('../db')

// GET /api/google/status — is this user connected, and what's the state
const getStatus = async (req, res) => {
  try {
    const integration = await getIntegration(req.user.id)
    if (!integration) return res.json({ connected: false })
    res.json({
      connected: true,
      google_email: integration.google_email,
      push_enabled: integration.push_enabled,
      pull_enabled: integration.pull_enabled,
      last_pull_at: integration.last_pull_at,
      last_pull_error: integration.last_pull_error,
      last_push_error: integration.last_push_error,
      connected_at: integration.connected_at
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

// GET /api/google/connect — redirect to Google's consent screen
const connect = async (req, res) => {
  try {
    const url = getAuthUrl(req.user.id)
    res.redirect(url)
  } catch (err) {
    console.error('[google/connect]', err)
    res.status(500).send('Failed to start Google OAuth flow')
  }
}

// GET /api/google/callback — Google redirects here after consent
const callback = async (req, res) => {
  const { code, state, error } = req.query

  if (error) {
    console.log('[google/callback] user denied consent:', error)
    return res.redirect('/settings.html?google=denied')
  }
  if (!code || !state) {
    return res.redirect('/settings.html?google=error&reason=missing_params')
  }

  const userId = verifyState(state)
  if (!userId) {
    return res.redirect('/settings.html?google=error&reason=invalid_state')
  }

  try {
    const tokenData = await exchangeCodeForTokens(code)
    await saveIntegration(userId, tokenData)
    // Kick off a first pull in the background — don't block the redirect
    pullExternalEvents(userId).catch(err =>
      console.error('[google/callback] initial pull failed:', err.message))
    res.redirect('/settings.html?google=connected')
  } catch (err) {
    console.error('[google/callback]', err)
    res.redirect(`/settings.html?google=error&reason=${encodeURIComponent(err.message)}`)
  }
}

// POST /api/google/disconnect
const disconnectGoogle = async (req, res) => {
  try {
    await disconnect(req.user.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

// PATCH /api/google/settings — toggle push/pull without disconnecting
const updateSettings = async (req, res) => {
  try {
    const { push_enabled, pull_enabled } = req.body
    const updates = { updated_at: new Date().toISOString() }
    if (typeof push_enabled === 'boolean') updates.push_enabled = push_enabled
    if (typeof pull_enabled === 'boolean') updates.pull_enabled = pull_enabled
    const { error } = await supabase
      .from('google_integrations')
      .update(updates)
      .eq('user_id', req.user.id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

// GET /api/google/external-events — cached Google events for calendar display
// Query params: from (ISO), to (ISO). Defaults to 30 days around now.
const getExternalEvents = async (req, res) => {
  try {
    const from = req.query.from
      ? new Date(req.query.from).toISOString()
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const to = req.query.to
      ? new Date(req.query.to).toISOString()
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

    const { data, error } = await supabase
      .from('google_external_events')
      .select('google_event_id, title, starts_at, ends_at, is_all_day')
      .eq('user_id', req.user.id)
      .gte('starts_at', from)
      .lte('starts_at', to)
      .order('starts_at', { ascending: true })
    if (error) throw error
    res.json({ events: data || [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

// POST /api/google/sync-now — manual "sync now" button
const syncNow = async (req, res) => {
  try {
    const result = await pullExternalEvents(req.user.id)
    res.json({ success: true, ...result })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

module.exports = {
  getStatus,
  connect,
  callback,
  disconnectGoogle,
  updateSettings,
  getExternalEvents,
  syncNow
}