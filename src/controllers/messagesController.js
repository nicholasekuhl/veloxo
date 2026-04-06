const supabase = require('../db')
const { sendSMS, buildMessageBody, getMasterClient, getNumberForLead } = require('../twilio')
const { createNotification } = require('../notifications')
const { spintext } = require('../spintext')
const { isWithinQuietHours, getNextSendWindow } = require('../compliance')

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

    let { data: conversation } = await supabase
      .from('conversations').select('*').eq('lead_id', leadId).single()
    if (!conversation) {
      const { data: newConv, error: newConvError } = await supabase
        .from('conversations').insert({ lead_id: leadId, status: 'active', user_id: req.user.id }).select().single()
      if (newConvError) throw newConvError
      conversation = newConv
    }

    const fromNumber = await getNumberForLead(req.user.id, lead.state)
    const rawBody = getInitialMessage(lead)
    const messageBody = buildMessageBody(rawBody, req.user.profile, lead, true)
    const result = await sendSMS(lead.phone, messageBody, fromNumber)
    if (!result.success) return res.status(500).json({ error: result.error })

    await supabase.from('messages').insert({
      conversation_id: conversation.id,
      user_id: req.user.id,
      direction: 'outbound',
      body: messageBody,
      sent_at: new Date().toISOString(),
      twilio_sid: result.sid,
      status: 'sent'
    })

    await supabase.from('leads').update({
      status: 'contacted',
      first_message_sent: true,
      updated_at: new Date().toISOString()
    }).eq('id', leadId)

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
  const frustrationPhrases = ['already told', 'i said', 'you keep', 'just tell me', 'forget it', 'never mind', 'this is annoying', 'stop texting']
  const profanityWords = ['fuck', 'shit', 'asshole', 'bitch', 'wtf', 'bullshit']
  const hasFrustration = frustrationPhrases.some(p => msg.includes(p))
  const hasProfanity = profanityWords.some(p => msg.includes(p))
  if (hasFrustration || hasProfanity) {
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
      await supabase.from('leads')
        .update({ status: 'opted_out', opted_out: true, opted_out_at: now, autopilot: false, updated_at: now })
        .eq('phone', From).eq('user_id', userId)
      const { data: stoppedLead } = await supabase.from('leads').select('id').eq('phone', From).eq('user_id', userId).single()
      if (stoppedLead) {
        await supabase.from('campaign_leads')
          .update({ status: 'paused', paused_at: now })
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
      let { data: blockedConv } = await supabase
        .from('conversations').select('id').eq('lead_id', lead.id).eq('user_id', userId).single()
      if (!blockedConv) {
        const { data: newConv } = await supabase
          .from('conversations')
          .insert({ lead_id: lead.id, status: 'active', user_id: userId })
          .select('id').single()
        blockedConv = newConv
      }
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
      .from('conversations').select('*').eq('lead_id', lead.id).eq('user_id', userId).single()

    if (!conversation) {
      const { data: newConv } = await supabase
        .from('conversations')
        .insert({ lead_id: lead.id, status: 'active', user_id: userId })
        .select().single()
      conversation = newConv
    }

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

    const agentName = profile?.agent_name || 'your agent'
    const agentFirstName = profile?.agent_nickname || agentName.split(' ')[0]
    const calendlyUrl = profile?.calendly_url?.trim() || ''

    const systemPrompt = `You are texting leads for ${agentName}, a licensed health insurance advisor who works with clients across the US. Qualify leads through warm casual SMS and book calls with ${agentFirstName}.${calendlyUrl ? ` Booking link: ${calendlyUrl}` : ''}

STYLE: Max 2-3 sentences. No em dashes or hyphens between thoughts, use commas. No emojis unless lead uses them first. No "Great!/Perfect!/Awesome!" openers. Use contractions. Match lead's energy and length. Agent first name only, never full name. Never repeat an opening word across messages. Write like a real person texting.

QUALIFY ONE QUESTION AT A TIME (never feel like a form):
1. Who needs coverage (individual/family, ages if family)
2. ZIP code
3. Situation (uninsured, losing coverage, comparing)
4. Income estimate (ballpark is fine)
5. Meds/conditions (sensitive, don't probe)
6. Why they're looking
7. Budget preference
Move to booking once engaged, don't need every data point.

BOOKING: Negotiate a time before any link. Confirm warmly once they give a day and time.${calendlyUrl ? ` Then share: ${calendlyUrl}` : ` No link available, just confirm ${agentFirstName} will call at that time.`}

OBJECTIONS:
- Email request: "The thing is, ${agentFirstName} just needs a quick look at your situation first so what I send actually makes sense for you. Only takes a few minutes, what time works?"
- Already has coverage: Offer a free comparison, no pressure.
- Cost question: "Depends on your age, ZIP, and income. That's exactly what ${agentFirstName} maps out on a quick call."
- Think about it: "No rush. Text me when you're ready and I'll pick up right where we left off."
- Pre-existing/meds: Acknowledge, note plans vary by situation, suggest a call with ${agentFirstName}.
- High income: Private PPO likely better fit, Marketplace discounts won't apply.
- Low income: May be Marketplace savings available. Use "may be" language, never confirm qualify.

COMPLIANCE: No premium/deductible quotes. No qualification promises. No Medicare/Medicaid beyond acknowledging and redirecting. Reply STOP opt-out on first message only.

GEOGRAPHY: If asked where you're based or where the agent is from, say something natural like "We work with clients all across the country" or "${agentFirstName} works with clients nationwide" — never name a specific city or state. The focus is always on the lead's location and what plans are available to them specifically.

KNOWN LEAD DATA — do not re-ask:
${[
  lead.first_name ? `Name: ${lead.first_name}${lead.last_name ? ' ' + lead.last_name : ''}` : null,
  lead.state ? `State: ${lead.state}` : null,
  lead.zip_code ? `ZIP: ${lead.zip_code}` : null,
  lead.income ? `Income: $${Number(lead.income).toLocaleString()}` : null,
  lead.product ? `Product: ${lead.product}` : null
].filter(Boolean).join(' | ') || 'None pre-loaded'}
Never re-ask for anything above. Never ask for availability again after appointment is confirmed.`

    console.log('BEFORE - System prompt chars:', systemPrompt.length, 'approx tokens:', Math.round(systemPrompt.length / 4))

    const rawMessages = history.length > 0 ? history : [{ role: 'user', content: inboundBody }]
    const cappedMessages = rawMessages.length > 12
      ? [...rawMessages.slice(0, 2), ...rawMessages.slice(-10)]
      : rawMessages

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

module.exports = { sendInitialOutreach, handleIncomingMessage, sendManualMessage, suggestReply, handleStatusCallback, isPositiveEngagement }
