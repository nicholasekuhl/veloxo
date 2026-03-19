const supabase = require('./db')

const createNotification = async (userId, type, title, body, leadId, conversationId) => {
  try {
    await supabase.from('notifications').insert({
      user_id: userId,
      type,
      title,
      body,
      lead_id: leadId || null,
      conversation_id: conversationId || null
    })
  } catch (err) {
    console.error('createNotification error:', err.message)
  }
}

const getNotifications = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(30)
    if (error) throw error
    const unread_count = (data || []).filter(n => !n.is_read).length
    res.json({ notifications: data || [], unread_count })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const getUnreadCount = async (req, res) => {
  try {
    const { count, error } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .eq('is_read', false)
    if (error) throw error
    res.json({ count: count || 0 })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const markAllRead = async (req, res) => {
  try {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', req.user.id)
      .eq('is_read', false)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const markOneRead = async (req, res) => {
  try {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

module.exports = { createNotification, getNotifications, getUnreadCount, markAllRead, markOneRead }
