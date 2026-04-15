const supabase = require('../db')
const { executeActions } = require('./actionsController')

const getDispositionTags = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('disposition_tags')
      .select(`
        *,
        disposition_messages (id, day_number, send_time, message_body),
        disposition_actions (id, action_type, action_value, action_order)
      `)
      .eq('user_id', req.user.id)
      .order('sort_order', { ascending: true })
    if (error) throw error
    res.json({ tags: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const createDispositionTag = async (req, res) => {
  try {
    const { name, color, description, messages, actions } = req.body
    if (!name) return res.status(400).json({ error: 'Tag name is required' })

    const { data: tag, error: tagError } = await supabase
      .from('disposition_tags')
      .insert({ name, color: color || '#6366f1', description, user_id: req.user.id })
      .select()
      .single()
    if (tagError) throw tagError

    if (messages && messages.length > 0) {
      const messageRows = messages.map(m => ({
        disposition_tag_id: tag.id,
        day_number: m.day_number,
        send_time: m.send_time || '10:00',
        message_body: m.message_body
      }))
      const { error: msgError } = await supabase.from('disposition_messages').insert(messageRows)
      if (msgError) throw msgError
    }

    if (actions && actions.length > 0) {
      const actionRows = actions.map((a, i) => ({
        disposition_tag_id: tag.id,
        action_type: a.action_type,
        action_value: a.action_value || {},
        action_order: i
      }))
      const { error: actError } = await supabase.from('disposition_actions').insert(actionRows)
      if (actError) throw actError
    }

    res.json({ success: true, tag })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const updateDispositionTag = async (req, res) => {
  try {
    const { name, color, description, messages, actions } = req.body

    const { data: tag, error: tagError } = await supabase
      .from('disposition_tags')
      .update({ name, color, description })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single()
    if (tagError) throw tagError

    if (messages !== undefined) {
      await supabase.from('disposition_messages').delete().eq('disposition_tag_id', req.params.id)
      if (messages.length > 0) {
        const messageRows = messages.map(m => ({
          disposition_tag_id: tag.id,
          day_number: m.day_number,
          send_time: m.send_time || '10:00',
          message_body: m.message_body
        }))
        const { error: msgError } = await supabase.from('disposition_messages').insert(messageRows)
        if (msgError) throw msgError
      }
    }

    if (actions !== undefined) {
      await supabase.from('disposition_actions').delete().eq('disposition_tag_id', req.params.id)
      if (actions.length > 0) {
        const actionRows = actions.map((a, i) => ({
          disposition_tag_id: tag.id,
          action_type: a.action_type,
          action_value: a.action_value || {},
          action_order: i
        }))
        const { error: actError } = await supabase.from('disposition_actions').insert(actionRows)
        if (actError) throw actError
      }
    }

    res.json({ success: true, tag })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const deleteDispositionTag = async (req, res) => {
  try {
    const { error } = await supabase.from('disposition_tags')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const calculateSendTime = (dayNumber, sendTime, startDate, timezone) => {
  try {
    const [hours, minutes] = sendTime.split(':').map(Number)
    const base = new Date(startDate)
    base.setDate(base.getDate() + (dayNumber - 1))
    const year = base.getFullYear()
    const month = String(base.getMonth() + 1).padStart(2, '0')
    const day = String(base.getDate()).padStart(2, '0')
    const h = String(hours).padStart(2, '0')
    const m = String(minutes).padStart(2, '0')
    const localStr = `${year}-${month}-${day}T${h}:${m}:00`
    const utcDate = new Date(new Date(localStr).toLocaleString('en-US', { timeZone: 'UTC' }))
    const tzDate = new Date(new Date(localStr).toLocaleString('en-US', { timeZone: timezone }))
    const offset = utcDate - tzDate
    return new Date(new Date(localStr).getTime() + offset).toISOString()
  } catch {
    const fallback = new Date(startDate)
    fallback.setDate(fallback.getDate() + (dayNumber - 1))
    fallback.setHours(10, 0, 0, 0)
    return fallback.toISOString()
  }
}

const applyDisposition = async (req, res) => {
  try {
    const { lead_id, disposition_tag_id, notes } = req.body
    if (!lead_id || !disposition_tag_id) {
      return res.status(400).json({ error: 'lead_id and disposition_tag_id are required' })
    }

    const { data: tag, error: tagError } = await supabase
      .from('disposition_tags')
      .select(`*, disposition_messages (*), disposition_actions (*)`)
      .eq('id', disposition_tag_id)
      .eq('user_id', req.user.id)
      .single()
    if (tagError) throw tagError

    const { data: lead, error: leadError } = await supabase
      .from('leads').select('*').eq('id', lead_id).eq('user_id', req.user.id).single()
    if (leadError) throw leadError

    await supabase.from('campaign_leads')
      .update({ status: 'paused', paused_at: new Date().toISOString() })
      .eq('lead_id', lead_id)
      .eq('status', 'pending')

    await supabase.from('leads').update({
      disposition_tag_id,
      disposition_color: tag.color,
      updated_at: new Date().toISOString()
    }).eq('id', lead_id)

    await supabase.from('lead_dispositions').insert({
      lead_id,
      disposition_tag_id,
      notes,
      applied_at: new Date().toISOString()
    })

    if (tag.disposition_messages && tag.disposition_messages.length > 0) {
      const leadTimezone = lead.timezone || 'America/New_York'
      const now = new Date().toISOString()
      const enrollments = tag.disposition_messages.map(msg => ({
        campaign_id: null,
        lead_id,
        status: 'pending',
        current_step: 0,
        start_date: now,
        next_send_at: calculateSendTime(msg.day_number, msg.send_time || '10:00', now, leadTimezone),
        disposition_tag_id,
        user_id: req.user.id
      }))
      await supabase.from('campaign_leads').insert(enrollments)
    }

    if (tag.disposition_actions && tag.disposition_actions.length > 0) {
      const freshLead = (await supabase.from('leads').select('*').eq('id', lead_id).single()).data
      await executeActions(freshLead || lead, tag.disposition_actions, disposition_tag_id, req.user.profile)
    }

    res.json({ success: true, tag })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const applyMultiDisposition = async (req, res) => {
  try {
    const { lead_id, tag_ids, notes } = req.body
    if (!lead_id) return res.status(400).json({ error: 'lead_id is required' })
    const ids = Array.isArray(tag_ids) ? tag_ids : []

    const { data: lead, error: leadError } = await supabase
      .from('leads').select('*').eq('id', lead_id).eq('user_id', req.user.id).single()
    if (leadError) throw leadError

    // Verify all tags belong to this user
    let tags = []
    if (ids.length > 0) {
      const { data: tagData } = await supabase
        .from('disposition_tags').select('*').eq('user_id', req.user.id).in('id', ids)
      tags = tagData || []
    }

    const now = new Date().toISOString()

    // Replace all dispositions for this lead
    await supabase.from('lead_dispositions').delete().eq('lead_id', lead_id)
    if (tags.length > 0) {
      await supabase.from('lead_dispositions').insert(
        tags.map(t => ({ lead_id, disposition_tag_id: t.id, user_id: req.user.id, applied_at: now, notes: notes || null }))
      )
    }

    // Keep leads.disposition_tag_id as first tag for backward compat
    await supabase.from('leads').update({
      disposition_tag_id: tags[0]?.id || null,
      disposition_color: tags[0]?.color || null,
      updated_at: now
    }).eq('id', lead_id)

    // Pause active campaign drips on disposition
    if (tags.length > 0) {
      await supabase.from('campaign_leads')
        .update({ status: 'paused', paused_at: now })
        .eq('lead_id', lead_id).eq('status', 'pending')
    }

    res.json({ success: true, tags })
  } catch (err) {
    console.error('applyMultiDisposition error:', err)
    res.status(500).json({ error: err.message })
  }
}

const getLeadDispositionHistory = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('lead_dispositions')
      .select(`*, disposition_tags (name, color)`)
      .eq('lead_id', req.params.leadId)
      .order('applied_at', { ascending: false })
    if (error) throw error
    res.json({ history: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const reorderDispositionTags = async (req, res) => {
  try {
    const { order } = req.body
    if (!order || !Array.isArray(order)) return res.status(400).json({ error: 'Invalid order data' })
    await Promise.all(
      order.map(({ id, sort_order }) =>
        supabase.from('disposition_tags').update({ sort_order }).eq('id', id).eq('user_id', req.user.id)
      )
    )
    res.json({ success: true })
  } catch (err) {
    console.error('Disposition reorder error:', err)
    res.status(500).json({ error: err.message })
  }
}

module.exports = {
  getDispositionTags,
  createDispositionTag,
  updateDispositionTag,
  deleteDispositionTag,
  applyDisposition,
  applyMultiDisposition,
  getLeadDispositionHistory,
  reorderDispositionTags
}
