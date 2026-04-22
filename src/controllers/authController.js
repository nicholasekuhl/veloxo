const supabase = require('../db')
const crypto = require('crypto')

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/'
}

const generateSlug = async (name) => {
  let base = name.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-')
  if (!base) base = 'agent'
  let slug = base
  let count = 2
  while (true) {
    const { data } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('agent_slug', slug)
      .single()
    if (!data) break
    slug = base + '-' + count
    count++
  }
  return slug
}

const login = async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' })

    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return res.status(401).json({ error: error.message })

    const { data: existingProfile } = await supabase
      .from('user_profiles').select('id').eq('id', data.user.id).single()

    if (!existingProfile) {
      await supabase.from('user_profiles').insert({
        id: data.user.id,
        email: data.user.email,
        agent_name: data.user.email.split('@')[0]
      })
    }

    res.cookie('session', data.session.access_token, { ...COOKIE_OPTS, maxAge: 60 * 60 * 1000 })
    res.cookie('refresh', data.session.refresh_token, { ...COOKIE_OPTS, maxAge: 30 * 24 * 60 * 60 * 1000 })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const logout = async (req, res) => {
  res.clearCookie('session', { path: '/' })
  res.clearCookie('refresh', { path: '/' })
  res.json({ success: true })
}

const getMe = async (req, res) => {
  res.json({ user: req.user.profile })
}

const updateProfile = async (req, res) => {
  try {
    const {
      agent_name, agency_name, calendly_url, timezone,
      compliance_footer, compliance_footer_enabled,
      personal_phone, sms_notifications_enabled,
      inapp_notifications_enabled, agent_nickname,
      notify_appointment_sms, first_name, last_name, state,
      priority_autopilot, ai_afterhours_response,
      business_address, business_city, business_state, business_zip
    } = req.body

    const updates = { updated_at: new Date().toISOString() }
    if (agent_name !== undefined) updates.agent_name = agent_name
    if (agency_name !== undefined) updates.agency_name = agency_name
    if (agent_nickname !== undefined) updates.agent_nickname = agent_nickname
    if (calendly_url !== undefined) updates.calendly_url = calendly_url
    if (timezone !== undefined) updates.timezone = timezone
    if (compliance_footer !== undefined) updates.compliance_footer = compliance_footer
    if (compliance_footer_enabled !== undefined) updates.compliance_footer_enabled = compliance_footer_enabled
    if (personal_phone !== undefined) updates.personal_phone = personal_phone
    if (sms_notifications_enabled !== undefined) updates.sms_notifications_enabled = sms_notifications_enabled
    if (inapp_notifications_enabled !== undefined) updates.inapp_notifications_enabled = inapp_notifications_enabled
    if (notify_appointment_sms !== undefined) updates.notify_appointment_sms = notify_appointment_sms
    if (first_name !== undefined) updates.first_name = first_name
    if (last_name !== undefined) updates.last_name = last_name
    if (state !== undefined) updates.state = state
    if (priority_autopilot !== undefined) updates.priority_autopilot = priority_autopilot
    if (ai_afterhours_response !== undefined) updates.ai_afterhours_response = ai_afterhours_response
    if (business_address !== undefined) updates.business_address = business_address
    if (business_city !== undefined) updates.business_city = business_city
    if (business_state !== undefined) updates.business_state = business_state
    if (business_zip !== undefined) updates.business_zip = business_zip
    if (req.body.advisor_page_enabled !== undefined) updates.advisor_page_enabled = req.body.advisor_page_enabled

    // Auto-mark profile complete when all required fields are present
    const existing = req.user.profile
    const merged = { ...existing, ...updates }
    const required = ['agent_name', 'agency_name', 'personal_phone', 'state', 'calendly_url']
    if (!existing.profile_complete && required.every(f => merged[f])) {
      updates.profile_complete = true
    }

    // Auto-generate slug if not set and agent_name is available
    if (!existing.agent_slug && merged.agent_name) {
      updates.agent_slug = await generateSlug(merged.agent_name)
    }

    const { data, error } = await supabase
      .from('user_profiles').update(updates).eq('id', req.user.id).select().single()
    if (error) throw error
    res.json({ success: true, profile: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const signup = async (req, res) => {
  try {
    const { email, password, agent_name } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' })
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })

    const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${appUrl}/auth/callback` }
    })
    if (error) return res.status(400).json({ error: error.message })

    if (data.user) {
      await supabase.from('user_profiles').insert({
        id: data.user.id,
        email: data.user.email,
        agent_name: agent_name || email.split('@')[0]
      })
      await supabase.from('buckets').insert({ user_id: data.user.id, name: 'Sold', color: '#22c55e' })
    }

    res.json({ success: true, needsVerification: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const authCallback = async (req, res) => {
  try {
    const { token_hash, type, code } = req.query
    let session = null

    if (token_hash) {
      const { data, error } = await supabase.auth.verifyOtp({ token_hash, type: type || 'signup' })
      if (!error && data.session) session = data.session
    } else if (code) {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code)
      if (!error && data.session) session = data.session
    }

    if (!session) return res.redirect('/login.html?verified=failed')

    res.cookie('session', session.access_token, { ...COOKIE_OPTS, maxAge: 60 * 60 * 1000 })
    res.cookie('refresh', session.refresh_token, { ...COOKIE_OPTS, maxAge: 30 * 24 * 60 * 60 * 1000 })
    res.redirect('/')
  } catch (err) {
    res.redirect('/login.html?verified=failed')
  }
}

const inviteAgent = async (req, res) => {
  try {
    const { email } = req.body
    if (!email) return res.status(400).json({ error: 'Email is required' })

    // Check if user already exists
    const { data: existing } = await supabase
      .from('user_profiles').select('id').eq('email', email).single()
    if (existing) return res.status(400).json({ error: 'An account with this email already exists' })

    // Cancel any existing unused invites for this email
    await supabase.from('invites').update({ used: true }).eq('email', email).eq('used', false)

    const token = crypto.randomBytes(32).toString('hex')
    await supabase.from('invites').insert({
      email,
      invited_by: req.user.id,
      token
    })

    const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`
    const inviteUrl = `${appUrl}/invite.html?token=${token}`

    const { sendInviteAgentEmail } = require('../emails/inviteAgent')
    await sendInviteAgentEmail({ email, inviteUrl })

    res.json({ success: true, invite_link: inviteUrl })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const validateToken = async (req, res) => {
  try {
    const { token } = req.params
    const { data, error } = await supabase
      .from('invites')
      .select('*')
      .eq('token', token)
      .eq('used', false)
      .single()

    if (error || !data) return res.json({ valid: false, reason: 'Invalid or already used' })
    if (new Date(data.expires_at) < new Date()) return res.json({ valid: false, reason: 'Invite link has expired' })

    res.json({ valid: true, email: data.email })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const signupWithToken = async (req, res) => {
  try {
    const { token, password, agent_name, agency_name, calendly_url, timezone } = req.body
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' })
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })

    const { data: invite, error: inviteError } = await supabase
      .from('invites').select('*').eq('token', token).eq('used', false).single()
    if (inviteError || !invite) return res.status(400).json({ error: 'Invalid or already used invite' })
    if (new Date(invite.expires_at) < new Date()) return res.status(400).json({ error: 'Invite link has expired' })

    const { data, error } = await supabase.auth.admin.createUser({
      email: invite.email,
      password,
      email_confirm: true
    })
    if (error) return res.status(400).json({ error: error.message })

    await supabase.from('user_profiles').insert({
      id: data.user.id,
      email: invite.email,
      agent_name: agent_name || invite.email.split('@')[0],
      agency_name: agency_name || null,
      calendly_url: calendly_url || null,
      timezone: timezone || 'America/New_York',
      tos_agreed: true,
      tos_agreed_at: new Date().toISOString()
    })
    await supabase.from('buckets').insert({ user_id: data.user.id, name: 'Sold', color: '#22c55e' })

    await supabase.from('invites').update({ used: true }).eq('id', invite.id)

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const getInvites = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('invites')
      .select('*')
      .eq('invited_by', req.user.id)
      .order('created_at', { ascending: false })
    if (error) throw error
    res.json({ invites: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const cancelInvite = async (req, res) => {
  try {
    const { error } = await supabase
      .from('invites')
      .update({ used: true })
      .eq('id', req.params.id)
      .eq('invited_by', req.user.id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body
    if (!email) return res.status(400).json({ error: 'Email is required' })

    const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${appUrl}/reset-password.html`
    })
    if (error) throw error

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const resetPassword = async (req, res) => {
  try {
    const { token_hash, password } = req.body
    if (!token_hash || !password) return res.status(400).json({ error: 'Token and password are required' })
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })

    const { data, error } = await supabase.auth.verifyOtp({ token_hash, type: 'recovery' })
    if (error || !data?.user) return res.status(400).json({ error: 'Reset link is invalid or expired' })

    const { error: updateError } = await supabase.auth.admin.updateUserById(data.user.id, { password })
    if (updateError) throw updateError

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const verifyInvite = async (req, res) => {
  try {
    const { token } = req.query
    if (!token) return res.json({ valid: false, reason: 'No token provided' })
    const { data, error } = await supabase
      .from('invites').select('email, expires_at').eq('token', token).eq('used', false).single()
    if (error || !data) return res.json({ valid: false, reason: 'Invalid or already used' })
    if (new Date(data.expires_at) < new Date()) return res.json({ valid: false, reason: 'Invite link has expired' })
    res.json({ valid: true, email: data.email })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const acceptInvite = async (req, res) => {
  try {
    const { token, first_name, last_name, password } = req.body
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' })
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' })
    if (!first_name || !last_name) return res.status(400).json({ error: 'First and last name required' })

    const { data: invite, error: inviteError } = await supabase
      .from('invites').select('*').eq('token', token).eq('used', false).single()
    if (inviteError || !invite) return res.status(400).json({ error: 'Invalid or already used invite' })
    if (new Date(invite.expires_at) < new Date()) return res.status(400).json({ error: 'Invite link has expired' })

    const { data: userData, error: createError } = await supabase.auth.admin.createUser({
      email: invite.email, password, email_confirm: true
    })
    if (createError) return res.status(400).json({ error: createError.message })

    const agentName = `${first_name} ${last_name}`.trim()
    const agentSlug = await generateSlug(agentName)
    await supabase.from('user_profiles').insert({
      id: userData.user.id,
      email: invite.email,
      first_name,
      last_name,
      agent_name: agentName,
      agent_slug: agentSlug,
      tos_agreed: true,
      tos_agreed_at: new Date().toISOString(),
      profile_complete: false
    })

    // Create system buckets
    await supabase.from('buckets').insert([
      { user_id: userData.user.id, name: 'Sold', color: '#22c55e', is_system: true, system_key: 'sold' },
      { user_id: userData.user.id, name: 'Opted Out', color: '#ef4444', is_system: true, system_key: 'opted_out' }
    ])

    await supabase.from('invites').update({ used: true }).eq('id', invite.id)

    // Log them in immediately so onboarding can call /auth/me and PATCH /profile
    const { data: loginData, error: loginError } = await supabase.auth.signInWithPassword({
      email: invite.email, password
    })
    if (loginError) {
      return res.json({ success: true, needsManualLogin: true })
    }

    res.cookie('session', loginData.session.access_token, { ...COOKIE_OPTS, maxAge: 60 * 60 * 1000 })
    res.cookie('refresh', loginData.session.refresh_token, { ...COOKIE_OPTS, maxAge: 30 * 24 * 60 * 60 * 1000 })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const agreeTos = async (req, res) => {
  try {
    const { error } = await supabase
      .from('user_profiles')
      .update({ tos_agreed: true, tos_agreed_at: new Date().toISOString() })
      .eq('id', req.user.id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

module.exports = { login, logout, getMe, updateProfile, signup, authCallback, inviteAgent, validateToken, signupWithToken, getInvites, cancelInvite, forgotPassword, resetPassword, agreeTos, verifyInvite, acceptInvite }
