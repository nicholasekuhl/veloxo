// ===== STATE =====
const LEADS_PER_PAGE = 50
let currentLeadsPage = 1
let totalLeads = 0
let isLoadingLeads = false
let hasMoreLeads = false
let isSearchActive = false
let searchDebounceTimer = null
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
let importTimeoutHandle = null
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
let contextMenuBucketIsFolder = false
let deleteTargetLeadId = null
let deleteTargetLeadName = null
let scheduleFollowupLeadId = null
let dragBucketId = null

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
const selectBucket = async (bucketId) => {
  activeBucket = bucketId
  activeFolderId = ''
  renderBucketPills()

  if (!bucketId) {
    // All Leads — reset to normal paginated view
    await loadLeads()
    return
  }

  // Server-side fetch for this specific bucket
  const grid = document.getElementById('leads-grid')
  grid.innerHTML = '<div style="padding:40px;text-align:center;color:#9ca3af;font-size:13px;">Loading...</div>'

  try {
    const res = await fetch('/leads?bucket_id=' + bucketId + '&limit=200&page=1')
    const data = await res.json()
    allLeads = data.leads || []

    document.getElementById('leads-count').textContent =
      'Showing ' + allLeads.length + ' of ' + (data.total || allLeads.length) + ' leads in bucket'

    renderLeads(allLeads)

    const loadMoreWrapper = document.getElementById('load-more-wrapper')
    if (loadMoreWrapper) loadMoreWrapper.style.display = (data.total > allLeads.length) ? 'block' : 'none'
  } catch (err) {
    console.error('Bucket filter error:', err)
  }
}

const selectFolder = async (folderId) => {
  activeFolderId = activeFolderId === folderId ? '' : folderId
  activeBucket = ''
  renderBucketPills()

  if (!activeFolderId) {
    // Deselected folder — reset to all leads
    await loadLeads()
    return
  }

  // Get all bucket IDs in this folder (direct children only)
  const folderBucketIds = allBuckets
    .filter(b => b.parent_id === folderId && !b.is_folder)
    .map(b => b.id)

  if (folderBucketIds.length === 0) {
    document.getElementById('leads-count').textContent = '0 leads in folder'
    renderLeads([])
    return
  }

  const grid = document.getElementById('leads-grid')
  grid.innerHTML = '<div style="padding:40px;text-align:center;color:#9ca3af;font-size:13px;">Loading...</div>'

  try {
    const results = await Promise.all(
      folderBucketIds.map(id =>
        fetch('/leads?bucket_id=' + id + '&limit=500&page=1').then(r => r.json())
      )
    )

    allLeads = results.flatMap(r => r.leads || [])
    const total = results.reduce((sum, r) => sum + (r.total || 0), 0)

    document.getElementById('leads-count').textContent =
      'Showing ' + allLeads.length + ' of ' + total + ' leads in folder'

    renderLeads(allLeads)

    const loadMoreWrapper = document.getElementById('load-more-wrapper')
    if (loadMoreWrapper) loadMoreWrapper.style.display = 'none'
  } catch (err) {
    console.error('Folder filter error:', err)
  }
}

const toggleFolderCollapse = (folderId, e) => {
  e.stopPropagation()
  collapsedFolders[folderId] = !collapsedFolders[folderId]
  renderBucketPills()
}

const getFolderCount = (folderId, buckets) => {
  let total = 0
  for (const b of buckets) {
    if (b.parent_id === folderId) {
      if (b.is_folder) {
        total += getFolderCount(b.id, buckets)
      } else {
        total += b.lead_count || 0
      }
    }
  }
  return total
}

const renderBucketPill = (b, extraStyle = '') => {
  const count = b.lead_count || 0
  const isActive = activeBucket === b.id
  const c = b.color || '#6366f1'
  const bg = isActive ? c : 'transparent'
  const color = isActive ? '#fff' : c
  const border = c
  const baseStyle = `background:${bg};color:${color};border-color:${border};${extraStyle}`
  if (b.is_system) {
    return `<button class="bucket-tab" data-bucket-id="${b.id}" style="${baseStyle}" onclick="selectBucket('${b.id}')" title="System bucket — cannot be renamed or deleted">🔒 ${b.name}<span style="opacity:0.8;font-size:11px;margin-left:4px;">${count}</span></button>`
  }
  // data-id used for drag-and-drop ordering; data-bucket-name used for context menu
  const escapedName = (b.name || '').replace(/"/g, '&quot;')
  return `<button class="bucket-tab" data-id="${b.id}" data-bucket-id="${b.id}" data-bucket-name="${escapedName}" data-bucket-color="${b.color || ''}" data-is-folder="${b.is_folder ? '1' : '0'}" style="${baseStyle}" onclick="selectBucket('${b.id}')" title="Right-click to rename, archive or run a campaign">${b.name}<span style="opacity:0.8;font-size:11px;margin-left:4px;">${count}</span></button>`
}

const renderBucketPills = () => {
  const container = document.getElementById('bucket-tabs')
  if (!container) return

  // Separate system (fixed) from user-created (draggable) buckets
  const soldBucketObj = allBuckets.find(b => b.system_key === 'sold')
  const optedOutBucketObj = allBuckets.find(b => b.system_key === 'opted_out')
  const dynamicBuckets = allBuckets.filter(b => !b.is_system)
  const depth1Folders = dynamicBuckets.filter(b => b.is_folder && b.parent_id)

  // Top-level dynamic items (folders + standalone buckets) sorted by sort_order
  const topLevelItems = dynamicBuckets
    .filter(b => !b.parent_id)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))

  // ── Fixed pills ─────────────────────────────────────────────────────────────
  let html = `<div class="bucket-tab${activeBucket === '' && activeFolderId === '' ? ' active' : ''}" onclick="selectBucket('')">All Leads <span class="count">${totalLeads || allLeads.length}</span></div>`

  if (soldBucketObj) {
    const c = soldBucketObj.color || '#22c55e'
    const isActive = activeBucket === soldBucketObj.id
    html += `<button class="bucket-tab" data-bucket-id="${soldBucketObj.id}" style="background:${isActive ? c : 'transparent'};color:${isActive ? '#fff' : c};border-color:${c};" onclick="selectBucket('${soldBucketObj.id}')">💰 Sold<span style="opacity:0.8;font-size:11px;margin-left:4px;">${soldBucketObj.lead_count || 0}</span></button>`
  }

  if (optedOutBucketObj) {
    const c = optedOutBucketObj.color || '#ef4444'
    const isActive = activeBucket === optedOutBucketObj.id
    html += `<button class="bucket-tab" data-bucket-id="${optedOutBucketObj.id}" style="background:${isActive ? c : 'transparent'};color:${isActive ? '#fff' : c};border-color:${c};" onclick="selectBucket('${optedOutBucketObj.id}')">🚫 Opted Out<span style="opacity:0.8;font-size:11px;margin-left:4px;">${optedOutBucketObj.lead_count || 0}</span></button>`
  }

  // ── Draggable dynamic items ─────────────────────────────────────────────────
  for (const item of topLevelItems) {
    if (item.is_folder) {
      const folder = item
      const isCollapsed = collapsedFolders[folder.id]
      const chevron = isCollapsed ? '▶' : '▼'
      const directBuckets = dynamicBuckets.filter(b => !b.is_folder && b.parent_id === folder.id)
      const subFolders = depth1Folders.filter(s => s.parent_id === folder.id)
      const folderCount = getFolderCount(folder.id, allBuckets)

      // Folder wrapper: block-level div so it's actually draggable as a unit
      html += `<div data-drag-id="${folder.id}" data-id="${folder.id}" style="display:inline-flex;align-items:center;gap:2px;flex-wrap:wrap;">
        <button class="bucket-tab" style="color:var(--color-text-secondary,#6b7280);border-color:var(--border-default,#e5e7eb);" onclick="toggleFolderCollapse('${folder.id}',event)">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0"><path d="M1.5 3A1.5 1.5 0 000 4.5v8A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H7.621a1.5 1.5 0 01-1.06-.44L5.5 3H1.5z"/></svg>
          ${folder.name}<span style="opacity:0.7;font-size:11px;margin-left:2px;">${folderCount}</span><span style="font-size:10px;opacity:0.5;margin-left:2px;">${chevron}</span>
        </button>`

      if (!isCollapsed) {
        for (const b of directBuckets) {
          html += renderBucketPill(b, 'margin-left:4px;')
        }
        for (const sub of subFolders) {
          const subCollapsed = collapsedFolders[sub.id]
          const subChevron = subCollapsed ? '▶' : '▼'
          const subBuckets = dynamicBuckets.filter(b => !b.is_folder && b.parent_id === sub.id)
          const subCount = getFolderCount(sub.id, allBuckets)
          html += `<div style="display:inline-flex;align-items:center;gap:2px;flex-wrap:wrap;margin-left:6px;">
            <button class="bucket-tab" style="font-size:11px;color:var(--color-text-secondary,#6b7280);border-color:var(--border-default,#e5e7eb);" onclick="toggleFolderCollapse('${sub.id}',event)">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0"><path d="M1.5 3A1.5 1.5 0 000 4.5v8A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H7.621a1.5 1.5 0 01-1.06-.44L5.5 3H1.5z"/></svg>
              ${sub.name}<span style="opacity:0.7;font-size:10px;margin-left:2px;">${subCount}</span><span style="font-size:9px;opacity:0.5;margin-left:2px;">${subChevron}</span>
            </button>`
          if (!subCollapsed) {
            for (const b of subBuckets) {
              html += renderBucketPill(b, 'margin-left:4px;font-size:11px;')
            }
          }
          html += `</div>`
        }
      }
      html += `</div>`
    } else {
      // Standalone bucket: render button directly (no inline span wrapper — inline elements aren't reliably draggable)
      html += renderBucketPill(item)
    }
  }

  container.innerHTML = html

  // Attach context-menu listeners to user bucket pills
  container.querySelectorAll('.bucket-tab[data-bucket-name]').forEach(btn => {
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      showBucketContextMenu(e.clientX, e.clientY, btn.dataset.bucketId, btn.dataset.bucketName, btn.dataset.isFolder === '1')
    })
  })

  // Attach drag-and-drop to dynamic draggable elements:
  //   - Standalone bucket buttons (.bucket-tab[data-id]) — draggable on the button itself
  //   - Folder wrapper divs ([data-drag-id]) — folder moves as a unit including children
  const getDragId = (el) => el.dataset.id || el.dataset.dragId

  const draggableEls = [
    ...Array.from(container.querySelectorAll('.bucket-tab[data-id]')).filter(btn => !btn.closest('[data-drag-id]')),
    ...Array.from(container.querySelectorAll('[data-drag-id]'))
  ]

  draggableEls.forEach(el => {
    el.draggable = true
    el.addEventListener('dragstart', (e) => {
      dragBucketId = getDragId(el)
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('bucketId', dragBucketId)
      setTimeout(() => { el.style.opacity = '0.4' }, 0)
    })
    el.addEventListener('dragend', () => {
      el.style.opacity = ''
      draggableEls.forEach(d => d.classList.remove('bucket-drag-over'))
    })
    el.addEventListener('dragover', (e) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const targetId = getDragId(el)
      if (dragBucketId && dragBucketId !== targetId) {
        draggableEls.forEach(d => d.classList.remove('bucket-drag-over'))
        el.classList.add('bucket-drag-over')
      }
    })
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('bucket-drag-over')
    })
    el.addEventListener('drop', (e) => {
      e.preventDefault()
      el.classList.remove('bucket-drag-over')
      const targetId = getDragId(el)
      if (!dragBucketId || dragBucketId === targetId) return
      reorderBucketDrop(dragBucketId, targetId)
      dragBucketId = null
    })
  })

  // Show commission total when Sold bucket is active
  const soldBkt = allBuckets.find(b => b.system_key === 'sold')
  const banner = document.getElementById('sold-commission-banner')
  if (banner) {
    if (activeBucket && soldBkt && activeBucket === soldBkt.id) {
      const soldLeads = allLeads.filter(l => l.bucket_id === soldBkt.id)
      const total = soldLeads.reduce((sum, l) => sum + (l.commission || 0), 0)
      const pending = soldLeads.filter(l => l.commission_status === 'pending').reduce((sum, l) => sum + (l.commission || 0), 0)
      banner.innerHTML = `<span style="font-weight:700;color:#166534;">Total Commission: ${fmtComm(total)}</span>${pending > 0 ? `<span style="color:#6b7280;font-size:12px;margin-left:10px;">${fmtComm(pending)} pending</span>` : ''}`
      banner.style.display = 'flex'
    } else {
      banner.style.display = 'none'
    }
  }
}

const reorderBucketDrop = async (draggedId, targetId) => {
  const topLevelItems = allBuckets
    .filter(b => !b.is_system && !b.parent_id)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))

  const fromIdx = topLevelItems.findIndex(b => b.id === draggedId)
  const toIdx = topLevelItems.findIndex(b => b.id === targetId)
  if (fromIdx === -1 || toIdx === -1) return

  const [moved] = topLevelItems.splice(fromIdx, 1)
  topLevelItems.splice(toIdx, 0, moved)

  // Update sort_order in local allBuckets immediately for instant re-render
  topLevelItems.forEach((b, i) => {
    const bkt = allBuckets.find(x => x.id === b.id)
    if (bkt) bkt.sort_order = i
  })
  renderBucketPills()

  try {
    await fetch('/buckets/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: topLevelItems.map(b => b.id) })
    })
  } catch (err) {
    console.error('Failed to save bucket order', err)
    toast.error('Error', 'Could not save bucket order')
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

const serverSearchLeads = async (query) => {
  isSearchActive = true
  const grid = document.getElementById('leads-grid')
  grid.innerHTML = `<div style="padding:40px;text-align:center;color:#9ca3af;font-size:13px;">Searching...</div>`
  try {
    const res = await fetch('/leads?search=' + encodeURIComponent(query) + '&limit=200&page=1')
    const data = await res.json()
    const leads = data.leads || []
    const countEl = document.getElementById('leads-count')
    if (countEl) countEl.textContent = leads.length + ' result' + (leads.length !== 1 ? 's' : '') + ' for "' + query + '"'
    allLeads = leads
    renderLeads(leads)
    const btn = document.getElementById('load-more-btn')
    if (btn) btn.style.display = 'none'
  } catch (err) { console.error('Search error:', err) }
}

const applyFilters = async () => {
  isSearchActive = true
  currentLeadsPage = 1
  const params = new URLSearchParams()
  params.set('limit', '500')
  params.set('page', '1')
  const search = document.getElementById('sf-search')?.value?.trim()
  if (search) params.set('search', search)
  const status = document.getElementById('sf-status')?.value
  if (status) params.set('status', status)
  const state = document.getElementById('sf-state')?.value
  if (state) params.set('state', state)
  const bucket = document.getElementById('sf-bucket')?.value || activeBucket
  if (bucket) params.set('bucket_id', bucket)
  const campaign = document.getElementById('sf-campaign')?.value || activeCampaignQuickFilter
  if (campaign) params.set('campaign_id', campaign)
  const autopilot = document.getElementById('sf-autopilot')?.value
  if (autopilot) params.set('autopilot', autopilot)
  const sold = document.getElementById('sf-sold')?.value
  if (sold) params.set('is_sold', sold)
  const dateFrom = document.getElementById('sf-date-from')?.value
  if (dateFrom) params.set('date_from', dateFrom)
  const dateTo = document.getElementById('sf-date-to')?.value
  if (dateTo) params.set('date_to', dateTo)
  const grid = document.getElementById('leads-grid')
  grid.innerHTML = `<div style="padding:40px;text-align:center;color:#9ca3af;font-size:13px;">Filtering...</div>`
  try {
    const res = await fetch('/leads?' + params.toString())
    const data = await res.json()
    allLeads = data.leads || []
    const countEl = document.getElementById('leads-count')
    if (countEl) countEl.textContent = 'Showing ' + allLeads.length + ' of ' + (data.total || allLeads.length) + ' leads'
    renderLeads(allLeads)
    const btn = document.getElementById('load-more-btn')
    if (btn) btn.style.display = 'none'
  } catch (err) { console.error('Filter error:', err) }
  updateFilterBadge()
}

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
  isSearchActive = false
  currentLeadsPage = 1
  allLeads = []
  loadMoreLeads()
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
        ? `<span class="tag" style="background:#eff6ff;color:#1d4ed8;font-size:10px;font-weight:600;border:1px solid #bfdbfe;">⚡ Campaign Active — Day ${lead.campaign_day}</span>`
        : hasActiveEnrollment
          ? `<span class="tag" style="background:#eff6ff;color:#1d4ed8;font-size:10px;font-weight:600;border:1px solid #bfdbfe;">⚡ Campaign Active</span>`
          : `<span class="tag" style="background:#f0fdf4;color:#166534;font-size:10px;font-weight:600;border:1px solid #bbf7d0;">✓ Campaign Done</span>`
      : ''
    const bucket = lead.bucket_id ? allBuckets.find(b => b.id === lead.bucket_id) : null
    return `
      <div class="lead-card ${lead.notes ? 'has-notes' : ''}" data-lead-id="${lead.id}">
        <div class="lead-card-body" style="display:grid;grid-template-columns:320px 1.8fr 1fr 260px 185px;width:100%;">

          <div class="col-contact">
            <div class="col-contact-top">
              <input type="checkbox" class="lead-cb lead-select-cb" data-id="${lead.id}" onchange="toggleLead(this)" ${selectedLeads.has(lead.id) ? 'checked' : ''}>
              <div class="lead-avatar" style="background:rgba(0,201,167,0.15);color:#00d4b4">${initials}</div>
              <div>
                <div style="display:flex;align-items:center;gap:6px">
                  <div class="lead-name">
                    <a href="/lead.html?id=${lead.id}" target="_blank" style="color:inherit;text-decoration:none;" onmouseover="this.style.color='#00d4b4'" onmouseout="this.style.color='inherit'">${name}</a>
                    ${lead.opted_out ? '<span style="font-size:10px;font-weight:700;color:#f87171;margin-left:4px;">🚫 OPT-OUT</span>' : ''}
                    ${lead.is_sold ? '<span style="font-size:10px;font-weight:700;color:#34d399;margin-left:4px;">✓ SOLD</span>' : ''}
                  </div>
                  <button class="copy-btn" data-copy="${name}" title="Copy name"><svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M2 10V2h8"/></svg></button>
                </div>
                <div style="display:flex;align-items:center;gap:6px">
                  <div class="lead-phone">${lead.phone}</div>
                  <button class="copy-btn" data-copy="${lead.phone}" title="Copy phone"><svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M2 10V2h8"/></svg></button>
                </div>
                ${lead.email ? `<div style="display:flex;align-items:center;gap:6px">
                  <div class="lead-email">${lead.email}</div>
                  <button class="copy-btn" data-copy="${lead.email}" title="Copy email"><svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M2 10V2h8"/></svg></button>
                </div>` : `<div class="lead-email"></div>`}
              </div>
            </div>
            <div class="lead-meta-line">${lead.state || ''} · <span>${lead.zip_code || ''}</span></div>
            ${localTime ? `<div class="lead-local-time"><svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="6" cy="6" r="5"/><path d="M6 3v3l1.5 1.5"/></svg>${localTime} local</div>` : ''}
            <div class="lead-status-row">
              <span class="status-pill sp-${lead.status}"><span class="sp-dot"></span>${lead.status}</span>
              ${hotLeadMap[lead.id] ? '<span style="font-size:11px;margin-left:4px;" title="Hot lead">🔥</span>' : ''}
              ${unreadConvMap[lead.id] ? `<button onclick="event.stopPropagation();viewConversation('${lead.id}')" title="Unread messages" style="background:#ef4444;color:white;border:none;border-radius:9px;padding:1px 6px;font-size:10px;font-weight:700;cursor:pointer;margin-left:4px;">💬 ${unreadConvMap[lead.id]}</button>` : ''}
            </div>
          </div>

          <div class="col-notes">
            <div class="notes-label">Notes</div>
            <textarea class="notes-textarea" placeholder="Add notes about this lead…" data-lead-id="${lead.id}" onblur="saveNotes('${lead.id}', this.value)">${lead.notes || ''}</textarea>
            <div class="notes-footer">
              <span class="notes-timestamp">${lead.notes_updated_at ? 'Last edited ' + timeAgo(lead.notes_updated_at) : 'No notes yet'}</span>
              <button class="notes-save-btn" onclick="saveNotes('${lead.id}', this.closest('.col-notes').querySelector('.notes-textarea').value)">Save</button>
            </div>
          </div>

          <div class="col-quotes">
            <div class="notes-label">Quoted Plans</div>
            <textarea class="notes-textarea quotes-textarea" placeholder="e.g. PPO $245/mo&#10;Dental add-on $32/mo" data-lead-id="${lead.id}" onblur="saveQuotes('${lead.id}', this.value)">${lead.quotes || ''}</textarea>
            <div class="notes-footer">
              <span class="notes-timestamp">${lead.quotes_updated_at ? 'Updated ' + timeAgo(lead.quotes_updated_at) : 'No quotes yet'}</span>
              <button class="notes-save-btn" onclick="saveQuotes('${lead.id}', this.closest('.col-quotes').querySelector('.quotes-textarea').value)">Save</button>
            </div>
          </div>

          <div class="col-actions">
            <button class="btn-call" onclick="event.stopPropagation();openSMSModal('${lead.id}','${safeName}')">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#0b0f12" stroke-width="1.5"><path d="M14 3a1 1 0 00-1-1H3a1 1 0 00-1 1v7a1 1 0 001 1h3l2 2 2-2h3a1 1 0 001-1V3z"/><path d="M5 6h6M5 9h4"/></svg>
              Send Text
            </button>
            <button class="btn-disposition" onclick="event.stopPropagation();openDispositionModal('${lead.id}','${safeName}')">Disposition</button>
            <div class="action-tags">
              ${leadDispTags.map(t => `<span class="action-tag" style="background:${t.color}18;border-color:${t.color}30;color:${t.color}">${t.name}</span>`).join('')}
              ${campProgress ? `<span class="action-tag teal">${hasActiveCampaign ? (lead.campaign_day != null ? `⚡ Day ${lead.campaign_day}` : '⚡ Active') : '✓ Done'}</span>` : ''}
              ${lead.product ? `<span class="action-tag" onclick="editLeadProduct('${lead.id}', this)" style="cursor:pointer;">${lead.product}</span>` : ''}
            </div>
            <div class="ap-toggle">
              <div class="ap-track ${lead.autopilot ? 'on' : ''}" onclick="toggleAutopilot('${lead.id}', ${!lead.autopilot})">
                <div class="ap-thumb"></div>
              </div>
              <span class="ap-label ${lead.autopilot ? 'on' : ''}">Autopilot ${lead.autopilot ? 'ON' : 'OFF'}</span>
            </div>
          </div>

          <div class="col-meta">
            <div class="meta-sms-line">Last contact: <strong>${lead.last_contacted_at ? new Date(lead.last_contacted_at).toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'}) : '—'}</strong></div>
            <div class="divider"></div>
            <div class="meta-row"><span class="meta-key">Added</span><span class="meta-val">${lead.created_at ? new Date(lead.created_at).toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'}) : '—'}</span></div>
            <div class="meta-row"><span class="meta-key">State</span><span class="meta-val">${lead.state || '—'}</span></div>
            <div class="meta-row"><span class="meta-key">Zip</span><span class="meta-val">${lead.zip_code || '—'}</span></div>
            <div class="meta-row"><span class="meta-key">DOB</span><span class="meta-val">${lead.date_of_birth || '—'}</span></div>
            <div class="divider"></div>
            <div class="meta-bucket-row">
              <span class="meta-bucket-dot" style="background:${bucket ? bucket.color : '#00c9a7'}"></span>
              <span class="meta-bucket-name">${bucket ? bucket.name : '—'}</span>
            </div>
            <div style="margin-top:6px;">
              <button class="lead-3dot-btn" onclick="event.stopPropagation();openLeadActionsMenu('${lead.id}','${safeName}',this)" title="More actions" style="color:rgba(255,255,255,0.3);font-size:14px;">⋯ More</button>
            </div>
          </div>

        </div>
      </div>
    `
  }).join('')
}

// ===== STATS =====
let _statsCache = null
let _statsCacheAt = 0
const STATS_CACHE_TTL = 60000
const CACHE_TTL = 5 * 60 * 1000
let _bucketsCache = null, _bucketsCacheAt = 0
let _campaignsCache = null, _campaignsCacheAt = 0
let _dispositionsCache = null, _dispositionsCacheAt = 0
let _templatesCache = null, _templatesCacheAt = 0

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

// ===== AUX DATA LOADERS WITH CACHE =====
const loadBuckets = async () => {
  const now = Date.now()
  if (_bucketsCache && now - _bucketsCacheAt < CACHE_TTL) { allBuckets = _bucketsCache; return }
  try {
    const res = await fetch('/buckets')
    const data = await res.json()
    allBuckets = data.buckets || []
    _bucketsCache = allBuckets
    _bucketsCacheAt = Date.now()
  } catch (err) { console.error(err) }
}

const loadCampaigns = async () => {
  const now = Date.now()
  if (_campaignsCache && now - _campaignsCacheAt < CACHE_TTL) { allCampaigns = _campaignsCache; return }
  try {
    const res = await fetch('/campaigns')
    const data = await res.json()
    allCampaigns = data.campaigns || []
    _campaignsCache = allCampaigns
    _campaignsCacheAt = Date.now()
  } catch (err) { console.error(err) }
}

// ===== LOAD LEADS =====
let leadsLoaded = false
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
    const [leadsRes] = await Promise.all([
      fetch(`/leads?page=1&limit=${LEADS_PER_PAGE}`),
      loadBuckets()
    ])
    const leadsData = await leadsRes.json()
    if (leadsData.leads) {
      allLeads = leadsData.leads
      totalLeads = leadsData.total || leadsData.leads.length
      hasMoreLeads = allLeads.length < totalLeads
      updateCampaignFilter()
    }
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
    leadsLoaded = true
  }
}

const loadMoreLeads = async () => {
  if (isLoadingLeads || !hasMoreLeads) return
  isLoadingLeads = true
  let spinner = document.getElementById('scroll-spinner')
  if (!spinner) {
    spinner = document.createElement('div')
    spinner.id = 'scroll-spinner'
    spinner.style.cssText = 'text-align:center;padding:20px;color:#9ca3af;font-size:13px;'
    spinner.textContent = 'Loading...'
    document.getElementById('leads-grid')?.after(spinner)
  }
  spinner.style.display = 'block'
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
    const sp = document.getElementById('scroll-spinner')
    if (sp) sp.style.display = 'none'
  }
}

const renderLoadMoreButton = () => {
  // Button hidden — infinite scroll handles loading
  const wrapper = document.getElementById('load-more-wrapper')
  if (wrapper) wrapper.style.display = 'none'
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
    bucketEl.innerHTML = '<option value="">All buckets</option>' + allBuckets.filter(b => !b.is_folder).map(b => `<option value="${b.id}">${b.name}</option>`).join('')
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
  if (n > 0) { bar.classList.add('visible'); if (count) count.textContent = `${n} lead${n !== 1 ? 's' : ''} selected` }
  else { bar.classList.remove('visible'); closeBulkDropdowns() }
  updateFab()
}

function toggleFabMenu(e) {
  if (e) e.stopPropagation()
  const m = document.getElementById('fab-menu')
  if (m) m.style.display = m.style.display === 'none' ? 'block' : 'none'
}

function closeFabMenu() {
  const m = document.getElementById('fab-menu')
  if (m) m.style.display = 'none'
}

function updateFab() {
  const wrap = document.getElementById('fab-wrap')
  const count = document.getElementById('fab-count')
  if (!wrap || !count) return
  const n = selectedLeads.size
  count.textContent = n
  wrap.style.display = n > 0 ? 'block' : 'none'
  if (n === 0) closeFabMenu()
}

document.addEventListener('click', e => {
  const wrap = document.getElementById('fab-wrap')
  if (wrap && !wrap.contains(e.target)) closeFabMenu()
})

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
    const bucketPills = allBuckets.filter(b => !b.is_folder).map(b => `<button class="bulk-dd-pill" style="background:${b.color};" onclick="confirmBulkBucket('${b.id}','${b.name.replace(/'/g, "\\'")}')" >📁 ${b.name}</button>`).join('')
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
    const soldBucket = allBuckets.find(b => b.system_key === 'sold')
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
  } catch (err) {
    console.error(err)
    if (lead) lead.autopilot = !value
    if (label) { label.textContent = !value ? 'Autopilot ON' : 'Autopilot'; label.className = `autopilot-label ${!value ? 'on' : ''}` }
    updateStats(allLeads)
    toast.error('Error', 'Could not update autopilot')
  }
}

const saveNotes = async (leadId, notes) => {
  try { await fetch(`/leads/${leadId}/notes`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes }) }) } catch (err) { console.error(err) }
}

const saveQuotes = async (leadId, quotes) => {
  try { await fetch(`/leads/${leadId}/quotes`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quotes }) }) } catch (err) { console.error(err) }
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
  const now = Date.now()
  if (_dispositionsCache && now - _dispositionsCacheAt < CACHE_TTL) { allDispositionTags = _dispositionsCache; return }
  try {
    const res = await fetch('/dispositions')
    const data = await res.json()
    allDispositionTags = data.tags || []
    _dispositionsCache = allDispositionTags
    _dispositionsCacheAt = Date.now()
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

const BUCKET_PALETTE = ['#6366f1','#3b82f6','#0ea5e9','#8b5cf6','#f59e0b','#10b981','#22c55e','#ef4444','#f97316','#ec4899']

const onImportCampaignChange = () => {
  const select = document.getElementById('import-campaign')
  const notice = document.getElementById('campaign-send-time-notice')
  if (!notice) return
  const campaign = allCampaigns.find(c => c.id === select.value)
  if (campaign?.initial_send_time) {
    const [h, m] = campaign.initial_send_time.split(':').map(Number)
    const ampm = h >= 12 ? 'PM' : 'AM'
    const hour = h % 12 || 12
    const timeLabel = `${hour}:${String(m).padStart(2, '0')} ${ampm}`
    notice.textContent = `ℹ️ Initial messages will send tomorrow at ${timeLabel} local to each lead's timezone.`
    notice.style.display = 'block'
  } else {
    notice.style.display = 'none'
  }
}

const onBucketSelectChange = (sel) => {
  const form = document.getElementById('new-bucket-form')
  if (!form) return
  form.style.display = sel.value === '__new__' ? '' : 'none'
}

const selectNewBucketColor = (color, el) => {
  document.getElementById('new-bucket-color').value = color
  document.querySelectorAll('#new-bucket-colors span').forEach(s => s.style.borderColor = 'transparent')
  el.style.borderColor = '#000'
}

const openUploadModal = () => {
  // Cancel any in-flight import timeout from a previous open
  if (importTimeoutHandle) { clearTimeout(importTimeoutHandle); importTimeoutHandle = null }
  importFile = null; importHeaders = []; importPreview = []
  document.getElementById('modal-file-name').textContent = ''
  const bucketSelect = document.getElementById('import-bucket-id')
  if (bucketSelect) {
    const folders = allBuckets.filter(b => b.is_folder && !b.parent_id)
    const subFolders = allBuckets.filter(b => b.is_folder && b.parent_id)
    const topBuckets = allBuckets.filter(b => !b.is_folder && !b.parent_id)
    const buildOptions = (buckets, prefix = '') => buckets.map(b => `<option value="${b.id}">${prefix}${b.name}</option>`).join('')
    let opts = '<option value="">No bucket</option>'
    for (const folder of folders) {
      opts += `<option disabled style="font-weight:700;color:#6b7280;">📂 ${folder.name}</option>`
      const subs = subFolders.filter(s => s.parent_id === folder.id)
      for (const sub of subs) {
        opts += `<option disabled style="font-weight:600;color:#6b7280;padding-left:12px;">  └ ${sub.name}</option>`
        const children = allBuckets.filter(b => !b.is_folder && b.parent_id === sub.id)
        opts += buildOptions(children, '      · ')
      }
      const directChildren = allBuckets.filter(b => !b.is_folder && b.parent_id === folder.id)
      opts += buildOptions(directChildren, '   · ')
    }
    opts += buildOptions(topBuckets)
    opts += '<option value="__new__">+ Create new bucket...</option>'
    bucketSelect.innerHTML = opts
    // Hide new-bucket-form in case it was open
    const newForm = document.getElementById('new-bucket-form')
    if (newForm) newForm.style.display = 'none'
    // Populate color swatches
    const colorContainer = document.getElementById('new-bucket-colors')
    const colorInput = document.getElementById('new-bucket-color')
    if (colorContainer && colorInput) {
      colorInput.value = '#6366f1'
      colorContainer.innerHTML = BUCKET_PALETTE.map(c => `<span onclick="selectNewBucketColor('${c}',this)" style="display:inline-block;width:20px;height:20px;border-radius:50%;background:${c};cursor:pointer;border:2px solid ${c === '#6366f1' ? '#000' : 'transparent'};"></span>`).join('')
    }
    // Populate parent folder select (depth-0 folders only)
    const parentSelect = document.getElementById('new-bucket-parent')
    if (parentSelect) {
      parentSelect.innerHTML = '<option value="">No folder</option>' + folders.map(f => `<option value="${f.id}">${f.name}</option>`).join('')
    }
    // Default name = today's date
    const nameInput = document.getElementById('new-bucket-name')
    if (nameInput) nameInput.value = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }
  document.getElementById('import-autopilot').checked = false
  document.getElementById('step1-status-bar').className = 'status-bar'
  document.getElementById('step1-status-bar').textContent = ''
  document.getElementById('import-status-bar').className = 'status-bar'
  document.getElementById('import-status-bar').textContent = ''
  document.getElementById('risk-status-bar').className = 'status-bar'
  document.getElementById('risk-status-bar').textContent = ''
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
  let bucketId = document.getElementById('import-bucket-id')?.value || ''

  // Create new bucket inline if selected
  if (bucketId === '__new__') {
    const name = document.getElementById('new-bucket-name')?.value.trim()
    const color = document.getElementById('new-bucket-color')?.value || '#6366f1'
    const parentId = document.getElementById('new-bucket-parent')?.value || null
    if (!name) return showImportStatus('Please enter a name for the new bucket', 'error')
    const riskStatusEl = document.getElementById('risk-status-bar')
    riskStatusEl.className = 'status-bar loading'
    riskStatusEl.textContent = 'Creating bucket...'
    try {
      const bRes = await fetch('/buckets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, color, parent_id: parentId || null }) })
      const bData = await bRes.json()
      if (!bRes.ok) return showImportStatus(bData.error || 'Failed to create bucket', 'error')
      bucketId = bData.bucket.id
      allBuckets.push(bData.bucket)
      _bucketsCache = null
    } catch (e) {
      return showImportStatus('Failed to create bucket: ' + e.message, 'error')
    }
  }

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
  riskStatusEl.textContent = '⏳ Uploading file...'
  const importAllBtn = document.getElementById('import-all-btn')
  const importGreenBtn = document.getElementById('import-green-btn')

  // Save button labels so they can be reconstructed after import (the spans live inside the buttons)
  const allCount = document.getElementById('import-all-count')?.textContent || '0'
  const greenCount = document.getElementById('import-green-count')?.textContent || '0'
  if (importAllBtn) { importAllBtn.disabled = true; importAllBtn.textContent = 'Importing...' }
  if (importGreenBtn) { importGreenBtn.disabled = true; importGreenBtn.textContent = 'Importing...' }

  // 30-second timeout fallback — re-enables UI if server never responds
  let timedOut = false
  clearTimeout(importTimeoutHandle)
  importTimeoutHandle = setTimeout(() => {
    timedOut = true
    riskStatusEl.className = 'status-bar error'
    riskStatusEl.textContent = '❌ Import timed out — please try again'
    if (importAllBtn) { importAllBtn.disabled = false; importAllBtn.innerHTML = `Import All Valid (<span id="import-all-count">${allCount}</span>)` }
    if (importGreenBtn) { importGreenBtn.disabled = false; importGreenBtn.innerHTML = `Import Clean Only (<span id="import-green-count">${greenCount}</span>)` }
  }, 30000)

  let importSucceeded = false
  try {
    const res = await fetch('/leads/upload', { method: 'POST', body: formData })
    clearTimeout(importTimeoutHandle)
    importTimeoutHandle = null
    if (timedOut) return
    const data = await res.json()
    if (data.success) {
      importSucceeded = true
      const importedCount = data.imported ?? 0
      const skipped = (data.skipped_duplicates ?? 0) + (data.skipped_invalid_phone ?? 0)
      riskStatusEl.className = 'status-bar success'
      riskStatusEl.textContent = `✅ Import complete — ${importedCount} lead${importedCount !== 1 ? 's' : ''} imported${skipped > 0 ? `, ${skipped} skipped` : ''}`

      lastSkippedRows = data.skipped_rows || []
      document.getElementById('res-imported').textContent = importedCount
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

      toast.success('Import complete', `${importedCount} lead${importedCount !== 1 ? 's' : ''} imported${skipped > 0 ? `, ${skipped} skipped` : ''}`)
      // Auto-close after 2 seconds then show results summary
      setTimeout(() => {
        closeUploadModal()
        document.getElementById('import-results-modal').classList.add('open')
      }, 2000)
    } else {
      riskStatusEl.className = 'status-bar error'
      riskStatusEl.textContent = `❌ Import failed: ${data.error || 'Unknown error'}`
    }
  } catch (err) {
    clearTimeout(importTimeoutHandle)
    importTimeoutHandle = null
    riskStatusEl.className = 'status-bar error'
    riskStatusEl.textContent = `❌ Import failed: ${err.message || 'Something went wrong'}`
  } finally {
    // On success the modal closes in 2s — leave buttons as-is. On failure/timeout restore them.
    if (!importSucceeded && !timedOut) {
      if (importAllBtn) { importAllBtn.disabled = false; importAllBtn.innerHTML = `Import All Valid (<span id="import-all-count">${allCount}</span>)` }
      if (importGreenBtn) { importGreenBtn.disabled = false; importGreenBtn.innerHTML = `Import Clean Only (<span id="import-green-count">${greenCount}</span>)` }
    }
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

const openEnrollModalForLead = (leadId) => { selectedLeads.clear(); selectedLeads.add(leadId); updateFab(); openEnrollModal() }

// ===== BUCKET CRUD =====
const openNewBucketModal = (id, name, color) => {
  editingBucketId = id || null
  window._creatingFolder = false
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
      const isFolder = !!window._creatingFolder
      const res = await fetch('/buckets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, color, is_folder: isFolder, parent_id: null }) })
      const data = await res.json()
      if (!data.success) throw new Error(data.error)
      allBuckets.push(data.bucket)
      window._creatingFolder = false
      toast.success(isFolder ? 'Folder created' : 'Bucket created', name)
    }
    renderBucketPills()
    updateCampaignFilter()
    closeNewBucketModal()
  } catch (err) { toast.error('Error', err.message) }
  finally { btn.disabled = false }
}

const showBucketContextMenu = (x, y, id, name, isFolder) => {
  const bucket = allBuckets.find(b => b.id === id)
  if (bucket?.is_system) return
  contextMenuBucketId = id
  contextMenuBucketName = name
  contextMenuBucketColor = bucket?.color || ''
  contextMenuBucketIsFolder = !!isFolder

  const childCount = isFolder ? allBuckets.filter(b => b.parent_id === id).length : 0
  const archiveBtn = document.getElementById('ctx-archive-btn')
  if (archiveBtn) {
    archiveBtn.textContent = isFolder
      ? `📦 Archive folder (${childCount} bucket${childCount !== 1 ? 's' : ''})`
      : '📦 Archive'
  }
  const runCampaignBtn = document.getElementById('ctx-run-campaign-btn')
  if (runCampaignBtn) runCampaignBtn.style.display = isFolder ? 'none' : 'block'

  const menu = document.getElementById('bucket-context-menu')
  // Ensure menu is a direct body child so position:fixed is never clipped
  if (menu.parentNode !== document.body) document.body.appendChild(menu)

  // Position — nudge inside viewport if needed
  menu.style.left = '0'
  menu.style.top = '0'
  menu.style.display = 'block'
  const mw = menu.offsetWidth || 180
  const mh = menu.offsetHeight || 140
  const left = x + mw > window.innerWidth ? window.innerWidth - mw - 6 : x
  const top = y + mh > window.innerHeight ? window.innerHeight - mh - 6 : y
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
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

const archiveBucketFromMenu = async () => {
  document.getElementById('bucket-context-menu').style.display = 'none'
  const msg = contextMenuBucketIsFolder
    ? `Archive folder "${contextMenuBucketName}"? All buckets inside will also be archived. Leads will be hidden from the main view.`
    : `Archive "${contextMenuBucketName}"? Leads will be hidden from the main view.`
  if (!confirm(msg)) return
  try {
    const res = await fetch(`/buckets/${contextMenuBucketId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'archive' })
    })
    const data = await res.json()
    if (!data.success) throw new Error(data.error)
    // Remove archived bucket (and children if folder) from allBuckets
    const archivedIds = new Set([contextMenuBucketId])
    if (contextMenuBucketIsFolder) {
      allBuckets.forEach(b => { if (b.parent_id === contextMenuBucketId) archivedIds.add(b.id) })
    }
    allBuckets = allBuckets.filter(b => !archivedIds.has(b.id))
    allLeads = allLeads.filter(l => !archivedIds.has(l.bucket_id))
    if (archivedIds.has(activeBucket)) { activeBucket = ''; activeFolderId = '' }
    renderBucketPills()
    updateCampaignFilter()
    filterLeads()
    toast.success('Archived', `"${contextMenuBucketName}" moved to archive`)
  } catch (err) { toast.error('Error', err.message) }
}

// ── Run Campaign from bucket context menu ────────────────────────────────────

const openRunCampaignModal = async () => {
  document.getElementById('bucket-context-menu').style.display = 'none'
  const bucket = allBuckets.find(b => b.id === contextMenuBucketId)
  if (!bucket || bucket.is_folder) return

  document.getElementById('run-campaign-modal-title').textContent = `Assign Campaign to "${contextMenuBucketName}"`
  document.getElementById('run-campaign-lead-count').textContent = `${bucket.lead_count || 0} lead${bucket.lead_count !== 1 ? 's' : ''} in this bucket (opted-out excluded automatically)`
  document.getElementById('run-campaign-notice').style.display = 'none'
  document.getElementById('run-campaign-confirm-btn').disabled = true

  await loadCampaigns()
  const campaigns = allCampaigns.filter(c => c.status !== 'deleted')
  const sel = document.getElementById('run-campaign-select')
  sel.innerHTML = '<option value="">Select a campaign…</option>' +
    campaigns.map(c => `<option value="${c.id}" data-time="${c.initial_send_time || ''}">${c.name}</option>`).join('')

  document.getElementById('run-campaign-modal').classList.add('open')
}

const closeRunCampaignModal = () => {
  document.getElementById('run-campaign-modal').classList.remove('open')
}

const onRunCampaignChange = () => {
  const sel = document.getElementById('run-campaign-select')
  const opt = sel.options[sel.selectedIndex]
  const sendTime = opt?.dataset?.time || ''
  const notice = document.getElementById('run-campaign-notice')
  const btn = document.getElementById('run-campaign-confirm-btn')
  btn.disabled = !sel.value
  if (sel.value && sendTime) {
    notice.style.display = 'block'
    notice.textContent = `⏰ Initial messages will send tomorrow at ${sendTime} local to each lead's timezone`
  } else if (sel.value) {
    notice.style.display = 'block'
    notice.textContent = 'Messages will send immediately on confirm'
  } else {
    notice.style.display = 'none'
  }
}

const confirmRunCampaign = async () => {
  const campaignId = document.getElementById('run-campaign-select').value
  if (!campaignId || !contextMenuBucketId) return
  const btn = document.getElementById('run-campaign-confirm-btn')
  btn.disabled = true
  btn.textContent = 'Assigning…'
  try {
    const res = await fetch(`/campaigns/${campaignId}/enroll-bucket/${contextMenuBucketId}`, { method: 'POST' })
    const data = await res.json()
    if (!data.success) throw new Error(data.error)
    closeRunCampaignModal()
    toast.success('Campaign assigned', `${data.count} lead${data.count !== 1 ? 's' : ''} enrolled`)
  } catch (err) {
    toast.error('Error', err.message)
  } finally {
    btn.disabled = false
    btn.textContent = 'Assign Campaign'
  }
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
  const now = Date.now()
  if (_templatesCache && now - _templatesCacheAt < CACHE_TTL) { allTemplates = _templatesCache; return }
  try {
    const res = await fetch('/templates')
    const data = await res.json()
    allTemplates = data.templates || []
    _templatesCache = allTemplates
    _templatesCacheAt = Date.now()
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
  if (tab === 'sms') loadDetailSMS(detailLeadId)
}

const loadDetailSMS = async (leadId) => {
  if (!leadId) return
  const list = document.getElementById('detail-sms-list')
  if (!list) return

  list.innerHTML = '<div style="padding:20px;text-align:center;color:#9ca3af;font-size:13px;">Loading...</div>'

  try {
    const res = await fetch('/messages?lead_id=' + leadId + '&limit=100')
    const data = await res.json()
    const messages = data.messages || []

    if (messages.length === 0) {
      list.innerHTML = '<div style="padding:20px;text-align:center;color:#9ca3af;font-size:13px;">No messages yet</div>'
      return
    }

    list.innerHTML = messages.map(m => {
      const isOut = m.direction === 'outbound'
      const time = new Date(m.sent_at).toLocaleString('en-US', {
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true
      })
      return '<div style="display:flex;justify-content:' + (isOut ? 'flex-end' : 'flex-start') + ';margin-bottom:8px;padding:0 4px;">' +
        '<div style="max-width:80%;background:' + (isOut ? '#6366f1' : 'var(--gray-100,#f3f4f6)') + ';color:' + (isOut ? 'white' : 'var(--color-text-primary,#374151)') + ';padding:8px 12px;border-radius:' + (isOut ? '12px 12px 2px 12px' : '12px 12px 12px 2px') + ';font-size:13px;line-height:1.5;">' +
        m.body +
        '<div style="font-size:10px;opacity:0.65;margin-top:3px;text-align:right;">' + time + (m.is_ai ? ' · AI' : '') + '</div>' +
        '</div></div>'
    }).join('')

    list.scrollTop = list.scrollHeight
  } catch (err) {
    console.error('loadDetailSMS:', err)
    list.innerHTML = '<div style="padding:20px;text-align:center;color:#ef4444;font-size:13px;">Failed to load messages</div>'
  }
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
      <div id="ami-bucket-sub" style="display:none;background:#131a1f;border-top:1px solid rgba(255,255,255,0.06);padding:4px 0;">
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

let _optOutLeadId = null
let _optOutLeadName = null
let _undoOptOutLeadId = null
let _undoOptOutLeadName = null

const confirmOptOutLead = (leadId, name) => {
  console.log('[optOut] confirmOptOutLead called — leadId:', leadId, 'name:', name)
  _optOutLeadId = leadId
  _optOutLeadName = name
  document.getElementById('opt-out-modal-title').textContent = `Opt Out ${name}?`
  document.getElementById('opt-out-modal-body').textContent = `This will cancel all scheduled messages, pause all campaign drips, and prevent any future texts to ${name}. This can be undone.`
  const btn = document.getElementById('opt-out-confirm-btn')
  btn.disabled = false
  btn.textContent = 'Opt Out'
  document.getElementById('opt-out-modal').classList.add('open')
}

const closeOptOutModal = () => {
  document.getElementById('opt-out-modal').classList.remove('open')
  _optOutLeadId = null
  _optOutLeadName = null
}

const executeOptOut = async () => {
  const leadId = _optOutLeadId
  const name = _optOutLeadName
  if (!leadId) return
  const btn = document.getElementById('opt-out-confirm-btn')
  btn.disabled = true
  btn.textContent = 'Opting out...'
  try {
    const res = await fetch(`/leads/${leadId}/opt-out`, { method: 'POST' })
    const data = await res.json()
    if (data.success) {
      closeOptOutModal()
      const lead = allLeads.find(l => l.id === leadId)
      if (lead) Object.assign(lead, data.lead)
      filterLeads()
      toast.success('Lead opted out', name + ' will no longer receive texts')
    } else {
      btn.disabled = false
      btn.textContent = 'Opt Out'
      toast.error('Error', data.error || 'Could not opt out lead')
    }
  } catch (err) {
    btn.disabled = false
    btn.textContent = 'Opt Out'
    toast.error('Error', 'Something went wrong')
  }
}

const undoOptOutAction = (leadId, name) => {
  console.log('[optOut] undoOptOutAction called — leadId:', leadId, 'name:', name)
  _undoOptOutLeadId = leadId
  _undoOptOutLeadName = name
  document.getElementById('undo-opt-out-modal-title').textContent = `Remove Opt-Out for ${name}?`
  document.getElementById('undo-opt-out-modal-body').textContent = `${name} will be able to receive texts again. Any paused campaigns will need to be manually resumed.`
  const btn = document.getElementById('undo-opt-out-confirm-btn')
  btn.disabled = false
  btn.textContent = 'Remove Opt-Out'
  document.getElementById('undo-opt-out-modal').classList.add('open')
}

const closeUndoOptOutModal = () => {
  document.getElementById('undo-opt-out-modal').classList.remove('open')
  _undoOptOutLeadId = null
  _undoOptOutLeadName = null
}

const executeUndoOptOut = async () => {
  const leadId = _undoOptOutLeadId
  const name = _undoOptOutLeadName
  if (!leadId) return
  const btn = document.getElementById('undo-opt-out-confirm-btn')
  btn.disabled = true
  btn.textContent = 'Removing...'
  try {
    const res = await fetch(`/leads/${leadId}/undo-opt-out`, { method: 'POST' })
    const data = await res.json()
    if (data.success) {
      closeUndoOptOutModal()
      const lead = allLeads.find(l => l.id === leadId)
      if (lead) Object.assign(lead, data.lead)
      filterLeads()
      toast.success('Opt-out removed', name + ' can now receive texts')
    } else {
      btn.disabled = false
      btn.textContent = 'Remove Opt-Out'
      toast.error('Error', data.error || 'Could not remove opt-out')
    }
  } catch (err) {
    btn.disabled = false
    btn.textContent = 'Remove Opt-Out'
    toast.error('Error', 'Something went wrong')
  }
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

  // Apply URL params before loadLeads so filterLeads picks them up
  const params = new URLSearchParams(window.location.search)
  const bucketIdParam = params.get('bucket_id')
  const stateParam = params.get('state')
  if (bucketIdParam) activeBucket = bucketIdParam
  if (stateParam) { const el = document.getElementById('sf-state'); if (el) el.value = stateParam }

  // Phase 1: show leads immediately (leads+buckets fetched in parallel inside loadLeads)
  loadLeads()

  // Phase 2: load aux data in background, re-render cards when ready
  Promise.all([loadCampaigns(), loadDispositionTags(), loadTemplates(), loadProfile()]).then(() => {
    updateCampaignFilter()
    if (!isLoadingLeads) filterLeads()
  })

  // Load conversation maps for lead card badges (fire-and-forget)
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

  // Debounced server-side search
  const searchInput = document.getElementById('sf-search')
  if (searchInput) {
    searchInput.addEventListener('input', function () {
      clearTimeout(searchDebounceTimer)
      const q = this.value.trim()
      if (q.length === 0) {
        isSearchActive = false
        currentLeadsPage = 1
        allLeads = []
        loadMoreLeads()
        return
      }
      if (q.length < 2) return
      searchDebounceTimer = setTimeout(() => serverSearchLeads(q), 400)
    })
  }

  loadCalBadge()
  loadNotifBadge()
  setInterval(loadNotifBadge, 30000)
}

function toggleNewBucketDropdown(e) {
  e.stopPropagation()
  const dd = document.getElementById('new-bucket-dropdown')
  if (!dd) return
  dd.style.display = dd.style.display === 'none' ? 'block' : 'none'
}

function closeNewBucketDropdown() {
  const dd = document.getElementById('new-bucket-dropdown')
  if (dd) dd.style.display = 'none'
}

document.addEventListener('click', (e) => {
  const wrap = document.getElementById('new-bucket-dropdown-wrap')
  if (wrap && !wrap.contains(e.target)) closeNewBucketDropdown()
})

function openNewFolderModal() {
  window._creatingFolder = true
  const titleEl = document.getElementById('new-bucket-modal-title')
  const nameEl = document.getElementById('new-bucket-name')
  const saveBtn = document.getElementById('save-bucket-btn')
  if (titleEl) titleEl.textContent = 'New Folder'
  if (nameEl) nameEl.value = ''
  if (saveBtn) saveBtn.textContent = 'Create Folder'
  const swatchContainer = document.getElementById('bucket-color-swatches')
  if (swatchContainer) {
    swatchContainer.innerHTML = BUCKET_COLORS.map(c =>
      `<div class="color-swatch${c === '#6366f1' ? ' selected' : ''}" style="background:${c};" data-color="${c}" onclick="selectBucketColor('${c}')"></div>`
    ).join('')
  }
  document.getElementById('new-bucket-modal')?.classList.add('open')
  setTimeout(() => document.getElementById('new-bucket-name')?.focus(), 50)
}

function debounceScroll(fn, delay) {
  let timer
  return function (...args) {
    clearTimeout(timer)
    timer = setTimeout(() => fn.apply(this, args), delay)
  }
}

window.addEventListener('scroll', debounceScroll(() => {
  if (isLoadingLeads || !hasMoreLeads) return
  if (isSearchActive || activeBucket || activeFolderId) return
  const scrollTop = window.scrollY || document.documentElement.scrollTop
  const windowHeight = window.innerHeight
  const docHeight = document.documentElement.scrollHeight
  if (docHeight - scrollTop - windowHeight < 400) {
    loadMoreLeads()
  }
}, 150))

document.addEventListener('DOMContentLoaded', init)

document.addEventListener('click', function(e) {
  const btn = e.target.closest('.copy-btn')
  if (!btn) return
  const text = btn.dataset.copy
  if (!text) return
  navigator.clipboard.writeText(text).then(() => {
    btn.classList.add('copied')
    setTimeout(() => btn.classList.remove('copied'), 1500)
  })
})
