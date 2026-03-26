const supabase = require('../db')
const { getMasterClient } = require('../twilio')

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
    const params = { limit: 10, smsEnabled: true }
    if (area_code) params.areaCode = area_code
    else params.inRegion = state

    console.log('Searching with params:', params)
    const numbers = await client.availablePhoneNumbers('US').local.list(params)
    console.log('Twilio returned:', numbers.length, 'numbers')

    if (numbers.length === 0) {
      const fallback = await client.availablePhoneNumbers('US').local.list({ limit: 5 })
      console.log('Fallback (no filter) returned:', fallback.length, 'numbers')
    }

    res.json({
      numbers: numbers.map(n => ({
        phone_number: n.phoneNumber,
        locality: n.locality,
        region: n.region,
        postal_code: n.postalCode
      }))
    })
  } catch (err) {
    console.log('Twilio error:', err)
    res.status(500).json({ error: err.message, code: err.code, status: err.status })
  }
}

const purchasePhoneNumber = async (req, res) => {
  try {
    const { phone_number, friendly_name, state } = req.body
    if (!phone_number) return res.status(400).json({ error: 'Phone number is required' })

    const client = getMasterClient()
    const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`

    const agentName = req.user.profile?.agent_name
    const twilioFriendlyName = agentName && state
      ? `${agentName} - ${state}`
      : agentName || state || phone_number

    const purchased = await client.incomingPhoneNumbers.create({
      phoneNumber: phone_number,
      friendlyName: twilioFriendlyName,
      smsUrl: `${appUrl}/messages/incoming`,
      smsMethod: 'POST'
    })

    const { data, error } = await supabase
      .from('phone_numbers')
      .insert({
        user_id: req.user.id,
        phone_number: purchased.phoneNumber,
        friendly_name: friendly_name || twilioFriendlyName,
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

const setDefaultPhoneNumber = async (req, res) => {
  try {
    // Unset default on all other numbers for this user
    await supabase
      .from('phone_numbers')
      .update({ is_default: false })
      .eq('user_id', req.user.id)

    // Set this number as default
    const { data, error } = await supabase
      .from('phone_numbers')
      .update({ is_default: true })
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

const getPhoneNumberHealth = async (req, res) => {
  try {
    const force = req.query.force === 'true'
    const userId = req.user.id

    const { data: phoneNumbers, error: pnError } = await supabase
      .from('phone_numbers').select('phone_number').eq('user_id', userId)
    if (pnError) throw pnError
    if (!phoneNumbers || !phoneNumbers.length) return res.json({ health: [] })

    if (!force) {
      const { data: cached } = await supabase
        .from('phone_number_health').select('*').eq('user_id', userId)
      if (cached && cached.length >= phoneNumbers.length) {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000
        if (cached.every(c => new Date(c.last_checked).getTime() > cutoff))
          return res.json({ health: cached })
      }
    }

    const client = getMasterClient()
    const VIOLATION_CODES = new Set([30007, 30008, 21610, 30034])
    const OPT_OUT_TERMS = ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']
    const now = new Date().toISOString()
    const results = []

    for (const { phone_number } of phoneNumbers) {
      let violation_count = 0, delivery_rate = 100, opt_out_count = 0
      try {
        const [outbound, inbound] = await Promise.all([
          client.messages.list({ from: phone_number, limit: 1000 }),
          client.messages.list({ to: phone_number, limit: 1000 })
        ])
        const total = outbound.length
        const delivered = outbound.filter(m => m.status === 'delivered').length
        violation_count = outbound.filter(m => m.errorCode && VIOLATION_CODES.has(parseInt(m.errorCode))).length
        delivery_rate = total > 0 ? parseFloat(((delivered / total) * 100).toFixed(2)) : 100
        opt_out_count = inbound.filter(m =>
          OPT_OUT_TERMS.some(t => (m.body || '').toUpperCase().trim().startsWith(t))
        ).length
      } catch (e) {
        console.error(`Health fetch error for ${phone_number}:`, e.message)
      }

      let health_status = 'good'
      if (violation_count > 50 || delivery_rate < 75) health_status = 'critical'
      else if (violation_count >= 20 || delivery_rate < 90) health_status = 'warning'

      const record = { phone_number, violation_count, opt_out_count, delivery_rate, health_status, last_checked: now }
      results.push(record)
      await supabase.from('phone_number_health')
        .upsert({ user_id: userId, ...record }, { onConflict: 'user_id,phone_number' })
    }

    res.json({ health: results })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const updatePhoneNumberState = async (req, res) => {
  try {
    const { state } = req.body
    const { error } = await supabase
      .from('phone_numbers')
      .update({ state: state || null, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    console.error('updatePhoneNumberState error:', err.message)
    res.status(500).json({ error: err.message })
  }
}

module.exports = { getPhoneNumbers, searchPhoneNumbers, purchasePhoneNumber, updatePhoneNumber, deletePhoneNumber, setDefaultPhoneNumber, getPhoneNumberHealth, updatePhoneNumberState }
