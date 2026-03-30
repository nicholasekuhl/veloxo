// ===== STATE =====
const LEADS_PER_PAGE = 50
let currentLeadsPage = 1
let totalLeads = 0
let isLoadingLeads = false
let hasMoreLeads = false
let allLeads = []
let allCampaigns = []
let unreadConvMap = {}
let hotLeadMap = {}
let ghostedMap = {}
let allBuckets = []
let allDispositionTags = []
let allTemplates = []
let selectedLeads = new Set()
let importFile = null
let importHeaders = []
let importPreview = []
let lastSkippedRows = []
let lastRiskData = null
let campaignSortKey = 'created_at'
let campaignSortDir = -1
let selectedDispColor = '#6366f1'
let activeBucket = ''
let activeFolderId = ''
let collapsedFolders = {}
let activeCampaignQuickFilter = ''
let activeFilters = {}
let smsTargetLeadId = null
let dispositionTargetLeadId = null
let soldTargetLeadId = null
let soldTargetLeadName = ''
let detailLeadId = null
let editingBucketId = null
let contextMenuBucketId = null
let contextMenuBucketName = null
let contextMenuBucketColor = null
let deleteTargetLeadId = null
let deleteTargetLeadName = null
let scheduleFollowupLeadId = null

const IMPORT_FIELDS = [
  { key: 'phone', label: 'Phone', required: true },
  { key: 'first_name', label: 'First Name' },
  { key: 'last_name', label: 'Last Name' },
  { key: 'email', label: 'Email' },
  { key: 'state', label: 'State' },
  { key: 'zip_code', label: 'ZIP Code' },
  { key: 'date_of_birth', label: 'Date of Birth' },
  { key: 'address', label: 'Address' },
  { key: 'product', label: 'Product' },
]
const COLORS = ['#6366f1','#8b5cf6','#ec4899','#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#3b82f6','#64748b','#1a1a2e','#059669']
const BUCKET_COLORS = ['#6366f1','#8b5cf6','#ec4899','#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#06b6d4','#3b82f6','#64748b','#1a1a2e']
const msState = { 'disposition': { selected: [] }, 'exclude-disposition': { selected: [] } }

// ===== MULTI-SELECT DROPDOWN =====
const openMsDropdown = (key) => {
  document.getElementById(`sf-${key}-dropdown`).style.display = 'block'
  renderMsOptions(key)
  document.getElementById(`sf-${key}-input`)?.focus()
}

const filterMsOptions = (key) => {
  document.getElementById(`sf-${key}-dropdown`).style.display = 'block'
  renderMsOptions(key)
}

const renderMsOptions = (key) => {
  const query = (document.getElementById(`sf-${key}-input`)?.value || '').toLowerCase()
  const selectedIds = msState[key].selected.map(s => s.id)
  const matches = query ? allDispositionTags.filter(t => t.name.toLowerCase().includes(query)) : allDispositionTags
  const el = document.getElementById(`sf-${key}-options`)
  if (!el) return
  if (!matches.length) { el.innerHTML = '<div style="padding:10px 12px;font-size:13px;color:#9ca3af;">No tags found</div>'; return }
  el.innerHTML = matches.map(t => {
    const sel = selectedIds.includes(t.id)
    return `<div class="ms-option ${sel ? 'ms-selected' : ''}" onclick="toggleMsOption('${key}','${t.id}','${t.name.replace(/'/g, "\\'")}')">
      <span style="width:16px;font-size:11px;flex-shrink:0;">${sel ? '✓' : ''}</span>${t.name}
    </div>`
  }).join('')
}

const toggleMsOption = (key, id, name) => {
  const idx = msState[key].selected.findIndex(s => s.id === id)
  if (idx === -1) msState[key].selected.push({ id, name })
  else msState[key].selected.splice(idx, 1)
  const input = document.getElementById(`sf-${key}-input`)
  if (input) input.value = ''
  renderMsPills(key)
  renderMsOptions(key)
  filterLeads()
}

const removeMsOption = (key, id) => {
  msState[key].selected = msState[key].selected.filter(s => s.id !== id)
  renderMsPills(key)
  renderMsOptions(key)
  filterLeads()
}

const renderMsPills = (key) => {
  const el = document.getElementById(`sf-${key}-pills`)
  if (!el) return
  el.innerHTML = msState[key].selected.map(s =>
    `<span class="ms-pill">${s.name}<button type="button" onclick="event.stopPropagation();removeMsOption('${key}','${s.id}')">×</button></span>`
  ).join('')
  const input = document.getElementById(`sf-${key}-input`)
  if (input) input.placeholder = msState[key].selected.length ? '' : (key === 'disposition' ? 'Filter by tag...' : 'Exclude tags...')
}

// ===== BUCKETS =====
const selectBucket = (bucketId) => {
  activeBucket = bucketId
  activeFolderId = ''
  renderBucketPills()
  filterLeads()
}

const selectFolder = (folderId) => {
  activeFolderId = activeFolderId === folderId ? '' : folderId
  activeBucket = ''
  renderBucketPills()
  filterLeads()
}

const toggleFolderCollapse = (folderId, e) => {
  e.stopPropagation()
  collapsedFolders[folderId] = !collapsedFolders[folderId]
  renderBucketPills()
}

const renderBucketPills = () => {
  const container = document.getElementById('bucket-tabs')
  if (!container) return

  const folders = allBuckets.filter(b => b.is_folder)
  const topLevel = allBuckets.filter(b => !b.is_folder && !b.parent_id)

  let html = `<div class="bucket-tab${activeBucket === '' && activeFolderId === '' ? ' active' : ''}" onclick="selectBucket('')">All Leads <span class="count">${allLeads.length}</span></div>`

  // Render folders with their child buckets
  for (const folder of folders) {
    const childBuckets = allBuckets.filter(b => b.parent_id === folder.id)
    const isCollapsed = collapsedFolders[folder.id]
    const chevron = isCollapsed ? '▶' : '▼'

    html += `<div style="display:inline-flex;align-items:center;gap:2px;flex-wrap:wrap;">
      <div class="bucket-tab" style="background:#f1f5f9;color:#374151;border-color:#e2e8f0;" onclick="toggleFolderCollapse('${folder.id}',event)">
        📂 ${folder.name} <span style="font-size:9px;margin-left:4px;opacity:0.6;">${chevron}</span>
      </div>`

    if (!isCollapsed) {
      for (const b of childBuckets) {
        const count = allLeads.filter(l => l.bucket_id === b.id).length
        const isActive = activeBucket === b.id
        const bucketColor = b.color
        const bg = isActive ? bucketColor : bucketColor + '18'
        const color = isActive ? 'white' : bucketColor
        const border = isActive ? bucketColor : bucketColor + '40'
        const safeName = b.name.replace(/'/g, "\\'").replace(/"/g, '&quot;')
        html += `<div class="bucket-tab" data-bucket-id="${b.id}" style="background:${bg};color:${color};border-color:${border};margin-left:4px;" onclick="selectBucket('${b.id}')" oncontextmenu="showBucketContextMenu(event,'${b.id}','${safeName}','${b.color}')" title="Right-click to rename or delete">${b.name} <span class="count" style="opacity:0.8">${count}</span></div>`
      }
    }
    html += `</div>`
  }

  // Render top-level buckets (no folder)
  for (const b of topLevel) {
    const count = allLeads.filter(l => l.bucket_id === b.id).length
    const isActive = activeBucket === b.id
    const bucketColor = b.is_system ? '#22c55e' : b.color
    const bg = isActive ? bucketColor : bucketColor + '18'
    const color = isActive ? 'white' : bucketColor
    const border = isActive ? bucketColor : bucketColor + '40'
    const safeName = b.name.replace(/'/g, "\\'").replace(/"/g, '&quot;')
    if (b.is_system) {
      html += `<div class="bucket-tab" data-bucket-id="${b.id}" style="background:${bg};color:${color};border-color:${border};" onclick="selectBucket('${b.id}')" title="System bucket — cannot be renamed or deleted">🔒 ${b.name} <span class="count" style="opacity:0.8">${count}</span></div>`
    } else {
      html += `<div class="bucket-tab" data-bucket-id="${b.id}" style="background:${bg};color:${color};border-color:${border};" onclick="selectBucket('${b.id}')" oncontextmenu="showBucketContextMenu(event,'${b.id}','${safeName}','${b.color}')" title="Right-click to rename or delete">📁 ${b.name} <span class="count" style="opacity:0.8">${count}</span></div>`
    }
  }
  container.innerHTML = html

  // Show commission total when Sold bucket is active
  const soldBucket = allBuckets.find(b => b.is_system)
  const banner = document.getElementById('sold-commission-banner')
  if (banner) {
    if (activeBucket && soldBucket && activeBucket === soldBucket.id) {
      const soldLeads = allLeads.filter(l => l.bucket_id === soldBucket.id)
      const total = soldLeads.reduce((sum, l) => sum + (l.commission || 0), 0)
      const pending = soldLeads.filter(l => l.commission_status === 'pending').reduce((sum, l) => sum + (l.commission || 0), 0)
      banner.innerHTML = `<span style="font-weight:700;color:#166534;">Total Commission: ${fmtComm(total)}</span>${pending > 0 ? `<span style="color:#6b7280;font-size:12px;margin-left:10px;">${fmtComm(pending)} pending</span>` : ''}`
      banner.style.display = 'flex'
    } else {
      banner.style.display = 'none'
    }
  }
}

// ===== FILTERING =====
const filterLeads = () => {
  const search = document.getElementById('sf-search')?.value.toLowerCase() || ''
  const status = document.getElementById('sf-status')?.value || ''
  const state = document.getElementById('sf-state')?.value || ''
  const campaign = document.getElementById('sf-campaign')?.value || ''
  const sfBucket = document.getElementById('sf-bucket')?.value || ''
  const timezone = document.getElementById('sf-timezone')?.value || ''
  const autopilot = document.getElementById('sf-autopilot')?.value || ''
  const sold = document.getElementById('sf-sold')?.value || ''
  const dateFrom = document.getElementById('sf-date-from')?.value || ''
  const dateTo = document.getElementById('sf-date-to')?.value || ''

  let filtered = allLeads

  if (activeFolderId) {
    const folderBucketIds = allBuckets.filter(b => b.parent_id === activeFolderId).map(b => b.id)
    filtered = filtered.filter(l => folderBucketIds.includes(l.bucket_id))
  } else if (activeBucket) filtered = filtered.filter(l => l.bucket_id === activeBucket)
  else if (sfBucket) filtered = filtered.filter(l => l.bucket_id === sfBucket)
  if (search) filtered = filtered.filter(l => [l.first_name, l.last_name, l.phone, l.email, l.state, l.zip_code].some(v => v?.toLowerCase().includes(search)))
  if (status) filtered = filtered.filter(l => l.status === status)
  if (state) filtered = filtered.filter(l => l.state === state)
  const selDisp = msState['disposition'].selected
  if (selDisp.length) filtered = filtered.filter(l => {
    const ids = (l.lead_dispositions || []).map(ld => ld.disposition_tag_id)
    if (!ids.length && l.disposition_tag_id) ids.push(l.disposition_tag_id)
    return selDisp.some(s => ids.includes(s.id))
  })
  const selExcl = msState['exclude-disposition'].selected
  if (selExcl.length) filtered = filtered.filter(l => {
    const ids = (l.lead_dispositions || []).map(ld => ld.disposition_tag_id)
    if (!ids.length && l.disposition_tag_id) ids.push(l.disposition_tag_id)
    return !selExcl.some(s => ids.includes(s.id))
  })
  if (campaign) filtered = filtered.filter(l => l.campaign_tags?.includes(campaign))
  if (timezone) filtered = filtered.filter(l => l.timezone === timezone)
  if (autopilot === 'true') filtered = filtered.filter(l => l.autopilot === true)
  if (autopilot === 'false') filtered = filtered.filter(l => !l.autopilot)
  if (sold === 'true') filtered = filtered.filter(l => l.is_sold === true)
  if (sold === 'false') filtered = filtered.filter(l => !l.is_sold)
  if (activeCampaignQuickFilter) filtered = filtered.filter(l => l.campaign_tags?.includes(activeCampaignQuickFilter))
  if (dateFrom) filtered = filtered.filter(l => l.created_at && new Date(l.created_at) >= new Date(dateFrom))
  if (dateTo) filtered = filtered.filter(l => l.created_at && new Date(l.created_at) <= new Date(dateTo + 'T23:59:59'))

  const countEl = document.getElementById('leads-count')
  if (countEl) {
    const loadedNote = hasMoreLeads ? ` (${allLeads.length} of ${totalLeads} loaded)` : ''
    countEl.textContent = `Showing ${filtered.length} leads${loadedNote}`
  }

  renderLeads(filtered)
  updateActiveFilterPills()
}

const applyFilters = () => { filterLeads(); updateFilterBadge() }

const resetFilters = () => {
  const ids = ['sf-search', 'sf-status', 'sf-state', 'sf-campaign', 'sf-bucket', 'sf-timezone', 'sf-autopilot', 'sf-sold', 'sf-date-from', 'sf-date-to']
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = '' })
  msState['disposition'].selected = []
  msState['exclude-disposition'].selected = []
  renderMsPills('disposition')
  renderMsPills('exclude-disposition')
  activeBucket = ''
  activeFolderId = ''
  activeCampaignQuickFilter = ''
  document.getElementById('campaign-quick-input').value = ''
  document.getElementById('campaign-clear-btn').style.display = 'none'
  renderBucketPills()
  filterLeads()
  updateFilterBadge()
}

const updateActiveFilterPills = () => {
  const container = document.getElementById('active-filters')
  if (!container) return
  const pills = []
  const checks = [
    { id: 'sf-search', label: 'Search' },
    { id: 'sf-status', label: 'Status' },
    { id: 'sf-state', label: 'State' },
    { id: 'sf-timezone', label: 'Timezone' },
    { id: 'sf-autopilot', label: 'Autopilot' },
    { id: 'sf-sold', label: 'Sold' },
    { id: 'sf-date-from', label: 'From date' },
    { id: 'sf-date-to', label: 'To date' },
  ]
  checks.forEach(({ id, label }) => {
    const el = document.getElementById(id)
    if (el?.value) {
      pills.push(`<div class="filter-pill">${label}: ${el.value} <button onclick="clearFilter('${id}')">×</button></div>`)
    }
  })
  msState['disposition'].selected.forEach(s => pills.push(`<div class="filter-pill">Tag: ${s.name} <button onclick="removeMsOption('disposition','${s.id}')">×</button></div>`))
  msState['exclude-disposition'].selected.forEach(s => pills.push(`<div class="filter-pill">Excl: ${s.name} <button onclick="removeMsOption('exclude-disposition','${s.id}')">×</button></div>`))
  const campEl = document.getElementById('sf-campaign')
  if (campEl?.value) pills.push(`<div class="filter-pill">Campaign: ${campEl.value} <button onclick="clearFilter('sf-campaign')">×</button></div>`)
  if (activeBucket) { const bkt = allBuckets.find(b => b.id === activeBucket); pills.push(`<div class="filter-pill">Bucket: ${bkt ? bkt.name : activeBucket} <button onclick="clearBucketFilter()">×</button></div>`) }
  container.innerHTML = pills.join('')
}

const clearFilter = (id) => {
  const el = document.getElementById(id)
  if (el) el.value = ''
  filterLeads()
}

const clearBucketFilter = () => {
  activeBucket = ''
  renderBucketPills()
  filterLeads()
}

const exportFilteredLeads = () => {
  const params = new URLSearchParams()
  const search = document.getElementById('sf-search')?.value
  const status = document.getElementById('sf-status')?.value
  const state = document.getElementById('sf-state')?.value
  const campaign = document.getElementById('sf-campaign')?.value
  const bucket = activeBucket || document.getElementById('sf-bucket')?.value
  const timezone = document.getElementById('sf-timezone')?.value
  const autopilot = document.getElementById('sf-autopilot')?.value
  const sold = document.getElementById('sf-sold')?.value
  const dateTo = document.getElementById('sf-date-to')?.value
  if (search) params.set('search', search)
  if (status) params.set('status', status)
  if (state) params.set('state', state)
  const dispIds = msState['disposition'].selected.map(s => s.id)
  if (dispIds.length) params.set('disposition_tag_id', dispIds[0])
  if (campaign) params.set('campaign_tag', campaign)
  if (bucket) params.set('bucket', bucket)
  if (timezone) params.set('timezone', timezone)
  if (autopilot) params.set('autopilot', autopilot)
  if (sold) params.set('is_sold', sold)
  if (dateTo) params.set('date_to', dateTo)
  window.open(`/leads/export?${params.toString()}`, '_blank')
}

const lastContactHtml = (lead) => {
  if (lead.last_contacted_at) {
    const days = Math.floor((Date.now() - new Date(lead.last_contacted_at)) / 86400000)
    const color = days <= 3 ? '#059669' : days <= 7 ? '#d97706' : '#dc2626'
    const text = days === 0 ? 'Today' : days === 1 ? '1d ago' : `${days}d ago`
    return `<span style="font-size:11px;color:${color};font-weight:500;">🕐 ${text}</span>`
  }
  return lead.status !== 'new' ? `<span style="font-size:11px;color:#d1d5db;">Never contacted</span>` : ''
}

// ===== RENDER LEADS =====
const renderLeads = (leads) => {
  const grid = document.getElementById('leads-grid')
  if (!leads.length) {
    if (!allLeads.length) {
      grid.innerHTML = `<div style="text-align:center;padding:72px 20px;">
        <div style="font-size:40px;margin-bottom:14px;">👥</div>
        <div style="font-size:17px;font-weight:700;color:#1a1a2e;margin-bottom:6px;">No leads yet</div>
        <div style="font-size:13px;color:#9ca3af;margin-bottom:20px;">Import a CSV file or create a lead manually to get started.</div>
        <button class="btn btn-primary" style="width:auto;padding:8px 20px;" onclick="openUploadModal()">Import Leads</button>
      </div>`
    } else {
      grid.innerHTML = `<div style="text-align:center;padding:60px 20px;color:#d1d5db;"><div style="font-size:28px;margin-bottom:8px;">🔍</div><div style="font-size:14px;">No leads match your filters</div></div>`
    }
    return
  }
  grid.innerHTML = leads.map(lead => {
    const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Unknown'
    const initials = getInitials(lead.first_name, lead.last_name)
    const localTime = lead.timezone ? getLocalTime(lead.timezone) : ''
    const tags = lead.campaign_tags || []
    const leadDispIds = (lead.lead_dispositions || []).map(ld => ld.disposition_tag_id)
    if (!leadDispIds.length && lead.disposition_tag_id) leadDispIds.push(lead.disposition_tag_id)
    const leadDispTags = leadDispIds.map(id => allDispositionTags.find(t => t.id === id)).filter(Boolean)
    const safeName = name.replace(/'/g, "\\'")
    const hasActiveCampaign = (lead.campaign_leads || []).some(cl => cl.status === 'active' || cl.status === 'pending')
    const borderColor = lead.opted_out ? '#ef4444'
      : lead.is_blocked ? '#9ca3af'
      : lead.is_sold ? '#16a34a'
      : hasActiveCampaign ? '#3b82f6'
      : leadDispTags[0] ? leadDispTags[0].color
      : 'transparent'
    const replyBadge = lead.has_replied != null
      ? (lead.has_replied
          ? `<span style="background:#d1fae5;color:#065f46;border-radius:20px;padding:2px 7px;font-size:10px;font-weight:600;">Replied</span>`
          : `<span style="background:#f3f4f6;color:#9ca3af;border-radius:20px;padding:2px 7px;font-size:10px;font-weight:600;">No reply</span>`)
      : ''
    const apptBadge = lead.next_appointment ? (() => {
      const apptDate = new Date(lead.next_appointment)
      const apptLabel = apptDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        + ' ' + apptDate.toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', hour12: true,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
        })
      return `<span class="appt-badge">&#128197; ${apptLabel}</span>`
    })() : ''
    const hasActiveEnrollment = hasActiveCampaign
    const campProgress = tags.length
      ? hasActiveEnrollment && lead.campaign_day != null
        ? `<span class="tag" style="background:#eff6ff;color:#1d4ed8;font-size:10px;font-weight:600;border:1px solid #bfdbfe;">⚡ ${tags[0]} — Day ${lead.campaign_day}</span>`
        : hasActiveEnrollment
          ? `<span class="tag" style="background:#eff6ff;color:#1d4ed8;font-size:10px;font-weight:600;border:1px solid #bfdbfe;">⚡ ${tags[0]}</span>`
          : `<span class="tag" style="background:#f0fdf4;color:#166534;font-size:10px;font-weight:600;border:1px solid #bbf7d0;">📤 Via: ${tags[0]}</span>`
      : ''
    return `
      <div class="lead-card" style="border-left: 4px solid ${borderColor};">
        <div class="lead-card-top">
          <div style="display:flex;align-items:flex-start;gap:6px;margin-top:3px;">
            <input type="checkbox" class="lead-select-cb" data-id="${lead.id}" onchange="toggleLead(this)" ${selectedLeads.has(lead.id) ? 'checked' : ''} style="accent-color:#6366f1;margin-top:2px;">
          </div>
          <div class="lead-card-left">
            <div class="lead-avatar">${initials}</div>
            <div class="lead-info">
              <div class="lead-name">
                <a href="/lead.html?id=${lead.id}" target="_blank" style="color:inherit;text-decoration:none;cursor:pointer;" onmouseover="this.style.color='#6366f1'" onmouseout="this.style.color='inherit'">${name}</a>
                <button class="copy-btn" onclick="copyToClipboard('${safeName}', this)" title="Copy name">${COPY_SVG}</button>
                ${lead.opted_out ? '<span style="background:#fee2e2;color:#b91c1c;border-radius:20px;padding:2px 8px;font-size:10px;font-weight:700;letter-spacing:.3px;">🚫 OPTED OUT</span>' : ''}
                ${lead.is_sold ? '<span class="sold-badge">✓ SOLD</span>' : ''}
                ${leadDispTags.map(t => `<span class="disposition-pill" style="background:${t.color}">${t.name}</span>`).join('')}
                ${replyBadge}
                ${apptBadge}
              </div>
              ${lead.is_sold ? `<div class="sold-info">${lead.sold_at ? 'Sold ' + new Date(lead.sold_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Sold'}${lead.sold_plan_type ? ' · ' + lead.sold_plan_type : ''}${lead.sold_premium ? ' · $' + parseFloat(lead.sold_premium).toFixed(0) + '/mo' : ''}</div>` : ''}
              <div class="lead-meta">
                <span>📞 ${lead.phone} <button class="copy-btn" onclick="copyToClipboard('${lead.phone}', this)" title="Copy phone">${COPY_SVG}</button></span>
                ${lead.email ? `<span>✉️ ${lead.email} <button class="copy-btn" onclick="copyToClipboard('${lead.email}', this)" title="Copy email">${COPY_SVG}</button></span>` : ''}
                ${lead.state ? `<span>📍 ${lead.state}</span>` : ''}
                ${lead.date_of_birth ? `<span>🎂 ${lead.date_of_birth}</span>` : ''}
                ${localTime ? `<span>🕐 ${localTime} local</span>` : ''}
                ${lastContactHtml(lead)}
              </div>
              <div class="lead-tags">
                <span class="tag tag-${lead.status}">${lead.status}</span>
                ${lead.bucket_id ? (() => { const bk = allBuckets.find(b => b.id === lead.bucket_id); return bk ? `<span class="tag" style="font-size:10px;background:${bk.color}18;color:${bk.color};border:1px solid ${bk.color}30;" title="Bucket: ${bk.name}">📁 ${bk.name}</span>` : '' })() : ''}
                ${lead.product ? `<span class="tag tag-plan" style="cursor:pointer;" onclick="editLeadProduct('${lead.id}', this)" title="Click to edit">${lead.product}</span>` : ''}
                ${campProgress}
              </div>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;">
            <div style="display:flex;align-items:center;gap:6px;">
              ${hotLeadMap[lead.id] ? `<span title="Hot lead — requesting quote" style="font-size:14px;cursor:pointer;" onclick="event.stopPropagation();viewConversation('${lead.id}')">🔥</span>` : ''}
              ${ghostedMap[lead.id] === 'positive_ghosted' ? `<span style="font-size:10px;background:#fef3c7;color:#92400e;border-radius:20px;padding:1px 6px;font-weight:600;cursor:pointer;" onclick="event.stopPropagation();viewConversation('${lead.id}')" title="Went quiet after engaging">Went Quiet</span>` : ghostedMap[lead.id] === 'ghosted_mid' ? `<span style="font-size:10px;background:#f3f4f6;color:#6b7280;border-radius:20px;padding:1px 6px;font-weight:600;cursor:pointer;" onclick="event.stopPropagation();viewConversation('${lead.id}')" title="No response to follow-ups">No Response</span>` : ''}
              ${unreadConvMap[lead.id] ? `<button onclick="event.stopPropagation();viewConversation('${lead.id}')" title="Unread messages" style="background:#ef4444;color:white;border:none;border-radius:9px;padding:2px 6px;font-size:11px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:3px;">💬 ${unreadConvMap[lead.id]}</button>` : ''}
              <button class="lead-3dot-btn" onclick="event.stopPropagation();openLeadActionsMenu('${lead.id}','${safeName}',this)" title="More actions">⋯</button>
            </div>
            <div class="autopilot-wrap">
              <span class="autopilot-label ${lead.autopilot ? 'on' : ''}" id="ap-label-${lead.id}">${lead.autopilot ? 'Autopilot ON' : 'Autopilot'}</span>
              <label class="toggle">
                <input type="checkbox" ${lead.autopilot ? 'checked' : ''} onchange="toggleAutopilot('${lead.id}', this.checked)">
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
        </div>
        <div class="lead-card-bottom">
          <textarea class="notes-input" placeholder="Add notes..." onblur="saveNotes('${lead.id}', this.value)">${lead.notes || ''}</textarea>
        </div>
        <div class="lead-qa-note-editor" id="qa-note-${lead.id}">
          <textarea class="lead-qa-note-input" id="qa-note-input-${lead.id}" placeholder="Type a note… Enter to save, Shift+Enter for newline" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();saveQuickNote('${lead.id}')}">${lead.notes || ''}</textarea>
          <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:6px;">
            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();closeQuickNote('${lead.id}')">Cancel</button>
            <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();saveQuickNote('${lead.id}')">Save Note</button>
          </div>
        </div>
        <div class="lead-qa-bar">
          <button class="lead-qa-btn qa-sms" onclick="event.stopPropagation();openSMSModal('${lead.id}','${safeName}')">
            <span class="qa-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></span><span class="qa-label">Send Text</span>
          </button>
          <div class="qa-sep"></div>
          <button class="lead-qa-btn qa-convo" onclick="event.stopPropagation();viewConversation('${lead.id}')">
            <span class="qa-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span><span class="qa-label">Conversation</span>
          </button>
          <div class="qa-sep"></div>
          <button class="lead-qa-btn qa-disp" onclick="event.stopPropagation();openDispositionModal('${lead.id}','${safeName}')">
            <span class="qa-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg></span><span class="qa-label">Disposition</span>
          </button>
          <div class="qa-sep"></div>
          <button class="lead-qa-btn qa-note" onclick="event.stopPropagation();quickNote('${lead.id}')">
            <span class="qa-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></span><span class="qa-label">Quick Note</span>
          </button>
          <div class="qa-sep"></div>
          <div style="position:relative;display:inline-block;">
            <button class="lead-qa-btn" onclick="event.stopPropagation();toggleBucketDropdown('${lead.id}')">
              <span class="qa-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg></span><span class="qa-label">Bucket</span>
            </button>
            <div id="bucket-dd-${lead.id}" style="display:none;position:absolute;bottom:calc(100% + 4px);left:0;background:white;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,0.1);z-index:200;min-width:160px;max-height:200px;overflow-y:auto;padding:4px 0;">
              <div onclick="event.stopPropagation();moveToBucket('${lead.id}',null)" style="padding:7px 14px;cursor:pointer;font-size:13px;color:#6b7280;" onmouseenter="this.style.background='#f9fafb'" onmouseleave="this.style.background=''">— No bucket</div>
              ${allBuckets.map(bk => `<div onclick="event.stopPropagation();moveToBucket('${lead.id}','${bk.id}')" style="padding:7px 14px;cursor:pointer;font-size:13px;color:#374151;display:flex;align-items:center;gap:8px;" onmouseenter="this.style.background='#f9fafb'" onmouseleave="this.style.background=''"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${bk.color};flex-shrink:0;"></span>${bk.name}</div>`).join('')}
            </div>
          </div>
          <div class="qa-sep"></div>
          ${lead.is_sold
            ? `<button class="lead-qa-btn qa-unsold" onclick="event.stopPropagation();markUnsold('${lead.id}','${safeName}')">
                <span class="qa-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg></span><span class="qa-label">Unsold</span>
              </button>`
            : `<button class="lead-qa-btn qa-sold" onclick="event.stopPropagation();openMarkSoldModal('${lead.id}','${safeName}')">
                <span class="qa-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span><span class="qa-label">Mark Sold</span>
              </button>`}
          <div class="qa-sep"></div>
          <a class="lead-qa-btn qa-profile" href="/lead.html?id=${lead.id}" target="_blank" onclick="event.stopPropagation()">
            <span class="qa-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span><span class="qa-label">Profile</span>
          </a>
        </div>
      </div>
    `
  }).join('')
}

// ===== STATS =====
let _statsCache = null
let _statsCacheAt = 0
const STATS_CACHE_TTL = 60000

const updateStats = (leads) => {
  // Only update from local data if we don't have a server stats cache
  if (!_statsCache) {
    document.getElementById('stat-total').textContent = totalLeads || leads.length
    document.getElementById('stat-new').textContent = leads.filter(l => l.status === 'new').length
    document.getElementById('stat-contacted').textContent = leads.filter(l => l.status === 'contacted').length
    document.getElementById('stat-booked').textContent = leads.filter(l => l.status === 'booked').length
    document.getElementById('stat-autopilot').textContent = leads.filter(l => l.autopilot).length
  }
}

const loadLeadStats = async () => {
  const now = Date.now()
  if (_statsCache && now - _statsCacheAt < STATS_CACHE_TTL) {
    applyLeadStats(_statsCache)
    return
  }
  try {
    const res = await fetch('/leads/stats')
    if (!res.ok) return
    const stats = await res.json()
    _statsCache = stats
    _statsCacheAt = now
    applyLeadStats(stats)
  } catch (err) {
    console.error('Failed to load lead stats', err)
  }
}

const applyLeadStats = (stats) => {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val }
  set('stat-total', stats.total)
  set('stat-new', stats.new)
  set('stat-contacted', stats.contacted)
  set('stat-booked', stats.booked)
  set('stat-autopilot', stats.autopilot)
}

// ===== LOAD LEADS =====
const loadLeads = async () => {
  if (isLoadingLeads) return
  isLoadingLeads = true
  currentLeadsPage = 1
  allLeads = []
  _statsCache = null
  const grid = document.getElementById('leads-grid')
  if (grid) {
    grid.innerHTML = Array(6).fill(0).map(() => `
      <div class="skel-card">
        <div style="display:flex;gap:14px;align-items:flex-start;">
          <div class="skeleton" style="width:42px;height:42px;border-radius:50%;flex-shrink:0;"></div>
          <div style="flex:1;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
              <div class="skeleton" style="height:15px;width:38%;"></div>
              <div class="skeleton" style="width:38px;height:20px;border-radius:10px;"></div>
            </div>
            <div style="display:flex;gap:12px;margin-bottom:8px;">
              <div class="skeleton" style="height:11px;width:28%;"></div>
              <div class="skeleton" style="height:11px;width:22%;"></div>
              <div class="skeleton" style="height:11px;width:18%;"></div>
            </div>
            <div style="display:flex;gap:6px;">
              <div class="skeleton" style="height:20px;width:64px;border-radius:20px;"></div>
              <div class="skeleton" style="height:20px;width:52px;border-radius:20px;"></div>
            </div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:14px;padding-top:14px;border-top:1px solid #f9fafb;">
          <div class="skeleton" style="height:28px;width:60px;border-radius:8px;"></div>
          <div class="skeleton" style="height:28px;width:60px;border-radius:8px;"></div>
          <div class="skeleton" style="height:28px;width:80px;border-radius:8px;"></div>
        </div>
      </div>`).join('')
  }
  try {
    const [leadsRes, bucketsRes] = await Promise.all([
      fetch(`/leads?page=1&limit=${LEADS_PER_PAGE}`),
      fetch('/buckets')
    ])
    const leadsData = await leadsRes.json()
    const bucketsData = await bucketsRes.json()
    if (leadsData.leads) {
      allLeads = leadsData.leads
      totalLeads = leadsData.total || leadsData.leads.length
      hasMoreLeads = allLeads.length < totalLeads
      updateCampaignFilter()
    }
    if (bucketsData.buckets) allBuckets = bucketsData.buckets
    renderBucketPills()
    filterLeads()
    renderLoadMoreButton()
    loadLeadStats()
  } catch (err) {
    console.error(err)
    toast.error('Failed to load leads', 'Please refresh the page and try again')
    if (grid) grid.innerHTML = '<div style="text-align:center;padding:48px 20px;color:#9ca3af;font-size:14px;">Could not load leads.</div>'
  } finally {
    isLoadingLeads = false
  }
}

const loadMoreLeads = async () => {
  if (isLoadingLeads || !hasMoreLeads) return
  isLoadingLeads = true
  const btn = document.getElementById('load-more-btn')
  if (btn) btn.textContent = 'Loading...'
  try {
    currentLeadsPage++
    const res = await fetch(`/leads?page=${currentLeadsPage}&limit=${LEADS_PER_PAGE}`)
    const data = await res.json()
    if (data.leads && data.leads.length) {
      allLeads = allLeads.concat(data.leads)
      totalLeads = data.total || totalLeads
      hasMoreLeads = allLeads.length < totalLeads
      updateStats(allLeads)
      updateCampaignFilter()
      filterLeads()
    } else {
      hasMoreLeads = false
    }
    renderLoadMoreButton()
  } catch (err) {
    console.error(err)
    toast.error('Failed to load more leads', '')
    currentLeadsPage--
  } finally {
    isLoadingLeads = false
  }
}

const renderLoadMoreButton = () => {
  let btn = document.getElementById('load-more-btn')
  if (!btn) {
    const wrapper = document.createElement('div')
    wrapper.id = 'load-more-wrapper'
    wrapper.style.cssText = 'text-align:center;padding:16px 0;'
    wrapper.innerHTML = '<button id="load-more-btn" class="btn btn-secondary" style="width:auto;padding:8px 24px;" onclick="loadMoreLeads()">Load More Leads</button>'
    const grid = document.getElementById('leads-grid')
    if (grid && grid.parentNode) grid.parentNode.insertBefore(wrapper, grid.nextSibling)
    btn = document.getElementById('load-more-btn')
  }
  const wrapper = document.getElementById('load-more-wrapper')
  if (wrapper) wrapper.style.display = hasMoreLeads ? 'block' : 'none'
  if (btn && hasMoreLeads) btn.textContent = `Load More Leads (${totalLeads - allLeads.length} remaining)`
}

const updateCampaignFilter = () => {
  const tags = [...new Set(allLeads.flatMap(l => l.campaign_tags || []))]
  const campEl = document.getElementById('sf-campaign')
  if (campEl) {
    campEl.innerHTML = '<option value="">All campaigns</option>' + tags.map(t => `<option value="${t}">${t}</option>`).join('')
  }
  const states = [...new Set(allLeads.map(l => l.state).filter(Boolean))].sort()
  const stateEl = document.getElementById('sf-state')
  if (stateEl) {
    stateEl.innerHTML = '<option value="">All states</option>' + states.map(s => `<option value="${s}">${s}</option>`).join('')
  }
  const bucketEl = document.getElementById('sf-bucket')
  if (bucketEl) {
    bucketEl.innerHTML = '<option value="">All buckets</option>' + allBuckets.map(b => `<option value="${b.id}">${b.name}</option>`).join('')
  }
  renderMsOptions('disposition')
  renderMsOptions('exclude-disposition')
}

// ===== SELECTION =====
const toggleSelectAll = (cb) => {
  document.querySelectorAll('.lead-select-cb').forEach(c => { c.checked = cb.checked; if (cb.checked) selectedLeads.add(c.dataset.id); else selectedLeads.delete(c.dataset.id) })
  updateBulkActions()
}
const toggleLead = (cb) => { if (cb.checked) selectedLeads.add(cb.dataset.id); else selectedLeads.delete(cb.dataset.id); updateBulkActions() }
const updateBulkActions = () => {
  const bar = document.getElementById('bulk-actions')
  const count = document.getElementById('selected-count')
  const n = selectedLeads.size
  if (n > 0) { bar.classList.add('visible'); count.textContent = `${n} lead${n !== 1 ? 's' : ''} selected` }
  else { bar.classList.remove('visible'); closeBulkDropdowns() }
}

const clearSelection = () => {
  selectedLeads.clear()
  document.querySelectorAll('.lead-select-cb').forEach(c => c.checked = false)
  const sa = document.getElementById('select-all')
  if (sa) sa.checked = false
  updateBulkActions()
}

// ===== BULK DROPDOWNS =====
const closeBulkDropdowns = () => {
  ['bulk-disp-dd', 'bulk-remove-disp-dd', 'bulk-camp-dd', 'bulk-bucket-dd'].forEach(id => {
    const el = document.getElementById(id)
    if (el) el.style.display = 'none'
  })
}

const toggleBulkDropdown = (ddId, type) => {
  const dd = document.getElementById(ddId)
  if (!dd) return
  const isOpen = dd.style.display !== 'none'
  closeBulkDropdowns()
  if (isOpen) return

  const n = selectedLeads.size
  if (type === 'disp') {
    if (!allDispositionTags.length) {
      dd.innerHTML = '<div style="padding:12px;font-size:13px;color:#9ca3af;">No disposition tags yet. Create them in Settings.</div>'
    } else {
      dd.innerHTML = `<div class="bulk-dd-label">Apply to ${n} lead${n !== 1 ? 's' : ''}:</div><div class="bulk-dd-pills">` +
        allDispositionTags.map(t => `<button class="bulk-dd-pill" style="background:${t.color};" onclick="confirmBulkDisposition('${t.id}','${t.name.replace(/'/g, "\\'")}')">${t.name}</button>`).join('') +
        '</div>'
    }
  } else if (type === 'campaign') {
    if (!allCampaigns.length) {
      dd.innerHTML = '<div style="padding:12px;font-size:13px;color:#9ca3af;">No campaigns yet. Create one first.</div>'
    } else {
      dd.innerHTML = `<div class="bulk-dd-label">Enroll ${n} lead${n !== 1 ? 's' : ''} in:</div>` +
        allCampaigns.map(c => `<button class="bulk-dd-item" onclick="confirmBulkCampaign('${c.id}','${c.name.replace(/'/g, "\\'")}')" >⚡ ${c.name}</button>`).join('')
    }
  } else if (type === 'bucket') {
    const bucketPills = allBuckets.map(b => `<button class="bulk-dd-pill" style="background:${b.color};" onclick="confirmBulkBucket('${b.id}','${b.name.replace(/'/g, "\\'")}')" >📁 ${b.name}</button>`).join('')
    dd.innerHTML = `<div class="bulk-dd-label">Move ${n} lead${n !== 1 ? 's' : ''} to:</div><div class="bulk-dd-pills">` +
      `<button class="bulk-dd-pill" style="background:#9ca3af;" onclick="confirmBulkBucket(null,'No bucket')">— No bucket</button>` +
      bucketPills + '</div>'
  } else if (type === 'remove-disp') {
    if (!allDispositionTags.length) {
      dd.innerHTML = '<div style="padding:12px;font-size:13px;color:#9ca3af;">No disposition tags yet.</div>'
    } else {
      dd.innerHTML = `<div class="bulk-dd-label">Remove from ${n} lead${n !== 1 ? 's' : ''}:</div><div class="bulk-dd-pills">` +
        allDispositionTags.map(t => `<button class="bulk-dd-pill" style="background:${t.color};" onclick="confirmBulkRemoveDisposition('${t.id}','${t.name.replace(/'/g, "\\'")}')">${t.name}</button>`).join('') +
        '</div>'
    }
  }

  dd.style.display = 'block'
  setTimeout(() => {
    const close = (e) => {
      if (!dd.contains(e.target)) { dd.style.display = 'none'; document.removeEventListener('click', close) }
    }
    document.addEventListener('click', close)
  }, 0)
}

// ===== BULK ACTION HELPER =====
const executeBulkAction = async (action, payload) => {
  const res = await fetch('/leads/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lead_ids: Array.from(selectedLeads), action, payload })
  })
  return res.json()
}

// ===== BULK CONFIRM ACTIONS =====
const confirmBulkDisposition = async (tagId, tagName) => {
  closeBulkDropdowns()
  const n = selectedLeads.size
  if (!await confirmModal(`Apply "${tagName}" to ${n} lead${n !== 1 ? 's' : ''}?`, `This will set the disposition tag for all ${n} selected lead${n !== 1 ? 's' : ''}.`, 'Apply')) return
  try {
    const data = await executeBulkAction('disposition', { disposition_id: tagId })
    if (!data.success) throw new Error(data.error)
    allLeads.forEach(l => {
      if (selectedLeads.has(l.id)) {
        l.disposition_tag_id = tagId
        const alreadyHas = (l.lead_dispositions || []).some(ld => ld.disposition_tag_id === tagId)
        if (!alreadyHas) l.lead_dispositions = [...(l.lead_dispositions || []), { disposition_tag_id: tagId }]
      }
    })
    clearSelection()
    filterLeads()
    toast.success('Tag applied', `${tagName} applied to ${data.affected} lead${data.affected !== 1 ? 's' : ''}`)
  } catch (err) { toast.error('Error', err.message || 'Bulk action failed') }
}

const confirmBulkCampaign = async (campaignId, campaignName) => {
  closeBulkDropdowns()
  const n = selectedLeads.size
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(10, 0, 0, 0)
  if (!await confirmModal(`Enroll ${n} lead${n !== 1 ? 's' : ''} in "${campaignName}"?`, `Messages will begin tomorrow at 10:00 AM in each lead's local timezone.`, 'Enroll')) return
  try {
    const data = await executeBulkAction('campaign', { campaign_id: campaignId, start_date: tomorrow.toISOString() })
    if (!data.success) throw new Error(data.error)
    clearSelection()
    loadLeads()
    const msg = data.skipped > 0 ? `${data.affected} enrolled · ${data.skipped} already in campaign` : `${data.affected} lead${data.affected !== 1 ? 's' : ''} enrolled`
    toast.success(`Enrolled in ${campaignName}`, msg)
  } catch (err) { toast.error('Error', err.message || 'Bulk action failed') }
}

const confirmBulkBucket = async (bucketId, bucketName) => {
  closeBulkDropdowns()
  const n = selectedLeads.size
  if (!await confirmModal(`Move ${n} lead${n !== 1 ? 's' : ''} to "${bucketName}"?`, '', 'Move')) return
  try {
    const data = await executeBulkAction('bucket', { bucket_id: bucketId })
    if (!data.success) throw new Error(data.error)
    allLeads.forEach(l => { if (selectedLeads.has(l.id)) l.bucket_id = bucketId })
    clearSelection()
    renderBucketPills()
    filterLeads()
    toast.success('Bucket updated', `${data.affected} lead${data.affected !== 1 ? 's' : ''} moved to ${bucketName}`)
  } catch (err) { toast.error('Error', err.message || 'Bulk action failed') }
}

const confirmBulkRemoveDisposition = async (tagId, tagName) => {
  closeBulkDropdowns()
  const n = selectedLeads.size
  if (!await confirmModal(`Remove "${tagName}" from ${n} lead${n !== 1 ? 's' : ''}?`, `This will remove this disposition tag from all selected leads.`, 'Remove')) return
  try {
    const data = await executeBulkAction('remove_disposition', { disposition_id: tagId })
    if (!data.success) throw new Error(data.error)
    allLeads.forEach(l => {
      if (selectedLeads.has(l.id)) {
        l.lead_dispositions = (l.lead_dispositions || []).filter(ld => ld.disposition_tag_id !== tagId)
        if (l.disposition_tag_id === tagId) l.disposition_tag_id = l.lead_dispositions[0]?.disposition_tag_id || null
      }
    })
    clearSelection()
    filterLeads()
    toast.success('Tag removed', `"${tagName}" removed from ${data.affected} lead${data.affected !== 1 ? 's' : ''}`)
  } catch (err) { toast.error('Error', err.message || 'Bulk action failed') }
}

const confirmBulkAutopilot = async (enable) => {
  const n = selectedLeads.size
  const label = enable ? 'Enable Autopilot' : 'Disable Autopilot'
  const desc = enable ? `AI will automatically respond to replies from ${n} selected lead${n !== 1 ? 's' : ''}.` : `AI responses will be paused for ${n} selected lead${n !== 1 ? 's' : ''}.`
  if (!await confirmModal(`${label} for ${n} lead${n !== 1 ? 's' : ''}?`, desc, label)) return
  try {
    const action = enable ? 'autopilot_on' : 'autopilot_off'
    const data = await executeBulkAction(action, {})
    if (!data.success) throw new Error(data.error)
    allLeads.forEach(l => { if (selectedLeads.has(l.id)) l.autopilot = enable })
    clearSelection()
    updateStats(allLeads)
    filterLeads()
    toast.success(label, `${data.affected} lead${data.affected !== 1 ? 's' : ''} updated`)
  } catch (err) { toast.error('Error', err.message || 'Bulk action failed') }
}

const confirmBulkBlock = async () => {
  const n = selectedLeads.size
  if (!await confirmModal(`Block ${n} lead${n !== 1 ? 's' : ''}?`, `This will block all selected leads and pause their campaigns. This cannot be easily undone.`, 'Block All', true)) return
  try {
    const data = await executeBulkAction('block', {})
    if (!data.success) throw new Error(data.error)
    allLeads.forEach(l => { if (selectedLeads.has(l.id)) l.is_blocked = true })
    clearSelection()
    filterLeads()
    toast.info('Leads blocked', `${data.affected} lead${data.affected !== 1 ? 's' : ''} blocked`)
  } catch (err) { toast.error('Error', err.message || 'Bulk action failed') }
}

// ===== BULK SOLD =====
const openBulkSoldModal = () => {
  const n = selectedLeads.size
  document.getElementById('bulk-sold-title').textContent = `Mark ${n} Lead${n !== 1 ? 's' : ''} as Sold 🎉`
  document.getElementById('bulk-sold-note').textContent = `This will mark all ${n} selected lead${n !== 1 ? 's' : ''} as sold, pause their campaigns, and record the sale.`
  document.getElementById('bulk-sold-plan').value = ''
  document.getElementById('bulk-sold-commission').value = ''
  document.getElementById('bulk-sold-modal').classList.add('open')
  setTimeout(() => document.getElementById('bulk-sold-plan')?.focus(), 80)
}

const submitBulkSold = async () => {
  const n = selectedLeads.size
  const plan = document.getElementById('bulk-sold-plan').value.trim()
  const commission = parseFloat(document.getElementById('bulk-sold-commission').value) || null
  if (!await confirmModal(`Mark ${n} lead${n !== 1 ? 's' : ''} as sold?`, plan ? `Product: ${plan}` : 'No product specified.', 'Mark as Sold')) return
  document.getElementById('bulk-sold-modal').classList.remove('open')
  try {
    const data = await executeBulkAction('sold', { sold_plan_type: plan || null, commission })
    if (!data.success) throw new Error(data.error)
    const soldBucket = allBuckets.find(b => b.is_system)
    allLeads.forEach(l => {
      if (selectedLeads.has(l.id)) {
        Object.assign(l, { is_sold: true, status: 'sold', sold_at: new Date().toISOString(), sold_plan_type: plan || null, commission })
        if (soldBucket) { l.previous_bucket_id = l.bucket_id !== soldBucket.id ? l.bucket_id : null; l.bucket_id = soldBucket.id }
      }
    })
    clearSelection()
    fireConfetti()
    renderBucketPills()
    filterLeads()
    toast.success(`${data.affected} lead${data.affected !== 1 ? 's' : ''} marked as sold!`, plan || '')
  } catch (err) { toast.error('Error', err.message || 'Bulk action failed') }
}

// ===== BULK EXPORT =====
const exportSelectedLeads = () => {
  const leads = allLeads.filter(l => selectedLeads.has(l.id))
  if (!leads.length) return
  const headers = ['First Name','Last Name','Phone','Email','State','Zip Code','Date of Birth','Product','Status','Bucket','Timezone','Notes','Autopilot','Is Sold','Created At']
  const rows = leads.map(l => [
    l.first_name || '', l.last_name || '', l.phone || '',
    l.email || '', l.state || '', l.zip_code || '',
    l.date_of_birth || '', l.product || '', l.status || '',
    allBuckets.find(b => b.id === l.bucket_id)?.name || l.bucket || '',
    l.timezone || '', l.notes || '',
    l.autopilot ? 'Yes' : 'No', l.is_sold ? 'Yes' : 'No',
    l.created_at ? new Date(l.created_at).toLocaleDateString() : ''
  ])
  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = `leads-export-${Date.now()}.csv`; a.click()
  URL.revokeObjectURL(url)
  toast.success('Export downloaded', `${leads.length} lead${leads.length !== 1 ? 's' : ''} exported`)
}

// ===== BULK DELETE =====
const openBulkDeleteModal = () => {
  const n = selectedLeads.size
  document.getElementById('bulk-delete-title').textContent = `Delete ${n} Lead${n !== 1 ? 's' : ''}?`
  document.getElementById('bulk-delete-body').textContent = `This will permanently delete ${n} lead${n !== 1 ? 's' : ''} and all their conversation history, tasks, and activity. This cannot be undone.`
  document.getElementById('bulk-delete-input').value = ''
  const btn = document.getElementById('bulk-delete-btn')
  btn.disabled = true; btn.style.opacity = '0.4'; btn.style.cursor = 'not-allowed'; btn.textContent = 'Permanently Delete'
  document.getElementById('bulk-delete-modal').classList.add('open')
  setTimeout(() => document.getElementById('bulk-delete-input')?.focus(), 80)
}

const closeBulkDeleteModal = () => document.getElementById('bulk-delete-modal').classList.remove('open')

const checkBulkDeleteInput = () => {
  const valid = document.getElementById('bulk-delete-input').value === 'DELETE'
  const btn = document.getElementById('bulk-delete-btn')
  btn.disabled = !valid; btn.style.opacity = valid ? '1' : '0.4'; btn.style.cursor = valid ? 'pointer' : 'not-allowed'
}

const confirmBulkDelete = async () => {
  if (document.getElementById('bulk-delete-input').value !== 'DELETE') return
  const n = selectedLeads.size
  const btn = document.getElementById('bulk-delete-btn')
  btn.disabled = true; btn.textContent = 'Deleting...'
  try {
    const data = await executeBulkAction('delete', {})
    if (!data.success) throw new Error(data.error)
    const deletedIds = new Set(Array.from(selectedLeads))
    allLeads = allLeads.filter(l => !deletedIds.has(l.id))
    closeBulkDeleteModal()
    clearSelection()
    updateStats(allLeads)
    renderBucketPills()
    filterLeads()
    toast.success(`${data.affected} lead${data.affected !== 1 ? 's' : ''} deleted`)
  } catch (err) { toast.error('Error', err.message || 'Bulk delete failed') }
  finally { btn.disabled = false; btn.textContent = 'Permanently Delete' }
}

// ===== AUTOPILOT =====
const toggleAutopilot = async (leadId, value) => {
  const label = document.getElementById(`ap-label-${leadId}`)
  if (label) { label.textContent = value ? 'Autopilot ON' : 'Autopilot'; label.className = `autopilot-label ${value ? 'on' : ''}` }
  const lead = allLeads.find(l => l.id === leadId)
  if (lead) lead.autopilot = value
  updateStats(allLeads)
  try {
    await fetch(`/leads/${leadId}/autopilot`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autopilot: value }) })
    toast.info(value ? 'Autopilot on' : 'Autopilot off', value ? 'AI will respond to this lead' : 'AI responses paused for this lead')
  } catch (err) { console.error(err) }
}

const saveNotes = async (leadId, notes) => {
  try { await fetch(`/leads/${leadId}/notes`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes }) }) } catch (err) { console.error(err) }
}

// ===== COMMUNICATION =====
const callLead = (phone) => window.open(`tel:${phone}`)

const viewConversation = (leadId) => {
  window.location.href = '/conversations.html?lead=' + leadId
}

const openSMSModal = (leadId, name) => {
  smsTargetLeadId = leadId
  document.getElementById('sms-to-label').textContent = `To: ${name}`
  document.getElementById('sms-body').value = ''
  document.getElementById('sms-char-count').textContent = '0 / 160'
  document.getElementById('sms-template-picker').style.display = 'none'
  document.getElementById('sms-modal').classList.add('open')
  setTimeout(() => document.getElementById('sms-body')?.focus(), 80)
  document.getElementById('sms-body').oninput = function() {
    const count = this.value.length
    const el = document.getElementById('sms-char-count')
    el.textContent = `${count} / 160`
    el.className = 'char-count' + (count > 160 ? ' danger' : count > 130 ? ' warning' : '')
  }
}

const toggleSMSTemplatePicker = () => {
  const picker = document.getElementById('sms-template-picker')
  if (!picker) return
  if (picker.style.display !== 'none') { picker.style.display = 'none'; return }
  if (!allTemplates.length) {
    picker.innerHTML = `<div style="padding:14px 16px;font-size:13px;color:#9ca3af;">No templates yet. Create one in Settings → Templates.</div>`
  } else {
    picker.innerHTML = allTemplates.map(t => `
      <div onclick="selectSMSTemplate('${t.id}')" style="padding:10px 14px;cursor:pointer;border-bottom:1px solid #f9fafb;transition:background 0.1s;" onmouseover="this.style.background='#f9fafb'" onmouseout="this.style.background=''">
        <div style="font-size:13px;font-weight:600;color:#1a1a2e;margin-bottom:2px;">${t.name}</div>
        <div style="font-size:12px;color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${(t.body || '').substring(0, 70)}</div>
      </div>`).join('')
  }
  picker.style.display = 'block'
  setTimeout(() => {
    const close = (e) => { if (!picker.contains(e.target)) { picker.style.display = 'none'; document.removeEventListener('click', close) } }
    document.addEventListener('click', close)
  }, 0)
}

const selectSMSTemplate = (templateId) => {
  const template = allTemplates.find(t => t.id === templateId)
  if (!template) return
  const lead = allLeads.find(l => l.id === smsTargetLeadId)
  let body = template.body || ''
  if (lead) {
    body = body.replace(/\[First Name\]/gi, lead.first_name || '').replace(/\[Last Name\]/gi, lead.last_name || '')
  }
  document.getElementById('sms-body').value = body
  const count = body.length
  const el = document.getElementById('sms-char-count')
  el.textContent = `${count} / 160`
  el.className = 'char-count' + (count > 160 ? ' danger' : count > 130 ? ' warning' : '')
  document.getElementById('sms-template-picker').style.display = 'none'
  document.getElementById('sms-body').focus()
}

const sendManualSMS = async () => {
  const body = document.getElementById('sms-body').value.trim()
  if (!body) return toast.error('Required', 'Please enter a message')
  try {
    const res = await fetch('/messages/send-manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_id: smsTargetLeadId, body })
    })
    const data = await res.json()
    if (data.success) { document.getElementById('sms-modal').classList.remove('open'); loadLeads(); toast.success('Message sent', 'SMS delivered successfully') }
    else toast.error('Send failed', data.error || 'Could not send message')
  } catch (err) { toast.error('Error', 'Something went wrong') }
}

// ===== DISPOSITION =====
const openDispositionModal = (leadId, name) => {
  dispositionTargetLeadId = leadId
  document.getElementById('disposition-lead-name').textContent = `Disposition tags for: ${name}`
  document.getElementById('disposition-notes').value = ''
  const lead = allLeads.find(l => l.id === leadId)
  const currentIds = new Set(
    (lead?.lead_dispositions || []).map(ld => ld.disposition_tag_id)
      .concat(lead?.disposition_tag_id ? [lead.disposition_tag_id] : [])
  )
  const grid = document.getElementById('disp-picker-grid')
  if (!allDispositionTags.length) {
    grid.innerHTML = `<div style="color:#9ca3af;font-size:13px;">No disposition tags yet. Create some in Settings → Disposition Tags.</div>`
  } else {
    grid.innerHTML = allDispositionTags.map(tag => `
      <label class="disp-check-row" style="border-left:4px solid ${tag.color};">
        <input type="checkbox" value="${tag.id}" ${currentIds.has(tag.id) ? 'checked' : ''}>
        <span class="disp-check-dot" style="background:${tag.color};"></span>
        <span class="disp-check-label">${tag.name}</span>
      </label>
    `).join('')
  }
  document.getElementById('disposition-modal').classList.add('open')
}

const applyDisposition = async () => {
  const notes = document.getElementById('disposition-notes').value
  const checkedIds = [...document.querySelectorAll('#disp-picker-grid input[type=checkbox]:checked')].map(cb => cb.value)
  try {
    const res = await fetch('/dispositions/apply-multi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_id: dispositionTargetLeadId, tag_ids: checkedIds, notes })
    })
    const data = await res.json()
    if (data.success) {
      // Update local state
      const lead = allLeads.find(l => l.id === dispositionTargetLeadId)
      if (lead) {
        lead.lead_dispositions = checkedIds.map(id => ({ disposition_tag_id: id }))
        lead.disposition_tag_id = checkedIds[0] || null
      }
      document.getElementById('disposition-modal').classList.remove('open')
      filterLeads()
      const count = checkedIds.length
      toast.success('Dispositions updated', count ? `${count} tag${count !== 1 ? 's' : ''} applied` : 'All tags removed')
    } else { toast.error('Error', data.error || 'Failed to apply dispositions') }
  } catch (err) { toast.error('Error', 'Something went wrong') }
}

// ===== MARK SOLD =====
const openMarkSoldModal = (leadId, leadName) => {
  soldTargetLeadId = leadId
  soldTargetLeadName = leadName
  document.getElementById('sold-modal-title').textContent = `Mark ${leadName} as Sold 🎉`
  document.getElementById('sold-plan-type').value = ''
  document.getElementById('sold-commission').value = ''
  document.getElementById('sold-premium').value = ''
  document.getElementById('sold-notes').value = ''
  document.getElementById('sold-modal').classList.add('open')
  setTimeout(() => document.getElementById('sold-plan-type').focus(), 100)
}

const submitMarkSold = async () => {
  const planType = document.getElementById('sold-plan-type').value.trim()
  const commission = parseFloat(document.getElementById('sold-commission').value) || null
  const premium = parseFloat(document.getElementById('sold-premium').value) || null
  const notes = document.getElementById('sold-notes').value.trim()
  try {
    const res = await fetch(`/leads/${soldTargetLeadId}/sold`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sold_plan_type: planType || null, sold_premium: premium, sold_notes: notes || null, commission: commission || null })
    })
    const data = await res.json()
    if (!data.success) throw new Error(data.error)
    document.getElementById('sold-modal').classList.remove('open')
    const lead = allLeads.find(l => l.id === soldTargetLeadId)
    if (lead) Object.assign(lead, { is_sold: true, status: 'sold', sold_at: data.lead.sold_at, sold_plan_type: data.lead.sold_plan_type, sold_premium: data.lead.sold_premium, commission: data.lead.commission, commission_status: data.lead.commission_status, bucket_id: data.lead.bucket_id, previous_bucket_id: data.lead.previous_bucket_id })
    toast.success(`${soldTargetLeadName} marked as sold!`, planType ? `${planType}${premium ? ` — $${premium}/mo` : ''}` : 'Sale recorded')
    fireConfetti()
    renderBucketPills()
    filterLeads()
  } catch (err) { toast.error('Error', err.message || 'Could not mark as sold') }
}

const markUnsold = async (leadId, leadName) => {
  const ok = await confirmModal(`Remove sold status from ${leadName}?`, 'This will restore their previous status. You can mark them as sold again anytime.', 'Remove', true)
  if (!ok) return
  try {
    const res = await fetch(`/leads/${leadId}/unsold`, { method: 'PATCH' })
    const data = await res.json()
    if (!data.success) throw new Error(data.error)
    const lead = allLeads.find(l => l.id === leadId)
    if (lead) Object.assign(lead, { is_sold: false, status: data.lead.status, sold_at: null, sold_plan_type: null, sold_premium: null, commission: null, commission_status: null, bucket_id: data.lead.bucket_id, previous_bucket_id: null })
    toast.info('Sold status removed', `${leadName} moved back to ${data.lead.status}`)
    renderBucketPills()
    filterLeads()
  } catch (err) { toast.error('Error', err.message || 'Could not remove sold status') }
}

// ===== PRODUCT EDIT =====
const editLeadProduct = async (leadId, el) => {
  const lead = allLeads.find(l => l.id === leadId)
  const current = lead?.product || ''
  const val = prompt('Product:', current)
  if (val === null) return
  try {
    const res = await fetch(`/leads/${leadId}/product`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ product: val.trim() || null }) })
    const data = await res.json()
    if (data.success) {
      if (lead) lead.product = val.trim() || null
      filterLeads()
    }
  } catch (e) { toast.error('Error', 'Could not update product') }
}

const loadDispositionTags = async () => {
  try {
    const res = await fetch('/dispositions')
    const data = await res.json()
    allDispositionTags = data.tags || []
  } catch (err) { console.error(err) }
}

// ===== QUICK NOTE =====
const quickNote = (leadId) => {
  const editor = document.getElementById(`qa-note-${leadId}`)
  if (!editor) return
  editor.classList.toggle('open')
  if (editor.classList.contains('open')) {
    document.getElementById(`qa-note-input-${leadId}`)?.focus()
  }
}

const closeQuickNote = (leadId) => {
  const editor = document.getElementById(`qa-note-${leadId}`)
  if (editor) editor.classList.remove('open')
}

const saveQuickNote = async (leadId) => {
  const input = document.getElementById(`qa-note-input-${leadId}`)
  if (!input) return
  const notes = input.value
  try {
    await fetch(`/leads/${leadId}/notes`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes })
    })
    const lead = allLeads.find(l => l.id === leadId)
    if (lead) lead.notes = notes
    closeQuickNote(leadId)
    const mainNotes = document.querySelector(`.lead-card .notes-input[onblur*="${leadId}"]`)
    if (mainNotes) mainNotes.value = notes
    toast.success('Note saved', notes.length > 40 ? notes.substring(0, 40) + '…' : (notes || 'Note cleared'))
  } catch (err) { toast.error('Error', 'Could not save note') }
}

// ===== UPLOAD MODAL =====
const autoMatchHeaders = (headers) => {
  const map = {}
  const patterns = {
    phone: /phone|mobile|cell|tel/i,
    first_name: /first.?name|firstname/i,
    last_name: /last.?name|lastname|surname/i,
    email: /email/i,
    state: /^state$|^st$/i,
    zip_code: /zip|postal/i,
    date_of_birth: /dob|birth|born/i,
    address: /address|street/i,
    product: /product|plan/i,
  }
  for (const [key, regex] of Object.entries(patterns)) {
    const match = headers.find(h => regex.test(h.trim()))
    if (match) map[key] = match
  }
  return map
}

const showStep1Status = (msg, type) => {
  const bar = document.getElementById('step1-status-bar')
  bar.textContent = msg; bar.className = `status-bar ${type}`
}
const showImportStatus = (msg, type, html) => {
  const bar = document.getElementById('import-status-bar')
  if (html) bar.innerHTML = msg; else bar.textContent = msg
  bar.className = `status-bar ${type}`
}

const updateMappingPreview = (fieldKey, selectedHeader) => {
  const colIdx = selectedHeader ? importHeaders.indexOf(selectedHeader) : -1
  document.querySelectorAll(`.map-preview-cell[data-field="${fieldKey}"]`).forEach((cell, i) => {
    cell.textContent = colIdx >= 0 ? (importPreview[i]?.[colIdx] || '') : ''
  })
}

const renderMappingUI = () => {
  const autoMap = autoMatchHeaders(importHeaders)
  let html = `<table class="map-table"><thead><tr>`
  html += `<th style="width:130px;">App Field</th><th style="width:190px;">Your Column</th>`
  for (let i = 0; i < Math.min(importPreview.length, 3); i++) {
    html += `<th>Sample ${i + 1}</th>`
  }
  html += `</tr></thead><tbody>`
  for (const field of IMPORT_FIELDS) {
    const sel = autoMap[field.key] || ''
    const colIdx = sel ? importHeaders.indexOf(sel) : -1
    html += `<tr><td style="font-weight:${field.required ? 600 : 500};color:${field.required ? '#1a1a2e' : '#374151'};">${field.label}${field.required ? ' <span style="color:#ef4444;font-weight:700;">*</span>' : ''}</td>`
    html += `<td><select class="map-select" data-field="${field.key}" onchange="updateMappingPreview('${field.key}', this.value)"><option value="">— Skip —</option>`
    for (const h of importHeaders) {
      html += `<option value="${h.replace(/"/g, '&quot;')}"${h === sel ? ' selected' : ''}>${h}</option>`
    }
    html += `</select></td>`
    for (let i = 0; i < Math.min(importPreview.length, 3); i++) {
      html += `<td class="map-preview-cell" data-field="${field.key}" data-sample="${i}">${colIdx >= 0 ? (importPreview[i]?.[colIdx] || '') : ''}</td>`
    }
    html += `</tr>`
  }
  html += `</tbody></table>`
  document.getElementById('mapping-table-container').innerHTML = html
}

const advanceToMapping = async () => {
  if (!importFile) return showStep1Status('Please select a file first', 'error')
  showStep1Status('Parsing file headers...', 'loading')
  document.getElementById('upload-next-btn').disabled = true
  try {
    const fd = new FormData(); fd.append('file', importFile)
    const res = await fetch('/leads/parse-headers', { method: 'POST', body: fd })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to parse file')
    importHeaders = data.headers; importPreview = data.preview
    showStep1Status('', '')
    renderMappingUI()
    document.getElementById('upload-step-1').style.display = 'none'
    document.getElementById('upload-step-2').style.display = ''
    setStepActive(2)
    document.getElementById('upload-modal-title').textContent = 'Map Columns'
  } catch (err) {
    showStep1Status(err.message || 'Failed to read file headers', 'error')
  } finally {
    document.getElementById('upload-next-btn').disabled = false
  }
}

const setStepActive = (n) => {
  ;[1, 2, 3].forEach(i => {
    const el = document.getElementById(`step-ind-${i}`)
    if (!el) return
    if (i === n) { el.style.cssText = `flex:1;text-align:center;padding:8px 12px;font-size:12px;font-weight:600;background:#EEF2FF;color:#4338ca;${i < 3 ? 'border-right:1px solid #e5e7eb;' : ''}` }
    else { el.style.cssText = `flex:1;text-align:center;padding:8px 12px;font-size:12px;font-weight:500;color:#9ca3af;${i < 3 ? 'border-right:1px solid #e5e7eb;' : ''}` }
  })
}

const goBackToStep1 = () => {
  document.getElementById('upload-step-2').style.display = 'none'
  document.getElementById('upload-step-3').style.display = 'none'
  document.getElementById('upload-step-1').style.display = ''
  setStepActive(1)
  document.getElementById('upload-modal-title').textContent = 'Import Lead Sheet'
  showImportStatus('', '')
}

const goBackToStep2 = () => {
  document.getElementById('upload-step-3').style.display = 'none'
  document.getElementById('upload-step-2').style.display = ''
  setStepActive(2)
  document.getElementById('upload-modal-title').textContent = 'Map Columns'
}

const advanceToRiskPreview = async () => {
  const columnMap = {}
  document.querySelectorAll('.map-select').forEach(sel => { if (sel.value) columnMap[sel.dataset.field] = sel.value })
  if (!columnMap.phone) return showImportStatus('Please map the Phone column — it is required', 'error')

  const btn = document.getElementById('upload-risk-btn')
  btn.disabled = true
  btn.textContent = 'Analyzing...'
  showImportStatus('Checking phone risk...', 'loading')

  try {
    const formData = new FormData()
    formData.append('file', importFile)
    formData.append('column_map', JSON.stringify(columnMap))
    const res = await fetch('/leads/risk-check', { method: 'POST', body: formData })
    const data = await res.json()
    if (data.error) return showImportStatus(data.error, 'error')

    lastRiskData = data
    document.getElementById('risk-green').textContent = data.summary.green
    document.getElementById('risk-yellow').textContent = data.summary.yellow
    document.getElementById('risk-red').textContent = data.summary.red
    document.getElementById('risk-total').textContent = data.rows.length
    document.getElementById('import-green-count').textContent = data.summary.green
    document.getElementById('import-all-count').textContent = data.summary.green + data.summary.yellow

    const riskColors = { green: { bg: '#d1fae5', text: '#065f46', label: 'Clean' }, yellow: { bg: '#fef3c7', text: '#92400e', label: 'Caution' }, red: { bg: '#fee2e2', text: '#991b1b', label: 'Blocked/Invalid' } }
    const displayed = data.rows.slice(0, 200)
    const tableHtml = `
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:#f9fafb;border-bottom:1px solid #e5e7eb;">
          <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:#6b7280;">Name</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:#6b7280;">Phone</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:#6b7280;">Risk</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:#6b7280;">Reason</th>
        </tr></thead>
        <tbody>${displayed.map(r => {
          const c = riskColors[r.risk]
          const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || '—'
          return `<tr style="border-bottom:1px solid #f3f3f6;">
            <td style="padding:7px 12px;">${name}</td>
            <td style="padding:7px 12px;font-family:monospace;font-size:12px;">${r.phone || '—'}</td>
            <td style="padding:7px 12px;"><span style="padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:${c.bg};color:${c.text};">${c.label}</span></td>
            <td style="padding:7px 12px;font-size:12px;color:#6b7280;">${r.reason}</td>
          </tr>`
        }).join('')}</tbody>
      </table>
      ${data.rows.length > 200 ? `<div style="padding:8px 12px;font-size:12px;color:#9ca3af;text-align:center;">Showing 200 of ${data.rows.length} rows</div>` : ''}
    `
    document.getElementById('risk-table-container').innerHTML = tableHtml
    document.getElementById('risk-status-bar').className = 'status-bar'
    document.getElementById('risk-status-bar').textContent = ''
    document.getElementById('upload-step-2').style.display = 'none'
    document.getElementById('upload-step-3').style.display = ''
    setStepActive(3)
    document.getElementById('upload-modal-title').textContent = 'Risk Preview'
  } catch (err) {
    showImportStatus('Risk check failed', 'error')
  } finally {
    btn.disabled = false
    btn.textContent = 'Analyze Risk →'
  }
}

const openUploadModal = () => {
  importFile = null; importHeaders = []; importPreview = []
  document.getElementById('modal-file-name').textContent = ''
  const bucketSelect = document.getElementById('import-bucket-id')
  if (bucketSelect) {
    bucketSelect.innerHTML = '<option value="">No bucket</option>' + allBuckets.map(b => `<option value="${b.id}">${b.name}</option>`).join('')
  }
  document.getElementById('import-autopilot').checked = false
  document.getElementById('step1-status-bar').className = 'status-bar'
  document.getElementById('step1-status-bar').textContent = ''
  document.getElementById('import-status-bar').className = 'status-bar'
  document.getElementById('import-status-bar').textContent = ''
  const select = document.getElementById('import-campaign')
  select.innerHTML = '<option value="">No campaign</option>' + allCampaigns.map(c => `<option value="${c.id}">${c.name}</option>`).join('')
  const dispSelect = document.getElementById('import-disposition')
  dispSelect.innerHTML = '<option value="">No disposition tag</option>' + allDispositionTags.map(t => `<option value="${t.id}">${t.name}</option>`).join('')
  document.getElementById('upload-step-1').style.display = ''
  document.getElementById('upload-step-2').style.display = 'none'
  document.getElementById('upload-step-3').style.display = 'none'
  setStepActive(1)
  document.getElementById('upload-modal-title').textContent = 'Import Lead Sheet'
  document.getElementById('upload-modal').classList.add('open')
}
const closeUploadModal = () => document.getElementById('upload-modal').classList.remove('open')

document.getElementById('modal-file-input').addEventListener('change', function(e) {
  if (e.target.files[0]) { importFile = e.target.files[0]; document.getElementById('modal-file-name').textContent = importFile.name }
})
const modalDropZone = document.getElementById('modal-drop-zone')
modalDropZone.addEventListener('dragover', (e) => { e.preventDefault(); modalDropZone.classList.add('dragover') })
modalDropZone.addEventListener('dragleave', () => modalDropZone.classList.remove('dragover'))
modalDropZone.addEventListener('drop', (e) => { e.preventDefault(); modalDropZone.classList.remove('dragover'); if (e.dataTransfer.files[0]) { importFile = e.dataTransfer.files[0]; document.getElementById('modal-file-name').textContent = importFile.name } })

const closeImportResults = () => {
  document.getElementById('import-results-modal').classList.remove('open')
  loadLeads()
}

const downloadSkippedCSV = () => {
  if (!lastSkippedRows.length) return
  const headers = ['first_name', 'last_name', 'phone', 'email', 'state', 'zip_code', 'skip_reason']
  const rows = lastSkippedRows.map(r => headers.map(h => `"${String(r[h] || '').replace(/"/g, '""')}"`).join(','))
  const csv = [headers.join(','), ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'skipped_leads.csv'
  a.click()
  URL.revokeObjectURL(url)
}

const submitImport = async (riskFilter = 'all') => {
  const columnMap = {}
  document.querySelectorAll('.map-select').forEach(sel => { if (sel.value) columnMap[sel.dataset.field] = sel.value })
  if (!columnMap.phone) return showImportStatus('Please map the Phone column — it is required', 'error')
  const bucketId = document.getElementById('import-bucket-id')?.value || ''
  const autopilot = document.getElementById('import-autopilot').checked
  const campaignId = document.getElementById('import-campaign').value
  const formData = new FormData()
  formData.append('file', importFile)
  if (bucketId) formData.append('bucket_id', bucketId)
  formData.append('autopilot', autopilot.toString())
  formData.append('risk_filter', riskFilter)
  if (campaignId) formData.append('campaign_id', campaignId)
  const dispositionTagId = document.getElementById('import-disposition').value
  if (dispositionTagId) formData.append('disposition_tag_id', dispositionTagId)
  formData.append('column_map', JSON.stringify(columnMap))

  const riskStatusEl = document.getElementById('risk-status-bar')
  riskStatusEl.className = 'status-bar loading'
  riskStatusEl.textContent = 'Importing leads...'
  const importAllBtn = document.getElementById('import-all-btn')
  const importGreenBtn = document.getElementById('import-green-btn')
  if (importAllBtn) importAllBtn.disabled = true
  if (importGreenBtn) importGreenBtn.disabled = true

  try {
    const res = await fetch('/leads/upload', { method: 'POST', body: formData })
    const data = await res.json()
    if (data.success) {
      closeUploadModal()
      lastSkippedRows = data.skipped_rows || []
      document.getElementById('res-imported').textContent = data.imported ?? 0
      document.getElementById('res-total').textContent = data.total_rows ?? 0
      document.getElementById('res-duplicates').textContent = data.skipped_duplicates ?? 0
      document.getElementById('res-invalid').textContent = data.skipped_invalid_phone ?? 0
      const dlWrap = document.getElementById('import-results-download-wrap')
      dlWrap.style.display = lastSkippedRows.length > 0 ? 'block' : 'none'
      const msgEl = document.getElementById('import-results-message')
      if (msgEl) {
        if (data.campaign_sends_queued) {
          msgEl.textContent = 'Initial messages are being sent now — check Railway logs for send progress.'
          msgEl.style.display = 'block'
        } else {
          msgEl.style.display = 'none'
        }
      }
      document.getElementById('import-results-modal').classList.add('open')
    } else {
      riskStatusEl.className = 'status-bar error'
      riskStatusEl.textContent = data.error || 'Import failed'
    }
  } catch (err) {
    riskStatusEl.className = 'status-bar error'
    riskStatusEl.textContent = 'Something went wrong'
  } finally {
    if (importAllBtn) importAllBtn.disabled = false
    if (importGreenBtn) importGreenBtn.disabled = false
  }
}

// Page-level drag-and-drop — opens upload modal with the dropped file
document.addEventListener('dragover', (e) => { e.preventDefault() })
document.addEventListener('drop', (e) => {
  e.preventDefault()
  // Only handle drops outside the modal's own drop zone
  if (e.target.closest('#modal-drop-zone')) return
  if (e.dataTransfer.files[0]) {
    importFile = e.dataTransfer.files[0]
    document.getElementById('modal-file-name').textContent = importFile.name
    openUploadModal()
  }
})

// ===== ENROLL MODAL =====
const openEnrollModal = () => {
  if (!allCampaigns.length) return toast.error('No campaigns', 'Create a campaign first')
  const select = document.getElementById('enroll-campaign-select')
  select.innerHTML = allCampaigns.map(c => `<option value="${c.id}">${c.name}</option>`).join('')
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(10, 0, 0, 0)
  const pad = n => String(n).padStart(2, '0')
  document.getElementById('enroll-start-date').value = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth()+1)}-${pad(tomorrow.getDate())}T${pad(tomorrow.getHours())}:${pad(tomorrow.getMinutes())}`
  const leads = allLeads.filter(l => selectedLeads.has(l.id))
  document.getElementById('enroll-leads-list').innerHTML = leads.map(l => `
    <div class="checkbox-row">
      <input type="checkbox" checked id="enroll-${l.id}" data-id="${l.id}">
      <label for="enroll-${l.id}">${[l.first_name, l.last_name].filter(Boolean).join(' ') || l.phone}</label>
      <span class="lead-info">${l.phone} · ${l.timezone || 'ET'}</span>
    </div>
  `).join('')
  document.getElementById('enroll-modal').classList.add('open')
}
const closeEnrollModal = () => document.getElementById('enroll-modal').classList.remove('open')

const enrollSelectedLeads = async () => {
  const campaignId = document.getElementById('enroll-campaign-select').value
  const startDate = document.getElementById('enroll-start-date').value
  const checkedLeads = Array.from(document.querySelectorAll('#enroll-leads-list input:checked')).map(cb => cb.dataset.id)
  if (!campaignId) return toast.error('Required', 'Please select a campaign')
  if (!startDate) return toast.error('Required', 'Please set a start date and time')
  if (!checkedLeads.length) return toast.error('Required', 'No leads selected')
  try {
    const res = await fetch(`/campaigns/${campaignId}/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lead_ids: checkedLeads, start_date: new Date(startDate).toISOString() }) })
    const data = await res.json()
    if (data.success) { closeEnrollModal(); selectedLeads.clear(); updateBulkActions(); loadLeads(); toast.success('Enrolled', `${data.count} lead${data.count !== 1 ? 's' : ''} added to campaign`) }
    else toast.error('Enrollment failed', data.error || 'Could not enroll leads')
  } catch (err) { toast.error('Error', 'Something went wrong') }
}

const openEnrollModalForLead = (leadId) => { selectedLeads.clear(); selectedLeads.add(leadId); openEnrollModal() }

// ===== BUCKET CRUD =====
const openNewBucketModal = (id, name, color) => {
  editingBucketId = id || null
  const titleEl = document.getElementById('new-bucket-modal-title')
  const nameEl = document.getElementById('new-bucket-name')
  const saveBtn = document.getElementById('save-bucket-btn')
  if (titleEl) titleEl.textContent = id ? 'Rename Bucket' : 'New Bucket'
  if (nameEl) nameEl.value = name || ''
  if (saveBtn) saveBtn.textContent = id ? 'Save' : 'Create Bucket'
  const swatchContainer = document.getElementById('bucket-color-swatches')
  const selectedColor = color || '#6366f1'
  if (swatchContainer) {
    swatchContainer.innerHTML = BUCKET_COLORS.map(c =>
      `<div class="color-swatch${c === selectedColor ? ' selected' : ''}" style="background:${c};" data-color="${c}" onclick="selectBucketColor('${c}')"></div>`
    ).join('')
  }
  document.getElementById('new-bucket-modal').classList.add('open')
  setTimeout(() => document.getElementById('new-bucket-name')?.focus(), 50)
}

const closeNewBucketModal = () => {
  document.getElementById('new-bucket-modal').classList.remove('open')
  editingBucketId = null
}

const selectBucketColor = (color) => {
  document.querySelectorAll('#bucket-color-swatches .color-swatch').forEach(s => {
    s.classList.toggle('selected', s.dataset.color === color)
  })
}

const getSelectedBucketColor = () => {
  return document.querySelector('#bucket-color-swatches .color-swatch.selected')?.dataset.color || '#6366f1'
}

const saveBucket = async () => {
  const name = document.getElementById('new-bucket-name')?.value.trim()
  if (!name) { toast.error('Name required', 'Please enter a bucket name'); return }
  const color = getSelectedBucketColor()
  const btn = document.getElementById('save-bucket-btn')
  btn.disabled = true
  try {
    if (editingBucketId) {
      const res = await fetch(`/buckets/${editingBucketId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, color }) })
      const data = await res.json()
      if (!data.success) throw new Error(data.error)
      const idx = allBuckets.findIndex(b => b.id === editingBucketId)
      if (idx !== -1) allBuckets[idx] = data.bucket
      toast.success('Bucket renamed', name)
    } else {
      const res = await fetch('/buckets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, color }) })
      const data = await res.json()
      if (!data.success) throw new Error(data.error)
      allBuckets.push(data.bucket)
      toast.success('Bucket created', name)
    }
    renderBucketPills()
    updateCampaignFilter()
    closeNewBucketModal()
  } catch (err) { toast.error('Error', err.message) }
  finally { btn.disabled = false }
}

const showBucketContextMenu = (e, id, name, color) => {
  e.preventDefault()
  e.stopPropagation()
  const bucket = allBuckets.find(b => b.id === id)
  if (bucket?.is_system) return
  contextMenuBucketId = id
  contextMenuBucketName = name
  contextMenuBucketColor = color
  const menu = document.getElementById('bucket-context-menu')
  menu.style.left = `${e.clientX}px`
  menu.style.top = `${e.clientY}px`
  menu.style.display = 'block'
}

const editBucketFromMenu = () => {
  document.getElementById('bucket-context-menu').style.display = 'none'
  openNewBucketModal(contextMenuBucketId, contextMenuBucketName, contextMenuBucketColor)
}

const deleteBucketFromMenu = async () => {
  document.getElementById('bucket-context-menu').style.display = 'none'
  if (!confirm(`Delete bucket "${contextMenuBucketName}"? Leads will be removed from this bucket.`)) return
  try {
    const res = await fetch(`/buckets/${contextMenuBucketId}`, { method: 'DELETE' })
    const data = await res.json()
    if (!data.success) throw new Error(data.error)
    allBuckets = allBuckets.filter(b => b.id !== contextMenuBucketId)
    allLeads.forEach(l => { if (l.bucket_id === contextMenuBucketId) l.bucket_id = null })
    if (activeBucket === contextMenuBucketId) activeBucket = ''
    renderBucketPills()
    updateCampaignFilter()
    filterLeads()
    toast.success('Bucket deleted')
  } catch (err) { toast.error('Error', err.message) }
}

document.addEventListener('click', (e) => {
  document.getElementById('bucket-context-menu').style.display = 'none'
  document.querySelectorAll('[id^="bucket-dd-"]').forEach(el => el.style.display = 'none')

  // Close disposition/exclude-disposition multi-select dropdowns when clicking outside
  if (!e.target.closest('.ms-widget')) {
    document.querySelectorAll('.ms-dropdown').forEach(el => el.style.display = 'none')
  }

  // Close campaign quick-filter dropdown when clicking outside
  if (!e.target.closest('#campaign-quick-input') && !e.target.closest('#campaign-quick-dropdown')) {
    const dd = document.getElementById('campaign-quick-dropdown')
    if (dd) dd.style.display = 'none'
  }
})

const toggleBucketDropdown = (leadId) => {
  const dd = document.getElementById(`bucket-dd-${leadId}`)
  if (!dd) return
  const isOpen = dd.style.display !== 'none'
  document.querySelectorAll('[id^="bucket-dd-"]').forEach(el => el.style.display = 'none')
  if (!isOpen) dd.style.display = 'block'
}

const moveToBucket = async (leadId, bucketId) => {
  document.querySelectorAll('[id^="bucket-dd-"]').forEach(el => el.style.display = 'none')
  try {
    const res = await fetch(`/leads/${leadId}/bucket`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bucket_id: bucketId }) })
    const data = await res.json()
    if (!data.success) throw new Error(data.error)
    const lead = allLeads.find(l => l.id === leadId)
    if (lead) lead.bucket_id = bucketId
    const bkt = allBuckets.find(b => b.id === bucketId)
    toast.success('Bucket updated', bkt ? bkt.name : 'Removed from bucket')
    renderBucketPills()
    filterLeads()
  } catch (err) { toast.error('Error', err.message) }
}

// ===== CAMPAIGN QUICK FILTERS =====
const showCampaignDropdown = () => {
  const query = (document.getElementById('campaign-quick-input')?.value || '').toLowerCase()
  const dropdown = document.getElementById('campaign-quick-dropdown')
  if (!dropdown) return
  const tags = [...new Set(allLeads.flatMap(l => l.campaign_tags || []))].sort()
  const matches = query ? tags.filter(c => c.toLowerCase().includes(query)) : tags
  if (!matches.length) { dropdown.style.display = 'none'; return }
  dropdown.innerHTML = matches.map(c =>
    `<div onclick="selectCampaignFilter('${c.replace(/'/g,"\\'")}','${c.replace(/'/g,"\\'")}') " style="padding:8px 12px;cursor:pointer;font-size:13px;color:#374151;" onmouseenter="this.style.background='#f3f4f6'" onmouseleave="this.style.background=''">${c}</div>`
  ).join('')
  dropdown.style.display = 'block'
}

const selectCampaignFilter = (label, value) => {
  activeCampaignQuickFilter = value
  document.getElementById('campaign-quick-input').value = label
  document.getElementById('campaign-clear-btn').style.display = 'block'
  document.getElementById('campaign-quick-dropdown').style.display = 'none'
  filterLeads()
}

const clearCampaignQuickFilter = () => {
  activeCampaignQuickFilter = ''
  document.getElementById('campaign-quick-input').value = ''
  document.getElementById('campaign-clear-btn').style.display = 'none'
  filterLeads()
}

// ===== CREATE LEAD =====
const openCreateLeadModal = () => {
  document.getElementById('create-lead-modal').classList.add('open')
  document.getElementById('cl-first').value = ''
  document.getElementById('cl-last').value = ''
  document.getElementById('cl-phone').value = ''
  document.getElementById('cl-email').value = ''
  document.getElementById('cl-dob').value = ''
  document.getElementById('cl-state').value = ''
  document.getElementById('cl-zip').value = ''
  document.getElementById('cl-product').value = ''
  document.getElementById('cl-address').value = ''
  document.getElementById('cl-notes').value = ''
  document.getElementById('cl-autopilot').checked = false
  document.getElementById('cl-error').style.display = 'none'

  // Populate campaign dropdown with active campaigns
  const campSel = document.getElementById('cl-campaign')
  if (campSel) {
    const activeCampaigns = allCampaigns.filter(c => c.status === 'active')
    campSel.innerHTML = '<option value="">No campaign</option>' +
      activeCampaigns.map(c => `<option value="${c.id}">${c.name}</option>`).join('')
  }

  // Populate disposition dropdown
  const dispSel = document.getElementById('cl-disposition')
  if (dispSel) {
    dispSel.innerHTML = '<option value="">No disposition</option>' +
      allDispositionTags.map(t => `<option value="${t.id}">${t.name}</option>`).join('')
  }
}

const closeCreateLeadModal = () => document.getElementById('create-lead-modal').classList.remove('open')

const saveCreateLead = async () => {
  const phone = document.getElementById('cl-phone').value.trim()
  if (!phone) { document.getElementById('cl-error').textContent = 'Phone is required.'; document.getElementById('cl-error').style.display = 'block'; return }
  const body = {
    first_name: document.getElementById('cl-first').value.trim(),
    last_name: document.getElementById('cl-last').value.trim(),
    phone,
    email: document.getElementById('cl-email').value.trim(),
    date_of_birth: document.getElementById('cl-dob').value.trim(),
    state: document.getElementById('cl-state').value,
    zip_code: document.getElementById('cl-zip').value.trim(),
    product: document.getElementById('cl-product').value.trim(),
    address: document.getElementById('cl-address').value.trim(),
    notes: document.getElementById('cl-notes').value.trim(),
    autopilot: document.getElementById('cl-autopilot').checked
  }
  const btn = document.getElementById('cl-save-btn')
  btn.disabled = true
  btn.textContent = 'Saving...'
  try {
    const res = await fetch('/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json()
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to create lead')
    const newLeadId = data.lead.id

    // Apply campaign enrollment if selected
    const campaignId = document.getElementById('cl-campaign')?.value
    if (campaignId) {
      await fetch(`/campaigns/${campaignId}/enroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_ids: [newLeadId], start_date: new Date().toISOString() })
      }).catch(() => {})
    }

    // Apply disposition if selected
    const dispositionId = document.getElementById('cl-disposition')?.value
    if (dispositionId) {
      await fetch('/dispositions/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: newLeadId, disposition_tag_id: dispositionId })
      }).catch(() => {})
    }

    closeCreateLeadModal()
    allLeads.unshift(data.lead)
    updateStats(allLeads)
    renderBucketPills()
    filterLeads()
  } catch (err) {
    document.getElementById('cl-error').textContent = err.message
    document.getElementById('cl-error').style.display = 'block'
  } finally {
    btn.disabled = false
    btn.textContent = 'Create Lead'
  }
}

// ===== TEMPLATES =====
const loadTemplates = async () => {
  try {
    const res = await fetch('/templates')
    const data = await res.json()
    allTemplates = data.templates || []
  } catch (err) { console.error(err) }
}

// ===== LEAD DETAIL MODAL =====
const openLeadDetail = async (leadId) => {
  detailLeadId = leadId
  const lead = allLeads.find(l => l.id === leadId)
  if (!lead) return
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Unknown'
  const initials = getInitials(lead.first_name, lead.last_name)
  const detailDispIds = (lead.lead_dispositions || []).map(ld => ld.disposition_tag_id)
  if (!detailDispIds.length && lead.disposition_tag_id) detailDispIds.push(lead.disposition_tag_id)
  const detailDispTags = detailDispIds.map(id => allDispositionTags.find(t => t.id === id)).filter(Boolean)
  document.getElementById('detail-avatar').textContent = initials
  document.getElementById('detail-name').innerHTML = `
    ${name}
    ${detailDispTags.map(t => `<span class="disposition-pill" style="background:${t.color}">${t.name}</span>`).join('')}
    <span class="tag tag-${lead.status}">${lead.status}</span>
    ${lead.is_sold ? '<span class="tag" style="background:#d1fae5;color:#065f46;">✓ Sold</span>' : ''}
  `
  document.getElementById('detail-meta').innerHTML = `
    <span>📞 ${lead.phone}</span>
    ${lead.email ? `<span>✉️ ${lead.email}</span>` : ''}
    ${lead.state ? `<span>📍 ${lead.state}${lead.zip_code ? ' ' + lead.zip_code : ''}</span>` : ''}
    ${lead.timezone ? `<span>🕐 ${getLocalTime(lead.timezone)} local</span>` : ''}
    ${lead.bucket_id ? (() => { const bk = allBuckets.find(b => b.id === lead.bucket_id); return bk ? `<span>📁 ${bk.name}</span>` : '' })() : (lead.bucket ? `<span>📁 ${lead.bucket}</span>` : '')}
  `
  const tags = lead.campaign_tags || []
  document.getElementById('detail-tags').innerHTML = tags.map(t => `<span class="tag tag-campaign">${t}</span>`).join('')
  document.getElementById('detail-call-btn').onclick = () => callLead(lead.phone)
  document.getElementById('detail-sms-btn').onclick = () => { document.getElementById('lead-detail-modal').classList.remove('open'); openSMSModal(leadId, name) }
  document.getElementById('detail-disp-btn').onclick = () => { document.getElementById('lead-detail-modal').classList.remove('open'); openDispositionModal(leadId, name) }
  const followupBar = document.getElementById('detail-followup-bar')
  const followupBadge = document.getElementById('detail-followup-badge')
  if (lead.next_followup_at) {
    const due = new Date(lead.next_followup_at)
    followupBar.style.display = 'block'
    followupBadge.textContent = `📅 Next Follow Up: ${due.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} ${due.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}${lead.next_followup_note ? ' — ' + lead.next_followup_note : ''}`
  } else {
    followupBar.style.display = 'none'
  }
  document.getElementById('detail-info-grid').innerHTML = [
    { lbl: 'First Name', val: lead.first_name || '—' },
    { lbl: 'Last Name', val: lead.last_name || '—' },
    { lbl: 'Phone', val: lead.phone || '—' },
    { lbl: 'Email', val: lead.email || '—' },
    { lbl: 'State', val: lead.state || '—' },
    { lbl: 'Zip Code', val: lead.zip_code || '—' },
    { lbl: 'Date of Birth', val: lead.date_of_birth || '—' },
    { lbl: 'Product', val: lead.product || '—' },
    { lbl: 'Address', val: lead.address || '—' },
    { lbl: 'Timezone', val: lead.timezone || '—' },
    { lbl: 'Autopilot', val: lead.autopilot ? 'ON' : 'OFF' },
    { lbl: 'Imported', val: lead.created_at ? formatDate(lead.created_at) : '—' }
  ].map(item => `
    <div class="detail-info-item">
      <div class="lbl">${item.lbl}</div>
      <div class="val">${item.val}</div>
    </div>
  `).join('')
  switchDetailTab('info')
  document.getElementById('lead-detail-modal').classList.add('open')
  loadDetailSMS(leadId)
  loadDetailTasks(leadId)
  loadDetailDispositionHistory(leadId)
}

const switchDetailTab = (tab) => {
  document.querySelectorAll('.lead-detail-tab').forEach((t, i) => {
    const tabs = ['info', 'sms', 'tasks', 'dispositions']
    t.classList.toggle('active', tabs[i] === tab)
  })
  document.querySelectorAll('.lead-detail-panel').forEach(p => p.classList.remove('active'))
  document.getElementById(`detail-panel-${tab}`)?.classList.add('active')
}

const loadDetailSMS = async (leadId) => {
  try {
    const res = await fetch('/conversations')
    const data = await res.json()
    const conv = (data.conversations || []).find(c => c.lead_id === leadId)
    const container = document.getElementById('detail-sms-list')
    if (!conv) { container.innerHTML = `<div style="text-align:center;padding:32px;color:#d1d5db;font-size:13px;">No messages yet</div>`; return }
    const res2 = await fetch(`/conversations/${conv.id}`)
    const data2 = await res2.json()
    const fullConv = data2.conversation
    if (!fullConv?.messages?.length) { container.innerHTML = `<div style="text-align:center;padding:32px;color:#d1d5db;font-size:13px;">No messages yet</div>`; return }
    container.innerHTML = fullConv.messages.map(m => `
      <div class="msg-history-item ${m.direction}">
        <div class="direction">${m.direction === 'inbound' ? '← Received' : m.is_ai ? '→ AI Sent' : '→ Sent'}</div>
        <div class="body">${m.body}</div>
        <div class="time">${formatTime(m.sent_at)}</div>
      </div>
    `).join('')
  } catch (err) { console.error(err) }
}

const loadDetailTasks = async (leadId) => {
  try {
    const res = await fetch(`/tasks/${leadId}`)
    const data = await res.json()
    renderDetailTasks(data.tasks || [], leadId)
  } catch (err) { console.error(err) }
}

const renderDetailTasks = (tasks, leadId) => {
  const container = document.getElementById('detail-tasks-list')
  if (!tasks.length) {
    container.innerHTML = `<div style="text-align:center;padding:32px;color:#d1d5db;font-size:13px;">No tasks yet — click "+ Add Task" to create one</div>`
    return
  }
  const now = new Date()
  container.innerHTML = tasks.map(t => {
    const due = new Date(t.due_date)
    const isOverdue = !t.completed && due < now
    const isToday = !t.completed && due.toDateString() === now.toDateString()
    const dueStr = due.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + due.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    return `
      <div class="task-row" id="task-row-${t.id}">
        <input type="checkbox" class="task-check" ${t.completed ? 'checked' : ''} onchange="toggleTask('${t.id}', this.checked, '${leadId}')">
        <div class="task-info">
          <div class="task-title ${t.completed ? 'completed' : ''}">${t.title}</div>
          <div class="task-due ${isOverdue ? 'overdue' : isToday ? 'today' : ''}">${isOverdue ? '⚠️ Overdue — ' : isToday ? '📅 Today — ' : ''}${dueStr}${t.notes ? ' · ' + t.notes : ''}</div>
        </div>
        <button class="btn btn-danger btn-sm" onclick="deleteTask('${t.id}', '${leadId}')">Delete</button>
      </div>
    `
  }).join('')
}

const openAddTaskForm = () => {
  const form = document.getElementById('add-task-form')
  form.style.display = 'block'
  document.getElementById('new-task-title').value = ''
  document.getElementById('new-task-notes').value = ''
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(10, 0, 0, 0)
  const pad = n => String(n).padStart(2, '0')
  document.getElementById('new-task-due').value = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth()+1)}-${pad(tomorrow.getDate())}T${pad(tomorrow.getHours())}:${pad(tomorrow.getMinutes())}`
}

const saveNewTask = async () => {
  const title = document.getElementById('new-task-title').value.trim()
  const due_date = document.getElementById('new-task-due').value
  const notes = document.getElementById('new-task-notes').value.trim()
  if (!title) return toast.error('Required', 'Please enter a task title')
  if (!due_date) return toast.error('Required', 'Please set a due date')
  try {
    const res = await fetch('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_id: detailLeadId, title, due_date: new Date(due_date).toISOString(), notes })
    })
    const data = await res.json()
    if (data.success) {
      document.getElementById('add-task-form').style.display = 'none'
      loadDetailTasks(detailLeadId)
      loadLeads()
      toast.success('Task created', title)
    } else toast.error('Save failed', data.error || 'Could not save task')
  } catch (err) { toast.error('Error', 'Something went wrong') }
}

const toggleTask = async (taskId, completed, leadId) => {
  try {
    await fetch(`/tasks/${taskId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ completed }) })
    loadDetailTasks(leadId)
    loadLeads()
  } catch (err) { console.error(err) }
}

const deleteTask = async (taskId, leadId) => {
  if (!await confirmModal('Delete task?', 'This task will be permanently removed.', 'Delete', true)) return
  try {
    await fetch(`/tasks/${taskId}`, { method: 'DELETE' })
    loadDetailTasks(leadId)
    loadLeads()
  } catch (err) { console.error(err) }
}

const loadDetailDispositionHistory = async (leadId) => {
  try {
    const res = await fetch(`/dispositions/history/${leadId}`)
    const data = await res.json()
    const container = document.getElementById('detail-disp-list')
    if (!data.history?.length) {
      container.innerHTML = `<div style="text-align:center;padding:32px;color:#d1d5db;font-size:13px;">No disposition history yet</div>`
      return
    }
    container.innerHTML = data.history.map(h => `
      <div class="disp-history-item">
        <div class="dot" style="background:${h.disposition_tags?.color || '#6366f1'}"></div>
        <div class="info">
          <div class="tag-name">${h.disposition_tags?.name || 'Unknown'}</div>
          <div class="applied">${formatTime(h.applied_at)}${h.notes ? ' · ' + h.notes : ''}</div>
        </div>
      </div>
    `).join('')
  } catch (err) { console.error(err) }
}

// ===== ONBOARDING CHECKLIST =====
const CHECKLIST_KEY = 'checklist_dismissed'

const loadChecklist = async (profile) => {
  if (localStorage.getItem(CHECKLIST_KEY)) return
  try {
    const [pnRes, campRes] = await Promise.all([fetch('/phone-numbers'), fetch('/campaigns')])
    const pnData = await pnRes.json()
    const campData = await campRes.json()
    const checks = {
      profile: !!(profile.agent_name && profile.agency_name),
      phone: (pnData.phone_numbers || []).length > 0,
      campaign: (campData.campaigns || []).length > 0,
      leads: allLeads.length > 0
    }
    const done = Object.values(checks).filter(Boolean).length
    if (done === 4) return
    renderChecklist(checks, done)
  } catch (err) { console.error('Checklist error:', err) }
}

const renderChecklist = (checks, done) => {
  const steps = [
    { key: 'profile', label: 'Complete your profile', sub: 'Add your name and agency — Settings → Account', action: () => { window.location.href = '/settings.html?panel=account' }, actionText: 'Go to Settings →' },
    { key: 'phone', label: 'Add a phone number', sub: 'Purchase a number to send and receive texts', action: () => { window.location.href = '/settings.html?panel=phone-numbers' }, actionText: 'Go to Settings →' },
    { key: 'campaign', label: 'Create your first campaign', sub: 'Write your drip message sequence', action: () => { window.location.href = '/campaigns.html' }, actionText: 'Go to Campaigns →' },
    { key: 'leads', label: 'Import your first leads', sub: 'Upload a CSV or Excel file', action: () => openUploadModal(), actionText: 'Import now →' }
  ]
  const pct = Math.round((done / 4) * 100)
  document.getElementById('checklist-bar').style.width = `${pct}%`
  document.getElementById('checklist-steps').innerHTML = steps.map(s => `
    <div class="checklist-step ${checks[s.key] ? 'done' : ''}" onclick="${checks[s.key] ? '' : `(${s.action.toString()})()`}">
      <div class="step-check">${checks[s.key] ? '✓' : ''}</div>
      <div class="step-label"><strong>${s.label}</strong><br><span style="font-size:12px;color:#9ca3af;">${s.sub}</span></div>
      ${!checks[s.key] ? `<span class="step-action">${s.actionText}</span>` : ''}
    </div>`).join('')
  document.getElementById('onboarding-checklist').style.display = 'block'
}

const dismissChecklist = () => {
  localStorage.setItem(CHECKLIST_KEY, '1')
  document.getElementById('onboarding-checklist').style.display = 'none'
}

const toggleFilters = () => {
  const panel = document.getElementById('search-panel')
  const arrow = document.getElementById('filters-arrow')
  const open = panel.classList.toggle('panel-open')
  arrow.textContent = open ? '▲' : '▼'
}

// Outside-click collapses the filter panel
document.addEventListener('click', (e) => {
  const panel = document.getElementById('search-panel')
  const toggleBtn = document.getElementById('filters-toggle-btn')
  if (panel?.classList.contains('panel-open') && !panel.contains(e.target) && !toggleBtn?.contains(e.target)) {
    panel.classList.remove('panel-open')
    const arrow = document.getElementById('filters-arrow')
    if (arrow) arrow.textContent = '▼'
  }
})

const updateFilterBadge = () => {
  const filterIds = ['sf-status', 'sf-state', 'sf-campaign', 'sf-bucket', 'sf-timezone', 'sf-autopilot', 'sf-sold', 'sf-date-from', 'sf-date-to']
  let count = filterIds.filter(id => document.getElementById(id)?.value).length
  count += (msState['disposition']?.selected || []).length
  count += (msState['exclude-disposition']?.selected || []).length
  if (activeCampaignQuickFilter) count++
  const badge = document.getElementById('filters-count-badge')
  if (!badge) return
  if (count > 0) { badge.textContent = count; badge.style.display = 'inline'; }
  else { badge.style.display = 'none'; }
}

// ===== ACTIONS MENU =====
const openLeadActionsMenu = (leadId, leadName, btn) => {
  const lead = allLeads.find(l => l.id === leadId)
  if (!lead) return

  const menu = document.getElementById('lead-actions-menu')
  menu.innerHTML = `
    <div style="padding:6px 0;">
      <div class="ami-section">COMMUNICATION</div>
      <button class="ami-item" onclick="closeLeadActionsMenu();openSMSModal('${leadId}','${leadName}')">
        <span class="ami-icon">💬</span> Send Text
      </button>
      <button class="ami-item" onclick="closeLeadActionsMenu();viewConversation('${leadId}')">
        <span class="ami-icon">🗨️</span> View Conversation
      </button>
      <button class="ami-item" onclick="closeLeadActionsMenu();openScheduleFollowupModal('${leadId}','${leadName}')">
        <span class="ami-icon">📅</span> Schedule Follow-up
      </button>
      <div class="ami-divider"></div>
      <div class="ami-section">PIPELINE</div>
      <button class="ami-item" onclick="closeLeadActionsMenu();openDispositionModal('${leadId}','${leadName}')">
        <span class="ami-icon">🏷️</span> Apply Disposition
      </button>
      <button class="ami-item" onclick="event.stopPropagation();toggleAmiSub('ami-bucket-sub')">
        <span class="ami-icon">📁</span> Move to Bucket <span style="margin-left:auto;font-size:11px;color:#9ca3af;flex-shrink:0;">▼</span>
      </button>
      <div id="ami-bucket-sub" style="display:none;background:#f9fafb;border-top:1px solid #f3f4f6;padding:4px 0;">
        <div class="ami-sub-item" onclick="closeLeadActionsMenu();moveToBucket('${leadId}',null)">— No bucket</div>
        ${allBuckets.map(bk => `<div class="ami-sub-item" onclick="closeLeadActionsMenu();moveToBucket('${leadId}','${bk.id}')"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${bk.color};margin-right:8px;flex-shrink:0;"></span>${bk.name}</div>`).join('')}
      </div>
      <button class="ami-item" onclick="closeLeadActionsMenu();openEnrollModalForLead('${leadId}')">
        <span class="ami-icon">⚡</span> Assign to Campaign
      </button>
      ${lead.is_sold
        ? `<button class="ami-item" onclick="closeLeadActionsMenu();markUnsold('${leadId}','${leadName}')"><span class="ami-icon">↩</span> Unmark Sold</button>`
        : `<button class="ami-item" onclick="closeLeadActionsMenu();openMarkSoldModal('${leadId}','${leadName}')"><span class="ami-icon">🎉</span> Mark as Sold</button>`
      }
      <button class="ami-item" onclick="closeLeadActionsMenu();markAsCalled('${leadId}')">
        <span class="ami-icon">📞</span> Mark as Called
      </button>
      <div class="ami-divider"></div>
      <div class="ami-section">LEAD MANAGEMENT</div>
      ${lead.is_blocked
        ? `<button class="ami-item" onclick="closeLeadActionsMenu();unblockLeadAction('${leadId}')"><span class="ami-icon">✅</span> Unblock Lead</button>`
        : `<button class="ami-item" onclick="closeLeadActionsMenu();blockLeadAction('${leadId}','${leadName}')"><span class="ami-icon">🚫</span> Block Lead</button>`
      }
      <button class="ami-item" onclick="closeLeadActionsMenu();skipTodayMessages('${leadId}','${leadName}')">
        <span class="ami-icon">⏸</span> Skip Today's Messages
      </button>
      <button class="ami-item" onclick="closeLeadActionsMenu();pauseAllDrips('${leadId}','${leadName}')">
        <span class="ami-icon">⏹</span> Pause All Drips
      </button>
      ${lead.opted_out
        ? `<button class="ami-item" onclick="closeLeadActionsMenu();undoOptOutAction('${leadId}','${leadName}')"><span class="ami-icon">✅</span> Remove Opt-out</button>`
        : `<button class="ami-item ami-danger" onclick="closeLeadActionsMenu();confirmOptOutLead('${leadId}','${leadName}')"><span class="ami-icon">🚫</span> Opt out of all texts</button>`
      }
      <div class="ami-divider"></div>
      <div class="ami-section" style="color:#ef4444;">DANGER ZONE</div>
      <button class="ami-item ami-danger" onclick="closeLeadActionsMenu();openDeleteLeadModal('${leadId}','${leadName}')">
        <span class="ami-icon">🗑️</span> Delete Lead
      </button>
    </div>
  `

  const rect = btn.getBoundingClientRect()
  const menuW = 230
  let top = rect.bottom + 4
  let left = rect.right - menuW
  if (left < 8) left = 8
  if (top + 480 > window.innerHeight) top = Math.max(8, rect.top - 480)

  menu.style.top = `${top + window.scrollY}px`
  menu.style.left = `${left}px`
  menu.style.display = 'block'

  setTimeout(() => {
    document.addEventListener('click', handleActionsMenuClose, { once: true })
  }, 0)
}

const toggleAmiSub = (id) => {
  const sub = document.getElementById(id)
  if (sub) sub.style.display = sub.style.display === 'none' ? 'block' : 'none'
}

const handleActionsMenuClose = (e) => {
  const menu = document.getElementById('lead-actions-menu')
  if (!menu) return
  if (menu.contains(e.target)) {
    setTimeout(() => document.addEventListener('click', handleActionsMenuClose, { once: true }), 0)
  } else {
    closeLeadActionsMenu()
  }
}

const closeLeadActionsMenu = () => {
  const menu = document.getElementById('lead-actions-menu')
  if (menu) menu.style.display = 'none'
}

// ===== NEW ACTIONS =====
const markAsCalled = async (leadId) => {
  try {
    const res = await fetch(`/leads/${leadId}/mark-called`, { method: 'PATCH' })
    const data = await res.json()
    if (data.success) {
      const lead = allLeads.find(l => l.id === leadId)
      if (lead) lead.last_called_at = data.lead.last_called_at
      toast.success('Call logged', 'Call attempt recorded')
    } else toast.error('Error', data.error || 'Could not log call')
  } catch (err) { toast.error('Error', 'Something went wrong') }
}

const skipTodayMessages = async (leadId, name) => {
  try {
    const res = await fetch(`/leads/${leadId}/skip-today`, { method: 'PATCH' })
    const data = await res.json()
    if (data.success) {
      toast.success("Today's messages skipped", `No drip messages will send to ${name} today`)
    } else toast.error('Error', data.error || 'Could not skip today')
  } catch (err) { toast.error('Error', 'Something went wrong') }
}

const pauseAllDrips = async (leadId, name) => {
  try {
    const res = await fetch(`/leads/${leadId}/pause-drips`, { method: 'PATCH' })
    const data = await res.json()
    if (data.success) {
      toast.success('Drips paused', `All campaigns paused for ${name}`)
    } else toast.error('Error', data.error || 'Could not pause drips')
  } catch (err) { toast.error('Error', 'Something went wrong') }
}

const blockLeadAction = async (leadId, name) => {
  if (!confirm(`Block ${name}? This will pause all messages and prevent future texts.`)) return
  try {
    const res = await fetch(`/leads/${leadId}/block`, { method: 'PATCH' })
    const data = await res.json()
    if (data.success) {
      const lead = allLeads.find(l => l.id === leadId)
      if (lead) Object.assign(lead, data.lead)
      filterLeads()
      toast.success('Lead blocked', name)
    } else toast.error('Error', data.error || 'Could not block lead')
  } catch (err) { toast.error('Error', 'Something went wrong') }
}

const unblockLeadAction = async (leadId) => {
  try {
    const res = await fetch(`/leads/${leadId}/unblock`, { method: 'PATCH' })
    const data = await res.json()
    if (data.success) {
      const lead = allLeads.find(l => l.id === leadId)
      if (lead) Object.assign(lead, data.lead)
      filterLeads()
      toast.success('Lead unblocked')
    } else toast.error('Error', data.error || 'Could not unblock lead')
  } catch (err) { toast.error('Error', 'Something went wrong') }
}

const confirmOptOutLead = async (leadId, name) => {
  if (!confirm(`Opt out ${name} from all texts?\n\nThis will:\n• Cancel all scheduled messages\n• Pause all campaign drips\n• Prevent any future texts to this lead\n\nThis can be undone.`)) return
  try {
    const res = await fetch(`/leads/${leadId}/opt-out`, { method: 'POST' })
    const data = await res.json()
    if (data.success) {
      const lead = allLeads.find(l => l.id === leadId)
      if (lead) Object.assign(lead, data.lead)
      filterLeads()
      toast.success('Lead opted out', name + ' will no longer receive texts')
    } else toast.error('Error', data.error || 'Could not opt out lead')
  } catch (err) { toast.error('Error', 'Something went wrong') }
}

const undoOptOutAction = async (leadId, name) => {
  if (!confirm(`Remove opt-out for ${name}? They can receive texts again.`)) return
  try {
    const res = await fetch(`/leads/${leadId}/undo-opt-out`, { method: 'POST' })
    const data = await res.json()
    if (data.success) {
      const lead = allLeads.find(l => l.id === leadId)
      if (lead) Object.assign(lead, data.lead)
      filterLeads()
      toast.success('Opt-out removed', name + ' can now receive texts')
    } else toast.error('Error', data.error || 'Could not remove opt-out')
  } catch (err) { toast.error('Error', 'Something went wrong') }
}

// ===== DELETE LEAD =====
const openDeleteLeadModal = (leadId, name) => {
  deleteTargetLeadId = leadId
  deleteTargetLeadName = name
  document.getElementById('delete-modal-title').textContent = `Delete ${name}?`
  document.getElementById('delete-confirm-input').value = ''
  const btn = document.getElementById('delete-confirm-btn')
  btn.disabled = true
  btn.style.opacity = '0.4'
  btn.style.cursor = 'not-allowed'
  btn.textContent = 'Permanently Delete'
  document.getElementById('delete-lead-modal').classList.add('open')
  setTimeout(() => document.getElementById('delete-confirm-input')?.focus(), 80)
}

const closeDeleteModal = () => {
  document.getElementById('delete-lead-modal').classList.remove('open')
  deleteTargetLeadId = null
  deleteTargetLeadName = null
}

const checkDeleteInput = () => {
  const val = document.getElementById('delete-confirm-input').value
  const btn = document.getElementById('delete-confirm-btn')
  const valid = val === 'DELETE'
  btn.disabled = !valid
  btn.style.opacity = valid ? '1' : '0.4'
  btn.style.cursor = valid ? 'pointer' : 'not-allowed'
}

const confirmDeleteLead = async () => {
  if (!deleteTargetLeadId || document.getElementById('delete-confirm-input').value !== 'DELETE') return
  const btn = document.getElementById('delete-confirm-btn')
  btn.disabled = true
  btn.textContent = 'Deleting...'
  try {
    const res = await fetch(`/leads/${deleteTargetLeadId}`, { method: 'DELETE' })
    const data = await res.json()
    if (data.success) {
      allLeads = allLeads.filter(l => l.id !== deleteTargetLeadId)
      const name = deleteTargetLeadName
      closeDeleteModal()
      updateStats(allLeads)
      renderBucketPills()
      filterLeads()
      toast.success('Lead deleted', name)
    } else toast.error('Delete failed', data.error || 'Could not delete lead')
  } catch (err) { toast.error('Error', 'Something went wrong') }
  finally {
    btn.disabled = false
    btn.textContent = 'Permanently Delete'
  }
}

// ===== SCHEDULE FOLLOW-UP =====
const openScheduleFollowupModal = (leadId, name) => {
  scheduleFollowupLeadId = leadId
  document.getElementById('schedule-followup-lead-name').textContent = `For: ${name}`
  document.getElementById('schedule-followup-title').value = ''
  document.getElementById('schedule-followup-notes').value = ''
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(10, 0, 0, 0)
  const pad = n => String(n).padStart(2, '0')
  document.getElementById('schedule-followup-date').value = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth()+1)}-${pad(tomorrow.getDate())}T${pad(tomorrow.getHours())}:${pad(tomorrow.getMinutes())}`
  document.getElementById('schedule-followup-modal').classList.add('open')
  setTimeout(() => document.getElementById('schedule-followup-title')?.focus(), 80)
}

const saveScheduleFollowup = async () => {
  const title = document.getElementById('schedule-followup-title').value.trim()
  const due_date = document.getElementById('schedule-followup-date').value
  const notes = document.getElementById('schedule-followup-notes').value.trim()
  if (!title) return toast.error('Required', 'Please enter a task description')
  if (!due_date) return toast.error('Required', 'Please set a date and time')
  try {
    const res = await fetch('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_id: scheduleFollowupLeadId, title, due_date: new Date(due_date).toISOString(), notes })
    })
    const data = await res.json()
    if (data.success) {
      document.getElementById('schedule-followup-modal').classList.remove('open')
      loadLeads()
      toast.success('Follow-up scheduled', title)
    } else toast.error('Save failed', data.error || 'Could not schedule follow-up')
  } catch (err) { toast.error('Error', 'Something went wrong') }
}

// ===== INIT =====
const init = async () => {
  const authed = await checkAuth()
  if (!authed) return
  try {
    const res = await fetch('/campaigns')
    const data = await res.json()
    allCampaigns = data.campaigns || []
  } catch (e) {}
  await Promise.all([loadDispositionTags(), loadTemplates(), loadProfile()])
  // Load conversation maps for lead card badges
  fetch('/conversations').then(r => r.json()).then(d => {
    unreadConvMap = {}
    hotLeadMap = {}
    ghostedMap = {}
    ;(d.conversations || []).forEach(c => {
      if ((c.unread_count || 0) > 0 && c.lead_id) unreadConvMap[c.lead_id] = c.unread_count
      if (c.handoff_reason === 'quote_requested' && c.lead_id) hotLeadMap[c.lead_id] = true
      if (c.engagement_status === 'positive_ghosted' && c.lead_id) ghostedMap[c.lead_id] = 'positive_ghosted'
      else if (c.engagement_status === 'ghosted_mid' && c.lead_id && !ghostedMap[c.lead_id]) ghostedMap[c.lead_id] = 'ghosted_mid'
    })
  }).catch(() => {})
  // Apply URL params before loadLeads so filterLeads picks them up
  const params = new URLSearchParams(window.location.search)
  const bucketIdParam = params.get('bucket_id')
  const stateParam = params.get('state')
  if (bucketIdParam) activeBucket = bucketIdParam
  if (stateParam) { const el = document.getElementById('sf-state'); if (el) el.value = stateParam }

  loadLeads()
  loadCalBadge()
  loadNotifBadge()
  setInterval(loadNotifBadge, 30000)
}

document.addEventListener('DOMContentLoaded', init)
