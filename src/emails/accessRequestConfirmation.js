// Access Request Confirmation — sent to applicant after they submit the
// request-access form. Fire-and-forget: swallows send errors and logs.

const { resend, FROM, brand } = require('../utils/email')

const sendAccessRequestConfirmationEmail = async ({ name, email }) => {
  const displayName = name || 'there'

  const bodyHtml = `<h1 style="font-size:22px;font-weight:700;letter-spacing:-0.3px;color:#fff;margin:0 0 18px;">You're on the list</h1>
          <p style="margin:0 0 14px;">Hi ${displayName},</p>
          <p style="margin:0 0 14px;">Thanks for your interest in Veloxo. We've received your request and you're on our early access list.</p>
          <p style="margin:0 0 14px;">We're onboarding agents carefully to make sure every user gets the best experience. We'll reach out to <strong style="color:#34d8b8;">${email}</strong> as soon as a spot opens up.</p>
          <p style="margin:0 0 18px;">In the meantime, if you have questions you can reach us at <a href="mailto:support@veloxo.io" style="color:#34d8b8;text-decoration:none;">support@veloxo.io</a>.</p>
          <p style="margin:0;color:rgba(255,255,255,0.55);">— The Veloxo Team</p>`

  try {
    await resend.emails.send({
      from: FROM.invites,
      to: email,
      subject: "You're on the list — Veloxo Early Access",
      html: brand({ bodyHtml })
    })
  } catch (err) {
    console.error('[email:accessRequestConfirmation]', err.message)
  }
}

module.exports = { sendAccessRequestConfirmationEmail }
