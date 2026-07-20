// ============================================================
// session-restore — Saved terminal tab restoration overlay
//
// Extracted from app.js: checkSavedSessions + formatSessionTime
// plus overlay event wiring.
// Auto-patches QCLI namespace at import time.
// ============================================================
// @ts-check
'use strict';

/** @typedef {import('../types').QCLI} QCLI */

/** @returns {QCLI} */
function Q() { return /** @type {QCLI} */ (window.QCLI || {}); }

/** @param {Date} date */
function formatSessionTime(date) {
  var now = Date.now();
  var diffMs = now - date.getTime();
  var diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return diffMin + "m ago";
  var diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return diffHr + "h ago";
  var diffDay = Math.floor(diffHr / 24);
  return diffDay + "d ago";
}

async function checkSavedSessions() {
  // Wait for CLIs to finish loading
  await new Promise(function(r) { setTimeout(r, 500); });
  if (!Q().SessionStore) return;
  try {
    var sessions = await Q().SessionStore.loadAllSessions();
    if (!sessions || sessions.length === 0) {
      // No saved sessions — auto-launch default CLI
      if (Q().launchDefaultCLI) Q().launchDefaultCLI();
      return;
    }

    var overlay = document.getElementById("session-restore-overlay");
    var list = document.getElementById("session-restore-list");
    var countEl = document.getElementById("session-restore-count");
    if (!overlay || !list) return;

    // Update count
    if (countEl) countEl.textContent = sessions.length + " tab" + (sessions.length > 1 ? "s" : "");

    // Populate list
    list.innerHTML = "";
    sessions.forEach(function(session) {
      var item = document.createElement("div");
      item.className = "session-restore-item selected";
      item.dataset.tabId = session.tabId;

      // Icon
      var icon = document.createElement("span");
      icon.className = "sr-item-icon";
      icon.textContent = session.icon || "\u25B6";
      item.appendChild(icon);

      // Info
      var info = document.createElement("div");
      info.className = "sr-item-info";

      var name = document.createElement("div");
      name.className = "sr-item-name";
      name.textContent = session.name || session.cliId || "Terminal";
      info.appendChild(name);

      var meta = document.createElement("div");
      meta.className = "sr-item-meta";

      var timeStr = session.timestamp ? formatSessionTime(new Date(session.timestamp)) : "";
      var timeSpan = document.createElement("span");
      timeSpan.className = "sr-item-time";
      timeSpan.textContent = timeStr;
      meta.appendChild(timeSpan);

      var bufSize = session.buffer ? session.buffer.length : 0;
      var sizeSpan = document.createElement("span");
      sizeSpan.textContent = bufSize > 0 ? (bufSize / 1024).toFixed(0) + "KB" : "(empty)";
      sizeSpan.style.cssText = "font-size:9px;opacity:0.5";
      meta.appendChild(sizeSpan);

      info.appendChild(meta);
      item.appendChild(info);

      // Checkbox
      var checkbox = document.createElement("span");
      checkbox.className = "sr-item-checkbox";
      checkbox.textContent = "\u2713";
      item.appendChild(checkbox);

      // Click to toggle selection
      item.addEventListener("click", function() {
        item.classList.toggle("selected");
        var check = item.querySelector(".sr-item-checkbox");
        if (check) {
          check.textContent = item.classList.contains("selected") ? "\u2713" : "";
        }
      });

      list.appendChild(item);
    });

    // Wire up buttons
    var ignoreBtn = document.getElementById("session-restore-ignore");
    var restoreBtn = document.getElementById("session-restore-all");

    if (ignoreBtn) {
      ignoreBtn.onclick = function() {
        overlay.classList.add("hidden");
        // Auto-launch default CLI when user dismisses session restore
        if (Q().launchDefaultCLI) Q().launchDefaultCLI();
      };
    }

    if (restoreBtn) {
      restoreBtn.onclick = function() {
        var selectedItems = list.querySelectorAll(".session-restore-item.selected");
        var selectedSessions = [];
        selectedItems.forEach(function(el) {
          var s = sessions.find(function(sess) { return sess.tabId === el.dataset.tabId; });
          if (s) selectedSessions.push(s);
        });

        if (selectedSessions.length > 0 && Q().Tabs) {
          Q().Tabs.restoreSessions(selectedSessions);
          // Set pending init for each restored tab
          for (var i = 0; i < selectedSessions.length; i++) {
            var s = selectedSessions[i];
            if (s.init && Q()._pendingInit) Q()._pendingInit.set(s.cliId, s.init);
          }
        }
        overlay.classList.add("hidden");
        if (Q().SessionStore) {
          Q().SessionStore.clearAllSessions();
        }
      };
    }

    // Show overlay
    overlay.classList.remove("hidden");
  } catch (e) {
    console.warn("[SessionStore] Check error:", /** @type {Error} */ (e).message);
  }
}

// ============================================================
// Auto-init — patch onto QCLI for backward compat
// ============================================================
Promise.resolve().then(function() {
  var q = Q();
  q.checkSavedSessions = checkSavedSessions;
});
