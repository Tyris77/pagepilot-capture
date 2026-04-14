/**
 * PagePilot Capture — Service Worker (v1.1 — Production Hardened)
 * ─────────────────────────────────────────────────────────────────────────────
 * Pipeline:
 *   1. Toolbar-icon click or keyboard shortcut fires initiateCapture().
 *   2. Capture lock prevents concurrent captures.
 *   3. Content script injected → page metrics collected.
 *   4. Sequential scroll-and-capture loop with rate-limiting.
 *   5. Slices written to chrome.storage.session (fallback: local).
 *   6. results.html tab opened — reads & clears storage directly.
 */

'use strict';

/* ─── Constants ─────────────────────────────────────────────────────────────── */

const SCROLL_SETTLE_MS       = 300;    // ms after scroll before capturing
const CAPTURE_MIN_GAP_MS     = 750;    // enforced floor between captureVisibleTab calls
                                       // Chrome quota ≈ 2 calls/sec; 750 ms is safe
const CAPTURE_RETRY_DELAY_MS = 1200;  // back-off before quota-error retry
const OVERLAP_PX             = 60;    // px overlap between consecutive frames
const MAX_SLICES             = 200;   // hard upper bound on capture frames
const MAX_PAGE_HEIGHT        = 30000; // logical px cap — avoids runaway infinite-scroll

// TTL embedded in the stored payload so the results page can self-expire stale data
// without relying on a timer in the service worker.
const DATA_TTL_MS            = 5 * 60 * 1000; // 5 minutes

// Storage key shared between the service worker and results.js.
const STORAGE_KEY            = 'pp_capture';

/* ─── Runtime State ──────────────────────────────────────────────────────────── */

// Capture lock — prevents a second capture starting while one is in progress.
// Safe to use as a plain boolean; the JS event loop is single-threaded.
let captureInProgress = false;

// Tracks when the last captureVisibleTab() call was made so the rate-limiter
// works correctly even across back-to-back captures.
let lastCaptureCallMs = 0;

/* ─── Storage Abstraction ────────────────────────────────────────────────────── */

/**
 * Returns the preferred storage area in priority order:
 *   1. chrome.storage.session  — survives SW restarts, auto-clears with session.
 *      Available since Chrome 102. Has a 10 MB quota.
 *   2. chrome.storage.local    — persistent fallback. Has a 5 MB quota.
 *
 * We pick session by default and fall back gracefully so the extension works
 * on any Chrome version.
 */
function getStorageArea() {
  return (typeof chrome.storage.session !== 'undefined')
    ? chrome.storage.session
    : chrome.storage.local;
}

/**
 * Write capture payload to storage.
 * Embeds an expiresAt timestamp so results.js can discard stale payloads
 * without needing a timer inside the service worker.
 *
 * Throws a descriptive Error if the quota is exceeded (payload too large).
 */
async function storeCapture(data) {
  const payload = { ...data, expiresAt: Date.now() + DATA_TTL_MS };
  const area    = getStorageArea();

  try {
    await area.set({ [STORAGE_KEY]: payload });
  } catch (err) {
    // Surface quota errors with a helpful message rather than a raw exception.
    if (err.message?.toLowerCase().includes('quota')) {
      throw new Error(
        'The screenshot is too large to store — the page may have too many slices. ' +
        `Try capturing a shorter page. (Original error: ${err.message})`
      );
    }
    throw err;
  }
}

/**
 * Remove capture payload from storage (called by results.js after reading,
 * but also available for cleanup on error paths).
 */
async function clearStoredCapture() {
  try {
    await getStorageArea().remove(STORAGE_KEY);
  } catch (_) {
    // Non-critical — ignore removal failures.
  }
}

/* ─── Entry Points ───────────────────────────────────────────────────────────── */

chrome.action.onClicked.addListener((tab) => {
  initiateCapture(tab);
});

/**
 * Keyboard shortcut handler.
 * We ALWAYS query the active tab ourselves and never rely on the optional `tab`
 * argument that Chrome passes, because its presence is unreliable across
 * Chrome versions and the command may arrive while a different window is focused.
 */
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'capture-full-page') return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
    if (activeTab) initiateCapture(activeTab);
  });
});

/* ─── Capture Pipeline ───────────────────────────────────────────────────────── */

async function initiateCapture(tab) {

  // ── Capture lock ────────────────────────────────────────────────────────────
  if (captureInProgress) {
    console.warn('[PagePilot] Capture already in progress — ignoring duplicate trigger.');
    return;
  }
  captureInProgress = true;

  try {
    await runCapture(tab);
  } finally {
    // Always release the lock, even if an unexpected exception escapes.
    captureInProgress = false;
  }
}

async function runCapture(tab) {
  if (!isCapturableTab(tab)) {
    await openResultsWithError(
      'Cannot capture this page — Chrome system pages and extension pages are restricted.'
    );
    return;
  }

  try {
    // ── Inject content script ────────────────────────────────────────────────
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files:  ['content-script.js'],
    });

    // ── Collect page metrics ─────────────────────────────────────────────────
    const metrics = await msgTab(tab.id, { type: 'PP_GET_METRICS' });
    if (metrics.error) throw new Error(metrics.error);

    const { totalHeight, viewportWidth, viewportHeight, devicePixelRatio, originalScrollY } = metrics;

    // ── Height cap ───────────────────────────────────────────────────────────
    const pageTruncated = totalHeight > MAX_PAGE_HEIGHT;
    const captureHeight = pageTruncated ? MAX_PAGE_HEIGHT : totalHeight;

    // ── Prepare page ─────────────────────────────────────────────────────────
    await msgTab(tab.id, { type: 'PP_PREPARE' });

    const slices  = [];
    let targetY   = 0;
    let slicesCapped = false;

    // ── Sequential scroll-and-capture loop ───────────────────────────────────
    // Steps within each iteration are fully awaited in order:
    //   scroll → settle → read actual position → rate-limited capture → store
    // No iteration begins until the previous one fully resolves.
    while (true) {
      // 1. Scroll to target position (instant, no smooth animation).
      await msgTab(tab.id, { type: 'PP_SCROLL', y: targetY });

      // 2. Wait for layout and lazy content to settle.
      await sleep(SCROLL_SETTLE_MS);

      // 3. Read actual scrollY — browser clamps near the page bottom.
      const { scrollY: actualY } = await msgTab(tab.id, { type: 'PP_GET_SCROLL' });

      // 4. Throttled capture with one automatic retry on quota error.
      const dataUrl = await captureVisibleTabSafe(tab.windowId);

      slices.push({ dataUrl, scrollY: actualY, viewportWidth, viewportHeight });

      // 5. Stop if the viewport bottom has reached or passed the capture boundary.
      if (actualY + viewportHeight >= captureHeight) break;

      // 6. Advance one viewport minus the overlap.
      const nextY = actualY + viewportHeight - OVERLAP_PX;
      if (nextY >= captureHeight) break;

      // 7. Enforce the slice cap before advancing.
      if (slices.length >= MAX_SLICES) {
        slicesCapped = true;
        break;
      }

      targetY = nextY;
    }
    // ── End of loop ──────────────────────────────────────────────────────────

    // ── Restore page ─────────────────────────────────────────────────────────
    await msgTab(tab.id, { type: 'PP_RESTORE', originalScrollY });

    // ── Build warnings for user-facing display ───────────────────────────────
    const warnings = [];
    if (pageTruncated) {
      warnings.push(
        `Page height (${totalHeight.toLocaleString()}px) exceeded the ${MAX_PAGE_HEIGHT.toLocaleString()}px ` +
        `capture limit — the bottom portion was not captured.`
      );
    }
    if (slicesCapped) {
      warnings.push(
        `Capture stopped after ${MAX_SLICES} slices to avoid excessive memory use. ` +
        `The lower part of the page may be missing.`
      );
    }

    // ── Write to storage ─────────────────────────────────────────────────────
    await storeCapture({
      slices,
      totalHeight:     captureHeight,
      viewportWidth,
      viewportHeight,
      devicePixelRatio,
      pageTitle:       tab.title || 'Untitled Page',
      pageUrl:         tab.url   || '',
      capturedAt:      new Date().toISOString(),
      warnings,        // surfaced in the results page UI
      sourceTabId:     tab.id,   // used by the Site Audit feature to re-contact the page
    });

    openResultsPage();

  } catch (err) {
    console.error('[PagePilot] Capture error:', err);

    // Best-effort page restore so we don't leave the page broken.
    try { await msgTab(tab.id, { type: 'PP_RESTORE' }); } catch (_) {}

    await openResultsWithError(err.message || 'An unexpected error occurred during capture.');
  }
}

/* ─── Helpers ────────────────────────────────────────────────────────────────── */

/**
 * Returns true for any normal web page the extension can inject into.
 */
function isCapturableTab(tab) {
  if (!tab || !tab.url) return false;
  return !tab.url.match(/^(chrome|chrome-extension|edge|about|devtools|data|javascript):/i);
}

/**
 * Promisified chrome.tabs.sendMessage.
 */
function msgTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Simple Promise-based delay.
 * Used for scroll-settle waits and rate-limit back-offs.
 * setTimeout here is intentional and appropriate — these are capture-loop
 * timing delays, not critical cleanup logic.
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Rate-limited wrapper around chrome.tabs.captureVisibleTab().
 *
 * Chrome enforces ~2 calls/second. This helper:
 *   1. Computes elapsed time since the previous capture call.
 *   2. Sleeps for the remainder of CAPTURE_MIN_GAP_MS if needed.
 *   3. On a quota error, backs off CAPTURE_RETRY_DELAY_MS and retries once.
 *   4. Stamps lastCaptureCallMs so every call self-throttles correctly.
 */
async function captureVisibleTabSafe(windowId) {
  const elapsed = Date.now() - lastCaptureCallMs;
  if (elapsed < CAPTURE_MIN_GAP_MS) {
    await sleep(CAPTURE_MIN_GAP_MS - elapsed);
  }

  try {
    lastCaptureCallMs = Date.now();
    return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  } catch (err) {
    const isQuota =
      err.message?.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND') ||
      err.message?.includes('quota');

    if (isQuota) {
      console.warn('[PagePilot] Quota hit — backing off 1200 ms and retrying…');
      await sleep(CAPTURE_RETRY_DELAY_MS);
      lastCaptureCallMs = Date.now();
      // Retry once. If it fails again the error propagates and aborts the capture.
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    }

    throw err; // non-quota error — propagate immediately
  }
}

/**
 * Open the results preview tab.
 * results.html reads its own data from storage — no message passing needed.
 */
function openResultsPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL('results.html') });
}

/**
 * Store an error payload and open the results page so the user sees
 * a friendly message rather than a blank tab or silent failure.
 */
async function openResultsWithError(message) {
  await storeCapture({ error: message });
  openResultsPage();
}

/* ─── Message Listener (results.js → service worker) ────────────────────────── */

/**
 * Handles messages sent from the results page via chrome.runtime.sendMessage.
 *
 * Supported message types:
 *   PP_RUN_AUDIT — Forward an audit request to the original source tab.
 *     Request:  { type: 'PP_RUN_AUDIT', tabId: number, pageUrl: string }
 *     Response: { ok: true,  meta: {...}, checks: [...] }
 *             | { ok: false, error: string }
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'PP_RUN_AUDIT') {
    runAuditOnTab(message.tabId, message.pageUrl, sendResponse);
    return true; // keep the message channel open for the async response
  }
  // Unknown messages — do not reply; let other listeners handle them.
});

/**
 * Validates that the target tab still exists and its URL matches the expected
 * page, then forwards the PP_RUN_AUDIT message to the content script.
 *
 * Safety checks:
 *   - Tab must still exist (not closed since capture).
 *   - Tab URL must still match pageUrl (user didn't navigate away).
 *   - Content script is re-injected if necessary before forwarding.
 *
 * @param {number}   tabId        - ID of the tab to audit.
 * @param {string}   pageUrl      - URL recorded at capture time.
 * @param {Function} sendResponse - Callback to return the result to results.js.
 */
async function runAuditOnTab(tabId, pageUrl, sendResponse) {
  try {
    // ── 1. Verify the tab is still open ─────────────────────────────────────
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (_) {
      sendResponse({ ok: false, error: 'The original tab has been closed. Reopen the page and run a new capture to audit it.' });
      return;
    }

    // ── 2. Verify the tab URL still matches ─────────────────────────────────
    // Compare origins + pathnames (ignore hash/search so minor navigations pass).
    const currentOrigin  = safeOrigin(tab.url);
    const expectedOrigin = safeOrigin(pageUrl);
    if (!currentOrigin || currentOrigin !== expectedOrigin) {
      sendResponse({
        ok: false,
        error: 'The tab has navigated to a different page since the screenshot was taken. Re-capture the current page to audit it.',
      });
      return;
    }

    // ── 3. Re-inject the content script (idempotent — guard flag prevents double-run) ─
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files:  ['content-script.js'],
      });
    } catch (injErr) {
      // Injection can fail on restricted pages. Surface as a clear error.
      sendResponse({ ok: false, error: `Could not inject audit script: ${injErr.message}` });
      return;
    }

    // ── 4. Forward the audit request to the content script ──────────────────
    chrome.tabs.sendMessage(tabId, { type: 'PP_RUN_AUDIT' }, (response) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: `Audit message failed: ${chrome.runtime.lastError.message}` });
        return;
      }
      sendResponse(response ?? { ok: false, error: 'Content script returned no response.' });
    });

  } catch (err) {
    sendResponse({ ok: false, error: `Audit error: ${err.message}` });
  }
}

/**
 * Extract just the origin from a URL string for equality checking.
 * Returns null for any URL that fails to parse or has no meaningful origin.
 */
function safeOrigin(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.origin !== 'null' ? u.origin : null;
  } catch (_) {
    return null;
  }
}
