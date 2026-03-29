const supabase = require('./db')
const { sendSMS, buildMessageBody, pickNumberForLead } = require('./twilio')
const { spintext } = require('./spintext')
const { smsQueue } = require('./smsQueue')
const nodemailer = require('nodemailer')
const { isWithinQuietHours, checkSystemInitiatedLimit, getNextSendWindow } = require('./compliance')

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

const isInBusinessHoursForTimezone = (timezone) => {
  try {
    const tz = timezone || 'America/New_York'
    const now = new Date()
    const hourStr = now.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false })
    const dayStr = now.toLocaleString('en-US', { timeZone: tz, weekday: 'short' })
    const hour = parseInt(hourStr)
    const isWeekend = dayStr === 'Sat' || dayStr === 'Sun'
    return !isWeekend && hour >= 9 && hour < 19
  } catch {
    return true
  }
}

const isPositiveEngagement = (history) => {
  const recentInbound = history.filter(m => m.role === 'user').slice(-5)
  const buyingSignals = [
    'how much', 'what does it cost', 'sounds good', 'interested', 'tell me more',
    'what are my options', 'i want', 'sign me up', "let's do it", 'when can we',
    'book', 'schedule', 'call me', 'yes', 'yeah', 'sure', 'okay', 'ok',
    "i'd like", 'i would like', 'that works', 'works for me', 'can you',
    'send me', 'deductible', 'premium', 'coverage', 'plan', 'quote', 'how does'
  ]
  return recentInbound.some(m =>
    buyingSignals.some(signal => m.content.toLowerCase().includes(signal))
  )
}

const generateFollowupMessage = async (lead, history, profile, followupContext) => {
  try {
    const Anthropic = require('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const agentName = profile?.agent_name || 'your agent'
    const agentFirstName = profile?.agent_nickname || agentName.split(' ')[0]
    const stage = followupContext.stage

    let instruction = ''
    if (stage === 'stage1') {
      instruction = `Send a brief warm follow-up. Reference exactly where the conversation left off. Ask the next logical question from the qualification flow. Keep it to 1-2 sentences. Be casual and non-pressuring.`
    } else if (stage === 'stage2') {
      instruction = `Send a very light one-sentence follow-up like "No worries at all — whenever you're ready just text me back and I'll pick up right where we left off." No questions.`
    } else if (stage === 'stage3') {
      instruction = `Send a final gentle one-sentence check-in. Something like "Still here whenever you want to revisit your options — no rush at all." No questions, no pressure.`
    } else {
      instruction = `Send a very brief final one-sentence message making it easy to re-engage with no pressure.`
    }

    const systemPrompt = `You are an AI texting on behalf of ${agentFirstName}, a health insurance advisor. ${instruction}

Rules: never be pushy, maximum 1-2 sentences, use the lead's first name once if appropriate, do not repeat phrases from previous messages, sound like a real person texting.`

    const rawMessages = history.length > 0 ? history : [{ role: 'user', content: 'Hi' }]
    const messagesToSend = rawMessages.length > 12
      ? [...rawMessages.slice(0, 2), ...rawMessages.slice(-10)]
      : rawMessages

    if (messagesToSend.length === 0 || messagesToSend[messagesToSend.length - 1].role === 'assistant') {
      messagesToSend.push({
        role: 'user',
        content: '[The lead has not responded. Generate a brief, warm, casual follow-up check-in message under 2 sentences. Do not restart the conversation.]'
      })
    }

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      system: systemPrompt,
      messages: messagesToSend
    })
    return response.content[0]?.text || null
  } catch (err) {
    console.error('generateFollowupMessage error:', err.message)
    return null
  }
}

const checkGhostedConversations = async () => {
  try {
    const now = new Date()
    const fifteenMinAgo = new Date(now - 15 * 60 * 1000).toISOString()

    const { data: conversations } = await supabase
      .from('conversations')
      .select('*')
      .eq('needs_agent_review', false)
      .not('last_outbound_at', 'is', null)
      .lte('last_outbound_at', fifteenMinAgo)
      .in('followup_stage', ['none', 'stage1', 'stage2', 'stage3'])

    if (!conversations || conversations.length === 0) return

    for (const conv of conversations) {
      if (conv.followup_stage === 'stage4' || conv.needs_agent_review === true || conv.engagement_status === 'dormant') {
        continue
      }

      const lastOutbound = new Date(conv.last_outbound_at)
      const lastInbound = conv.last_inbound_at ? new Date(conv.last_inbound_at) : null

      // Skip if lead replied after our last outbound
      if (lastInbound && lastInbound > lastOutbound) continue

      const minutesSince = (now - lastOutbound) / (1000 * 60)
      const stage = conv.followup_stage || 'none'
      let targetStage = null

      if (stage === 'none' && minutesSince >= 15) targetStage = 'stage1'
      else if (stage === 'stage1' && minutesSince >= 60) targetStage = 'stage2'
      else if (stage === 'stage2' && minutesSince >= 240) targetStage = 'stage3'
      else if (stage === 'stage3' && minutesSince >= 1200) targetStage = 'stage4'

      if (!targetStage) continue

      // Load the lead
      const { data: lead } = await supabase
        .from('leads')
        .select('*')
        .eq('id', conv.lead_id)
        .single()

      if (!lead || !lead.autopilot || lead.opted_out || lead.is_blocked) continue
      if (!isInBusinessHoursForTimezone(lead.timezone)) continue

      // TCPA quiet hours — hard block on follow-ups
      const quietCheck = isWithinQuietHours(lead.state, lead.timezone)
      if (quietCheck.blocked) {
        console.log(`Follow-up blocked (quiet hours): ${quietCheck.reason} — lead ${lead.id}`)
        continue
      }

      // Daily system-initiated limit (FL/OK/MD = 3/day)
      const followupDailyCheck = checkSystemInitiatedLimit(lead.state, lead.outbound_initiated_today)
      if (followupDailyCheck.blocked) {
        console.log(`Follow-up blocked (daily limit): ${followupDailyCheck.reason} — lead ${lead.id}`)
        continue
      }

      // Load message history
      const { data: messages } = await supabase
        .from('messages')
        .select('direction, body, sent_at')
        .eq('conversation_id', conv.id)
        .order('sent_at', { ascending: true })

      if (!messages || messages.length === 0) continue

      const history = messages.map(m => ({
        role: m.direction === 'inbound' ? 'user' : 'assistant',
        content: m.body
      }))

      const positive = isPositiveEngagement(history)
      const engagementStatus = positive ? 'positive_ghosted' : (lastInbound ? 'ghosted_mid' : 'dormant')

      const { data: profile } = await supabase
        .from('user_profiles').select('*').eq('id', lead.user_id).single()

      const { data: phoneNumbers } = await supabase
        .from('phone_numbers').select('phone_number, state, is_default')
        .eq('user_id', lead.user_id).eq('is_active', true)

      const fromNumber = pickNumberForLead(phoneNumbers, lead.state) || process.env.TWILIO_PHONE_NUMBER
      if (!fromNumber) continue

      const followupText = await generateFollowupMessage(lead, history, profile, { stage: targetStage })
      if (!followupText) continue

      const result = await sendSMS(lead.phone, followupText, fromNumber)
      if (!result.success) {
        console.error(`Follow-up send failed for lead ${lead.id}:`, result.error)
        continue
      }

      await supabase.from('messages').insert({
        conversation_id: conv.id,
        user_id: lead.user_id,
        direction: 'outbound',
        body: followupText,
        sent_at: now.toISOString(),
        is_ai: true,
        twilio_sid: result.sid,
        status: 'sent'
      })

      // Increment system-initiated counter (re-engagement follows are system-initiated)
      await supabase.from('leads')
        .update({ outbound_initiated_today: (lead.outbound_initiated_today || 0) + 1 })
        .eq('id', lead.id)

      const newFollowupCount = (conv.followup_count || 0) + 1
      const newStage = targetStage === 'stage4' ? 'completed' : targetStage

      const convUpdates = {
        followup_stage: newStage,
        followup_count: newFollowupCount,
        last_outbound_at: now.toISOString(),
        engagement_status: engagementStatus,
        updated_at: now.toISOString()
      }

      // After final follow-up on positive engagement — hand off to agent
      if (targetStage === 'stage4' && engagementStatus === 'positive_ghosted') {
        convUpdates.needs_agent_review = true
        convUpdates.handoff_reason = 'positive_ghosted'
        await supabase.from('leads').update({ autopilot: false, updated_at: now.toISOString() }).eq('id', lead.id)
      }

      await supabase.from('conversations').update(convUpdates).eq('id', conv.id)

      // Notify agent when a positive-engagement lead goes quiet (stage2 only, avoid spamming)
      if (engagementStatus === 'positive_ghosted' && targetStage === 'stage2') {
        const { createNotification } = require('./notifications')
        const leadName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.phone
        createNotification(
          lead.user_id,
          'lead_ghosted',
          `${leadName} went quiet after engaging`,
          `This lead was showing interest but stopped responding. A follow-up has been sent.`,
          lead.id,
          conv.id
        )
      }

      console.log(`Follow-up ${targetStage} sent to lead ${lead.id} (${engagementStatus})`)
    }
  } catch (err) {
    console.error('checkGhostedConversations error:', err.message)
  }
}

// Helper: get next_send_at for first day-based message after quick steps complete
const getNextDayBasedSendAt = async (enrollment) => {
  const { data: messages } = await supabase
    .from('campaign_messages')
    .select('day_number, send_time')
    .eq('campaign_id', enrollment.campaign_id)
    .order('day_number', { ascending: true })
    .limit(1)
  if (!messages || messages.length === 0) return null
  const tz = enrollment.leads?.timezone || 'America/New_York'
  return calculateSendTime(messages[0].day_number, messages[0].send_time || '10:00', enrollment.start_date, tz)
}

const processQuickFollowups = async () => {
  try {
    const now = new Date()

    // Fetch enrollments where at least one quick step may still need sending
    const { data: enrollments, error } = await supabase
      .from('campaign_leads')
      .select(`
        *,
        leads (id, first_name, last_name, phone, state, status, opted_out, timezone, first_message_sent, outbound_initiated_today),
        campaigns (id, name, status, message_1, message_1_spintext, message_2, message_2_delay_minutes, message_2_spintext, message_3, message_3_delay_minutes, message_3_spintext, cancel_on_reply)
      `)
      .in('status', ['pending', 'active'])
      .or('step_1_sent_at.is.null,step_2_sent_at.is.null,step_3_sent_at.is.null')

    if (error) throw error

    // Only process campaigns that have message_1 (quick follow-up campaigns)
    const quickEnrollments = (enrollments || []).filter(e => e.campaigns?.message_1)
    if (quickEnrollments.length === 0) return

    // Batch-load phone numbers and profiles
    const userIds = [...new Set(quickEnrollments.map(e => e.user_id).filter(Boolean))]
    let phoneNumbersMap = {}
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

    // Batch-load conversations for reply check
    const leadIds = [...new Set(quickEnrollments.map(e => e.lead_id).filter(Boolean))]
    let convMap = {}
    if (leadIds.length > 0) {
      const { data: convs } = await supabase
        .from('conversations')
        .select('lead_id, id, last_inbound_at')
        .in('lead_id', leadIds)
      if (convs) {
        for (const c of convs) convMap[c.lead_id] = c
      }
    }

    for (const enrollment of quickEnrollments) {
      if (!enrollment.leads || !enrollment.campaigns) continue
      if (enrollment.campaigns.status !== 'active') continue
      if (!['pending', 'active'].includes(enrollment.status)) continue

      const lead = enrollment.leads
      const campaign = enrollment.campaigns
      const conv = convMap[lead.id]

      if (lead.opted_out || lead.status === 'opted_out') {
        await supabase.from('campaign_leads').update({ status: 'opted_out' }).eq('id', enrollment.id)
        continue
      }

      // Determine which step to attempt
      let stepToSend = null
      if (!enrollment.step_1_sent_at) {
        if (new Date(enrollment.next_send_at) <= now) stepToSend = 1
      } else if (!enrollment.step_2_sent_at && campaign.message_2 && campaign.message_2_delay_minutes) {
        const sendAfter = new Date(new Date(enrollment.step_1_sent_at).getTime() + campaign.message_2_delay_minutes * 60000)
        const leadReplied = conv?.last_inbound_at && new Date(conv.last_inbound_at) > new Date(enrollment.step_1_sent_at)
        if (sendAfter <= now && !leadReplied) stepToSend = 2
      } else if (enrollment.step_2_sent_at && !enrollment.step_3_sent_at && campaign.message_3 && campaign.message_3_delay_minutes) {
        const sendAfter = new Date(new Date(enrollment.step_1_sent_at).getTime() + campaign.message_3_delay_minutes * 60000)
        const leadReplied = conv?.last_inbound_at && new Date(conv.last_inbound_at) > new Date(enrollment.step_1_sent_at)
        if (sendAfter <= now && !leadReplied) stepToSend = 3
      }

      if (!stepToSend) continue

      // Compliance checks
      const quietCheck = isWithinQuietHours(lead.state, lead.timezone)
      if (quietCheck.blocked) {
        console.log(`Quick follow-up step ${stepToSend} blocked (quiet hours): ${quietCheck.reason} — lead ${lead.id}`)
        // Delay step 2/3 to next permitted window
        if (stepToSend > 1) {
          await supabase.from('campaign_leads')
            .update({ next_send_at: getNextSendWindow(lead.state, lead.timezone) })
            .eq('id', enrollment.id)
        }
        continue
      }

      const dailyCheck = checkSystemInitiatedLimit(lead.state, lead.outbound_initiated_today)
      if (dailyCheck.blocked) {
        console.log(`Quick follow-up step ${stepToSend} blocked (daily limit): ${dailyCheck.reason} — lead ${lead.id}`)
        continue
      }

      // Build message body
      const msgKey = stepToSend === 1 ? 'message_1' : stepToSend === 2 ? 'message_2' : 'message_3'
      const spintextKey = `message_${stepToSend}_spintext`
      const rawBody = campaign[spintextKey] ? spintext(campaign[msgKey]) : campaign[msgKey]
      const firstName = lead.first_name || 'there'
      const resolvedBody = rawBody.replace('[First Name]', firstName)
      const userProfile = enrollment.user_id ? profileMap[enrollment.user_id] : null
      let messageBody = buildMessageBody(resolvedBody, userProfile, lead, false)
      if (stepToSend === 1) {
        const agencyName = userProfile?.agency_name
        if (!lead.first_message_sent && agencyName && !messageBody.includes(agencyName)) {
          messageBody = `${messageBody}\n${agencyName}`
        }
      }

      const fromNumber = pickNumberForLead(enrollment.user_id ? phoneNumbersMap[enrollment.user_id] : null, lead.state) || process.env.TWILIO_PHONE_NUMBER

      // Enqueue — don't block the scheduler loop waiting on Twilio
      smsQueue.add({
        phone: lead.phone,
        message: messageBody,
        leadId: lead.id,
        conversationId: conv?.id || null,
        userId: enrollment.user_id || null,
        fromNumber,
        enrollmentId: enrollment.id,
        stepToSend,

        sendFn: async (job) => {
          const result = await sendSMS(job.phone, job.message, job.fromNumber)
          if (!result.success) throw new Error(result.error || 'sendSMS failed')
          job._twilioSid = result.sid
        },

        onSuccess: async (job) => {
          const sentAt = new Date().toISOString()

          // Ensure conversation exists — null guard before reading .id
          let conversation = conv
          if (!conversation) {
            const { data: newConv } = await supabase
              .from('conversations')
              .insert({ lead_id: job.leadId, status: 'active', user_id: job.userId })
              .select().single()
            conversation = newConv
          }
          if (!conversation || !conversation.id) {
            console.error(`[quickFollowups] No conversation for lead ${job.leadId} — skipping DB log`)
            return
          }

          await supabase.from('messages').insert({
            conversation_id: conversation.id,
            user_id: job.userId,
            direction: 'outbound',
            body: job.message,
            sent_at: sentAt,
            twilio_sid: job._twilioSid,
            status: 'sent'
          })

          const leadUpdates = { updated_at: sentAt, outbound_initiated_today: (lead.outbound_initiated_today || 0) + 1 }
          if (canUpgrade(lead.status, 'contacted')) leadUpdates.status = 'contacted'
          if (job.stepToSend === 1 && !lead.first_message_sent) leadUpdates.first_message_sent = true
          await supabase.from('leads').update(leadUpdates).eq('id', job.leadId)

          const stepUpdates = {}
          if (job.stepToSend === 1) {
            stepUpdates.step_1_sent_at = sentAt
            if (campaign.message_2 && campaign.message_2_delay_minutes) {
              stepUpdates.next_send_at = new Date(new Date(sentAt).getTime() + campaign.message_2_delay_minutes * 60000).toISOString()
            } else {
              const nextDayAt = await getNextDayBasedSendAt(enrollment)
              if (nextDayAt) stepUpdates.next_send_at = nextDayAt
              else { stepUpdates.status = 'completed'; stepUpdates.completed_at = sentAt }
            }
          } else if (job.stepToSend === 2) {
            stepUpdates.step_2_sent_at = sentAt
            if (campaign.message_3 && campaign.message_3_delay_minutes) {
              stepUpdates.next_send_at = new Date(new Date(enrollment.step_1_sent_at).getTime() + campaign.message_3_delay_minutes * 60000).toISOString()
            } else {
              const nextDayAt = await getNextDayBasedSendAt(enrollment)
              if (nextDayAt) stepUpdates.next_send_at = nextDayAt
              else { stepUpdates.status = 'completed'; stepUpdates.completed_at = sentAt }
            }
          } else if (job.stepToSend === 3) {
            stepUpdates.step_3_sent_at = sentAt
            const nextDayAt = await getNextDayBasedSendAt(enrollment)
            if (nextDayAt) stepUpdates.next_send_at = nextDayAt
            else { stepUpdates.status = 'completed'; stepUpdates.completed_at = sentAt }
          }

          await supabase.from('campaign_leads').update(stepUpdates).eq('id', job.enrollmentId)
          console.log(`[quickFollowups] Step ${job.stepToSend} sent to lead ${job.leadId}`)
        },

        onFailure: async (job, err) => {
          console.error(`[quickFollowups] Step ${job.stepToSend} failed for lead ${job.leadId}: ${err?.message}`)
        },
      })
    }
  } catch (err) {
    console.error('processQuickFollowups error:', err.message)
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
              subject: 'TextApp Scheduler Alert — heartbeat stale',
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
        leads (id, first_name, last_name, phone, state, status, opted_out, timezone, first_message_sent, outbound_initiated_today),
        campaigns (id, name, status, message_1)
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

      // Quick follow-up campaigns: let processQuickFollowups handle until step_1 is sent
      if (enrollment.campaigns.message_1 && !enrollment.step_1_sent_at) continue

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

      // TCPA quiet hours — hard block, no override
      const quietCheck = isWithinQuietHours(enrollment.leads.state, enrollment.leads.timezone)
      if (quietCheck.blocked) {
        console.log(`Campaign send blocked (quiet hours): ${quietCheck.reason} — lead ${enrollment.leads.id}`)
        continue
      }

      // Daily system-initiated limit (FL/OK/MD = 3/day)
      const dailyCheck = checkSystemInitiatedLimit(enrollment.leads.state, enrollment.leads.outbound_initiated_today)
      if (dailyCheck.blocked) {
        console.log(`Campaign send blocked (daily limit): ${dailyCheck.reason} — lead ${enrollment.leads.id}`)
        continue
      }

      const firstName = enrollment.leads.first_name || 'there'
      const rawBody = spintext(currentMessage.message_body).replace('[First Name]', firstName)
      const userProfile = enrollment.user_id ? profileMap[enrollment.user_id] : null
      let messageBody = buildMessageBody(rawBody, userProfile, enrollment.leads, false)
      // Belt-and-suspenders: always append agency name to first campaign message if not already present
      const agencyName = userProfile?.agency_name
      if (!enrollment.leads.first_message_sent && agencyName && !messageBody.includes(agencyName)) {
        messageBody = `${messageBody}\n${agencyName}`
      }

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
            user_id: enrollment.user_id || null,
            direction: 'outbound',
            body: messageBody,
            sent_at: new Date().toISOString(),
            twilio_sid: result.sid,
            status: 'sent'
          })

        const leadUpdates = { updated_at: new Date().toISOString() }
        if (canUpgrade(enrollment.leads.status, 'contacted')) leadUpdates.status = 'contacted'
        if (!enrollment.leads.first_message_sent) leadUpdates.first_message_sent = true
        // Increment system-initiated counter (used for FL/OK/MD daily limit)
        leadUpdates.outbound_initiated_today = (enrollment.leads.outbound_initiated_today || 0) + 1
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
      .select('*, leads (id, first_name, phone, state, timezone, status, is_blocked, outbound_initiated_today)')
      .eq('status', 'pending')
      .lte('send_at', now.toISOString())

    if (dueOneOff && dueOneOff.length > 0) {
      for (const sm of dueOneOff) {
        if (!sm.leads) continue
        if (sm.leads.status === 'opted_out' || sm.leads.is_blocked) {
          await supabase.from('scheduled_messages').update({ status: 'cancelled' }).eq('id', sm.id)
          continue
        }

        // TCPA quiet hours — hard block on scheduled messages
        const smQuietCheck = isWithinQuietHours(sm.leads.state, sm.leads.timezone)
        if (smQuietCheck.blocked) {
          console.log(`Scheduled message blocked (quiet hours): ${smQuietCheck.reason} — lead ${sm.leads.id}`)
          continue
        }

        // AI-queued conversational replies are NOT system-initiated — skip daily limit
        const isAiQueued = sm.notes && sm.notes.includes('AI response queued')
        if (!isAiQueued) {
          const smDailyCheck = checkSystemInitiatedLimit(sm.leads.state, sm.leads.outbound_initiated_today)
          if (smDailyCheck.blocked) {
            console.log(`Scheduled message blocked (daily limit): ${smDailyCheck.reason} — lead ${sm.leads.id}`)
            continue
          }
        }

        const fromNumber = pickNumberForLead(sm.user_id ? phoneNumbersMap[sm.user_id] : null, sm.leads.state) || process.env.TWILIO_PHONE_NUMBER
        const result = await sendSMS(sm.leads.phone, sm.body, fromNumber)
        if (result.success) {
          messagesSent++
          await supabase.from('scheduled_messages').update({ status: 'sent', sent_at: now.toISOString() }).eq('id', sm.id)
          // Upgrade lead status new → contacted on one-off send
          const smLeadUpdates = { updated_at: now.toISOString() }
          if (canUpgrade(sm.leads.status, 'contacted')) smLeadUpdates.status = 'contacted'
          // Increment system-initiated counter only for non-AI-queued messages
          if (!isAiQueued) {
            smLeadUpdates.outbound_initiated_today = (sm.leads.outbound_initiated_today || 0) + 1
          }
          await supabase.from('leads').update(smLeadUpdates).eq('id', sm.leads.id)
          if (sm.conversation_id) {
            await supabase.from('messages').insert({
              conversation_id: sm.conversation_id,
              user_id: sm.user_id || null,
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

const resetDailySendCounts = async () => {
  try {
    await Promise.all([
      supabase
        .from('phone_numbers')
        .update({ sent_today: 0 })
        .neq('id', '00000000-0000-0000-0000-000000000000'),
      supabase
        .from('leads')
        .update({ outbound_initiated_today: 0 })
        .gt('outbound_initiated_today', 0) // only touch rows that need it
    ])
    console.log('Daily sent_today and outbound_initiated_today counters reset')
  } catch (err) {
    console.error('resetDailySendCounts error:', err.message)
  }
}

const restoreCoolingNumbers = async () => {
  try {
    await supabase
      .from('phone_numbers')
      .update({ status: 'active', cooloff_until: null })
      .eq('status', 'cooling')
      .lt('cooloff_until', new Date().toISOString())
    console.log('Cooling numbers restored to active')
  } catch (err) {
    console.error('restoreCoolingNumbers error:', err.message)
  }
}

const scheduleMidnightReset = () => {
  const now = new Date()
  const nextMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0))
  const msUntilMidnight = nextMidnight - now
  setTimeout(() => {
    resetDailySendCounts()
    scheduleMidnightReset() // reschedule for next midnight
  }, msUntilMidnight)
}

const startScheduler = () => {
  console.log('Campaign scheduler started — master Twilio account active')
  setInterval(processScheduledMessages, 60000)
  // setInterval(processQuickFollowups, 60000) // TEMP DISABLED
  setInterval(checkGhostedConversations, 60000)
  setInterval(restoreCoolingNumbers, 5 * 60 * 1000) // check every 5 min
  scheduleMidnightReset()
  processScheduledMessages()
  processQuickFollowups()
  checkGhostedConversations()
}

module.exports = { startScheduler }
