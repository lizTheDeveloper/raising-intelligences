/* ============================================
   MULTIVERSE STUDIOS — Matrix Authentication
   Matrix homeserver: matrix.multiversegames.ai
   ============================================ */

(function initMatrixAuth() {
  'use strict';

  // ── QA Bypass (matches play-gate.js) ──────────────────────
  var QA_BYPASS_TOKEN = '2E9of-hSOdWxB2og5gmZ1MmMYUij0hMUqBKD5TqUrmc';
  var params = new URLSearchParams(window.location.search);
  if (params.get('bypass_auth') === QA_BYPASS_TOKEN) {
    return;
  }

  // Match the homeserver + auth-proxy endpoints to the domain the page was
  // served from; both domains front the same Synapse and the same library-api
  // auth proxy, so the user stays on the domain family they arrived through.
  const ON_AI = /(^|\.)multiversegames\.ai$/.test(location.hostname);
  const MATRIX_DOMAIN = ON_AI ? 'matrix.multiversegames.ai' : 'matrix.multiversestudios.xyz';
  const HOMESERVER = 'https://' + MATRIX_DOMAIN;
  const AUTH_PROXY = 'https://' + (ON_AI ? 'api.multiversegames.ai' : 'api.multiversestudios.xyz') + '/auth/matrix';

  // ── Utilities ──────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* noop */ }
  }

  function storageRemove(key) {
    try { localStorage.removeItem(key); } catch (_) { /* noop */ }
  }

  // ── Session State ──────────────────────────────────────────
  // The Matrix access token is held server-side in an HttpOnly cookie (mx_session).
  // Only non-sensitive identifiers are stored client-side.

  let session = {
    userId: storageGet('mx_user_id'),
    deviceId: storageGet('mx_device_id'),
    homeserver: storageGet('mx_homeserver') || HOMESERVER,
    displayName: null,
  };

  function saveSession(data) {
    session.userId = data.user_id;
    session.deviceId = data.device_id;
    session.homeserver = HOMESERVER;
    storageSet('mx_user_id', data.user_id);
    storageSet('mx_device_id', data.device_id);
    storageSet('mx_homeserver', HOMESERVER);
  }

  function clearSession() {
    session.userId = null;
    session.deviceId = null;
    session.displayName = null;
    storageRemove('mx_user_id');
    storageRemove('mx_device_id');
    storageRemove('mx_homeserver');
  }

  // ── Auth Proxy API ─────────────────────────────────────────
  // All auth calls go through the server-side proxy at AUTH_PROXY.
  // The Matrix access token never touches the browser — it lives in an
  // HttpOnly cookie managed by the proxy.

  async function proxyFetch(method, path, body) {
    const opts = { method, credentials: 'include', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(AUTH_PROXY + path, opts);
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json.error || ('HTTP ' + res.status));
    }
    return json;
  }

  async function apiLogin(username, password) {
    return proxyFetch('POST', '/login', { username, password });
  }

  async function apiRegister(username, password) {
    return proxyFetch('POST', '/register', { username, password });
  }

  async function apiWhoami() {
    return proxyFetch('GET', '/whoami', undefined);
  }

  async function apiGetProfile(userId) {
    // Profile is a public Matrix endpoint — no auth needed, direct call fine.
    const res = await fetch(HOMESERVER + '/_matrix/client/v3/profile/' + encodeURIComponent(userId));
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
    return json;
  }

  async function apiLogout() {
    return proxyFetch('POST', '/logout', {});
  }

  async function apiRequestOpenIdToken() {
    return proxyFetch('POST', '/openid-token', {});
  }

  // ── High-Level Auth Functions ──────────────────────────────

  async function login(username, password) {
    const data = await apiLogin(username, password);
    saveSession(data);
    await fetchDisplayName();
    updateNavUI();
    window.dispatchEvent(new CustomEvent('matrixAuthLogin', { detail: { userId: session.userId } }));
    return data;
  }

  async function register(username, password) {
    const data = await apiRegister(username, password);
    saveSession(data);
    await fetchDisplayName();
    updateNavUI();
    window.dispatchEvent(new CustomEvent('matrixAuthLogin', { detail: { userId: session.userId } }));
    return data;
  }

  async function logout() {
    try { await apiLogout(); } catch (_) { /* best-effort */ }
    clearSession();
    updateNavUI();
  }

  async function fetchDisplayName() {
    if (!session.userId) return;
    try {
      const profile = await apiGetProfile(session.userId);
      session.displayName = profile.displayname || null;
    } catch (_) {
      session.displayName = null;
    }
  }

  async function validateSession() {
    if (!session.userId) {
      clearSession();
      return false;
    }
    try {
      await apiWhoami();
      await fetchDisplayName();
      return true;
    } catch (_) {
      clearSession();
      return false;
    }
  }

  async function getOpenIdToken() {
    if (!session.userId) {
      throw new Error('Not logged in');
    }
    return apiRequestOpenIdToken();
  }

  // ── Inject Styles ─────────────────────────────────────────

  const CSS = `
/* Auth Modal Overlay */
#mx-auth-overlay {
  position: fixed;
  inset: 0;
  z-index: 100000;
  background: rgba(5,5,8,0.85);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s ease;
}
#mx-auth-overlay.open {
  opacity: 1;
  pointer-events: auto;
}

/* Modal */
#mx-auth-modal {
  background: var(--void-elevated, #111118);
  border: 1px solid var(--void-border, #1a1a24);
  border-radius: 10px;
  width: 380px;
  max-width: 92vw;
  box-shadow: 0 0 60px rgba(0,0,0,0.8), 0 0 30px rgba(0,255,200,0.06);
  font-family: var(--font-mono, monospace);
  color: var(--star-white, #e8e6f0);
  overflow: hidden;
  transform: translateY(16px) scale(0.97);
  transition: transform 0.25s ease;
}
#mx-auth-overlay.open #mx-auth-modal {
  transform: translateY(0) scale(1);
}

/* Header */
#mx-auth-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 0;
}
#mx-auth-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--biolume, #00ffc8);
}
#mx-auth-close {
  background: none;
  border: none;
  color: var(--dust, #8a8694);
  font-size: 20px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  transition: color 0.15s;
}
#mx-auth-close:hover { color: var(--star-white, #e8e6f0); }

/* Tabs */
#mx-auth-tabs {
  display: flex;
  border-bottom: 1px solid var(--void-border, #1a1a24);
  margin: 12px 20px 0;
}
.mx-auth-tab {
  flex: 1;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--dust, #8a8694);
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  letter-spacing: 0.05em;
  padding: 8px 0;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
  text-transform: uppercase;
}
.mx-auth-tab:hover { color: var(--star-white, #e8e6f0); }
.mx-auth-tab.active {
  color: var(--biolume, #00ffc8);
  border-bottom-color: var(--biolume, #00ffc8);
}

/* Form */
#mx-auth-body { padding: 20px; }
.mx-auth-field {
  margin-bottom: 14px;
}
.mx-auth-field label {
  display: block;
  font-size: 11px;
  color: var(--dust, #8a8694);
  margin-bottom: 5px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.mx-auth-field input {
  width: 100%;
  padding: 10px 12px;
  background: rgba(5,5,8,0.6);
  border: 1px solid var(--void-border, #1a1a24);
  border-radius: 6px;
  color: var(--star-white, #e8e6f0);
  font-family: var(--font-mono, monospace);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s;
  box-sizing: border-box;
}
.mx-auth-field input:focus {
  border-color: var(--biolume, #00ffc8);
}

/* Error */
#mx-auth-error {
  background: rgba(255,107,53,0.1);
  border: 1px solid rgba(255,107,53,0.3);
  border-radius: 6px;
  color: var(--ember, #ff6b35);
  font-size: 12px;
  padding: 8px 12px;
  margin-bottom: 14px;
  display: none;
  word-break: break-word;
}
#mx-auth-error.visible { display: block; }

/* Submit */
#mx-auth-submit {
  width: 100%;
  padding: 11px;
  background: transparent;
  border: 1px solid var(--biolume, #00ffc8);
  border-radius: 6px;
  color: var(--biolume, #00ffc8);
  font-family: var(--font-mono, monospace);
  font-size: 13px;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
#mx-auth-submit:hover {
  background: var(--biolume, #00ffc8);
  color: var(--void, #050508);
}
#mx-auth-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Nav auth elements */
#mx-auth-nav-signin {
  cursor: pointer;
  color: var(--biolume, #00ffc8);
  transition: opacity 0.15s;
}
#mx-auth-nav-signin:hover { opacity: 0.8; }

#mx-auth-nav-user {
  position: relative;
  cursor: pointer;
  color: var(--biolume, #00ffc8);
  user-select: none;
}
#mx-auth-nav-user-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
#mx-auth-nav-user-label::after {
  content: '';
  display: inline-block;
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid currentColor;
  transition: transform 0.15s;
}
#mx-auth-nav-user.open #mx-auth-nav-user-label::after {
  transform: rotate(180deg);
}

/* Dropdown */
#mx-auth-dropdown {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 180px;
  background: var(--void-elevated, #111118);
  border: 1px solid var(--void-border, #1a1a24);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.7);
  padding: 6px 0;
  opacity: 0;
  pointer-events: none;
  transform: translateY(-4px);
  transition: opacity 0.15s, transform 0.15s;
  z-index: 100001;
}
#mx-auth-nav-user.open #mx-auth-dropdown {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}
.mx-auth-dropdown-item {
  display: block;
  width: 100%;
  padding: 8px 16px;
  background: none;
  border: none;
  color: var(--star-white, #e8e6f0);
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.mx-auth-dropdown-item:hover {
  background: rgba(0,255,200,0.07);
  color: var(--biolume, #00ffc8);
}
.mx-auth-dropdown-divider {
  height: 1px;
  background: var(--void-border, #1a1a24);
  margin: 4px 0;
}

/* Toast notification */
#mx-auth-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%) translateY(20px);
  background: var(--void-elevated, #111118);
  border: 1px solid var(--biolume, #00ffc8);
  border-radius: 6px;
  color: var(--biolume, #00ffc8);
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  padding: 8px 16px;
  z-index: 100002;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s, transform 0.2s;
}
#mx-auth-toast.visible {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
`;

  const styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  // ── Build Modal DOM ────────────────────────────────────────

  const overlay = document.createElement('div');
  overlay.id = 'mx-auth-overlay';
  overlay.innerHTML = `
    <div id="mx-auth-modal">
      <div id="mx-auth-header">
        <h3>Matrix Authentication</h3>
        <button id="mx-auth-close" aria-label="Close">&times;</button>
      </div>
      <div id="mx-auth-tabs">
        <button class="mx-auth-tab active" data-tab="login">Sign In</button>
        <button class="mx-auth-tab" data-tab="register">Create Account</button>
      </div>
      <div id="mx-auth-body">
        <div id="mx-auth-error"></div>
        <div class="mx-auth-field">
          <label for="mx-auth-username">Username</label>
          <input type="text" id="mx-auth-username" autocomplete="username" placeholder="username">
        </div>
        <div class="mx-auth-field">
          <label for="mx-auth-password">Password</label>
          <input type="password" id="mx-auth-password" autocomplete="current-password">
        </div>
        <div class="mx-auth-field" id="mx-auth-confirm-field" style="display:none;">
          <label for="mx-auth-confirm">Confirm Password</label>
          <input type="password" id="mx-auth-confirm" autocomplete="new-password">
        </div>
        <button id="mx-auth-submit">Sign In</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Toast element
  const toast = document.createElement('div');
  toast.id = 'mx-auth-toast';
  document.body.appendChild(toast);

  // ── Modal Logic ────────────────────────────────────────────

  const elClose = document.getElementById('mx-auth-close');
  const elError = document.getElementById('mx-auth-error');
  const elUsername = document.getElementById('mx-auth-username');
  const elPassword = document.getElementById('mx-auth-password');
  const elConfirm = document.getElementById('mx-auth-confirm');
  const elConfirmField = document.getElementById('mx-auth-confirm-field');
  const elSubmit = document.getElementById('mx-auth-submit');
  const tabs = overlay.querySelectorAll('.mx-auth-tab');

  let activeTab = 'login';

  function showModal() {
    overlay.classList.add('open');
    elError.classList.remove('visible');
    elUsername.value = '';
    elPassword.value = '';
    elConfirm.value = '';
    elUsername.focus();
  }

  function hideModal() {
    overlay.classList.remove('open');
  }

  function showError(msg) {
    elError.textContent = msg;
    elError.classList.add('visible');
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('visible');
    setTimeout(function() { toast.classList.remove('visible'); }, 2500);
  }

  function switchTab(tab) {
    activeTab = tab;
    tabs.forEach(function(t) {
      t.classList.toggle('active', t.dataset.tab === tab);
    });
    elConfirmField.style.display = tab === 'register' ? '' : 'none';
    elSubmit.textContent = tab === 'login' ? 'Sign In' : 'Create Account';
    elPassword.autocomplete = tab === 'login' ? 'current-password' : 'new-password';
    elError.classList.remove('visible');
  }

  tabs.forEach(function(t) {
    t.addEventListener('click', function() { switchTab(t.dataset.tab); });
  });

  elClose.addEventListener('click', hideModal);
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) hideModal();
  });

  // Submit handler
  async function handleSubmit() {
    elError.classList.remove('visible');
    var username = elUsername.value.trim();
    var password = elPassword.value;

    if (!username || !password) {
      showError('Username and password are required.');
      return;
    }

    // Strip server part from any Matrix ID format:
    //   @user:server.tld  →  user
    //   user:server.tld   →  user  (e.g. pasted from a different client)
    if (username.startsWith('@')) {
      username = username.split(':')[0].substring(1);
    } else if (username.includes(':')) {
      username = username.split(':')[0];
    }

    if (activeTab === 'register') {
      if (password !== elConfirm.value) {
        showError('Passwords do not match.');
        return;
      }
      if (password.length < 8) {
        showError('Password must be at least 8 characters.');
        return;
      }
    }

    elSubmit.disabled = true;
    elSubmit.textContent = activeTab === 'login' ? 'Signing in...' : 'Creating account...';

    try {
      if (activeTab === 'login') {
        await login(username, password);
      } else {
        await register(username, password);
      }
      hideModal();
      showToast('Signed in as ' + escapeHtml(session.displayName || session.userId));
    } catch (err) {
      showError(err.message || 'Authentication failed.');
    } finally {
      elSubmit.disabled = false;
      elSubmit.textContent = activeTab === 'login' ? 'Sign In' : 'Create Account';
    }
  }

  elSubmit.addEventListener('click', handleSubmit);
  elPassword.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && activeTab === 'login') handleSubmit();
  });
  elConfirm.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') handleSubmit();
  });

  // ── Nav Bar Integration ────────────────────────────────────

  let navLi = null;       // <li> we inject
  let dropdownOpen = false;

  function updateNavUI() {
    // Remove previous nav element if present
    if (navLi && navLi.parentNode) {
      navLi.parentNode.removeChild(navLi);
    }

    var navLinks = document.querySelector('.nav-links');
    if (!navLinks) return;

    // Find the "Beta Access" item to insert before it
    var betaItem = null;
    var items = navLinks.querySelectorAll('li');
    for (var i = 0; i < items.length; i++) {
      var link = items[i].querySelector('a');
      if (link && (link.textContent.trim() === 'Beta Access' ||
                   (link.getAttribute('href') || '').indexOf('#buy') !== -1)) {
        betaItem = items[i];
        break;
      }
    }

    navLi = document.createElement('li');

    if (session.userId) {
      // Logged in state
      var displayLabel = escapeHtml(session.displayName || session.userId);
      navLi.innerHTML =
        '<div id="mx-auth-nav-user">' +
          '<span id="mx-auth-nav-user-label">' + displayLabel + '</span>' +
          '<div id="mx-auth-dropdown">' +
            '<button class="mx-auth-dropdown-item" data-action="profile">My Profile</button>' +
            '<button class="mx-auth-dropdown-item" data-action="openid">OpenID Token</button>' +
            '<div class="mx-auth-dropdown-divider"></div>' +
            '<button class="mx-auth-dropdown-item" data-action="signout">Sign Out</button>' +
          '</div>' +
        '</div>';

      if (betaItem) {
        navLinks.insertBefore(navLi, betaItem);
      } else {
        navLinks.appendChild(navLi);
      }

      // Dropdown toggle
      var userEl = document.getElementById('mx-auth-nav-user');
      var labelEl = document.getElementById('mx-auth-nav-user-label');
      labelEl.addEventListener('click', function(e) {
        e.stopPropagation();
        dropdownOpen = !dropdownOpen;
        userEl.classList.toggle('open', dropdownOpen);
      });

      // Dropdown actions
      var dropdownItems = navLi.querySelectorAll('.mx-auth-dropdown-item');
      dropdownItems.forEach(function(item) {
        item.addEventListener('click', function(e) {
          e.stopPropagation();
          dropdownOpen = false;
          userEl.classList.remove('open');
          var action = item.dataset.action;
          if (action === 'signout') {
            logout();
          } else if (action === 'openid') {
            handleCopyOpenId();
          } else if (action === 'profile') {
            showToast('User: ' + escapeHtml(session.userId));
          }
        });
      });

      // Close dropdown on outside click
      document.addEventListener('click', function closeDropdown() {
        if (dropdownOpen) {
          dropdownOpen = false;
          var el = document.getElementById('mx-auth-nav-user');
          if (el) el.classList.remove('open');
        }
      });

    } else {
      // Logged out state
      navLi.innerHTML = '<a id="mx-auth-nav-signin" href="javascript:void(0)">Sign In</a>';

      if (betaItem) {
        navLinks.insertBefore(navLi, betaItem);
      } else {
        navLinks.appendChild(navLi);
      }

      document.getElementById('mx-auth-nav-signin').addEventListener('click', showModal);
    }
  }

  async function handleCopyOpenId() {
    try {
      var tokenData = await getOpenIdToken();
      var tokenStr = JSON.stringify(tokenData);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(tokenStr);
        showToast('OpenID token copied to clipboard');
      } else {
        // Fallback for older browsers
        var ta = document.createElement('textarea');
        ta.value = tokenStr;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('OpenID token copied to clipboard');
      }
    } catch (err) {
      showToast('Failed to get OpenID token: ' + err.message);
    }
  }

  // ── Initialize ─────────────────────────────────────────────

  async function init() {
    if (session.userId) {
      // Validate the server-side session cookie is still live.
      var valid = await validateSession();
      if (!valid) {
        clearSession();
      }
    }
    updateNavUI();
    window.dispatchEvent(new CustomEvent('matrixAuthReady', { detail: { loggedIn: !!session.userId } }));
  }

  // Run init when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ── Public API ─────────────────────────────────────────────

  // NOTE: getAccessToken() is intentionally absent from the public API.
  // Exposing the raw Matrix token to any script on the page widens the XSS
  // exfiltration surface. Use getOpenIdToken() for delegated auth instead.
  // If you need authenticated Matrix API calls from game code, add a dedicated
  // method here that proxies the specific call without leaking the token.
  window.matrixAuth = {
    isLoggedIn: function() { return !!session.userId; },
    getUserId: function() { return session.userId; },
    getOpenIdToken: function() { return getOpenIdToken(); },
    getJoinedRooms: function() { return proxyFetch('GET', '/joined-rooms', undefined).then(function(d) { return d.joined_rooms || []; }).catch(function() { return []; }); },
    getProfile: function(userId) { return apiGetProfile(userId); },
    login: function(user, pass) { return login(user, pass); },
    logout: function() { return logout(); },
    showLoginModal: function() { showModal(); },
  };

})();
