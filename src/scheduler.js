const supabase = require('./db')
const { sendSMS, buildMessageBody, pickNumberForLead } = require('./twilio')
const { deductSmsCredit } = require('./services/credits')
const { spintext } = require('./spintext')
const { smsQueue } = require('./smsQueue')
const nodemailer = require('nodemailer')
const { isValidTimezone, isWithinQuietHours, checkSystemInitiatedLimit, getNextSendWindow } = require('./compliance')
const { bumpMessageCount } = require('./utils/messageCount')

const HEALTH_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const HEALTH_ALERT_THRESHOLD_MS = 5 * 60 * 1000

// Per-user fairness cap — max jobs enqueued per user per scheduler tick.
// Prevents one agent's blast from starving every other agent's sends.
const RATE_PER_SECOND_PER_USER = 3

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
    base.setDate(base.getDate() + dayNumber)
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
    fallback.setDate(fallback.getDate() + dayNumber)
    fallback.setHours(10, 0, 0, 0)
    return fallback.toISOString()
  }
}

const safeTimezone = (tz) => isValidTimezone(tz) ? tz : 'America/New_York'

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

Rules: never be pushy, maximum 1-2 sentences, use the lead's first name once if appropriate, do not repeat phrases from previous messages, sound like a real person texting.

ABSOLUTE RULE: Never use any emoji in any message. Not a single one. Not ever, not once. Violating this rule is not acceptable.

ABSOLUTE RULE: Never use any dash character. No hyphen, no em dash, no en dash. Use a comma or period instead.

ABSOLUTE RULE: Never capitalize any word after a period or sentence break. Only capitalize the very first word of the message, the word "I", and real proper names. Everything else stays lowercase even at the start of a new sentence.

ABSOLUTE RULE: Never use exclamation marks, colons, semicolons, parentheses, brackets, asterisks, ellipses, or any special punctuation. Only periods, commas, and question marks.`

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
      .limit(30)

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

      if (!lead || !lead.autopilot || lead.opted_out || lead.is_blocked || lead.do_not_contact) continue
      if (!isInBusinessHoursForTimezone(safeTimezone(lead.timezone))) continue

      // TCPA quiet hours — hard block on follow-ups
      const quietCheck = isWithinQuietHours(lead.state, safeTimezone(lead.timezone))
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

      // Load last 30 messages for AI context
      const { data: recentMessages } = await supabase
        .from('messages')
        .select('direction, body, sent_at')
        .eq('conversation_id', conv.id)
        .order('sent_at', { ascending: false })
        .limit(30)

      const messages = (recentMessages || []).slice().reverse()
      if (messages.length === 0) continue

      const history = messages.filter(m => m.direction !== 'system').map(m => ({
        role: m.direction === 'inbound' ? 'user' : 'assistant',
        content: m.body
      }))
      if (conv.summary) {
        history.unshift({ role: 'user', content: `[CONVERSATION SUMMARY - earlier messages]: ${conv.summary}` })
      }

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
      await bumpMessageCount(conv.id)

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
  const tz = safeTimezone(enrollment.leads?.timezone)
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
        leads (id, first_name, last_name, phone, state, status, opted_out, do_not_contact, timezone, first_message_sent, outbound_initiated_today),
        campaigns (id, name, status, message_1, message_1_spintext, message_2, message_2_delay_minutes, message_2_spintext, message_3, message_3_delay_minutes, message_3_spintext, cancel_on_reply)
      `)
      .in('status', ['pending', 'active'])
      .or('step_1_sent_at.is.null,step_2_sent_at.is.null,step_3_sent_at.is.null')

    if (error) throw error

    // Only process campaigns that have message_1 (quick follow-up campaigns).
    // Group by user_id and cap at RATE_PER_SECOND_PER_USER per tick for fairness.
    const byUserQuick = {}
    for (const e of (enrollments || [])) {
      if (!e.campaigns?.message_1 || !e.user_id) continue
      if (!byUserQuick[e.user_id]) byUserQuick[e.user_id] = []
      byUserQuick[e.user_id].push(e)
    }
    const quickEnrollments = []
    for (const userEnrollments of Object.values(byUserQuick)) {
      quickEnrollments.push(...userEnrollments.slice(0, RATE_PER_SECOND_PER_USER))
    }
    if (quickEnrollments.length === 0) return
    console.log(`[scheduler] tick: ${Object.keys(byUserQuick).length} active users | ${quickEnrollments.length} jobs dispatched (quick followups)`)

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

      if (lead.opted_out || lead.status === 'opted_out' || lead.do_not_contact) {
        await supabase.from('campaign_leads').update({ status: lead.do_not_contact ? 'cancelled' : 'opted_out' }).eq('id', enrollment.id)
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

      // Guard: if step_1 was already recorded but status somehow got reset to pending, fix it and skip
      if (enrollment.step_1_sent_at && stepToSend === 1) {
        console.log(`[quickFollowups] step_1 already sent for enrollment ${enrollment.id} — fixing status to active`)
        await supabase.from('campaign_leads')
          .update({ status: 'active' })
          .eq('id', enrollment.id)
        continue
      }

      // Compliance checks
      const quietCheck = isWithinQuietHours(lead.state, safeTimezone(lead.timezone))
      if (quietCheck.blocked) {
        console.log(`Quick follow-up step ${stepToSend} blocked (quiet hours): ${quietCheck.reason} — lead ${lead.id}`)
        // Delay step 2/3 to next permitted window
        if (stepToSend > 1) {
          await supabase.from('campaign_leads')
            .update({ next_send_at: getNextSendWindow(lead.state, safeTimezone(lead.timezone)) })
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

      // Atomic guard — claim each step before enqueue to prevent duplicate sends on concurrent runs
      if (stepToSend === 1) {
        const { data: claimed } = await supabase
          .from('campaign_leads')
          .update({ step_1_sent_at: new Date().toISOString() })
          .eq('id', enrollment.id)
          .is('step_1_sent_at', null)
          .select('id')
        if (!claimed || claimed.length === 0) {
          console.log(`[quickFollowups] Step 1 already claimed for enrollment ${enrollment.id} — skipping`)
          continue
        }
      } else if (stepToSend === 2) {
        const { data: claimed } = await supabase
          .from('campaign_leads')
          .update({ step_2_sent_at: new Date().toISOString() })
          .eq('id', enrollment.id)
          .is('step_2_sent_at', null)
          .select('id')
        if (!claimed || claimed.length === 0) {
          console.log(`[quickFollowups] Step 2 already claimed for enrollment ${enrollment.id} — skipping`)
          continue
        }
      } else if (stepToSend === 3) {
        const { data: claimed } = await supabase
          .from('campaign_leads')
          .update({ step_3_sent_at: new Date().toISOString() })
          .eq('id', enrollment.id)
          .is('step_3_sent_at', null)
          .select('id')
        if (!claimed || claimed.length === 0) {
          console.log(`[quickFollowups] Step 3 already claimed for enrollment ${enrollment.id} — skipping`)
          continue
        }
      }

      // Enqueue — don't block the scheduler loop waiting on Twilio
      console.log(`[scheduler] Queuing quick step ${stepToSend} for enrollment ${enrollment.id}, status was: ${enrollment.status}`)
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

          const { data: conversation } = await supabase
            .from('conversations')
            .upsert({ lead_id: job.leadId, user_id: job.userId, status: 'active' }, { onConflict: 'lead_id,user_id', ignoreDuplicates: false })
            .select('id').single()
          if (!conversation?.id) {
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
          await bumpMessageCount(conversation.id)

          const leadUpdates = { updated_at: sentAt, outbound_initiated_today: (lead.outbound_initiated_today || 0) + 1 }
          if (canUpgrade(lead.status, 'contacted')) leadUpdates.status = 'contacted'
          if (job.stepToSend === 1 && !lead.first_message_sent) {
            leadUpdates.first_message_sent = true
            leadUpdates.first_message_sent_at = sentAt
          }
          await supabase.from('leads').update(leadUpdates).eq('id', job.leadId)

          // step_1_sent_at is written here as authoritative timestamp (atomic guard uses DB now(), onSuccess uses sentAt for precision)
          // step_2_sent_at and step_3_sent_at are already set by the atomic guard — do NOT overwrite them here
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
            // step_2_sent_at already set atomically — only update scheduling fields
            if (campaign.message_3 && campaign.message_3_delay_minutes) {
              stepUpdates.next_send_at = new Date(new Date(enrollment.step_1_sent_at).getTime() + campaign.message_3_delay_minutes * 60000).toISOString()
            } else {
              const nextDayAt = await getNextDayBasedSendAt(enrollment)
              if (nextDayAt) stepUpdates.next_send_at = nextDayAt
              else { stepUpdates.status = 'completed'; stepUpdates.completed_at = sentAt }
            }
          } else if (job.stepToSend === 3) {
            // step_3_sent_at already set atomically — only update scheduling fields
            const nextDayAt = await getNextDayBasedSendAt(enrollment)
            if (nextDayAt) stepUpdates.next_send_at = nextDayAt
            else { stepUpdates.status = 'completed'; stepUpdates.completed_at = sentAt }
          }

          await supabase.from('campaign_leads').update(stepUpdates).eq('id', job.enrollmentId)
          console.log(`[quickFollowups] Step ${job.stepToSend} sent to lead ${job.leadId}`)
          if (job.userId) deductSmsCredit(job.userId, job.fromNumber, job.phone, null).catch(err => console.error('[credits] SMS deduction failed:', err.message))
        },

        onFailure: async (job, err) => {
          console.error('[quickFollowups] Step', job.stepToSend, 'failed for lead', job.leadId, err?.message)

          // Mark enrollment as failed so scheduler does not keep retrying this lead
          if (job.enrollmentId) {
            await supabase
              .from('campaign_leads')
              .update({
                status: 'failed',
                cancelled_reason: err?.message || 'send_failed'
              })
              .eq('id', job.enrollmentId)
          }

          // If invalid number — block the lead so no further sends are attempted
          const isInvalidNumber = err?.message && (
            err.message.includes('Invalid') ||
            err.message.includes('not a mobile') ||
            err.message.includes('opted out')
          )
          if (isInvalidNumber && job.leadId) {
            await supabase
              .from('leads')
              .update({
                is_blocked: true,
                notes: 'Auto-blocked: invalid phone number',
                updated_at: new Date().toISOString()
              })
              .eq('id', job.leadId)
            console.log('[quickFollowups] Auto-blocked lead with invalid number:', job.leadId)
          }
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
              subject: 'Veloxo Scheduler Alert — heartbeat stale',
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
        leads (id, first_name, last_name, phone, state, status, opted_out, do_not_contact, timezone, first_message_sent, outbound_initiated_today),
        campaigns (id, name, status, message_1)
      `)
      .eq('status', 'pending')
      .lte('next_send_at', now.toISOString())

    if (error) throw error
    if (!dueCampaignLeads || dueCampaignLeads.length === 0) return

    // Group by user_id and cap at RATE_PER_SECOND_PER_USER per tick for fairness.
    // Prevents one agent's large campaign from monopolising every other agent's sends.
    const byUserSched = {}
    for (const e of dueCampaignLeads) {
      if (!e.user_id) continue
      if (!byUserSched[e.user_id]) byUserSched[e.user_id] = []
      byUserSched[e.user_id].push(e)
    }
    const throttledLeads = []
    for (const userLeads of Object.values(byUserSched)) {
      throttledLeads.push(...userLeads.slice(0, RATE_PER_SECOND_PER_USER))
    }
    console.log(`[scheduler] tick: ${Object.keys(byUserSched).length} active users | ${throttledLeads.length} jobs dispatched (campaign)`)

    // Batch-load active phone numbers and profiles for all unique user_ids in this batch
    const userIds = [...new Set(throttledLeads.map(e => e.user_id).filter(Boolean))]
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

    for (const enrollment of throttledLeads) {
      if (!enrollment.leads || !enrollment.campaigns) continue
      if (enrollment.campaigns.status !== 'active') continue

      // Secondary guard — skip if enrollment was paused/completed/cancelled since query ran
      if (!['pending', 'active'].includes(enrollment.status)) {
        console.log(`Skipping enrollment ${enrollment.id} — status is '${enrollment.status}'`)
        continue
      }

      // Quick follow-up campaigns: let processQuickFollowups handle until step_1 is sent
      if (enrollment.campaigns.message_1 && !enrollment.step_1_sent_at) continue

      if (enrollment.leads.opted_out || enrollment.leads.status === 'opted_out' || enrollment.leads.do_not_contact) {
        await supabase
          .from('campaign_leads')
          .update({ status: enrollment.leads.do_not_contact ? 'cancelled' : 'opted_out' })
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
      const quietCheck = isWithinQuietHours(enrollment.leads.state, safeTimezone(enrollment.leads.timezone))
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

      // Atomic claim — flip status pending→active before enqueue.
      // If two scheduler instances race, only one wins; the loser sees claimed.length === 0 and skips.
      const { data: claimed, error: claimError } = await supabase
        .from('campaign_leads')
        .update({ status: 'active' })
        .eq('id', enrollment.id)
        .eq('status', 'pending')
        .select('id')
      if (claimError) {
        console.error(`[scheduler] Claim error for enrollment ${enrollment.id}:`, claimError.message)
        continue
      }
      if (!claimed || claimed.length === 0) {
        console.log(`[scheduler] Enrollment ${enrollment.id} already claimed — skipping`)
        continue
      }

      console.log(`[scheduler] Queuing day-based send for enrollment ${enrollment.id}, status was: ${enrollment.status}`)
      smsQueue.add({
        phone: enrollment.leads.phone,
        message: messageBody,
        leadId: enrollment.leads.id,
        conversationId: null,
        userId: enrollment.user_id || null,
        fromNumber,
        enrollmentId: enrollment.id,
        currentStep: enrollment.current_step,

        sendFn: async (job) => {
          const result = await sendSMS(job.phone, job.message, job.fromNumber)
          if (!result.success) throw new Error(result.error || 'sendSMS failed')
          job._twilioSid = result.sid
        },

        onSuccess: async (job) => {
          const sentAt = new Date().toISOString()

          const { data: conversation } = await supabase
            .from('conversations')
            .upsert({ lead_id: job.leadId, user_id: job.userId, status: 'active' }, { onConflict: 'lead_id,user_id', ignoreDuplicates: false })
            .select('*').single()

          if (!conversation?.id) {
            console.error(`[scheduler] No conversation for lead ${job.leadId} — skipping DB log`)
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
          await bumpMessageCount(conversation.id)

          const leadUpdates = { updated_at: sentAt }
          if (canUpgrade(enrollment.leads.status, 'contacted')) leadUpdates.status = 'contacted'
          if (!enrollment.leads.first_message_sent) {
            leadUpdates.first_message_sent = true
            leadUpdates.first_message_sent_at = sentAt
          }
          leadUpdates.outbound_initiated_today = (enrollment.leads.outbound_initiated_today || 0) + 1
          await supabase.from('leads').update(leadUpdates).eq('id', job.leadId)

          const nextStep = job.currentStep + 1
          const isLastStep = nextStep >= messages.length
          if (isLastStep) {
            await supabase.from('campaign_leads').update({
              status: 'completed',
              current_step: nextStep,
              completed_at: sentAt
            }).eq('id', job.enrollmentId)
          } else {
            const nextMessage = messages[nextStep]
            const leadTimezone = safeTimezone(enrollment.leads.timezone)
            const nextSendAt = calculateSendTime(
              nextMessage.day_number,
              nextMessage.send_time || '10:00',
              enrollment.start_date,
              leadTimezone
            )
            await supabase.from('campaign_leads').update({
              current_step: nextStep,
              next_send_at: nextSendAt
            }).eq('id', job.enrollmentId)
          }
          messagesSent++
          console.log('[scheduler] Day-based send queued successfully for lead', job.leadId)
          if (job.userId) deductSmsCredit(job.userId, job.fromNumber, job.phone, null).catch(err => console.error('[credits] SMS deduction failed:', err.message))
        },

        onFailure: async (job, err) => {
          console.error('[scheduler] Day-based send failed for lead', job.leadId, err?.message)

          // Mark enrollment as failed so scheduler does not keep retrying this lead
          if (job.enrollmentId) {
            await supabase
              .from('campaign_leads')
              .update({
                status: 'failed',
                cancelled_reason: err?.message || 'send_failed'
              })
              .eq('id', job.enrollmentId)
          }

          // If invalid number — block the lead so no further sends are attempted
          const isInvalidNumber = err?.message && (
            err.message.includes('Invalid') ||
            err.message.includes('not a mobile') ||
            err.message.includes('opted out')
          )
          if (isInvalidNumber && job.leadId) {
            await supabase
              .from('leads')
              .update({
                is_blocked: true,
                notes: 'Auto-blocked: invalid phone number',
                updated_at: new Date().toISOString()
              })
              .eq('id', job.leadId)
            console.log('[scheduler] Auto-blocked lead with invalid number:', job.leadId)
          }
        },
      })
    }

    // Process one-off scheduled messages
    const { data: dueOneOff } = await supabase
      .from('scheduled_messages')
      .select('*, leads (id, first_name, phone, state, timezone, status, is_blocked, do_not_contact, outbound_initiated_today)')
      .eq('status', 'pending')
      .lte('send_at', now.toISOString())

    if (dueOneOff && dueOneOff.length > 0) {
      // Same per-user fairness cap for one-off scheduled messages
      const byUserOneOff = {}
      for (const sm of dueOneOff) {
        if (!sm.user_id) continue
        if (!byUserOneOff[sm.user_id]) byUserOneOff[sm.user_id] = []
        byUserOneOff[sm.user_id].push(sm)
      }
      const throttledOneOff = []
      for (const userMsgs of Object.values(byUserOneOff)) {
        throttledOneOff.push(...userMsgs.slice(0, RATE_PER_SECOND_PER_USER))
      }
      console.log(`[scheduler] tick: ${Object.keys(byUserOneOff).length} active users | ${throttledOneOff.length} jobs dispatched (one-off)`)

      for (const sm of throttledOneOff) {
        if (!sm.leads) continue
        if (sm.leads.status === 'opted_out' || sm.leads.is_blocked || sm.leads.do_not_contact) {
          await supabase.from('scheduled_messages').update({ status: 'cancelled' }).eq('id', sm.id)
          continue
        }

        // TCPA quiet hours — hard block on scheduled messages
        const smQuietCheck = isWithinQuietHours(sm.leads.state, safeTimezone(sm.leads.timezone))
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
        const smIsAiQueued = isAiQueued // capture loop var for closure
        const smSnapshot = sm         // capture loop var for closure
        smsQueue.add({
          phone: sm.leads.phone,
          message: sm.body,
          leadId: sm.leads.id,
          conversationId: sm.conversation_id || null,
          userId: sm.user_id || null,
          fromNumber,
          scheduledMessageId: sm.id,

          sendFn: async (job) => {
            const result = await sendSMS(job.phone, job.message, job.fromNumber)
            if (!result.success) throw new Error(result.error || 'sendSMS failed')
          },

          onSuccess: async (job) => {
            const sentAt = new Date().toISOString()
            messagesSent++
            await supabase.from('scheduled_messages').update({ status: 'sent', sent_at: sentAt }).eq('id', job.scheduledMessageId)
            const smLeadUpdates = { updated_at: sentAt }
            if (canUpgrade(smSnapshot.leads.status, 'contacted')) smLeadUpdates.status = 'contacted'
            if (!smIsAiQueued) {
              smLeadUpdates.outbound_initiated_today = (smSnapshot.leads.outbound_initiated_today || 0) + 1
            }
            await supabase.from('leads').update(smLeadUpdates).eq('id', job.leadId)
            if (job.conversationId) {
              await supabase.from('messages').insert({
                conversation_id: job.conversationId,
                user_id: job.userId,
                direction: 'outbound',
                body: job.message,
                sent_at: sentAt,
                status: 'sent'
              })
              await bumpMessageCount(job.conversationId)
              await supabase.from('conversations').update({ updated_at: sentAt }).eq('id', job.conversationId)
            }
            if (job.userId) deductSmsCredit(job.userId, job.fromNumber, job.phone, null).catch(err => console.error('[credits] SMS deduction failed:', err.message))
          },

          onFailure: async (job, err) => {
            errorsCount++
            console.error('[scheduler] One-off scheduled message failed for lead', job.leadId, err?.message)
            await supabase.from('scheduled_messages').update({ status: 'failed' }).eq('id', job.scheduledMessageId)
          },
        })
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


const checkPipelineGhosts = async () => {
  try {
    const now = new Date()
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString()

    // Find leads with a pipeline stage that haven't advanced in 24 hours
    const { data: stalled } = await supabase
      .from('leads')
      .select('id, pipeline_stage, pipeline_stage_set_at, user_id')
      .not('pipeline_stage', 'is', null)
      .eq('pipeline_ghosted', false)
      .not('pipeline_stage', 'in', '("sold","appointment_scheduled")')
      .neq('status', 'booked')
      .lte('pipeline_stage_set_at', oneDayAgo)

    if (!stalled || stalled.length === 0) return

    // Check each lead for recent inbound since stage was set
    for (const lead of stalled) {
      const { data: recentInbound } = await supabase
        .from('messages')
        .select('id')
        .eq('lead_id', lead.id)
        .eq('direction', 'inbound')
        .gte('sent_at', lead.pipeline_stage_set_at)
        .limit(1)

      // If no inbound since stage was set — mark as ghosted
      if (!recentInbound || recentInbound.length === 0) {
        await supabase.from('leads')
          .update({
            pipeline_ghosted: true,
            pipeline_ghosted_at: now.toISOString()
          })
          .eq('id', lead.id)
      }
    }

    console.log('[pipeline] Ghost check complete,', stalled.length, 'leads checked')
  } catch (err) {
    console.error('checkPipelineGhosts:', err.message)
  }
}

const checkColdLeads = async () => {
  try {
    const now = new Date()
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString()

    // Find conversations where autopilot is on, last outbound was 24h+ ago,
    // and the lead has not replied since the last outbound
    const { data: conversations } = await supabase
      .from('conversations')
      .select('id, lead_id, last_outbound_at, last_inbound_at, needs_agent_review')
      .eq('needs_agent_review', false)
      .not('last_outbound_at', 'is', null)
      .lte('last_outbound_at', oneDayAgo)

    if (!conversations || conversations.length === 0) return

    let coldCount = 0

    for (const conv of conversations) {
      // Skip if lead replied after our last outbound
      if (conv.last_inbound_at && new Date(conv.last_inbound_at) > new Date(conv.last_outbound_at)) continue

      // Load the lead — must have autopilot on, not already cold/blocked/opted-out
      const { data: lead } = await supabase
        .from('leads')
        .select('id, autopilot, is_cold, is_blocked, opted_out, do_not_contact, user_id')
        .eq('id', conv.lead_id)
        .single()

      if (!lead) continue
      if (!lead.autopilot) continue
      if (lead.is_cold || lead.is_blocked || lead.opted_out || lead.do_not_contact) continue

      // Fetch last 5 messages to count consecutive outbound at the tail
      const { data: recentMessages } = await supabase
        .from('messages')
        .select('direction')
        .eq('conversation_id', conv.id)
        .order('sent_at', { ascending: false })
        .limit(5)

      if (!recentMessages || recentMessages.length < 3) continue

      // Count how many consecutive outbound messages are at the end (most recent first)
      let consecutiveOutbound = 0
      for (const msg of recentMessages) {
        if (msg.direction === 'outbound') {
          consecutiveOutbound++
        } else {
          break
        }
      }

      if (consecutiveOutbound < 3) continue

      // Mark lead cold and turn off autopilot
      await supabase
        .from('leads')
        .update({ autopilot: false, is_cold: true, updated_at: now.toISOString() })
        .eq('id', lead.id)

      await supabase
        .from('conversations')
        .update({ needs_agent_review: true, handoff_reason: 'cold_lead', updated_at: now.toISOString() })
        .eq('id', conv.id)

      coldCount++
      console.log(`[coldLeads] Lead ${lead.id} marked cold after ${consecutiveOutbound} unanswered messages`)
    }

    if (coldCount > 0) console.log(`[coldLeads] ${coldCount} lead(s) marked cold`)
  } catch (err) {
    console.error('checkColdLeads error:', err.message)
  }
}

const scheduleDailyAt9am = () => {
  const now = new Date()
  const next9am = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 14, 0, 0)) // 9am ET = 14:00 UTC
  if (next9am <= now) next9am.setUTCDate(next9am.getUTCDate() + 1)
  const msUntil = next9am - now
  setTimeout(() => {
    checkColdLeads()
    scheduleDailyAt9am() // reschedule for next day
  }, msUntil)
  console.log(`[coldLeads] Next cold lead check scheduled in ${Math.round(msUntil / 60000)} minutes`)
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

// ─── CONVERSATION ARCHIVING (nightly @ 2am ET = 07:00 UTC) ──────────────────

const summarizeConversationForArchive = async (messages) => {
  try {
    const Anthropic = require('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    const transcript = messages.map(m => {
      const who = m.direction === 'inbound' ? 'Lead' : (m.direction === 'system' ? 'System' : 'Agent')
      return `${who}: ${m.body}`
    }).join('\n')

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Summarize this insurance sales conversation in 2-3 sentences. Include: lead's insurance needs, household info mentioned, any quotes discussed, current status, and last known intent. Be specific with numbers and dates.\n\n---\n${transcript}\n---`
      }]
    })
    return response.content[0]?.text?.trim() || null
  } catch (err) {
    console.error('[archive] summarize error:', err.message)
    return null
  }
}

const archiveOldConversations = async () => {
  try {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
    const { data: batch, error } = await supabase
      .from('conversations')
      .select('id, updated_at, message_count')
      .is('archived_at', null)
      .gt('message_count', 0)
      .lt('updated_at', cutoff)
      .limit(100)

    if (error) {
      console.error('[archive] query error:', error.message)
      return
    }
    if (!batch || batch.length === 0) {
      console.log('[archive] nothing to archive')
      return
    }

    console.log(`[archive] processing ${batch.length} conversation(s)`)
    let archivedCount = 0
    let failedCount = 0

    for (const conv of batch) {
      try {
        // STEP 1 — summary from last 50 messages
        const { data: recentMessages } = await supabase
          .from('messages')
          .select('direction, body, sent_at')
          .eq('conversation_id', conv.id)
          .order('sent_at', { ascending: false })
          .limit(50)
        const messagesForSummary = (recentMessages || []).slice().reverse()

        const summary = messagesForSummary.length > 0
          ? await summarizeConversationForArchive(messagesForSummary)
          : null

        if (summary) {
          await supabase.from('conversations').update({ summary }).eq('id', conv.id)
        }

        // STEP 2 — copy messages to archive, then delete originals
        const { data: allMessages } = await supabase
          .from('messages').select('*').eq('conversation_id', conv.id)

        if (allMessages && allMessages.length > 0) {
          const { error: insertErr } = await supabase.from('messages_archive').insert(allMessages)
          if (insertErr) {
            console.error(`[archive] insert_archive failed for conv ${conv.id}:`, insertErr.message)
            failedCount++
            continue
          }
          const { error: delErr } = await supabase.from('messages').delete().eq('conversation_id', conv.id)
          if (delErr) {
            console.error(`[archive] delete_messages failed for conv ${conv.id}:`, delErr.message)
            failedCount++
            continue
          }
        }

        // STEP 3 — mark conversation archived
        await supabase.from('conversations')
          .update({ archived_at: new Date().toISOString() })
          .eq('id', conv.id)

        archivedCount++
      } catch (convErr) {
        failedCount++
        console.error(`[archive] conv ${conv.id} error:`, convErr.message)
      }
    }

    console.log(`[archive] done — archived: ${archivedCount}, failed: ${failedCount}`)
  } catch (err) {
    console.error('[archive] fatal:', err.message)
  }
}

const scheduleDailyAt2am = () => {
  const now = new Date()
  // 2am ET = 07:00 UTC (close enough year-round; DST drift is 1 hour but not critical for archiving)
  const next2am = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 7, 0, 0))
  if (next2am <= now) next2am.setUTCDate(next2am.getUTCDate() + 1)
  const msUntil = next2am - now
  setTimeout(() => {
    archiveOldConversations()
    scheduleDailyAt2am()
  }, msUntil)
  console.log(`[archive] next run scheduled in ${Math.round(msUntil / 60000)} minutes`)
}

// ─── DISPOSITION DRIPS ──────────────────────────────────────────────────────

const processDrips = async () => {
  try {
    // Get all drip definitions
    const { data: allDrips, error: dripsErr } = await supabase
      .from('disposition_drips')
      .select('*, disposition_tags (id, name, color)')
    if (dripsErr || !allDrips || allDrips.length === 0) return

    const now = new Date()
    let sent = 0
    let skipped = 0

    for (const drip of allDrips) {
      // Find leads that had this disposition applied exactly day_number days ago
      const targetDate = new Date(now)
      targetDate.setDate(targetDate.getDate() - drip.day_number)
      const dayStart = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate(), 0, 0, 0))
      const dayEnd = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate(), 23, 59, 59))

      // For day 0 drips, look at leads dispositioned in the last 5 minutes (handled per scheduler tick)
      let matchQuery
      if (drip.day_number === 0) {
        const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString()
        matchQuery = supabase
          .from('lead_dispositions')
          .select('lead_id')
          .eq('disposition_tag_id', drip.disposition_tag_id)
          .gte('applied_at', fiveMinAgo)
      } else {
        matchQuery = supabase
          .from('lead_dispositions')
          .select('lead_id')
          .eq('disposition_tag_id', drip.disposition_tag_id)
          .gte('applied_at', dayStart.toISOString())
          .lte('applied_at', dayEnd.toISOString())
      }

      const { data: matches } = await matchQuery
      if (!matches || matches.length === 0) continue

      const leadIds = [...new Set(matches.map(m => m.lead_id))]

      // Check which leads already received this drip
      const { data: alreadySent } = await supabase
        .from('disposition_drip_sends')
        .select('lead_id')
        .eq('drip_id', drip.id)
        .in('lead_id', leadIds)
      const sentSet = new Set((alreadySent || []).map(s => s.lead_id))

      const unsent = leadIds.filter(id => !sentSet.has(id))
      if (unsent.length === 0) continue

      // Get lead details
      const { data: leads } = await supabase
        .from('leads')
        .select('*')
        .in('id', unsent)
        .eq('opted_out', false)
        .eq('is_blocked', false)
        .eq('is_sold', false)
        .eq('do_not_contact', false)

      if (!leads || leads.length === 0) continue

      for (const lead of leads) {
        try {
          // Check quiet hours
          const tz = lead.timezone || 'America/New_York'
          if (isWithinQuietHours && isWithinQuietHours(tz)) {
            skipped++
            continue
          }

          // Resolve variables — [Var] format (primary) + {var} format (backward compat)
          let body = drip.message_body
            .replace(/\[First Name\]/gi, lead.first_name || 'there')
            .replace(/\[Last Name\]/gi, lead.last_name || '')
            .replace(/\[Phone\]/gi, lead.phone || '')
            .replace(/\[Email\]/gi, lead.email || '')
            .replace(/\[State\]/gi, lead.state || '')
            .replace(/\[Zip Code\]/gi, lead.zip_code || '')
            .replace(/\[Date of Birth\]/gi, lead.date_of_birth || '')
            .replace(/\{first_name\}/gi, lead.first_name || 'there')
            .replace(/\{last_name\}/gi, lead.last_name || '')
            .replace(/\{phone\}/gi, lead.phone || '')
            .replace(/\{email\}/gi, lead.email || '')
            .replace(/\{state\}/gi, lead.state || '')
            .replace(/\{zip_code\}/gi, lead.zip_code || '')
            .replace(/\{date_of_birth\}/gi, lead.date_of_birth || '')

          const fromNumber = await pickNumberForLead(lead.user_id, lead.state)
          if (!fromNumber) {
            console.error(`[drips] No from number for user ${lead.user_id}`)
            continue
          }

          // Get user profile for compliance footer
          const { data: profile } = await supabase
            .from('user_profiles')
            .select('*')
            .eq('id', lead.user_id)
            .single()

          if (profile && buildMessageBody) {
            body = buildMessageBody(body, profile, lead, !lead.first_message_sent)
          }

          const smsResult = await sendSMS(lead.phone, body, fromNumber)

          if (smsResult.success) {
            // Record send to prevent duplicates
            await supabase.from('disposition_drip_sends').insert({
              drip_id: drip.id,
              lead_id: lead.id
            }).catch(() => {}) // UNIQUE constraint = already sent

            // Create conversation/message record
            let { data: conversation } = await supabase
              .from('conversations')
              .select('id')
              .eq('lead_id', lead.id)
              .eq('user_id', lead.user_id)
              .single()

            if (!conversation) {
              const { data: newConv } = await supabase
                .from('conversations')
                .insert({ lead_id: lead.id, user_id: lead.user_id, status: 'active' })
                .select('id')
                .single()
              conversation = newConv
            }

            if (conversation) {
              await supabase.from('messages').insert({
                conversation_id: conversation.id,
                user_id: lead.user_id,
                direction: 'outbound',
                body,
                sent_at: new Date().toISOString(),
                twilio_sid: smsResult.sid,
                status: 'sent',
                is_ai: false
              })
              await bumpMessageCount(conversation.id)
            }

            // Update lead status
            await supabase.from('leads').update({
              status: lead.status === 'new' ? 'contacted' : lead.status,
              first_message_sent: true,
              last_contacted_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }).eq('id', lead.id)

            sent++
          }
        } catch (err) {
          console.error(`[drips] Error sending drip ${drip.id} to lead ${lead.id}:`, err.message)
        }
      }
    }

    if (sent > 0 || skipped > 0) {
      console.log(`[drips] processDrips complete: ${sent} sent, ${skipped} skipped (quiet hours)`)
    }
  } catch (err) {
    console.error('[drips] processDrips error:', err.message)
  }
}

// ─── Concurrency guards — prevent overlapping scheduler ticks ─────────────────
let isProcessingScheduled = false
let isProcessingGhosted = false
let isProcessingQuickFollowups = false
let isProcessingColdLeads = false
let isProcessingDrips = false

const guardedProcessScheduledMessages = async () => {
  if (isProcessingScheduled) {
    console.log('[scheduler] processScheduledMessages already running — skipping tick')
    return
  }
  isProcessingScheduled = true
  try {
    await processScheduledMessages()
  } finally {
    isProcessingScheduled = false
  }
}

const guardedCheckGhostedConversations = async () => {
  if (isProcessingGhosted) {
    console.log('[scheduler] checkGhostedConversations already running — skipping tick')
    return
  }
  isProcessingGhosted = true
  try {
    await checkGhostedConversations()
  } finally {
    isProcessingGhosted = false
  }
}

const guardedProcessQuickFollowups = async () => {
  if (isProcessingQuickFollowups) {
    console.log('[scheduler] processQuickFollowups already running — skipping tick')
    return
  }
  isProcessingQuickFollowups = true
  try {
    await processQuickFollowups()
  } finally {
    isProcessingQuickFollowups = false
  }
}

const guardedCheckColdLeads = async () => {
  if (isProcessingColdLeads) {
    console.log('[scheduler] checkColdLeads already running — skipping')
    return
  }
  isProcessingColdLeads = true
  try {
    await checkColdLeads()
  } finally {
    isProcessingColdLeads = false
  }
}

const guardedProcessDrips = async () => {
  if (isProcessingDrips) {
    console.log('[scheduler] processDrips already running — skipping')
    return
  }
  isProcessingDrips = true
  try {
    await processDrips()
  } finally {
    isProcessingDrips = false
  }
}

// ─── AI DEBOUNCE WORKER ────────────────────────────────────────────────
// Replaces the old in-memory setTimeout-based debounce with DB polling so
// AI responses survive deploys/restarts. Every inbound message resets
// conversations.ai_pending_at to NOW. This job fires when that timestamp
// is 45+ seconds old, meaning the lead has stopped typing.
const AI_DEBOUNCE_QUIET_MS = 45000

const processPendingAiResponses = async () => {
  try {
    const cutoff = new Date(Date.now() - AI_DEBOUNCE_QUIET_MS).toISOString()
    const { data: pending, error } = await supabase
      .from('conversations')
      .select('id, ai_pending_at')
      .not('ai_pending_at', 'is', null)
      .lt('ai_pending_at', cutoff)
      .limit(10)
    if (error) {
      console.error('[AI poller] query error:', error.message)
      return
    }
    console.log('[AI poller] tick — checked, found:', pending?.length || 0, 'pending')
    if (!pending || pending.length === 0) return

    let processPendingAi
    try {
      ({ processPendingAi } = require('./controllers/messagesController'))
      if (typeof processPendingAi !== 'function') {
        console.error('[AI poller] processPendingAi is not a function — export missing from messagesController')
        return
      }
    } catch (err) {
      console.error('[AI poller] failed to require messagesController:', err.message)
      return
    }

    for (const conv of pending) {
      // Claim: clear the flag only if it hasn't moved (no newer inbound during
      // our scan). If the update returns zero rows, someone else grabbed it
      // or a new inbound reset the timer — skip this tick.
      const { data: claimed } = await supabase
        .from('conversations')
        .update({ ai_pending_at: null })
        .eq('id', conv.id)
        .eq('ai_pending_at', conv.ai_pending_at)
        .select('id')
      if (!claimed || claimed.length === 0) {
        continue
      }
      try {
        console.log(`[AI poller] processing conv ${conv.id}`)
        await processPendingAi(conv.id)
      } catch (err) {
        console.error(`[AI poller] processPendingAi threw for conv ${conv.id}:`, err.message)
      }
    }
  } catch (err) {
    console.error('[AI poller] processPendingAiResponses error:', err.message)
  }
}

const startScheduler = () => {
  console.log('Campaign scheduler started — master Twilio account active')
  setInterval(guardedProcessScheduledMessages, 90000)   // every 90 seconds
  setInterval(guardedCheckGhostedConversations, 120000) // every 2 minutes
  setInterval(guardedProcessQuickFollowups, 60000)
  setInterval(checkPipelineGhosts, 120000)              // every 2 minutes

  setInterval(guardedProcessDrips, 300000)              // every 5 minutes
  setInterval(processPendingAiResponses, 15000)         // every 15 seconds — AI debounce worker
  console.log('[AI poller] Started — polling every 15 seconds')

  scheduleMidnightReset()
  scheduleDailyAt9am()
  scheduleDailyAt2am()
  guardedProcessScheduledMessages()
  guardedProcessQuickFollowups()
  guardedCheckGhostedConversations()
  checkPipelineGhosts()
  guardedCheckColdLeads()
  guardedProcessDrips()
  processPendingAiResponses()
}

module.exports = { startScheduler }
