/* ============================================================
   EAC TOOLS — SHARED JS  v1.0
   Loaded by every tool page via <script src="/eac.js"></script>
   Covers: auth · dropdown · CMS content · CMS admin editor
   All functions are global so tool-specific scripts can call them.
   ============================================================ */

/* ── AUTH STATE (readable by tool pages) ── */
var eacUser = null;

/* ── AUTH INIT ── */
(async function initAuth() {
  const el = document.getElementById('header-auth');
  if (!el) return;

  try {
    const res = await fetch('/api/me');
    const { user } = await res.json();
    eacUser = user;

    if (user) {
      if (user.isAdmin) {
        try { enableEditing(); } catch (e) { console.error('CMS init failed:', e); }
      }
      const initial = (user.name || user.email || '?')[0].toUpperCase();
      el.innerHTML = `
        <button class="header-user-btn" onclick="toggleDropdown(event)">
          ${user.avatarUrl
            ? `<img class="header-avatar" src="${user.avatarUrl}" alt="${user.name}">`
            : `<div class="header-avatar-placeholder">${initial}</div>`}
          <span class="header-user-name">${user.name || user.email}</span>
          <svg class="header-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div class="header-dropdown" id="header-dropdown">
          <a class="dropdown-item" href="/dashboard">My Dashboard</a>
          <div class="dropdown-divider"></div>
          <button class="dropdown-item dropdown-logout" onclick="handleLogout()">Log out</button>
        </div>`;
    } else {
      el.innerHTML = _loginBtn();
    }
  } catch {
    el.innerHTML = _loginBtn();
  }
})();

function _loginBtn() {
  const redirect = encodeURIComponent(window.location.href);
  return `<a class="btn-member-login" href="https://auth.expertauthor.community/login?redirect=${redirect}"><svg class="lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Member Login<span class="login-divider"></span><span class="login-dashboard">Your dashboard →</span></a>`;
}

function toggleDropdown(e) {
  e.stopPropagation();
  document.getElementById('header-dropdown')?.classList.toggle('open');
}
document.addEventListener('click', function() {
  document.getElementById('header-dropdown')?.classList.remove('open');
});

function handleLogout() {
  const redirect = encodeURIComponent(window.location.href);
  window.location.href = `https://auth.expertauthor.community/api/auth/logout?redirect=${redirect}`;
}


/* ── CMS CONTENT ── */
var contentMap = {};

function loadContent() {
  try {
    const raw = document.getElementById('page-content')?.textContent;
    if (raw) contentMap = JSON.parse(raw);
    applyContent();
  } catch {}
}

function applyContent() {
  Object.entries(contentMap).forEach(function([key, html]) {
    const el = document.querySelector(`[data-content-key="${key}"]`);
    if (el && html) el.innerHTML = html;
  });
}


/* ── CMS ADMIN EDITOR ── */
function enableEditing() {
  document.querySelectorAll('[data-content-key]').forEach(function(el) {
    if (el.closest('.cms-region')) return;
    const key = el.dataset.contentKey;
    const wrap = document.createElement('div');
    wrap.className = 'cms-region';
    el.parentNode.insertBefore(wrap, el);
    wrap.appendChild(el);

    const btn = document.createElement('button');
    btn.className = 'cms-edit-btn';
    btn.title = 'Edit';
    btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit';
    btn.addEventListener('click', function(e) { e.stopPropagation(); editRegion(key); });
    wrap.appendChild(btn);
  });
}

function editRegion(key) {
  const el = document.querySelector(`[data-content-key="${key}"]`);
  const wrap = el?.closest('.cms-region');
  if (!wrap || wrap.dataset.editing) return;

  wrap.dataset.editing = 'true';
  const original = el.innerHTML;
  el.style.display = 'none';
  wrap.querySelector('.cms-edit-btn').style.display = 'none';

  const uid = 'cms-' + key.replace(/[^a-z0-9]/gi, '-');
  const edWrap = document.createElement('div');
  edWrap.className = 'cms-editor-wrap';
  edWrap.innerHTML = `
    <div class="cms-toolbar">
      <button type="button" class="cms-tb-btn" data-cmd="bold"><b>B</b></button>
      <button type="button" class="cms-tb-btn" data-cmd="italic"><i>I</i></button>
      <button type="button" class="cms-tb-btn" data-cmd="h2">H2</button>
      <button type="button" class="cms-tb-btn" data-cmd="p">¶</button>
    </div>
    <div class="cms-editable" contenteditable="true" id="${uid}"></div>
    <div class="cms-actions">
      <button class="cms-save-btn">Save</button>
      <button class="cms-cancel-btn">Cancel</button>
    </div>`;
  wrap.appendChild(edWrap);

  const editable = edWrap.querySelector('.cms-editable');
  editable.innerHTML = original;

  edWrap.querySelectorAll('.cms-tb-btn').forEach(function(btn) {
    btn.addEventListener('mousedown', function(e) {
      e.preventDefault();
      const cmd = btn.dataset.cmd;
      if (cmd === 'h2')     document.execCommand('formatBlock', false, 'h2');
      else if (cmd === 'p') document.execCommand('formatBlock', false, 'p');
      else                  document.execCommand(cmd);
      editable.focus();
    });
  });

  edWrap.querySelector('.cms-save-btn').addEventListener('click', function() { saveCms(key, original); });
  edWrap.querySelector('.cms-cancel-btn').addEventListener('click', function() { cancelCms(key, original); });
}

async function saveCms(key, original) {
  const el      = document.querySelector(`[data-content-key="${key}"]`);
  const wrap    = el?.closest('.cms-region');
  if (!wrap) return;

  const uid     = 'cms-' + key.replace(/[^a-z0-9]/gi, '-');
  const html    = document.getElementById(uid)?.innerHTML ?? '';
  const saveBtn = wrap.querySelector('.cms-save-btn');
  saveBtn.textContent = 'Saving…';
  saveBtn.disabled    = true;

  const page = window.location.pathname.replace(/^\//, '').replace(/\.html$/, '') || 'index';

  try {
    const r = await fetch('/api/content', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ key, html, page, label: key }),
    });
    if (!r.ok) throw new Error();
    finishEdit(key, html);
  } catch {
    saveBtn.textContent = 'Save';
    saveBtn.disabled    = false;
    alert('Save failed — please try again.');
  }
}

function cancelCms(key, original) { finishEdit(key, original); }

function finishEdit(key, html) {
  const el   = document.querySelector(`[data-content-key="${key}"]`);
  const wrap = el?.closest('.cms-region');
  if (!wrap) return;
  el.innerHTML = html;
  el.style.display = '';
  wrap.querySelector('.cms-editor-wrap')?.remove();
  wrap.querySelector('.cms-edit-btn').style.display = '';
  delete wrap.dataset.editing;
}

/* Run on every page load */
loadContent();
