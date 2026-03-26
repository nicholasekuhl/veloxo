const supabase = require('../db')

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

    const [{ data: profiles }, { data: leadCounts }, { data: msgCounts }] = await Promise.all([
      supabase
        .from('user_profiles')
        .select('id, agent_name, agency_name, created_at, is_suspended, suspended_at, suspended_reason, is_admin')
        .in('id', userIds),
      supabase.from('leads').select('user_id').in('user_id', userIds),
      supabase.from('messages')
        .select('conversation_id, conversations(user_id)')
        .eq('direction', 'outbound')
        .gte('sent_at', monthStart.toISOString())
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

    const users = authUsers
      .map(au => {
        const profile = profileMap[au.id] || {}
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
          message_count_this_month: msgCountMap[au.id] || 0
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

module.exports = { getUsers, suspendUser, unsuspendUser, deleteUser, getComplianceOverrides }
