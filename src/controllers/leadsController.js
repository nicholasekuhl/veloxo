const csv = require('csv-parser')
const xlsx = require('xlsx')
const { Readable } = require('stream')
const supabase = require('../db')

const normalizePhone = (phone) => {
  if (!phone) return null
  const digits = phone.toString().replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}

const normalizeState = (state) => {
  if (!state) return null
  const trimmed = state.toString().trim()
  const stateMap = {
    'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
    'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
    'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
    'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
    'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
    'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
    'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
    'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
    'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
    'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
    'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
    'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
    'wisconsin': 'WI', 'wyoming': 'WY'
  }
  if (trimmed.length === 2) return trimmed.toUpperCase()
  return stateMap[trimmed.toLowerCase()] || trimmed.toUpperCase()
}

const getTimezone = (state) => {
  const timezones = {
    'CT': 'America/New_York', 'DE': 'America/New_York', 'FL': 'America/New_York',
    'GA': 'America/New_York', 'ME': 'America/New_York', 'MD': 'America/New_York',
    'MA': 'America/New_York', 'NH': 'America/New_York', 'NJ': 'America/New_York',
    'NY': 'America/New_York', 'NC': 'America/New_York', 'OH': 'America/New_York',
    'PA': 'America/New_York', 'RI': 'America/New_York', 'SC': 'America/New_York',
    'VT': 'America/New_York', 'VA': 'America/New_York', 'WV': 'America/New_York',
    'MI': 'America/New_York', 'IN': 'America/Indiana/Indianapolis',
    'AL': 'America/Chicago', 'AR': 'America/Chicago', 'IL': 'America/Chicago',
    'IA': 'America/Chicago', 'KS': 'America/Chicago', 'KY': 'America/Chicago',
    'LA': 'America/Chicago', 'MN': 'America/Chicago', 'MS': 'America/Chicago',
    'MO': 'America/Chicago', 'NE': 'America/Chicago', 'ND': 'America/Chicago',
    'OK': 'America/Chicago', 'SD': 'America/Chicago', 'TN': 'America/Chicago',
    'TX': 'America/Chicago', 'WI': 'America/Chicago',
    'AZ': 'America/Phoenix', 'CO': 'America/Denver', 'ID': 'America/Denver',
    'MT': 'America/Denver', 'NM': 'America/Denver', 'UT': 'America/Denver',
    'WY': 'America/Denver',
    'CA': 'America/Los_Angeles', 'NV': 'America/Los_Angeles',
    'OR': 'America/Los_Angeles', 'WA': 'America/Los_Angeles',
    'AK': 'America/Anchorage', 'HI': 'Pacific/Honolulu'
  }
  return timezones[state] || 'America/New_York'
}

const normalizeDOB = (dob) => {
  if (!dob) return null
  const str = dob.toString().trim()
  const mmddyyyy = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/)
  if (mmddyyyy) {
    const m = mmddyyyy[1].padStart(2, '0')
    const d = mmddyyyy[2].padStart(2, '0')
    return `${m}/${d}/${mmddyyyy[3]}`
  }
  const yyyymmdd = str.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/)
  if (yyyymmdd) {
    const m = yyyymmdd[2].padStart(2, '0')
    const d = yyyymmdd[3].padStart(2, '0')
    return `${m}/${d}/${yyyymmdd[1]}`
  }
  const mmddyy = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2})$/)
  if (mmddyy) {
    const m = mmddyy[1].padStart(2, '0')
    const d = mmddyy[2].padStart(2, '0')
    const year = parseInt(mmddyy[3])
    const fullYear = year > 30 ? `19${mmddyy[3]}` : `20${mmddyy[3]}`
    return `${m}/${d}/${fullYear}`
  }
  try {
    const date = new Date(str)
    if (!isNaN(date.getTime())) {
      const m = String(date.getMonth() + 1).padStart(2, '0')
      const d = String(date.getDate()).padStart(2, '0')
      return `${m}/${d}/${date.getFullYear()}`
    }
  } catch { return str }
  return str
}

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
  } catch {
    const fallback = new Date(startDate)
    fallback.setDate(fallback.getDate() + (dayNumber - 1))
    fallback.setHours(10, 0, 0, 0)
    return fallback.toISOString()
  }
}

const parseRow = (row, bucket, autopilot, importedAt, userId) => {
  const keys = Object.keys(row).reduce((acc, key) => {
    acc[key.toLowerCase().trim()] = row[key]
    return acc
  }, {})
  const phone = normalizePhone(
    keys['phone'] || keys['phone number'] || keys['mobile'] || keys['cell']
  )
  if (!phone) return null
  const state = normalizeState(keys['state'] || keys['st'] || null)
  return {
    first_name: keys['first name'] || keys['firstname'] || keys['first_name'] || null,
    last_name: keys['last name'] || keys['lastname'] || keys['last_name'] || null,
    phone,
    email: keys['email'] || keys['email address'] || null,
    state,
    zip_code: keys['zip'] || keys['zip code'] || keys['zipcode'] || keys['postal code'] || null,
    date_of_birth: normalizeDOB(keys['dob'] || keys['date of birth'] || keys['birthdate'] || keys['birthday'] || keys['birth date'] || null),
    address: keys['address'] || keys['street address'] || keys['street'] || null,
    plan_type: keys['plan'] || keys['plan type'] || keys['plan_type'] || null,
    timezone: getTimezone(state),
    status: 'new',
    bucket: bucket || null,
    bucket_imported_at: importedAt || null,
    autopilot: autopilot || false,
    user_id: userId || null
  }
}

const processCSV = (buffer, bucket, autopilot, importedAt, userId) => {
  return new Promise((resolve, reject) => {
    const leads = []
    const stream = Readable.from(buffer.toString())
    stream
      .pipe(csv())
      .on('data', (row) => {
        const lead = parseRow(row, bucket, autopilot, importedAt, userId)
        if (lead) leads.push(lead)
      })
      .on('end', () => resolve(leads))
      .on('error', reject)
  })
}

const processXLSX = (buffer, bucket, autopilot, importedAt, userId) => {
  const workbook = xlsx.read(buffer, { type: 'buffer' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const rows = xlsx.utils.sheet_to_json(sheet)
  return rows.map(row => parseRow(row, bucket, autopilot, importedAt, userId)).filter(Boolean)
}

const uploadLeads = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

    const userId = req.user.id
    const fileType = req.file.mimetype
    const fileBuffer = req.file.buffer
    const bucket = req.body.bucket || null
    const autopilot = req.body.autopilot === 'true'
    const campaignId = req.body.campaign_id || null
    const campaignStartDate = req.body.campaign_start_date || null
    const dispositionTagId = req.body.disposition_tag_id || null
    const importedAt = new Date().toISOString()

    let leads = []
    if (fileType === 'text/csv') {
      leads = await processCSV(fileBuffer, bucket, autopilot, importedAt, userId)
    } else {
      leads = processXLSX(fileBuffer, bucket, autopilot, importedAt, userId)
    }

    if (leads.length === 0) {
      return res.status(400).json({ error: 'No valid leads found. Make sure your file has a phone column.' })
    }

    // Deduplication — check all phone numbers against existing leads for this user
    const phoneNumbers = leads.map(l => l.phone)
    const { data: existingLeads } = await supabase
      .from('leads')
      .select('phone')
      .eq('user_id', userId)
      .in('phone', phoneNumbers)

    const existingPhones = new Set((existingLeads || []).map(l => l.phone))
    const newLeads = leads.filter(l => !existingPhones.has(l.phone))
    const skippedCount = leads.length - newLeads.length

    if (newLeads.length === 0) {
      return res.json({
        success: true,
        imported: 0,
        skipped: skippedCount,
        message: `Skipped all ${skippedCount} leads — all already exist in your system`
      })
    }

    const { data, error } = await supabase.from('leads').insert(newLeads).select()
    if (error) throw error

    if (campaignId && campaignStartDate && data.length > 0) {
      const { data: messages } = await supabase
        .from('campaign_messages')
        .select('*')
        .eq('campaign_id', campaignId)
        .order('day_number', { ascending: true })

      if (messages && messages.length > 0) {
        const firstMessage = messages[0]
        const enrollments = data.map((lead) => {
          const leadTimezone = lead.timezone || 'America/New_York'
          const firstSendAt = calculateSendTime(
            firstMessage.day_number,
            firstMessage.send_time || '10:00',
            campaignStartDate,
            leadTimezone
          )
          return {
            campaign_id: campaignId,
            lead_id: lead.id,
            status: 'pending',
            current_step: 0,
            start_date: new Date(campaignStartDate).toISOString(),
            next_send_at: firstSendAt,
            user_id: userId
          }
        })
        await supabase.from('campaign_leads').insert(enrollments)

        const campaignData = await supabase
          .from('campaigns').select('name').eq('id', campaignId).single()

        if (campaignData.data) {
          await Promise.all(data.map(lead =>
            supabase.from('leads').update({
              campaign_tags: [campaignData.data.name],
              updated_at: new Date().toISOString()
            }).eq('id', lead.id)
          ))
        }
      }
    }

    if (dispositionTagId && data.length > 0) {
      const { data: dispTag } = await supabase
        .from('disposition_tags')
        .select('id, name, color, disposition_messages(*)')
        .eq('id', dispositionTagId)
        .eq('user_id', userId)
        .single()

      if (dispTag) {
        await Promise.all(data.map(lead =>
          supabase.from('leads').update({
            disposition_tag_id: dispTag.id,
            disposition_color: dispTag.color,
            updated_at: new Date().toISOString()
          }).eq('id', lead.id)
        ))

        await supabase.from('lead_dispositions').insert(
          data.map(lead => ({
            lead_id: lead.id,
            disposition_tag_id: dispTag.id,
            applied_at: new Date().toISOString(),
            notes: `Applied at import — bucket: ${bucket}`
          }))
        )

        if (dispTag.disposition_messages && dispTag.disposition_messages.length > 0) {
          const dispEnrollments = data.map(lead => {
            const leadTimezone = lead.timezone || 'America/New_York'
            const now = new Date().toISOString()
            return {
              campaign_id: null,
              lead_id: lead.id,
              status: 'pending',
              current_step: 0,
              start_date: now,
              next_send_at: calculateSendTime(
                dispTag.disposition_messages[0].day_number,
                dispTag.disposition_messages[0].send_time || '10:00',
                now,
                leadTimezone
              ),
              disposition_tag_id: dispTag.id,
              user_id: userId
            }
          })
          await supabase.from('campaign_leads').insert(dispEnrollments)
        }
      }
    }

    const importedCount = data.length
    const parts = [`Imported ${importedCount} new lead${importedCount !== 1 ? 's' : ''}`]
    if (skippedCount > 0) parts.push(`skipped ${skippedCount} duplicate${skippedCount !== 1 ? 's' : ''} already in your system`)
    if (bucket) parts.push(`into bucket "${bucket}"`)

    res.json({
      success: true,
      imported: importedCount,
      skipped: skippedCount,
      message: parts.join(', '),
      leads: data
    })
  } catch (err) {
    console.error('Upload error:', err)
    res.status(500).json({ error: err.message })
  }
}

const getLeads = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
    if (error) throw error
    res.json({ leads: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const getBuckets = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('bucket, bucket_imported_at')
      .eq('user_id', req.user.id)
      .not('bucket', 'is', null)
      .order('bucket_imported_at', { ascending: false })
    if (error) throw error
    const seen = new Set()
    const buckets = []
    for (const row of data) {
      if (!seen.has(row.bucket)) {
        seen.add(row.bucket)
        buckets.push(row)
      }
    }
    res.json({ buckets })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const exportLeads = async (req, res) => {
  try {
    const {
      status, bucket, state, plan_type, timezone,
      disposition_tag_id, campaign_tag, is_sold,
      is_cold, autopilot, search
    } = req.query

    let query = supabase.from('leads').select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })

    if (status) query = query.eq('status', status)
    if (bucket) query = query.eq('bucket', bucket)
    if (state) query = query.eq('state', state)
    if (plan_type) query = query.eq('plan_type', plan_type)
    if (timezone) query = query.eq('timezone', timezone)
    if (disposition_tag_id) query = query.eq('disposition_tag_id', disposition_tag_id)
    if (is_sold === 'true') query = query.eq('is_sold', true)
    if (is_cold === 'true') query = query.eq('is_cold', true)
    if (autopilot === 'true') query = query.eq('autopilot', true)
    if (campaign_tag) query = query.contains('campaign_tags', [campaign_tag])

    const { data, error } = await query
    if (error) throw error

    let leads = data
    if (search) {
      const s = search.toLowerCase()
      leads = leads.filter(l =>
        [l.first_name, l.last_name, l.phone, l.email, l.state]
          .some(v => v?.toLowerCase().includes(s))
      )
    }

    const headers = [
      'First Name', 'Last Name', 'Phone', 'Email', 'State',
      'Zip Code', 'Date of Birth', 'Plan Type', 'Status',
      'Bucket', 'Timezone', 'Notes', 'Autopilot',
      'Is Sold', 'Is Cold', 'Created At'
    ]

    const rows = leads.map(l => [
      l.first_name || '', l.last_name || '', l.phone || '',
      l.email || '', l.state || '', l.zip_code || '',
      l.date_of_birth || '', l.plan_type || '', l.status || '',
      l.bucket || '', l.timezone || '', l.notes || '',
      l.autopilot ? 'Yes' : 'No',
      l.is_sold ? 'Yes' : 'No',
      l.is_cold ? 'Yes' : 'No',
      l.created_at ? new Date(l.created_at).toLocaleDateString() : ''
    ])

    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n')

    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="leads-export-${Date.now()}.csv"`)
    res.send(csvContent)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const updateAutopilot = async (req, res) => {
  try {
    const { autopilot } = req.body
    const { data, error } = await supabase
      .from('leads')
      .update({ autopilot, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single()
    if (error) throw error
    res.json({ success: true, lead: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const updateNotes = async (req, res) => {
  try {
    const { notes } = req.body
    const { data, error } = await supabase
      .from('leads')
      .update({ notes, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single()
    if (error) throw error
    res.json({ success: true, lead: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const getLeadById = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single()
    if (error) throw error
    res.json({ lead: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const createLead = async (req, res) => {
  try {
    const { first_name, last_name, phone, email, date_of_birth, state, zip_code, plan_type, address, notes, autopilot } = req.body
    if (!phone) return res.status(400).json({ error: 'Phone is required' })
    const normalizedPhone = normalizePhone(phone)
    if (!normalizedPhone) return res.status(400).json({ error: 'Invalid phone number format' })
    const normalizedState = state ? normalizeState(state) : null

    const { data, error } = await supabase
      .from('leads')
      .insert({
        user_id: req.user.id,
        first_name: first_name || null,
        last_name: last_name || null,
        phone: normalizedPhone,
        email: email || null,
        date_of_birth: date_of_birth ? normalizeDOB(date_of_birth) : null,
        state: normalizedState,
        zip_code: zip_code || null,
        plan_type: plan_type || null,
        address: address || null,
        notes: notes || null,
        autopilot: autopilot === true || autopilot === 'true',
        status: 'new',
        timezone: normalizedState ? getTimezone(normalizedState) : 'America/New_York'
      })
      .select()
      .single()

    if (error) return res.status(400).json({ error: error.message })
    res.json({ success: true, lead: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

module.exports = { uploadLeads, getLeads, getBuckets, exportLeads, getLeadById, updateAutopilot, updateNotes, createLead }
