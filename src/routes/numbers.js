const express = require('express')
const router = express.Router()
const supabase = require('../db')

// GET /api/numbers — list user's active sending numbers
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('user_numbers')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('is_active', true)
      .order('created_at', { ascending: true })
    if (error) throw error
    res.json({ numbers: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/numbers — register a number for this user
router.post('/', async (req, res) => {
  const { phone_number, label } = req.body
  if (!phone_number) return res.status(400).json({ error: 'phone_number required' })
  try {
    const { data, error } = await supabase
      .from('user_numbers')
      .insert({ user_id: req.user.id, phone_number, label: label || null })
      .select()
      .single()
    if (error) throw error
    res.json({ number: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/numbers/:id — deactivate a number
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('user_numbers')
      .update({ is_active: false })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
