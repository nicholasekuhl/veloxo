const supabase = require('./db')
const { sendSMS } = require('./twilio')
const { spintext } = require('./spintext')

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

const isWithinBusinessHours = (sendTime) => {
  try {
    const [hours] = sendTime.split(':').map(Number)
    return hours >= 9 && hours < 19
  } catch {
    return true
  }
}

const processScheduledMessages = async () => {
  try {
    const now = new Date().toISOString()

    const { data: dueCampaignLeads, error } = await supabase
      .from('campaign_leads')
      .select(`
        *,
        leads (id, first_name, last_name, phone, status, timezone),
        campaigns (id, name, status)
      `)
      .eq('status', 'pending')
      .lte('next_send_at', now)

    if (error) throw error
    if (!dueCampaignLeads || dueCampaignLeads.length === 0) return

    // Batch-load user profiles for all unique user_ids in this batch
    const userIds = [...new Set(dueCampaignLeads.map(e => e.user_id).filter(Boolean))]
    let profileMap = {}
    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from('user_profiles')
        .select('*')
        .in('id', userIds)
      if (profiles) {
        profileMap = Object.fromEntries(profiles.map(p => [p.id, p]))
      }
    }

    for (const enrollment of dueCampaignLeads) {
      if (!enrollment.leads || !enrollment.campaigns) continue
      if (enrollment.campaigns.status !== 'active') continue

      if (enrollment.leads.status === 'opted_out') {
        await supabase
          .from('campaign_leads')
          .update({ status: 'opted_out' })
          .eq('id', enrollment.id)
        continue
      }

      const { data: messages } = await supabase
        .from('campaign_messages')
        .select('*')
        .eq('campaign_id', enrollment.campaign_id)
        .order('day_number', { ascending: true })

      if (!messages || messages.length === 0) continue

      const currentMessage = messages[enrollment.current_step]
      if (!currentMessage) {
        await supabase
          .from('campaign_leads')
          .update({ status: 'completed', completed_at: new Date().toISOString() })
          .eq('id', enrollment.id)
        continue
      }

      const sendTime = currentMessage.send_time || '10:00'
      if (!isWithinBusinessHours(sendTime)) {
        console.log(`Message time ${sendTime} outside business hours — skipping`)
        continue
      }

      const firstName = enrollment.leads.first_name || 'there'
      const messageBody = spintext(currentMessage.message_body).replace('[First Name]', firstName)

      // Use this enrollment's user's Twilio credentials (falls back to .env if not set)
      const profile = enrollment.user_id ? profileMap[enrollment.user_id] || null : null
      const result = await sendSMS(enrollment.leads.phone, messageBody, profile)

      if (result.success) {
        let { data: conversation } = await supabase
          .from('conversations')
          .select('*')
          .eq('lead_id', enrollment.leads.id)
          .single()

        if (!conversation) {
          const { data: newConv } = await supabase
            .from('conversations')
            .insert({ lead_id: enrollment.leads.id, status: 'active', user_id: enrollment.user_id || null })
            .select()
            .single()
          conversation = newConv
        }

        await supabase
          .from('messages')
          .insert({
            conversation_id: conversation.id,
            direction: 'outbound',
            body: messageBody,
            sent_at: new Date().toISOString(),
            twilio_sid: result.sid,
            status: 'sent'
          })

        await supabase
          .from('leads')
          .update({ status: 'contacted', updated_at: new Date().toISOString() })
          .eq('id', enrollment.leads.id)

        const nextStep = enrollment.current_step + 1
        const isLastStep = nextStep >= messages.length

        if (isLastStep) {
          await supabase
            .from('campaign_leads')
            .update({ status: 'completed', current_step: nextStep, completed_at: new Date().toISOString() })
            .eq('id', enrollment.id)
        } else {
          const nextMessage = messages[nextStep]
          const leadTimezone = enrollment.leads.timezone || 'America/New_York'
          const nextSendAt = calculateSendTime(
            nextMessage.day_number,
            nextMessage.send_time || '10:00',
            enrollment.start_date,
            leadTimezone
          )
          await supabase
            .from('campaign_leads')
            .update({ current_step: nextStep, next_send_at: nextSendAt })
            .eq('id', enrollment.id)
        }
      }
    }
  } catch (err) {
    console.error('Scheduler error:', err.message)
  }
}

const startScheduler = () => {
  console.log('Campaign scheduler started — per-user Twilio credentials active')
  setInterval(processScheduledMessages, 60000)
  processScheduledMessages()
}

module.exports = { startScheduler }
