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
    if (process.env.STATUS_CALLBACK_URL) {
      params.statusCallback = process.env.STATUS_CALLBACK_URL
    }

    const message = await client.messages.create(params)
    console.log(`SMS sent to ${to} from ${from} — SID: ${message.sid}`)
    return { success: true, sid: message.sid }
  } catch (err) {
    console.error(`SMS failed to ${to}:`, err.message)
    return { success: false, error: err.message }
  }
}

module.exports = { sendSMS, getMasterClient }
