const express = require('express')
const router = express.Router()
const supabase = require('../db')

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

    const { first_name, last_name, phone, email, state,
            zip_code, date_of_birth, income, household,
            gender, age, lead_cost, bucket_name, source } = req.body

    if (!phone) return res.status(400).json({ error: 'Phone required' })

    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('id, priority_autopilot')
      .eq('id', userId)
      .single()
    if (!userProfile) {
      return res.status(404).json({ error: 'User not found' })
    }

    const digits = phone.replace(/\D/g, '')
    const normalizedPhone = digits.length === 10
      ? '+1' + digits : '+' + digits

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
      return res.json({
        success: true, action: 'updated', lead_id: existing.id
      })
    }

    let bucketId = null
    const targetBucket = bucket_name || 'Priority Leads'
    const { data: bucket } = await supabase
      .from('buckets').select('id')
      .eq('name', targetBucket)
      .eq('user_id', userId)
      .single()

    if (bucket) {
      bucketId = bucket.id
    } else {
      const { data: newBucket } = await supabase
        .from('buckets')
        .insert({
          name: targetBucket,
          user_id: userId,
          color: '#f59e0b'
        })
        .select('id').single()
      bucketId = newBucket?.id
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
        bucket_id: bucketId,
        lead_tier: 'priority',
        lead_source: source || 'webhook',
        lead_cost: lead_cost || null,
        queued_at: new Date().toISOString(),
        status: 'new',
        autopilot: userProfile.priority_autopilot || false
      })
      .select('id').single()

    if (error) throw error
    return res.json({
      success: true, action: 'created', lead_id: newLead.id
    })

  } catch (err) {
    console.error('[webhook] inbound lead error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router
