// Sending addresses (set via env or defaults):
// RESEND_FROM_INVITES=invites@veloxo.io
// RESEND_FROM_NOREPLY=noreply@veloxo.io
// RESEND_FROM_BILLING=billing@veloxo.io
// RESEND_FROM_SUPPORT=support@veloxo.io

const { Resend } = require('resend')
const resend = new Resend(process.env.RESEND_API_KEY)

const FROM = {
  invites: process.env.RESEND_FROM_INVITES || 'invites@veloxo.io',
  noreply: process.env.RESEND_FROM_NOREPLY || 'noreply@veloxo.io',
  billing: process.env.RESEND_FROM_BILLING || 'billing@veloxo.io',
  support: process.env.RESEND_FROM_SUPPORT || 'support@veloxo.io',
}

// Wraps body content in the standard Veloxo branded shell
// (dark theme, gradient logo header, footer).
const brand = ({ bodyHtml }) => `
    <div style="font-family:system-ui,-apple-system,sans-serif;background:#08080f;padding:40px 20px;margin:0;">
      <div style="max-width:520px;margin:0 auto;background:#0f0f18;border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;">
        <div style="padding:32px 36px 8px;text-align:center;">
          <div style="display:inline-flex;align-items:center;gap:10px;">
            <div style="width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,#00c9a7,#0ea5e9);display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;">
              <span style="color:#fff;font-weight:700;font-size:16px;letter-spacing:-1px;">&rsaquo;&rsaquo;&rsaquo;</span>
            </div>
            <span style="font-size:22px;font-weight:700;letter-spacing:-0.5px;color:#fff;vertical-align:middle;"><span style="color:#00d4b4;">Velox</span>o</span>
          </div>
        </div>
        <div style="padding:24px 36px 36px;color:rgba(255,255,255,0.75);font-size:15px;line-height:1.65;">
          ${bodyHtml}
        </div>
        <div style="padding:16px 36px;border-top:1px solid rgba(255,255,255,0.06);text-align:center;font-size:12px;color:rgba(255,255,255,0.35);">
          <a href="https://veloxo.io" style="color:rgba(255,255,255,0.55);text-decoration:none;">veloxo.io</a>
          &nbsp;&middot;&nbsp;
          <a href="mailto:support@veloxo.io" style="color:rgba(255,255,255,0.55);text-decoration:none;">support@veloxo.io</a>
        </div>
      </div>
    </div>
  `

const sendCreditPurchaseEmail = async ({
  toEmail, agentName, creditType,
  creditAmount, dollarAmount, newBalance
}) => {
  await resend.emails.send({
    from: FROM.billing,
    to: toEmail,
    subject: `Credit Purchase Confirmed — ${creditAmount} ${creditType} Credits`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#0a0a0f">Purchase Confirmed</h2>
        <p>Hi ${agentName},</p>
        <p>Your credit purchase was successful.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr>
            <td style="padding:8px;border-bottom:1px solid #eee">Credit Type</td>
            <td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold">
              ${creditType} Credits</td>
          </tr>
          <tr>
            <td style="padding:8px;border-bottom:1px solid #eee">Credits Added</td>
            <td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold">
              +${creditAmount.toLocaleString()}</td>
          </tr>
          <tr>
            <td style="padding:8px;border-bottom:1px solid #eee">Amount Charged</td>
            <td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold">
              $${dollarAmount}</td>
          </tr>
          <tr>
            <td style="padding:8px">New Balance</td>
            <td style="padding:8px;font-weight:bold">
              ${newBalance.toLocaleString()} credits</td>
          </tr>
        </table>
        <p>Questions? Reply to this email or contact
           <a href="mailto:support@veloxo.io">support@veloxo.io</a></p>
        <p style="color:#666;font-size:12px;margin-top:24px">
          Veloxo &middot; veloxo.io</p>
      </div>
    `
  })
}

module.exports = { sendCreditPurchaseEmail, FROM, resend, brand }
