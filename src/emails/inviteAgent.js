// Invite Agent — sent when an admin invites a new agent to Veloxo.
// Contains a tokenized accept-invite link that expires in 7 days.
// Blocking send: errors propagate so the caller can respond with 500.

const { resend, FROM, brand } = require('../utils/email')

const sendInviteAgentEmail = async ({ email, inviteUrl }) => {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[email:inviteAgent] RESEND_API_KEY not set — invite email not sent. Link:', inviteUrl)
    return
  }

  const bodyHtml = `<h1 style="font-size:22px;font-weight:700;letter-spacing:-0.3px;color:#fff;margin:0 0 18px;">You're invited to Veloxo</h1>
          <p style="margin:0 0 14px;">You've been invited to join Veloxo, the AI-powered SMS platform for insurance agents.</p>
          <p style="margin:0 0 22px;">Click below to set up your account and get started.</p>
          <div style="text-align:center;margin:0 0 22px;">
            <a href="${inviteUrl}" style="display:inline-block;background:linear-gradient(135deg,#00c9a7,#0ea5e9);color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px;letter-spacing:-0.2px;">Accept Invite</a>
          </div>
          <p style="margin:0 0 14px;font-size:13px;color:rgba(255,255,255,0.45);">Or paste this link into your browser:</p>
          <p style="margin:0 0 22px;font-size:13px;word-break:break-all;"><a href="${inviteUrl}" style="color:#34d8b8;text-decoration:none;">${inviteUrl}</a></p>
          <p style="margin:0;color:rgba(255,255,255,0.45);font-size:12px;">This link expires in 7 days. If you didn't expect this invite, you can ignore this email.</p>`

  await resend.emails.send({
    from: FROM.invites,
    to: email,
    subject: 'You have been invited to Veloxo',
    html: brand({ bodyHtml })
  })
}

module.exports = { sendInviteAgentEmail }
