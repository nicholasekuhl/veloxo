// Access Request Notification — sent to admin (ADMIN_EMAIL) when a new
// user submits the request-access form. Plaintext-style internal alert,
// intentionally not wrapped in brand(). Fire-and-forget.

const { resend, FROM } = require('../utils/email')

const sendAccessRequestNotificationEmail = async ({ name, email, notes }) => {
  const displayName = name || 'Anonymous'
  const displayNotes = notes || 'None provided'
  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short'
  }) + ' ET'

  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111;">
      <h2 style="margin:0 0 16px;font-size:18px;">New access request received.</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:8px 0;color:#666;width:80px;">Name:</td><td style="padding:8px 0;font-weight:500;">${displayName}</td></tr>
        <tr><td style="padding:8px 0;color:#666;">Email:</td><td style="padding:8px 0;font-weight:500;">${email}</td></tr>
        <tr><td style="padding:8px 0;color:#666;vertical-align:top;">Notes:</td><td style="padding:8px 0;white-space:pre-wrap;">${displayNotes}</td></tr>
        <tr><td style="padding:8px 0;color:#666;">Time:</td><td style="padding:8px 0;">${timestamp}</td></tr>
      </table>
      <p style="margin:20px 0 0;font-size:14px;">
        Review and invite at:<br>
        <a href="https://app.veloxo.io/admin.html" style="color:#0ea5e9;">https://app.veloxo.io/admin.html</a>
      </p>
    </div>
  `

  try {
    await resend.emails.send({
      from: FROM.noreply,
      to: process.env.ADMIN_EMAIL || 'you@youragency.com',
      subject: `New Access Request — ${displayName} (${email})`,
      html
    })
  } catch (err) {
    console.error('[email:accessRequestNotification]', err.message)
  }
}

module.exports = { sendAccessRequestNotificationEmail }
