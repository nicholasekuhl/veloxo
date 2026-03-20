// shared.js — shared utilities loaded on every page

let currentUser = null

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

// ─── PROFILE ─────────────────────────────────────────────────────────────────

const loadProfile = async () => {
  try {
    const res = await fetch('/auth/me')
    if (!res.ok) return
    const data = await res.json()
    const p = data.user
    currentUser = p
    const displayName = p.agent_name || p.email || ''
    const headerName = document.getElementById('header-agent-name')
    if (headerName) headerName.textContent = displayName
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
    if (typeof loadChecklist === 'function') loadChecklist(p)
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
    return `<div class="notif-item ${n.is_read ? 'read' : 'unread'}" onclick="handleNotifClick('${n.id}','${n.lead_id || ''}','${n.conversation_id || ''}')">
      <div class="notif-avatar">?</div>
      <div class="notif-content">
        <div class="notif-name">${n.title}</div>
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

const loadNotifBadge = async () => {
  if (document.hidden) return
  try {
    const res = await fetch('/notifications/unread-count')
    const data = await res.json()
    updateNotifBadge(data.count || 0)
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
    const res = await fetch('/appointments')
    const data = await res.json()
    const appts = data.appointments || []
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz })
    const todayCount = appts.filter(a => {
      return a.scheduled_at?.slice(0, 10) === todayStr && a.status === 'scheduled'
    }).length
    const badge = document.getElementById('today-appt-badge')
    if (!badge) return
    if (todayCount > 0) { badge.textContent = todayCount; badge.style.display = 'inline' }
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
    `<button type="button" class="kw-chip" onclick="kwChipFlash(this);insertAtCursor(${taExpr},${JSON.stringify(val)})">${label}</button>`
  ).join('')
  return `<div class="kw-chips"><span class="kw-chips-label">Insert variable:</span>${chips}</div>`
}

// ─── CONFETTI ────────────────────────────────────────────────────────────────

const fireConfetti = () => {
  if (typeof confetti !== 'undefined') {
    confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 }, colors: ['#10b981', '#6366f1', '#f59e0b', '#ec4899'] })
    setTimeout(() => confetti({ particleCount: 80, spread: 60, origin: { y: 0.5 }, colors: ['#10b981', '#6366f1'] }), 600)
  }
}
