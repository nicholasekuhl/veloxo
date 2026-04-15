const express = require('express')
const router = express.Router()
const supabase = require('../db')

// Railway env var required: MAKE_WEBHOOK_SECRET=<random string>

const normalizePhone = (phone) => {
  if (!phone) return null
  const digits = phone.toString().replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}

// POST /api/leads/inbound — public webhook for Make.com
router.post('/inbound', async (req, res) => {
  try {
    // 1. Validate secret
    if (req.body.secret !== process.env.MAKE_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    // 2. Find user by ADMIN_EMAIL
    const { data: user, error: userErr } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('email', process.env.ADMIN_EMAIL)
      .single()
    if (userErr || !user) {
      return res.status(500).json({ error: 'Admin user not found' })
    }
    const userId = user.id

    // 3. Normalize phone
    const phone = normalizePhone(req.body.phone)
    if (!phone) {
      return res.status(400).json({ error: 'Valid phone number is required' })
    }

    // 4. Check for duplicate by phone + user_id
    const { data: existing } = await supabase
      .from('leads')
      .select('id')
      .eq('user_id', userId)
      .eq('phone', phone)
      .single()

    if (existing) {
      const updateFields = {}
      if (req.body.first_name) updateFields.first_name = req.body.first_name
      if (req.body.last_name) updateFields.last_name = req.body.last_name
      if (req.body.email) updateFields.email = req.body.email
      if (req.body.state) updateFields.state = req.body.state
      if (req.body.zip_code) updateFields.zip_code = req.body.zip_code
      if (req.body.date_of_birth) updateFields.date_of_birth = req.body.date_of_birth
      if (req.body.lead_cost) updateFields.lead_cost = req.body.lead_cost
      updateFields.updated_at = new Date().toISOString()

      if (Object.keys(updateFields).length > 1) {
        await supabase
          .from('leads')
          .update(updateFields)
          .eq('id', existing.id)
          .eq('user_id', userId)
      }

      return res.json({ success: true, action: 'updated', lead_id: existing.id })
    }

    // 5. Find or create bucket
    let bucketId = null
    const bucketName = req.body.bucket_name
    if (bucketName) {
      const { data: bucket } = await supabase
        .from('buckets')
        .select('id')
        .eq('user_id', userId)
        .eq('name', bucketName)
        .single()

      if (bucket) {
        bucketId = bucket.id
      } else {
        const { data: newBucket, error: bucketErr } = await supabase
          .from('buckets')
          .insert({ user_id: userId, name: bucketName })
          .select('id')
          .single()
        if (bucketErr) console.error('[webhook] Failed to create bucket:', bucketErr.message)
        else bucketId = newBucket.id
      }
    }

    // 6. Build notes from optional fields
    const noteParts = []
    if (req.body.income) noteParts.push(`Income: ${req.body.income}`)
    if (req.body.household) noteParts.push(`Household: ${req.body.household}`)
    if (req.body.gender) noteParts.push(`Gender: ${req.body.gender}`)
    if (req.body.age) noteParts.push(`Age: ${req.body.age}`)
    const notes = noteParts.length > 0 ? noteParts.join(' | ') : null

    // 7. Create lead
    const { data: lead, error: insertErr } = await supabase
      .from('leads')
      .insert({
        user_id: userId,
        first_name: req.body.first_name || null,
        last_name: req.body.last_name || null,
        phone,
        email: req.body.email || null,
        state: req.body.state || null,
        zip_code: req.body.zip_code || null,
        date_of_birth: req.body.date_of_birth || null,
        notes,
        bucket_id: bucketId,
        lead_tier: 'priority',
        lead_source: req.body.source || 'webhook',
        lead_cost: req.body.lead_cost || null,
        queued_at: new Date().toISOString(),
        status: 'new',
        autopilot: false
      })
      .select('id')
      .single()

    if (insertErr) {
      console.error('[webhook] Lead insert failed:', insertErr.message)
      return res.status(500).json({ error: insertErr.message })
    }

    // 8. Return success
    console.log(`[webhook] Lead created: ${lead.id} (${phone})`)
    res.json({ success: true, action: 'created', lead_id: lead.id })
  } catch (err) {
    console.error('[webhook] Unexpected error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
