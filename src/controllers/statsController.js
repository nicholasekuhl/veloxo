const supabase = require('../db')

const ERROR_DESCRIPTIONS = {
  '30001': 'Queue overflow',
  '30002': 'Account suspended',
  '30003': 'Unreachable destination handset',
  '30004': 'Message blocked',
  '30005': 'Unknown destination handset',
  '30006': 'Landline or unreachable carrier',
  '30007': 'Carrier violation',
  '30008': 'Unknown error',
  '30009': 'Missing segment',
  '30010': 'Message price exceeds max price',
  '21211': 'Invalid phone number',
  '21614': 'Not a mobile number',
}

const getDeliveryStats = async (req, res) => {
  try {
    const { days = 30 } = req.query
    const since = new Date()
    since.setDate(since.getDate() - parseInt(days))

    const { data, error } = await supabase
      .from('messages')
      .select('status, error_code, error_message, sent_at')
      .eq('direction', 'outbound')
      .gte('sent_at', since.toISOString())

    if (error) throw error

    const totals = { sent: 0, delivered: 0, undelivered: 0, failed: 0, queued: 0 }
    const errorMap = {}

    for (const msg of data) {
      const s = msg.status || 'sent'
      if (s in totals) totals[s]++
      else totals.sent++

      if ((s === 'failed' || s === 'undelivered') && msg.error_code) {
        const code = msg.error_code
        if (!errorMap[code]) {
          errorMap[code] = {
            code,
            reason: ERROR_DESCRIPTIONS[code] || msg.error_message || `Error ${code}`,
            count: 0
          }
        }
        errorMap[code].count++
      }
    }

    const total = data.length
    const totalFailed = totals.failed + totals.undelivered
    const delivery_rate = total > 0 && totals.delivered > 0
      ? parseFloat(((totals.delivered / total) * 100).toFixed(1))
      : null

    res.json({
      period_days: parseInt(days),
      total,
      totals,
      total_failed: totalFailed,
      delivery_rate,
      error_breakdown: Object.values(errorMap).sort((a, b) => b.count - a.count)
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

module.exports = { getDeliveryStats }
