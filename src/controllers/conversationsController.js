const supabase = require('../db')

const getConversations = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select(`
        *,
        messages (id, direction, body, sent_at, is_ai)
      `)
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false })
    if (error) throw error
    res.json({ conversations: data })
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
        messages (id, direction, body, sent_at, is_ai)
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
    const allowed = ['needs_agent_review', 'handoff_reason', 'status']
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

module.exports = { getConversations, getConversation, updateConversation }
