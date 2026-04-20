const express = require('express')
const router = express.Router()
const supabase = require('../db')
const { getBalances } = require('../services/credits')

// GET /api/credits/balance
// Returns per-type balances + aggregate lifetime totals.
router.get('/balance', async (req, res) => {
  try {
    const balances = await getBalances(req.user.id)
    res.json(balances)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/credits/transactions
// Returns the last 50 transactions across all credit types.
// Optional ?credit_type=sms|ai|dnc to filter.
router.get('/transactions', async (req, res) => {
  try {
    let q = supabase
      .from('credit_transactions')
      .select('id, amount, credit_type, transaction_type, notes, balance_after, created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50)

    if (req.query.credit_type && ['sms', 'ai', 'dnc'].includes(req.query.credit_type)) {
      q = q.eq('credit_type', req.query.credit_type)
    }

    const { data, error } = await q
    if (error) throw error
    res.json({ transactions: data || [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/credits/thresholds
router.get('/thresholds', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('sms_low_threshold, ai_low_threshold, dnc_low_threshold')
      .eq('id', req.user.id)
      .single()
    if (error) throw error
    res.json({
      sms: parseFloat(data?.sms_low_threshold ?? 100),
      ai:  parseFloat(data?.ai_low_threshold  ?? 50),
      dnc: parseFloat(data?.dnc_low_threshold ?? 50)
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/credits/thresholds
// Body: { sms?: number, ai?: number, dnc?: number }
router.put('/thresholds', async (req, res) => {
  try {
    const update = {}
    if (Number.isFinite(req.body.sms)) update.sms_low_threshold = Math.max(0, req.body.sms)
    if (Number.isFinite(req.body.ai))  update.ai_low_threshold  = Math.max(0, req.body.ai)
    if (Number.isFinite(req.body.dnc)) update.dnc_low_threshold = Math.max(0, req.body.dnc)
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No valid thresholds provided' })
    }
    const { error } = await supabase
      .from('user_profiles')
      .update(update)
      .eq('id', req.user.id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
