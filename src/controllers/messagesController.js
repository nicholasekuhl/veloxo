const supabase = require('../db')
const { sendSMS, buildMessageBody, getMasterClient } = require('../twilio')
const { createNotification } = require('../notifications')
const { spintext } = require('../spintext')

const getInitialMessage = (lead) => {
  const firstName = lead.first_name || 'there'
  return `Hi ${firstName}! This is Nick with Coverage by Kuhl. I saw you were exploring health insurance options and I'd love to help you find the right plan for your needs and budget. Do you have a few minutes to connect?`
}

const getUserFromNumber = async (userId) => {
  const { data } = await supabase
    .from('phone_numbers')
    .select('phone_number')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .single()
  return data?.phone_number || process.env.TWILIO_PHONE_NUMBER || null
}

const sendInitialOutreach = async (req, res) => {
  try {
    const { leadId } = req.params
    const { data: lead, error: leadError } = await supabase
      .from('leads').select('*').eq('id', leadId).eq('user_id', req.user.id).single()
    if (leadError || !lead) return res.status(404).json({ error: 'Lead not found' })
    if (lead.status !== 'new') return res.status(400).json({ error: 'Lead has already been contacted' })

    let { data: conversation } = await supabase
      .from('conversations').select('*').eq('lead_id', leadId).single()
    if (!conversation) {
      const { data: newConv, error: newConvError } = await supabase
        .from('conversations').insert({ lead_id: leadId, status: 'active', user_id: req.user.id }).select().single()
      if (newConvError) throw newConvError
      conversation = newConv
    }

    const fromNumber = await getUserFromNumber(req.user.id)
    const rawBody = getInitialMessage(lead)
    const messageBody = buildMessageBody(rawBody, req.user.profile, lead, true)
    const result = await sendSMS(lead.phone, messageBody, fromNumber)
    if (!result.success) return res.status(500).json({ error: result.error })

    await supabase.from('messages').insert({
      conversation_id: conversation.id,
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
  const fullText = history.map(m => m.content).join(' ').toLowerCase()

  // TRIGGER 1: Appointment confirmed
  if (conversation.appointment_confirmed) {
    return {
      triggered: true,
      reason: 'appointment_confirmed',
      message: `Perfect, I've got everything noted. ${agentName} will be in touch and can walk you through everything from here. Looking forward to connecting you!`
    }
  }

  // TRIGGER 2: Quote requested
  const quotePhrases = ['how much', "what's the price", 'give me a quote', 'what would it cost', 'send me options', 'what are my options', 'can you send', 'email me', 'just send it']
  if (quotePhrases.some(p => msg.includes(p))) {
    return {
      triggered: true,
      reason: 'quote_requested',
      message: `Absolutely — ${agentName} can put that together on a quick call so the numbers actually make sense for your specific situation. When works best for you?`
    }
  }

  // TRIGGER 3: Complex medical
  const medicalPhrases = ['surgery', 'procedure', 'diagnosed', 'condition', 'prescription', 'specialist', 'will this cover', 'does this cover']
  const medSuffixPattern = /\b\w+(mab|pril|statin|zole|pine)\b/i
  if (medicalPhrases.some(p => msg.includes(p)) || medSuffixPattern.test(msg)) {
    return {
      triggered: true,
      reason: 'complex_medical',
      message: `That's really helpful context. The right plan really does depend on your specific situation — ${agentName} can make sure you're matched with the right coverage. Do you prefer a quick review later today or tomorrow?`
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
      message: `Perfect, I've got everything noted. ${agentName} will be in touch and can walk you through everything from here. Looking forward to connecting you!`
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

const handleIncomingMessage = async (req, res) => {
  try {
    const { From, Body, To } = req.body

    // Look up which user owns this number via phone_numbers table
    let userId = null
    let profile = null
    const fromNumber = To

    const { data: phoneRecord } = await supabase
      .from('phone_numbers')
      .select('user_id')
      .eq('phone_number', To)
      .eq('is_active', true)
      .single()

    if (phoneRecord) {
      userId = phoneRecord.user_id
      const { data: userProfile } = await supabase.from('user_profiles').select('*').eq('id', userId).single()
      profile = userProfile
    }

    if (!userId) {
      console.log(`Incoming message to unrecognized number ${To} — ignoring`)
      res.set('Content-Type', 'text/xml')
      return res.send('<Response></Response>')
    }

    if (['STOP', 'UNSUBSCRIBE'].includes(Body.trim().toUpperCase())) {
      await supabase.from('leads')
        .update({ status: 'opted_out', updated_at: new Date().toISOString() })
        .eq('phone', From).eq('user_id', userId)
      res.set('Content-Type', 'text/xml')
      return res.send('<Response></Response>')
    }

    const { data: lead } = await supabase.from('leads').select('*').eq('phone', From).eq('user_id', userId).single()
    if (!lead) {
      res.set('Content-Type', 'text/xml')
      return res.send('<Response></Response>')
    }

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
          direction: 'inbound',
          body: Body,
          sent_at: new Date().toISOString()
        })
        await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', blockedConv.id)
      }
      res.set('Content-Type', 'text/xml')
      return res.send('<Response></Response>')
    }

    const { data: pausedRows } = await supabase.from('campaign_leads')
      .update({ status: 'paused', paused_at: new Date().toISOString() })
      .eq('lead_id', lead.id)
      .in('status', ['pending', 'active'])
      .select('id')
    if (pausedRows && pausedRows.length > 0) {
      console.log(`Campaign paused for lead: ${lead.id} (${pausedRows.length} enrollment(s))`)
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
      direction: 'inbound',
      body: Body,
      sent_at: new Date().toISOString()
    })

    await supabase.from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversation.id)

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
      createNotification(userId, 'inbound_message', `${leadName} replied`, Body.slice(0, 100), lead.id, conversation.id)
    }

    // SMS forwarding — non-blocking, never delays main flow
    if (profile?.sms_notifications_enabled !== false && profile?.personal_phone && lead.status !== 'opted_out') {
      const forwardingNumber = process.env.FORWARDING_NUMBER
      if (forwardingNumber) {
        const agencyName = profile.agency_name || 'TextApp'
        const msgBody = Body.length > 100 ? Body.slice(0, 100) + '...' : Body
        const leadName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || ''
        const forwardText = `${agencyName}: msg from ${leadName} ${lead.phone}: ${msgBody}`.trim()
        sendSMS(profile.personal_phone, forwardText, forwardingNumber)
      }
    }

    // Stop AI if already handed off
    if (conversation.needs_agent_review) {
      res.set('Content-Type', 'text/xml')
      return res.send('<Response></Response>')
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

      // Check handoff triggers before generating AI response
      const handoff = checkHandoffTriggers(conversation, Body, history, profile)

      if (handoff.triggered) {
        await executeHandoff(lead, conversation, handoff, fromNumber)
      } else {
        const aiResponse = await generateAIResponse(lead, history, profile)

        if (aiResponse) {
          const aiBody = buildMessageBody(aiResponse, profile, lead, false)
          const result = await sendSMS(lead.phone, aiBody, fromNumber)
          if (result.success) {
            await supabase.from('messages').insert({
              conversation_id: conversation.id,
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
              .update({ updated_at: new Date().toISOString() })
              .eq('id', conversation.id)

            // Check if conversation just confirmed an appointment
            const { data: conv } = await supabase.from('conversations').select('appointment_confirmed').eq('id', conversation.id).single()
            if (!conv?.appointment_confirmed) {
              const apptData = await detectAppointment(history, aiResponse)
              if (apptData.confirmed) {
                await bookAppointment(lead, conversation.id, apptData, profile, fromNumber)
              }
            }
          }
        }
      }
    }

    res.set('Content-Type', 'text/xml')
    res.send('<Response></Response>')
  } catch (err) {
    console.error('Incoming message error:', err)
    res.set('Content-Type', 'text/xml')
    res.send('<Response></Response>')
  }
}

const sendManualMessage = async (req, res) => {
  try {
    const { conversation_id, lead_id, body } = req.body
    if (!body) return res.status(400).json({ error: 'Message body is required' })

    const { data: lead } = await supabase
      .from('leads').select('*').eq('id', lead_id).eq('user_id', req.user.id).single()
    if (!lead) return res.status(404).json({ error: 'Lead not found' })

    const fromNumber = await getUserFromNumber(req.user.id)
    const processedBody = spintext(body).replace(/\[First Name\]/g, lead.first_name || 'there')
    const finalBody = buildMessageBody(processedBody, req.user.profile, lead, false)
    const result = await sendSMS(lead.phone, finalBody, fromNumber)
    if (!result.success) return res.status(500).json({ error: result.error })

    await supabase.from('messages').insert({
      conversation_id,
      direction: 'outbound',
      body: finalBody,
      sent_at: new Date().toISOString(),
      is_ai: false,
      twilio_sid: result.sid,
      status: 'sent'
    })

    await supabase.from('conversations')
      .update({ updated_at: new Date().toISOString() })
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
    const recentMessages = [...history.slice(-6), { role: 'assistant', content: aiResponse }]

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: `Analyze this SMS conversation. Did both parties just agree on a specific day AND time for a phone call?
Return ONLY valid JSON. If yes: {"confirmed":true,"datetime":"${today.slice(0,4)}-MM-DDTHH:MM:00","day_desc":"Tuesday","time_desc":"2:00 PM"}
If no: {"confirmed":false}
Today is ${today}. Only return confirmed=true if a specific date+time was mutually agreed upon.`,
      messages: recentMessages
    })

    return JSON.parse(response.content[0]?.text || '{"confirmed":false}')
  } catch {
    return { confirmed: false }
  }
}

const bookAppointment = async (lead, conversationId, appointmentData, profile, fromNumber) => {
  try {
    const tz = profile?.timezone || 'America/New_York'
    const localStr = appointmentData.datetime
    const utcDate = new Date(new Date(localStr).toLocaleString('en-US', { timeZone: 'UTC' }))
    const tzDate = new Date(new Date(localStr).toLocaleString('en-US', { timeZone: tz }))
    const offset = utcDate - tzDate
    const scheduledAt = new Date(new Date(localStr).getTime() + offset).toISOString()

    const { data: appointment } = await supabase
      .from('appointments')
      .insert({
        user_id: lead.user_id,
        lead_id: lead.id,
        scheduled_at: scheduledAt,
        duration_minutes: 15,
        title: `Call with ${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
        notes: `Booked via AI conversation`,
        status: 'scheduled',
        lead_name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
        lead_phone: lead.phone
      })
      .select().single()

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

      const agentName = profile?.agent_name || 'your agent'
      const confirmText = `Perfect, locked in! ${agentName} will call you ${appointmentData.day_desc} at ${appointmentData.time_desc}. Looking forward to it!`
      const confirmResult = await sendSMS(lead.phone, confirmText, fromNumber)
      if (confirmResult.success) {
        await supabase.from('messages').insert({
          conversation_id: conversationId,
          direction: 'outbound',
          body: confirmText,
          sent_at: new Date().toISOString(),
          is_ai: true,
          twilio_sid: confirmResult.sid,
          status: 'sent'
        })
      }
    }
  } catch (err) {
    console.error('Appointment booking error:', err.message)
  }
}

const generateAIResponse = async (lead, history, profile) => {
  try {
    const Anthropic = require('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    const agentName = profile?.agent_name || 'your agent'
    const calendlyUrl = profile?.calendly_url || '[booking link]'

    const systemPrompt = `You are a health insurance coverage specialist working for an independent health insurance agency. Your job is to have warm, helpful SMS conversations with people who have expressed interest in health coverage, gather the information needed to understand their situation, and schedule a quick call with a licensed advisor who will walk them through their options.

The licensed advisor's name is ${agentName} and their booking link is ${calendlyUrl}.

---

IDENTITY AND TONE:
- You are friendly, warm, patient, and never pushy
- You write like a real person texting — casual, concise, no corporate language
- You never use bullet points, numbered lists, or formal formatting in texts
- Keep responses to 1-3 sentences maximum unless absolutely necessary
- Use simple language — no jargon unless the lead uses it first
- Never make assumptive statements about what someone qualifies for
- Never quote specific plan prices or confirm coverage details — that is the advisor's job on the call
- Always make the lead feel like you are on their side, not selling to them
- Use smiley faces sparingly and naturally, like a real person would :)

---

WHAT YOU SELL:
- Marketplace (ACA) health insurance plans
- Private off-exchange health insurance plans (these are underwritten and require qualification — never promise someone will qualify)
- Dental and vision can often be bundled with coverage
- You do NOT sell Medicare or Medicaid
- If someone asks about Medicare or Medicaid, acknowledge it warmly and let them know those are government programs you do not specialize in, but you are happy to point them in the right direction

---

QUALIFICATION FLOW:
Work through these naturally in conversation — never ask multiple questions at once, never make it feel like a form:

1. WHO needs coverage — individual or family, and ages if family
2. ZIP code — needed to check what plans are available in their area
3. SITUATION — are they uninsured, losing coverage, or just comparing rates
4. INCOME — household income estimate to check Marketplace savings eligibility. Always say a ballpark is totally fine
5. MEDICATIONS AND CONDITIONS — any ongoing meds or conditions that need to be covered. Be sensitive here, never probe unnecessarily
6. WHY they are looking — price, coverage gaps, losing a job, life change, etc
7. BUDGET — monthly budget preference. Frame as something more budget friendly each month or lower out of pocket when you use it
8. PRE-QUOTE VALUE BUILD — once you have enough info, let them know there are options worth reviewing and that a quick call would be the best next step to go over everything properly

You do not need to collect every single data point before suggesting a call. Use judgment — if someone is clearly engaged and ready, move toward booking.

---

BOOKING A CALL:
- Never cold drop a booking link — negotiate a time first
- Ask if they prefer today, tomorrow, morning or afternoon
- Once they give a time, confirm it warmly and let them know ${agentName} will be calling them at that time to walk through their options
- After confirming the time, share the booking link so the lead can add it to their calendar: ${calendlyUrl}
- Example confirmation: "Perfect, I will lock that in. ${agentName} will give you a quick call at that time and walk you through everything step by step so you can pick what feels right."

---

GHOSTED LEAD FOLLOW-UPS:
If a lead stops responding mid-conversation, be patient and non-pressuring:

First follow-up (sent 4-6 hours later):
Reference exactly where you left off. "Hey [First Name], I did not want to overwhelm you. If you still want help comparing options I can keep everything really simple. Just send me [the missing info] whenever you get a second."

Second follow-up (sent next day):
Even lighter. "No worries at all. Whenever you are ready just text me and I will take care of everything from there."

Never follow up more than twice without a response. Never guilt, pressure, or create false urgency.

---

OBJECTIONS AND COMMON SITUATIONS:

"Can you just send me info by email?"
"I can definitely send everything over by email. The thing is ${agentName} just needs to do a quick review of your specific situation first so that what I send actually makes sense for you. It only takes a few minutes — what time works for a quick call?"

"I already have coverage"
"Got it, totally understand. A lot of people find it is worth doing a quick comparison just to make sure what you have is still the best fit — especially if anything has changed with your situation. No pressure at all, but happy to help if you ever want a second opinion."

"How much does it cost?"
"It really depends on a few things like your age, ZIP, income, and what level of coverage you need. That is exactly what ${agentName} can help map out on a quick call — there are usually a few different options at different price points."

"I need to think about it"
"Of course, totally makes sense. No rush at all. Just text me whenever you are ready and I can pick up right where we left off."

"Pre-existing conditions or specific medications"
"That is really helpful to know. The right plan really does depend on how each company covers your specific situation — some plans cover certain things more affordably than others. ${agentName} can help match you with the right one. Do you prefer a quick review later today or tomorrow morning?"

High income lead (private plans likely better):
"Got it, thanks for sharing. With that income level, private PPO options will usually line up better since Marketplace discounts would not apply. There are actually some really solid nationwide plans available. The main thing now is just narrowing them down so you are not paying for coverage you do not need. Would you prefer a quick review with ${agentName} later today or tomorrow?"

Low income lead (Marketplace savings likely available):
"Great, thanks for sharing that. With that income it looks like you may be in a range where there are some savings available on the Marketplace — I would want ${agentName} to take a closer look to see exactly what applies to your situation. Would a quick call work for you later today or tomorrow?"
Note: never confirm they qualify — always frame as "may be" and "looks like"

---

COMPLIANCE GUARDRAILS — NEVER DO THESE:
- Never tell someone they qualify for anything without confirmation from a licensed advisor
- Never quote specific premiums, deductibles, or out of pocket maximums
- Never say "you will definitely be covered for that"
- Never discuss Medicare, Medicaid, or government assistance programs beyond acknowledging them
- Never guarantee private plan approval — always frame as "there are options worth exploring" not "you qualify"
- Never pressure or create false urgency
- Never text someone who has replied STOP
- Always include Reply STOP to opt out on the very first outbound message to a new lead

---

RESPONSE STYLE RULES:
- Maximum 2-3 sentences per message
- Never ask more than one question per message
- Match the lead's energy — if they are brief, be brief. If they are chatty, be warmer
- Use the lead's first name occasionally but not in every message
- Never start two consecutive messages with the same opening word
- Read the full conversation history before responding — never repeat a question already answered
- If you are unsure what they mean, ask one simple clarifying question

Lead info: Name: ${lead.first_name || ''} ${lead.last_name || ''}, State: ${lead.state || 'unknown'}, Plan interest: ${lead.plan_type || 'unknown'}`

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: systemPrompt,
      messages: history.slice(-10)
    })

    return response.content[0]?.text || null
  } catch (err) {
    console.error('AI generation error:', err.message)
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

const handleStatusCallback = async (req, res) => {
  try {
    const { MessageSid, MessageStatus, ErrorCode, ErrorMessage } = req.body
    if (!MessageSid) return res.sendStatus(200)

    const update = { status: STATUS_MAP[MessageStatus] || MessageStatus }
    if (ErrorCode) update.error_code = ErrorCode
    if (ErrorMessage) update.error_message = ErrorMessage

    await supabase.from('messages').update(update).eq('twilio_sid', MessageSid)
    res.sendStatus(200)
  } catch (err) {
    console.error('Status callback error:', err.message)
    res.sendStatus(200)
  }
}

module.exports = { sendInitialOutreach, handleIncomingMessage, sendManualMessage, suggestReply, handleStatusCallback }
