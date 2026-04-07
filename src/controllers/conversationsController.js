const supabase = require('../db')

const getConversations = async (req, res) => {
  try {
    const { filter = 'all', show_blocked = 'false' } = req.query
    const showBlocked = show_blocked === 'true'

    const page = parseInt(req.query.page) || 1
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const offset = (page - 1) * limit

    let query = supabase
      .from('conversations')
      .select(`
        *, from_number,
        leads (id, first_name, last_name, phone, status, timezone, autopilot, disposition_tag_id, notes, email, state, zip_code, date_of_birth, product, address, bucket_id, is_blocked, is_cold, created_at)
      `, { count: 'exact' })
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false })

    if (req.query.lead_id) query = query.eq('lead_id', req.query.lead_id)

    query = query.range(offset, offset + limit - 1)

    const { data, error, count } = await query
    if (error) throw error

    let conversations = data || []

    if (!showBlocked) {
      conversations = conversations.filter(c => !c.leads?.is_blocked)
    }

    // Fetch only the last message per conversation
    // .limit() prevents a full table scan when message count is large
    if (conversations.length > 0) {
      const convIds = conversations.map(c => c.id)
      const { data: lastMsgs } = await supabase
        .from('messages')
        .select('conversation_id, body, direction, sent_at, is_ai')
        .in('conversation_id', convIds)
        .order('sent_at', { ascending: false })
        .limit(convIds.length * 5) // cap — we only need the most recent 1 per convo

      const lastMsgMap = {}
      for (const m of lastMsgs || []) {
        if (!lastMsgMap[m.conversation_id]) lastMsgMap[m.conversation_id] = m
      }
      conversations = conversations.map(c => ({ ...c, last_message: lastMsgMap[c.id] || null }))
    }

    const now = new Date()
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()

    if (filter === 'unread') {
      conversations = conversations.filter(c => (c.unread_count || 0) > 0)
    } else if (filter === 'starred') {
      conversations = conversations.filter(c => c.is_starred)
    } else if (filter === 'recent') {
      conversations = conversations.filter(c => c.updated_at >= sevenDaysAgo)
    }

    res.json({ conversations, total: count, page, limit })
  } catch (err) {
    console.error('Conversations getConversations error:', err.message)
    res.status(500).json({ error: err.message })
  }
}

const getConversation = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select(`
        *,
        messages (id, direction, body, sent_at, is_ai, status, error_message),
        leads (id, first_name, last_name, phone, status, timezone, autopilot, disposition_tag_id, notes, email, state, zip_code, date_of_birth, product, address, bucket_id, is_blocked, is_cold, created_at)
      `)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single()
    if (error) {
      console.error('Messages fetch error:', error.message)
      throw error
    }
    res.json({ conversation: data })
  } catch (err) {
    console.error('Conversations getConversation error:', err.message)
    res.status(500).json({ error: err.message })
  }
}

const updateConversation = async (req, res) => {
  try {
    const allowed = ['needs_agent_review', 'handoff_reason', 'status', 'is_starred', 'engagement_status', 'followup_stage', 'followup_count']
    const updates = { updated_at: new Date().toISOString() }
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k] })

    const { data, error } = await supabase
      .from('conversations')
      .update(updates)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single()
    if (error) throw error
    res.json({ success: true, conversation: data })
  } catch (err) {
    console.error('Conversations updateConversation error:', err.message)
    res.status(500).json({ error: err.message })
  }
}

const starConversation = async (req, res) => {
  try {
    const { data: current, error: fetchErr } = await supabase
      .from('conversations')
      .select('is_starred')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single()
    if (fetchErr) throw fetchErr

    const newVal = !current.is_starred
    const { data, error } = await supabase
      .from('conversations')
      .update({ is_starred: newVal })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single()
    if (error) throw error
    res.json({ success: true, is_starred: newVal, conversation: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const getScheduledMessages = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('scheduled_messages')
      .select('*')
      .eq('conversation_id', req.params.id)
      .eq('user_id', req.user.id)
      .eq('status', 'pending')
      .order('send_at', { ascending: true })
    if (error) throw error
    res.json({ scheduled_messages: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const createScheduledMessage = async (req, res) => {
  try {
    const { body, send_at, lead_id } = req.body
    if (!body || !send_at) return res.status(400).json({ error: 'body and send_at are required' })

    const { data, error } = await supabase
      .from('scheduled_messages')
      .insert({
        user_id: req.user.id,
        lead_id,
        conversation_id: req.params.id,
        body,
        send_at
      })
      .select()
      .single()
    if (error) throw error
    res.json({ success: true, scheduled_message: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const markConversationRead = async (req, res) => {
  try {
    const { error } = await supabase
      .from('conversations')
      .update({ unread_count: 0, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    console.error('markConversationRead error:', err.message)
    res.status(500).json({ error: err.message })
  }
}

const getConversationMessages = async (req, res) => {
  try {
    const { data: conv, error: convErr } = await supabase
      .from('conversations').select('id').eq('id', req.params.id).eq('user_id', req.user.id).single()
    if (convErr || !conv) return res.status(404).json({ error: 'Conversation not found' })
    const { data, error } = await supabase
      .from('messages')
      .select('id, body, direction, status, sent_at, twilio_sid, is_ai, error_message')
      .eq('conversation_id', req.params.id)
      .order('sent_at', { ascending: true })
    if (error) {
      console.error('getConversationMessages fetch error:', error.message)
      throw error
    }
    res.json({ messages: data || [] })
  } catch (err) {
    console.error('getConversationMessages error:', err.message)
    res.status(500).json({ error: err.message })
  }
}

const deleteConversation = async (req, res) => {
  try {
    const { data: conv, error: fetchErr } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single()
    if (fetchErr || !conv) return res.status(404).json({ error: 'Conversation not found' })

    await supabase.from('messages').delete().eq('conversation_id', req.params.id)
    await supabase.from('conversations').delete().eq('id', req.params.id)

    res.json({ success: true })
  } catch (err) {
    console.error('deleteConversation error:', err.message)
    res.status(500).json({ error: err.message })
  }
}

const searchConversations = async (req, res) => {
  try {
    const q = (req.query.q || '').trim()
    if (!q) return res.json({ conversations: [] })

    const { data: leads, error: leadsErr } = await supabase
      .from('leads')
      .select('id')
      .eq('user_id', req.user.id)
      .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,phone.ilike.%${q}%`)

    if (leadsErr) throw leadsErr

    const leadIds = (leads || []).map(l => l.id)
    if (!leadIds.length) return res.json({ conversations: [] })

    const { data, error } = await supabase
      .from('conversations')
      .select(`
        *, from_number,
        leads (id, first_name, last_name, phone, status, timezone, autopilot, disposition_tag_id, notes, email, state, zip_code, date_of_birth, product, address, bucket_id, is_blocked, is_cold, created_at)
      `)
      .eq('user_id', req.user.id)
      .in('lead_id', leadIds)
      .order('updated_at', { ascending: false })
      .limit(50)

    if (error) throw error

    const conversations = data || []
    if (conversations.length > 0) {
      const convIds = conversations.map(c => c.id)
      const { data: lastMsgs } = await supabase
        .from('messages')
        .select('conversation_id, body, direction, sent_at, is_ai')
        .in('conversation_id', convIds)
        .order('sent_at', { ascending: false })
        .limit(convIds.length * 5)

      const lastMsgMap = {}
      for (const m of lastMsgs || []) {
        if (!lastMsgMap[m.conversation_id]) lastMsgMap[m.conversation_id] = m
      }
      conversations.forEach(c => { c.last_message = lastMsgMap[c.id] || null })
    }

    res.json({ conversations })
  } catch (err) {
    console.error('searchConversations error:', err.message)
    res.status(500).json({ error: err.message })
  }
}

module.exports = {
  getConversations,
  getConversation,
  updateConversation,
  starConversation,
  getScheduledMessages,
  createScheduledMessage,
  getConversationMessages,
  markConversationRead,
  deleteConversation,
  searchConversations
}
