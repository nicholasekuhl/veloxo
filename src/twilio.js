const twilio = require('twilio')
const { normalizeState, getStateFromPhone } = require('./areaCodes')

const getMasterClient = () => {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) throw new Error('Master Twilio credentials not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)')
  return twilio(sid, token)
}

const sendSMS = async (to, body, fromNumber) => {
  try {
    const from = fromNumber || process.env.TWILIO_PHONE_NUMBER
    if (!from) throw new Error('No from number available — purchase a phone number in Settings')

    const client = getMasterClient()
    const params = { body, from, to }
    const appUrl = process.env.APP_URL
    if (appUrl) {
      params.statusCallback = `${appUrl}/messages/status`
    }

    const message = await client.messages.create(params)
    console.log(`SMS sent to ${to} from ${from} — SID: ${message.sid}`)
    return { success: true, sid: message.sid }
  } catch (err) {
    console.error(`SMS failed to ${to}:`, err.message)
    return { success: false, error: err.message }
  }
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
 * 1. Number whose state matches lead's state (via stored state field, then area code lookup)
 * 2. Number marked is_default
 * 3. First active number
 * Returns phone_number string or null.
 */
const pickNumberForLead = (phoneNumbers, leadState) => {
  if (!phoneNumbers || phoneNumbers.length === 0) return null

  const normLeadState = normalizeState(leadState)
  if (normLeadState) {
    const stateMatch = phoneNumbers.find(pn => {
      const pnState = normalizeState(pn.state) || getStateFromPhone(pn.phone_number)
      return pnState === normLeadState
    })
    if (stateMatch) return stateMatch.phone_number
  }

  const defaultNum = phoneNumbers.find(pn => pn.is_default === true)
  if (defaultNum) return defaultNum.phone_number

  return phoneNumbers[0].phone_number
}

/**
 * Get the best from-number for a user + lead state, querying the DB.
 */
const getNumberForLead = async (userId, leadState) => {
  const supabase = require('./db')
  const { data } = await supabase
    .from('phone_numbers')
    .select('phone_number, state, is_default')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: true })
  return pickNumberForLead(data || [], leadState) || process.env.TWILIO_PHONE_NUMBER || null
}

module.exports = { sendSMS, getMasterClient, buildMessageBody, pickNumberForLead, getNumberForLead }
