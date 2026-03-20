const supabase = require('../db')

const getCampaigns = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('campaigns')
      .select(`
        *,
        campaign_messages (id, day_number, send_time, message_body),
        campaign_leads (id, status, leads(has_replied))
      `)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
    if (error) throw error
    res.json({ campaigns: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const getCampaign = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('campaigns')
      .select(`
        *,
        campaign_messages (id, day_number, send_time, message_body),
        campaign_leads (id, status, lead_id, next_send_at, current_step)
      `)
      .eq('id', req.params.id)
      .single()
    if (error) throw error
    res.json({ campaign: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const createCampaign = async (req, res) => {
  try {
    const { name, description, messages } = req.body
    if (!name) return res.status(400).json({ error: 'Campaign name is required' })
    if (!messages || messages.length === 0) return res.status(400).json({ error: 'At least one message is required' })

    const { data: campaign, error: campError } = await supabase
      .from('campaigns')
      .insert({ name, description, status: 'draft', user_id: req.user.id })
      .select()
      .single()
    if (campError) throw campError

    const messageRows = messages.map((msg) => ({
      campaign_id: campaign.id,
      day_number: msg.day_number,
      send_time: msg.send_time || '10:00',
      message_body: msg.message_body
    }))

    const { error: msgError } = await supabase
      .from('campaign_messages')
      .insert(messageRows)
    if (msgError) throw msgError

    res.json({ success: true, campaign })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const updateCampaign = async (req, res) => {
  try {
    const { name, description, messages } = req.body

    const { data: campaign, error: campError } = await supabase
      .from('campaigns')
      .update({ name, description, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single()
    if (campError) throw campError

    if (messages) {
      await supabase
        .from('campaign_messages')
        .delete()
        .eq('campaign_id', req.params.id)

      const messageRows = messages.map((msg) => ({
        campaign_id: campaign.id,
        day_number: msg.day_number,
        send_time: msg.send_time || '10:00',
        message_body: msg.message_body
      }))

      const { error: msgError } = await supabase
        .from('campaign_messages')
        .insert(messageRows)
      if (msgError) throw msgError
    }

    res.json({ success: true, campaign })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const deleteCampaign = async (req, res) => {
  try {
    const { error } = await supabase
      .from('campaigns')
      .delete()
      .eq('id', req.params.id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const enrollLeads = async (req, res) => {
  try {
    const { lead_ids, start_date } = req.body
    const campaignId = req.params.id

    if (!lead_ids || lead_ids.length === 0) {
      return res.status(400).json({ error: 'No leads provided' })
    }
    if (!start_date) {
      return res.status(400).json({ error: 'Start date and time is required' })
    }

    const { data: messages, error: msgError } = await supabase
      .from('campaign_messages')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('day_number', { ascending: true })
    if (msgError) throw msgError

    if (messages.length === 0) {
      return res.status(400).json({ error: 'Campaign has no messages' })
    }

    const { data: leadsData } = await supabase
      .from('leads')
      .select('id, timezone')
      .in('id', lead_ids)

    const firstMessage = messages[0]
    const enrollments = leadsData.map((lead) => {
      const leadTimezone = lead.timezone || 'America/New_York'
      const firstSendAt = calculateSendTime(
        firstMessage.day_number,
        firstMessage.send_time || '10:00',
        start_date,
        leadTimezone
      )
      return {
        campaign_id: campaignId,
        lead_id: lead.id,
        status: 'pending',
        current_step: 0,
        start_date: new Date(start_date).toISOString(),
        next_send_at: firstSendAt,
        user_id: req.user.id
      }
    })

    const { data, error } = await supabase
      .from('campaign_leads')
      .insert(enrollments)
      .select()
    if (error) throw error

    res.json({
      success: true,
      message: `Tagged ${data.length} leads with campaign`,
      count: data.length
    })
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
  } catch (err) {
    const fallback = new Date(startDate)
    fallback.setDate(fallback.getDate() + (dayNumber - 1))
    fallback.setHours(10, 0, 0, 0)
    return fallback.toISOString()
  }
}

const startCampaign = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('campaigns')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single()
    if (error) throw error
    res.json({ success: true, campaign: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const pauseCampaign = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('campaigns')
      .update({ status: 'paused', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single()
    if (error) throw error
    res.json({ success: true, campaign: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

module.exports = {
  getCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  enrollLeads,
  startCampaign,
  pauseCampaign
}