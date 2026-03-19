const twilio = require('twilio')

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

module.exports = { sendSMS, getMasterClient, buildMessageBody }
