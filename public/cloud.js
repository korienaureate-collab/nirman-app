/* ============================================================
   Nirman Ledger — Private Cross-Device Sync v2 (Supabase, encrypted)
   ------------------------------------------------------------
   - Books are encrypted in THIS browser (AES-256-GCM, key derived
     from your PIN with PBKDF2, 200k rounds) BEFORE leaving the device.
   - Row id = SHA-256 of the PIN; the PIN itself is never stored.
   - Same PIN on every device; devices pull the newest copy and push
     changes a few seconds after you make them.
   - v2 fixes: reads the app state through the app's real storage
     (kapl_nirman_v1) and its real S binding; skips re-uploading
     data that was just downloaded (no sync loops); shows v2 marker.
   ============================================================ */
(function () {
  'use strict';

  var CFG = window.NL_CLOUD_CONFIG || {};
  var BASE = String(CFG.url || '').replace(/\/+$/, '');
  var ANON = String(CFG.anon_key || '');
  var TABLE = String(CFG.table || 'nirman_sync');
  var APP_KEY = 'kapl_nirman_v1';          /* the app's own localStorage key */
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
  var lastPushHash = '';    /* skip re-upload of identical data */
  var lastApplyHash = '';   /* skip re-upload of just-downloaded data */

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
  function djb2(s) { var h = 5381, i; for (i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; } return String(h); }

  function toastSafe(m, bad) {
    try { if (typeof toast === 'function') toast(m, !!bad); } catch (e) {}
  }

  /* ---------- app state access ---------- */
  /* The app declares `let S` (global lexical binding, NOT window.S).
     Read order: live binding -> window.S -> the app's own localStorage. */
  function currentState() {
    try { if (typeof S !== 'undefined' && S && S.company) return S; } catch (e) {}
    try { if (window.S && window.S.company) return window.S; } catch (e) {}
    try {
      var raw = localStorage.getItem(APP_KEY);
      if (raw) { var j = JSON.parse(raw); if (j && j.company) return j; }
    } catch (e) {}
    return null;
  }
  /* Write the downloaded state back through the app's REAL S binding
     (indirect eval resolves the global lexical binding; window.S is
     only a fallback for app versions that expose it). */
  function setCurrentState(j) {
    window.__nlSyncData = j;
    var ok = false;
    try { (0, eval)('S = window.__nlSyncData'); ok = true; } catch (e) {}
    try { window.S = j; } catch (e) {}
    return ok;
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
      return { v: 2, salt: bytesToHex(salt), iv: bytesToHex(iv), ct: bytesToHex(new Uint8Array(ct)) };
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
    var st = currentState();
    if (!st) throw new Error('no data to upload yet');
    var json = JSON.stringify(st);
    var h = djb2(json);
    if (h === lastPushHash || h === lastApplyHash) {
      return Promise.resolve();   /* nothing new — do not touch the server row */
    }
    var now = new Date().toISOString();
    return seal(st, p).then(function (payload) {
      return sha256Hex(p).then(function (id) {
        return api(TABLE + '?on_conflict=pin', {
          method: 'POST',
          headers: { 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify([{ pin: id, payload: payload, updated_at: now }])
        });
      });
    }).then(function (r) {
      if (!r.ok) throw new Error('save failed (server ' + r.status + ')');
      lastPushHash = h;
      setStateTs(now);
    });
  }

  /* ---------- apply cloud data to the app ---------- */
  function applyState(data) {
    if (!data || !data.company) throw new Error('data not recognised');
    if (!data.lb) data.lb = {};
    ['murum', 'gitti', 'msand', 'hava', 'dumper'].forEach(function (k) { if (!data.lb[k]) data.lb[k] = []; });
    setCurrentState(data);
    lastApplyHash = djb2(JSON.stringify(data));
    try {
      if (typeof save === 'function') save();       /* persists to localStorage + triggers a (skipped) push */
      if (typeof render === 'function') render();
      if (typeof logAudit === 'function') logAudit('C', 'CloudSync', '—', 'Loaded from private cloud');
    } catch (e) { console.error('[NL sync] applyState', e); }
  }

  /* ---------- polling / auto sync ---------- */
  function pollOnce(silent) {
    if (!pin || pulling || pendingPush) return Promise.resolve();
    pulling = true;
    return pull(pin).then(function (row) {
      if (row && row.updated_at > stateTs()) {
        return unseal(row.payload, pin).then(function (data) {
          var h = djb2(JSON.stringify(data));
          var cur = currentState();
          var same = cur && djb2(JSON.stringify(cur)) === h;
          if (same) { setStateTs(row.updated_at); return; }  /* already have it */
          applyState(data);
          setStateTs(row.updated_at);
          toastSafe('🔄 Synced latest data from cloud');
        });
      }
    }).catch(function (e) {
      if (!silent) console.warn('[NL sync] poll failed:', e.message);
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
        console.warn('[NL sync] push failed:', e.message);
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
        pin = p;
        localStorage.setItem(LS_PIN, p);
        setUI(true);
        if (!currentState()) {
          msg('🟢 Auto-sync ON — will upload as soon as there is data.');
          startPolling();
          return null;
        }
        return push(p).then(function () {
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
      '<div style="font-weight:600;font-size:12.5px;margin-bottom:8px">🔒 Private auto-sync v2 — end-to-end encrypted</div>' +
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

  /* The app is a single-page app: #cloudSyncStatus exists only while the
     Company & Backup page is rendered. Watch the DOM and inject the box
     the moment the section appears (also survives re-renders). */
  function watchUI() {
    injectUI();
    if (uiWatchStarted) return;
    uiWatchStarted = true;
    var mo = new MutationObserver(function () { injectUI(); });
    mo.observe(document.body, { childList: true, subtree: true });
    setInterval(function () { injectUI(); }, 1500);
  }

  /* ---------- boot ---------- */
  function boot() {
    console.log('[NL sync] nl-v2 loaded, configured=' + configured);
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
