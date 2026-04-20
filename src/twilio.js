const twilio = require('twilio')
const { normalizeState, getStateFromPhone } = require('./areaCodes')

const getMasterClient = () => {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) throw new Error('Master Twilio credentials not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)')
  return twilio(sid, token)
}

// ─── Per-number rate limiter ───────────────────────────────────────────────
const numberRateLimits = new Map()
const RATE_LIMIT_WINDOW_MS = 60000 // 1 minute
const MAX_PER_MINUTE = 30          // per number
const MIN_DELAY_MS = 1500          // 1.5 seconds between sends

const checkAndEnforceRateLimit = async (fromNumber) => {
  const now = Date.now()
  const key = fromNumber

  if (!numberRateLimits.has(key)) {
    numberRateLimits.set(key, [])
  }

  const timestamps = numberRateLimits.get(key)

  // Remove timestamps older than 1 minute
  const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS)
  numberRateLimits.set(key, recent)

  // Check if at limit
  if (recent.length >= MAX_PER_MINUTE) {
    const oldestInWindow = recent[0]
    const waitMs = RATE_LIMIT_WINDOW_MS - (now - oldestInWindow)
    console.log(`Rate limit hit for ${fromNumber} — waiting ${waitMs}ms`)
    await new Promise(r => setTimeout(r, waitMs))
  }

  // Enforce minimum delay between sends
  if (recent.length > 0) {
    const lastSend = recent[recent.length - 1]
    const elapsed = now - lastSend
    if (elapsed < MIN_DELAY_MS) {
      await new Promise(r => setTimeout(r, MIN_DELAY_MS - elapsed))
    }
  }

  // Record this send
  recent.push(Date.now())
  numberRateLimits.set(key, recent)
}
// ──────────────────────────────────────────────────────────────────────────

const sendSMS = async (to, body, fromNumber) => {
  try {
    const from = fromNumber || process.env.TWILIO_PHONE_NUMBER
    if (!from) throw new Error('No from number available — purchase a phone number in Settings')

    await checkAndEnforceRateLimit(from)

    const client = getMasterClient()
    const params = { body, from, to }
    const appUrl = process.env.APP_URL
    if (appUrl) {
      params.statusCallback = `${appUrl}/messages/status`
    }

    const message = await client.messages.create(params)
    console.log(`SMS sent to ${to} from ${from} — SID: ${message.sid}`)

    // Increment sent_today counter for this number
    incrementSentToday(from).catch(() => {})

    return {
      success: true,
      sid: message.sid,
      // Twilio's numSegments is the billable segment count (160 chars GSM-7,
      // 70 chars UCS-2). Used by deductSmsCredit so multi-segment messages
      // are billed correctly.
      segments: parseInt(message.numSegments || '1', 10),
      // price is in Twilio's billing currency (may not be USD) — informational
      // only, used for periodic reconciliation, not for billing the user.
      price: message.price ? parseFloat(message.price) : null
    }
  } catch (err) {
    console.error(`SMS failed to ${to}:`, err.message)
    return { success: false, error: err.message }
  }
}

const incrementSentToday = async (phoneNumber) => {
  const supabase = require('./db')
  await supabase.rpc('increment_sent_today', { p_phone_number: phoneNumber }).catch(() => {
    // Fallback: raw update
    supabase
      .from('phone_numbers')
      .update({ sent_today: supabase.raw('sent_today + 1') })
      .eq('phone_number', phoneNumber)
      .catch(() => {})
  })
}

const buildMessageBody = (body, userProfile, lead, isFirstMessage) => {
  const isFirst = isFirstMessage || !lead?.first_message_sent
  if (!isFirst) return body
  if (userProfile?.compliance_footer_enabled === false) return body

  let footer
  if (userProfile?.compliance_footer) {
    footer = userProfile.compliance_footer
  } else {
    const agencyName = userProfile?.agency_name
    footer = agencyName ? `Reply STOP to opt out. ${agencyName}` : 'Reply STOP to opt out.'
  }

  return `${body}\n${footer}`
}

/**
 * Pick the best from-number for a lead given an array of phone_number records.
 * Priority:
 * 1. Number whose state matches lead's state AND is under daily limit AND not cooling/flagged
 * 2. Number marked is_default (if available and under limit)
 * 3. First active number under limit
 * Returns phone_number string or null.
 */
const pickNumberForLead = (phoneNumbers, leadState) => {
  if (!phoneNumbers || phoneNumbers.length === 0) return null

  // Filter out cooling/flagged numbers and those at daily limit
  const available = phoneNumbers.filter(pn => {
    if (pn.status === 'flagged' || pn.status === 'retired') return false
    if (pn.daily_limit != null && pn.sent_today != null && pn.sent_today >= pn.daily_limit) return false
    return true
  })

  // Fall back to all numbers if none available after filtering
  const pool = available.length > 0 ? available : phoneNumbers

  const normLeadState = normalizeState(leadState)
  if (normLeadState) {
    const stateMatch = pool.find(pn => {
      const pnState = normalizeState(pn.state) || getStateFromPhone(pn.phone_number)
      return pnState === normLeadState
    })
    if (stateMatch) return stateMatch.phone_number
  }

  const defaultNum = pool.find(pn => pn.is_default === true)
  if (defaultNum) return defaultNum.phone_number

  return pool[0].phone_number
}

/**
 * Get the best from-number for a user + lead state, querying the DB.
 * Respects daily limits, cooling/flagged status.
 */
const getNumberForLead = async (userId, leadState) => {
  const supabase = require('./db')
  const { data } = await supabase
    .from('phone_numbers')
    .select('phone_number, state, is_default, status, sent_today, daily_limit, cooloff_until')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('sent_today', { ascending: true })
  return pickNumberForLead(data || [], leadState) || process.env.TWILIO_PHONE_NUMBER || null
}

/**
 * Select best number for a user + lead state with full DB logic.
 * Returns the full phone_numbers row or null.
 */
const selectBestNumber = async (userId, leadState) => {
  const supabase = require('./db')
  const normState = normalizeState(leadState)

  // First: state-matched number under daily limit, not cooling/flagged
  if (normState) {
    const { data: stateMatch } = await supabase
      .from('phone_numbers')
      .select('phone_number, id, sent_today, daily_limit, state, status, cooloff_until')
      .eq('user_id', userId)
      .eq('is_active', true)
      .eq('state', normState)
      .not('status', 'in', '("flagged","retired")')
      .lt('sent_today', supabase.raw('daily_limit'))
      .order('sent_today', { ascending: true })
      .limit(1)
    if (stateMatch && stateMatch.length > 0) return stateMatch[0]
  }

  // Fallback: any available number
  const { data: anyNumber } = await supabase
    .from('phone_numbers')
    .select('phone_number, id, sent_today, daily_limit, state, status, cooloff_until')
    .eq('user_id', userId)
    .eq('is_active', true)
    .not('status', 'in', '("flagged","retired")')
    .lt('sent_today', supabase.raw('daily_limit'))
    .order('sent_today', { ascending: true })
    .limit(1)

  return (anyNumber && anyNumber.length > 0) ? anyNumber[0] : null
}

module.exports = { sendSMS, getMasterClient, buildMessageBody, pickNumberForLead, getNumberForLead, selectBestNumber }
