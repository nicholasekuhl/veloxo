const supabase = require('../db')

const STATUS_MAP = { queued: 'sending', sending: 'sending', sent: 'sent', delivered: 'delivered', undelivered: 'failed', failed: 'failed' }

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

    // Today's numbers
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const { data: todayData } = await supabase
      .from('messages')
      .select('status')
      .eq('direction', 'outbound')
      .gte('sent_at', todayStart.toISOString())

    const today = { total: todayData?.length || 0, delivered: 0, failed: 0, pending: 0 }
    for (const m of todayData || []) {
      const s = STATUS_MAP[m.status] || m.status || 'sent'
      if (s === 'delivered') today.delivered++
      else if (s === 'failed') today.failed++
      else today.pending++
    }
    today.rate = today.total > 0 && today.delivered > 0
      ? parseFloat(((today.delivered / today.total) * 100).toFixed(1))
      : null

    res.json({
      period_days: parseInt(days),
      total,
      totals,
      total_failed: totalFailed,
      delivery_rate,
      error_breakdown: Object.values(errorMap).sort((a, b) => b.count - a.count),
      today
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const getDays = (range) => range === 'today' ? 1 : range === '7d' ? 7 : range === '90d' ? 90 : 30

const getOverview = async (req, res) => {
  try {
    const { range = '30d' } = req.query
    const userId = req.user.id
    const days = getDays(range)
    const since = new Date()
    since.setDate(since.getDate() - days)
    const prevSince = new Date(since)
    prevSince.setDate(prevSince.getDate() - days)

    const [{ data: msgs }, { data: prevMsgs }, { data: leads }, { data: campaigns }] = await Promise.all([
      supabase.from('messages').select('status').eq('user_id', userId).eq('direction', 'outbound').gte('sent_at', since.toISOString()),
      supabase.from('messages').select('id').eq('user_id', userId).eq('direction', 'outbound').gte('sent_at', prevSince.toISOString()).lt('sent_at', since.toISOString()),
      supabase.from('leads').select('id, created_at, has_replied').eq('user_id', userId),
      supabase.from('campaigns').select('id, is_active').eq('user_id', userId),
    ])

    const totalSent = msgs?.length || 0
    const delivered = msgs?.filter(m => m.status === 'delivered').length || 0
    const replied = leads?.filter(l => l.has_replied).length || 0

    res.json({
      messages_sent: totalSent,
      messages_sent_prev: prevMsgs?.length || 0,
      delivered,
      delivery_rate: totalSent > 0 ? parseFloat(((delivered / totalSent) * 100).toFixed(1)) : null,
      new_leads: leads?.filter(l => new Date(l.created_at) >= since).length || 0,
      total_leads: leads?.length || 0,
      replied_leads: replied,
      reply_rate: leads?.length > 0 ? parseFloat(((replied / leads.length) * 100).toFixed(1)) : null,
      active_campaigns: campaigns?.filter(c => c.is_active).length || 0,
      total_campaigns: campaigns?.length || 0,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const getMessageStats = async (req, res) => {
  try {
    const { range = '30d' } = req.query
    const userId = req.user.id
    const days = getDays(range)
    const since = new Date()
    since.setDate(since.getDate() - days)

    const { data: msgs, error } = await supabase
      .from('messages')
      .select('status, sent_at, direction')
      .eq('user_id', userId)
      .gte('sent_at', since.toISOString())

    if (error) throw error

    const dailyMap = {}
    const heatmapMap = {}

    for (const msg of msgs || []) {
      const d = new Date(msg.sent_at)
      const date = d.toISOString().split('T')[0]
      if (!dailyMap[date]) dailyMap[date] = { date, sent: 0, delivered: 0, inbound: 0 }
      if (msg.direction === 'outbound') {
        dailyMap[date].sent++
        if (msg.status === 'delivered') dailyMap[date].delivered++
        const key = `${d.getDay()}_${d.getHours()}`
        if (!heatmapMap[key]) heatmapMap[key] = { dow: d.getDay(), hour: d.getHours(), count: 0 }
        heatmapMap[key].count++
      } else {
        dailyMap[date].inbound++
      }
    }

    const daily = []
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const date = d.toISOString().split('T')[0]
      daily.push(dailyMap[date] || { date, sent: 0, delivered: 0, inbound: 0 })
    }

    res.json({ daily, heatmap: Object.values(heatmapMap) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const getCampaignStats = async (req, res) => {
  try {
    const userId = req.user.id
    const { data: campaigns, error } = await supabase
      .from('campaigns')
      .select('id, name, is_active, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (error) throw error
    if (!campaigns || !campaigns.length) return res.json({ campaigns: [] })

    const ids = campaigns.map(c => c.id)
    const [{ data: msgs }, { data: enrollments }] = await Promise.all([
      supabase.from('messages').select('campaign_id, status').eq('user_id', userId).eq('direction', 'outbound').in('campaign_id', ids),
      supabase.from('campaign_leads').select('campaign_id, status').in('campaign_id', ids),
    ])

    const mMap = {}, eMap = {}
    for (const m of msgs || []) {
      if (!m.campaign_id) continue
      if (!mMap[m.campaign_id]) mMap[m.campaign_id] = { sent: 0, delivered: 0 }
      mMap[m.campaign_id].sent++
      if (m.status === 'delivered') mMap[m.campaign_id].delivered++
    }
    for (const e of enrollments || []) {
      if (!eMap[e.campaign_id]) eMap[e.campaign_id] = { total: 0, active: 0 }
      eMap[e.campaign_id].total++
      if (e.status === 'active' || e.status === 'pending') eMap[e.campaign_id].active++
    }

    res.json({
      campaigns: campaigns.map(c => {
        const m = mMap[c.id] || { sent: 0, delivered: 0 }
        const e = eMap[c.id] || { total: 0, active: 0 }
        return {
          id: c.id, name: c.name, is_active: c.is_active,
          leads_enrolled: e.total, leads_active: e.active,
          messages_sent: m.sent, delivered: m.delivered,
          delivery_rate: m.sent > 0 ? parseFloat(((m.delivered / m.sent) * 100).toFixed(1)) : null,
        }
      })
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const getLeadFunnel = async (req, res) => {
  try {
    const userId = req.user.id
    const { data: leads, error } = await supabase
      .from('leads')
      .select('status, is_sold, is_blocked, has_replied, last_contacted_at')
      .eq('user_id', userId)

    if (error) throw error

    const total = leads?.length || 0
    const contacted = leads?.filter(l => l.last_contacted_at).length || 0
    const replied = leads?.filter(l => l.has_replied).length || 0
    const sold = leads?.filter(l => l.is_sold).length || 0
    const blocked = leads?.filter(l => l.is_blocked).length || 0

    res.json({ funnel: { total, contacted, replied, sold, blocked } })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const getActivityStats = async (req, res) => {
  try {
    const { range = '7d' } = req.query
    const userId = req.user.id
    const days = getDays(range)
    const since = new Date()
    since.setDate(since.getDate() - days)

    const { data: msgs, error } = await supabase
      .from('messages')
      .select('id, direction, status, sent_at, lead_id, body')
      .eq('user_id', userId)
      .gte('sent_at', since.toISOString())
      .order('sent_at', { ascending: false })
      .limit(40)

    if (error) throw error

    res.json({
      activity: (msgs || []).map(m => ({
        id: m.id,
        type: m.direction === 'inbound' ? 'reply' : 'sent',
        lead_id: m.lead_id,
        status: m.status,
        preview: m.body ? m.body.substring(0, 80) : null,
        at: m.sent_at,
      }))
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const getSoldStats = async (req, res) => {
  try {
    const userId = req.user.id
    const { data: sold, error } = await supabase
      .from('leads')
      .select('id, first_name, last_name, sold_at, sold_plan_type, sold_premium, sold_notes')
      .eq('user_id', userId)
      .eq('is_sold', true)
      .order('sold_at', { ascending: false })
    if (error) throw error

    const now = new Date()
    const thisMonth = (sold || []).filter(l => {
      if (!l.sold_at) return false
      const d = new Date(l.sold_at)
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
    })
    const totalPremium = thisMonth.reduce((s, l) => s + (parseFloat(l.sold_premium) || 0), 0)

    res.json({
      total_sold: sold?.length || 0,
      sold_this_month: thisMonth.length,
      total_premium: Math.round(totalPremium * 100) / 100,
      avg_premium: thisMonth.length > 0 ? Math.round((totalPremium / thisMonth.length) * 100) / 100 : null,
      recent: (sold || []).slice(0, 10)
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

module.exports = { getDeliveryStats, getOverview, getMessageStats, getCampaignStats, getLeadFunnel, getActivityStats, getSoldStats }
