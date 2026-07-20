// ============================================================
// context-menu — Terminal right-click menu + output pins list
//
// Phase 2: Extracts showContextMenu, hideContextMenu,
// copySelection, pinSelectedOutput, searchSelection,
// pasteClipboard, renderPinnedList from app.js.
// Auto-patches QCLI namespace at import time.
// ============================================================
// @ts-check
'use strict';

/** @typedef {import('../types').QCLI} QCLI */
/** @typedef {{id:string,text:string,pin?:any}} PinItem */
/** @typedef {{label:string,action:(selection:string,term:any)=>void}} PluginMenuItem */

/** @returns {QCLI} */
function Q() { return /** @type {QCLI} */ (window.QCLI || {}); }

// ── Helpers ──

function termAccessor() {
  const tabs = Q().Tabs;
  return tabs ? tabs.term : null;
}

function wsSend(data) {
  const fn = Q().wsSend;
  if (fn) fn(data);
}

/** @param {string} msg @param {string} [type] */
function showToast(msg, type) {
  const fn = Q().showToast;
  if (fn) fn(msg, type);
}

// ── State ──
/** @type {string} */
var currentPinText = '';

// ============================================================
// Show / hide
// ============================================================

/**
 * Show context menu at position
 * @param {number} x
 * @param {number} y
 * @param {string} [selection]
 */
export function showContextMenu(x, y, selection) {
  const menu = document.getElementById('terminal-context-menu');
  if (!menu) return;
  currentPinText = selection || '';

  var hasSel = !!selection;
  menu.querySelectorAll('.ctx-copy, .ctx-pin, .ctx-search-sel, .ctx-divider-sel')
    .forEach(function(el) { el.classList.toggle('hidden', !hasSel); });
  menu.querySelectorAll('.ctx-paste, .ctx-clear, .ctx-search')
    .forEach(function(el) { el.classList.toggle('hidden', hasSel); });

  // ── Inject plugin menu items dynamically ──
  injectPluginMenuItems(menu, hasSel);

  // Clamp to viewport
  var menuW = Math.min(200, window.innerWidth - 16);
  var left = Math.min(x, window.innerWidth - menuW);
  var menuH = menu.scrollHeight || 180;
  var top = Math.min(y, window.innerHeight - menuH - 8);

  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.classList.remove('hidden');
}

// ── Plugin menu injection ──
/**
 * @param {HTMLElement} menu
 * @param {boolean} hasSelection
 */
function injectPluginMenuItems(menu, hasSelection) {
  var UIR = Q().UIRegistry;
  if (!UIR) return;

  var items = UIR.getMenuItemsForContext(hasSelection);
  if (items.length === 0) return;

  // Remove previously injected items (cleanup before rebuild)
  var existing = menu.querySelectorAll('.ctx-plugin');
  existing.forEach(function(el) { el.remove(); });

  // Add divider before plugin items
  var divider = document.createElement('div');
  divider.className = 'ctx-divider ctx-plugin';
  menu.appendChild(divider);

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var el = document.createElement('div');
    el.className = 'ctx-item ctx-plugin';
    el.textContent = item.label;      el.addEventListener('click', function(it) {
        return function() {
          hideContextMenu();
          var term = termAccessor();
          try { it.action(currentPinText, term); } catch (e) {
            console.warn('[ContextMenu] Plugin action error:', e);
          }
        };
      }(/** @type {PluginMenuItem} */ (item)));
    menu.appendChild(el);
  }
}

export function hideContextMenu() {
  var menu = document.getElementById('terminal-context-menu');
  if (menu) menu.classList.add('hidden');
}

// ============================================================
// Actions
// ============================================================

export function copySelection() {
  hideContextMenu();
  var term = termAccessor();
  if (!term) return;
  var selection = term.getSelection();
  if (selection) {
    navigator.clipboard.writeText(selection).catch(function(err) {
      console.warn('[Clipboard] Copy failed:', /** @type {Error} */ (err).message);
    });
    term.clearSelection();
  }
}

export async function pinSelectedOutput() {
  if (!currentPinText) return;
  var store = Q().PinStore;
  if (!store) return;
  var activeTab = Q().Tabs ? Q().Tabs.activeTabId : null;
  var tab = activeTab && Q().Tabs ? Q().Tabs.getTab(activeTab) : null;
  var title = prompt('Pin title (optional):', tab && tab.name ? 'Output from ' + tab.name : '');
  await store.add(
    currentPinText.replace(/(?:[@-Z\-_]|[[0-?]*[ -/]*[@-~])/g, '').trim(),
    tab && tab.cliId || '',
    tab && tab.name || '',
    title || ''
  );
  hideContextMenu();
  showToast('📌 ' + ('已固定到输出剪贴板'), 'success');
  await renderPinnedList();
}

export function searchSelection() {
  if (!currentPinText) { hideContextMenu(); return; }
  hideContextMenu();
  var searchBar = document.getElementById('terminal-search-bar');
  var searchInput = document.getElementById('terminal-search-input');
  var searchResults = document.getElementById('terminal-search-results');
  if (searchBar) searchBar.classList.remove('hidden');
  if (searchInput) {
    searchInput.value = currentPinText;
    searchInput.focus();
  }
  // Trigger search
  var addon = Q().searchAddon;
  if (addon && searchResults) {
    addon.clearActiveSearch();
    var found = addon.findNext(currentPinText, { incremental: false });
    searchResults.textContent = found ? '🔍 1+' : '✗';
  }
}

export function pasteClipboard() {
  hideContextMenu();
  navigator.clipboard.readText().then(function(text) {
    if (text) wsSend({ type: 'input', data: text });
  }).catch(function(err) {
    console.warn('[Clipboard] Right-click paste failed:', /** @type {Error} */ (err).message);
  });
}

export async function renderPinnedList() {
  // Delegate to PinReport if available
  if (Q().PinReport && Q().PinReport.renderPinnedList) {
    return Q().PinReport.renderPinnedList();
  }
  // Fallback
  var container = document.getElementById('pinned-list');
  var section = document.getElementById('pinned-section');
  if (!container || !section) return;
  var store = Q().PinStore;
  if (!store) { section.classList.add('hidden'); return; }

  var pins = await store.getAll();
  if (pins.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  container.innerHTML = '';
  for (var i = 0; i < pins.length; i++) {
    var pin = pins[i];
    (function(pinId, pinText) {
      var el = document.createElement('div');
      el.className = 'pin-item';

      var text = document.createElement('span');
      text.className = 'pin-item-text';
      text.textContent = pinText.slice(0, 200);
      el.appendChild(text);

      var removeBtn = document.createElement('button');
      removeBtn.className = 'pin-item-remove';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', async function(e) {
        e.stopPropagation();
        await store.remove(pinId);
        await renderPinnedList();
      });
      el.appendChild(removeBtn);

      el.addEventListener('click', function() {
        navigator.clipboard.writeText(/** @type {string} */ (pinText)).catch(function() {});
        showToast('📋 ' + ('已复制到剪贴板'), 'success');
      });

      container.appendChild(el);
    })(pin.id, pin.text);
  }
}

// ============================================================
// Notification permission (small utility kept adjacent)
// ============================================================
export function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

// ============================================================
// Auto-init — patch onto QCLI for backward compat
// ============================================================
Promise.resolve().then(function() {
  var q = Q();
  q.showContextMenu = showContextMenu;
  q.hideContextMenu = hideContextMenu;
  q.requestNotificationPermission = requestNotificationPermission;
  q.copySelection = copySelection;
  q.pinSelectedOutput = pinSelectedOutput;
  q.searchSelection = searchSelection;
  q.pasteClipboard = pasteClipboard;
  q.renderPinnedList = renderPinnedList;
});
