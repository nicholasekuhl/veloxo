// shared.js — shared utilities loaded on every page

// ─── THEME PERSISTENCE (runs before render to prevent flash) ─────────────────
;(function() {
  const saved = localStorage.getItem('theme')
  if (saved) document.documentElement.setAttribute('data-theme', saved)
})()

function toggleTheme() {
  const html = document.documentElement
  const current = html.getAttribute('data-theme')
  const next = current === 'light' ? 'dark' : 'light'
  if (next === 'dark') {
    html.removeAttribute('data-theme')
    localStorage.setItem('theme', 'dark')
  } else {
    html.setAttribute('data-theme', 'light')
    localStorage.setItem('theme', 'light')
  }
}

let currentUser = null

// ─── GLOBAL ERROR BOUNDARY ───────────────────────────────────────────────────

window.addEventListener('unhandledrejection', event => {
  console.error('Unhandled promise rejection:', event.reason)
})

/**
 * Show a friendly error state inside a container element.
 * @param {string} containerId  - ID of the element to render the error into
 * @param {string} sectionName  - Human-readable name shown in the error message
 * @param {Function} retryFn    - Called when the user clicks Retry
 * @param {string} [message]    - Optional custom error message
 */
const showPageError = (containerId, sectionName, retryFn, message) => {
  const el = document.getElementById(containerId)
  if (!el) return
  el.innerHTML = `
    <div style="text-align:center;padding:48px 24px;color:var(--color-text-secondary);">
      <div style="font-size:32px;margin-bottom:12px;">⚠️</div>
      <div style="font-size:15px;font-weight:600;color:var(--gray-700);margin-bottom:6px;">Could not load ${sectionName}</div>
      <div style="font-size:13px;margin-bottom:20px;">${message || 'An error occurred. Check your connection and try again.'}</div>
      <button class="btn btn-secondary" onclick="(${retryFn.toString()})()">Retry</button>
    </div>
  `
}

// ─── AUTH ───────────────────────────────────────────────────────────────────

const checkAuth = async () => {
  try {
    const res = await fetch('/auth/me')
    if (res.status === 401) { window.location.href = '/login.html'; return false }
    if (res.status === 403) {
      const data = await res.json()
      if (data.error === 'tos_required') { window.location.href = '/tos-required.html'; return false }
      if (data.error === 'suspended') { window.location.href = '/suspended.html'; return false }
      window.location.href = '/login.html'
      return false
    }
    return true
  } catch {
    window.location.href = '/login.html'
    return false
  }
}

const logout = async () => {
  await fetch('/auth/logout', { method: 'POST' })
  window.location.href = '/login.html'
}

// ─── PROFILE COMPLETION CHECK ─────────────────────────────────────────────────

const checkProfileComplete = (profile) => {
  const exempt = ['/onboarding.html', '/login.html', '/invite.html']
  if (exempt.some(p => window.location.pathname.includes(p))) return
  if (!profile.profile_complete) {
    window.location.href = '/onboarding.html'
  }
}

// ─── PROFILE ─────────────────────────────────────────────────────────────────

const loadProfile = async () => {
  try {
    const res = await fetch('/auth/me')
    if (!res.ok) return
    const data = await res.json()
    const p = data.user
    currentUser = p
    checkProfileComplete(p)
    const displayName = p.agent_name || p.email || ''
    const headerName = document.getElementById('header-agent-name')
    if (headerName) headerName.textContent = displayName
    const headerAgency = document.getElementById('header-agency-name')
    if (headerAgency) headerAgency.textContent = p.agency_name || ''
    const userAvatarEl = document.getElementById('user-avatar-initials')
    if (userAvatarEl) userAvatarEl.textContent = getInitials(p.agent_name?.split(' ')[0], p.agent_name?.split(' ')[1])
    const ddName = document.getElementById('profile-dropdown-name')
    if (ddName) ddName.textContent = displayName
    const ddEmail = document.getElementById('profile-dropdown-email')
    if (ddEmail) ddEmail.textContent = p.email || ''
    const drawerName = document.getElementById('drawer-agent-name')
    if (drawerName) drawerName.textContent = displayName
    if (p.is_admin) {
      const adminLink = document.getElementById('admin-nav-link')
      if (adminLink) adminLink.style.display = 'inline-flex'
      const adminDrawerBtn = document.getElementById('drawer-btn-admin')
      if (adminDrawerBtn) adminDrawerBtn.style.display = 'flex'
      const profileAdminLink = document.getElementById('profile-admin-link')
      if (profileAdminLink) profileAdminLink.style.display = 'flex'
    }
    // Settings-page-only fields
    const agentNameEl = document.getElementById('profile-agent-name')
    if (agentNameEl) agentNameEl.value = p.agent_name || ''
    const agencyNameEl = document.getElementById('profile-agency-name')
    if (agencyNameEl) agencyNameEl.value = p.agency_name || ''
    const nicknameEl = document.getElementById('profile-agent-nickname')
    if (nicknameEl) nicknameEl.value = p.agent_nickname || ''
    const calendlyEl = document.getElementById('profile-calendly-url')
    if (calendlyEl) calendlyEl.value = p.calendly_url || ''
    const tzEl = document.getElementById('profile-timezone')
    if (tzEl) tzEl.value = p.timezone || 'America/New_York'
    const emailEl = document.getElementById('profile-email')
    if (emailEl) emailEl.value = p.email || ''
    const complianceEnabled = document.getElementById('compliance-enabled')
    if (complianceEnabled) {
      complianceEnabled.checked = p.compliance_footer_enabled !== false
      const complianceFooter = document.getElementById('compliance-footer')
      if (complianceFooter) complianceFooter.value = p.compliance_footer || ''
      if (typeof updateCompliancePreview === 'function') updateCompliancePreview()
      const note = document.getElementById('campaign-footer-note')
      if (note) note.style.display = (p.compliance_footer_enabled !== false) ? 'block' : 'none'
    }
    const personalPhone = document.getElementById('profile-personal-phone')
    if (personalPhone) personalPhone.value = p.personal_phone || ''
    const smsNotif = document.getElementById('sms-notif-enabled')
    if (smsNotif) smsNotif.checked = p.sms_notifications_enabled !== false
    const inappNotif = document.getElementById('inapp-notif-enabled')
    if (inappNotif) inappNotif.checked = p.inapp_notifications_enabled !== false
    const apptNotif = document.getElementById('appt-notif-enabled')
    if (apptNotif) apptNotif.checked = p.notify_appointment_sms !== false
    const afterHours = document.getElementById('ai-afterhours-response')
    if (afterHours) afterHours.value = p.ai_afterhours_response || 'queue'
    const priorityAp = document.getElementById('priority-autopilot-enabled')
    if (priorityAp) priorityAp.checked = p.priority_autopilot === true
    if (typeof loadChecklist === 'function') loadChecklist(p)
    // Populate sidebar credits
    const formatCredits = (n) => {
      if (n === undefined || n === null) return '—'
      const num = parseFloat(n)
      if (isNaN(num)) return '—'
      if (num >= 1000) return (num / 1000).toFixed(1) + 'k'
      return Math.floor(num).toString()
    }
    const smsEl = document.getElementById('sidebar-sms-credits')
    const aiEl = document.getElementById('sidebar-ai-credits')
    const dncEl = document.getElementById('sidebar-dnc-credits')
    if (smsEl) {
      smsEl.textContent = formatCredits(p.sms_credits)
      smsEl.classList.remove('low', 'critical')
      if (parseFloat(p.sms_credits) < 100) smsEl.classList.add('low')
      if (parseFloat(p.sms_credits) < 25) smsEl.classList.add('critical')
    }
    if (aiEl) {
      aiEl.textContent = formatCredits(p.ai_credits)
      aiEl.classList.remove('low', 'critical')
      if (parseFloat(p.ai_credits) < 50) aiEl.classList.add('low')
      if (parseFloat(p.ai_credits) < 10) aiEl.classList.add('critical')
    }
    if (dncEl) {
      dncEl.textContent = formatCredits(p.dnc_credits)
      dncEl.classList.remove('low', 'critical')
      if (parseFloat(p.dnc_credits) < 50) dncEl.classList.add('low')
      if (parseFloat(p.dnc_credits) < 10) dncEl.classList.add('critical')
    }
  } catch (err) { console.error('Profile load error:', err) }
}

// ─── NOTIFICATIONS ───────────────────────────────────────────────────────────

let notifPanelOpen = false

const toggleNotifPanel = (e) => {
  e.stopPropagation()
  notifPanelOpen = !notifPanelOpen
  document.getElementById('notif-panel').style.display = notifPanelOpen ? 'block' : 'none'
  if (notifPanelOpen) loadNotifications()
}

const loadNotifications = async () => {
  try {
    const res = await fetch('/notifications')
    const data = await res.json()
    renderNotifications(data.notifications || [])
    updateNotifBadge(data.unread_count || 0)
  } catch (err) { console.error('Notifications load error:', err) }
}

const renderNotifications = (notifs) => {
  const list = document.getElementById('notif-list')
  if (!notifs.length) {
    list.innerHTML = `<div class="notif-empty"><div class="notif-empty-icon">🔔</div><p>No new notifications</p><span>Lead replies will appear here</span></div>`
    return
  }
  list.innerHTML = notifs.map(n => {
    const preview = (n.body || '').slice(0, 60) + ((n.body || '').length > 60 ? '…' : '')
    const icon = n.type === 'appointment_booked' ? '&#128197;' :
      n.type === 'hot_lead' ? '&#128293;' : '&#128172;'
    return `<div class="notif-item ${n.is_read ? 'read' : 'unread'}" onclick="handleNotifClick('${n.id}','${n.lead_id || ''}','${n.conversation_id || ''}')">
      <div class="notif-avatar">?</div>
      <div class="notif-content">
        <div class="notif-name">${icon} ${n.title}</div>
        <div class="notif-preview">${preview}</div>
        <div class="notif-time">${timeAgo(n.created_at)}</div>
      </div>
    </div>`
  }).join('')
}

const handleNotifClick = async (notifId, leadId, convId) => {
  document.getElementById('notif-panel').style.display = 'none'
  notifPanelOpen = false
  if (notifId) fetch(`/notifications/read/${notifId}`, { method: 'POST' }).catch(() => {})
  if (convId) {
    window.location.href = `/conversations.html?conv=${convId}`
  } else if (leadId) {
    window.location.href = `/conversations.html?lead=${leadId}`
  }
  loadNotifBadge()
}

const markAllNotifRead = async () => {
  await fetch('/notifications/read', { method: 'POST' }).catch(() => {})
  loadNotifications()
  updateNotifBadge(0)
}

const updateNotifBadge = (count) => {
  const badge = document.getElementById('notif-badge')
  if (!badge) return
  if (count <= 0) { badge.style.display = 'none'; return }
  badge.style.display = 'inline'
  badge.textContent = count > 9 ? '9+' : count
}

const updateConvNavBadge = (count) => {
  const convLink = document.querySelector('a[href="/conversations.html"]')
  if (!convLink) return
  let badge = convLink.querySelector('.conv-nav-badge')
  if (count <= 0) {
    if (badge) badge.remove()
    return
  }
  if (!badge) {
    badge = document.createElement('span')
    badge.className = 'conv-nav-badge'
    badge.style.cssText = 'position:absolute;top:4px;right:4px;background:#ef4444;color:white;font-size:10px;font-weight:700;min-width:18px;height:18px;border-radius:9px;padding:0 4px;display:flex;align-items:center;justify-content:center;pointer-events:none;'
    convLink.style.position = 'relative'
    convLink.appendChild(badge)
  }
  badge.textContent = count > 99 ? '99+' : count
}

const loadNotifBadge = async () => {
  if (document.hidden) return
  try {
    const res = await fetch('/notifications/unread-count')
    const data = await res.json()
    updateNotifBadge(data.count || 0)
    updateConvNavBadge(data.count || 0)
  } catch {}
}

// Close notif panel when clicking outside
document.addEventListener('click', (e) => {
  if (notifPanelOpen && !document.getElementById('notif-wrap')?.contains(e.target)) {
    const panel = document.getElementById('notif-panel')
    if (panel) panel.style.display = 'none'
    notifPanelOpen = false
  }
})

// ─── CALENDAR BADGE ──────────────────────────────────────────────────────────

const loadCalBadge = async () => {
  try {
    const res = await fetch('/appointments?upcoming=true')
    const data = await res.json()
    const badge = document.getElementById('today-appt-badge')
    if (!badge) return
    if (data.count > 0) { badge.style.display = 'inline-block' }
    else badge.style.display = 'none'
  } catch {}
}

// ─── PROFILE DROPDOWN ────────────────────────────────────────────────────────

const toggleProfileMenu = (e) => {
  e.stopPropagation()
  document.getElementById('profile-menu').classList.toggle('open')
}

const closeProfileMenu = () => {
  document.getElementById('profile-menu').classList.remove('open')
}

const goToSettings = (panel) => {
  window.location.href = '/settings.html?panel=' + panel
}

const goToSettingsNotif = () => {
  window.location.href = '/settings.html?panel=notifications'
}

document.addEventListener('click', (e) => {
  if (!document.getElementById('profile-menu')?.contains(e.target)) closeProfileMenu()
})

// ─── MOBILE NAV DRAWER ───────────────────────────────────────────────────────

const openNavDrawer = () => {
  document.getElementById('nav-drawer').classList.add('open')
  document.getElementById('nav-overlay').classList.add('open')
}

const closeNavDrawer = () => {
  document.getElementById('nav-drawer').classList.remove('open')
  document.getElementById('nav-overlay').classList.remove('open')
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeNavDrawer() })

// ─── FORMATTERS ──────────────────────────────────────────────────────────────

const getInitials = (first, last) => ((first?.[0] || '') + (last?.[0] || '')).toUpperCase() || '?'

const formatDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

const formatTime = (iso) => {
  if (!iso) return ''
  const d = new Date(iso), now = new Date(), diff = now - d
  if (diff < 86400000) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (diff < 604800000) return d.toLocaleDateString('en-US', { weekday: 'short' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const getLocalTime = (tz) => {
  try { return new Date().toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }) } catch { return '' }
}

const fmtComm = (n) => n > 0 ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '—'

const timeAgo = (isoStr) => {
  const diff = Math.floor((Date.now() - new Date(isoStr)) / 1000)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`
  if (diff < 172800) return 'Yesterday'
  return new Date(isoStr).toLocaleDateString()
}

// ─── CLIPBOARD ───────────────────────────────────────────────────────────────

const COPY_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><rect x="9" y="2" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`
const CHECK_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><polyline points="20 6 9 17 4 12"/></svg>`

const copyToClipboard = async (text, btn) => {
  if (!text) return
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text)
    } else {
      const ta = document.createElement('textarea')
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0'
      document.body.appendChild(ta); ta.select()
      if (!document.execCommand('copy')) throw new Error()
      document.body.removeChild(ta)
    }
    btn.innerHTML = CHECK_SVG
    btn.classList.add('copied')
    btn.title = 'Copied!'
    setTimeout(() => { btn.innerHTML = COPY_SVG; btn.classList.remove('copied'); btn.title = 'Copy' }, 2000)
  } catch (e) { toast.error('Could not copy', 'Please copy manually') }
}

// ─── KEYWORD CHIPS ───────────────────────────────────────────────────────────

const insertAtCursor = (textarea, value) => {
  if (!textarea) return
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const before = textarea.value.substring(0, start)
  const after = textarea.value.substring(end)
  textarea.value = before + value + after
  const newPos = start + value.length
  textarea.setSelectionRange(newPos, newPos)
  textarea.focus()
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

const kwChipFlash = (chip) => {
  chip.style.background = '#c7d2fe'
  chip.style.borderColor = '#818cf8'
  chip.style.color = '#4338ca'
  setTimeout(() => { chip.style.background = ''; chip.style.borderColor = ''; chip.style.color = '' }, 150)
}

const KW_CHIPS = [
  ['First Name', '[First Name]'], ['Last Name', '[Last Name]'], ['Full Name', '[Full Name]'],
  ['Phone', '[Phone]'], ['Email', '[Email]'], ['State', '[State]'],
  ['City', '[City]'], ['Zip', '[Zip]'], ['Agent Name', '[Agent Name]'],
  ['Agency Name', '[Agency Name]'], ['Calendly Link', '[Calendly Link]'],
  ['Date', '[Date]'], ['Time', '[Time]'],
]

const kwChipsRowHTML = (taExpr) => {
  const chips = KW_CHIPS.map(([label, val]) =>
    `<button type="button" class="kw-chip" onclick="kwChipFlash(this);insertAtCursor(${taExpr},'${val}')">${label}</button>`
  ).join('')
  return `<div class="kw-chips"><span class="kw-chips-label">Insert variable:</span>${chips}</div>`
}

// ─── SIDEBAR ─────────────────────────────────────────────────────────────────

const renderSidebar = () => {
  const root = document.getElementById('sidebar-root')
  if (!root) return
  const p = window.location.pathname
  const a = (href) => (p === href || p.endsWith(href)) ? ' active' : ''

  const SVG_LEADS = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6" cy="5" r="2.5"/><path d="M1.5 13.5c0-3 2-4.5 4.5-4.5s4.5 1.5 4.5 4.5"/><circle cx="12.5" cy="6" r="1.8"/><path d="M10.5 13.5c0-2 1-3 2-3s2 1 2 3"/></svg>`
  const SVG_BUCKETS = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="12" height="9" rx="2"/><path d="M5 4V3a1 1 0 011-1h4a1 1 0 011 1v1"/></svg>`
  const SVG_ARCHIVE = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="3" rx="1"/><path d="M3 6v7a1 1 0 001 1h8a1 1 0 001-1V6"/><path d="M6 10h4"/></svg>`
  const SVG_PIPELINE = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="3" height="12" rx="1"/><rect x="6.5" y="5" width="3" height="9" rx="1"/><rect x="11" y="3" width="3" height="11" rx="1"/></svg>`
  const SVG_CONV = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 5a1 1 0 00-1-1H3a1 1 0 00-1 1v6a1 1 0 001 1h2v2l3-2h5a1 1 0 001-1V5z"/></svg>`
  const SVG_CAMP = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4l5 3 7-4"/><rect x="2" y="4" width="12" height="9" rx="1"/></svg>`
  const SVG_STATS = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 13V9l3-3 3 2.5 3-5 3 2V13H2z"/></svg>`
  const SVG_CAL = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M5 2v2M11 2v2M2 7h12"/></svg>`
  const SVG_SETTINGS = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41"/></svg>`
  const SVG_ADMIN = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2l1.5 3 3.5.5-2.5 2.5.5 3.5L8 10l-3 1.5.5-3.5L3 5.5 6.5 5z"/></svg>`
  const SVG_BELL = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2a5 5 0 00-5 5v2l-1 2h12l-1-2V7a5 5 0 00-5-5z"/><path d="M6.5 13a1.5 1.5 0 003 0"/></svg>`

  root.innerHTML = `
<div class="sidebar" id="nav-drawer">
  <div class="sidebar-logo">
    <a href="/leads.html" class="logo-link" title="Home">
      <div class="logo">
        <div class="logo-mark">
          <svg viewBox="0 0 36 36" fill="none" width="20" height="20">
            <path d="M8 10L14 18L8 26" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.6"/>
            <path d="M15 10L23 18L15 26" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M21 10L29 18L21 26" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.7"/>
          </svg>
        </div>
        <span class="logo-text"><span class="logo-velox">velox</span>o</span>
      </div>
    </a>
  </div>
  <nav class="sidebar-nav">
    <span class="nav-section-label">Lead Management</span>
    <a href="/leads.html" class="nav-item${a('/leads.html')}">${SVG_LEADS}<span>Leads</span><span class="nav-priority-badge" id="priority-count-badge" style="display:none;"></span></a>
    <a href="/buckets.html" class="nav-item${a('/buckets.html')}">${SVG_BUCKETS}<span>Buckets</span></a>
    <a href="/archive.html" class="nav-item${a('/archive.html')}">${SVG_ARCHIVE}<span>Archive</span></a>
    <a href="/pipeline.html" class="nav-item${a('/pipeline.html')}">${SVG_PIPELINE}<span>Pipeline</span></a>
    <a href="/lead-vendors.html" class="nav-item${a('/lead-vendors.html')}">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6" cy="5" r="2.5"/><path d="M1.5 13.5c0-3 2-4.5 4.5-4.5s4.5 1.5 4.5 4.5"/><path d="M11 7l2 2 2-2"/><path d="M13 9V3"/></svg>
      <span>Lead Vendors</span>
    </a>

    <span class="nav-section-label">Outreach</span>
    <a href="/conversations.html" class="nav-item${a('/conversations.html')}">${SVG_CONV}<span>Conversations</span><span class="notif-badge-inline nav-badge alert" id="notif-badge" style="display:none;"></span></a>
    <a href="/campaigns.html" class="nav-item${a('/campaigns.html')}">${SVG_CAMP}<span>Campaigns</span></a>
    <a href="/dispositions.html" class="nav-item${a('/dispositions.html')}">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 5h12M4 5V3.5A1.5 1.5 0 015.5 2h5A1.5 1.5 0 0112 3.5V5M6 9l1.5 1.5L11 7"/></svg>
      <span>Dispositions</span>
    </a>
    <a href="/templates.html" class="nav-item${a('/templates.html')}">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M5 6h6M5 9h4"/></svg>
      <span>Templates</span>
    </a>
    <a href="/drips.html" class="nav-item${a('/drips.html')}">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v4M8 10v4"/><path d="M4 6h8"/><path d="M5 10h6"/><circle cx="8" cy="6" r="1" fill="currentColor"/><circle cx="8" cy="10" r="1" fill="currentColor"/></svg>
      <span>Follow-up Drips</span>
    </a>

    <span class="nav-section-label">Insights</span>
    <a href="/stats.html" class="nav-item${a('/stats.html')}">${SVG_STATS}<span>Stats</span></a>
    <a href="/calendar.html" class="nav-item${a('/calendar.html')}" id="nav-calendar">${SVG_CAL}<span>Calendar</span><span id="today-appt-badge" class="nav-badge alert" style="display:none;"></span></a>

    <div style="border-top:1px solid var(--sidebar-border);margin:6px 0;"></div>
    <a href="/settings.html" class="nav-item${a('/settings.html')}">${SVG_SETTINGS}<span>Settings</span></a>
    <a href="/admin.html" id="admin-nav-link" class="nav-item${a('/admin.html')}" style="display:none;">${SVG_ADMIN}<span>Admin</span></a>
  </nav>
  <div class="sidebar-credits" id="sidebar-credits" onclick="window.location.href='/settings.html?panel=billing'" title="View Billing">
    <div class="credits-row">
      <span class="credits-icon">💬</span>
      <span class="credits-label">SMS</span>
      <span class="credits-value" id="sidebar-sms-credits">—</span>
    </div>
    <div class="credits-row">
      <span class="credits-icon">🤖</span>
      <span class="credits-label">AI</span>
      <span class="credits-value" id="sidebar-ai-credits">—</span>
    </div>
    <div class="credits-row">
      <span class="credits-icon">🛡️</span>
      <span class="credits-label">DNC</span>
      <span class="credits-value" id="sidebar-dnc-credits">—</span>
    </div>
    <div class="credits-buy-link">+ Buy Credits</div>
  </div>
  <div class="sidebar-footer">
    <div id="notif-wrap" style="padding:0 8px 4px;">
      <button class="nav-item" id="notification-bell" onclick="toggleNotifPanel(event)" style="width:100%;border:none;cursor:pointer;font-family:inherit;">
        ${SVG_BELL}<span>Notifications</span>
        <span class="nav-badge alert" id="notif-count-badge" style="display:none;margin-left:auto;"></span>
      </button>
      <div class="notif-panel" id="notif-panel" style="display:none;">
        <div class="notif-panel-header"><span>Notifications</span><a onclick="markAllNotifRead()">Mark all read</a></div>
        <div class="notif-list" id="notif-list"></div>
        <div class="notif-footer">Showing last 30 notifications</div>
      </div>
    </div>
    <div style="padding:0 8px 4px;">
      <button class="theme-toggle" onclick="toggleTheme()">
        <svg class="theme-icon-moon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13.5 8.5a5.5 5.5 0 01-6-6 5.5 5.5 0 106 6z"/></svg>
        <svg class="theme-icon-sun" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41"/></svg>
        <span>Toggle theme</span>
      </button>
    </div>
    <div style="position:relative;" id="profile-menu">
      <div id="profile-dropdown" style="display:none;position:absolute;bottom:70px;left:8px;right:8px;background:var(--dropdown-bg);border:1px solid var(--input-border);border-radius:10px;padding:8px;z-index:300;">
        <div id="profile-dropdown-name" class="profile-user-name"></div>
        <div id="profile-dropdown-email" class="profile-user-email"></div>
        <div class="dropdown-divider"></div>
        <button class="nav-item" onclick="goToSettings('account');document.getElementById('profile-dropdown').style.display='none';">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="6" r="2.5"/><path d="M2.5 13c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/></svg>
          Profile &amp; Settings
        </button>
        <a href="/admin.html" id="profile-admin-link" class="nav-item" style="display:none;">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2l1.5 3 3.5.5-2.5 2.5.5 3.5L8 10l-3 1.5.5-3.5L3 5.5 6.5 5z"/></svg>
          Admin Panel
        </a>
        <div class="dropdown-divider"></div>
        <button class="nav-item" onclick="logout()">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h3M10 11l3-3-3-3M13 8H6"/></svg>
          Log out
        </button>
      </div>
      <div class="user-row" id="profile-trigger" onclick="event.stopPropagation();var d=document.getElementById('profile-dropdown');d.style.display=d.style.display==='block'?'none':'block';">
        <div class="user-avatar" id="user-avatar-initials">?</div>
        <div style="flex:1;min-width:0;">
          <div class="user-name" id="header-agent-name"></div>
          <div class="user-sub" id="header-agency-name"></div>
        </div>
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:0.3;flex-shrink:0"><path d="M5 3l4 4-4 4"/></svg>
      </div>
    </div>
  </div>
</div>`

  if (!window._profileDropdownBound) {
    window._profileDropdownBound = true
    document.addEventListener('click', function(e) {
      const pm = document.getElementById('profile-menu')
      if (pm && !pm.contains(e.target)) {
        const d = document.getElementById('profile-dropdown')
        if (d) d.style.display = 'none'
      }
    })
  }
}

document.addEventListener('DOMContentLoaded', () => {
  renderSidebar()
  const savedTheme = localStorage.getItem('theme')
  if (savedTheme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light')
  } else {
    document.documentElement.removeAttribute('data-theme')
  }
})

// ─── CONFETTI ────────────────────────────────────────────────────────────────

const fireConfetti = () => {
  if (typeof confetti !== 'undefined') {
    confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 }, colors: ['#10b981', '#6366f1', '#f59e0b', '#ec4899'] })
    setTimeout(() => confetti({ particleCount: 80, spread: 60, origin: { y: 0.5 }, colors: ['#10b981', '#6366f1'] }), 600)
  }
}
