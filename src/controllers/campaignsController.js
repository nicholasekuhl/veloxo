const supabase = require('../db')

const getCampaigns = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('campaigns')
      .select(`
        *,
        campaign_messages (id, day_number, send_time, message_body),
        campaign_leads (id, status, leads(status))
      `)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
    if (error) throw error
    res.json({ campaigns: data })
  } catch (err) {
    console.error('Campaigns getCampaigns error:', err.message)
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
    console.error('Campaigns getCampaign error:', err.message)
    res.status(500).json({ error: err.message })
  }
}

const createCampaign = async (req, res) => {
  try {
    const {
      name, description, messages,
      message_1, message_1_spintext,
      message_2, message_2_delay_minutes, message_2_spintext,
      message_3, message_3_delay_minutes, message_3_spintext,
      cancel_on_reply, initial_send_time
    } = req.body
    if (!name) return res.status(400).json({ error: 'Campaign name is required' })
    if (!message_1) return res.status(400).json({ error: 'Initial message is required' })

    const { data: campaign, error: campError } = await supabase
      .from('campaigns')
      .insert({
        name, description, status: 'draft', user_id: req.user.id,
        message_1, message_1_spintext: !!message_1_spintext,
        message_2: message_2 || null,
        message_2_delay_minutes: message_2_delay_minutes || null,
        message_2_spintext: !!message_2_spintext,
        message_3: message_3 || null,
        message_3_delay_minutes: message_3_delay_minutes || null,
        message_3_spintext: !!message_3_spintext,
        cancel_on_reply: cancel_on_reply !== false,
        initial_send_time: initial_send_time || null
      })
      .select()
      .single()
    if (campError) throw campError

    if (messages && messages.length > 0) {
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

const updateCampaign = async (req, res) => {
  try {
    const {
      name, description, messages,
      message_1, message_1_spintext,
      message_2, message_2_delay_minutes, message_2_spintext,
      message_3, message_3_delay_minutes, message_3_spintext,
      cancel_on_reply, initial_send_time
    } = req.body

    const updates = { name, description, updated_at: new Date().toISOString() }
    if (initial_send_time !== undefined) updates.initial_send_time = initial_send_time || null
    if (message_1 !== undefined) {
      Object.assign(updates, {
        message_1, message_1_spintext: !!message_1_spintext,
        message_2: message_2 || null,
        message_2_delay_minutes: message_2_delay_minutes || null,
        message_2_spintext: !!message_2_spintext,
        message_3: message_3 || null,
        message_3_delay_minutes: message_3_delay_minutes || null,
        message_3_spintext: !!message_3_spintext,
        cancel_on_reply: cancel_on_reply !== false
      })
    }

    const { data: campaign, error: campError } = await supabase
      .from('campaigns')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single()
    if (campError) throw campError

    if (messages !== undefined) {
      await supabase
        .from('campaign_messages')
        .delete()
        .eq('campaign_id', req.params.id)

      if (messages && messages.length > 0) {
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

// Returns the next UTC ISO timestamp when timeStr (HH:MM[:SS]) occurs in the given timezone.
// If that time has already passed today in the lead's timezone, rolls to tomorrow.
const getNextSendAt = (timeStr, timezone) => {
  try {
    const now = new Date()
    const [hours, minutes] = timeStr.split(':').map(Number)
    const leadNow = new Date(now.toLocaleString('en-US', { timeZone: timezone }))
    const target = new Date(leadNow)
    target.setHours(hours, minutes, 0, 0)
    if (target <= leadNow) target.setDate(target.getDate() + 1)
    const utcOffset = now.getTime() - leadNow.getTime()
    return new Date(target.getTime() + utcOffset).toISOString()
  } catch {
    return new Date().toISOString()
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

    const { data: campaign, error: campFetchError } = await supabase
      .from('campaigns')
      .select('message_1, initial_send_time')
      .eq('id', campaignId)
      .single()
    if (campFetchError) throw campFetchError

    const { data: messages, error: msgError } = await supabase
      .from('campaign_messages')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('day_number', { ascending: true })
    if (msgError) throw msgError

    // Must have either message_1 or at least one day-based message
    if (!campaign.message_1 && messages.length === 0) {
      return res.status(400).json({ error: 'Campaign has no messages' })
    }

    const { data: leadsData } = await supabase
      .from('leads')
      .select('id, timezone')
      .in('id', lead_ids)

    const enrollments = leadsData.map((lead) => {
      const leadTimezone = lead.timezone || 'America/New_York'
      let firstSendAt

      if (campaign.message_1) {
        // Quick-follow-up campaign: use initial_send_time if set, otherwise start_date
        firstSendAt = campaign.initial_send_time
          ? getNextSendAt(campaign.initial_send_time, leadTimezone)
          : new Date(start_date).toISOString()
      } else {
        // Legacy day-based campaign: schedule first day-based message
        const firstMessage = messages[0]
        firstSendAt = calculateSendTime(
          firstMessage.day_number,
          firstMessage.send_time || '10:00',
          start_date,
          leadTimezone
        )
      }

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

const duplicateCampaign = async (req, res) => {
  try {
    const { data: original, error: fetchErr } = await supabase
      .from('campaigns')
      .select('*, campaign_messages(*)')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single()
    if (fetchErr || !original) return res.status(404).json({ error: 'Campaign not found' })

    const { campaign_messages, id, created_at, updated_at, ...fields } = original
    const { data: newCampaign, error: insertErr } = await supabase
      .from('campaigns')
      .insert({ ...fields, name: `${original.name} (Copy)`, status: 'draft', user_id: req.user.id })
      .select()
      .single()
    if (insertErr) throw insertErr

    if (campaign_messages && campaign_messages.length > 0) {
      await supabase.from('campaign_messages').insert(
        campaign_messages.map(m => ({
          campaign_id: newCampaign.id,
          day_number: m.day_number,
          send_time: m.send_time,
          message_body: m.message_body
        }))
      )
    }

    res.json({ success: true, campaign: newCampaign })
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
  pauseCampaign,
  duplicateCampaign
}