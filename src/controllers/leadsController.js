const csv = require('csv-parser')
const xlsx = require('xlsx')
const { Readable } = require('stream')
const supabase = require('../db')
const { sendSMS, buildMessageBody, pickNumberForLead } = require('../twilio')
const { spintext } = require('../spintext')
const { isWithinQuietHours, checkSystemInitiatedLimit } = require('../compliance')
const { checkDNC } = require('../utils/dncCheck')
const { bumpMessageCount } = require('../utils/messageCount')

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

    // RULE: Folders are organizational containers only — leads must never be assigned to a folder.
    // DB audit: SELECT COUNT(*) FROM leads WHERE bucket_id IN (SELECT id FROM buckets WHERE is_folder = true)
    if (bucketId) {
      const { data: bucketCheck } = await supabase
        .from('buckets').select('is_folder').eq('id', bucketId).eq('user_id', userId).single()
      if (bucketCheck?.is_folder) {
        return res.status(400).json({ error: 'Cannot assign leads to a folder. Please select a bucket.' })
      }
    }
    const campaignId = req.body.campaign_id || null
    const campaignStartDate = new Date().toISOString()
    const dispositionTagId = req.body.disposition_tag_id || null
    const leadTier = req.body.lead_tier || 'pool'
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

    const seenFilePhones = new Set()
    const uniqueFileLeads = []
    const fileDeupedLeads = []
    parseResult.valid.forEach(l => {
      if (seenFilePhones.has(l.phone)) fileDeupedLeads.push(l)
      else { seenFilePhones.add(l.phone); uniqueFileLeads.push(l) }
    })

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

    // Apply lead tier
    newLeads.forEach(l => {
      l.lead_tier = leadTier === 'priority' ? 'priority' : 'standard'
      if (leadTier === 'priority') l.queued_at = importedAt
    })

    const BATCH_SIZE = 100
    const insertedLeads = []
    for (let i = 0; i < newLeads.length; i += BATCH_SIZE) {
      const batch = newLeads.slice(i, i + BATCH_SIZE)
      const { data: batchData, error: batchError } = await supabase.from('leads').insert(batch).select()
      if (batchError) throw batchError
      insertedLeads.push(...batchData)
    }
    const data = insertedLeads

    // Batch DNC check on imported leads
    let dncFlaggedCount = 0
    if (process.env.REAL_PHONE_VALIDATION_API_KEY && data.length > 0) {
      const DNC_BATCH = 10
      for (let i = 0; i < data.length; i += DNC_BATCH) {
        const batch = data.slice(i, i + DNC_BATCH)
        const results = await Promise.allSettled(batch.map(l => checkDNC(l.phone)))
        for (let j = 0; j < results.length; j++) {
          if (results[j].status !== 'fulfilled') continue
          const dnc = results[j].value
          const lead = batch[j]
          if (dnc.is_dnc) {
            dncFlaggedCount++
            await supabase.from('leads').update({
              do_not_contact: true, autopilot: false, updated_at: new Date().toISOString()
            }).eq('id', lead.id)
            supabase.from('compliance_log').insert({
              user_id: userId, lead_id: lead.id, lead_phone: lead.phone,
              event_type: 'dnc_flagged', event_detail: 'DNC detected during CSV import'
            }).then(() => {}).catch(err => console.error('[DNC] log error:', err.message))
          }
          if (dnc.is_litigator) {
            supabase.from('compliance_log').insert({
              user_id: userId, lead_id: lead.id, lead_phone: lead.phone,
              event_type: 'litigator_flagged', event_detail: 'Known litigator detected during CSV import'
            }).then(() => {}).catch(err => console.error('[DNC] log error:', err.message))
          }
        }
      }
    }

    if (campaignId && data.length > 0) {
      const { data: campaign } = await supabase
        .from('campaigns')
        .select('*, campaign_messages(*)')
        .eq('id', campaignId)
        .eq('user_id', userId)
        .single()

      if (campaign) {
        const isQuickCampaign = !!campaign.message_1
        const dayMessages = (campaign.campaign_messages || [])
          .sort((a, b) => a.day_number - b.day_number)

        let enrollments
        if (isQuickCampaign) {
          enrollments = data.map((lead) => ({
            campaign_id: campaignId,
            lead_id: lead.id,
            status: 'pending',
            current_step: 0,
            start_date: campaignStartDate,
            next_send_at: campaignStartDate,
            user_id: userId
          }))
        } else if (dayMessages.length > 0) {
          enrollments = data.map((lead) => {
            const leadTimezone = lead.timezone || 'America/New_York'
            return {
              campaign_id: campaignId,
              lead_id: lead.id,
              status: 'pending',
              current_step: 0,
              start_date: campaignStartDate,
              next_send_at: calculateSendTime(
                dayMessages[0].day_number,
                dayMessages[0].send_time || '10:00',
                campaignStartDate,
                leadTimezone
              ),
              user_id: userId
            }
          })
        }

        if (enrollments && enrollments.length > 0) {
          const { data: insertedEnrollments } = await supabase
            .from('campaign_leads')
            .insert(enrollments)
            .select('id, lead_id')

          await supabase.from('leads').update({
            campaign_tags: [campaign.name],
            updated_at: campaignStartDate
          }).in('id', data.map(l => l.id))

          const [{ data: userPhoneNumbers }, { data: userProfile }] = await Promise.all([
            supabase.from('phone_numbers')
              .select('phone_number, state, is_default, sent_today, daily_limit, status')
              .eq('user_id', userId)
              .eq('is_active', true),
            supabase.from('user_profiles')
              .select('agency_name, compliance_footer, compliance_footer_enabled')
              .eq('id', userId)
              .single()
          ])

          for (const lead of data) {
            const quietCheck = isWithinQuietHours(lead.state, lead.timezone)
            if (quietCheck.blocked) {
              console.log(`Initial campaign send blocked (quiet hours) for lead ${lead.id}: ${quietCheck.reason}`)
              continue
            }

            const dailyCheck = checkSystemInitiatedLimit(lead.state, lead.outbound_initiated_today || 0)
            if (dailyCheck.blocked) {
              console.log(`Initial campaign send blocked (daily limit) for lead ${lead.id}`)
              continue
            }

            const rawMessage = isQuickCampaign
              ? (campaign.message_1_spintext ? spintext(campaign.message_1) : campaign.message_1)
              : spintext(dayMessages[0].message_body)

            const firstName = lead.first_name || 'there'
            const resolved = rawMessage.replace(/\[First Name\]/gi, firstName)
            let messageBody = buildMessageBody(resolved, userProfile, lead, false)
            const agencyName = userProfile?.agency_name
            if (agencyName && !messageBody.includes(agencyName)) {
              messageBody = messageBody + '\n' + agencyName
            }

            const fromNumber = pickNumberForLead(userPhoneNumbers, lead.state)
            if (!fromNumber) {
              console.log(`No phone number available for lead ${lead.id}`)
              continue
            }

            const enrollment = (insertedEnrollments || []).find(e => e.lead_id === lead.id)
            const leadTimezone = lead.timezone || 'America/New_York'

            try {
              const result = await sendSMS(lead.phone, messageBody, fromNumber, { userId, leadId: lead.id })
              if (!result.success) throw new Error(result.error || 'send failed')

              const sentAt = new Date().toISOString()

              const { data: conv } = await supabase
                .from('conversations')
                .upsert({ lead_id: lead.id, user_id: userId, status: 'active' }, { onConflict: 'lead_id,user_id', ignoreDuplicates: false })
                .select('id').single()

              if (conv?.id) {
                await supabase.from('messages').insert({
                  conversation_id: conv.id,
                  user_id: userId,
                  direction: 'outbound',
                  body: messageBody,
                  sent_at: sentAt,
                  twilio_sid: result.sid,
                  status: 'sent',
                  from_number: fromNumber
                })
                await bumpMessageCount(conv.id)
              }

              await supabase.from('leads').update({
                status: 'contacted',
                first_message_sent: true,
                updated_at: sentAt
              }).eq('id', lead.id)
              // Atomic counter bump via RPC. Lead was just created so the
              // counter is 0 and this is equivalent to the old `= 1` assignment,
              // but keeps behavior consistent with every other call site.
              await supabase.rpc('bump_outbound_initiated', { p_lead_id: lead.id })

              if (enrollment?.id) {
                if (isQuickCampaign) {
                  const stepUpdate = { step_1_sent_at: sentAt, status: 'active' }
                  if (campaign.message_2 && campaign.message_2_delay_minutes) {
                    stepUpdate.next_send_at = new Date(
                      new Date(sentAt).getTime() + campaign.message_2_delay_minutes * 60000
                    ).toISOString()
                  }
                  await supabase.from('campaign_leads').update(stepUpdate).eq('id', enrollment.id)
                } else {
                  const nextStep = 1
                  if (nextStep < dayMessages.length) {
                    const nextMsg = dayMessages[nextStep]
                    const nextSendAt = calculateSendTime(
                      nextMsg.day_number,
                      nextMsg.send_time || '10:00',
                      sentAt,
                      leadTimezone
                    )
                    await supabase.from('campaign_leads').update({
                      current_step: nextStep,
                      next_send_at: nextSendAt,
                      status: 'active'
                    }).eq('id', enrollment.id)
                  } else {
                    await supabase.from('campaign_leads').update({
                      status: 'completed',
                      completed_at: sentAt
                    }).eq('id', enrollment.id)
                  }
                }
              }

              console.log(`Initial campaign message sent to lead ${lead.id}`)
            } catch (sendErr) {
              console.error(`Initial campaign send failed for lead ${lead.id}: ${sendErr?.message}`)
            }
          }
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
    if (dncFlaggedCount > 0) parts.push(`${dncFlaggedCount} DNC-flagged`)
    if (bucket) parts.push(`into bucket "${bucket}"`)

    res.json({
      success: true,
      total_rows: totalRows,
      imported: importedCount,
      skipped_duplicates: skippedDuplicates,
      skipped_invalid_phone: parseSkipped.length,
      dnc_flagged: dncFlaggedCount,
      skipped_rows: skippedRows,
      message: parts.join(', '),
      lead_tier: leadTier,
      campaign_sends_queued: !!(campaignId && importedCount > 0),
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
    const hasFilters = !!(req.query.search || req.query.status || req.query.state || req.query.bucket_id || req.query.campaign_id || req.query.autopilot || req.query.is_sold || req.query.date_from || req.query.date_to)
    const limit = Math.min(parseInt(req.query.limit) || (hasFilters ? 500 : 50), 500)
    const offset = (page - 1) * limit

    // Handle campaign_id filter first (requires async lookup)
    let enrolledIds = null
    if (req.query.campaign_id) {
      const { data: enrolled } = await supabase
        .from('campaign_leads')
        .select('lead_id')
        .eq('campaign_id', req.query.campaign_id)
        .eq('user_id', req.user.id)
      enrolledIds = (enrolled || []).map(e => e.lead_id)
      if (enrolledIds.length === 0) return res.json({ leads: [], total: 0, page, limit })
    }

    // Fetch archived bucket IDs to exclude their leads from non-bucket-scoped views
    let archivedBucketIds = []
    if (!req.query.bucket_id) {
      const { data: archivedBuckets } = await supabase
        .from('buckets').select('id').eq('user_id', req.user.id).eq('is_archived', true)
      archivedBucketIds = (archivedBuckets || []).map(b => b.id)
    }

    const showDeleted = req.query.deleted === 'true'

    const applyQueryFilters = (q) => {
      q = q.eq('user_id', req.user.id)
      // Soft delete: default view hides deleted; ?deleted=true shows only deleted
      if (showDeleted) q = q.not('deleted_at', 'is', null)
      else q = q.is('deleted_at', null)
      // Exclude opted-out and archived-bucket leads from all views except bucket-scoped views
      if (!req.query.bucket_id) {
        q = q.eq('opted_out', false)
        if (archivedBucketIds.length > 0) {
          q = q.not('bucket_id', 'in', `(${archivedBucketIds.join(',')})`)
        }
      }
      if (req.query.search) {
        // Split search on whitespace and require each word to match at least
        // one field (first_name/last_name/phone/email). This makes multi-word
        // queries like "Test One" or "John Smith" correctly match leads whose
        // first and last names are in separate columns.
        //
        // Escape PostgREST .or() delimiters and ilike wildcards so searches
        // with punctuation (e.g., "Smith, John" or "O'Brien") don't break.
        const escapeTerm = (term) => term
          .replace(/[,()]/g, m => '\\' + m)
          .replace(/%/g, '\\%')
          .replace(/_/g, '\\_')
        const terms = req.query.search.trim().split(/\s+/).filter(Boolean).map(escapeTerm)
        for (const term of terms) {
          q = q.or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,phone.ilike.%${term}%,email.ilike.%${term}%`)
        }
      }
      if (req.query.status) q = q.eq('status', req.query.status)
      if (req.query.state) q = q.eq('state', req.query.state)
      if (req.query.bucket_id) q = q.eq('bucket_id', req.query.bucket_id)
      if (req.query.autopilot) q = q.eq('autopilot', req.query.autopilot === 'true')
      if (req.query.is_sold) q = q.eq('is_sold', req.query.is_sold === 'true')
      if (req.query.date_from) q = q.gte('created_at', req.query.date_from)
      if (req.query.date_to) q = q.lte('created_at', req.query.date_to + 'T23:59:59Z')
      if (enrolledIds) q = q.in('id', enrolledIds)
      if (req.query.tier === 'priority') {
        q = q.eq('lead_tier', 'priority')
      } else if (req.query.tier === 'worked') {
        q = q.eq('lead_tier', 'standard').not('lead_source', 'is', null)
      }
      return q
    }

    const [{ data, error }, { count, error: countErr }] = await Promise.all([
      applyQueryFilters(supabase.from('leads').select('*, campaign_leads(status), lead_dispositions(disposition_tag_id)'))
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1),
      applyQueryFilters(supabase.from('leads').select('*', { count: 'exact', head: true }))
    ])
    if (error) throw error
    if (countErr) throw countErr

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

// CHANGED: uses COUNT queries via Promise.all instead of fetching all lead rows
const getLeadStats = async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('get_lead_stats', { p_user_id: req.user.id })
    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

// CHANGED: queries buckets table directly instead of scanning all leads
const getBuckets = async (req, res) => {
  try {
    const [{ data, error }, { data: countRows }] = await Promise.all([
      supabase.from('buckets').select('*').eq('user_id', req.user.id)
        .order('created_at', { ascending: false }),
      supabase.rpc('get_bucket_lead_counts', { p_user_id: req.user.id })
    ])
    if (error) throw error
    const countMap = {}
    for (const r of countRows || []) countMap[r.bucket_id] = parseInt(r.lead_count) || 0
    res.json({ buckets: (data || []).map(b => ({ ...b, lead_count: countMap[b.id] || 0 })) })
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
      .is('deleted_at', null)
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

const updateQuotes = async (req, res) => {
  try {
    const { quotes } = req.body
    const { data, error } = await supabase
      .from('leads')
      .update({ quotes, quotes_updated_at: new Date().toISOString(), updated_at: new Date().toISOString() })
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
    const leadId = req.params.id
    const { data: lead, error } = await supabase
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .single()

    if (error || !lead) {
      return res.status(404).json({ error: 'Lead not found' })
    }

    const isAdmin = req.user.email === process.env.ADMIN_EMAIL
    if (lead.user_id !== req.user.id && !isAdmin) {
      return res.status(403).json({ error: 'Access denied' })
    }

    return res.json({ lead })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const createLead = async (req, res) => {
  try {
    const { first_name, last_name, phone, email, date_of_birth, state, zip_code, product, address, gender, notes, autopilot } = req.body
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
        gender: gender || null,
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
      .in('status', ['paused'])  // never reset active/completed — double guard
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
    .from('buckets').select('id').eq('user_id', userId).eq('system_key', 'sold').single()
  if (existing) return existing.id
  const { data: created } = await supabase
    .from('buckets').insert({ user_id: userId, name: 'Sold', color: '#22c55e', is_system: true, system_key: 'sold' })
    .select('id').single()
  return created?.id || null
}

const getOrCreateOptOutBucket = async (userId) => {
  const { data: existing } = await supabase
    .from('buckets').select('id').eq('user_id', userId).eq('system_key', 'opted_out').single()
  if (existing) return existing.id
  const { data: created } = await supabase
    .from('buckets').insert({ user_id: userId, name: 'Opted Out', color: '#ef4444', is_system: true, system_key: 'opted_out' })
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
    if (bucket_id) {
      const { data: bucket } = await supabase
        .from('buckets').select('is_folder').eq('id', bucket_id).eq('user_id', req.user.id).single()
      if (bucket?.is_folder) {
        return res.status(400).json({ error: 'Cannot assign leads to a folder. Please select a bucket.' })
      }
    }
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
      if (bucket_id) {
        const { data: bucket } = await supabase
          .from('buckets').select('is_folder').eq('id', bucket_id).eq('user_id', userId).single()
        if (bucket?.is_folder) {
          return res.status(400).json({ error: 'Cannot assign leads to a folder. Please select a bucket.' })
        }
      }
      await supabase.from('leads')
        .update({ bucket_id: bucket_id || null, updated_at: now })
        .in('id', validIds)
      return res.json({ success: true, affected: validIds.length })
    }

    if (action === 'sold') {
      const { sold_plan_type, commission } = payload
      const soldBucketId = await getOrCreateSoldBucket(userId)
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

// Soft delete — sets deleted_at; lead is hidden from all queries but can be restored.
const deleteLead = async (req, res) => {
  try {
    const leadId = req.params.id
    const userId = req.user.id

    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('leads')
      .update({ deleted_at: now, updated_at: now })
      .eq('id', leadId)
      .eq('user_id', userId)
      .select('id')
      .single()

    if (error || !data) return res.status(404).json({ error: 'Lead not found' })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

// Hard purge — removes the lead and all related rows. Blocked for opted-out leads (TCPA).
const purgeLead = async (req, res) => {
  try {
    const leadId = req.params.id
    const userId = req.user.id

    const { data: lead, error: fetchErr } = await supabase
      .from('leads')
      .select('id, opted_out')
      .eq('id', leadId).eq('user_id', userId).single()
    if (fetchErr || !lead) return res.status(404).json({ error: 'Lead not found' })

    if (lead.opted_out) {
      return res.status(403).json({ error: 'Opted-out leads cannot be permanently deleted for TCPA compliance.' })
    }

    // Gather conversation ids first (messages/messages_archive reference conversation_id, not lead_id)
    const { data: convs } = await supabase
      .from('conversations').select('id').eq('lead_id', leadId)
    const convIds = (convs || []).map(c => c.id)

    await supabase.from('lead_household_members').delete().eq('lead_id', leadId)
    await supabase.from('lead_dispositions').delete().eq('lead_id', leadId)
    await supabase.from('scheduled_messages').delete().eq('lead_id', leadId)
    await supabase.from('campaign_leads').delete().eq('lead_id', leadId)
    await supabase.from('notifications').delete().eq('lead_id', leadId)
    await supabase.from('tasks').delete().eq('lead_id', leadId)
    await supabase.from('appointments').delete().eq('lead_id', leadId)

    if (convIds.length > 0) {
      await supabase.from('messages').delete().in('conversation_id', convIds)
      await supabase.from('messages_archive').delete().in('conversation_id', convIds)
      await supabase.from('conversations').delete().in('id', convIds)
    }

    const { error } = await supabase.from('leads').delete().eq('id', leadId).eq('user_id', userId)
    if (error) throw error

    res.json({ success: true, purged: true })
  } catch (err) {
    console.error('purgeLead error:', err.message)
    res.status(500).json({ error: err.message })
  }
}

// Restore — clears deleted_at.
const restoreLead = async (req, res) => {
  try {
    const leadId = req.params.id
    const userId = req.user.id

    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('leads')
      .update({ deleted_at: null, updated_at: now })
      .eq('id', leadId)
      .eq('user_id', userId)
      .select('id')
      .single()

    if (error || !data) return res.status(404).json({ error: 'Lead not found' })
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
    const optOutBucketId = await getOrCreateOptOutBucket(req.user.id)

    const { data, error } = await supabase
      .from('leads')
      .update({ opted_out: true, opted_out_at: now, autopilot: false, updated_at: now, ...(optOutBucketId ? { bucket_id: optOutBucketId } : {}) })
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

    const seenInFile = new Set()
    const withinFileDupes = new Set()
    parseResult.valid.forEach(l => {
      if (seenInFile.has(l.phone)) withinFileDupes.add(l.phone)
      else seenInFile.add(l.phone)
    })

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

const PIPELINE_STAGES = [
  'new_lead',
  'contacted',
  'replied',
  'quoted',
  'appointment_set',
  'sold',
  'lost'
]

const updatePipelineStage = async (req, res) => {
  try {
    const { pipeline_stage } = req.body
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('leads')
      .update({
        pipeline_stage,
        pipeline_stage_set_at: now,
        pipeline_ghosted: false,
        pipeline_ghosted_at: null,
        updated_at: now
      })
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

const getPipelineLeads = async (req, res) => {
  try {
    const { range = '30d', from, to } = req.query
    let since

    if (range === 'custom' && from) {
      since = new Date(from).toISOString()
    } else {
      const days = range === 'today' ? 1
        : range === '7d' ? 7
        : range === '30d' ? 30
        : range === '60d' ? 60 : 90
      since = new Date()
      since.setDate(since.getDate() - days)
      since = since.toISOString()
    }

    let query = supabase
      .from('leads')
      .select('id, first_name, last_name, phone, state, zip_code, status, pipeline_stage, pipeline_stage_set_at, pipeline_ghosted, pipeline_ghosted_at, notes, updated_at')
      .eq('user_id', req.user.id)
      .is('deleted_at', null)
      .not('pipeline_stage', 'is', null)
      .gte('pipeline_stage_set_at', since)
      .order('pipeline_stage_set_at', { ascending: false })

    if (range === 'custom' && to) {
      query = query.lte('pipeline_stage_set_at', new Date(to + 'T23:59:59Z').toISOString())
    }

    const { data, error } = await query
    if (error) throw error

    // Group by stage
    const grouped = {}
    PIPELINE_STAGES.forEach(s => { grouped[s] = [] })
    for (const lead of data || []) {
      if (grouped[lead.pipeline_stage]) grouped[lead.pipeline_stage].push(lead)
    }

    // Fetch last message preview for each lead
    const leadIds = (data || []).map(l => l.id)
    let lastMsgMap = {}
    if (leadIds.length > 0) {
      // user_id filter is safe here — leadIds were already user-scoped above
      const { data: convs } = await supabase
        .from('conversations')
        .select('lead_id, id')
        .eq('user_id', req.user.id)
        .in('lead_id', leadIds)
      if (convs && convs.length > 0) {
        const convIds = convs.map(c => c.id)
        const convLeadMap = {}
        convs.forEach(c => { convLeadMap[c.id] = c.lead_id })
        const { data: lastMsgs } = await supabase
          .from('messages')
          .select('conversation_id, body, sent_at')
          .in('conversation_id', convIds)
          .order('sent_at', { ascending: false })
        if (lastMsgs) {
          for (const m of lastMsgs) {
            const leadId = convLeadMap[m.conversation_id]
            if (leadId && !lastMsgMap[leadId]) lastMsgMap[leadId] = m.body
          }
        }
      }
    }

    // Attach last message preview
    for (const stage of PIPELINE_STAGES) {
      grouped[stage] = grouped[stage].map(l => ({
        ...l,
        last_message: lastMsgMap[l.id] || null
      }))
    }

    res.json({ stages: grouped, total: data?.length || 0 })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const patchLead = async (req, res) => {
  try {
    const allowed = ['lead_tier', 'lead_cost', 'lead_source', 'queued_at']
    const updates = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key]
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' })
    }
    updates.updated_at = new Date().toISOString()

    const { data, error } = await supabase
      .from('leads')
      .update(updates)
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

// ─── HOUSEHOLD MEMBERS ───────────────────────────────────────────────────────

const calcAge = (dob) => Math.floor((Date.now() - new Date(dob).getTime()) / 31557600000)

const assignRole = (dob, existingAdultCount) => {
  const age = calcAge(dob)
  if (age <= 26) return 'dependent'
  return existingAdultCount === 0 ? 'spouse' : 'adult'
}

const reassignRoles = async (leadId, userId) => {
  const { data: members } = await supabase
    .from('lead_household_members')
    .select('id, date_of_birth')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: true })
  if (!members || !members.length) return

  let adultCount = 0
  for (const m of members) {
    const age = calcAge(m.date_of_birth)
    let role
    if (age <= 26) {
      role = 'dependent'
    } else {
      role = adultCount === 0 ? 'spouse' : 'adult'
      adultCount++
    }
    await supabase.from('lead_household_members').update({ role }).eq('id', m.id)
  }
}

const getHouseholdMembers = async (req, res) => {
  try {
    const { data: members, error } = await supabase
      .from('lead_household_members')
      .select('id, date_of_birth, role, created_at')
      .eq('lead_id', req.params.id)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: true })
    if (error) throw error
    const enriched = (members || []).map(m => ({ ...m, age: calcAge(m.date_of_birth) }))
    res.json({ members: enriched })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const addHouseholdMember = async (req, res) => {
  console.log('[household] POST called, lead_id:', req.params.id)
  try {
    const { date_of_birth } = req.body
    if (!date_of_birth) return res.status(400).json({ error: 'Date of birth is required' })

    // Verify lead belongs to user
    const { data: lead } = await supabase.from('leads').select('id').eq('id', req.params.id).eq('user_id', req.user.id).single()
    if (!lead) return res.status(404).json({ error: 'Lead not found' })

    // Count existing adults (27+) for role assignment
    const { data: existing } = await supabase
      .from('lead_household_members')
      .select('id, date_of_birth')
      .eq('lead_id', req.params.id)
    const adultCount = (existing || []).filter(m => calcAge(m.date_of_birth) >= 27).length

    const role = assignRole(date_of_birth, adultCount)

    const { data: member, error } = await supabase
      .from('lead_household_members')
      .insert({ lead_id: req.params.id, user_id: req.user.id, date_of_birth, role })
      .select()
      .single()
    if (error) throw error

    // Update household count on lead
    const newCount = (existing || []).length + 1 + 1 // existing members + new one + primary
    await supabase.from('leads').update({ household_size: newCount, updated_at: new Date().toISOString() }).eq('id', req.params.id)

    res.json({ member: { ...member, age: calcAge(date_of_birth) } })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const deleteHouseholdMember = async (req, res) => {
  try {
    // Verify lead belongs to user
    const { data: lead } = await supabase.from('leads').select('id').eq('id', req.params.id).eq('user_id', req.user.id).single()
    if (!lead) return res.status(404).json({ error: 'Lead not found' })

    const { error } = await supabase
      .from('lead_household_members')
      .delete()
      .eq('id', req.params.memberId)
      .eq('lead_id', req.params.id)
    if (error) throw error

    // Re-assign roles for remaining members
    await reassignRoles(req.params.id, req.user.id)

    // Update household count
    const { data: remaining } = await supabase
      .from('lead_household_members')
      .select('id')
      .eq('lead_id', req.params.id)
    const newCount = (remaining || []).length + 1 // remaining + primary
    await supabase.from('leads').update({ household_size: newCount, updated_at: new Date().toISOString() }).eq('id', req.params.id)

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

module.exports = { parseHeaders, uploadLeads, riskCheck, getLeads, getLeadStats, getBuckets, exportLeads, getLeadById, updateAutopilot, updateNotes, updateQuotes, updateProduct, updateCommissionStatus, updateLeadBucket, createLead, resumeCampaigns, blockLead, unblockLead, markSold, unmarkSold, deleteLead, purgeLead, restoreLead, skipToday, pauseDrips, markCalled, bulkAction, optOut, undoOptOut, checkQuietHours, logComplianceOverride, getOrCreateOptOutBucket, getPipelineLeads, updatePipelineStage, patchLead, getHouseholdMembers, addHouseholdMember, deleteHouseholdMember, calcAge, assignRole }
