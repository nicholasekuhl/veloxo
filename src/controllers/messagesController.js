const supabase = require('../db')
const { sendSMS, buildMessageBody, getMasterClient, getNumberForLead } = require('../twilio')
const { createNotification } = require('../notifications')
const { spintext } = require('../spintext')
const { isWithinQuietHours, getNextSendWindow } = require('../compliance')
const { getOrCreateOptOutBucket } = require('./leadsController')
const { detectPipelineStage, extractLeadDataFromHistory, generateNoteSummary, STAGE_ORDER } = require('../pipeline')

const isPositiveEngagement = (history) => {
  const recentInbound = history.filter(m => m.role === 'user').slice(-5)
  const buyingSignals = [
    'how much', 'what does it cost', 'what would i pay', 'sounds good', 'interested',
    'tell me more', 'what are my options', 'i want', 'sign me up', "let's do it",
    'when can we', 'book', 'schedule', 'call me', 'yes', 'yeah', 'sure', 'okay',
    'ok', "i'd like", 'i would like', 'that works', 'works for me', 'can you',
    'send me', "what's included", 'what is included', 'deductible', 'premium',
    'coverage', 'plan', 'quote', 'how does', 'what about'
  ]
  return recentInbound.some(m =>
    buyingSignals.some(signal => m.content.toLowerCase().includes(signal))
  )
}

const autoExtractLeadData = async (lead, message) => {
  try {
    const updates = {}
    const zipMatch = message.match(/\b(\d{5})\b/)
    if (zipMatch && !lead.zip_code) updates.zip_code = zipMatch[1]
    const stateMatch = message.match(/\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/)
    if (stateMatch && !lead.state) updates.state = stateMatch[1]
    const incomeMatch = message.match(/\$?([\d,]+)\s*(?:k|thousand|a year|\/year|per year|annually|annual income)/i) ||
                        message.match(/(?:make|earn|income|salary)\s+(?:about|around|roughly)?\s*\$?([\d,]+)/i)
    if (incomeMatch && !lead.income) {
      let inc = incomeMatch[1].replace(/,/g, '')
      if (/k\b/i.test(message) || parseInt(inc) < 1000) inc = String(parseInt(inc) * 1000)
      updates.income = parseInt(inc)
    }
    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString()
      await supabase.from('leads').update(updates).eq('id', lead.id)
      console.log('Auto-extracted lead data:', updates)
    }
  } catch (err) {
    console.error('autoExtractLeadData error:', err.message)
  }
}

const getInitialMessage = (lead) => {
  const firstName = lead.first_name || 'there'
  return `Hi ${firstName}! I saw you were exploring your options and I'd love to help find the right fit for your needs and budget. Do you have a few minutes to connect?`
}


const sendInitialOutreach = async (req, res) => {
  try {
    const { leadId } = req.params
    const { data: lead, error: leadError } = await supabase
      .from('leads').select('*').eq('id', leadId).eq('user_id', req.user.id).single()
    if (leadError || !lead) return res.status(404).json({ error: 'Lead not found' })
    if (lead.opted_out) return res.status(403).json({ error: 'Lead has opted out. Message not sent.' })
    if (lead.status !== 'new') return res.status(400).json({ error: 'Lead has already been contacted' })

    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .upsert({ lead_id: leadId, user_id: req.user.id, status: 'active' }, { onConflict: 'lead_id,user_id', ignoreDuplicates: false })
      .select('*').single()
    if (convError) throw convError

    const fromNumber = await getNumberForLead(req.user.id, lead.state)
    const rawBody = getInitialMessage(lead)
    const messageBody = buildMessageBody(rawBody, req.user.profile, lead, true)
    const result = await sendSMS(lead.phone, messageBody, fromNumber)
    if (!result.success) return res.status(500).json({ error: result.error })

    const sentAt = new Date().toISOString()
    await supabase.from('messages').insert({
      conversation_id: conversation.id,
      user_id: req.user.id,
      direction: 'outbound',
      body: messageBody,
      sent_at: sentAt,
      twilio_sid: result.sid,
      status: 'sent'
    })

    await Promise.all([
      supabase.from('leads').update({
        status: 'contacted',
        first_message_sent: true,
        updated_at: sentAt
      }).eq('id', leadId),
      supabase.from('conversations')
        .update({ updated_at: sentAt, last_outbound_at: sentAt })
        .eq('id', conversation.id)
    ])

    res.json({ success: true, message: `Initial outreach sent to ${lead.first_name} ${lead.last_name}`, phone: lead.phone })
  } catch (err) {
    console.error('Outreach error:', err)
    res.status(500).json({ error: err.message })
  }
}

const checkHandoffTriggers = (conversation, lastInboundMessage, history, profile) => {
  const msg = lastInboundMessage.toLowerCase()
  const agentName = profile?.agent_name || 'your agent'
  const agentFirstName = profile?.agent_nickname || agentName.split(' ')[0]
  const fullText = history.map(m => m.content).join(' ').toLowerCase()

  // TRIGGER 0: Soft decline / not interested
  const softDeclinePhrases = [
    "not interested", "no thank you", "no thanks",
    "i'm all set", "im all set", "all set thanks",
    "leave me alone", "dont text me", "remove me",
    "unsubscribe", "i'm good", "im good",
    "all set", "already covered", "already have insurance",
    "not right now", "maybe later", "never mind", "nevermind",
    "no longer interested", "found something", "got covered",
    "went with someone else", "not looking",
    "don't need it", "dont need it", "good for now",
    "not anymore", "already enrolled", "got a plan"
  ]
  const isSoftDecline = softDeclinePhrases.some(p => msg.includes(p))
  if (isSoftDecline) {
    return { triggered: true, reason: 'soft_decline', message: null }
  }

  // TRIGGER 1: Appointment confirmed
  if (conversation.appointment_confirmed) {
    return {
      triggered: true,
      reason: 'appointment_confirmed',
      message: `Perfect, I've got everything noted. ${agentFirstName} will be in touch and can walk you through everything from here. Looking forward to connecting you!`
    }
  }

  // TRIGGER 2: Quote requested — only hand off after 2 pushbacks
  const quotePhrases = ['how much', "what's the price", 'give me a quote', 'what would it cost', 'send me options', 'what are my options', 'can you send', 'email me', 'just send it']
  if (quotePhrases.some(p => msg.includes(p))) {
    if ((conversation.quote_push_count || 0) >= 2) {
      return {
        triggered: true,
        reason: 'quote_requested',
        message: `Absolutely — ${agentFirstName} can put that together on a quick call so the numbers actually make sense for your specific situation. When works best for you?`
      }
    }
    return { triggered: false, quoteDetected: true }
  }

  // TRIGGER 3: Complex medical
  const medicalPhrases = ['surgery', 'procedure', 'diagnosed', 'condition', 'prescription', 'specialist', 'will this cover', 'does this cover']
  const medSuffixPattern = /\b\w+(mab|pril|statin|zole|pine)\b/i
  if (medicalPhrases.some(p => msg.includes(p)) || medSuffixPattern.test(msg)) {
    return {
      triggered: true,
      reason: 'complex_medical',
      message: `That's really helpful context. The right plan really does depend on your specific situation — ${agentFirstName} can make sure you're matched with the right coverage. Do you prefer a quick review later today or tomorrow?`
    }
  }

  // TRIGGER 4: Frustration / profanity
  const frustrationPhrases = ['already told', 'i said', 'you keep', 'just tell me', 'forget it', 'this is annoying', 'stop texting']
  const hasProfanity = /fuck|shit|ass|bitch|damn|hell|crap|wtf|stfu|piss/i.test(msg)
  const hasFrustration = frustrationPhrases.some(p => msg.includes(p))
  if (hasProfanity) {
    return { triggered: true, reason: 'soft_decline', message: null }
  }
  if (hasFrustration) {
    return { triggered: true, reason: 'frustration_detected', message: null }
  }

  // TRIGGER 5: Qualification complete — all 5 data points present in history
  const hasCoverageType = /\b(individual|family|just me|me and|my family|myself|spouse|kids|children)\b/.test(fullText)
  const hasZip = /\b\d{5}\b/.test(fullText)
  const hasIncome = /\$[\d,]+|\d+k\b|\d[\d,]{2,}|\bincome\b/.test(fullText)
  const hasMeds = /\b(none|no meds|no medications|no conditions|healthy|no prescriptions|taking|prescription|medication|no issues)\b/.test(fullText)
  const hasBudget = /\$[\d,]+|budget|\baffordable\b|\bcheap\b|\blow.{0,10}cost|\blow.{0,10}premium/.test(fullText)
  if (hasCoverageType && hasZip && hasIncome && hasMeds && hasBudget) {
    return {
      triggered: true,
      reason: 'qualification_complete',
      message: `Perfect, I've got everything noted. ${agentFirstName} will be in touch and can walk you through everything from here. Looking forward to connecting you!`
    }
  }

  // TRIGGER 6: Consecutive followups
  if ((conversation.consecutive_followups || 0) >= 2) {
    return { triggered: true, reason: 'unresponsive_after_followups', message: null }
  }

  return { triggered: false }
}

const executeHandoff = async (lead, conversation, handoff, fromNumber) => {
  try {
    if (handoff.reason === 'soft_decline') {
      console.log('Soft decline detected for lead:', lead.id, '— stopping all outreach')
      const now = new Date().toISOString()
      const optOutBucketId = await getOrCreateOptOutBucket(lead.user_id)
      await Promise.all([
        supabase.from('conversations').update({
          needs_agent_review: false,
          handoff_reason: 'soft_decline',
          status: 'closed',
          updated_at: now
        }).eq('id', conversation.id),
        supabase.from('leads').update({
          opted_out: true,
          status: 'opted_out',
          is_cold: true,
          autopilot: false,
          opted_out_at: now,
          updated_at: now,
          ...(optOutBucketId ? { bucket_id: optOutBucketId } : {})
        }).eq('id', lead.id),
        supabase.from('campaign_leads').update({
          status: 'cancelled'
        }).eq('lead_id', lead.id).in('status', ['pending', 'active'])
      ])
      return
    }

    await supabase.from('conversations').update({
      needs_agent_review: true,
      handoff_reason: handoff.reason,
      updated_at: new Date().toISOString()
    }).eq('id', conversation.id)

    await supabase.from('leads').update({
      autopilot: false,
      updated_at: new Date().toISOString()
    }).eq('id', lead.id)

    if (handoff.message) {
      const result = await sendSMS(lead.phone, handoff.message, fromNumber)
      if (result.success) {
        await supabase.from('messages').insert({
          conversation_id: conversation.id,
          user_id: lead.user_id,
          direction: 'outbound',
          body: handoff.message,
          sent_at: new Date().toISOString(),
          is_ai: true,
          twilio_sid: result.sid,
          status: 'sent'
        })
      }
    }

    console.log(`Handoff triggered for lead ${lead.id}: ${handoff.reason}`)
  } catch (err) {
    console.error('Handoff execution error:', err.message)
  }
}

const processInboundMessage = async (body) => {
  try {
    const { From, Body } = body
    const toNumber = body.To || body.to

    if (!toNumber) {
      console.log('Full webhook body:', JSON.stringify(body))
      return
    }

    // Look up which user owns this number via phone_numbers table
    let userId = null
    let profile = null
    const fromNumber = toNumber

    const { data: phoneRecord } = await supabase
      .from('phone_numbers')
      .select('user_id')
      .eq('phone_number', toNumber)
      .eq('is_active', true)
      .single()

    if (phoneRecord) {
      userId = phoneRecord.user_id
      const { data: userProfile } = await supabase.from('user_profiles').select('*').eq('id', userId).single()
      profile = userProfile
    }

    if (!userId) {
      console.log(`Incoming message to unrecognized number ${toNumber} — ignoring`)
      return
    }

    if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(Body.trim().toUpperCase())) {
      const now = new Date().toISOString()
      const optOutBucketId = await getOrCreateOptOutBucket(userId)
      await supabase.from('leads')
        .update({ status: 'opted_out', opted_out: true, opted_out_at: now, autopilot: false, updated_at: now, ...(optOutBucketId ? { bucket_id: optOutBucketId } : {}) })
        .eq('phone', From).eq('user_id', userId)
      const { data: stoppedLead } = await supabase.from('leads').select('id').eq('phone', From).eq('user_id', userId).single()
      if (stoppedLead) {
        await supabase.from('campaign_leads')
          .update({ status: 'cancelled' })
          .eq('lead_id', stoppedLead.id).in('status', ['pending', 'active'])
      }
      return
    }

    let { data: lead } = await supabase.from('leads').select('*').eq('phone', From).eq('user_id', userId).single()
    if (!lead) {
      return
    }

    console.log('Inbound message received for lead:', lead.id)
    console.log('Lead autopilot status:', lead.autopilot)
    console.log('ANTHROPIC_API_KEY exists:', !!process.env.ANTHROPIC_API_KEY)
    console.log('User profile agent_name:', profile?.agent_name)

    // Blocked leads: log message but never respond
    if (lead.is_blocked) {
      const { data: blockedConv } = await supabase
        .from('conversations')
        .upsert({ lead_id: lead.id, user_id: userId, status: 'active' }, { onConflict: 'lead_id,user_id', ignoreDuplicates: false })
        .select('id').single()
      if (blockedConv) {
        await supabase.from('messages').insert({
          conversation_id: blockedConv.id,
          user_id: userId,
          direction: 'inbound',
          body: Body,
          sent_at: new Date().toISOString()
        })
        await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', blockedConv.id)
      }
      return
    }

    // Handle active campaign enrollments on reply
    let needsCampaignReplyNotif = false
    const { data: activeEnrollments } = await supabase
      .from('campaign_leads')
      .select('id, campaign_id, campaigns(cancel_on_reply)')
      .eq('lead_id', lead.id)
      .in('status', ['pending', 'active'])
    if (activeEnrollments && activeEnrollments.length > 0) {
      const now = new Date().toISOString()
      for (const enrollment of activeEnrollments) {
        const cancelOnReply = enrollment.campaigns?.cancel_on_reply !== false
        if (cancelOnReply) {
          await supabase.from('campaign_leads')
            .update({ status: 'completed', completed_at: now, cancelled_reason: 'lead_replied' })
            .eq('id', enrollment.id)
          if (!lead.autopilot) needsCampaignReplyNotif = true
        } else {
          await supabase.from('campaign_leads')
            .update({ status: 'paused', paused_at: now })
            .eq('id', enrollment.id)
        }
      }
      console.log(`Campaign enrollments processed on reply for lead: ${lead.id} (${activeEnrollments.length} enrollment(s))`)
    }

    let { data: conversation } = await supabase
      .from('conversations')
      .upsert({ lead_id: lead.id, user_id: userId, status: 'active' }, { onConflict: 'lead_id,user_id', ignoreDuplicates: false })
      .select('*').single()

    // Reset consecutive followups — lead responded
    if (conversation.consecutive_followups > 0) {
      await supabase.from('conversations')
        .update({ consecutive_followups: 0 })
        .eq('id', conversation.id)
      conversation = { ...conversation, consecutive_followups: 0 }
    }

    await supabase.from('messages').insert({
      conversation_id: conversation.id,
      user_id: userId,
      direction: 'inbound',
      body: Body,
      sent_at: new Date().toISOString()
    })

    const nowIso = new Date().toISOString()
    await supabase.from('conversations')
      .update({
        updated_at: nowIso,
        unread_count: (conversation.unread_count || 0) + 1,
        last_inbound_at: nowIso,
        followup_count: 0,
        followup_stage: 'none',
        engagement_status: 'active'
      })
      .eq('id', conversation.id)
    conversation = { ...conversation, followup_count: 0, followup_stage: 'none', engagement_status: 'active' }

    // Auto-extract structured data from inbound message
    autoExtractLeadData(lead, Body)

    // Upgrade lead status to 'replied' if new or contacted
    const STATUS_PRIORITY = { new: 0, contacted: 1, replied: 2, booked: 3, sold: 4 }
    if ((STATUS_PRIORITY[lead.status] ?? 0) < STATUS_PRIORITY.replied) {
      await supabase.from('leads').update({
        status: 'replied',
        has_replied: true,
        updated_at: new Date().toISOString()
      }).eq('id', lead.id)
      lead = { ...lead, status: 'replied', has_replied: true }
    }

    // In-app notification
    if (profile?.inapp_notifications_enabled !== false) {
      const leadName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.phone
      console.log('Creating notification for user:', userId)
      createNotification(userId, 'inbound_message', `${leadName} replied`, Body.slice(0, 100), lead.id, conversation.id)
    }

    // Campaign reply notification (autopilot off + cancel_on_reply)
    if (needsCampaignReplyNotif) {
      const leadName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.phone
      createNotification(userId, 'campaign_reply', 'Campaign reply needs follow-up', `${leadName} replied to your campaign and needs a manual response`, lead.id, conversation.id)
    }

    // SMS forwarding — non-blocking, never delays main flow
    if (profile?.sms_notifications_enabled === true && profile?.personal_phone && lead.status !== 'opted_out') {
      const forwardingNumber = (process.env.FORWARDING_NUMBER || '').trim()
      if (!forwardingNumber) {
        console.log('SMS forward skipped — FORWARDING_NUMBER env var not set')
      } else {
        const agencyName = profile.agency_name || 'TextApp'
        const msgBody = Body.length > 100 ? Body.slice(0, 100) + '...' : Body
        const leadName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || ''
        const forwardText = `${agencyName}: msg from ${leadName} ${lead.phone}: ${msgBody}`.trim()
        sendSMS(profile.personal_phone, forwardText, process.env.FORWARDING_NUMBER)
      }
    }

    // Stop AI if already handed off
    if (conversation.needs_agent_review) {
      return
    }

    if (lead.autopilot && profile) {
      const { data: messages } = await supabase
        .from('messages').select('*')
        .eq('conversation_id', conversation.id)
        .order('sent_at', { ascending: true })

      const history = (messages || []).map(m => ({
        role: m.direction === 'inbound' ? 'user' : 'assistant',
        content: m.body
      }))
      console.log('Conversation history loaded:', history.length, 'messages')

      // Check handoff triggers before generating AI response
      const handoff = checkHandoffTriggers(conversation, Body, history, profile)

      if (handoff.quoteDetected) {
        const newCount = (conversation.quote_push_count || 0) + 1
        await supabase.from('conversations')
          .update({ quote_push_count: newCount })
          .eq('id', conversation.id)
        conversation = { ...conversation, quote_push_count: newCount }
      }

      if (handoff.triggered) {
        await executeHandoff(lead, conversation, handoff, fromNumber)
      } else {
        const aiResponse = await generateAIResponse(lead, history, profile, Body)

        if (aiResponse) {
          // Check quiet hours — queue if outside window and user prefers queuing
          const quietCheck = isWithinQuietHours(lead.state, lead.timezone)
          const afterHoursSetting = profile.ai_afterhours_response || 'queue'

          if (quietCheck.blocked && afterHoursSetting === 'queue') {
            const nextWindow = getNextSendWindow(lead.state, lead.timezone)
            const aiBody = buildMessageBody(removeExcessEmojis(naturalizeText(aiResponse)), profile, lead, false)
            await supabase.from('scheduled_messages').insert({
              user_id: userId,
              lead_id: lead.id,
              conversation_id: conversation.id,
              body: aiBody,
              scheduled_at: nextWindow,
              send_at: nextWindow,
              status: 'pending',
              notes: 'AI response queued — outside quiet hours'
            })
            console.log(`AI response queued until ${nextWindow} for lead ${lead.id} (${quietCheck.reason})`)
            return
          }

          // Delay scales with message length to feel more human
          const wordCount = aiResponse.split(' ').length
          const baseDelay = 12000
          const perWordDelay = 800
          const maxDelay = 75000
          const jitter = Math.floor(Math.random() * 6000)
          const delay = Math.min(baseDelay + (wordCount * perWordDelay) + jitter, maxDelay)
          await new Promise(resolve => setTimeout(resolve, delay))

          const aiBody = buildMessageBody(removeExcessEmojis(naturalizeText(aiResponse)), profile, lead, false)
          const result = await sendSMS(lead.phone, aiBody, fromNumber)
          if (result.success) {
            await supabase.from('messages').insert({
              conversation_id: conversation.id,
              user_id: userId,
              direction: 'outbound',
              body: aiBody,
              sent_at: new Date().toISOString(),
              is_ai: true,
              twilio_sid: result.sid,
              status: 'sent'
            })
            if (!lead.first_message_sent) {
              await supabase.from('leads').update({ first_message_sent: true }).eq('id', lead.id)
              lead = { ...lead, first_message_sent: true }
            }
            await supabase.from('conversations')
              .update({ updated_at: new Date().toISOString(), last_outbound_at: new Date().toISOString() })
              .eq('id', conversation.id)

            // ─── PIPELINE STAGE DETECTION ────────────────────────────────────
            try {
              const { data: allMessages } = await supabase
                .from('messages')
                .select('direction, body')
                .eq('conversation_id', conversation.id)
                .order('sent_at', { ascending: true })

              const newStage = detectPipelineStage(lead, allMessages || [])
              const pipelineUpdates = {}

              // Only advance stage, never go backward
              if (newStage) {
                const currentOrder = STAGE_ORDER.indexOf(lead.pipeline_stage)
                const newOrder = STAGE_ORDER.indexOf(newStage)
                if (newOrder > currentOrder) {
                  pipelineUpdates.pipeline_stage = newStage
                  pipelineUpdates.pipeline_stage_set_at = new Date().toISOString()
                  pipelineUpdates.pipeline_ghosted = false
                  pipelineUpdates.pipeline_ghosted_at = null
                }
              }

              // Extract any new structured data
              const extracted = extractLeadDataFromHistory(lead, allMessages || [])
              if (extracted) Object.assign(pipelineUpdates, extracted)

              // Append AI note if stage changed or new data extracted
              const stageChanged = newStage && newStage !== lead.pipeline_stage
              if (stageChanged || extracted) {
                const summary = generateNoteSummary(
                  { ...lead, ...pipelineUpdates },
                  pipelineUpdates.pipeline_stage || lead.pipeline_stage || newStage
                )
                const timestamp = new Date().toLocaleString('en-US', {
                  month: 'short', day: 'numeric',
                  hour: 'numeric', minute: '2-digit', hour12: true
                })
                const noteEntry = '[Auto ' + timestamp + '] ' + summary
                pipelineUpdates.notes = lead.notes
                  ? lead.notes + '\n' + noteEntry
                  : noteEntry
              }

              if (Object.keys(pipelineUpdates).length > 0) {
                await supabase.from('leads').update(pipelineUpdates).eq('id', lead.id)
              }
            } catch (pipelineErr) {
              console.error('Pipeline detection error:', pipelineErr.message)
            }
            // ─────────────────────────────────────────────────────────────────

            // Check if conversation just confirmed an appointment
            const { data: conv } = await supabase.from('conversations').select('appointment_confirmed').eq('id', conversation.id).single()
            if (!conv?.appointment_confirmed) {
              const hasDay = /monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|tonight|this evening|this morning|this afternoon|next week/i.test(aiBody)
              const hasTime = /\d{1,2}(:\d{2})?\s*(am|pm)|noon|morning|afternoon/i.test(aiBody)
              const hasConfirmation = /locked in|booked|scheduled|set up|confirmed|will call|give you a call|he'll call|i'll call|call you|reach out|talk soon|speak.*soon|call.*today|call.*tomorrow|call.*morning|call.*afternoon|set for|all set|you're set|you're all set/i.test(aiBody)
              const hasBookingPattern = hasDay && hasTime && /call|speak|talk|reach/i.test(aiBody)
              const mightBeBooking = hasDay || hasTime || hasConfirmation || hasBookingPattern
              console.log('Checking for appointment confirmation')
              console.log('hasDay:', hasDay, 'hasTime:', hasTime, 'hasConfirmation:', hasConfirmation, 'hasBookingPattern:', hasBookingPattern, 'mightBeBooking:', mightBeBooking)
              console.log('Response text:', aiBody)
              if (!mightBeBooking) {
                console.log('Skipping detectAppointment — no booking signals in response')
                return
              }
              const apptData = await detectAppointment(history, aiResponse)
              if (apptData.confirmed) {
                console.log('Appointment detected:', apptData)
                await bookAppointment(lead, conversation.id, apptData, profile, fromNumber)
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('Incoming message error:', err)
  }
}

const handleIncomingMessage = async (req, res) => {
  // Respond to Twilio IMMEDIATELY — prevents retries and 15s timeout errors
  res.set('Content-Type', 'text/xml')
  res.send('<Response></Response>')

  try {
    await processInboundMessage(req.body)
  } catch (err) {
    console.error('Inbound processing error:', err.message)
  }
}

const sendManualMessage = async (req, res) => {
  try {
    const { conversation_id, lead_id, body } = req.body
    if (!body) return res.status(400).json({ error: 'Message body is required' })

    const { data: lead } = await supabase
      .from('leads').select('*').eq('id', lead_id).eq('user_id', req.user.id).single()
    if (!lead) return res.status(404).json({ error: 'Lead not found' })
    if (lead.opted_out) return res.status(403).json({ error: 'Lead has opted out. Message not sent.' })

    const fromNumber = await getNumberForLead(req.user.id, lead.state)
    const processedBody = spintext(body).replace(/\[First Name\]/g, lead.first_name || 'there')
    const finalBody = buildMessageBody(processedBody, req.user.profile, lead, false)
    const result = await sendSMS(lead.phone, finalBody, fromNumber)
    if (!result.success) return res.status(500).json({ error: result.error })

    await supabase.from('messages').insert({
      conversation_id,
      user_id: req.user.id,
      direction: 'outbound',
      body: finalBody,
      sent_at: new Date().toISOString(),
      is_ai: false,
      twilio_sid: result.sid,
      status: 'sent'
    })

    await supabase.from('conversations')
      .update({ updated_at: new Date().toISOString(), last_outbound_at: new Date().toISOString(), from_number: fromNumber })
      .eq('id', conversation_id)

    // Only upgrade status, never downgrade
    const STATUS_PRIORITY_M = { new: 0, contacted: 1, replied: 2, booked: 3, sold: 4 }
    const leadUpdates = { updated_at: new Date().toISOString() }
    if ((STATUS_PRIORITY_M[lead.status] ?? 0) < STATUS_PRIORITY_M.contacted) leadUpdates.status = 'contacted'
    if (!lead.first_message_sent) leadUpdates.first_message_sent = true
    await supabase.from('leads').update(leadUpdates).eq('id', lead_id)

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const detectAppointment = async (history, aiResponse) => {
  try {
    const Anthropic = require('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const today = new Date().toISOString().split('T')[0]
    const recentMessages = [
      ...history.slice(-6),
      { role: 'assistant', content: aiResponse },
      { role: 'user', content: 'Based on this conversation, did both parties agree on a specific day and time for a phone call? Reply with the JSON format specified in the system prompt.' }
    ]

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: `Did both parties agree on a specific day AND time for a call? Today is ${today}.
Return ONLY valid JSON, no markdown.
If yes: {"confirmed":true,"day":"tomorrow","time":"2pm"}
If no: {"confirmed":false}`,
      messages: recentMessages
    })

    const rawText = response.content[0]?.text || '{"confirmed":false}'
    console.log('detectAppointment raw response:', rawText)
    const cleaned = rawText.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim()
    return JSON.parse(cleaned)
  } catch (err) {
    console.error('detectAppointment error:', err.message)
    return { confirmed: false }
  }
}

const bookAppointment = async (lead, conversationId, appointmentData, profile, fromNumber) => {
  try {
    console.log('bookAppointment called with:', JSON.stringify(appointmentData))
    const day = appointmentData.day || ''
    const time = appointmentData.time || ''
    if (!day || !time) {
      console.error('bookAppointment: missing day or time from detectAppointment:', appointmentData)
      return
    }

    // Parse natural language day/time into a schedulable datetime
    // Use lead timezone first, then agent profile timezone, then EST
    const tz = lead.timezone || profile?.timezone || 'America/New_York'

    // Get today's date string in the target timezone
    const now = new Date()
    const todayInTz = now.toLocaleDateString('en-CA', { timeZone: tz }) // "2026-03-27"
    let [tzYear, tzMonth, tzDay] = todayInTz.split('-').map(Number)

    const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 }
    const dayLower = day.toLowerCase()
    const currentDayOfWeek = new Date(todayInTz + 'T12:00:00Z').getDay()

    if (dayLower === 'today' || dayLower === 'tonight') {
      // keep tzYear/tzMonth/tzDay as-is
    } else if (dayLower === 'tomorrow') {
      const d = new Date(Date.UTC(tzYear, tzMonth - 1, tzDay + 1))
      tzYear = d.getUTCFullYear(); tzMonth = d.getUTCMonth() + 1; tzDay = d.getUTCDate()
    } else if (dayLower === 'next week') {
      const d = new Date(Date.UTC(tzYear, tzMonth - 1, tzDay + 7))
      tzYear = d.getUTCFullYear(); tzMonth = d.getUTCMonth() + 1; tzDay = d.getUTCDate()
    } else {
      const targetDayNum = dayMap[dayLower]
      if (targetDayNum !== undefined) {
        let diff = targetDayNum - currentDayOfWeek
        if (diff <= 0) diff += 7
        const d = new Date(Date.UTC(tzYear, tzMonth - 1, tzDay + diff))
        tzYear = d.getUTCFullYear(); tzMonth = d.getUTCMonth() + 1; tzDay = d.getUTCDate()
      }
    }

    // Parse time string like "2pm", "2:30pm", "14:00", "noon"
    let hours = 12, minutes = 0
    const timeLower = time.toLowerCase().trim()
    if (timeLower === 'noon') {
      hours = 12; minutes = 0
    } else {
      const timeMatch = timeLower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/)
      if (timeMatch) {
        hours = parseInt(timeMatch[1], 10)
        minutes = parseInt(timeMatch[2] || '0', 10)
        const meridiem = timeMatch[3] || ''
        if (meridiem === 'pm' && hours < 12) hours += 12
        if (meridiem === 'am' && hours === 12) hours = 0
      }
    }

    // Build a naive UTC string treating local time as UTC, then apply timezone offset
    // This correctly converts "noon in EST" → 17:00 UTC (UTC-5) or 16:00 UTC (UTC-4 EDT)
    const dateStr = `${tzYear}-${String(tzMonth).padStart(2,'0')}-${String(tzDay).padStart(2,'0')}`
    const timeStr = `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:00`
    const naiveUtc = new Date(`${dateStr}T${timeStr}Z`)
    // What does that UTC moment look like in the target timezone?
    const tzRendered = new Date(naiveUtc.toLocaleString('en-US', { timeZone: tz }))
    // Difference = the UTC offset for that timezone at that moment
    const tzOffset = naiveUtc - tzRendered
    const scheduledAt = new Date(naiveUtc.getTime() + tzOffset).toISOString()

    if (!scheduledAt || scheduledAt.includes('NaN')) {
      console.error('bookAppointment: could not build scheduledAt from day:', day, 'time:', time, 'tz:', tz)
      return
    }

    console.log('Attempting appointment INSERT for lead', lead.id, 'at', scheduledAt, '(day:', day, 'time:', time, ')')
    const { data: appointment, error: apptErr } = await supabase
      .from('appointments')
      .insert({
        user_id: lead.user_id,
        lead_id: lead.id,
        scheduled_at: scheduledAt,
        duration_minutes: 15,
        title: `Call with ${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
        notes: `Booked via AI conversation`,
        status: 'scheduled'
      })
      .select().single()

    if (apptErr) {
      console.error('Appointment insert error:', apptErr.message)
      console.error('Appointment insert details:', apptErr.details, apptErr.hint, apptErr.code)
      return
    }
    console.log('Appointment created:', appointment?.id, 'at', appointment?.scheduled_at)

    const apptTime = new Date(scheduledAt).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
      hour12: true, timeZone: tz
    })
    createNotification(
      lead.user_id,
      'appointment_booked',
      'Appointment booked',
      `${lead.first_name} scheduled for ${apptTime}`,
      lead.id,
      conversationId
    ).catch(err => console.error('bookAppointment: createNotification error:', err.message))

    if (appointment) {
      await supabase.from('conversations').update({
        appointment_confirmed: true,
        appointment_id: appointment.id,
        needs_agent_review: true,
        handoff_reason: 'appointment_confirmed',
        updated_at: new Date().toISOString()
      }).eq('id', conversationId)

      // Upgrade to booked status (never downgrade from sold)
      const STATUS_PRIORITY_B = { new: 0, contacted: 1, replied: 2, booked: 3, sold: 4 }
      const bookedUpdate = { autopilot: false, updated_at: new Date().toISOString() }
      if ((STATUS_PRIORITY_B[lead.status] ?? 0) < STATUS_PRIORITY_B.booked) bookedUpdate.status = 'booked'
      await supabase.from('leads').update(bookedUpdate).eq('id', lead.id)

      const agentFirstName = profile?.agent_nickname || (profile?.agent_name || 'your agent').split(' ')[0]
      const confirmText = `Locked in. ${agentFirstName} will call you ${day} at ${time} and walk you through everything. Looking forward to connecting you two!`
      const confirmResult = await sendSMS(lead.phone, confirmText, fromNumber)
      if (confirmResult.success) {
        await supabase.from('messages').insert({
          conversation_id: conversationId,
          user_id: lead.user_id,
          direction: 'outbound',
          body: confirmText,
          sent_at: new Date().toISOString(),
          is_ai: true,
          twilio_sid: confirmResult.sid,
          status: 'sent'
        })
      }

      if (profile?.notify_appointment_sms !== false && profile?.personal_phone) {
        const notificationBody = `TextApp: New appointment booked!\nLead: ${lead.first_name || ''} ${lead.last_name || ''}\nPhone: ${lead.phone}\nTime: ${apptTime}\nCalendly: ${profile.calendly_url || 'N/A'}`
        sendSMS(profile.personal_phone, notificationBody, process.env.FORWARDING_NUMBER)
          .catch(err => console.error('bookAppointment: agent SMS notification error:', err.message))
      }
    }
  } catch (err) {
    console.error('Appointment booking error:', err.message)
    console.error('Appointment booking stack:', err.stack)
  }
}

const naturalizeText = (text) => {
  text = text.replace(/\s*—\s*/g, ', ')
  text = text.replace(/\s+-\s+/g, ', ')
  text = text.replace(/,\s*,/g, ',')
  return text
}

const removeExcessEmojis = (text) => {
  const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu
  const matches = text.match(emojiRegex) || []
  if (matches.length > 1) {
    let count = 0
    return text.replace(emojiRegex, (match) => {
      count++
      return count <= 1 ? match : ''
    })
  }
  return text
}

const generateAIResponse = async (lead, history, profile, inboundBody = '') => {
  try {
    const Anthropic = require('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    const calendlyUrl = profile?.calendly_url?.trim() || ''

    const systemPrompt = `You are texting leads on behalf of a licensed health insurance brokerage. Your job is to qualify leads through short casual SMS and get them on a call with a benefits specialist.
${calendlyUrl ? 'Booking link: ' + calendlyUrl : ''}

IDENTITY: Never introduce yourself by name or refer to yourself as anything. The outreach message already handled the introduction.

If the lead asks ANY variation of: who is this, who are you, what is your name, who are you with, what company is this, or any similar identity question — respond ONLY with:
"We're an independent brokerage with access to both public and private plan options, so we can help explore every available option for you." Then immediately pivot back to the conversation naturally.

Never confirm or deny a specific name, company name, or identity beyond this. Never say you are an AI or a bot.

STYLE:
Keep messages short. 1 to 2 sentences max.
No emojis. Ever.
ABSOLUTE RULE: Never use any dash character in any message. No hyphen (-), no em dash (—), no en dash (–). Not ever, not once. Use a comma or period instead. Violating this rule is not acceptable.
No exclamations. No "Great!" "Perfect!" "Awesome!" or any filler words.
Use "our benefits specialist" or "the advisor" when referring to the person who will call. Never use any name.
Write like a real person sending a quick text. Casual, direct, no fluff.
Basic punctuation only. Sentences do not need to be perfect.
Match the lead's energy and length.
Never repeat an opening word from a previous message.

QUALIFICATION FLOW — one question at a time:
Step 1: Who needs coverage. Individual or family. If family get ages of everyone.
Step 2: ZIP code if not already known.
Step 3: Annual income, ballpark is fine.
Step 3b: Meds and conditions. Keep it light, something like "do you take any regular medications or have any ongoing conditions I should factor in" — only one ask, don't probe if they don't want to share.
Step 4: Monthly budget. Use this exact framing: "ok got it, I can run a statewide search to see all the plans available to you. how much would you like to stay around monthly so I can narrow down your options"
Step 5: Schedule the call. Say something like "ok perfect, next step is a quick call with our benefits specialist to go over your options. what day and time works for you"
Once they give a day and time confirm it and stop. Do not send any links.

Do not need all data points before moving to booking.

BOOKING:
Get a day and time first. Ask something like "what day and time works best for you"
Once they give a time confirm it simply like "ok locked in, our benefits specialist will call you [day] at [time]"
Do not mention any booking links or URLs.
The appointment gets added to the calendar automatically.

OBJECTIONS:
Email request: the advisor just needs a quick look at your situation first so the info actually makes sense for you. takes a few minutes, what time works
Already has coverage: offer a free comparison, no pressure
Cost question: depends on your age, zip and income, that's exactly what the advisor goes over on the call
Think about it: no rush, text back whenever you're ready
Pre-existing conditions: plans vary by situation, best to go over it on a call
High income: private PPO likely a better fit, marketplace discounts probably won't apply
Low income: there may be some savings available depending on your situation

STOP RESPONDING IMMEDIATELY — do not send any message if lead says any of:
not interested, no thank you, no thanks, no, nope, stop, dont text me, leave me alone, remove me, unsubscribe, i'm good, im good, all set, i'm all set, im all set, already covered, already have insurance, not right now, maybe later, never mind, nevermind, no longer interested, found something, got covered, went with someone else, not looking, or uses any profanity of any kind.
When any of these are detected return null immediately and do not generate a response.

COMPLIANCE:
No premium or deductible quotes.
No qualification promises.
No Medicare or Medicaid discussion beyond acknowledging and redirecting.
No STOP reminder after the first message.

GEOGRAPHY:
Never mention a specific city or state as where the agent is based. If asked say "we work with clients all across the country" and redirect to the lead's situation.

KNOWN LEAD DATA, do not re-ask:
${[
  lead.first_name ? `Name: ${lead.first_name}${lead.last_name ? ' ' + lead.last_name : ''}` : null,
  lead.state ? `State: ${lead.state}` : null,
  lead.zip_code ? `ZIP: ${lead.zip_code}` : null,
  lead.income ? `Income: $${Number(lead.income).toLocaleString()}` : null,
  lead.product ? `Product: ${lead.product}` : null
].filter(Boolean).join(' | ') || 'None pre-loaded'}

Never re-ask for anything above.
Never ask for availability again after appointment is confirmed.`

    console.log('BEFORE - System prompt chars:', systemPrompt.length, 'approx tokens:', Math.round(systemPrompt.length / 4))

    let rawMessages = history.length > 0 ? history : [{ role: 'user', content: inboundBody }]
    let cappedMessages = rawMessages.length > 12
      ? [...rawMessages.slice(0, 2), ...rawMessages.slice(-10)]
      : rawMessages

    // Anthropic requires the last message to be from 'user' — trim any trailing assistant messages
    while (cappedMessages.length > 0 && cappedMessages[cappedMessages.length - 1].role === 'assistant') {
      cappedMessages = cappedMessages.slice(0, -1)
    }
    if (cappedMessages.length === 0) cappedMessages = [{ role: 'user', content: inboundBody }]

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: systemPrompt,
      messages: cappedMessages
    })

    return response.content[0]?.text || null
  } catch (err) {
    console.error('AI response error:', err.message)
    return null
  }
}

const suggestReply = async (req, res) => {
  try {
    const { conversation_id, lead_id } = req.body

    const { data: lead } = await supabase
      .from('leads').select('*').eq('id', lead_id).eq('user_id', req.user.id).single()
    if (!lead) return res.status(404).json({ error: 'Lead not found' })

    const { data: messages } = await supabase
      .from('messages').select('*')
      .eq('conversation_id', conversation_id)
      .order('sent_at', { ascending: true })

    const history = (messages || []).map(m => ({
      role: m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.body
    }))

    if (history.length === 0) {
      return res.json({ suggestion: getInitialMessage(lead) })
    }

    const suggestion = await generateAIResponse(lead, history, req.user.profile)
    res.json({ suggestion: suggestion || '' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const STATUS_MAP = {
  queued: 'sending',
  sending: 'sending',
  sent: 'sent',
  delivered: 'delivered',
  undelivered: 'failed',
  failed: 'failed'
}

// Carrier/spam related error codes that indicate filtering
const VIOLATION_CODES = new Set(['30003', '30004', '30005', '30006', '30007', '30008'])

const handleStatusCallback = async (req, res) => {
  try {
    const { MessageSid, MessageStatus, ErrorCode, ErrorMessage, From } = req.body
    if (!MessageSid) return res.sendStatus(200)

    const update = { status: STATUS_MAP[MessageStatus] || MessageStatus }
    if (ErrorCode) update.error_code = ErrorCode
    if (ErrorMessage) update.error_message = ErrorMessage

    await supabase.from('messages').update(update).eq('twilio_sid', MessageSid)

    // Carrier violation tracking
    if (ErrorCode && VIOLATION_CODES.has(String(ErrorCode))) {
      const fromNumber = From || req.body.from
      if (fromNumber) {
        const { data: pn } = await supabase
          .from('phone_numbers')
          .select('id, violation_count, daily_limit, status')
          .eq('phone_number', fromNumber)
          .single()

        if (pn) {
          // Count violations in last 100 messages for this number
          const { count: totalSent } = await supabase
            .from('messages')
            .select('id', { count: 'exact', head: true })
            .eq('twilio_sid', MessageSid) // placeholder — use from number join in practice

          const newCount = (pn.violation_count || 0) + 1

          // Fetch recent 100 sends to compute rate
          const { count: recentViolations } = await supabase
            .from('messages')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'failed')
            .not('error_code', 'is', null)
            .gte('sent_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())

          const violationRate = Math.min(((recentViolations || 0) / 100) * 100, 100)

          const statusUpdate = {
            violation_count: newCount,
            violation_rate: violationRate
          }

          await supabase.from('phone_numbers').update(statusUpdate).eq('id', pn.id)
        }
      }
    }

    res.sendStatus(200)
  } catch (err) {
    console.error('Status callback error:', err.message)
    res.sendStatus(200)
  }
}

const getMessagesByLead = async (req, res) => {
  try {
    const { lead_id, limit = 100 } = req.query
    if (!lead_id) return res.status(400).json({ error: 'lead_id required' })

    const { data: conv } = await supabase
      .from('conversations')
      .select('id')
      .eq('lead_id', lead_id)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (!conv) return res.json({ messages: [] })

    const { data: messages } = await supabase
      .from('messages')
      .select('id, body, direction, sent_at, is_ai, status')
      .eq('conversation_id', conv.id)
      .order('sent_at', { ascending: true })
      .limit(parseInt(limit))

    res.json({ messages: messages || [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

module.exports = { sendInitialOutreach, handleIncomingMessage, sendManualMessage, suggestReply, handleStatusCallback, isPositiveEngagement, getMessagesByLead }
