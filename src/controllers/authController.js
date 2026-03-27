const supabase = require('../db')
const nodemailer = require('nodemailer')
const crypto = require('crypto')

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax'
}

const getMailer = () => nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
})

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
  res.clearCookie('session')
  res.clearCookie('refresh')
  res.json({ success: true })
}

const getMe = async (req, res) => {
  res.json({ user: req.user.profile })
}

const updateProfile = async (req, res) => {
  try {
    const { agent_name, agency_name, calendly_url, timezone, compliance_footer, compliance_footer_enabled, personal_phone, sms_notifications_enabled, inapp_notifications_enabled, agent_nickname, notify_appointment_sms } = req.body

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
    const signupLink = `${appUrl}/signup.html?token=${token}`

    if (process.env.SMTP_HOST) {
      const mailer = getMailer()
      await mailer.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: email,
        subject: 'You have been invited to TextApp',
        text: `You have been invited to join TextApp.\n\nClick here to set up your account:\n${signupLink}\n\nThis link expires in 7 days.`,
        html: `<p>You have been invited to join TextApp.</p><p><a href="${signupLink}" style="background:#6366f1;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">Set Up Your Account</a></p><p style="color:#9ca3af;font-size:12px;">This link expires in 7 days.</p>`
      })
    }

    res.json({ success: true, invite_link: signupLink })
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

module.exports = { login, logout, getMe, updateProfile, signup, authCallback, inviteAgent, validateToken, signupWithToken, getInvites, cancelInvite, forgotPassword, resetPassword, agreeTos }
