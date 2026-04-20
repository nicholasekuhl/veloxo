const supabase = require('../db')
const { addCredits } = require('../services/credits')

const getUsers = async (req, res) => {
  try {
    // Use auth.admin.listUsers() — guaranteed to bypass RLS and return all users
    const { data: authData, error: authError } = await supabase.auth.admin.listUsers({ perPage: 1000 })
    if (authError) throw authError

    const authUsers = authData.users || []
    const userIds = authUsers.map(u => u.id)

    if (!userIds.length) return res.json({ users: [] })

    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)

    const [{ data: profiles }, { data: leadCounts }, { data: msgCounts }, { data: creditRows }] = await Promise.all([
      supabase
        .from('user_profiles')
        .select('id, agent_name, agency_name, created_at, is_suspended, suspended_at, suspended_reason, is_admin')
        .in('id', userIds),
      supabase.from('leads').select('user_id').in('user_id', userIds),
      supabase.from('messages')
        .select('conversation_id, conversations(user_id)')
        .eq('direction', 'outbound')
        .gte('sent_at', monthStart.toISOString()),
      supabase.from('user_credits').select('user_id, balance, lifetime_purchased, lifetime_used').in('user_id', userIds)
    ])

    const profileMap = {}
    for (const p of profiles || []) profileMap[p.id] = p

    const leadCountMap = {}
    for (const l of leadCounts || []) {
      leadCountMap[l.user_id] = (leadCountMap[l.user_id] || 0) + 1
    }

    const msgCountMap = {}
    for (const m of msgCounts || []) {
      const uid = m.conversations?.user_id
      if (uid) msgCountMap[uid] = (msgCountMap[uid] || 0) + 1
    }

    const creditMap = {}
    for (const c of creditRows || []) creditMap[c.user_id] = c

    const users = authUsers
      .map(au => {
        const profile = profileMap[au.id] || {}
        const credits = creditMap[au.id] || {}
        return {
          id: au.id,
          email: au.email,
          agent_name: profile.agent_name || null,
          agency_name: profile.agency_name || null,
          created_at: profile.created_at || au.created_at,
          is_suspended: profile.is_suspended || false,
          suspended_at: profile.suspended_at || null,
          suspended_reason: profile.suspended_reason || null,
          is_admin: profile.is_admin || false,
          lead_count: leadCountMap[au.id] || 0,
          message_count_this_month: msgCountMap[au.id] || 0,
          credit_balance: credits.balance != null ? parseFloat(credits.balance) : 0,
          lifetime_purchased: credits.lifetime_purchased != null ? parseFloat(credits.lifetime_purchased) : 0,
          lifetime_used: credits.lifetime_used != null ? parseFloat(credits.lifetime_used) : 0
        }
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

    res.json({ users })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const suspendUser = async (req, res) => {
  try {
    const { id } = req.params
    const { reason } = req.body

    if (!reason?.trim()) return res.status(400).json({ error: 'Reason is required' })
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot suspend your own account' })

    const { error } = await supabase
      .from('user_profiles')
      .update({ is_suspended: true, suspended_at: new Date().toISOString(), suspended_reason: reason.trim() })
      .eq('id', id)

    if (error) throw error

    // Invalidate all their Supabase auth sessions
    await supabase.auth.admin.signOut(id, 'global').catch(() => {})

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const unsuspendUser = async (req, res) => {
  try {
    const { id } = req.params

    const { error } = await supabase
      .from('user_profiles')
      .update({ is_suspended: false, suspended_at: null, suspended_reason: null })
      .eq('id', id)

    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const deleteUser = async (req, res) => {
  try {
    const { id } = req.params
    const { confirm } = req.body

    if (confirm !== 'DELETE') return res.status(400).json({ error: 'Confirmation required' })
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' })

    // Delete in dependency order
    // messages → via conversations
    const { data: convs } = await supabase.from('conversations').select('id').eq('user_id', id)
    const convIds = (convs || []).map(c => c.id)
    if (convIds.length) await supabase.from('messages').delete().in('conversation_id', convIds)

    await Promise.all([
      supabase.from('conversations').delete().eq('user_id', id),
      supabase.from('campaign_leads').delete().eq('user_id', id),
      supabase.from('leads').delete().eq('user_id', id),
      supabase.from('campaign_messages').delete().in('campaign_id',
        (await supabase.from('campaigns').select('id').eq('user_id', id)).data?.map(c => c.id) || []
      ),
      supabase.from('phone_numbers').delete().eq('user_id', id),
      supabase.from('notifications').delete().eq('user_id', id),
      supabase.from('invites').delete().eq('invited_by', id),
    ])

    await supabase.from('campaigns').delete().eq('user_id', id)
    await supabase.from('user_profiles').delete().eq('id', id)
    await supabase.auth.admin.deleteUser(id)

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const getComplianceOverrides = async (req, res) => {
  try {
    const supabase = require('../db')
    const { data, error } = await supabase
      .from('compliance_overrides')
      .select(`
        id, created_at, message_body, lead_state, lead_timezone,
        local_time_at_send, reason,
        user_id,
        user_profiles!compliance_overrides_user_id_fkey (agent_name)
      `)
      .order('created_at', { ascending: false })
      .limit(500)
    if (error) throw error

    const overrides = (data || []).map(r => ({
      ...r,
      agent_name: r.user_profiles?.agent_name || null
    }))

    res.json({ overrides })
  } catch (err) {
    console.error('getComplianceOverrides error:', err.message)
    res.status(500).json({ error: err.message })
  }
}

const getStats = async (req, res) => {
  try {
    const [
      { count: totalUsers },
      { count: activeUsers },
      { count: suspendedUsers },
      { count: totalLeads }
    ] = await Promise.all([
      supabase.from('user_profiles').select('*', { count: 'exact', head: true }),
      supabase.from('user_profiles').select('*', { count: 'exact', head: true }).eq('is_suspended', false),
      supabase.from('user_profiles').select('*', { count: 'exact', head: true }).eq('is_suspended', true),
      supabase.from('leads').select('*', { count: 'exact', head: true })
    ])
    res.json({ totalUsers: totalUsers || 0, active: activeUsers || 0, suspended: suspendedUsers || 0, totalLeads: totalLeads || 0 })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const addUserCredits = async (req, res) => {
  try {
    const { id } = req.params
    const { amount, description, credit_type } = req.body

    const parsed = parseFloat(amount)
    if (!parsed || parsed <= 0) return res.status(400).json({ error: 'Amount must be a positive number' })

    const creditType = credit_type || 'sms'
    if (!['sms', 'ai', 'dnc'].includes(creditType)) {
      return res.status(400).json({ error: 'Invalid credit_type. Must be sms, ai, or dnc.' })
    }

    const newBalance = await addCredits(id, parsed, creditType, description || `Admin top-up by ${req.user.id}`)
    res.json({ success: true, credit_type: creditType, new_balance: newBalance })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const backfillStatuses = async (req, res) => {
  try {
    // Find all lead IDs that have at least one inbound message
    const { data: inboundMessages, error: msgError } = await supabase
      .from('messages')
      .select('conversation_id, conversations(lead_id)')
      .eq('direction', 'inbound')

    if (msgError) throw msgError

    const leadIds = [...new Set(
      (inboundMessages || [])
        .map(m => m.conversations?.lead_id)
        .filter(Boolean)
    )]

    if (!leadIds.length) return res.json({ updated: 0, message: 'No inbound messages found' })

    // Update leads that have status = 'contacted' AND have at least one inbound message
    const { data: updated, error: updateError } = await supabase
      .from('leads')
      .update({ status: 'replied', updated_at: new Date().toISOString() })
      .eq('status', 'contacted')
      .in('id', leadIds)
      .select('id')

    if (updateError) throw updateError

    const count = updated?.length ?? 0
    console.log(`[backfill] Updated ${count} leads from contacted → replied`)
    res.json({ updated: count, message: `Backfilled ${count} leads to status 'replied'` })
  } catch (err) {
    console.error('Backfill error:', err)
    res.status(500).json({ error: err.message })
  }
}

// ── Access Requests ──────────────────────────────────────────
const createAccessRequest = async (req, res) => {
  try {
    const { name, email, notes } = req.body
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' })
    const normalised = email.trim().toLowerCase()
    const cleanName = (name || '').trim()
    const cleanNotes = (notes || '').trim()
    // Silently deduplicate
    const { data: existing, error: dupeError } = await supabase
      .from('access_requests')
      .select('id')
      .eq('email', normalised)
      .maybeSingle()
    if (dupeError) {
      console.error('[access-request] dedup lookup error:', dupeError)
      return res.status(500).json({ error: dupeError.message })
    }
    if (existing) return res.json({ success: true })
    const payload = { email: normalised, status: 'pending' }
    if (cleanName) payload.name = cleanName
    if (cleanNotes) payload.notes = cleanNotes
    const { error } = await supabase
      .from('access_requests')
      .insert([payload])
    if (error) {
      console.error('[access-request] insert error:', error)
      return res.status(500).json({ error: error.message })
    }

    // Fire-and-forget notification emails — never block or fail the request
    sendAccessRequestEmails({ name: cleanName, email: normalised, notes: cleanNotes })
      .catch(err => console.error('[access-request emails]', err.message))

    res.json({ success: true })
  } catch (err) {
    console.error('[access-request] unexpected error:', err)
    res.status(500).json({ error: err.message || 'Failed to save' })
  }
}

const sendAccessRequestEmails = async ({ name, email, notes }) => {
  const { resend, FROM } = require('../utils/email')
  const displayName = name || 'there'
  const displayNotes = notes || 'None provided'
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) + ' ET'

  const confirmationHtml = `
    <div style="font-family:system-ui,-apple-system,sans-serif;background:#08080f;padding:40px 20px;margin:0;">
      <div style="max-width:520px;margin:0 auto;background:#0f0f18;border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;">
        <div style="padding:32px 36px 8px;text-align:center;">
          <div style="display:inline-flex;align-items:center;gap:10px;">
            <div style="width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,#00c9a7,#0ea5e9);display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;">
              <span style="color:#fff;font-weight:700;font-size:16px;letter-spacing:-1px;">&rsaquo;&rsaquo;&rsaquo;</span>
            </div>
            <span style="font-size:22px;font-weight:700;letter-spacing:-0.5px;color:#fff;vertical-align:middle;"><span style="color:#00d4b4;">Velox</span>o</span>
          </div>
        </div>
        <div style="padding:24px 36px 36px;color:rgba(255,255,255,0.75);font-size:15px;line-height:1.65;">
          <h1 style="font-size:22px;font-weight:700;letter-spacing:-0.3px;color:#fff;margin:0 0 18px;">You're on the list</h1>
          <p style="margin:0 0 14px;">Hi ${displayName},</p>
          <p style="margin:0 0 14px;">Thanks for your interest in Veloxo. We've received your request and you're on our early access list.</p>
          <p style="margin:0 0 14px;">We're onboarding agents carefully to make sure every user gets the best experience. We'll reach out to <strong style="color:#34d8b8;">${email}</strong> as soon as a spot opens up.</p>
          <p style="margin:0 0 18px;">In the meantime, if you have questions you can reach us at <a href="mailto:support@veloxo.io" style="color:#34d8b8;text-decoration:none;">support@veloxo.io</a>.</p>
          <p style="margin:0;color:rgba(255,255,255,0.55);">— The Veloxo Team</p>
        </div>
        <div style="padding:16px 36px;border-top:1px solid rgba(255,255,255,0.06);text-align:center;font-size:12px;color:rgba(255,255,255,0.35);">
          <a href="https://veloxo.io" style="color:rgba(255,255,255,0.55);text-decoration:none;">veloxo.io</a>
          &nbsp;&middot;&nbsp;
          <a href="mailto:support@veloxo.io" style="color:rgba(255,255,255,0.55);text-decoration:none;">support@veloxo.io</a>
        </div>
      </div>
    </div>
  `

  const adminHtml = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111;">
      <h2 style="margin:0 0 16px;font-size:18px;">New access request received.</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:8px 0;color:#666;width:80px;">Name:</td><td style="padding:8px 0;font-weight:500;">${displayName}</td></tr>
        <tr><td style="padding:8px 0;color:#666;">Email:</td><td style="padding:8px 0;font-weight:500;">${email}</td></tr>
        <tr><td style="padding:8px 0;color:#666;vertical-align:top;">Notes:</td><td style="padding:8px 0;white-space:pre-wrap;">${displayNotes}</td></tr>
        <tr><td style="padding:8px 0;color:#666;">Time:</td><td style="padding:8px 0;">${timestamp}</td></tr>
      </table>
      <p style="margin:20px 0 0;font-size:14px;">
        Review and invite at:<br>
        <a href="https://app.veloxo.io/admin.html" style="color:#0ea5e9;">https://app.veloxo.io/admin.html</a>
      </p>
    </div>
  `

  const applicantPromise = resend.emails.send({
    from: FROM.invites,
    to: email,
    subject: "You're on the list — Veloxo Early Access",
    html: confirmationHtml
  }).catch(err => console.error('[access-request confirmation email]', err.message))

  const adminPromise = resend.emails.send({
    from: FROM.noreply,
    to: process.env.ADMIN_EMAIL || 'nick@veloxo.io',
    subject: `New Access Request — ${displayName} (${email})`,
    html: adminHtml
  }).catch(err => console.error('[access-request admin email]', err.message))

  await Promise.all([applicantPromise, adminPromise])
}

const getAccessRequests = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('access_requests')
      .select('id, email, status, requested_at, notes, invited_at')
      .order('requested_at', { ascending: false })
    if (error) throw error
    res.json({ requests: data || [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const inviteFromAccessRequest = async (req, res) => {
  try {
    const { id } = req.params
    const { data: ar, error: fetchErr } = await supabase
      .from('access_requests')
      .select('id, email, status')
      .eq('id', id)
      .single()
    if (fetchErr || !ar) return res.status(404).json({ error: 'Request not found' })

    // Reuse inviteAgent handler with a synthetic req/res
    const { inviteAgent } = require('./authController')
    const mockRes = { _status: 200, _data: null }
    mockRes.status = (code) => { mockRes._status = code; return mockRes }
    mockRes.json = (data) => { mockRes._data = data; return mockRes }
    await inviteAgent({ ...req, body: { email: ar.email } }, mockRes)
    if (mockRes._status !== 200 || !mockRes._data?.success) {
      return res.status(mockRes._status || 500).json({ error: mockRes._data?.error || 'Invite failed' })
    }

    const now = new Date().toISOString()
    await supabase
      .from('access_requests')
      .update({ status: 'invited', invited_at: now })
      .eq('id', id)

    res.json({ success: true, email: ar.email })
  } catch (err) {
    console.error('inviteFromAccessRequest error:', err.message)
    res.status(500).json({ error: err.message })
  }
}

const declineAccessRequest = async (req, res) => {
  try {
    const { id } = req.params
    const { error } = await supabase
      .from('access_requests')
      .update({ status: 'declined' })
      .eq('id', id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const getComplianceLogs = async (req, res) => {
  try {
    const { user_id, event_type, date_from, date_to } = req.query
    let query = supabase.from('compliance_log').select('*').order('created_at', { ascending: false }).limit(500)
    if (user_id) query = query.eq('user_id', user_id)
    if (event_type) query = query.eq('event_type', event_type)
    if (date_from) query = query.gte('created_at', date_from)
    if (date_to) query = query.lte('created_at', date_to + 'T23:59:59Z')
    const { data, error } = await query
    if (error) throw error
    res.json({ logs: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

module.exports = { getUsers, getStats, suspendUser, unsuspendUser, deleteUser, getComplianceOverrides, addUserCredits, backfillStatuses, createAccessRequest, getAccessRequests, inviteFromAccessRequest, declineAccessRequest, getComplianceLogs }
