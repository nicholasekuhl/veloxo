const supabase = require('../db')

const getAppointments = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('appointments')
      .select('*, leads(first_name, last_name, phone, state)')
      .eq('user_id', req.user.id)
      .order('scheduled_at', { ascending: true })
    if (error) throw error
    res.json({ appointments: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const getTodayAppointments = async (req, res) => {
  try {
    const tz = req.user.profile.timezone || 'America/New_York'
    const now = new Date()
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: tz })
    const startOfDay = new Date(`${todayStr}T00:00:00`)
    const endOfDay = new Date(`${todayStr}T23:59:59`)

    const { data, error } = await supabase
      .from('appointments')
      .select('*, leads(first_name, last_name, phone, state)')
      .eq('user_id', req.user.id)
      .gte('scheduled_at', startOfDay.toISOString())
      .lte('scheduled_at', endOfDay.toISOString())
      .order('scheduled_at', { ascending: true })
    if (error) throw error
    res.json({ appointments: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const createAppointment = async (req, res) => {
  try {
    const { lead_id, scheduled_at, duration_minutes, title, notes } = req.body
    if (!lead_id) return res.status(400).json({ error: 'lead_id is required' })
    if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at is required' })

    const { data: lead } = await supabase.from('leads').select('first_name, last_name, phone').eq('id', lead_id).single()

    const { data, error } = await supabase
      .from('appointments')
      .insert({
        user_id: req.user.id,
        lead_id,
        scheduled_at,
        duration_minutes: duration_minutes || 15,
        title: title || `Call with ${lead?.first_name || ''} ${lead?.last_name || ''}`.trim(),
        notes,
        status: 'scheduled',
        lead_name: `${lead?.first_name || ''} ${lead?.last_name || ''}`.trim(),
        lead_phone: lead?.phone
      })
      .select()
      .single()
    if (error) throw error

    // Upgrade lead status to booked (never downgrade from sold)
    if (data && lead_id) {
      const { data: leadRow } = await supabase.from('leads').select('status').eq('id', lead_id).single()
      const STATUS_PRIORITY = { new: 0, contacted: 1, replied: 2, booked: 3, sold: 4 }
      if (leadRow && (STATUS_PRIORITY[leadRow.status] ?? 0) < STATUS_PRIORITY.booked) {
        await supabase.from('leads').update({ status: 'booked', updated_at: new Date().toISOString() }).eq('id', lead_id)
      }
    }

    res.json({ success: true, appointment: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const updateAppointment = async (req, res) => {
  try {
    const { status, notes, scheduled_at, duration_minutes, title } = req.body
    const updates = { updated_at: new Date().toISOString() }
    if (status !== undefined) updates.status = status
    if (notes !== undefined) updates.notes = notes
    if (scheduled_at !== undefined) updates.scheduled_at = scheduled_at
    if (duration_minutes !== undefined) updates.duration_minutes = duration_minutes
    if (title !== undefined) updates.title = title

    const { data, error } = await supabase
      .from('appointments')
      .update(updates)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single()
    if (error) throw error
    res.json({ success: true, appointment: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const deleteAppointment = async (req, res) => {
  try {
    const { error } = await supabase
      .from('appointments')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const getLeadAppointments = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('appointments')
      .select('*')
      .eq('lead_id', req.params.leadId)
      .eq('user_id', req.user.id)
      .order('scheduled_at', { ascending: false })
    if (error) throw error
    res.json({ appointments: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

module.exports = { getAppointments, getTodayAppointments, createAppointment, updateAppointment, deleteAppointment, getLeadAppointments }
