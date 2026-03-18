const supabase = require('../db')

const getLeadTasks = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('lead_id', req.params.leadId)
      .order('due_date', { ascending: true })
    if (error) throw error
    res.json({ tasks: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const createTask = async (req, res) => {
  try {
    const { lead_id, title, due_date, notes } = req.body
    if (!lead_id) return res.status(400).json({ error: 'lead_id is required' })
    if (!title) return res.status(400).json({ error: 'Title is required' })
    if (!due_date) return res.status(400).json({ error: 'Due date is required' })

    const { data: task, error: taskError } = await supabase
      .from('tasks')
      .insert({ lead_id, title, due_date, notes, user_id: req.user.id })
      .select()
      .single()
    if (taskError) throw taskError

    const { data: upcoming } = await supabase
      .from('tasks')
      .select('due_date, title')
      .eq('lead_id', lead_id)
      .eq('completed', false)
      .order('due_date', { ascending: true })
      .limit(1)

    if (upcoming && upcoming.length > 0) {
      await supabase.from('leads').update({
        next_followup_at: upcoming[0].due_date,
        next_followup_note: upcoming[0].title,
        updated_at: new Date().toISOString()
      }).eq('id', lead_id)
    }

    res.json({ success: true, task })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const updateTask = async (req, res) => {
  try {
    const { title, due_date, notes, completed } = req.body
    const updateData = { title, due_date, notes }
    if (completed !== undefined) {
      updateData.completed = completed
      updateData.completed_at = completed ? new Date().toISOString() : null
    }

    const { data: task, error } = await supabase
      .from('tasks')
      .update(updateData)
      .eq('id', req.params.id)
      .select()
      .single()
    if (error) throw error

    const { data: upcoming } = await supabase
      .from('tasks')
      .select('due_date, title')
      .eq('lead_id', task.lead_id)
      .eq('completed', false)
      .order('due_date', { ascending: true })
      .limit(1)

    await supabase.from('leads').update({
      next_followup_at: upcoming?.[0]?.due_date || null,
      next_followup_note: upcoming?.[0]?.title || null,
      updated_at: new Date().toISOString()
    }).eq('id', task.lead_id)

    res.json({ success: true, task })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

const deleteTask = async (req, res) => {
  try {
    const { data: task } = await supabase
      .from('tasks')
      .select('lead_id')
      .eq('id', req.params.id)
      .single()

    const { error } = await supabase
      .from('tasks')
      .delete()
      .eq('id', req.params.id)
    if (error) throw error

    if (task?.lead_id) {
      const { data: upcoming } = await supabase
        .from('tasks')
        .select('due_date, title')
        .eq('lead_id', task.lead_id)
        .eq('completed', false)
        .order('due_date', { ascending: true })
        .limit(1)

      await supabase.from('leads').update({
        next_followup_at: upcoming?.[0]?.due_date || null,
        next_followup_note: upcoming?.[0]?.title || null,
        updated_at: new Date().toISOString()
      }).eq('id', task.lead_id)
    }

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

module.exports = { getLeadTasks, createTask, updateTask, deleteTask }