/**
 * Veloxo — Toast & Confirm Modal System
 * Provides window.toast.success/error/warning/info(title, msg)
 * and window.confirmModal(title, msg, confirmText, destructive)
 */
(function () {
  // ─── CSS ────────────────────────────────────────────────────────────────────
  const css = `
    #ta-container {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 99999;
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
      max-width: 380px;
      width: calc(100vw - 48px);
    }
    .ta-toast {
      background: white;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.14);
      display: flex;
      align-items: flex-start;
      gap: 0;
      overflow: hidden;
      pointer-events: all;
      position: relative;
      border-left: 4px solid transparent;
      transform: translateX(calc(100% + 32px));
      opacity: 0;
      transition: transform 0.28s cubic-bezier(0.34,1.2,0.64,1), opacity 0.22s ease;
    }
    .ta-toast--show {
      transform: translateX(0);
      opacity: 1;
    }
    .ta-toast--hide {
      transform: translateX(calc(100% + 32px));
      opacity: 0;
    }
    .ta-toast--success { border-left-color: #059669; }
    .ta-toast--error   { border-left-color: #dc2626; }
    .ta-toast--warning { border-left-color: #d97706; }
    .ta-toast--info    { border-left-color: #3b82f6; }

    .ta-toast__icon {
      flex-shrink: 0;
      width: 36px;
      height: 36px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 700;
      margin: 12px 0 12px 12px;
    }
    .ta-toast--success .ta-toast__icon { background: #d1fae5; color: #059669; }
    .ta-toast--error   .ta-toast__icon { background: #fee2e2; color: #dc2626; }
    .ta-toast--warning .ta-toast__icon { background: #fef3c7; color: #d97706; }
    .ta-toast--info    .ta-toast__icon { background: #dbeafe; color: #3b82f6; }

    .ta-toast__body {
      flex: 1;
      padding: 12px 8px 14px 10px;
      min-width: 0;
    }
    .ta-toast__title {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      font-weight: 700;
      color: #1a1a2e;
      line-height: 1.3;
      margin-bottom: 2px;
    }
    .ta-toast__msg {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px;
      color: #6b7280;
      line-height: 1.45;
    }
    .ta-toast__x {
      flex-shrink: 0;
      background: none;
      border: none;
      cursor: pointer;
      color: #d1d5db;
      font-size: 16px;
      line-height: 1;
      padding: 10px 10px 0 4px;
      transition: color 0.1s;
      font-family: inherit;
    }
    .ta-toast__x:hover { color: #6b7280; }

    .ta-toast__bar {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: rgba(0,0,0,0.06);
    }
    .ta-toast__progress {
      height: 100%;
      transition: none;
    }
    .ta-toast--success .ta-toast__progress { background: #059669; }
    .ta-toast--error   .ta-toast__progress { background: #dc2626; }
    .ta-toast--warning .ta-toast__progress { background: #d97706; }
    .ta-toast--info    .ta-toast__progress { background: #3b82f6; }

    /* ── Confirm Modal ──────────────────────────────────────────────────── */
    .ta-confirm-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.45);
      z-index: 100000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      opacity: 0;
      transition: opacity 0.18s ease;
    }
    .ta-confirm-overlay--show { opacity: 1; }

    .ta-confirm {
      background: white;
      border-radius: 16px;
      padding: 28px;
      width: 100%;
      max-width: 420px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.2);
      transform: scale(0.94) translateY(8px);
      transition: transform 0.2s cubic-bezier(0.34,1.2,0.64,1);
    }
    .ta-confirm-overlay--show .ta-confirm { transform: scale(1) translateY(0); }

    .ta-confirm__title {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 17px;
      font-weight: 700;
      color: #1a1a2e;
      margin-bottom: 10px;
    }
    .ta-confirm__msg {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
      color: #6b7280;
      line-height: 1.55;
      margin-bottom: 24px;
    }
    .ta-confirm__footer {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
    }
    .ta-confirm__cancel, .ta-confirm__ok {
      border: none;
      padding: 9px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      transition: all 0.15s;
    }
    .ta-confirm__cancel {
      background: #f3f4f6;
      color: #374151;
    }
    .ta-confirm__cancel:hover { background: #e5e7eb; }
    .ta-confirm__ok {
      background: #6366f1;
      color: white;
    }
    .ta-confirm__ok:hover { background: #4f46e5; }
    .ta-confirm__ok--danger {
      background: #dc2626;
      color: white;
    }
    .ta-confirm__ok--danger:hover { background: #b91c1c; }

    @media (max-width: 480px) {
      #ta-container { right: 12px; bottom: 16px; width: calc(100vw - 24px); }
      .ta-confirm { padding: 22px 18px; }
      .ta-confirm__footer { flex-direction: column-reverse; }
      .ta-confirm__cancel, .ta-confirm__ok { width: 100%; text-align: center; }
    }

    /* ── Skeleton Loaders ────────────────────────────────────────────── */
    @keyframes skeleton-loading {
      0%   { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    .skeleton {
      background: linear-gradient(90deg, #f0f0f0 25%, #e4e4e4 50%, #f0f0f0 75%);
      background-size: 200% 100%;
      animation: skeleton-loading 1.4s ease-in-out infinite;
      border-radius: 6px;
      display: inline-block;
    }
    @media (prefers-color-scheme: dark) {
      .skeleton {
        background: linear-gradient(90deg, #2a2a3a 25%, #333348 50%, #2a2a3a 75%);
        background-size: 200% 100%;
      }
    }
    .skel-card { background: white; border-radius: 14px; padding: 18px 22px; border: 1px solid #f0f0f0; margin-bottom: 10px; }
    .skel-conv-item { padding: 11px 14px; border-bottom: 1px solid #f9fafb; display: flex; gap: 10px; align-items: flex-start; }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ─── Container ──────────────────────────────────────────────────────────────
  const container = document.createElement('div');
  container.id = 'ta-container';

  function ensureContainer() {
    if (!document.body.contains(container)) document.body.appendChild(container);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureContainer);
  } else {
    ensureContainer();
  }

  // ─── Toast logic ────────────────────────────────────────────────────────────
  const DURATION = 4000;
  const MAX = 4;
  const icons = { success: '✓', error: '✕', warning: '!', info: 'i' };
  const activeToasts = [];

  function createToast(type, title, message) {
    ensureContainer();

    // Dismiss oldest if at max
    if (activeToasts.length >= MAX) dismiss(activeToasts[0]);

    let remaining = DURATION;
    let startedAt = null;
    let timer = null;

    const el = document.createElement('div');
    el.className = `ta-toast ta-toast--${type}`;
    el.innerHTML = `
      <div class="ta-toast__icon">${icons[type] || 'i'}</div>
      <div class="ta-toast__body">
        <div class="ta-toast__title">${escHtml(title)}</div>
        ${message ? `<div class="ta-toast__msg">${escHtml(message)}</div>` : ''}
      </div>
      <button class="ta-toast__x" aria-label="Dismiss">×</button>
      <div class="ta-toast__bar"><div class="ta-toast__progress"></div></div>
    `;

    const progress = el.querySelector('.ta-toast__progress');

    const start = () => {
      startedAt = Date.now();
      timer = setTimeout(() => dismiss(el), remaining);
      // Animate progress bar from current % to 0 over remaining ms
      const startPct = (remaining / DURATION) * 100;
      progress.style.transition = 'none';
      progress.style.width = startPct + '%';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        progress.style.transition = `width ${remaining}ms linear`;
        progress.style.width = '0%';
      }));
    };

    const pause = () => {
      clearTimeout(timer);
      remaining = Math.max(0, remaining - (Date.now() - startedAt));
      // Freeze progress bar
      const frozenPct = (remaining / DURATION) * 100;
      progress.style.transition = 'none';
      progress.style.width = frozenPct + '%';
    };

    el.addEventListener('mouseenter', pause);
    el.addEventListener('mouseleave', start);
    el.querySelector('.ta-toast__x').addEventListener('click', () => dismiss(el));

    container.appendChild(el);
    activeToasts.push(el);

    // Slide in
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.classList.add('ta-toast--show');
      start();
    }));
  }

  function dismiss(el) {
    const idx = activeToasts.indexOf(el);
    if (idx === -1) return;
    activeToasts.splice(idx, 1);
    el.classList.remove('ta-toast--show');
    el.classList.add('ta-toast--hide');
    setTimeout(() => { if (el.parentNode) el.remove(); }, 350);
  }

  function escHtml(str) {
    if (typeof str !== 'string') str = String(str || '');
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  window.toast = {
    success: (title, msg) => createToast('success', title, msg),
    error:   (title, msg) => createToast('error',   title, msg),
    warning: (title, msg) => createToast('warning', title, msg),
    info:    (title, msg) => createToast('info',    title, msg),
  };

  // ─── Confirm Modal ──────────────────────────────────────────────────────────
  let activeConfirm = null;

  window.confirmModal = function (title, message, confirmText, destructive) {
    confirmText  = confirmText  || 'Confirm';
    destructive  = destructive  !== false; // default destructive=true
    return new Promise(function (resolve) {
      // Only one confirm at a time
      if (activeConfirm) { activeConfirm.remove(); activeConfirm = null; }

      const overlay = document.createElement('div');
      overlay.className = 'ta-confirm-overlay';
      overlay.innerHTML = `
        <div class="ta-confirm">
          <div class="ta-confirm__title">${escHtml(title)}</div>
          <p class="ta-confirm__msg">${escHtml(message)}</p>
          <div class="ta-confirm__footer">
            <button class="ta-confirm__cancel">Cancel</button>
            <button class="ta-confirm__ok${destructive ? ' ta-confirm__ok--danger' : ''}">${escHtml(confirmText)}</button>
          </div>
        </div>
      `;

      function done(result) {
        overlay.classList.remove('ta-confirm-overlay--show');
        document.removeEventListener('keydown', keyHandler);
        setTimeout(() => { if (overlay.parentNode) overlay.remove(); activeConfirm = null; }, 220);
        resolve(result);
      }

      overlay.querySelector('.ta-confirm__cancel').addEventListener('click', () => done(false));
      overlay.querySelector('.ta-confirm__ok').addEventListener('click', () => done(true));
      overlay.addEventListener('click', e => { if (e.target === overlay) done(false); });

      function keyHandler(e) {
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
        if (e.key === 'Enter')  { e.preventDefault(); done(true); }
      }
      document.addEventListener('keydown', keyHandler);

      activeConfirm = overlay;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('ta-confirm-overlay--show')));
    });
  };
})();
