const supabase = require('../db')

const getConversations = async (req, res) => {
  try {
    const { filter = 'all', show_blocked = 'false' } = req.query
    const showBlocked = show_blocked === 'true'

    const { data, error } = await supabase
      .from('conversations')
      .select(`
        *,
        messages (id, direction, body, sent_at, is_ai, status, error_message),
        leads (id, first_name, last_name, phone, status, timezone, autopilot, disposition_tag_id, notes, email, state, zip, date_of_birth, product, address, bucket, is_blocked, is_cold, created_at, source)
      `)
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false })
    if (error) throw error

    let conversations = data || []

    if (!showBlocked) {
      conversations = conversations.filter(c => !c.leads?.is_blocked)
    }

    const now = new Date()
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()

    if (filter === 'unread') {
      // Unread = last message is inbound (agent hasn't responded)
      conversations = conversations.filter(c => {
        const msgs = c.messages || []
        if (!msgs.length) return false
        const last = msgs[msgs.length - 1]
        return last.direction === 'inbound'
      })
    } else if (filter === 'starred') {
      conversations = conversations.filter(c => c.is_starred)
    } else if (filter === 'recent') {
      conversations = conversations.filter(c => c.updated_at >= sevenDaysAgo)
    }

    res.json({ conversations })
  } catch (err) {
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
        leads (id, first_name, last_name, phone, status, timezone, autopilot, disposition_tag_id, notes, email, state, zip, date_of_birth, product, address, bucket, is_blocked, is_cold, created_at, source)
      `)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single()
    if (error) throw error
    res.json({ conversation: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const updateConversation = async (req, res) => {
  try {
    const allowed = ['needs_agent_review', 'handoff_reason', 'status', 'is_starred']
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

module.exports = {
  getConversations,
  getConversation,
  updateConversation,
  starConversation,
  getScheduledMessages,
  createScheduledMessage
}
