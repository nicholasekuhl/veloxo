const crypto = require('crypto')
const supabase = require('../db')

const getLeadVendors = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('lead_vendors')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
    if (error) throw error
    res.json({ vendors: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const createLeadVendor = async (req, res) => {
  try {
    const { name, contact_email, color, default_cost, field_mapping,
            on_receipt_autopilot, on_receipt_text_template_id } = req.body
    if (!name) return res.status(400).json({ error: 'Vendor name is required' })

    const apiKey = crypto.randomBytes(24).toString('hex')

    const { data: vendor, error } = await supabase
      .from('lead_vendors')
      .insert({
        name,
        contact_email: contact_email || null,
        color: color || '#f59e0b',
        default_cost: default_cost || null,
        field_mapping: field_mapping || {},
        on_receipt_autopilot: on_receipt_autopilot || false,
        on_receipt_text_template_id: on_receipt_text_template_id || null,
        api_key: apiKey,
        user_id: req.user.id,
        leads_received: 0
      })
      .select()
      .single()
    if (error) throw error
    res.json({ success: true, vendor })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const updateLeadVendor = async (req, res) => {
  try {
    const { name, contact_email, color, default_cost, field_mapping,
            on_receipt_autopilot, on_receipt_text_template_id } = req.body

    const updates = {}
    if (name !== undefined) updates.name = name
    if (contact_email !== undefined) updates.contact_email = contact_email || null
    if (color !== undefined) updates.color = color
    if (default_cost !== undefined) updates.default_cost = default_cost
    if (field_mapping !== undefined) updates.field_mapping = field_mapping
    if (on_receipt_autopilot !== undefined) updates.on_receipt_autopilot = on_receipt_autopilot
    if (on_receipt_text_template_id !== undefined) updates.on_receipt_text_template_id = on_receipt_text_template_id || null
    updates.updated_at = new Date().toISOString()

    const { data: vendor, error } = await supabase
      .from('lead_vendors')
      .update(updates)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single()
    if (error) throw error
    res.json({ success: true, vendor })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const deleteLeadVendor = async (req, res) => {
  try {
    const { error } = await supabase
      .from('lead_vendors')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const regenerateApiKey = async (req, res) => {
  try {
    const apiKey = crypto.randomBytes(24).toString('hex')
    const { data: vendor, error } = await supabase
      .from('lead_vendors')
      .update({ api_key: apiKey, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single()
    if (error) throw error
    res.json({ success: true, api_key: apiKey, vendor })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const sendSetupEmail = async (req, res) => {
  try {
    const { data: vendor, error: vendorErr } = await supabase
      .from('lead_vendors')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single()
    if (vendorErr || !vendor) return res.status(404).json({ error: 'Vendor not found' })
    if (!vendor.contact_email) return res.status(400).json({ error: 'Vendor has no contact email' })

    if (!process.env.RESEND_API_KEY) {
      return res.status(500).json({ error: 'Email service not configured' })
    }

    const { Resend } = require('resend')
    const resend = new Resend(process.env.RESEND_API_KEY)

    const webhookUrl = `https://app.veloxo.io/api/leads/inbound`
    const profile = req.user.profile || {}
    const agentName = profile.agent_name || 'Your agent'
    const agentEmail = req.user.email

    const fieldMappingDocs = vendor.field_mapping && Object.keys(vendor.field_mapping).length > 0
      ? Object.entries(vendor.field_mapping).map(([veloxo, vendor_field]) => `  "${vendor_field}": "..." → ${veloxo}`).join('\n')
      : '  Uses standard field names (first_name, last_name, phone, email, state, zip_code, etc.)'

    const examplePayload = JSON.stringify({
      api_key: vendor.api_key,
      first_name: 'Jane',
      last_name: 'Smith',
      phone: '+15550000001',
      email: 'jane.smith@email.com',
      state: 'FL',
      zip_code: '33401'
    }, null, 2)

    const ccList = agentEmail ? [agentEmail] : []

    await resend.emails.send({
      from: process.env.RESEND_FROM || 'integrations@veloxo.io',
      to: vendor.contact_email,
      cc: ccList,
      subject: `Veloxo Lead Integration Setup — ${vendor.name}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
          <h2 style="color: #7c6ff7;">Lead Integration Setup</h2>
          <p>Hi, ${agentName} has set up a lead integration with Veloxo. Please use the details below to send leads via HTTP POST.</p>

          <h3>Endpoint</h3>
          <pre style="background: #f4f4f5; padding: 12px; border-radius: 8px; font-size: 13px; overflow-x: auto;">POST ${webhookUrl}</pre>

          <h3>API Key</h3>
          <pre style="background: #f4f4f5; padding: 12px; border-radius: 8px; font-size: 13px; word-break: break-all;">${vendor.api_key}</pre>
          <p style="font-size: 13px; color: #666;">Include this as <code>"api_key"</code> in the JSON request body.</p>

          <h3>Field Mapping</h3>
          <pre style="background: #f4f4f5; padding: 12px; border-radius: 8px; font-size: 13px; white-space: pre-wrap;">${fieldMappingDocs}</pre>

          <h3>Example Payload</h3>
          <pre style="background: #f4f4f5; padding: 12px; border-radius: 8px; font-size: 13px; overflow-x: auto;">${examplePayload}</pre>

          <h3>Required Fields</h3>
          <ul style="font-size: 13px;">
            <li><strong>api_key</strong> — your API key (required)</li>
            <li><strong>phone</strong> — lead phone number (required)</li>
            <li>All other fields are optional</li>
          </ul>

          <p style="color: #999; font-size: 12px; margin-top: 32px;">This email was sent from Veloxo on behalf of ${agentName}.</p>
        </div>
      `
    })

    res.json({ success: true, message: 'Setup email sent' })
  } catch (err) {
    console.error('[leadVendors] sendSetupEmail error:', err.message)
    res.status(500).json({ error: err.message })
  }
}

module.exports = {
  getLeadVendors,
  createLeadVendor,
  updateLeadVendor,
  deleteLeadVendor,
  regenerateApiKey,
  sendSetupEmail
}
