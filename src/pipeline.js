const STAGE_ORDER = [
  'replied',
  'household_confirmed',
  'income_provided',
  'medical_shared',
  'budget_provided',
  'appointment_scheduled',
  'sold'
]

// Detect pipeline stage from conversation history using regex — zero API calls
function detectPipelineStage(lead, messages) {
  // fullText (all messages) is used ONLY for appointment_scheduled,
  // which checks for confirmation phrases that appear in outbound AI replies.
  // All other stage checks use inbound (lead messages only) to prevent
  // AI qualifying questions from falsely advancing stages.
  const fullText = messages
    .map(m => m.body || m.content || '')
    .join(' ')
    .toLowerCase()
  const inbound = messages
    .filter(m => m.direction === 'inbound' || m.role === 'user')
    .map(m => m.body || m.content || '')
    .join(' ')
    .toLowerCase()

  // Sold
  if (lead.is_sold) return 'sold'

  // Appointment scheduled
  if (
    lead.status === 'booked' ||
    fullText.includes('locked in') ||
    fullText.includes('will call you') ||
    fullText.includes('call you tomorrow') ||
    fullText.includes('call you today') ||
    /scheduled.*call|call.*scheduled/i.test(fullText)
  ) return 'appointment_scheduled'

  // Budget provided
  const hasBudget = /\$\d+|\d+\s*(per month|\/mo|a month|monthly)|budget|around \d+|stay around/i.test(inbound)
  if (hasBudget) return 'budget_provided'

  // Medical shared
  const hasMedical = /medication|prescription|doctor|condition|diagnosis|surgery|no meds|no medications|healthy|none|no conditions|taking/i.test(inbound)
  if (hasMedical) return 'medical_shared'

  // Income provided
  const hasIncome = /\$[\d,]+|\d+k\b|\d[\d,]{2,}|income|salary|make|earn|year|annual/i.test(inbound)
  if (hasIncome) return 'income_provided'

  // Household confirmed
  const hasHousehold = /just me|myself|individual|family|wife|husband|kids|children|spouse|partner|son|daughter|\d+ (of us|people|kids)|(ages?|years? old)\s+\d+/i.test(inbound)
  if (hasHousehold) return 'household_confirmed'

  // Replied — any inbound message that isn't an opt-out
  const OPT_OUT = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']
  const hasRealReply = messages.some(m =>
    (m.direction === 'inbound' || m.role === 'user') &&
    !OPT_OUT.includes((m.body || m.content || '').trim().toLowerCase())
  )
  if (hasRealReply) return 'replied'

  return null
}

// Extract structured data from conversation for AI notes — returns null if nothing new
function extractLeadDataFromHistory(lead, messages) {
  const inbound = messages
    .filter(m => m.direction === 'inbound' || m.role === 'user')
    .map(m => m.body || m.content || '')
    .join(' ')

  const extracted = {}

  // ZIP code
  const zipMatch = inbound.match(/\b(\d{5})\b/)
  if (zipMatch && !lead.zip_code) extracted.zip_code = zipMatch[1]

  // Income
  const incomeMatch =
    inbound.match(/\$?([\d,]+)\s*(?:k|thousand|a year|\/year|per year|annually)/i) ||
    inbound.match(/(?:make|earn|income|salary)\s+(?:about|around|roughly)?\s*\$?([\d,]+)/i)
  if (incomeMatch && !lead.income) {
    let inc = incomeMatch[1].replace(/,/g, '')
    if (/k\b/i.test(inbound) || parseInt(inc) < 1000) inc = String(parseInt(inc) * 1000)
    extracted.income = parseInt(inc)
  }

  // State
  const stateMatch = inbound.match(/\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/)
  if (stateMatch && !lead.state) extracted.state = stateMatch[1]

  return Object.keys(extracted).length > 0 ? extracted : null
}

// Generate a plain-text notes summary of what's been collected
function generateNoteSummary(lead, stage) {
  const parts = []

  if (lead.first_name)
    parts.push(lead.first_name + (lead.last_name ? ' ' + lead.last_name : ''))
  if (lead.state) parts.push(lead.state)
  if (lead.zip_code) parts.push(lead.zip_code)
  if (lead.income)
    parts.push('income ~$' + Number(lead.income).toLocaleString())
  if (stage)
    parts.push('stage: ' + stage.replace(/_/g, ' '))

  return parts.join(', ')
}

module.exports = {
  detectPipelineStage,
  extractLeadDataFromHistory,
  generateNoteSummary,
  STAGE_ORDER
}

// DATA FIX: Run once in Supabase SQL editor to
// clear pipeline stages from opted-out leads:
// UPDATE leads SET pipeline_stage = null,
//   pipeline_ghosted = false,
//   pipeline_ghosted_at = null
// WHERE (opted_out = true OR status = 'opted_out')
//   AND pipeline_stage IS NOT NULL;
