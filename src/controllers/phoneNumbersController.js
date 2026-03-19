const supabase = require('../db')
const { getTwilioClient } = require('../twilio')

const getMasterClient = () => {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) throw new Error('Master Twilio credentials not configured')
  return getTwilioClient(sid, token)
}

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

const searchPhoneNumbers = async (req, res) => {
  try {
    const { state, area_code } = req.query
    if (!state && !area_code) return res.status(400).json({ error: 'Provide state or area_code' })

    const client = getMasterClient()
    const params = { limit: 10, smsEnabled: true, voiceEnabled: false }
    if (area_code) params.areaCode = area_code
    else params.inRegion = state

    const numbers = await client.availablePhoneNumbers('US').local.list(params)
    res.json({
      numbers: numbers.map(n => ({
        phone_number: n.phoneNumber,
        locality: n.locality,
        region: n.region,
        postal_code: n.postalCode
      }))
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const purchasePhoneNumber = async (req, res) => {
  try {
    const { phone_number, friendly_name, state } = req.body
    if (!phone_number) return res.status(400).json({ error: 'Phone number is required' })

    const client = getMasterClient()
    const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`

    const purchased = await client.incomingPhoneNumbers.create({
      phoneNumber: phone_number,
      friendlyName: friendly_name || phone_number,
      smsUrl: `${appUrl}/messages/incoming`,
      smsMethod: 'POST'
    })

    const { data, error } = await supabase
      .from('phone_numbers')
      .insert({
        user_id: req.user.id,
        phone_number: purchased.phoneNumber,
        friendly_name: friendly_name || purchased.friendlyName,
        twilio_account_sid: process.env.TWILIO_ACCOUNT_SID,
        twilio_auth_token: process.env.TWILIO_AUTH_TOKEN,
        state: state || null,
        is_active: true
      })
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
    const { data: record, error: fetchError } = await supabase
      .from('phone_numbers')
      .select('phone_number')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single()
    if (fetchError || !record) return res.status(404).json({ error: 'Number not found' })

    try {
      const client = getMasterClient()
      const existing = await client.incomingPhoneNumbers.list({ phoneNumber: record.phone_number })
      if (existing[0]) await client.incomingPhoneNumbers(existing[0].sid).remove()
    } catch (twilioErr) {
      console.error('Twilio release failed:', twilioErr.message)
    }

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

module.exports = { getPhoneNumbers, searchPhoneNumbers, purchasePhoneNumber, updatePhoneNumber, deletePhoneNumber }
