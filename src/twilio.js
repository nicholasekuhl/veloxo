const twilio = require('twilio')

const getTwilioClient = (accountSid, authToken) => {
  return twilio(accountSid, authToken)
}

// credentials can be a user_profile or a phone_numbers record
// profile:      { twilio_account_sid, twilio_auth_token, twilio_phone_number }
// phone_number: { twilio_account_sid, twilio_auth_token, phone_number }
const sendSMS = async (to, body, credentials) => {
  try {
    const accountSid = credentials?.twilio_account_sid || process.env.TWILIO_ACCOUNT_SID
    const authToken = credentials?.twilio_auth_token || process.env.TWILIO_AUTH_TOKEN
    const fromNumber = credentials?.phone_number || credentials?.twilio_phone_number || process.env.TWILIO_PHONE_NUMBER

    if (!accountSid || !authToken || !fromNumber) {
      throw new Error('Missing Twilio credentials — set them in your profile or add a phone number')
    }

    const client = getTwilioClient(accountSid, authToken)
    const params = { body, from: fromNumber, to }
    if (process.env.STATUS_CALLBACK_URL) {
      params.statusCallback = process.env.STATUS_CALLBACK_URL
    }

    const message = await client.messages.create(params)
    console.log(`SMS sent to ${to} from ${fromNumber} — SID: ${message.sid}`)
    return { success: true, sid: message.sid }
  } catch (err) {
    console.error(`SMS failed to ${to}:`, err.message)
    return { success: false, error: err.message }
  }
}

module.exports = { sendSMS, getTwilioClient }
