const supabase = require('../db')
const { sendSMS, getNumberForLead } = require('../twilio')
const { spintext } = require('../spintext')

const calculateSendTime = (dayNumber, sendTime, startDate, timezone) => {
  try {
    const [hours, minutes] = sendTime.split(':').map(Number)
    const base = new Date(startDate)
    base.setDate(base.getDate() + (dayNumber - 1))
    const year = base.getFullYear()
    const month = String(base.getMonth() + 1).padStart(2, '0')
    const day = String(base.getDate()).padStart(2, '0')
    const h = String(hours).padStart(2, '0')
    const m = String(minutes).padStart(2, '0')
    const localStr = `${year}-${month}-${day}T${h}:${m}:00`
    const utcDate = new Date(new Date(localStr).toLocaleString('en-US', { timeZone: 'UTC' }))
    const tzDate = new Date(new Date(localStr).toLocaleString('en-US', { timeZone: timezone }))
    const offset = utcDate - tzDate
    return new Date(new Date(localStr).getTime() + offset).toISOString()
  } catch {
    const fallback = new Date(startDate)
    fallback.setDate(fallback.getDate() + (dayNumber - 1))
    fallback.setHours(10, 0, 0, 0)
    return fallback.toISOString()
  }
}

const executeActions = async (lead, actions, dispositionTagId, profile) => {
  if (!actions || actions.length === 0) return

  const sorted = [...actions].sort((a, b) => (a.action_order || 0) - (b.action_order || 0))

  for (const action of sorted) {
    try {
      switch (action.action_type) {

        case 'remove_disposition_tags': {
          const tagIds = action.action_value?.tag_ids || []
          if (tagIds.length > 0) {
            const currentLead = await supabase.from('leads').select('disposition_tag_id').eq('id', lead.id).single()
            if (currentLead.data && tagIds.includes(currentLead.data.disposition_tag_id)) {
              await supabase.from('leads').update({
                disposition_tag_id: null,
                disposition_color: null,
                updated_at: new Date().toISOString()
              }).eq('id', lead.id)
            }
          } else {
            await supabase.from('leads').update({
              disposition_tag_id: null,
              disposition_color: null,
              updated_at: new Date().toISOString()
            }).eq('id', lead.id)
          }
          break
        }

        case 'add_disposition_tag': {
          const tagId = action.action_value?.tag_id
          if (tagId) {
            const { data: tag } = await supabase.from('disposition_tags').select('*').eq('id', tagId).single()
            if (tag) {
              await supabase.from('leads').update({
                disposition_tag_id: tag.id,
                disposition_color: tag.color,
                updated_at: new Date().toISOString()
              }).eq('id', lead.id)
              await supabase.from('lead_dispositions').insert({
                lead_id: lead.id,
                disposition_tag_id: tag.id,
                applied_at: new Date().toISOString(),
                notes: `Auto-applied by action from disposition tag`
              })
            }
          }
          break
        }

        case 'pause_campaigns': {
          await supabase.from('campaign_leads')
            .update({ status: 'paused', paused_at: new Date().toISOString() })
            .eq('lead_id', lead.id)
            .eq('status', 'pending')
          break
        }

        case 'add_to_campaign': {
          const campaignId = action.action_value?.campaign_id
          const startDate = action.action_value?.start_date || new Date().toISOString()
          if (campaignId) {
            const { data: messages } = await supabase
              .from('campaign_messages')
              .select('*')
              .eq('campaign_id', campaignId)
              .order('day_number', { ascending: true })
            if (messages && messages.length > 0) {
              const leadTimezone = lead.timezone || 'America/New_York'
              const firstSendAt = calculateSendTime(
                messages[0].day_number,
                messages[0].send_time || '10:00',
                startDate,
                leadTimezone
              )
              await supabase.from('campaign_leads').insert({
                campaign_id: campaignId,
                lead_id: lead.id,
                status: 'pending',
                current_step: 0,
                start_date: new Date(startDate).toISOString(),
                next_send_at: firstSendAt,
                user_id: lead.user_id || null
              })
            }
          }
          break
        }

        case 'remove_from_campaigns': {
          await supabase.from('campaign_leads')
            .update({ status: 'paused', paused_at: new Date().toISOString() })
            .eq('lead_id', lead.id)
            .in('status', ['pending', 'active'])
          break
        }

        case 'send_immediate_text': {
          const message = action.action_value?.message
          if (message && lead.phone) {
            console.log('Disposition action triggered:', action.action_type)
            console.log('Sending to:', lead.phone)
            const body = spintext(message)
              .replace(/\[First Name\]/gi, lead.first_name || 'there')
              .replace(/\[Last Name\]/gi, lead.last_name || '')
              .replace(/\[Phone\]/gi, lead.phone || '')
              .replace(/\[Email\]/gi, lead.email || '')
              .replace(/\[State\]/gi, lead.state || '')
              .replace(/\[Zip Code\]/gi, lead.zip_code || '')
              .replace(/\[Date of Birth\]/gi, lead.date_of_birth || '')
              .replace(/\{first_name\}/gi, lead.first_name || 'there')
              .replace(/\{last_name\}/gi, lead.last_name || '')
              .replace(/\{phone\}/gi, lead.phone || '')
              .replace(/\{email\}/gi, lead.email || '')
              .replace(/\{state\}/gi, lead.state || '')
              .replace(/\{zip_code\}/gi, lead.zip_code || '')
            const fromNumber = await getNumberForLead(lead.user_id, lead.state)
            const result = await sendSMS(lead.phone, body, fromNumber)
            if (result.success) {
              let { data: conversation } = await supabase
                .from('conversations')
                .select('*')
                .eq('lead_id', lead.id)
                .single()
              if (!conversation) {
                const { data: newConv } = await supabase
                  .from('conversations')
                  .insert({ lead_id: lead.id, status: 'active', user_id: lead.user_id || null })
                  .select()
                  .single()
                conversation = newConv
              }
              if (conversation) {
                await supabase.from('messages').insert({
                  conversation_id: conversation.id,
                  user_id: lead.user_id || null,
                  direction: 'outbound',
                  body,
                  sent_at: new Date().toISOString(),
                  is_ai: false,
                  twilio_sid: result.sid,
                  status: 'sent'
                })
              }
              await supabase.from('leads').update({
                status: 'contacted',
                updated_at: new Date().toISOString()
              }).eq('id', lead.id)
            }
          }
          break
        }

        case 'update_status': {
          const status = action.action_value?.status
          if (status) {
            await supabase.from('leads').update({
              status,
              updated_at: new Date().toISOString()
            }).eq('id', lead.id)
          }
          break
        }

        case 'pipeline_stage': {
          const stage = action.action_value?.stage
          if (stage) {
            await supabase.from('leads').update({
              pipeline_stage: stage,
              updated_at: new Date().toISOString()
            }).eq('id', lead.id)
          }
          break
        }

        case 'mark_as_sold': {
          await supabase.from('leads').update({
            is_sold: true,
            status: 'booked',
            updated_at: new Date().toISOString()
          }).eq('id', lead.id)
          break
        }

        case 'flag_as_cold': {
          await supabase.from('leads').update({
            is_cold: true,
            updated_at: new Date().toISOString()
          }).eq('id', lead.id)
          break
        }

        case 'add_note': {
          const note = action.action_value?.note
          if (note) {
            const firstName = lead.first_name || 'there'
            const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
            const noteText = `[${timestamp}] ${note.replace(/\[First Name\]/g, firstName)}`
            const { data: currentLead } = await supabase.from('leads').select('notes').eq('id', lead.id).single()
            const existing = currentLead?.notes || ''
            const updated = existing ? `${existing}\n${noteText}` : noteText
            await supabase.from('leads').update({
              notes: updated,
              updated_at: new Date().toISOString()
            }).eq('id', lead.id)
          }
          break
        }

        case 'move_to_bucket': {
          const bucketId = action.action_value?.bucket_id
          if (bucketId) {
            await supabase.from('leads').update({
              bucket_id: bucketId,
              updated_at: new Date().toISOString()
            }).eq('id', lead.id)
          }
          break
        }

        case 'opt_out': {
          const now = new Date().toISOString()
          await supabase.from('leads').update({
            opted_out: true, opted_out_at: now, autopilot: false, status: 'opted_out', updated_at: now
          }).eq('id', lead.id)
          await supabase.from('campaign_leads')
            .update({ status: 'paused', paused_at: now })
            .eq('lead_id', lead.id).in('status', ['pending', 'active'])
          break
        }

        default:
          console.log(`Unknown action type: ${action.action_type}`)
      }
    } catch (err) {
      console.error(`Action execution error (${action.action_type}):`, err.message)
    }
  }
}

module.exports = { executeActions }
