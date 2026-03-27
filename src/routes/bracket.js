const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const supabase = require('../db')

const ADMIN_PASSWORD = process.env.BRACKET_ADMIN_PASSWORD || 'changeme'
// Simple signed token — no JWT library needed
const TOKEN_SECRET = process.env.SUPABASE_KEY || 'fallback-secret'

function makeToken() {
  const payload = `bracket-admin:${Date.now()}`
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex')
  return Buffer.from(`${payload}:${sig}`).toString('base64')
}

function verifyToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8')
    const lastColon = decoded.lastIndexOf(':')
    const payload = decoded.substring(0, lastColon)
    const sig = decoded.substring(lastColon + 1)
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex')
    return sig === expected
  } catch {
    return false
  }
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-bracket-token']
  if (!token || !verifyToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

// POST /bracket/admin/login
router.post('/admin/login', (req, res) => {
  const { password } = req.body
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' })
  }
  res.json({ token: makeToken() })
})

// GET /bracket/state  — public, returns current bracket JSON
router.get('/state', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bracket_state')
      .select('state')
      .eq('id', 1)
      .single()

    if (error || !data) {
      // No state yet — return empty
      return res.json({ state: null })
    }
    res.json({ state: data.state })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /bracket/save  — admin only, saves bracket JSON
router.post('/save', requireAdmin, async (req, res) => {
  try {
    const { state } = req.body
    if (!state) return res.status(400).json({ error: 'No state provided' })

    const { error } = await supabase
      .from('bracket_state')
      .upsert({ id: 1, state, updated_at: new Date().toISOString() })

    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router