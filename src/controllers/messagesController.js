const supabase = require('../db')
const { sendSMS, buildMessageBody, getMasterClient, getNumberForLead } = require('../twilio')
const { createNotification } = require('../notifications')
const { spintext } = require('../spintext')
const { isWithinQuietHours, getNextSendWindow } = require('../compliance')
const { getOrCreateOptOutBucket } = require('./leadsController')
const { detectPipelineStage, extractLeadDataFromHistory, generateNoteSummary, STAGE_ORDER } = require('../pipeline')
const { deductAiCredit } = require('../services/credits')
const { calcAge, assignRole } = require('./leadsController')

// Per-conversation debounce — prevents duplicate AI responses when a lead sends
// multiple messages in quick succession (e.g. "Tomorrow 1:30" then "Actually 4:30")
const pendingAiResponses = new Map() // key: conversationId, value: timeout handle

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

const STATE_NAMES = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
  'colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA',
  'hawaii':'HI','idaho':'ID','illinois':'IL','indiana':'IN','iowa':'IA','kansas':'KS',
  'kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD','massachusetts':'MA',
  'michigan':'MI','minnesota':'MN','mississippi':'MS','missouri':'MO','montana':'MT',
  'nebraska':'NE','nevada':'NV','new hampshire':'NH','new jersey':'NJ','new mexico':'NM',
  'new york':'NY','north carolina':'NC','north dakota':'ND','ohio':'OH','oklahoma':'OK',
  'oregon':'OR','pennsylvania':'PA','rhode island':'RI','south carolina':'SC',
  'south dakota':'SD','tennessee':'TN','texas':'TX','utah':'UT','vermont':'VT',
  'virginia':'VA','washington':'WA','west virginia':'WV','wisconsin':'WI','wyoming':'WY'
}

const autoExtractLeadData = async (lead, message) => {
  try {
    const updates = {}
    const noteLines = []
    const msg = message.toLowerCase()

    // ZIP code
    const zipMatch = message.match(/\b(\d{5})\b/)
    if (zipMatch && !lead.zip_code) updates.zip_code = zipMatch[1]

    // State — abbreviation
    const stateAbbrMatch = message.match(/\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/)
    if (stateAbbrMatch && !lead.state) updates.state = stateAbbrMatch[1]

    // State — full name (e.g. "I'm in Florida", "live in Texas")
    if (!lead.state && !updates.state) {
      const stateNameMatch = msg.match(/(?:i'm in|im in|i am in|live in|from|located in|i live in)\s+([a-z ]+)/i)
      if (stateNameMatch) {
        const candidate = stateNameMatch[1].trim().toLowerCase()
        if (STATE_NAMES[candidate]) updates.state = STATE_NAMES[candidate]
      }
    }

    // Income
    const incomeMatch = message.match(/\$?([\d,]+)\s*(?:k|thousand|a year|\/year|per year|annually|annual income)/i) ||
                        message.match(/(?:make|earn|income|salary)\s+(?:about|around|roughly)?\s*\$?([\d,]+)/i)
    if (incomeMatch && !lead.income) {
      let inc = incomeMatch[1].replace(/,/g, '')
      if (/k\b/i.test(message) || parseInt(inc) < 1000) inc = String(parseInt(inc) * 1000)
      updates.income = parseInt(inc)
    }

    // Age extraction
    const ageMatch = msg.match(/(?:i'm|im|i am)\s+(\d{2})\b/) ||
                     msg.match(/\bage\s+(\d{2})\b/) ||
                     msg.match(/(\d{2})\s+years?\s+old/)
    if (ageMatch) {
      const age = parseInt(ageMatch[1])
      if (age >= 18 && age <= 99) {
        noteLines.push(`[Auto] Age: ${age}`)
      }
    }

    // Household size extraction (natural language)
    if (!lead.household_size) {
      let householdSize = null
      let householdDesc = null
      if (/just me|only me|myself$|single|just myself/i.test(msg)) {
        householdSize = 1; householdDesc = 'Individual'
      } else if (/me and my (wife|husband|spouse|partner)/i.test(msg)) {
        householdSize = 2; householdDesc = 'Self + spouse'
      } else {
        const familyMatch = msg.match(/family of (\d)/i) || msg.match(/(\d) (?:people|in my household|in household|of us)/i)
        if (familyMatch) {
          householdSize = parseInt(familyMatch[1])
          householdDesc = `${householdSize} people`
        }
        const kidsMatch = msg.match(/(?:myself|me) and (\d) kids/i) || msg.match(/(\d) kids/i)
        if (kidsMatch && !householdSize) {
          const kids = parseInt(kidsMatch[1])
          householdSize = kids + 1
          householdDesc = `Self + ${kids} kid${kids > 1 ? 's' : ''}`
        }
      }
      if (householdSize) {
        updates.household_size = householdSize
        noteLines.push(`--- Household Info (Auto-extracted) ---`)
        noteLines.push(`Size: ${householdSize} people`)
        noteLines.push(`Members: ${householdDesc}`)
        noteLines.push(`---`)
      }
    }

    // DOB extraction — detect dates and add to household members
    const dobPatterns = [
      /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/g,
      /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})\b/g,
      /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})\s*,?\s*(\d{4})/gi
    ]
    const parsedDobs = []
    for (const pattern of dobPatterns) {
      let match
      while ((match = pattern.exec(message)) !== null) {
        let dateStr
        if (/jan|feb|mar|apr/i.test(match[1])) {
          dateStr = `${match[1]} ${match[2]}, ${match[3]}`
        } else {
          let year = match[3]
          if (year.length === 2) year = parseInt(year) > 30 ? '19' + year : '20' + year
          dateStr = `${match[1]}/${match[2]}/${year}`
        }
        const parsed = new Date(dateStr)
        if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 1920 && parsed.getFullYear() <= new Date().getFullYear()) {
          const isoDate = parsed.toISOString().split('T')[0]
          if (!parsedDobs.includes(isoDate)) parsedDobs.push(isoDate)
        }
      }
    }

    // Also detect birth year only: "born 2015", "born in 2019"
    const yearOnlyMatch = message.match(/\bborn\s+(?:in\s+)?(\d{4})\b/gi)
    if (yearOnlyMatch) {
      for (const ym of yearOnlyMatch) {
        const yearStr = ym.match(/(\d{4})/)[1]
        const yr = parseInt(yearStr)
        if (yr > 1920 && yr <= new Date().getFullYear()) {
          const isoDate = `${yr}-01-01`
          if (!parsedDobs.includes(isoDate)) parsedDobs.push(isoDate)
        }
      }
    }

    if (parsedDobs.length > 0) {
      try {
        const householdNotes = []
        let dobIndex = 0

        // First DOB → primary lead if not already set
        if (!lead.date_of_birth) {
          updates.date_of_birth = parsedDobs[dobIndex]
          dobIndex = 1
        }

        // Remaining DOBs → household members
        if (parsedDobs.length > dobIndex) {
          const { data: existing } = await supabase
            .from('lead_household_members')
            .select('id, date_of_birth')
            .eq('lead_id', lead.id)
          const existingDobs = (existing || []).map(m => m.date_of_birth)
          const adultCount = (existing || []).filter(m => calcAge(m.date_of_birth) >= 27).length
          let runningAdultCount = adultCount

          for (let i = dobIndex; i < parsedDobs.length; i++) {
            const dob = parsedDobs[i]
            if (existingDobs.includes(dob)) continue
            const role = assignRole(dob, runningAdultCount)
            if (calcAge(dob) >= 27) runningAdultCount++
            await supabase.from('lead_household_members').insert({
              lead_id: lead.id, user_id: lead.user_id, date_of_birth: dob, role
            })
            const memberAge = calcAge(dob)
            householdNotes.push(`${role.charAt(0).toUpperCase() + role.slice(1)} (Age ${memberAge})`)
          }

          if (householdNotes.length > 0) {
            noteLines.push(`[Auto] Household updated: ${householdNotes.join(', ')}`)
            // Update household count
            const { count } = await supabase
              .from('lead_household_members')
              .select('id', { count: 'exact', head: true })
              .eq('lead_id', lead.id)
            updates.household_size = (count || 0) + 1
          }
        }
      } catch (dobErr) {
        console.error('[autoExtract] DOB household error:', dobErr.message)
      }
    }

    // Append notes if any were generated
    if (noteLines.length > 0) {
      const newNotes = noteLines.join('\n')
      updates.notes = lead.notes ? lead.notes + '\n' + newNotes : newNotes
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString()
      await supabase.from('leads').update(updates).eq('id', lead.id)
      console.log('[autoExtract] Lead', lead.id, '→', updates)
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

const checkHandoffTriggers = (conversation, lastInboundMessage, history) => {
  const msg = lastInboundMessage.toLowerCase()
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
      message: `Perfect, I've got everything noted. Our benefits specialist will be in touch and can walk you through everything from here.`
    }
  }

  // TRIGGER 2: Quote requested — only hand off after 2 pushbacks
  const quotePhrases = ['how much', "what's the price", 'give me a quote', 'what would it cost', 'send me options', 'what are my options', 'can you send', 'email me', 'just send it']
  if (quotePhrases.some(p => msg.includes(p))) {
    if ((conversation.quote_push_count || 0) >= 2) {
      return {
        triggered: true,
        reason: 'quote_requested',
        message: `Absolutely, our benefits specialist can put that together on a quick call so the numbers actually make sense for your specific situation. When works best for you?`
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
      message: `That's really helpful context. The right plan really does depend on your specific situation. Our benefits specialist can make sure you're matched with the right coverage. Do you prefer a quick review later today or tomorrow?`
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
      message: `Perfect, I've got everything noted. Our benefits specialist will be in touch and can walk you through everything from here.`
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
          pipeline_stage: null,
          pipeline_ghosted: false,
          pipeline_ghosted_at: null,
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

    // Exact-match opt-out keywords (Twilio STOP words + extras)
    const STOP_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'QUIT', 'END', 'REMOVE', 'OPTOUT']
    const bodyUpper = Body.trim().toUpperCase()
    if (STOP_KEYWORDS.includes(bodyUpper) || bodyUpper === 'OPT OUT' || bodyUpper === 'DO NOT CONTACT'
        || bodyUpper === 'REMOVE ME' || bodyUpper === 'TAKE ME OFF'
        || bodyUpper === 'DONT TEXT ME' || bodyUpper === "DON'T TEXT ME"
        || bodyUpper === 'DONT CALL ME' || bodyUpper === "DON'T CALL ME") {
      const now = new Date().toISOString()
      const optOutBucketId = await getOrCreateOptOutBucket(userId)
      await supabase.from('leads')
        .update({ status: 'opted_out', opted_out: true, opted_out_at: now, autopilot: false, updated_at: now, pipeline_stage: null, pipeline_ghosted: false, pipeline_ghosted_at: null, ...(optOutBucketId ? { bucket_id: optOutBucketId } : {}) })
        .eq('phone', From).eq('user_id', userId)
      const { data: stoppedLead } = await supabase.from('leads').select('id').eq('phone', From).eq('user_id', userId).single()
      if (stoppedLead) {
        await Promise.all([
          supabase.from('campaign_leads')
            .update({ status: 'cancelled' })
            .eq('lead_id', stoppedLead.id).in('status', ['pending', 'active']),
          supabase.from('scheduled_messages')
            .delete()
            .eq('lead_id', stoppedLead.id)
            .eq('status', 'pending')
        ])
        // Log to compliance_log
        supabase.from('compliance_log').insert({
          user_id: userId,
          lead_id: stoppedLead.id,
          lead_phone: From,
          event_type: 'opt_out',
          event_detail: `Lead texted: ${Body.trim()}`
        }).then(() => {}).catch(err => console.error('[compliance] log error:', err.message))
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
        const agencyName = profile.agency_name || 'Veloxo'
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
      const convId = conversation.id

      // Cancel any existing pending AI response for this conversation
      if (pendingAiResponses.has(convId)) {
        clearTimeout(pendingAiResponses.get(convId))
        console.log(`[AI] Debounce reset for conversation ${convId} — new message arrived`)
      }

      // Capture loop-local copies for the closure
      const capturedLead = { ...lead }
      const capturedConversation = { ...conversation }
      const capturedProfile = profile
      const capturedFromNumber = fromNumber
      const capturedUserId = userId
      const capturedBody = Body

      // Debounce 45-60 seconds — gives leads time to send multiple messages
      // before the AI responds, so it sees the full context
      const debounceMs = 45000 + Math.floor(Math.random() * 15000)
      console.log(`[AI] Debounce set to ${Math.round(debounceMs / 1000)}s for conversation ${convId}`)
      const handle = setTimeout(async () => {
        pendingAiResponses.delete(convId)

        try {
          // Re-check autopilot — agent may have turned it off during the debounce window
          const { data: freshLead } = await supabase
            .from('leads').select('autopilot, first_message_sent, pipeline_stage, notes, status')
            .eq('id', capturedLead.id).single()
          if (!freshLead?.autopilot) {
            console.log(`[AI] Autopilot turned off during debounce for lead ${capturedLead.id} — skipping`)
            return
          }

          // Re-check handoff status — agent may have taken over
          const { data: freshConv } = await supabase
            .from('conversations').select('needs_agent_review, quote_push_count, appointment_confirmed')
            .eq('id', convId).single()
          if (freshConv?.needs_agent_review) {
            console.log(`[AI] Conversation ${convId} handed off during debounce — skipping`)
            return
          }

          // Re-fetch ALL messages fresh — captures every message sent during the debounce window
          const { data: freshMessages } = await supabase
            .from('messages').select('*')
            .eq('conversation_id', convId)
            .order('sent_at', { ascending: true })

          const history = (freshMessages || []).filter(m => m.direction !== 'system').map(m => ({
            role: m.direction === 'inbound' ? 'user' : 'assistant',
            content: m.body
          }))
          console.log(`[AI] Debounce fired for conversation ${convId} — history: ${history.length} messages`)

          // Use the latest inbound message for handoff trigger checks
          const lastInbound = (freshMessages || []).filter(m => m.direction === 'inbound').slice(-1)[0]
          const lastInboundBody = lastInbound?.body || capturedBody

          // Merge fresh conversation data for handoff checks
          const convForHandoff = { ...capturedConversation, ...freshConv }

          // Opt-out intent — explicit conversational phrases not caught by Twilio STOP keyword.
          // Run BEFORE AI and BEFORE checkHandoffTriggers so no response is ever generated.
          const OPT_OUT_PHRASES = [
            'take me off', 'remove me', 'stop texting', 'dont text', "don't text",
            'unsubscribe', 'not interested', 'leave me alone', 'stop contacting',
            'do not contact', 'opt out', 'opt-out', 'dont call me', "don't call me"
          ]
          const lastBodyLower = lastInboundBody.toLowerCase().trim()
          const isOptOutIntent = OPT_OUT_PHRASES.some(p => lastBodyLower.includes(p))

          if (isOptOutIntent) {
            console.log('[AI] Opt-out intent detected for lead', capturedLead.id, '— triggering opt-out')
            const now = new Date().toISOString()
            const optOutBucketId = await getOrCreateOptOutBucket(capturedUserId)
            await Promise.all([
              supabase.from('conversations').update({
                needs_agent_review: false,
                handoff_reason: 'soft_decline',
                status: 'closed',
                updated_at: now
              }).eq('id', convId),
              supabase.from('leads').update({
                opted_out: true,
                status: 'opted_out',
                is_cold: true,
                autopilot: false,
                opted_out_at: now,
                updated_at: now,
                pipeline_stage: null,
                pipeline_ghosted: false,
                pipeline_ghosted_at: null,
                ...(optOutBucketId ? { bucket_id: optOutBucketId } : {})
              }).eq('id', capturedLead.id),
              supabase.from('campaign_leads').update({ status: 'cancelled' })
                .eq('lead_id', capturedLead.id).in('status', ['pending', 'active']),
              supabase.from('scheduled_messages')
                .delete()
                .eq('lead_id', capturedLead.id)
                .eq('status', 'pending')
            ])
            // Log to compliance_log
            supabase.from('compliance_log').insert({
              user_id: capturedUserId,
              lead_id: capturedLead.id,
              lead_phone: capturedLead.phone,
              event_type: 'opt_out',
              event_detail: `AI detected opt-out intent: "${lastInboundBody.trim()}"`
            }).then(() => {}).catch(err => console.error('[compliance] log error:', err.message))
            return
          }

          const handoff = checkHandoffTriggers(convForHandoff, lastInboundBody, history)

          if (handoff.quoteDetected) {
            const newCount = (convForHandoff.quote_push_count || 0) + 1
            await supabase.from('conversations')
              .update({ quote_push_count: newCount })
              .eq('id', convId)
          }

          if (handoff.triggered) {
            await executeHandoff({ ...capturedLead, ...freshLead }, convForHandoff, handoff, capturedFromNumber)
          } else {
            const mergedLead = { ...capturedLead, ...freshLead }
            const aiResponse = await generateAIResponse(mergedLead, history, capturedProfile, lastInboundBody, capturedUserId)

            if (!aiResponse || aiResponse.trim() === '' || aiResponse.trim().toLowerCase() === 'null') {
              console.log('[AI] Null/empty response for lead', mergedLead.id, '— flagging for agent review')
              await supabase.from('conversations')
                .update({ needs_agent_review: true, handoff_reason: 'ai_null_response', updated_at: new Date().toISOString() })
                .eq('id', convId)
              await supabase.from('leads').update({ autopilot: false }).eq('id', mergedLead.id)
            } else if (aiResponse) {
              // Check quiet hours — queue if outside window and user prefers queuing
              const quietCheck = isWithinQuietHours(mergedLead.state, mergedLead.timezone)
              const afterHoursSetting = capturedProfile.ai_afterhours_response || 'queue'

              if (quietCheck.blocked && afterHoursSetting === 'queue') {
                const nextWindow = getNextSendWindow(mergedLead.state, mergedLead.timezone)
                const aiBody = buildMessageBody(removeExcessEmojis(naturalizeText(aiResponse)), capturedProfile, mergedLead, false)
                await supabase.from('scheduled_messages').insert({
                  user_id: capturedUserId,
                  lead_id: mergedLead.id,
                  conversation_id: convId,
                  body: aiBody,
                  scheduled_at: nextWindow,
                  send_at: nextWindow,
                  status: 'pending',
                  notes: 'AI response queued — outside quiet hours'
                })
                console.log(`[AI] Response queued until ${nextWindow} for lead ${mergedLead.id} (${quietCheck.reason})`)
                return
              }

              // Typing delay scales with message length to feel human
              const wordCount = aiResponse.split(' ').length
              const baseDelay = 12000
              const perWordDelay = 800
              const maxDelay = 75000
              const jitter = Math.floor(Math.random() * 6000)
              const delay = Math.min(baseDelay + (wordCount * perWordDelay) + jitter, maxDelay)
              await new Promise(resolve => setTimeout(resolve, delay))

              const aiBody = buildMessageBody(removeExcessEmojis(naturalizeText(aiResponse)), capturedProfile, mergedLead, false)
              const result = await sendSMS(mergedLead.phone, aiBody, capturedFromNumber)
              if (result.success) {
                await supabase.from('messages').insert({
                  conversation_id: convId,
                  user_id: capturedUserId,
                  direction: 'outbound',
                  body: aiBody,
                  sent_at: new Date().toISOString(),
                  is_ai: true,
                  twilio_sid: result.sid,
                  status: 'sent'
                })
                if (!mergedLead.first_message_sent) {
                  await supabase.from('leads').update({ first_message_sent: true }).eq('id', mergedLead.id)
                }
                await supabase.from('conversations')
                  .update({ updated_at: new Date().toISOString(), last_outbound_at: new Date().toISOString() })
                  .eq('id', convId)

                // ─── QUOTE STALL DETECTION ───────────────────────────────────
                const quoteStallPhrases = ['pull something up', 'let me check', 'run some numbers', 'look that up', 'check on that', 'pull up some', 'one moment', 'give me a sec']
                const aiBodyLower = aiBody.toLowerCase()
                if (quoteStallPhrases.some(p => aiBodyLower.includes(p))) {
                  console.log(`[AI] Quote stall detected for lead ${mergedLead.id} — pausing autopilot`)
                  await supabase.from('leads').update({ autopilot: false, updated_at: new Date().toISOString() }).eq('id', mergedLead.id)
                  const leadName = [mergedLead.first_name, mergedLead.last_name].filter(Boolean).join(' ') || mergedLead.phone
                  createNotification(capturedUserId, 'quote_requested', 'Quote Requested', `${leadName} is asking for a quote. Enter a quote range in the conversation panel.`, mergedLead.id, convId)
                  await supabase.from('messages').insert({
                    conversation_id: convId,
                    user_id: capturedUserId,
                    direction: 'system',
                    body: 'AI paused — waiting for agent to provide quote range',
                    sent_at: new Date().toISOString(),
                    is_ai: true,
                    status: 'sent'
                  })
                }
                // ─────────────────────────────────────────────────────────────

                // ─── PIPELINE STAGE DETECTION ────────────────────────────────
                try {
                  const { data: allMessages } = await supabase
                    .from('messages').select('direction, body')
                    .eq('conversation_id', convId)
                    .order('sent_at', { ascending: true })

                  const newStage = detectPipelineStage(mergedLead, allMessages || [])
                  const pipelineUpdates = {}

                  if (newStage) {
                    const currentOrder = STAGE_ORDER.indexOf(mergedLead.pipeline_stage)
                    const newOrder = STAGE_ORDER.indexOf(newStage)
                    if (newOrder > currentOrder) {
                      pipelineUpdates.pipeline_stage = newStage
                      pipelineUpdates.pipeline_stage_set_at = new Date().toISOString()
                      pipelineUpdates.pipeline_ghosted = false
                      pipelineUpdates.pipeline_ghosted_at = null
                    }
                  }

                  const extracted = extractLeadDataFromHistory(mergedLead, allMessages || [])
                  if (extracted) Object.assign(pipelineUpdates, extracted)

                  const stageChanged = newStage && newStage !== mergedLead.pipeline_stage
                  if (stageChanged || extracted) {
                    const summary = generateNoteSummary(
                      { ...mergedLead, ...pipelineUpdates },
                      pipelineUpdates.pipeline_stage || mergedLead.pipeline_stage || newStage
                    )
                    const timestamp = new Date().toLocaleString('en-US', {
                      month: 'short', day: 'numeric',
                      hour: 'numeric', minute: '2-digit', hour12: true
                    })
                    const noteEntry = '[Auto ' + timestamp + '] ' + summary
                    pipelineUpdates.notes = mergedLead.notes
                      ? mergedLead.notes + '\n' + noteEntry
                      : noteEntry
                  }

                  if (Object.keys(pipelineUpdates).length > 0) {
                    await supabase.from('leads').update(pipelineUpdates).eq('id', mergedLead.id)
                  }
                } catch (pipelineErr) {
                  console.error('Pipeline detection error:', pipelineErr.message)
                }
                // ─────────────────────────────────────────────────────────────

                // Check if conversation just confirmed an appointment
                const { data: convCheck } = await supabase.from('conversations').select('appointment_confirmed').eq('id', convId).single()
                if (!convCheck?.appointment_confirmed) {
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
                  const apptData = await detectAppointment(history, aiResponse, capturedUserId)
                  if (apptData.confirmed) {
                    console.log('Appointment detected:', apptData)
                    await bookAppointment(mergedLead, convId, apptData, capturedProfile, capturedFromNumber)
                  }
                }
              }
            }
          }
        } catch (debounceErr) {
          console.error('[AI] Debounce handler error:', debounceErr.message)
        }
      }, debounceMs)

      pendingAiResponses.set(convId, handle)
    }
  } catch (err) {
    console.error('Incoming message error:', err)
  }
}

const handleIncomingMessage = async (req, res) => {
  // Already respond-first — no change needed
  // Responds to carrier before any async processing to prevent 15s timeout retries
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
    const profile = req.user.profile || {}
    const processedBody = spintext(body)
      .replace(/\[First Name\]/gi, lead.first_name || '')
      .replace(/\[Last Name\]/gi, lead.last_name || '')
      .replace(/\[Full Name\]/gi, [lead.first_name, lead.last_name].filter(Boolean).join(' '))
      .replace(/\[Phone\]/gi, lead.phone || '')
      .replace(/\[Email\]/gi, lead.email || '')
      .replace(/\[State\]/gi, lead.state || '')
      .replace(/\[Zip\]/gi, lead.zip_code || '')
      .replace(/\[DOB\]/gi, lead.date_of_birth || '')
      .replace(/\[Agent Name\]/gi, profile.agent_name || '')
      .replace(/\[Agency Name\]/gi, profile.agency_name || '')
      .replace(/\[Calendly Link\]/gi, profile.calendly_url || '')
    const finalBody = buildMessageBody(processedBody, profile, lead, false)
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

const detectAppointment = async (history, aiResponse, userId = null) => {
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

    if (userId && response.usage) {
      deductAiCredit(userId, response.usage.input_tokens, response.usage.output_tokens, 'claude-haiku-4-5-20251001')
        .catch(err => console.error('[credits] AI deduction failed:', err.message))
    }

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

      // Explicitly advance pipeline to appointment_scheduled — only advance, never downgrade
      const currentPipelineOrder = STAGE_ORDER.indexOf(lead.pipeline_stage)
      const apptOrder = STAGE_ORDER.indexOf('appointment_scheduled')
      if (apptOrder > currentPipelineOrder) {
        bookedUpdate.pipeline_stage = 'appointment_scheduled'
        bookedUpdate.pipeline_stage_set_at = new Date().toISOString()
        bookedUpdate.pipeline_ghosted = false
        bookedUpdate.pipeline_ghosted_at = null
      }

      await supabase.from('leads').update(bookedUpdate).eq('id', lead.id)
      console.log(`[bookAppointment] pipeline_stage → appointment_scheduled for lead ${lead.id}`)

      const confirmText = `Locked in. Our benefits specialist will call you ${day} at ${time} and walk you through everything.`
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
        const notificationBody = `Veloxo: New appointment booked!\nLead: ${lead.first_name || ''} ${lead.last_name || ''}\nPhone: ${lead.phone}\nTime: ${apptTime}\nCalendly: ${profile.calendly_url || 'N/A'}`
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

const generateAIResponse = async (lead, history, profile, inboundBody = '', userId = null) => {
  try {
    const Anthropic = require('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    const calendlyUrl = profile?.calendly_url?.trim() || ''

    let systemPrompt = `You are texting leads on behalf of a licensed health insurance brokerage. Your job is to qualify leads through short casual SMS and get them on a call with a benefits specialist.
${calendlyUrl ? 'Booking link: ' + calendlyUrl : ''}

IDENTITY: Never introduce yourself by name or refer to yourself as anything. The outreach message already handled the introduction.

If the lead asks ANY variation of: who is this, who are you, what is your name, who are you with, what company is this, or any similar identity question — respond ONLY with:
"We're an independent brokerage with access to both public and private plan options, so we can help explore every available option for you." Then immediately pivot back to the conversation naturally.

Never confirm or deny a specific name, company name, or identity beyond this. Never say you are an AI or a bot.

STYLE:
Keep messages short. 1 to 2 sentences max.
ABSOLUTE RULE: Never use any emoji in any message. Not a single one. Not ever, not once. No smiley faces, no hearts, no checkmarks, no hands, no symbols of any kind. Violating this rule is not acceptable.
ABSOLUTE RULE: Never capitalize any word after a period or sentence break. The only words that are ever capitalized are: the very first word of the entire message, the word "I", and real proper names of actual people or places. Every other word stays lowercase even at the start of a new sentence. Write like someone casually texting, not writing a formal document.
ABSOLUTE RULE: Never use any special characters beyond basic periods, commas, and question marks. No colons, semicolons, parentheses, brackets, slashes, asterisks, ellipses, exclamation marks, or any other punctuation. Just periods, commas, and question marks.
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
Cost question or quote request: "I hear you, I don't want to throw numbers out without knowing your full picture, but there are usually solid options around that range. The call takes just a few minutes and they can pull up real numbers for your exact situation. What day works?"
Already has insurance: "Totally makes sense, a lot of people find they're overpaying or missing better coverage though. Takes 5 minutes for a free side by side comparison. Worth a quick look?"
Think about it or not sure: "No rush at all, whenever you're ready just text me back and I'll pick up right where we left off."
Price objection (too expensive, can't afford it): "I hear you on the budget, that's exactly why a quick call helps. They work with all budgets and can often find options people don't know exist. What day and time works to take a look?"
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
Never ask for availability again after appointment is confirmed.

INFORMATION EXTRACTION:
When leads share personal information, acknowledge it naturally and remember it. Extract and use: age, location/state, household size, income range, employment status, health conditions mentioned.

HOUSEHOLD AWARENESS:
If a lead mentions family members, ask about their ages naturally as part of qualification. A family of 4 has different options than a single person. When a lead mentions household members, ages of family members, or dependents, acknowledge this information and use it to tailor your response.

HOUSEHOLD QUALIFICATION:
When qualifying a lead, determine household size and dates of birth for ALL members who will be on the health insurance plan. Ask naturally: "and what are everyone's dates of birth" or "how old is everyone in your household". When leads provide multiple dates like "1/1/1990, 1/1/1992, 6/15/2019" recognize these as household member DOBs and acknowledge them: "got it, so that's you, your spouse, and a little one born in 2019". ACA coverage rules for context: adults 27+ are separate insured persons, dependents can be covered up to age 26, a family of 5 with ages 45/40/26/18/10 has 2 adults and 3 dependents under ACA. Always try to get full household DOBs before discussing pricing as this significantly affects the quote range.

QUOTE HANDLING:
If a lead resists a call and asks for a quote via text, respond with something like "ok let me pull something up real quick" and then wait. Do NOT make up numbers or estimate premiums. If QUOTE CONTEXT is provided in your instructions, use those exact numbers naturally.

BATCHING AWARENESS:
You may receive multiple messages from the same lead sent seconds or minutes apart. Always read all messages before responding. Respond to the full context of all recent messages, not just the last one.

CONVERSATION CONTINUITY:
You may be re-enabled mid-conversation after a human agent has been manually responding. Read the FULL conversation history carefully before responding. Pick up naturally from where the conversation left off. Never repeat information already discussed. If a quote has already been provided (check conversation history), do not ask for details again, continue the conversation forward.`

    // Inject lead state context
    const stateContext = [
      lead.quote_low ? `Quote already provided: $${lead.quote_low}-$${lead.quote_high}/mo` : null,
      lead.pipeline_stage ? `Current pipeline stage: ${lead.pipeline_stage}` : null,
      lead.status ? `Current lead status: ${lead.status}` : null
    ].filter(Boolean)
    if (stateContext.length > 0) {
      systemPrompt += `\n\nLEAD STATE:\n${stateContext.join('\n')}`
    }

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

    if (userId && response.usage) {
      deductAiCredit(userId, response.usage.input_tokens, response.usage.output_tokens, 'claude-sonnet-4-6')
        .catch(err => console.error('[credits] AI deduction failed:', err.message))
    }

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

    const suggestion = await generateAIResponse(lead, history, req.user.profile, '', req.user.id)
    res.json({ suggestion: suggestion || '' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const sendQuote = async (req, res) => {
  try {
    const { lead_id, conversation_id, quote_low, quote_high } = req.body
    if (!quote_low || !quote_high) return res.status(400).json({ error: 'Quote low and high are required' })

    const { data: lead } = await supabase
      .from('leads').select('*').eq('id', lead_id).eq('user_id', req.user.id).single()
    if (!lead) return res.status(404).json({ error: 'Lead not found' })

    const now = new Date().toISOString()
    const timestamp = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
    const quoteNote = `[${timestamp}] Quote provided: $${quote_low}-$${quote_high}/mo`

    // Save quote to lead
    await supabase.from('leads').update({
      quote_low,
      quote_high,
      quoted_at: now,
      pipeline_stage: 'quoted',
      pipeline_stage_set_at: now,
      notes: lead.notes ? lead.notes + '\n' + quoteNote : quoteNote,
      updated_at: now
    }).eq('id', lead_id)

    const fromNumber = await getNumberForLead(req.user.id, lead.state)
    const profile = req.user.profile || {}
    const mergedLead = { ...lead, quote_low, quote_high }

    if (lead.autopilot) {
      // Autopilot ON — generate AI response with quote context
      const { data: messages } = await supabase
        .from('messages').select('*')
        .eq('conversation_id', conversation_id)
        .order('sent_at', { ascending: true })

      const history = (messages || []).map(m => ({
        role: m.direction === 'inbound' ? 'user' : 'assistant',
        content: m.body
      }))

      const quoteContext = `AGENT_CONTEXT: Agent has provided a quote range of $${quote_low}-$${quote_high}/mo. Use these exact numbers naturally in your next response. Present the quote casually like you just ran the numbers.`
      history.push({ role: 'user', content: quoteContext })

      const aiResponse = await generateAIResponse(mergedLead, history, profile, quoteContext, req.user.id)

      if (aiResponse) {
        const aiBody = buildMessageBody(removeExcessEmojis(naturalizeText(aiResponse)), profile, mergedLead, false)
        const wordCount = aiResponse.split(' ').length
        const delay = Math.min(12000 + (wordCount * 800) + Math.floor(Math.random() * 6000), 75000)
        await new Promise(resolve => setTimeout(resolve, delay))

        const result = await sendSMS(mergedLead.phone, aiBody, fromNumber)
        if (result.success) {
          await supabase.from('messages').insert({
            conversation_id,
            user_id: req.user.id,
            direction: 'outbound',
            body: aiBody,
            sent_at: new Date().toISOString(),
            is_ai: true,
            twilio_sid: result.sid,
            status: 'sent'
          })
          await supabase.from('conversations')
            .update({ updated_at: new Date().toISOString(), last_outbound_at: new Date().toISOString() })
            .eq('id', conversation_id)
        }
      }
    } else {
      // Autopilot OFF — send manual quote message, agent stays in control
      const quoteBody = `okay so i pulled up some numbers, looks like you're looking at $${quote_low}-$${quote_high}/mo depending on the plan. what date were you thinking for coverage to start?`
      const finalBody = buildMessageBody(quoteBody, profile, mergedLead, false)
      const result = await sendSMS(mergedLead.phone, finalBody, fromNumber)
      if (result.success) {
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
          .update({ updated_at: new Date().toISOString(), last_outbound_at: new Date().toISOString() })
          .eq('id', conversation_id)
      }
    }

    res.json({ success: true, message: 'Quote sent' })
  } catch (err) {
    console.error('[sendQuote] error:', err.message)
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

module.exports = { sendInitialOutreach, handleIncomingMessage, sendManualMessage, suggestReply, sendQuote, handleStatusCallback, isPositiveEngagement, getMessagesByLead }
