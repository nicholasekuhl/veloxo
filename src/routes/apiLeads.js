const express = require('express')
const router = express.Router()
const supabase = require('../db')

// Helper: normalize phone to E.164
const normalizePhone = (phone) => {
  const digits = phone.replace(/\D/g, '')
  return digits.length === 10 ? '+1' + digits : '+' + digits
}

// Helper: create or update lead from webhook data
const processInboundLead = async ({ userId, fields, vendorId, vendorName, autopilot }) => {
  const { first_name, last_name, phone, email, state, zip_code,
          date_of_birth, income, household, gender, age, lead_cost, source } = fields

  if (!phone) return { error: 'Phone required', status: 400 }

  const normalizedPhone = normalizePhone(phone)

  const { data: existing } = await supabase
    .from('leads').select('id')
    .eq('phone', normalizedPhone)
    .eq('user_id', userId)
    .single()

  if (existing) {
    await supabase.from('leads').update({
      first_name: first_name || undefined,
      last_name: last_name || undefined,
      email: email || undefined,
      state: state || undefined,
      zip_code: zip_code || undefined,
      updated_at: new Date().toISOString()
    }).eq('id', existing.id)
    return { success: true, action: 'updated', lead_id: existing.id }
  }

  const notes = age ? 'Age: ' + age : null

  const { data: newLead, error } = await supabase
    .from('leads')
    .insert({
      first_name: first_name || null,
      last_name: last_name || null,
      phone: normalizedPhone,
      email: email || null,
      state: state || null,
      zip_code: zip_code || null,
      date_of_birth: date_of_birth || null,
      gender: gender || null,
      income: income || null,
      household: household || null,
      notes: notes,
      user_id: userId,
      bucket_id: null,
      lead_tier: 'priority',
      lead_source: vendorName || source || 'webhook',
      lead_vendor_id: vendorId || null,
      lead_cost: lead_cost || null,
      queued_at: new Date().toISOString(),
      status: 'new',
      autopilot: autopilot || false
    })
    .select('id').single()

  if (error) throw error
  return { success: true, action: 'created', lead_id: newLead.id }
}

// Helper: apply vendor field mapping to incoming body
const applyFieldMapping = (body, mapping) => {
  if (!mapping || Object.keys(mapping).length === 0) return body

  const mapped = {}
  for (const [veloxoField, vendorField] of Object.entries(mapping)) {
    mapped[veloxoField] = body[vendorField] !== undefined ? body[vendorField] : body[veloxoField]
  }
  // Include any unmapped fields from body
  for (const [key, value] of Object.entries(body)) {
    if (mapped[key] === undefined) mapped[key] = value
  }
  return mapped
}

// ─── API KEY AUTH ENDPOINT ──────────────────────────────────────────────────
router.post('/inbound', async (req, res) => {
  try {
    const { api_key } = req.body
    if (!api_key) {
      return res.status(401).json({ error: 'API key required' })
    }

    const { data: vendor, error: vendorErr } = await supabase
      .from('lead_vendors')
      .select('*')
      .eq('api_key', api_key)
      .single()

    if (vendorErr || !vendor) {
      return res.status(401).json({ error: 'Invalid API key' })
    }

    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('id, priority_autopilot')
      .eq('id', vendor.user_id)
      .single()
    if (!userProfile) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Apply field mapping
    const fields = applyFieldMapping(req.body, vendor.field_mapping)

    // Use vendor default_cost if no lead_cost provided
    if (!fields.lead_cost && vendor.default_cost) {
      fields.lead_cost = vendor.default_cost
    }

    const result = await processInboundLead({
      userId: vendor.user_id,
      fields,
      vendorId: vendor.id,
      vendorName: vendor.name,
      autopilot: vendor.on_receipt_autopilot
    })

    if (result.error) {
      return res.status(result.status).json({ error: result.error })
    }

    // Update vendor stats
    await supabase.rpc('increment_vendor_leads', { vendor_id: vendor.id }).catch(() => {
      // Fallback if RPC doesn't exist
      supabase.from('lead_vendors').update({
        leads_received: (vendor.leads_received || 0) + 1,
        last_lead_at: new Date().toISOString()
      }).eq('id', vendor.id).then(() => {}).catch(err => {
        console.error('[webhook] vendor stats update failed:', err.message)
      })
    })

    // If vendor has on_receipt_text_template_id and lead was created, schedule text
    if (vendor.on_receipt_text_template_id && result.action === 'created') {
      try {
        const { data: template } = await supabase
          .from('templates')
          .select('body')
          .eq('id', vendor.on_receipt_text_template_id)
          .eq('user_id', vendor.user_id)
          .single()

        if (template) {
          const { data: lead } = await supabase
            .from('leads')
            .select('*')
            .eq('id', result.lead_id)
            .single()

          if (lead) {
            const { sendSMS, getNumberForLead, buildMessageBody } = require('../twilio')

            // Replace template variables
            let messageBody = template.body
              .replace(/\{first_name\}/gi, lead.first_name || 'there')
              .replace(/\{last_name\}/gi, lead.last_name || '')
              .replace(/\{phone\}/gi, lead.phone || '')
              .replace(/\{email\}/gi, lead.email || '')
              .replace(/\{state\}/gi, lead.state || '')
              .replace(/\{zip_code\}/gi, lead.zip_code || '')

            const fromNumber = await getNumberForLead(vendor.user_id, lead.state)

            // Build with compliance footer
            const profile = userProfile
            messageBody = buildMessageBody(messageBody, profile, lead, !lead.first_message_sent)

            const smsResult = await sendSMS(lead.phone, messageBody, fromNumber)

            if (smsResult.success) {
              // Create conversation and message record
              const { data: conversation } = await supabase
                .from('conversations')
                .upsert(
                  { lead_id: result.lead_id, user_id: vendor.user_id, status: 'active' },
                  { onConflict: 'lead_id,user_id', ignoreDuplicates: false }
                )
                .select('id').single()

              if (conversation) {
                await supabase.from('messages').insert({
                  conversation_id: conversation.id,
                  user_id: vendor.user_id,
                  direction: 'outbound',
                  body: messageBody,
                  sent_at: new Date().toISOString(),
                  twilio_sid: smsResult.sid,
                  status: 'sent',
                  is_ai: false
                })
              }

              await supabase.from('leads').update({
                status: 'contacted',
                first_message_sent: true,
                last_contacted_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              }).eq('id', result.lead_id)
            }
          }
        }
      } catch (err) {
        console.error('[webhook] on_receipt text send failed:', err.message)
      }
    }

    return res.json(result)
  } catch (err) {
    console.error('[webhook] inbound lead error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ─── LEGACY :userId ENDPOINT (Make.com backward compat) ─────────────────────
router.post('/inbound/:userId', async (req, res) => {
  try {
    if (!process.env.MAKE_WEBHOOK_SECRET) {
      console.warn('[webhook] MAKE_WEBHOOK_SECRET not set')
    }
    const { userId } = req.params
    const secret = req.body.secret
    if (!secret || secret !== process.env.MAKE_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    if (!userId) {
      return res.status(400).json({ error: 'User ID required' })
    }

    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('id, priority_autopilot')
      .eq('id', userId)
      .single()
    if (!userProfile) {
      return res.status(404).json({ error: 'User not found' })
    }

    const result = await processInboundLead({
      userId,
      fields: req.body,
      vendorId: null,
      vendorName: null,
      autopilot: userProfile.priority_autopilot || false
    })

    if (result.error) {
      return res.status(result.status).json({ error: result.error })
    }

    return res.json(result)
  } catch (err) {
    console.error('[webhook] inbound lead error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router
