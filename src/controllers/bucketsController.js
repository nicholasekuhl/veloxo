const supabase = require('../db')

const HEX_RE = /^#[0-9a-f]{6}$/i

const getBuckets = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('buckets').select('*').eq('user_id', req.user.id)
      .order('sort_order', { ascending: true }).order('created_at', { ascending: true })
    if (error) throw error
    res.json({ buckets: data })
  } catch (err) { res.status(500).json({ error: err.message }) }
}

const createBucket = async (req, res) => {
  try {
    const { name, color = '#6366f1', parent_id = null, is_folder = false, sort_order = 0 } = req.body
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' })
    if (!HEX_RE.test(color)) return res.status(400).json({ error: 'Invalid color — must be a 6-digit hex color' })
    const insert = { user_id: req.user.id, name: name.trim(), color, is_folder: !!is_folder, sort_order }
    if (parent_id) insert.parent_id = parent_id
    const { data, error } = await supabase
      .from('buckets').insert(insert)
      .select().single()
    if (error) throw error
    res.json({ success: true, bucket: data })
  } catch (err) { res.status(500).json({ error: err.message }) }
}

const updateBucket = async (req, res) => {
  try {
    const { data: existing } = await supabase
      .from('buckets').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single()
    if (!existing) return res.status(404).json({ error: 'Bucket not found' })
    if (existing.is_system) return res.status(403).json({ error: 'Cannot rename a system bucket' })

    const { name, color, parent_id, sort_order } = req.body
    const updates = {}
    if (name !== undefined) updates.name = name.trim()
    if (color !== undefined) {
      if (!HEX_RE.test(color)) return res.status(400).json({ error: 'Invalid color' })
      updates.color = color
    }
    if (parent_id !== undefined) updates.parent_id = parent_id || null
    if (sort_order !== undefined) updates.sort_order = sort_order
    const { data, error } = await supabase
      .from('buckets').update(updates).eq('id', req.params.id).eq('user_id', req.user.id)
      .select().single()
    if (error) throw error
    res.json({ success: true, bucket: data })
  } catch (err) { res.status(500).json({ error: err.message }) }
}

const deleteBucket = async (req, res) => {
  try {
    const { data: existing } = await supabase
      .from('buckets').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single()
    if (!existing) return res.status(404).json({ error: 'Bucket not found' })
    if (existing.is_system) return res.status(403).json({ error: 'Cannot delete a system bucket' })

    // Move all leads in this bucket to no bucket
    await supabase.from('leads')
      .update({ bucket_id: null }).eq('bucket_id', req.params.id).eq('user_id', req.user.id)

    const { error } = await supabase
      .from('buckets').delete().eq('id', req.params.id).eq('user_id', req.user.id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
}

module.exports = { getBuckets, createBucket, updateBucket, deleteBucket, patchBucket: updateBucket }
