const supabase = require('../db')

const getPhoneNumbers = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('phone_numbers')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: true })
    if (error) throw error
    res.json({ phone_numbers: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const addPhoneNumber = async (req, res) => {
  try {
    const { phone_number, friendly_name, twilio_account_sid, twilio_auth_token, state } = req.body
    if (!phone_number) return res.status(400).json({ error: 'Phone number is required' })
    if (!twilio_account_sid) return res.status(400).json({ error: 'Twilio Account SID is required' })
    if (!twilio_auth_token) return res.status(400).json({ error: 'Twilio Auth Token is required' })

    const { data, error } = await supabase
      .from('phone_numbers')
      .insert({ phone_number, friendly_name, twilio_account_sid, twilio_auth_token, state, user_id: req.user.id })
      .select()
      .single()
    if (error) throw error
    res.json({ success: true, phone_number: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const updatePhoneNumber = async (req, res) => {
  try {
    const { friendly_name, state, is_active } = req.body
    const updates = {}
    if (friendly_name !== undefined) updates.friendly_name = friendly_name
    if (state !== undefined) updates.state = state
    if (is_active !== undefined) updates.is_active = is_active

    const { data, error } = await supabase
      .from('phone_numbers')
      .update(updates)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single()
    if (error) throw error
    res.json({ success: true, phone_number: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const deletePhoneNumber = async (req, res) => {
  try {
    const { error } = await supabase
      .from('phone_numbers')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

module.exports = { getPhoneNumbers, addPhoneNumber, updatePhoneNumber, deletePhoneNumber }
