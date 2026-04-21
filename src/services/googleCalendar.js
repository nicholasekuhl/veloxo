// Google Calendar API wrappers.
// pushAppointment — insert/update/delete a Veloxo appointment on Google.
// pullExternalEvents — fetch the user's own Google events for calendar display.

const { google } = require('googleapis')
const supabase = require('../db')
const { getAuthenticatedClient, getIntegration, logSync } = require('./googleAuth')

// Build a Google event body from a Veloxo appointment row.
const buildEventBody = (appt, profile) => {
  const start = new Date(appt.scheduled_at)
  const end = new Date(start.getTime() + (appt.duration_minutes || 15) * 60 * 1000)
  const tz = profile?.timezone || 'America/New_York'

  const descriptionParts = []
  if (appt.lead_name) descriptionParts.push(`Lead: ${appt.lead_name}`)
  if (appt.lead_phone) descriptionParts.push(`Phone: ${appt.lead_phone}`)
  if (appt.notes) descriptionParts.push(`\nNotes:\n${appt.notes}`)
  descriptionParts.push(`\nCreated via Veloxo`)

  return {
    summary: appt.title || `Call with ${appt.lead_name || 'lead'}`,
    description: descriptionParts.join('\n'),
    start: { dateTime: start.toISOString(), timeZone: tz },
    end: { dateTime: end.toISOString(), timeZone: tz },
    source: { title: 'Veloxo', url: 'https://app.veloxo.io' },
    extendedProperties: {
      private: {
        veloxo_appointment_id: appt.id,
        veloxo_lead_id: appt.lead_id || ''
      }
    }
  }
}

// Push an appointment to Google. Handles create vs update vs delete based on state.
// Fire-and-forget from callers — never throws, always logs.
const pushAppointment = async (userId, appointmentId) => {
  try {
    const integration = await getIntegration(userId)
    if (!integration || !integration.push_enabled) return

    const client = await getAuthenticatedClient(userId)
    if (!client) return

    const calendar = google.calendar({ version: 'v3', auth: client })

    const { data: appt } = await supabase
      .from('appointments')
      .select('*')
      .eq('id', appointmentId)
      .eq('user_id', userId)
      .maybeSingle()

    // Appointment deleted in Veloxo — mirror the delete on Google if we have an event id
    if (!appt) {
      // We don't know the google_event_id anymore (row is gone). The delete
      // path in appointmentsController captures this before deleting and calls
      // deleteEvent directly. This branch only hits for inserts-then-missing races.
      return
    }

    // Never push events that originated from Google — would create a loop
    if (appt.sync_origin === 'google') return

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('timezone')
      .eq('id', userId)
      .maybeSingle()

    const body = buildEventBody(appt, profile)
    const calendarId = integration.calendar_id || 'primary'

    if (appt.status === 'cancelled') {
      if (appt.google_event_id) {
        await calendar.events.delete({
          calendarId,
          eventId: appt.google_event_id,
          sendUpdates: 'none'
        }).catch(() => {}) // 404 is fine — already gone
        await supabase.from('appointments').update({
          google_event_id: null,
          google_etag: null,
          google_synced_at: new Date().toISOString()
        }).eq('id', appt.id)
        await logSync(userId, 'push', 'delete', appt.id, appt.google_event_id, true, null)
      }
      return
    }

    if (appt.google_event_id) {
      // Update existing Google event
      const { data: updated } = await calendar.events.update({
        calendarId,
        eventId: appt.google_event_id,
        requestBody: body,
        sendUpdates: 'none'
      })
      await supabase.from('appointments').update({
        google_etag: updated.etag,
        google_synced_at: new Date().toISOString()
      }).eq('id', appt.id)
      await logSync(userId, 'push', 'update', appt.id, appt.google_event_id, true, null)
    } else {
      // Create new Google event
      const { data: created } = await calendar.events.insert({
        calendarId,
        requestBody: body,
        sendUpdates: 'none'
      })
      await supabase.from('appointments').update({
        google_event_id: created.id,
        google_etag: created.etag,
        google_synced_at: new Date().toISOString()
      }).eq('id', appt.id)
      await logSync(userId, 'push', 'create', appt.id, created.id, true, null)
    }
  } catch (err) {
    console.error(`[googleCalendar] push failed for appt ${appointmentId}:`, err.message)
    await supabase.from('google_integrations').update({
      last_push_error: String(err.message || err).slice(0, 500),
      updated_at: new Date().toISOString()
    }).eq('user_id', userId).catch(() => {})
    await logSync(userId, 'push', 'create', appointmentId, null, false, err.message)
  }
}

// Called when an appointment is about to be hard-deleted.
// Must run BEFORE the DB delete so we still have google_event_id.
const deleteAppointmentEvent = async (userId, appt) => {
  try {
    if (!appt?.google_event_id) return
    const integration = await getIntegration(userId)
    if (!integration || !integration.push_enabled) return

    const client = await getAuthenticatedClient(userId)
    if (!client) return

    const calendar = google.calendar({ version: 'v3', auth: client })
    await calendar.events.delete({
      calendarId: integration.calendar_id || 'primary',
      eventId: appt.google_event_id,
      sendUpdates: 'none'
    }).catch(() => {})
    await logSync(userId, 'push', 'delete', appt.id, appt.google_event_id, true, null)
  } catch (err) {
    console.error(`[googleCalendar] delete failed for appt ${appt?.id}:`, err.message)
    await logSync(userId, 'push', 'delete', appt?.id, appt?.google_event_id, false, err.message)
  }
}

// Pull the user's Google events (for calendar display).
// Uses incremental sync when possible; falls back to full sync when sync token
// is missing or invalid.
const pullExternalEvents = async (userId) => {
  try {
    const integration = await getIntegration(userId)
    if (!integration || !integration.pull_enabled) return { updated: 0 }

    const client = await getAuthenticatedClient(userId)
    if (!client) return { updated: 0 }

    const calendar = google.calendar({ version: 'v3', auth: client })
    const calendarId = integration.calendar_id || 'primary'

    let pageToken = undefined
    let newSyncToken = null
    let updatedCount = 0
    let deletedCount = 0

    // Build list params. If we have a sync token, use incremental. Otherwise
    // pull a 60-day window (past 7 days through next 53 days).
    const baseParams = integration.pull_sync_token
      ? { syncToken: integration.pull_sync_token }
      : {
          timeMin: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
          timeMax: new Date(Date.now() + 53 * 24 * 60 * 60 * 1000).toISOString(),
          singleEvents: true
        }

    try {
      do {
        const { data } = await calendar.events.list({
          calendarId,
          ...baseParams,
          pageToken,
          maxResults: 250,
          showDeleted: true
        })

        for (const event of data.items || []) {
          // Skip events Veloxo created — those already appear as appointments
          const isVeloxoEvent = event.extendedProperties?.private?.veloxo_appointment_id
          if (isVeloxoEvent) continue

          if (event.status === 'cancelled') {
            await supabase.from('google_external_events')
              .delete()
              .eq('user_id', userId)
              .eq('google_event_id', event.id)
            deletedCount++
            continue
          }

          const startsAt = event.start?.dateTime || event.start?.date
          if (!startsAt) continue

          await supabase.from('google_external_events').upsert({
            user_id: userId,
            google_event_id: event.id,
            calendar_id: calendarId,
            title: event.summary || '(no title)',
            starts_at: new Date(startsAt).toISOString(),
            ends_at: event.end?.dateTime || event.end?.date || null,
            is_all_day: !event.start?.dateTime,
            status: event.status,
            last_synced_at: new Date().toISOString()
          }, { onConflict: 'user_id,google_event_id' })
          updatedCount++
        }

        pageToken = data.nextPageToken
        if (data.nextSyncToken) newSyncToken = data.nextSyncToken
      } while (pageToken)

      await supabase.from('google_integrations').update({
        pull_sync_token: newSyncToken,
        last_pull_at: new Date().toISOString(),
        last_pull_error: null,
        updated_at: new Date().toISOString()
      }).eq('user_id', userId)

      await logSync(userId, 'pull', integration.pull_sync_token ? 'incremental_sync' : 'full_sync',
        null, null, true, null)

      return { updated: updatedCount, deleted: deletedCount }
    } catch (err) {
      // If the sync token is stale (410 Gone), clear it and retry as full sync
      if (err.code === 410 || /invalid sync token/i.test(err.message || '')) {
        await supabase.from('google_integrations').update({
          pull_sync_token: null,
          updated_at: new Date().toISOString()
        }).eq('user_id', userId)
        console.log(`[googleCalendar] sync token stale for user ${userId} — will full-sync next tick`)
        return { updated: 0, note: 'sync_token_reset' }
      }
      throw err
    }
  } catch (err) {
    console.error(`[googleCalendar] pull failed for user ${userId}:`, err.message)
    await supabase.from('google_integrations').update({
      last_pull_error: String(err.message || err).slice(0, 500),
      updated_at: new Date().toISOString()
    }).eq('user_id', userId).catch(() => {})
    await logSync(userId, 'pull', 'full_sync', null, null, false, err.message)
    return { updated: 0, error: err.message }
  }
}

module.exports = {
  pushAppointment,
  deleteAppointmentEvent,
  pullExternalEvents
}