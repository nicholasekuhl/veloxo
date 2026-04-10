const supabase = require('../db')
const { getMasterClient } = require('../twilio')

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
    console.error('getDeliveryStats error:', err.message, err.stack)
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

    const [
      { count: totalSent },
      { count: delivered },
      { count: prevSentCount },
      { count: totalLeads },
      { count: newLeads },
      { data: campaigns },
      { count: replied }
    ] = await Promise.all([
      supabase.from('messages').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('direction', 'outbound').gte('sent_at', since.toISOString()),
      supabase.from('messages').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('direction', 'outbound').eq('status', 'delivered').gte('sent_at', since.toISOString()),
      supabase.from('messages').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('direction', 'outbound').gte('sent_at', prevSince.toISOString()).lt('sent_at', since.toISOString()),
      supabase.from('leads').select('*', { count: 'exact', head: true }).eq('user_id', userId),
      supabase.from('leads').select('*', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', since.toISOString()),
      supabase.from('campaigns').select('id, status').eq('user_id', userId),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('user_id', userId).not('last_inbound_at', 'is', null).gte('last_inbound_at', since.toISOString()),
    ])

    const sentCount = totalSent || 0
    const deliveredCount = delivered || 0

    res.json({
      messages_sent: sentCount,
      messages_sent_prev: prevSentCount || 0,
      delivered: deliveredCount,
      delivery_rate: sentCount > 0 ? parseFloat(((deliveredCount / sentCount) * 100).toFixed(1)) : null,
      new_leads: newLeads || 0,
      total_leads: totalLeads || 0,
      replied_leads: replied || 0,
      reply_rate: sentCount > 0 && replied > 0 ? parseFloat(((replied / sentCount) * 100).toFixed(1)) : null,
      active_campaigns: campaigns?.filter(c => c.status === 'active').length || 0,
      total_campaigns: campaigns?.length || 0,
    })
  } catch (err) {
    console.error('getOverview error:', err.message, err.stack)
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
      .limit(10000)

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
    console.error('getMessageStats error:', err.message, err.stack)
    res.status(500).json({ error: err.message })
  }
}

const getCampaignStats = async (req, res) => {
  try {
    const userId = req.user.id
    const { data: campaigns, error } = await supabase
      .from('campaigns')
      .select('id, name, status, created_at')
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
          id: c.id, name: c.name, is_active: c.status === 'active',
          leads_enrolled: e.total, leads_active: e.active,
          messages_sent: m.sent, delivered: m.delivered,
          delivery_rate: m.sent > 0 ? parseFloat(((m.delivered / m.sent) * 100).toFixed(1)) : null,
        }
      })
    })
  } catch (err) {
    console.error('getCampaignStats error:', err.message, err.stack)
    res.status(500).json({ error: err.message })
  }
}

const getLeadFunnel = async (req, res) => {
  try {
    const userId = req.user.id
    const [{ data: leads, error }, { data: repliedConvs }] = await Promise.all([
      supabase.from('leads').select('status, is_sold, is_blocked, first_message_sent').eq('user_id', userId),
      supabase.from('conversations').select('lead_id').eq('user_id', userId).not('last_inbound_at', 'is', null)
    ])

    if (error) throw error

    const total = leads?.length || 0
    const contacted = leads?.filter(l => l.first_message_sent || l.status !== 'new').length || 0
    const replied = new Set((repliedConvs || []).map(c => c.lead_id)).size
    const sold = leads?.filter(l => l.is_sold).length || 0
    const blocked = leads?.filter(l => l.is_blocked).length || 0

    res.json({ funnel: { total, contacted, replied, sold, blocked } })
  } catch (err) {
    console.error('getLeadFunnel error:', err.message, err.stack)
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
      .select('id, direction, status, sent_at, conversation_id, body')
      .eq('user_id', userId)
      .gte('sent_at', since.toISOString())
      .order('sent_at', { ascending: false })
      .limit(40)

    if (error) throw error

    res.json({
      activity: (msgs || []).map(m => ({
        id: m.id,
        type: m.direction === 'inbound' ? 'reply' : 'sent',
        conversation_id: m.conversation_id,
        status: m.status,
        preview: m.body ? m.body.substring(0, 80) : null,
        at: m.sent_at,
      }))
    })
  } catch (err) {
    console.error('getActivityStats error:', err.message, err.stack)
    res.status(500).json({ error: err.message })
  }
}

const getSoldStats = async (req, res) => {
  try {
    const userId = req.user.id
    const { data: sold, error } = await supabase
      .from('leads')
      .select('id, first_name, last_name, sold_at, sold_plan_type, sold_premium, sold_notes, product, commission, commission_status, commission_paid_at')
      .eq('user_id', userId)
      .eq('is_sold', true)
      .order('sold_at', { ascending: false })
    if (error) throw error

    const now = new Date()
    const r2 = (n) => Math.round(n * 100) / 100
    const sumComm = (arr) => arr.reduce((s, l) => s + (parseFloat(l.commission) || 0), 0)

    const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0)
    const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay()); startOfWeek.setHours(0, 0, 0, 0)
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    const startOfYear = new Date(now.getFullYear(), 0, 1)

    const allSold = sold || []
    const inRange = (l, since) => l.sold_at && new Date(l.sold_at) >= since

    const thisMonth = allSold.filter(l => inRange(l, startOfMonth))
    const totalPremium = thisMonth.reduce((s, l) => s + (parseFloat(l.sold_premium) || 0), 0)
    const withComm = allSold.filter(l => l.commission)

    // 30-day commission chart
    const commByDay = {}
    const thirtyAgo = new Date(now); thirtyAgo.setDate(now.getDate() - 29); thirtyAgo.setHours(0, 0, 0, 0)
    for (const l of allSold) {
      if (!l.sold_at || !l.commission) continue
      const d = new Date(l.sold_at)
      if (d < thirtyAgo) continue
      const key = d.toISOString().split('T')[0]
      commByDay[key] = (commByDay[key] || 0) + (parseFloat(l.commission) || 0)
    }
    const commission_chart = []
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now); d.setDate(now.getDate() - i)
      const key = d.toISOString().split('T')[0]
      commission_chart.push({ date: key, amount: r2(commByDay[key] || 0) })
    }

    res.json({
      total_sold: allSold.length,
      sold_this_month: thisMonth.length,
      total_premium: r2(totalPremium),
      avg_premium: thisMonth.length > 0 ? r2(totalPremium / thisMonth.length) : null,
      commission_today: r2(sumComm(allSold.filter(l => inRange(l, startOfToday)))),
      commission_week: r2(sumComm(allSold.filter(l => inRange(l, startOfWeek)))),
      commission_month: r2(sumComm(thisMonth)),
      commission_year: r2(sumComm(allSold.filter(l => inRange(l, startOfYear)))),
      commission_alltime: r2(sumComm(allSold)),
      commission_avg: withComm.length > 0 ? r2(sumComm(withComm) / withComm.length) : null,
      commission_chart,
      recent: allSold.slice(0, 20)
    })
  } catch (err) {
    console.error('getSoldStats error:', err.message, err.stack)
    res.status(500).json({ error: err.message })
  }
}

const getTwilioDelivery = async (req, res) => {
  try {
    const userId = req.user.id

    const { data: phoneNumbers, error: pnError } = await supabase
      .from('phone_numbers')
      .select('phone_number, friendly_name')
      .eq('user_id', userId)
      .eq('is_active', true)

    if (pnError) throw pnError
    if (!phoneNumbers || !phoneNumbers.length) return res.json({ numbers: [] })

    const client = getMasterClient()
    const CARRIER_CODES = new Set([30003, 30004, 30006, 30007])
    const results = []

    for (const { phone_number, friendly_name } of phoneNumbers) {
      try {
        const messages = await client.messages.list({ from: phone_number, limit: 100 })
        const total = messages.length
        const delivered = messages.filter(m => m.status === 'delivered').length
        const failed = messages.filter(m => m.status === 'failed').length
        const undelivered = messages.filter(m => m.status === 'undelivered').length
        const carrier_errors = messages.filter(m => m.errorCode && CARRIER_CODES.has(parseInt(m.errorCode))).length

        results.push({
          phone_number,
          friendly_name: friendly_name || phone_number,
          total,
          delivered,
          failed,
          undelivered,
          delivery_rate: total > 0 ? parseFloat(((delivered / total) * 100).toFixed(1)) : null,
          failure_rate: total > 0 ? parseFloat((((failed + undelivered) / total) * 100).toFixed(1)) : null,
          carrier_error_rate: total > 0 ? parseFloat(((carrier_errors / total) * 100).toFixed(1)) : null,
        })
      } catch (e) {
        console.error(`getTwilioDelivery fetch error for ${phone_number}:`, e.message)
        results.push({ phone_number, friendly_name: friendly_name || phone_number, error: e.message })
      }
    }

    res.json({ numbers: results })
  } catch (err) {
    console.error('getTwilioDelivery error:', err.message, err.stack)
    res.status(500).json({ error: err.message })
  }
}

const getStateStats = async (req, res) => {
  try {
    const { range = '30d' } = req.query
    const userId = req.user.id
    const days = getDays(range)
    const since = new Date()
    since.setDate(since.getDate() - days)

    const { data: leads, error } = await supabase
      .from('leads')
      .select('state, is_sold, created_at')
      .eq('user_id', userId)
      .not('state', 'is', null)
      .neq('state', '')
      .gte('created_at', since.toISOString())

    if (error) throw error

    const map = {}
    for (const lead of leads || []) {
      const s = (lead.state || '').trim().toUpperCase()
      if (!s) continue
      if (!map[s]) map[s] = { state: s, total_leads: 0, total_sold: 0 }
      map[s].total_leads++
      if (lead.is_sold) map[s].total_sold++
    }

    const states = Object.values(map).map(s => ({
      ...s,
      conversion_rate: s.total_leads > 0
        ? Math.round((s.total_sold / s.total_leads) * 1000) / 10
        : 0
    })).sort((a, b) => b.total_leads - a.total_leads)

    res.json({ states })
  } catch (err) {
    console.error('getStateStats error:', err.message)
    res.status(500).json({ error: err.message })
  }
}

module.exports = { getDeliveryStats, getOverview, getMessageStats, getCampaignStats, getLeadFunnel, getActivityStats, getSoldStats, getTwilioDelivery, getStateStats }
