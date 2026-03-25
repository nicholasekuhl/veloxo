const supabase = require('./db')
const { sendSMS, buildMessageBody, pickNumberForLead } = require('./twilio')
const { spintext } = require('./spintext')
const nodemailer = require('nodemailer')

const HEALTH_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const HEALTH_ALERT_THRESHOLD_MS = 5 * 60 * 1000

// Status priority — never downgrade
const STATUS_PRIORITY = { new: 0, contacted: 1, replied: 2, booked: 3, sold: 4 }
const canUpgrade = (current, target) => (STATUS_PRIORITY[target] ?? -1) > (STATUS_PRIORITY[current] ?? -1)

const getMailer = () => nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
})

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
  let messagesSent = 0
  let errorsCount = 0

  try {
    const now = new Date()

    // Read previous heartbeat, check for gap, send alert if needed
    const { data: healthRow } = await supabase
      .from('scheduler_health')
      .select('last_heartbeat')
      .eq('id', HEALTH_ID)
      .single()

    if (healthRow?.last_heartbeat) {
      const gap = now - new Date(healthRow.last_heartbeat)
      if (gap > HEALTH_ALERT_THRESHOLD_MS) {
        const gapMin = Math.round(gap / 60000)
        const adminEmail = process.env.ADMIN_EMAIL
        if (adminEmail && process.env.SMTP_HOST) {
          try {
            const mailer = getMailer()
            await mailer.sendMail({
              from: process.env.SMTP_USER,
              to: adminEmail,
              subject: 'TextApp Scheduler Alert — Gap Detected',
              text: `The scheduler has recovered after a ${gapMin}-minute gap.\n\nLast heartbeat: ${healthRow.last_heartbeat}\nCurrent time: ${now.toISOString()}`
            })
          } catch (mailErr) {
            console.error('Scheduler alert email failed:', mailErr.message)
          }
        }
        console.warn(`Scheduler gap detected: ${gapMin} minutes since last tick`)
      }
    }

    // Update heartbeat at start of tick
    await supabase
      .from('scheduler_health')
      .update({ last_heartbeat: now.toISOString(), updated_at: now.toISOString() })
      .eq('id', HEALTH_ID)

    const { data: dueCampaignLeads, error } = await supabase
      .from('campaign_leads')
      .select(`
        *,
        leads (id, first_name, last_name, phone, state, status, opted_out, timezone, first_message_sent),
        campaigns (id, name, status)
      `)
      .eq('status', 'pending')
      .lte('next_send_at', now.toISOString())

    if (error) throw error
    if (!dueCampaignLeads || dueCampaignLeads.length === 0) return

    // Batch-load active phone numbers and profiles for all unique user_ids in this batch
    const userIds = [...new Set(dueCampaignLeads.map(e => e.user_id).filter(Boolean))]
    let phoneNumbersMap = {}  // userId -> array of {phone_number, state, is_default}
    let profileMap = {}
    if (userIds.length > 0) {
      const [{ data: phoneNumbers }, { data: profiles }] = await Promise.all([
        supabase.from('phone_numbers').select('user_id, phone_number, state, is_default').in('user_id', userIds).eq('is_active', true).order('created_at', { ascending: true }),
        supabase.from('user_profiles').select('id, agency_name, compliance_footer, compliance_footer_enabled').in('id', userIds)
      ])
      if (phoneNumbers) {
        for (const pn of phoneNumbers) {
          if (!phoneNumbersMap[pn.user_id]) phoneNumbersMap[pn.user_id] = []
          phoneNumbersMap[pn.user_id].push(pn)
        }
      }
      if (profiles) {
        for (const p of profiles) profileMap[p.id] = p
      }
    }

    for (const enrollment of dueCampaignLeads) {
      if (!enrollment.leads || !enrollment.campaigns) continue
      if (enrollment.campaigns.status !== 'active') continue

      // Secondary guard — skip if enrollment was paused/completed/cancelled since query ran
      if (!['pending', 'active'].includes(enrollment.status)) {
        console.log(`Skipping enrollment ${enrollment.id} — status is '${enrollment.status}'`)
        continue
      }

      if (enrollment.leads.opted_out || enrollment.leads.status === 'opted_out') {
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
      const rawBody = spintext(currentMessage.message_body).replace('[First Name]', firstName)
      const userProfile = enrollment.user_id ? profileMap[enrollment.user_id] : null
      const messageBody = buildMessageBody(rawBody, userProfile, enrollment.leads, false)

      const fromNumber = pickNumberForLead(enrollment.user_id ? phoneNumbersMap[enrollment.user_id] : null, enrollment.leads.state) || process.env.TWILIO_PHONE_NUMBER
      const result = await sendSMS(enrollment.leads.phone, messageBody, fromNumber)

      if (result.success) {
        messagesSent++
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

        const leadUpdates = { updated_at: new Date().toISOString() }
        if (canUpgrade(enrollment.leads.status, 'contacted')) leadUpdates.status = 'contacted'
        if (!enrollment.leads.first_message_sent) leadUpdates.first_message_sent = true
        await supabase.from('leads').update(leadUpdates).eq('id', enrollment.leads.id)
        if (!enrollment.leads.first_message_sent) enrollment.leads.first_message_sent = true

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
      } else {
        errorsCount++
      }
    }

    // Process one-off scheduled messages
    const { data: dueOneOff } = await supabase
      .from('scheduled_messages')
      .select('*, leads (id, first_name, phone, state, status, is_blocked)')
      .eq('status', 'pending')
      .lte('send_at', now.toISOString())

    if (dueOneOff && dueOneOff.length > 0) {
      for (const sm of dueOneOff) {
        if (!sm.leads) continue
        if (sm.leads.status === 'opted_out' || sm.leads.is_blocked) {
          await supabase.from('scheduled_messages').update({ status: 'cancelled' }).eq('id', sm.id)
          continue
        }
        const fromNumber = pickNumberForLead(sm.user_id ? phoneNumbersMap[sm.user_id] : null, sm.leads.state) || process.env.TWILIO_PHONE_NUMBER
        const result = await sendSMS(sm.leads.phone, sm.body, fromNumber)
        if (result.success) {
          messagesSent++
          await supabase.from('scheduled_messages').update({ status: 'sent', sent_at: now.toISOString() }).eq('id', sm.id)
          // Upgrade lead status new → contacted on one-off send
          if (canUpgrade(sm.leads.status, 'contacted')) {
            await supabase.from('leads').update({ status: 'contacted', updated_at: now.toISOString() }).eq('id', sm.leads.id)
          }
          if (sm.conversation_id) {
            await supabase.from('messages').insert({
              conversation_id: sm.conversation_id,
              direction: 'outbound',
              body: sm.body,
              sent_at: now.toISOString(),
              status: 'sent'
            })
            await supabase.from('conversations').update({ updated_at: now.toISOString() }).eq('id', sm.conversation_id)
          }
        } else {
          errorsCount++
          await supabase.from('scheduled_messages').update({ status: 'failed' }).eq('id', sm.id)
        }
      }
    }

    await supabase
      .from('scheduler_health')
      .update({ messages_sent_last_run: messagesSent, errors_last_run: errorsCount })
      .eq('id', HEALTH_ID)
  } catch (err) {
    console.error('Scheduler error:', err.message)
    errorsCount++
    await supabase
      .from('scheduler_health')
      .update({ errors_last_run: errorsCount })
      .eq('id', HEALTH_ID)
      .catch(() => {})
  }
}

const startScheduler = () => {
  console.log('Campaign scheduler started — master Twilio account active')
  setInterval(processScheduledMessages, 60000)
  processScheduledMessages()
}

module.exports = { startScheduler }
