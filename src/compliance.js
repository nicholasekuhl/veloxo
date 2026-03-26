const STATE_RULES = {
  // Federal default — all unlisted states
  default: {
    startHour: 8,
    endHour: 21, // 9pm
    allowSunday: true,
    allowHolidays: true,
    maxPer24Hours: null
  },
  FL: { startHour: 8, endHour: 20, allowSunday: true,  allowHolidays: true,  maxPer24Hours: 3    },
  OK: { startHour: 8, endHour: 20, allowSunday: true,  allowHolidays: true,  maxPer24Hours: 3    },
  WA: { startHour: 8, endHour: 20, allowSunday: true,  allowHolidays: true,  maxPer24Hours: null },
  MD: { startHour: 8, endHour: 20, allowSunday: true,  allowHolidays: true,  maxPer24Hours: 3    },
  NJ: { startHour: 8, endHour: 20, allowSunday: true,  allowHolidays: true,  maxPer24Hours: null },
  MS: { startHour: 8, endHour: 21, allowSunday: false, allowHolidays: true,  maxPer24Hours: null },
  AL: { startHour: 8, endHour: 20, allowSunday: false, allowHolidays: false, maxPer24Hours: null },
  LA: { startHour: 8, endHour: 20, allowSunday: false, allowHolidays: false, maxPer24Hours: null },
  SD: { startHour: 9, endHour: 21, allowSunday: false, allowHolidays: true,  maxPer24Hours: null },
  TX: {
    startHour: 9,
    endHour: 21,
    allowSunday: true,
    sundayStartHour: 12, // noon on Sundays
    allowHolidays: true,
    maxPer24Hours: null
  }
}

// Federal holidays for states that restrict them
const FEDERAL_HOLIDAYS_2026 = [
  '2026-01-01', '2026-01-19', '2026-02-16',
  '2026-05-25', '2026-06-19', '2026-07-04',
  '2026-09-07', '2026-10-12', '2026-11-11',
  '2026-11-26', '2026-12-25'
]

function isWithinQuietHours(leadState, leadTimezone) {
  const rules = STATE_RULES[leadState] || STATE_RULES.default
  const now = new Date()

  // Get current time in lead's timezone
  const leadTime = new Date(now.toLocaleString('en-US', {
    timeZone: leadTimezone || 'America/New_York'
  }))

  const hour = leadTime.getHours()
  const dayOfWeek = leadTime.getDay() // 0 = Sunday
  const dateStr = leadTime.toISOString().split('T')[0]

  // Check Sunday restrictions
  if (dayOfWeek === 0 && !rules.allowSunday) {
    return { blocked: true, reason: 'No texts permitted on Sundays in ' + leadState }
  }

  // Check Texas Sunday noon rule
  if (leadState === 'TX' && dayOfWeek === 0) {
    if (hour < 12) {
      return { blocked: true, reason: 'Texas law prohibits texts before noon on Sundays' }
    }
  }

  // Check holiday restrictions
  if (!rules.allowHolidays && FEDERAL_HOLIDAYS_2026.includes(dateStr)) {
    return { blocked: true, reason: 'No texts permitted on holidays in ' + leadState }
  }

  // Check start/end hours
  if (hour < rules.startHour) {
    return {
      blocked: true,
      reason: 'Before permitted hours in ' + (leadState || 'this state') +
        '. Allowed after ' + rules.startHour + 'am local time'
    }
  }

  if (hour >= rules.endHour) {
    return {
      blocked: true,
      reason: 'After permitted hours in ' + (leadState || 'this state') +
        '. Allowed before ' + (rules.endHour === 20 ? '8pm' : '9pm') + ' local time'
    }
  }

  return { blocked: false }
}

function getStateMaxPerDay(state) {
  const rules = STATE_RULES[state] || STATE_RULES.default
  return rules.maxPer24Hours
}

/**
 * Check whether a system-initiated send would exceed the state's daily
 * outbound limit (FL/OK/MD = 3). Conversational AI replies and manual
 * agent replies must never call this — it only applies to messages the
 * system originates without the lead having texted first.
 *
 * @param {string} leadState
 * @param {number} outboundInitiatedToday  value of leads.outbound_initiated_today
 * @returns {{ blocked: boolean, reason?: string }}
 */
function checkSystemInitiatedLimit(leadState, outboundInitiatedToday) {
  const rules = STATE_RULES[leadState] || STATE_RULES.default
  if (!rules.maxPer24Hours) return { blocked: false }
  const count = outboundInitiatedToday || 0
  if (count >= rules.maxPer24Hours) {
    return {
      blocked: true,
      reason: `Daily system-initiated message limit reached for ${leadState} (${count}/${rules.maxPer24Hours})`
    }
  }
  return { blocked: false }
}

/**
 * Returns the next datetime (as ISO string) when sending is permitted
 * for the given state and timezone.
 */
function getNextSendWindow(state, timezone) {
  const rules = STATE_RULES[state] || STATE_RULES.default
  const tz = timezone || 'America/New_York'
  const now = new Date()

  // Work in lead's local time
  const leadTime = new Date(now.toLocaleString('en-US', { timeZone: tz }))
  const hour = leadTime.getHours()
  const dayOfWeek = leadTime.getDay()

  // Helper: build a UTC Date for today at a given local hour in the lead's tz
  const localHourToUTC = (localDate, localHour) => {
    const y = localDate.getFullYear()
    const m = String(localDate.getMonth() + 1).padStart(2, '0')
    const d = String(localDate.getDate()).padStart(2, '0')
    const h = String(localHour).padStart(2, '0')
    const localStr = `${y}-${m}-${d}T${h}:00:00`
    // Convert local string to UTC using offset trick
    const utcBase = new Date(new Date(localStr).toLocaleString('en-US', { timeZone: 'UTC' }))
    const tzBase  = new Date(new Date(localStr).toLocaleString('en-US', { timeZone: tz }))
    const offset  = utcBase - tzBase
    return new Date(new Date(localStr).getTime() + offset)
  }

  // If we are before start hour today (and today is allowed), return today at start hour
  const startHour = (state === 'TX' && dayOfWeek === 0) ? 12 : rules.startHour
  const todayAllowed = !(dayOfWeek === 0 && !rules.allowSunday)

  if (todayAllowed && hour < rules.endHour) {
    if (hour < startHour) {
      return localHourToUTC(leadTime, startHour).toISOString()
    }
    // Currently within window — send immediately (caller guards this)
    return now.toISOString()
  }

  // Otherwise find the next permitted day
  let candidate = new Date(leadTime)
  for (let i = 1; i <= 7; i++) {
    candidate.setDate(candidate.getDate() + 1)
    const dow = candidate.getDay()
    if (dow === 0 && !rules.allowSunday) continue
    const dateStr = candidate.toISOString().split('T')[0]
    if (!rules.allowHolidays && FEDERAL_HOLIDAYS_2026.includes(dateStr)) continue
    const nextStart = (state === 'TX' && dow === 0) ? 12 : rules.startHour
    return localHourToUTC(candidate, nextStart).toISOString()
  }

  // Fallback — next day at 9am UTC
  const fallback = new Date(now)
  fallback.setDate(fallback.getDate() + 1)
  fallback.setUTCHours(14, 0, 0, 0) // 9am ET
  return fallback.toISOString()
}

module.exports = { isWithinQuietHours, getStateMaxPerDay, checkSystemInitiatedLimit, getNextSendWindow, STATE_RULES }
