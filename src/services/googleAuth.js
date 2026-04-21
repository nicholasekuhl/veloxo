// Google OAuth helpers — connect flow, token refresh, authenticated client factory.
// Reads/writes google_integrations with encrypted tokens.

const { google } = require('googleapis')
const crypto = require('crypto')
const supabase = require('../db')
const { encrypt, decrypt } = require('../utils/tokenCrypto')

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email'
]

const REFRESH_BUFFER_MS = 5 * 60 * 1000 // refresh if token expires within 5 min

// Build a fresh OAuth2 client instance (stateless — no shared tokens).
const buildOAuthClient = () => new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
)

// Generate the consent-screen URL. `state` is an HMAC-signed userId so the
// callback can verify the user who started the flow hasn't been swapped.
const getAuthUrl = (userId) => {
  const state = signState(userId)
  const client = buildOAuthClient()
  return client.generateAuthUrl({
    access_type: 'offline',       // required to get a refresh_token
    prompt: 'consent',            // force refresh_token on reconnect
    scope: SCOPES,
    state,
    include_granted_scopes: true
  })
}

const signState = (userId) => {
  const secret = process.env.GOOGLE_CLIENT_SECRET || 'fallback'
  const payload = `${userId}.${Date.now()}`
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32)
  return Buffer.from(`${payload}.${sig}`).toString('base64url')
}

const verifyState = (state) => {
  try {
    const decoded = Buffer.from(state, 'base64url').toString('utf8')
    const [userId, ts, sig] = decoded.split('.')
    if (!userId || !ts || !sig) return null
    const ageMs = Date.now() - parseInt(ts, 10)
    if (ageMs > 10 * 60 * 1000) return null // state valid for 10 min
    const secret = process.env.GOOGLE_CLIENT_SECRET || 'fallback'
    const expected = crypto.createHmac('sha256', secret).update(`${userId}.${ts}`).digest('hex').slice(0, 32)
    if (expected !== sig) return null
    return userId
  } catch {
    return null
  }
}

// Exchange the callback code for tokens + identify the Google account email.
const exchangeCodeForTokens = async (code) => {
  const client = buildOAuthClient()
  const { tokens } = await client.getToken(code)
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh_token. User may need to revoke existing access at myaccount.google.com/permissions and reconnect.')
  }
  client.setCredentials(tokens)
  const oauth2 = google.oauth2({ version: 'v2', auth: client })
  const { data: userinfo } = await oauth2.userinfo.get()
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: new Date(tokens.expiry_date || Date.now() + 3600 * 1000),
    scope: tokens.scope,
    email: userinfo.email
  }
}

// Store/replace a user's Google integration row.
const saveIntegration = async (userId, tokenData) => {
  const row = {
    user_id: userId,
    google_email: tokenData.email,
    access_token: encrypt(tokenData.access_token),
    refresh_token: encrypt(tokenData.refresh_token),
    token_expires_at: tokenData.expires_at.toISOString(),
    scope: tokenData.scope,
    sync_enabled: true,
    push_enabled: true,
    pull_enabled: true,
    pull_sync_token: null,        // force full pull on first sync
    last_pull_at: null,
    last_pull_error: null,
    last_push_error: null,
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }
  const { error } = await supabase.from('google_integrations').upsert(row, { onConflict: 'user_id' })
  if (error) throw error
}

// Load the integration for a user, or null if none exists / disabled.
const getIntegration = async (userId) => {
  const { data } = await supabase
    .from('google_integrations')
    .select('*')
    .eq('user_id', userId)
    .eq('sync_enabled', true)
    .maybeSingle()
  return data || null
}

// Return an OAuth2 client pre-loaded with valid tokens.
// Refreshes the access token automatically if it's near expiry.
const getAuthenticatedClient = async (userId) => {
  const integration = await getIntegration(userId)
  if (!integration) return null

  const client = buildOAuthClient()
  const accessToken = decrypt(integration.access_token)
  const refreshToken = decrypt(integration.refresh_token)
  const expiresAt = new Date(integration.token_expires_at).getTime()

  client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: expiresAt
  })

  // Refresh if within buffer window
  if (Date.now() + REFRESH_BUFFER_MS >= expiresAt) {
    try {
      const { credentials } = await client.refreshAccessToken()
      const newExpires = new Date(credentials.expiry_date || Date.now() + 3600 * 1000)
      await supabase.from('google_integrations').update({
        access_token: encrypt(credentials.access_token),
        token_expires_at: newExpires.toISOString(),
        updated_at: new Date().toISOString()
      }).eq('user_id', userId)
      client.setCredentials(credentials)
      await logSync(userId, 'push', 'refresh_token', null, null, true, null)
    } catch (err) {
      await handleAuthError(userId, err)
      return null
    }
  }

  return client
}

// If refresh fails (invalid_grant = user revoked access), disable sync
// and log the error so the UI can surface it.
const handleAuthError = async (userId, err) => {
  const isInvalidGrant = err?.response?.data?.error === 'invalid_grant' ||
                         /invalid_grant/i.test(err?.message || '')
  if (isInvalidGrant) {
    await supabase.from('google_integrations').update({
      sync_enabled: false,
      last_push_error: 'Access revoked — user must reconnect',
      updated_at: new Date().toISOString()
    }).eq('user_id', userId)
  }
  await logSync(userId, 'push', 'refresh_token', null, null, false, err.message || 'unknown error')
}

// Disconnect — revoke Google-side + delete local row.
const disconnect = async (userId) => {
  const integration = await getIntegration(userId)
  if (integration) {
    try {
      const client = buildOAuthClient()
      client.setCredentials({ access_token: decrypt(integration.access_token) })
      await client.revokeCredentials().catch(() => {})
    } catch {}
  }
  await supabase.from('google_integrations').delete().eq('user_id', userId)
  await supabase.from('google_external_events').delete().eq('user_id', userId)
}

// Audit log helper — used across this file and googleCalendar.js.
const logSync = async (userId, direction, action, appointmentId, googleEventId, success, errorMessage) => {
  try {
    await supabase.from('google_sync_log').insert({
      user_id: userId,
      direction,
      action,
      appointment_id: appointmentId,
      google_event_id: googleEventId,
      success,
      error_message: errorMessage ? String(errorMessage).slice(0, 500) : null
    })
  } catch {
    // Never let audit log failures break the actual sync
  }
}

module.exports = {
  SCOPES,
  getAuthUrl,
  verifyState,
  exchangeCodeForTokens,
  saveIntegration,
  getIntegration,
  getAuthenticatedClient,
  disconnect,
  logSync
}