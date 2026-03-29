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

const parseHeaders = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const fileType = req.file.mimetype
    const fileBuffer = req.file.buffer
    let headers = []
    let preview = []

    if (fileType === 'text/csv') {
      await new Promise((resolve, reject) => {
        let rowCount = 0
        const stream = Readable.from(fileBuffer.toString())
        stream.pipe(csv()).on('headers', (h) => { headers = h }).on('data', (row) => {
          if (rowCount < 3) { preview.push(headers.map(h => row[h] ?? '')); rowCount++ }
        }).on('end', resolve).on('error', reject)
      })
    } else {
      const workbook = xlsx.read(fileBuffer, { type: 'buffer' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 })
      if (rows.length > 0) {
        headers = rows[0].map(h => String(h ?? ''))
        preview = rows.slice(1, 4).map(row => headers.map((_, i) => String(row[i] ?? '')))
      }
    }

    res.json({ headers, preview })
  } catch (err) {
    console.error('Parse headers error:', err)
    res.status(500).json({ error: err.message })
  }
}

const parseRowWithMap = (row, columnMap, bucket, autopilot, importedAt, userId) => {
  // columnMap: { app_field: 'CSV Header Name', ... }
  const get = (field) => {
    const header = columnMap[field]
    if (!header) return null
    return row[header] ?? null
  }
  const rawPhone = get('phone')
  const phone = normalizePhone(rawPhone)
  const raw = {
    first_name: get('first_name') || '',
    last_name: get('last_name') || '',
    phone: rawPhone || '',
    email: get('email') || '',
    state: get('state') || '',
    zip_code: get('zip_code') || ''
  }
  if (!phone) return { lead: null, reason: rawPhone ? 'invalid_phone' : 'missing_phone', raw }
  const state = normalizeState(get('state'))
  return {
    lead: {
      first_name: get('first_name') || null,
      last_name: get('last_name') || null,
      phone,
      email: get('email') || null,
      state,
      zip_code: get('zip_code') || null,
      date_of_birth: normalizeDOB(get('date_of_birth')) || null,
      address: get('address') || null,
      product: get('product') || null,
      timezone: getTimezone(state),
      status: 'new',
      bucket: bucket || null,
      bucket_imported_at: importedAt || null,
      autopilot: autopilot || false,
      user_id: userId || null
    },
    raw,
    reason: null
  }
}

const parseRow = (row, bucket, autopilot, importedAt, userId) => {
  const keys = Object.keys(row).reduce((acc, key) => {
    acc[key.toLowerCase().trim()] = row[key]
    return acc
  }, {})
  const rawPhone = keys['phone'] || keys['phone number'] || keys['mobile'] || keys['cell']
  const phone = normalizePhone(rawPhone)
  const raw = {
    first_name: keys['first name'] || keys['firstname'] || keys['first_name'] || '',
    last_name: keys['last name'] || keys['lastname'] || keys['last_name'] || '',
    phone: rawPhone || '',
    email: keys['email'] || keys['email address'] || '',
    state: keys['state'] || keys['st'] || '',
    zip_code: keys['zip'] || keys['zip code'] || keys['zipcode'] || keys['postal code'] || ''
  }
  if (!phone) return { lead: null, reason: rawPhone ? 'invalid_phone' : 'missing_phone', raw }
  const state = normalizeState(keys['state'] || keys['st'] || null)
  return {
    lead: {
      first_name: keys['first name'] || keys['firstname'] || keys['first_name'] || null,
      last_name: keys['last name'] || keys['lastname'] || keys['last_name'] || null,
      phone,
      email: keys['email'] || keys['email address'] || null,
      state,
      zip_code: keys['zip'] || keys['zip code'] || keys['zipcode'] || keys['postal code'] || null,
      date_of_birth: normalizeDOB(keys['dob'] || keys['date of birth'] || keys['birthdate'] || keys['birthday'] || keys['birth date'] || null),
      address: keys['address'] || keys['street address'] || keys['street'] || null,
      product: keys['product'] || keys['plan'] || keys['plan type'] || keys['plan_type'] || null,
      timezone: getTimezone(state),
      status: 'new',
      bucket: bucket || null,
      bucket_imported_at: importedAt || null,
      autopilot: autopilot || false,
      user_id: userId || null
    },
    raw,
    reason: null
  }
}

const processCSV = (buffer, bucket, autopilot, importedAt, userId, columnMap) => {
  return new Promise((resolve, reject) => {
    const valid = []
    const skipped = []
    const stream = Readable.from(buffer.toString())
    stream
      .pipe(csv())
      .on('data', (row) => {
        const result = columnMap
          ? parseRowWithMap(row, columnMap, bucket, autopilot, importedAt, userId)
          : parseRow(row, bucket, autopilot, importedAt, userId)
        if (result.lead) valid.push(result.lead)
        else skipped.push({ raw: result.raw, reason: result.reason })
      })
      .on('end', () => resolve({ valid, skipped }))
      .on('error', reject)
  })
}

const processXLSX = (buffer, bucket, autopilot, importedAt, userId, columnMap) => {
  const workbook = xlsx.read(buffer, { type: 'buffer' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const rows = xlsx.utils.sheet_to_json(sheet)
  const valid = [], skipped = []
  rows.forEach(row => {
    const result = columnMap
      ? parseRowWithMap(row, columnMap, bucket, autopilot, importedAt, userId)
      : parseRow(row, bucket, autopilot, importedAt, userId)
    if (result.lead) valid.push(result.lead)
    else skipped.push({ raw: result.raw, reason: result.reason })
  })
  return { valid, skipped }
}

const uploadLeads = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

    const userId = req.user.id
    const fileType = req.file.mimetype
    const fileBuffer = req.file.buffer
    const bucket = req.body.bucket || null
    const bucketId = req.body.bucket_id || null
    const autopilot = req.body.autopilot === 'true'
    const campaignId = req.body.campaign_id || null
    const campaignStartDate = req.body.campaign_start_date || null
    const dispositionTagId = req.body.disposition_tag_id || null
    const importedAt = new Date().toISOString()
    const columnMap = req.body.column_map ? JSON.parse(req.body.column_map) : null

    let parseResult = { valid: [], skipped: [] }
    if (fileType === 'text/csv') {
      parseResult = await processCSV(fileBuffer, bucket, autopilot, importedAt, userId, columnMap)
    } else {
      parseResult = processXLSX(fileBuffer, bucket, autopilot, importedAt, userId, columnMap)
    }
    const parseSkipped = parseResult.skipped
    const totalRows = parseResult.valid.length + parseSkipped.length

    if (totalRows === 0) {
      return res.status(400).json({ error: 'No rows found in file.' })
    }

    // Dedup within file — keep first occurrence of each phone
    const seenFilePhones = new Set()
    const uniqueFileLeads = []
    const fileDeupedLeads = []
    parseResult.valid.forEach(l => {
      if (seenFilePhones.has(l.phone)) fileDeupedLeads.push(l)
      else { seenFilePhones.add(l.phone); uniqueFileLeads.push(l) }
    })

    // Deduplication — check all phone numbers against existing leads for this user
    const phoneNumbers = uniqueFileLeads.map(l => l.phone)
    let existingPhones = new Set()
    if (phoneNumbers.length > 0) {
      const { data: existingLeads } = await supabase
        .from('leads')
        .select('phone')
        .eq('user_id', userId)
        .in('phone', phoneNumbers)
      existingPhones = new Set((existingLeads || []).map(l => l.phone))
    }
    const newLeads = uniqueFileLeads.filter(l => !existingPhones.has(l.phone))
    const duplicateLeads = uniqueFileLeads.filter(l => existingPhones.has(l.phone))
    const skippedDuplicates = duplicateLeads.length + fileDeupedLeads.length

    const skippedRows = [
      ...parseSkipped.map(s => ({ ...s.raw, skip_reason: s.reason === 'invalid_phone' ? 'Invalid phone number' : 'Missing phone number' })),
      ...fileDeupedLeads.map(l => ({ first_name: l.first_name || '', last_name: l.last_name || '', phone: l.phone || '', email: l.email || '', state: l.state || '', zip_code: l.zip_code || '', skip_reason: 'Duplicate within file' })),
      ...duplicateLeads.map(l => ({ first_name: l.first_name || '', last_name: l.last_name || '', phone: l.phone || '', email: l.email || '', state: l.state || '', zip_code: l.zip_code || '', skip_reason: 'Duplicate — already in system' }))
    ]

    if (newLeads.length === 0) {
      return res.json({
        success: true,
        total_rows: totalRows,
        imported: 0,
        skipped_duplicates: skippedDuplicates,
        skipped_invalid_phone: parseSkipped.length,
        skipped_rows: skippedRows,
        message: `No new leads to import — ${skippedDuplicates} duplicate${skippedDuplicates !== 1 ? 's' : ''} skipped`
      })
    }

    if (bucketId) newLeads.forEach(l => { l.bucket_id = bucketId })

    // Insert in batches of 100 to avoid Supabase payload limits
    const BATCH_SIZE = 100
    const insertedLeads = []
    for (let i = 0; i < newLeads.length; i += BATCH_SIZE) {
      const batch = newLeads.slice(i, i + BATCH_SIZE)
      const { data: batchData, error: batchError } = await supabase.from('leads').insert(batch).select()
      if (batchError) throw batchError
      insertedLeads.push(...batchData)
    }
    const data = insertedLeads

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
          await supabase.from('leads').update({
            campaign_tags: [campaignData.data.name],
            updated_at: new Date().toISOString()
          }).in('id', data.map(l => l.id))
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
        await supabase.from('leads').update({
          disposition_tag_id: dispTag.id,
          disposition_color: dispTag.color,
          updated_at: new Date().toISOString()
        }).in('id', data.map(l => l.id))

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
    if (skippedDuplicates > 0) parts.push(`${skippedDuplicates} duplicate${skippedDuplicates !== 1 ? 's' : ''} skipped`)
    if (parseSkipped.length > 0) parts.push(`${parseSkipped.length} invalid phone${parseSkipped.length !== 1 ? 's' : ''} skipped`)
    if (bucket) parts.push(`into bucket "${bucket}"`)

    res.json({
      success: true,
      total_rows: totalRows,
      imported: importedCount,
      skipped_duplicates: skippedDuplicates,
      skipped_invalid_phone: parseSkipped.length,
      skipped_rows: skippedRows,
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
    const page = parseInt(req.query.page) || 1
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const offset = (page - 1) * limit

    const [{ data, error }, { count, error: countErr }] = await Promise.all([
      supabase
        .from('leads')
        .select('*, campaign_leads(status), lead_dispositions(disposition_tag_id)')
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1),
      supabase
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', req.user.id)
    ])
    if (error) throw error
    if (countErr) throw countErr

    // Fetch appointments only for the leads in this page
    const leadIds = (data || []).map(l => l.id)
    const { data: upcomingAppts } = leadIds.length ? await supabase
      .from('appointments')
      .select('lead_id, scheduled_at')
      .in('lead_id', leadIds)
      .eq('status', 'scheduled')
      .gt('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true }) : { data: [] }

    const nextApptMap = {}
    for (const a of upcomingAppts || []) {
      if (!nextApptMap[a.lead_id]) nextApptMap[a.lead_id] = a.scheduled_at
    }

    const leads = (data || []).map(l => ({ ...l, next_appointment: nextApptMap[l.id] || null }))
    res.json({ leads, total: count, page, limit })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const getLeadStats = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('status, autopilot')
      .eq('user_id', req.user.id)
    if (error) throw error
    const stats = {
      total: data.length,
      new: data.filter(l => l.status === 'new').length,
      contacted: data.filter(l => l.status === 'contacted').length,
      booked: data.filter(l => l.status === 'booked').length,
      autopilot: data.filter(l => l.autopilot).length
    }
    res.json(stats)
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
      status, bucket, state, timezone,
      disposition_tag_id, campaign_tag, is_sold,
      is_cold, autopilot, search
    } = req.query

    let query = supabase.from('leads').select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })

    if (status) query = query.eq('status', status)
    if (bucket) query = query.eq('bucket', bucket)
    if (state) query = query.eq('state', state)
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
      'Zip Code', 'Date of Birth', 'Product', 'Status',
      'Bucket', 'Timezone', 'Notes', 'Autopilot',
      'Is Sold', 'Is Cold', 'Created At'
    ]

    const rows = leads.map(l => [
      l.first_name || '', l.last_name || '', l.phone || '',
      l.email || '', l.state || '', l.zip_code || '',
      l.date_of_birth || '', l.product || '', l.status || '',
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
    const { first_name, last_name, phone, email, date_of_birth, state, zip_code, product, address, notes, autopilot } = req.body
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
        product: product || null,
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

const resumeCampaigns = async (req, res) => {
  try {
    const { data: paused, error: fetchError } = await supabase
      .from('campaign_leads')
      .select('id')
      .eq('lead_id', req.params.id)
      .eq('user_id', req.user.id)
      .eq('status', 'paused')
    if (fetchError) throw fetchError

    if (!paused || paused.length === 0) {
      return res.json({ success: true, resumed: 0, message: 'No paused campaigns for this lead' })
    }

    const ids = paused.map(r => r.id)
    const { error: updateError } = await supabase
      .from('campaign_leads')
      .update({ status: 'pending', next_send_at: new Date().toISOString(), paused_at: null })
      .in('id', ids)
    if (updateError) throw updateError

    console.log(`Campaigns resumed for lead ${req.params.id} (${ids.length} enrollment(s))`)
    res.json({ success: true, resumed: ids.length, message: `Resumed ${ids.length} campaign${ids.length !== 1 ? 's' : ''}` })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const blockLead = async (req, res) => {
  try {
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('leads')
      .update({ is_blocked: true, blocked_at: now, autopilot: false, updated_at: now })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single()
    if (error) throw error

    await supabase
      .from('campaign_leads')
      .update({ status: 'paused', paused_at: now })
      .eq('lead_id', req.params.id)
      .in('status', ['pending', 'active'])

    res.json({ success: true, lead: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const unblockLead = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('leads')
      .update({ is_blocked: false, blocked_at: null, updated_at: new Date().toISOString() })
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

const getOrCreateSoldBucket = async (userId) => {
  const { data: existing } = await supabase
    .from('buckets').select('id').eq('user_id', userId).eq('is_system', true).single()
  if (existing) return existing.id
  const { data: created } = await supabase
    .from('buckets').insert({ user_id: userId, name: 'Sold', color: '#22c55e', is_system: true })
    .select('id').single()
  return created?.id || null
}

const markSold = async (req, res) => {
  try {
    const { sold_plan_type, sold_premium, sold_notes, commission } = req.body
    const now = new Date().toISOString()

    const { data: lead, error: fetchErr } = await supabase
      .from('leads').select('id, first_name, last_name, notes, bucket_id').eq('id', req.params.id).eq('user_id', req.user.id).single()
    if (fetchErr || !lead) return res.status(404).json({ error: 'Lead not found' })

    const soldBucketId = await getOrCreateSoldBucket(req.user.id)

    const saleParts = ['Marked as sold']
    if (sold_plan_type) saleParts.push(sold_plan_type)
    if (sold_premium) saleParts.push(`$${sold_premium}/month`)
    if (commission) saleParts.push(`commission $${commission}`)
    if (sold_notes) saleParts.push(sold_notes)
    const saleNote = saleParts.join(' — ')
    const newNotes = lead.notes ? `${lead.notes}\n${saleNote}` : saleNote

    const { data, error } = await supabase
      .from('leads')
      .update({
        is_sold: true, sold_at: now,
        sold_plan_type: sold_plan_type || null,
        sold_premium: sold_premium ? parseFloat(sold_premium) : null,
        sold_notes: sold_notes || null,
        commission: commission ? parseFloat(commission) : null,
        commission_status: 'pending',
        status: 'sold', autopilot: false, notes: newNotes, updated_at: now,
        bucket_id: soldBucketId,
        previous_bucket_id: lead.bucket_id !== soldBucketId ? lead.bucket_id : null
      })
      .eq('id', req.params.id).eq('user_id', req.user.id).select().single()
    if (error) throw error

    await supabase.from('campaign_leads')
      .update({ status: 'paused', paused_at: now })
      .eq('lead_id', req.params.id).in('status', ['pending', 'active'])

    res.json({ success: true, lead: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const unmarkSold = async (req, res) => {
  try {
    const now = new Date().toISOString()

    const { data: lead, error: fetchErr } = await supabase
      .from('leads').select('id, has_replied, notes, previous_bucket_id').eq('id', req.params.id).eq('user_id', req.user.id).single()
    if (fetchErr || !lead) return res.status(404).json({ error: 'Lead not found' })

    const newStatus = lead.has_replied ? 'replied' : 'contacted'
    const unsoldNote = 'Removed sold status'
    const newNotes = lead.notes ? `${lead.notes}\n${unsoldNote}` : unsoldNote

    const { data, error } = await supabase
      .from('leads')
      .update({
        is_sold: false, sold_at: null,
        sold_plan_type: null, sold_premium: null, sold_notes: null,
        commission: null, commission_status: null, commission_paid_at: null,
        status: newStatus, notes: newNotes, updated_at: now,
        bucket_id: lead.previous_bucket_id || null,
        previous_bucket_id: null
      })
      .eq('id', req.params.id).eq('user_id', req.user.id).select().single()
    if (error) throw error

    res.json({ success: true, lead: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const updateCommissionStatus = async (req, res) => {
  try {
    const { status } = req.body
    if (!['pending', 'paid', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status' })
    const now = new Date().toISOString()
    const updates = { commission_status: status, updated_at: now }
    if (status === 'paid') updates.commission_paid_at = now
    if (status !== 'paid') updates.commission_paid_at = null
    const { data, error } = await supabase
      .from('leads').update(updates).eq('id', req.params.id).eq('user_id', req.user.id).select().single()
    if (error) throw error
    res.json({ success: true, lead: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const updateProduct = async (req, res) => {
  try {
    const { product } = req.body
    const { data, error } = await supabase
      .from('leads')
      .update({ product: product || null, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('user_id', req.user.id)
      .select().single()
    if (error) throw error
    res.json({ success: true, lead: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const updateLeadBucket = async (req, res) => {
  try {
    const { bucket_id } = req.body
    const { data, error } = await supabase
      .from('leads')
      .update({ bucket_id: bucket_id || null, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('user_id', req.user.id)
      .select().single()
    if (error) throw error
    res.json({ success: true, lead: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const bulkAction = async (req, res) => {
  try {
    const { lead_ids, action, payload = {} } = req.body
    if (!Array.isArray(lead_ids) || !lead_ids.length) {
      return res.status(400).json({ error: 'No leads specified' })
    }
    const userId = req.user.id
    const now = new Date().toISOString()

    // Verify all leads belong to this user
    const { data: owned, error: verifyErr } = await supabase
      .from('leads').select('id, bucket_id').eq('user_id', userId).in('id', lead_ids)
    if (verifyErr) throw verifyErr
    const validIds = owned.map(l => l.id)
    if (!validIds.length) return res.status(403).json({ error: 'No valid leads found' })

    if (action === 'disposition') {
      const { disposition_id } = payload
      if (!disposition_id) return res.status(400).json({ error: 'disposition_id required' })
      await supabase.from('leads')
        .update({ disposition_tag_id: disposition_id, updated_at: now })
        .in('id', validIds)
      const historyRows = validIds.map(id => ({ lead_id: id, user_id: userId, disposition_tag_id: disposition_id, applied_at: now }))
      await supabase.from('lead_dispositions').upsert(historyRows, { onConflict: 'lead_id,disposition_tag_id', ignoreDuplicates: true })
      return res.json({ success: true, affected: validIds.length })
    }

    if (action === 'remove_disposition') {
      const { disposition_id } = payload
      if (!disposition_id) return res.status(400).json({ error: 'disposition_id required' })
      await supabase.from('lead_dispositions')
        .delete()
        .in('lead_id', validIds)
        .eq('disposition_tag_id', disposition_id)
      // Clear disposition_tag_id on lead if it matched this tag
      await supabase.from('leads')
        .update({ disposition_tag_id: null, updated_at: now })
        .in('id', validIds)
        .eq('disposition_tag_id', disposition_id)
      return res.json({ success: true, affected: validIds.length })
    }

    if (action === 'autopilot_on') {
      await supabase.from('leads').update({ autopilot: true, updated_at: now }).in('id', validIds)
      return res.json({ success: true, affected: validIds.length })
    }

    if (action === 'autopilot_off') {
      await supabase.from('leads').update({ autopilot: false, updated_at: now }).in('id', validIds)
      return res.json({ success: true, affected: validIds.length })
    }

    if (action === 'block') {
      await supabase.from('leads').update({ is_blocked: true, updated_at: now }).in('id', validIds)
      await supabase.from('campaign_leads')
        .update({ status: 'paused', paused_at: now })
        .in('lead_id', validIds).in('status', ['pending', 'active'])
      return res.json({ success: true, affected: validIds.length })
    }

    if (action === 'campaign') {
      const { campaign_id, start_date } = payload
      if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' })
      const { data: existing } = await supabase
        .from('campaign_leads').select('lead_id')
        .eq('campaign_id', campaign_id).in('lead_id', validIds).in('status', ['pending', 'active'])
      const existingSet = new Set((existing || []).map(r => r.lead_id))
      const toEnroll = validIds.filter(id => !existingSet.has(id))
      if (toEnroll.length) {
        const enrollRows = toEnroll.map(leadId => ({
          lead_id: leadId, campaign_id, user_id: userId,
          status: 'pending', enrolled_at: now,
          next_send_at: start_date || now
        }))
        await supabase.from('campaign_leads').insert(enrollRows)
      }
      return res.json({ success: true, affected: toEnroll.length, skipped: validIds.length - toEnroll.length })
    }

    if (action === 'bucket') {
      const { bucket_id } = payload
      await supabase.from('leads')
        .update({ bucket_id: bucket_id || null, updated_at: now })
        .in('id', validIds)
      return res.json({ success: true, affected: validIds.length })
    }

    if (action === 'sold') {
      const { sold_plan_type, commission } = payload
      const soldBucketId = await getOrCreateSoldBucket(userId)
      // Group leads by their current bucket_id so we can set previous_bucket_id correctly
      const bucketGroups = new Map()
      for (const l of owned) {
        const key = l.bucket_id || null
        if (!bucketGroups.has(key)) bucketGroups.set(key, [])
        bucketGroups.get(key).push(l.id)
      }
      for (const [currentBucketId, ids] of bucketGroups) {
        await supabase.from('leads')
          .update({
            is_sold: true, sold_at: now, status: 'sold', autopilot: false,
            sold_plan_type: sold_plan_type || null,
            commission: commission ? parseFloat(commission) : null,
            commission_status: commission ? 'pending' : null,
            updated_at: now,
            bucket_id: soldBucketId,
            previous_bucket_id: currentBucketId !== soldBucketId ? currentBucketId : null
          })
          .in('id', ids)
      }
      await supabase.from('campaign_leads')
        .update({ status: 'paused', paused_at: now })
        .in('lead_id', validIds).in('status', ['pending', 'active'])
      return res.json({ success: true, affected: validIds.length })
    }

    if (action === 'delete') {
      await supabase.from('messages').delete().in('lead_id', validIds)
      await supabase.from('conversations').delete().in('lead_id', validIds)
      await supabase.from('tasks').delete().in('lead_id', validIds)
      await supabase.from('campaign_leads').delete().in('lead_id', validIds)
      await supabase.from('lead_dispositions').delete().in('lead_id', validIds)
      await supabase.from('notifications').delete().in('lead_id', validIds)
      await supabase.from('appointments').delete().in('lead_id', validIds)
      await supabase.from('leads').delete().in('id', validIds).eq('user_id', userId)
      return res.json({ success: true, affected: validIds.length })
    }

    return res.status(400).json({ error: 'Invalid action' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const deleteLead = async (req, res) => {
  try {
    const leadId = req.params.id
    const userId = req.user.id

    const { data: lead, error: fetchErr } = await supabase
      .from('leads').select('id').eq('id', leadId).eq('user_id', userId).single()
    if (fetchErr || !lead) return res.status(404).json({ error: 'Lead not found' })

    await supabase.from('messages').delete().eq('lead_id', leadId)
    await supabase.from('conversations').delete().eq('lead_id', leadId)
    await supabase.from('tasks').delete().eq('lead_id', leadId)
    await supabase.from('campaign_leads').delete().eq('lead_id', leadId)
    await supabase.from('lead_dispositions').delete().eq('lead_id', leadId)
    await supabase.from('notifications').delete().eq('lead_id', leadId)
    await supabase.from('appointments').delete().eq('lead_id', leadId)

    const { error } = await supabase.from('leads').delete().eq('id', leadId).eq('user_id', userId)
    if (error) throw error

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const skipToday = async (req, res) => {
  try {
    const lead = await supabase.from('leads').select('timezone').eq('id', req.params.id).eq('user_id', req.user.id).single()
    if (lead.error) throw lead.error
    const tz = lead.data?.timezone || 'America/New_York'
    const now = new Date()
    const endOfDay = new Date(now.toLocaleDateString('en-US', { timeZone: tz }))
    endOfDay.setDate(endOfDay.getDate() + 1)
    const skipUntil = endOfDay.toISOString()

    const { data, error } = await supabase
      .from('leads')
      .update({ skip_until: skipUntil, updated_at: now.toISOString() })
      .eq('id', req.params.id).eq('user_id', req.user.id)
      .select().single()
    if (error) throw error
    res.json({ success: true, lead: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const pauseDrips = async (req, res) => {
  try {
    const now = new Date().toISOString()
    const { error } = await supabase
      .from('campaign_leads')
      .update({ status: 'paused', paused_at: now })
      .eq('lead_id', req.params.id)
      .eq('user_id', req.user.id)
      .in('status', ['pending', 'active'])
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const optOut = async (req, res) => {
  try {
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('leads')
      .update({ opted_out: true, opted_out_at: now, autopilot: false, updated_at: now })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single()
    if (error) throw error

    await supabase
      .from('campaign_leads')
      .update({ status: 'paused', paused_at: now })
      .eq('lead_id', req.params.id)
      .in('status', ['pending', 'active'])

    await supabase
      .from('messages')
      .update({ status: 'cancelled' })
      .eq('lead_id', req.params.id)
      .eq('status', 'scheduled')

    res.json({ success: true, lead: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const undoOptOut = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('leads')
      .update({ opted_out: false, opted_out_at: null, updated_at: new Date().toISOString() })
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

const markCalled = async (req, res) => {
  try {
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('leads')
      .update({ last_called_at: now, updated_at: now })
      .eq('id', req.params.id).eq('user_id', req.user.id)
      .select().single()
    if (error) throw error
    res.json({ success: true, lead: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const checkQuietHours = async (req, res) => {
  try {
    const { isWithinQuietHours } = require('../compliance')
    const { data: lead, error } = await supabase
      .from('leads')
      .select('id, state, timezone')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single()
    if (error || !lead) return res.status(404).json({ error: 'Lead not found' })
    const result = isWithinQuietHours(lead.state, lead.timezone)
    res.json(result)
  } catch (err) {
    console.error('checkQuietHours error:', err.message)
    res.status(500).json({ error: err.message })
  }
}

const logComplianceOverride = async (req, res) => {
  try {
    const { lead_id, message_body, lead_state, lead_timezone, local_time_at_send, reason } = req.body
    await supabase.from('compliance_overrides').insert({
      user_id: req.user.id,
      lead_id,
      message_body,
      lead_state,
      lead_timezone,
      local_time_at_send,
      reason
    })
    res.json({ success: true })
  } catch (err) {
    console.error('logComplianceOverride error:', err.message)
    res.status(500).json({ error: err.message })
  }
}

const riskCheck = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const userId = req.user.id
    const fileType = req.file.mimetype
    const fileBuffer = req.file.buffer
    const columnMap = req.body.column_map ? JSON.parse(req.body.column_map) : null

    let parseResult = { valid: [], skipped: [] }
    if (fileType === 'text/csv') {
      parseResult = await processCSV(fileBuffer, null, false, null, userId, columnMap)
    } else {
      parseResult = processXLSX(fileBuffer, null, false, null, userId, columnMap)
    }

    // Detect within-file duplicates (first occurrence is primary, rest are dupes)
    const seenInFile = new Set()
    const withinFileDupes = new Set()
    parseResult.valid.forEach(l => {
      if (seenInFile.has(l.phone)) withinFileDupes.add(l.phone)
      else seenInFile.add(l.phone)
    })

    // Check blocked and existing phones in parallel
    const uniquePhones = [...seenInFile]
    let blockedPhones = new Set()
    let existingPhones = new Set()
    if (uniquePhones.length > 0) {
      const [blockedRes, existingRes] = await Promise.all([
        supabase.from('leads').select('phone').eq('user_id', userId).eq('is_blocked', true).in('phone', uniquePhones),
        supabase.from('leads').select('phone').eq('user_id', userId).in('phone', uniquePhones)
      ])
      blockedPhones = new Set((blockedRes.data || []).map(l => l.phone))
      existingPhones = new Set((existingRes.data || []).map(l => l.phone))
    }

    const rows = []
    parseResult.skipped.forEach(s => {
      rows.push({ first_name: s.raw.first_name || '', last_name: s.raw.last_name || '', phone: s.raw.phone || '', risk: 'red', reason: s.reason === 'invalid_phone' ? 'Invalid phone number' : 'Missing phone number' })
    })
    const seenForOutput = new Set()
    parseResult.valid.forEach(l => {
      let risk = 'green', reason = 'Clean'
      if (blockedPhones.has(l.phone)) { risk = 'red'; reason = 'Blocked in your system' }
      else if (existingPhones.has(l.phone)) { risk = 'yellow'; reason = 'Already in your system' }
      else if (seenForOutput.has(l.phone)) { risk = 'yellow'; reason = 'Duplicate within file' }
      seenForOutput.add(l.phone)
      rows.push({ first_name: l.first_name || '', last_name: l.last_name || '', phone: l.phone || '', risk, reason })
    })

    res.json({
      rows,
      summary: {
        green: rows.filter(r => r.risk === 'green').length,
        yellow: rows.filter(r => r.risk === 'yellow').length,
        red: rows.filter(r => r.risk === 'red').length
      }
    })
  } catch (err) {
    console.error('Risk check error:', err)
    res.status(500).json({ error: err.message })
  }
}

module.exports = { parseHeaders, uploadLeads, riskCheck, getLeads, getLeadStats, getBuckets, exportLeads, getLeadById, updateAutopilot, updateNotes, updateProduct, updateCommissionStatus, updateLeadBucket, createLead, resumeCampaigns, blockLead, unblockLead, markSold, unmarkSold, deleteLead, skipToday, pauseDrips, markCalled, bulkAction, optOut, undoOptOut, checkQuietHours, logComplianceOverride }
