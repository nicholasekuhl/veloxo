const supabase = require('../db')

const HEX_RE = /^#[0-9a-f]{6}$/i

const getBuckets = async (req, res) => {
  try {
    const showArchived = req.query.archived === 'true'
    const [{ data, error }, { data: countRows }] = await Promise.all([
      supabase.from('buckets').select('*').eq('user_id', req.user.id)
        .eq('is_archived', showArchived)
        .order('sort_order', { ascending: true }).order('created_at', { ascending: true }),
      supabase.rpc('get_bucket_lead_counts', { p_user_id: req.user.id })
    ])
    if (error) throw error
    const countMap = {}
    for (const r of countRows || []) countMap[r.bucket_id] = parseInt(r.lead_count) || 0
    res.json({ buckets: (data || []).map(b => ({ ...b, lead_count: countMap[b.id] || 0 })) })
  } catch (err) { res.status(500).json({ error: err.message }) }
}

const createBucket = async (req, res) => {
  try {
    const { name, color = '#6366f1', parent_id = null, is_folder = false, sort_order = 0, is_archived = false } = req.body
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' })
    if (!HEX_RE.test(color)) return res.status(400).json({ error: 'Invalid color — must be a 6-digit hex color' })

    let depth = 0
    if (parent_id) {
      const { data: parent } = await supabase
        .from('buckets')
        .select('depth, is_folder')
        .eq('id', parent_id)
        .eq('user_id', req.user.id)
        .single()

      if (!parent) return res.status(400).json({ error: 'Parent not found' })

      depth = (parent.depth || 0) + 1

      if (depth > 2) return res.status(400).json({ error: 'Maximum folder depth reached' })

      if (depth === 2 && is_folder) {
        return res.status(400).json({ error: 'Cannot create a folder at this level. Create a bucket instead.' })
      }
    }

    const insert = { user_id: req.user.id, name: name.trim(), color, is_folder: !!is_folder, sort_order, depth }
    if (parent_id) insert.parent_id = parent_id
    if (is_archived) { insert.is_archived = true; insert.archived_at = new Date().toISOString() }

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

const patchBucket = async (req, res) => {
  try {
    const { data: existing } = await supabase
      .from('buckets').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single()
    if (!existing) return res.status(404).json({ error: 'Bucket not found' })

    // ── Archive ──────────────────────────────────────────────────────────────
    if (req.body.action === 'archive') {
      if (existing.is_system) return res.status(403).json({ error: 'Cannot archive a system bucket' })
      const now = new Date().toISOString()

      await supabase.from('buckets')
        .update({ is_archived: true, archived_at: now })
        .eq('id', req.params.id).eq('user_id', req.user.id)

      // Archive direct children
      await supabase.from('buckets')
        .update({ is_archived: true, archived_at: now })
        .eq('parent_id', req.params.id).eq('user_id', req.user.id)

      // Archive grandchildren
      const { data: children } = await supabase
        .from('buckets').select('id')
        .eq('parent_id', req.params.id).eq('user_id', req.user.id)

      if (children?.length > 0) {
        await supabase.from('buckets')
          .update({ is_archived: true, archived_at: now })
          .in('parent_id', children.map(c => c.id)).eq('user_id', req.user.id)
      }

      return res.json({ success: true })
    }

    // ── Unarchive ─────────────────────────────────────────────────────────────
    if (req.body.action === 'unarchive') {
      await supabase.from('buckets')
        .update({ is_archived: false, archived_at: null })
        .eq('id', req.params.id).eq('user_id', req.user.id)

      // Restore direct children
      await supabase.from('buckets')
        .update({ is_archived: false, archived_at: null })
        .eq('parent_id', req.params.id).eq('user_id', req.user.id)

      // Restore grandchildren
      const { data: children } = await supabase
        .from('buckets').select('id')
        .eq('parent_id', req.params.id).eq('user_id', req.user.id)

      if (children?.length > 0) {
        await supabase.from('buckets')
          .update({ is_archived: false, archived_at: null })
          .in('parent_id', children.map(c => c.id)).eq('user_id', req.user.id)
      }

      return res.json({ success: true })
    }

    // ── Normal field update ────────────────────────────────────────────────────
    if (existing.is_system) return res.status(403).json({ error: 'Cannot modify a system bucket' })
    const { name, color, parent_id, sort_order, depth } = req.body
    const updates = {}
    if (name !== undefined) updates.name = name.trim()
    if (color !== undefined) {
      if (!HEX_RE.test(color)) return res.status(400).json({ error: 'Invalid color' })
      updates.color = color
    }
    if (parent_id !== undefined) {
      updates.parent_id = parent_id || null
      if (parent_id) {
        const { data: parent } = await supabase.from('buckets').select('depth').eq('id', parent_id).single()
        updates.depth = (parent?.depth || 0) + 1
      } else {
        updates.depth = 0
      }
    } else if (depth !== undefined) {
      updates.depth = depth
    }
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

const getArchivedBuckets = async (req, res) => {
  try {
    const userId = req.user.id
    const [{ data: buckets, error }, { data: countRows }, { data: lastOutboundRows }] = await Promise.all([
      supabase.from('buckets').select('*').eq('user_id', userId).eq('is_archived', true)
        .order('archived_at', { ascending: false }),
      supabase.rpc('get_bucket_lead_counts', { p_user_id: userId }),
      supabase.rpc('get_archived_bucket_last_outbound', { p_user_id: userId })
    ])
    if (error) throw error
    const countMap = {}
    for (const r of countRows || []) countMap[r.bucket_id] = parseInt(r.lead_count) || 0
    const lastOutboundMap = {}
    for (const r of lastOutboundRows || []) lastOutboundMap[r.bucket_id] = r.last_outbound_at
    res.json({
      buckets: (buckets || []).map(b => ({
        ...b,
        lead_count: countMap[b.id] || 0,
        last_outbound_at: lastOutboundMap[b.id] || null
      }))
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
}

const reorderBuckets = async (req, res) => {
  try {
    const { order } = req.body
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of bucket IDs' })
    await Promise.all(
      order.map((id, index) =>
        supabase.from('buckets')
          .update({ sort_order: index })
          .eq('id', id)
          .eq('user_id', req.user.id)
      )
    )
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
}

module.exports = { getBuckets, getArchivedBuckets, createBucket, updateBucket, patchBucket, deleteBucket, reorderBuckets }
