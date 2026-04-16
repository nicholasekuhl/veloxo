const express = require('express')
const router = express.Router()
const supabase = require('../db')

const getInitials = (name) => {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?'
}

const esc = (str) => (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const notFoundPage = () => `<!DOCTYPE html>
<html><head><title>Page Not Found</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,sans-serif;max-width:680px;margin:0 auto;padding:80px 24px;text-align:center;color:#1a1a2e;background:#fafafa;}h1{font-size:48px;margin:0 0 8px;color:#ccc;}p{color:#888;}</style>
</head><body><h1>404</h1><p>This page does not exist.</p></body></html>`

const inactivePage = (agentName) => `<!DOCTYPE html>
<html><head><title>${esc(agentName)} | Page Not Active</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,sans-serif;max-width:680px;margin:0 auto;padding:80px 24px;text-align:center;color:#1a1a2e;background:#fafafa;}p{color:#888;line-height:1.6;}</style>
</head><body><p>This compliance page is not yet active.</p></body></html>`

const compliancePage = (profile) => {
  const name = esc(profile.agent_name || 'Agent')
  const agency = esc(profile.agency_name || 'Agency')
  const email = esc(profile.email || '')
  const slug = esc(profile.agent_slug)
  const initials = esc(getInitials(profile.agent_name))

  return `<!DOCTYPE html>
<html>
<head>
  <title>${name} | ${agency}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 680px; margin: 0 auto; padding: 40px 24px; color: #1a1a2e; background: #fafafa; }
    .avatar { width: 64px; height: 64px; border-radius: 50%; background: #00c9a7; display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 700; color: white; margin-bottom: 16px; }
    h1 { font-size: 24px; margin: 0 0 4px; }
    .agency { color: #666; margin-bottom: 32px; }
    .section { margin-bottom: 28px; }
    .section h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #999; margin-bottom: 12px; }
    .section p { line-height: 1.7; color: #444; }
    .rights li { margin-bottom: 8px; line-height: 1.6; color: #444; }
    .footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid #eee; font-size: 12px; color: #aaa; display: flex; gap: 16px; }
    .footer a { color: #aaa; text-decoration: none; }
    .footer a:hover { color: #666; }
    .powered { margin-left: auto; }
  </style>
</head>
<body>
  <div class="avatar">${initials}</div>
  <h1>${name}</h1>
  <p class="agency">${agency} &middot; Licensed Insurance Advisor</p>

  <div class="section">
    <h2>Why am I receiving text messages?</h2>
    <p>You are receiving SMS messages because you recently submitted a request for health insurance information or a quote. By submitting that form, you provided express written consent to be contacted by ${agency} and its licensed agents via automated text message at the number you provided.</p>
  </div>

  <div class="section">
    <h2>Your Rights</h2>
    <ul class="rights">
      <li>Message frequency varies based on your inquiry</li>
      <li>Message and data rates may apply</li>
      <li>Reply <strong>STOP</strong> at any time to opt out permanently</li>
      <li>Reply <strong>HELP</strong> for assistance</li>
      <li>For questions contact: ${email}</li>
    </ul>
  </div>

  <div class="section">
    <h2>Consent Language</h2>
    <p>By requesting insurance information, you consented to receive automated SMS messages from ${agency}. Your consent is not a condition of any purchase.</p>
  </div>

  <div class="footer">
    <a href="/${slug}/privacy">Privacy Policy</a>
    <a href="/${slug}/terms">Terms &amp; Conditions</a>
    <span class="powered">Powered by Veloxo</span>
  </div>
</body>
</html>`
}

const privacyPage = (profile) => {
  const name = esc(profile.agent_name || 'Agent')
  const agency = esc(profile.agency_name || 'Agency')
  const email = esc(profile.email || '')
  const slug = esc(profile.agent_slug)

  return `<!DOCTYPE html>
<html>
<head>
  <title>Privacy Policy | ${agency}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 680px; margin: 0 auto; padding: 40px 24px; color: #1a1a2e; background: #fafafa; line-height: 1.7; }
    h1 { font-size: 22px; margin-bottom: 4px; }
    .sub { color: #888; margin-bottom: 32px; font-size: 14px; }
    h2 { font-size: 15px; margin: 28px 0 8px; color: #333; }
    p, li { color: #444; font-size: 14px; }
    ul { padding-left: 20px; }
    li { margin-bottom: 6px; }
    .back { display: inline-block; margin-top: 32px; color: #00c9a7; text-decoration: none; font-size: 13px; }
    .back:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p class="sub">${agency}</p>

  <h2>Information We Collect</h2>
  <p>When you request insurance information, we collect your name, phone number, email address, zip code, and other details you provide on the inquiry form.</p>

  <h2>How We Use Your Information</h2>
  <ul>
    <li>To contact you about your insurance inquiry via SMS, phone, or email</li>
    <li>To provide quotes, plan information, and enrollment assistance</li>
    <li>To send appointment reminders and follow-up messages</li>
  </ul>

  <h2>SMS Communications</h2>
  <p>By submitting your phone number, you consent to receive automated SMS messages from ${agency} and its licensed agents. Message frequency varies. Message and data rates may apply. Reply STOP to opt out at any time. Reply HELP for assistance.</p>

  <h2>Data Sharing</h2>
  <p>We do not sell your personal information to third parties. Your data may be shared with insurance carriers solely for the purpose of providing you with quotes and coverage options you requested.</p>

  <h2>Data Retention</h2>
  <p>We retain your information for as long as necessary to fulfill your insurance inquiry and comply with legal obligations. You may request deletion of your data at any time by contacting us.</p>

  <h2>Contact</h2>
  <p>For questions about this privacy policy, contact ${name} at <a href="mailto:${email}" style="color:#00c9a7;">${email}</a>.</p>

  <a class="back" href="/${slug}">&larr; Back</a>
</body>
</html>`
}

const termsPage = (profile) => {
  const name = esc(profile.agent_name || 'Agent')
  const agency = esc(profile.agency_name || 'Agency')
  const email = esc(profile.email || '')
  const slug = esc(profile.agent_slug)

  return `<!DOCTYPE html>
<html>
<head>
  <title>Terms &amp; Conditions | ${agency}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 680px; margin: 0 auto; padding: 40px 24px; color: #1a1a2e; background: #fafafa; line-height: 1.7; }
    h1 { font-size: 22px; margin-bottom: 4px; }
    .sub { color: #888; margin-bottom: 32px; font-size: 14px; }
    h2 { font-size: 15px; margin: 28px 0 8px; color: #333; }
    p, li { color: #444; font-size: 14px; }
    ul { padding-left: 20px; }
    li { margin-bottom: 6px; }
    .back { display: inline-block; margin-top: 32px; color: #00c9a7; text-decoration: none; font-size: 13px; }
    .back:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Terms &amp; Conditions</h1>
  <p class="sub">${agency}</p>

  <h2>Service Description</h2>
  <p>${agency} provides insurance information, quotes, and enrollment assistance via SMS, phone, and email. Messages are sent by licensed insurance agents or automated systems on their behalf.</p>

  <h2>Consent to SMS</h2>
  <p>By submitting your contact information through an insurance inquiry form, you provide express written consent to receive automated SMS messages from ${agency} at the phone number you provided. Your consent is not a condition of purchasing any insurance product.</p>

  <h2>Opting Out</h2>
  <p>You may opt out of SMS communications at any time by replying <strong>STOP</strong> to any message. Upon opting out, you will receive a confirmation message and no further messages will be sent. Reply <strong>HELP</strong> at any time for assistance.</p>

  <h2>Message Frequency &amp; Rates</h2>
  <p>Message frequency varies based on your inquiry and engagement. Standard message and data rates from your wireless carrier may apply.</p>

  <h2>Limitation of Liability</h2>
  <p>${agency} provides insurance information for educational and enrollment purposes only. All insurance products are underwritten by the respective insurance carrier. ${agency} is not liable for coverage decisions made by insurance carriers.</p>

  <h2>Contact</h2>
  <p>For questions about these terms, contact ${name} at <a href="mailto:${email}" style="color:#00c9a7;">${email}</a>.</p>

  <a class="back" href="/${slug}">&larr; Back</a>
</body>
</html>`
}

const lookupProfile = async (slug) => {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('agent_name, agency_name, email, agent_slug, advisor_page_enabled')
    .eq('agent_slug', slug)
    .single()
  if (error || !data) return null
  return data
}

router.get('/:slug/privacy', async (req, res) => {
  const profile = await lookupProfile(req.params.slug)
  if (!profile) return res.status(404).send(notFoundPage())
  if (!profile.advisor_page_enabled) return res.status(403).send(inactivePage(profile.agent_name))
  res.send(privacyPage(profile))
})

router.get('/:slug/terms', async (req, res) => {
  const profile = await lookupProfile(req.params.slug)
  if (!profile) return res.status(404).send(notFoundPage())
  if (!profile.advisor_page_enabled) return res.status(403).send(inactivePage(profile.agent_name))
  res.send(termsPage(profile))
})

router.get('/:slug', async (req, res) => {
  const profile = await lookupProfile(req.params.slug)
  if (!profile) return res.status(404).send(notFoundPage())
  if (!profile.advisor_page_enabled) return res.status(403).send(inactivePage(profile.agent_name))
  res.send(compliancePage(profile))
})

module.exports = router
