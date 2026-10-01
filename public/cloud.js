/* ============================================================
   Nirman Ledger — Private Cross-Device Sync (Supabase, encrypted)
   ------------------------------------------------------------
   Loaded automatically by the app when cloud-config.js defines
   window.NL_CLOUD_CONFIG.

   How it works
   - Your books are encrypted in THIS browser (AES-256-GCM, key derived
     from your PIN with PBKDF2, 200,000 rounds) BEFORE anything leaves
     the device. The server only ever stores unreadable ciphertext.
   - The row id is a SHA-256 hash of your PIN, so the raw PIN is never
     stored on the server either.
   - Same PIN on every device -> each device pulls the newest copy and
     pushes your changes a few seconds after you make them.
   - Last saved wins: avoid editing on two devices offline at the same
     time. Keep the PIN safe — without it the cloud data cannot be
     decrypted by anyone (there is no recovery backdoor).
   ============================================================ */
(function () {
  'use strict';

  var CFG = window.NL_CLOUD_CONFIG || {};
  var BASE = String(CFG.url || '').replace(/\/+$/, '');
  var ANON = String(CFG.anon_key || '');
  var TABLE = String(CFG.table || 'nirman_sync');
  var LS_PIN = 'nl_sync_pin';
  var LS_TS = 'nl_sync_state_ts';

  var configured = /^https?:\/\/.+\..+/.test(BASE) &&
                   ANON.length > 50 &&
                   !/PASTE/i.test(BASE + ANON);

  var pin = localStorage.getItem(LS_PIN) || '';
  var pushTimer = null;
  var pendingPush = false;
  var pollTimer = null;
  var pulling = false;
  var uiWatchStarted = false;

  /* ---------- tiny helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function bytesToHex(b) {
    var s = '';
    for (var i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
    return s;
  }
  function hexToBytes(h) {
    var a = new Uint8Array(h.length / 2);
    for (var i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
    return a;
  }
  function stateTs() { return localStorage.getItem(LS_TS) || ''; }
  function setStateTs(t) { localStorage.setItem(LS_TS, t); }

  function toastSafe(m, bad) {
    try { if (typeof toast === 'function') toast(m, !!bad); } catch (e) {}
  }

  /* ---------- crypto ---------- */
  function deriveKey(p, saltHex) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(p), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: 200000, hash: 'SHA-256' },
          base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
  }
  function sha256Hex(str) {
    var enc = new TextEncoder();
    return crypto.subtle.digest('SHA-256', enc.encode('nl1:' + str))
      .then(function (buf) { return bytesToHex(new Uint8Array(buf)); });
  }
  function seal(obj, p) {
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return deriveKey(p, bytesToHex(salt)).then(function (key) {
      return crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv }, key,
        new TextEncoder().encode(JSON.stringify(obj)));
    }).then(function (ct) {
      return { v: 1, salt: bytesToHex(salt), iv: bytesToHex(iv), ct: bytesToHex(new Uint8Array(ct)) };
    });
  }
  function unseal(pkg, p) {
    return deriveKey(p, pkg.salt).then(function (key) {
      return crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: hexToBytes(pkg.iv) }, key, hexToBytes(pkg.ct));
    }).then(function (pt) {
      return JSON.parse(new TextDecoder().decode(pt));
    });
  }

  /* ---------- Supabase REST ---------- */
  function api(path, opts) {
    var o = opts || {};
    o.headers = Object.assign({
      'apikey': ANON,
      'Authorization': 'Bearer ' + ANON,
      'Content-Type': 'application/json'
    }, o.headers || {});
    return fetch(BASE + '/rest/v1/' + path, o);
  }
  function pull(p) {
    return sha256Hex(p).then(function (id) {
      return api(TABLE + '?pin=eq.' + id + '&select=payload,updated_at&limit=1');
    }).then(function (r) {
      if (!r.ok) throw new Error('server ' + r.status);
      return r.json();
    }).then(function (rows) { return rows && rows.length ? rows[0] : null; });
  }
  function push(p) {
    if (!window.S) throw new Error('app state not ready');
    var now = new Date().toISOString();
    return seal(window.S, p).then(function (payload) {
      return sha256Hex(p).then(function (id) {
        return api(TABLE + '?on_conflict=pin', {
          method: 'POST',
          headers: { 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify([{ pin: id, payload: payload, updated_at: now }])
        });
      });
    }).then(function (r) {
      if (!r.ok) throw new Error('save failed (server ' + r.status + ')');
      setStateTs(now);
    });
  }

  /* ---------- apply cloud data to the app ---------- */
  function applyState(j) {
    if (!j || !j.company) throw new Error('data not recognised');
    if (!j.lb) j.lb = {};
    ['murum', 'gitti', 'msand', 'hava', 'dumper'].forEach(function (k) { if (!j.lb[k]) j.lb[k] = []; });
    window.S = j;
    try {
      var lbE = ['msand', 'gitti', 'hava', 'dumper', 'murum']
        .every(function (k) { return !window.S.lb[k] || !window.S.lb[k].length; });
      if (lbE && typeof migrateTripsToLb === 'function') migrateTripsToLb();
      if (typeof save === 'function') save();
      if (typeof render === 'function') render();
      if (typeof logAudit === 'function') logAudit('C', 'CloudSync', '—', 'Loaded from private cloud');
    } catch (e) { console.error('applyState', e); }
  }

  /* ---------- polling / auto sync ---------- */
  function pollOnce(silent) {
    if (!pin || pulling || pendingPush) return Promise.resolve();
    pulling = true;
    return pull(pin).then(function (row) {
      if (row && row.updated_at > stateTs()) {
        return unseal(row.payload, pin).then(function (data) {
          applyState(data);
          setStateTs(row.updated_at);
          toastSafe('🔄 Synced latest data from cloud');
        });
      }
    }).catch(function (e) {
      if (!silent) console.warn('sync poll failed:', e.message);
    }).finally(function () { pulling = false; });
  }
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () { pollOnce(true); }, 60000);
    window.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') pollOnce(true);
    });
  }

  /* the app calls this after every change (debounced push) */
  window.cloudScheduleSync = function () {
    if (!pin || !configured) return;
    pendingPush = true;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      push(pin).then(function () {
        pendingPush = false;
        setUI(true);
      }).catch(function (e) {
        pendingPush = false;
        console.warn('sync push failed:', e.message);
      });
    }, 4000);
  };

  /* ---------- settings UI ---------- */
  function setUI(on) {
    var b = $('nlSyncBtn'), off = $('nlSyncOff'), inp = $('nlSyncPin');
    if (!b) return;
    b.textContent = on ? '⬆ Sync now' : 'Enable';
    if (off) off.style.display = on ? '' : 'none';
    if (inp && on) inp.value = pin;
  }
  function msg(t, bad) {
    var el = $('nlSyncMsg');
    if (el) { el.textContent = t; el.style.color = bad ? 'var(--crit)' : 'var(--muted)'; }
    try { if (typeof cloudStatus === 'function' && t) cloudStatus(t, !bad); } catch (e) {}
  }

  function enableSync() {
    var p = (($('nlSyncPin') || {}).value || '').trim();
    if (p.length < 6) { msg('Use a PIN of at least 6 characters (letters + numbers is best).', true); return; }
    var b = $('nlSyncBtn'); if (b) { b.disabled = true; b.textContent = '…'; }
    msg('Connecting…');
    pull(p).then(function (row) {
      if (row) {
        var when;
        try { when = new Date(row.updated_at).toLocaleString(); } catch (e) { when = 'unknown time'; }
        if (!confirm('Cloud data found (saved ' + when + ').\n\nLoad it on this device and replace what is here now?')) {
          if (b) { b.disabled = false; setUI(!!pin); }
          msg('Cancelled.');
          return null;
        }
        return unseal(row.payload, p).then(function (data) {
          applyState(data);
          setStateTs(row.updated_at);
          pin = p;
          localStorage.setItem(LS_PIN, p);
          setUI(true);
          msg('🟢 Auto-sync ON — cloud data loaded. Use the same PIN on your other devices.');
          toastSafe('✅ Auto-sync enabled');
          startPolling();
        }).catch(function () {
          msg('Wrong PIN — the existing cloud data could not be decrypted with it.', true);
        });
      } else {
        return push(p).then(function () {
          pin = p;
          localStorage.setItem(LS_PIN, p);
          setUI(true);
          msg('🟢 Auto-sync ON — your data is uploaded (encrypted). Use the same PIN on your other devices.');
          toastSafe('✅ Auto-sync enabled');
          startPolling();
        });
      }
    }).catch(function (e) {
      msg('Sync failed: ' + e.message, true);
    }).finally(function () {
      if (b) b.disabled = false;
    });
  }

  function disableSync() {
    pin = '';
    localStorage.removeItem(LS_PIN);
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    setUI(false);
    msg('Auto-sync stopped on this device. Your local data is untouched.');
  }

  function injectUI() {
    var host = $('cloudSyncStatus');
    if (!host || $('nlSyncBtn')) return;
    var box = document.createElement('div');
    box.style.cssText = 'margin:10px 0;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface-2)';
    box.innerHTML =
      '<div style="font-weight:600;font-size:12.5px;margin-bottom:8px">🔒 Private auto-sync — end-to-end encrypted</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
      '<input id="nlSyncPin" type="password" autocomplete="off" placeholder="Sync PIN (6+ characters)" ' +
      'style="flex:1;min-width:150px;padding:7px 10px;border:1px solid var(--line-2);border-radius:6px;background:var(--surface);color:var(--ink);font-family:var(--mono);font-size:13px">' +
      '<button id="nlSyncBtn" class="btn pri" style="padding:7px 14px">Enable</button>' +
      '<button id="nlSyncOff" class="btn" style="padding:7px 14px;display:none">Stop</button>' +
      '</div><div id="nlSyncMsg" style="font-size:11.5px;margin-top:7px;color:var(--muted)"></div>';
    host.parentNode.insertBefore(box, host.nextSibling);
    $('nlSyncBtn').addEventListener('click', function () {
      if (pin) {
        pendingPush = false;
        window.cloudScheduleSync();
        msg('Uploading current data…');
      } else {
        enableSync();
      }
    });
    $('nlSyncOff').addEventListener('click', disableSync);
    if (pin) {
      setUI(true);
      msg('🟢 Auto-sync is ON (PIN saved). Data syncs automatically.');
      startPolling();
      pollOnce(true);
    }
  }

  /* The app is a single-page app: the Cloud Sync section (#cloudSyncStatus)
     is created only when the user opens Company & Backup — possibly long
     after this module runs. Watch the DOM and inject the box the moment
     the section appears (also covers re-renders that wipe the box). */
  function watchUI() {
    injectUI();
    if (uiWatchStarted) return;
    uiWatchStarted = true;
    var mo = new MutationObserver(function () { injectUI(); });
    mo.observe(document.body, { childList: true, subtree: true });
    /* belt-and-braces in case MutationObserver is unavailable */
    setInterval(function () { injectUI(); }, 1500);
  }

  /* ---------- boot ---------- */
  function boot() {
    if (!configured) {
      console.warn('[NL sync] cloud-config.js has no Supabase keys yet — sync stays off.');
      return;
    }
    watchUI();
    if (pin) {
      pull(pin).then(function (row) {
        if (row && row.updated_at > stateTs()) {
          return unseal(row.payload, pin).then(function (data) {
            applyState(data);
            setStateTs(row.updated_at);
            toastSafe('🔄 Loaded latest data from cloud');
          }).catch(function () {
            console.warn('[NL sync] saved PIN no longer decrypts cloud data');
          });
        } else if (!row) {
          return push(pin);
        }
      }).catch(function (e) { console.warn('[NL sync] boot sync failed:', e.message); });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
