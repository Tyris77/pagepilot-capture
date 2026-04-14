/**
 * PagePilot Capture — Results Page (v1.2 — Production Hardened)
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 *   1. Load capture data via a three-tier fallback chain.
 *   2. Stitch image slices onto a bounds-checked canvas.
 *   3. Render a scaled preview.
 *   4. Export as PNG, multi-page PDF, or clipboard image.
 *   5. Surface warnings (truncation, canvas cap) in the status bar.
 *   6. Show the Site Audit placeholder when the feature flag is set.
 */

'use strict';

/* ─── Storage / Message Constants ────────────────────────────────────────────── */

// Must match the key used in service-worker.js.
const STORAGE_KEY = 'pp_capture';

/* ─── Canvas Safety Limits ───────────────────────────────────────────────────── */

// Conservative ceilings that work across all GPU drivers.
// Chrome's actual limit varies by hardware; 16 384 is the widely-safe value.
const CANVAS_MAX_DIMENSION = 16_384;        // px — max safe width or height
const CANVAS_MAX_AREA      = 268_435_456;   // px² — 16 384 × 16 384

/* ─── DOM References ─────────────────────────────────────────────────────────── */

const els = {
  pageTitle:        document.getElementById('pageTitle'),
  pageUrl:          document.getElementById('pageUrl'),
  captureTime:      document.getElementById('captureTime'),
  pageMeta:         document.getElementById('pageMeta'),
  statusText:       document.getElementById('statusText'),
  statusDot:        document.getElementById('statusDot'),
  loadingSpinner:   document.getElementById('loadingSpinner'),
  loadingText:      document.getElementById('loadingText'),
  errorBox:         document.getElementById('errorBox'),
  errorMsg:         document.getElementById('errorMsg'),
  btnErrorRetry:    document.getElementById('btnErrorRetry'),
  canvasWrapper:    document.getElementById('canvasWrapper'),
  previewCanvas:    document.getElementById('previewCanvas'),
  overlayCanvas:    document.getElementById('overlayCanvas'),
  auditPanel:       document.getElementById('auditPanel'),
  auditHeader:      document.getElementById('auditHeader'),
  auditSections:    document.getElementById('auditSections'),
  dimensionInfo:    document.getElementById('dimensionInfo'),
  btnDownloadPng:   document.getElementById('btnDownloadPng'),
  btnExportPdf:     document.getElementById('btnExportPdf'),
  btnCopyClipboard: document.getElementById('btnCopyClipboard'),
  btnCaptureAgain:  document.getElementById('btnCaptureAgain'),
  btnSiteAudit:     document.getElementById('btnSiteAudit'),
};

/* ─── Page State ─────────────────────────────────────────────────────────────── */

let finalCanvas = null; // Set only after stitching completes; guards all exports.
let captureData = null; // Raw payload from the service worker.

/* ─── Bootstrap ──────────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  wireButtons();
  fetchCaptureData();
});

/* ─── Button Wiring ──────────────────────────────────────────────────────────── */

function wireButtons() {
  els.btnDownloadPng  .addEventListener('click', onDownloadPng);
  els.btnExportPdf    .addEventListener('click', onExportPdf);
  els.btnCopyClipboard.addEventListener('click', onCopyClipboard);
  els.btnCaptureAgain .addEventListener('click', () => window.close());
  els.btnErrorRetry   .addEventListener('click', () => window.close());
  els.btnSiteAudit   ?.addEventListener('click', onRunAudit);
}

/* ─── Site Audit ─────────────────────────────────────────────────────────────── */

/**
 * Called after processCapture() succeeds.
 * The audit button is always visible; it is just disabled until the canvas is ready.
 * enableButtons() un-disables it along with the other export controls.
 */
function enableAuditButton() {
  if (els.btnSiteAudit) els.btnSiteAudit.disabled = false;
}

/**
 * Main audit handler — wired to #btnSiteAudit click.
 *
 * 1. Disables the button (prevents double-clicks).
 * 2. Sends PP_RUN_AUDIT to the service worker, which forwards it to the source tab.
 * 3. On success: renders the audit panel and draws the fold overlay on the canvas.
 * 4. On failure: shows the error in the status bar and re-enables the button.
 */
async function onRunAudit() {
  if (!captureData?.sourceTabId) {
    setStatus('Cannot audit — no source tab recorded for this capture.', 'error');
    return;
  }

  if (els.btnSiteAudit) els.btnSiteAudit.disabled = true;
  setStatus('Running site audit…', 'active');

  try {
    const response = await sendMessageToSW({
      type:    'PP_RUN_AUDIT',
      tabId:   captureData.sourceTabId,
      pageUrl: captureData.pageUrl,
    });

    if (!response?.ok) {
      const msg = response?.error || 'Audit returned no data.';
      setStatus(`Audit failed: ${msg}`, 'error');
      if (els.btnSiteAudit) els.btnSiteAudit.disabled = false;
      return;
    }

    // Draw fold line overlay on the screenshot preview.
    if (response.meta?.foldY != null) {
      syncOverlayCanvas();
      drawFoldOverlay(response.meta.foldY);
    }

    // Render the check cards in the audit panel.
    renderAuditPanel(response.checks, response.meta);

    const okCount   = response.checks.filter(c => c.status === 'ok').length;
    const warnCount = response.checks.filter(c => c.status === 'needs_attention').length;
    const missCount = response.checks.filter(c => c.status === 'not_found').length;

    setStatus(
      `Audit complete — ${okCount} passed · ${warnCount} needs attention · ${missCount} not found`,
      okCount === response.checks.length ? 'success' : 'active'
    );

    // Scroll audit panel into view.
    els.auditPanel?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  } catch (err) {
    setStatus(`Audit error: ${err.message}`, 'error');
    if (els.btnSiteAudit) els.btnSiteAudit.disabled = false;
  }
}

/**
 * Send a message to the service worker via chrome.runtime.sendMessage.
 * Wraps the callback-based API in a Promise; resolves null on any error.
 */
function sendMessageToSW(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[PagePilot Audit] SW message error:', chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve(response ?? null);
      });
    } catch (err) {
      console.warn('[PagePilot Audit] sendMessage threw:', err.message);
      resolve(null);
    }
  });
}

/**
 * Build and display the audit panel below the screenshot.
 * Checks are grouped by their `category` field.
 *
 * @param {Array}  checks  - Array of check objects from scoreAuditChecks().
 * @param {Object} meta    - { foldY, viewportWidth, viewportHeight }
 */
function renderAuditPanel(checks, meta) {
  if (!els.auditPanel || !els.auditHeader || !els.auditSections) return;

  const okCount   = checks.filter(c => c.status === 'ok').length;
  const warnCount = checks.filter(c => c.status === 'needs_attention').length;
  const missCount = checks.filter(c => c.status === 'not_found').length;

  // ── Summary header ────────────────────────────────────────────────────────
  els.auditHeader.innerHTML = `
    <span class="pp-audit-title">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      Quick Site Audit
    </span>
    <div class="pp-audit-counts">
      <span class="pp-badge pp-badge--ok">✓ ${okCount} passed</span>
      ${warnCount > 0 ? `<span class="pp-badge pp-badge--warn">⚠ ${warnCount} needs attention</span>` : ''}
      ${missCount > 0 ? `<span class="pp-badge pp-badge--miss">✗ ${missCount} not found</span>` : ''}
      <span class="pp-fold-legend" title="Dashed red line on the screenshot marks the fold (first viewport)">
        <span class="pp-fold-legend-line" aria-hidden="true"></span>
        fold line
      </span>
    </div>
  `;

  // ── Group checks by category ───────────────────────────────────────────────
  const groups = {};
  for (const check of checks) {
    if (!groups[check.category]) groups[check.category] = [];
    groups[check.category].push(check);
  }

  // ── Render each group ─────────────────────────────────────────────────────
  els.auditSections.innerHTML = '';

  for (const [groupName, groupChecks] of Object.entries(groups)) {
    const gOk   = groupChecks.filter(c => c.status === 'ok').length;
    const gWarn = groupChecks.filter(c => c.status === 'needs_attention').length;
    const gMiss = groupChecks.filter(c => c.status === 'not_found').length;

    const groupBadges = [
      gOk   > 0 ? `<span class="pp-badge pp-badge--ok">${gOk} ✓</span>`     : '',
      gWarn > 0 ? `<span class="pp-badge pp-badge--warn">${gWarn} ⚠</span>` : '',
      gMiss > 0 ? `<span class="pp-badge pp-badge--miss">${gMiss} ✗</span>` : '',
    ].join('');

    const checksHtml = groupChecks.map((check) => {
      const dotClass = {
        ok:               'pp-check-dot--ok',
        needs_attention:  'pp-check-dot--warn',
        not_found:        'pp-check-dot--miss',
      }[check.status] || 'pp-check-dot--miss';

      const suggestion = (check.status !== 'ok' && check.suggestion)
        ? `<div class="pp-check-suggestion">${escHtml(check.suggestion)}</div>`
        : '';

      return `
        <div class="pp-audit-check">
          <span class="pp-check-dot ${dotClass}" aria-hidden="true"></span>
          <div class="pp-check-body">
            <div class="pp-check-name">${escHtml(check.name)}</div>
            <div class="pp-check-detail">${escHtml(check.detail)}</div>
            ${suggestion}
          </div>
          <span class="pp-badge ${
            check.status === 'ok' ? 'pp-badge--ok'
            : check.status === 'needs_attention' ? 'pp-badge--warn'
            : 'pp-badge--miss'
          }" aria-label="Status: ${escHtml(check.status)}">
            ${check.status === 'ok' ? 'OK' : check.status === 'needs_attention' ? 'Attention' : 'Missing'}
          </span>
        </div>`;
    }).join('');

    const details = document.createElement('details');
    details.className = 'pp-audit-group';
    details.open = true; // start expanded
    details.innerHTML = `
      <summary class="pp-audit-group-summary">
        ${escHtml(groupName)}
        <div class="pp-audit-group-badges">${groupBadges}</div>
        <svg class="pp-toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </summary>
      ${checksHtml}
    `;
    els.auditSections.appendChild(details);
  }

  // Show the panel.
  els.auditPanel.style.display = 'block';
}

/**
 * Escape a string for safe insertion as HTML text content.
 */
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ─── Fold Overlay ───────────────────────────────────────────────────────────── */

/**
 * Size the overlay canvas to exactly match the CSS-rendered size of previewCanvas.
 * Must be called after previewCanvas has been laid out (i.e., after renderPreview).
 */
function syncOverlayCanvas() {
  if (!els.overlayCanvas || !els.previewCanvas) return;
  const rect = els.previewCanvas.getBoundingClientRect();
  els.overlayCanvas.width  = rect.width;
  els.overlayCanvas.height = rect.height;
}

/**
 * Draw a dashed red horizontal line at the fold position.
 *
 * @param {number} foldY - The fold Y in logical page pixels (= window.innerHeight of source page).
 */
function drawFoldOverlay(foldY) {
  if (!els.overlayCanvas || !els.previewCanvas) return;
  if (!foldY || foldY <= 0) return;

  const previewH = els.previewCanvas.height; // full logical pixel height of stitched canvas
  const overlayH = els.overlayCanvas.height; // CSS px height of the rendered preview

  // Scale the fold position from logical canvas pixels to CSS overlay pixels.
  const scale       = overlayH / previewH;
  const foldYScaled = foldY * scale;

  // If the fold is at or beyond the visible preview, nothing to draw.
  if (foldYScaled >= overlayH) return;

  const ctx = els.overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, els.overlayCanvas.width, overlayH);

  // Dashed red line.
  ctx.save();
  ctx.strokeStyle  = 'rgba(239,68,68,0.85)';
  ctx.lineWidth    = 2;
  ctx.setLineDash([6, 4]);
  ctx.lineDashOffset = 0;
  ctx.beginPath();
  ctx.moveTo(0,                    foldYScaled);
  ctx.lineTo(els.overlayCanvas.width, foldYScaled);
  ctx.stroke();

  // "fold" label at the right edge.
  ctx.setLineDash([]);
  ctx.fillStyle   = 'rgba(239,68,68,0.85)';
  ctx.font        = '11px -apple-system, system-ui, sans-serif';
  ctx.textAlign   = 'right';
  ctx.textBaseline = 'bottom';
  const label = '↑ above fold';
  ctx.fillText(label, els.overlayCanvas.width - 6, foldYScaled - 3);
  ctx.restore();
}

/**
 * Clear the fold overlay (used when the audit panel is reset / re-run).
 */
function clearFoldOverlay() {
  if (!els.overlayCanvas) return;
  const ctx = els.overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
}

/* ─── Data Fetching — Three-Tier Fallback Chain ──────────────────────────────── */

/**
 * Loads capture data using three strategies in priority order:
 *
 *   1. chrome.storage.session — preferred; survives SW restarts, auto-clears.
 *   2. chrome.storage.local   — fallback for Chrome < 102 or session quota errors.
 *   3. chrome.runtime.sendMessage(PP_GET_CAPTURE_DATA) — last resort for the rare
 *      case where storage.set() failed but the service worker still holds data in
 *      memory. Fails gracefully (resolves null) if no listener is registered.
 *
 * Each layer is independent; a failure in one does not abort the others.
 * After any successful storage read, the key is removed immediately so stale
 * data cannot be re-used on a future page load.
 */
async function fetchCaptureData() {
  setStatus('Retrieving capture data…', 'active');

  try {
    // ── Tier 1: session storage ──────────────────────────────────────────────
    const sessionPayload = await readAndClearStorage(
      typeof chrome.storage.session !== 'undefined' ? chrome.storage.session : null
    );
    if (sessionPayload) { handlePayload(sessionPayload); return; }

    // ── Tier 2: local storage ────────────────────────────────────────────────
    const localPayload = await readAndClearStorage(chrome.storage.local);
    if (localPayload) { handlePayload(localPayload); return; }

    // ── Tier 3: service worker message ───────────────────────────────────────
    const swPayload = await fetchFromServiceWorker();
    if (swPayload) { handlePayload(swPayload); return; }

    // Nothing found anywhere.
    showError('No capture data found. Please close this tab and capture the page again.');

  } catch (err) {
    showError(`Failed to retrieve capture data: ${err.message}`);
  }
}

/**
 * Try to read STORAGE_KEY from a chrome.storage area.
 * - Returns the payload if valid and not expired.
 * - Removes the key immediately on any successful read.
 * - Returns null (never throws) on missing data, expired data, or API errors.
 */
async function readAndClearStorage(store) {
  if (!store) return null;

  try {
    const result  = await store.get(STORAGE_KEY);
    const payload = result[STORAGE_KEY];
    if (!payload) return null;

    // Clear the slot before doing anything else so it is never re-read.
    try { await store.remove(STORAGE_KEY); } catch (_) {}

    // Discard stale payloads (TTL embedded by service-worker.js).
    if (payload.expiresAt && Date.now() > payload.expiresAt) {
      console.warn('[PagePilot] Stale capture payload discarded from storage.');
      return null;
    }

    return payload;
  } catch (err) {
    console.warn('[PagePilot] Storage read error:', err.message);
    return null; // Don't let a storage API failure block the fallback chain.
  }
}

/**
 * Ask the service worker for capture data via message passing.
 * Returns the data payload on success, or null if the service worker has no
 * listener (already cleared its store) or if the message times out.
 * Never rejects — always resolves.
 */
function fetchFromServiceWorker() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'PP_GET_CAPTURE_DATA' }, (response) => {
        if (chrome.runtime.lastError) {
          // Normal when the SW has no listener — not an error worth surfacing.
          console.warn('[PagePilot] SW message fallback unavailable:',
            chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve(response?.ok ? response.data : null);
      });
    } catch (err) {
      // sendMessage itself can throw if the extension context is invalid.
      console.warn('[PagePilot] SW message fallback threw:', err.message);
      resolve(null);
    }
  });
}

/**
 * Central dispatch point once we have a raw payload from any storage tier.
 */
function handlePayload(payload) {
  if (payload.error) {
    showError(payload.error);
    return;
  }
  captureData = payload;
  processCapture(payload);
}

/* ─── Processing Pipeline ────────────────────────────────────────────────────── */

async function processCapture(data) {
  try {
    populateMeta(data);
    setStatus(`Stitching ${data.slices.length} slices…`, 'active');

    // stitchSlices() may add its own canvas-cap warnings to stitchWarnings.
    const { canvas, stitchWarnings } = await stitchSlices(data);
    finalCanvas = canvas;

    renderPreview(finalCanvas);

    // Buttons are enabled only here — after finalCanvas is confirmed non-null.
    enableButtons();

    // Merge service-worker capture warnings with stitching warnings.
    const allWarnings = [...(data.warnings || []), ...stitchWarnings];
    if (allWarnings.length > 0) {
      // Show the most important warning in the status bar; log all to console.
      setStatus(`⚠ ${allWarnings[0]}`, 'error');
      console.warn('[PagePilot] Warnings:', allWarnings);
    } else {
      setStatus(
        `${data.slices.length} slices · ${finalCanvas.width} × ${finalCanvas.height} px`,
        'success'
      );
    }

    els.dimensionInfo.textContent = `${finalCanvas.width} × ${finalCanvas.height} px`;

  } catch (err) {
    console.error('[PagePilot Results] Processing error:', err);
    showError(`Failed to build screenshot: ${err.message}`);
  }
}

function populateMeta(data) {
  document.title = `PagePilot — ${data.pageTitle || 'Screenshot'}`;

  if (els.pageTitle) {
    els.pageTitle.textContent = data.pageTitle || 'Untitled';
    els.pageTitle.title       = data.pageTitle || '';
  }

  if (els.pageUrl) {
    // safeParseUrl prevents new URL() from throwing on malformed data.
    const parsed     = safeParseUrl(data.pageUrl);
    const displayUrl = parsed
      ? (parsed.hostname + parsed.pathname).replace(/\/$/, '') // trim trailing slash
      : (data.pageUrl || '');
    els.pageUrl.textContent = displayUrl;
    els.pageUrl.href        = parsed ? data.pageUrl : '#';
    els.pageUrl.title       = data.pageUrl || '';
  }

  if (els.captureTime && data.capturedAt) {
    els.captureTime.textContent = new Date(data.capturedAt).toLocaleString();
  }
}

/**
 * Enable export buttons. Only ever called after finalCanvas is assigned.
 * The disabled attribute on each button in the HTML acts as the initial guard;
 * this function is the only path that lifts it.
 */
function enableButtons() {
  if (!finalCanvas) return; // defensive — should always be set by this point
  els.btnDownloadPng  .disabled = false;
  els.btnExportPdf    .disabled = false;
  els.btnCopyClipboard.disabled = false;
  enableAuditButton();
}

/* ─── URL Utility ────────────────────────────────────────────────────────────── */

/**
 * Safely parse a URL string without throwing.
 * Returns a URL object on success, or null for any malformed input.
 * Used by populateMeta() and buildFilename() to prevent crashes on
 * data:// URIs, file:// paths, or any other non-standard URL the
 * captured page might report.
 */
function safeParseUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  try {
    return new URL(urlStr);
  } catch (_) {
    return null;
  }
}

/* ─── Image Stitching ────────────────────────────────────────────────────────── */

/**
 * Draws all captured slices onto a single canvas in scroll order.
 * Each slice is drawn at its logical scrollY position so later slices
 * overwrite the overlap area from earlier ones — giving the freshest
 * rendering at every seam boundary.
 *
 * Output uses logical (CSS) pixel dimensions, not device-pixel dimensions,
 * to keep file sizes manageable for tall pages.
 *
 * Returns { canvas, stitchWarnings[] } so the caller can surface any
 * dimension capping to the user alongside the service-worker warnings.
 */
async function stitchSlices(data) {
  const { slices, totalHeight, viewportWidth, viewportHeight } = data;

  // Compute safe canvas dimensions and collect any truncation warnings.
  const { width: canvasWidth, height: canvasHeight, warnings: stitchWarnings } =
    computeSafeCanvasSize(viewportWidth, totalHeight);

  const canvas = document.createElement('canvas');
  canvas.width  = canvasWidth;
  canvas.height = canvasHeight;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i];
    if (slice.scrollY >= canvasHeight) break; // slice is beyond the capped canvas

    setStatus(`Stitching slice ${i + 1} / ${slices.length}…`, 'active');

    const img = await loadImage(slice.dataUrl);

    // Scale the DPR-resolution source into the logical-pixel destination rect.
    ctx.drawImage(img, 0, slice.scrollY, canvasWidth, viewportHeight);
  }

  return { canvas, stitchWarnings };
}

/**
 * Compute the largest canvas size that is safe to allocate given browser limits.
 * Returns { width, height, warnings[] }.
 *
 * Warnings are plain-English strings the caller should surface to the user.
 *
 * ── TILED RENDERING — Future Architecture Note ───────────────────────────────
 * When a page exceeds CANVAS_MAX_AREA, a single-canvas approach fails due to
 * GPU texture limits. The correct v2 fix is a tile-based pipeline:
 *
 *   1. Split the full page height into N tiles of ≤ CANVAS_MAX_DIMENSION px.
 *   2. Stitch the relevant slices into each tile canvas independently.
 *   3. Preview: downscale and composite tiles into a smaller display canvas.
 *   4. PNG export: stream raw pixel rows from each tile into a single Blob
 *      using an OffscreenCanvas worker + a streaming PNG encoder (e.g. UPNG).
 *   5. PDF export: each tile becomes a natural PDF page — already supported
 *      by buildMultiPagePDF(); just pass tile canvases as page descriptors.
 *
 * TODO(v2): Implement a TiledCanvas class with:
 *   - async drawSlice(slice)          — routes each slice to the correct tile
 *   - async toBlob(type, quality)     — streams a unified export Blob
 *   - async toPDFPages()              — returns per-tile page descriptors
 *   Gate with:  if (needsTiling(w, h)) return new TiledCanvas(w, h, slices);
 * ─────────────────────────────────────────────────────────────────────────────
 */
function computeSafeCanvasSize(requestedW, requestedH) {
  let w = requestedW;
  let h = requestedH;
  const warnings = [];

  if (w > CANVAS_MAX_DIMENSION) {
    warnings.push(
      `Canvas width was reduced from ${w.toLocaleString()}px to ` +
      `${CANVAS_MAX_DIMENSION.toLocaleString()}px due to browser GPU limits.`
    );
    w = CANVAS_MAX_DIMENSION;
  }

  if (h > CANVAS_MAX_DIMENSION) {
    warnings.push(
      `Page height (${requestedH.toLocaleString()}px) exceeds the ` +
      `${CANVAS_MAX_DIMENSION.toLocaleString()}px canvas limit — ` +
      `the bottom of the screenshot has been cut off. ` +
      `Export a PDF to capture the full page across multiple pages instead.`
    );
    h = CANVAS_MAX_DIMENSION;
  }

  // Check total area after dimension clamping.
  if (w * h > CANVAS_MAX_AREA) {
    const safeH = Math.floor(CANVAS_MAX_AREA / w);
    warnings.push(
      `Canvas area exceeds the ${Math.round(CANVAS_MAX_AREA / 1_000_000)}MP limit — ` +
      `height further reduced to ${safeH.toLocaleString()}px. ` +
      `Use Export PDF to save the complete image.`
    );
    h = safeH;
  }

  return { width: w, height: h, warnings };
}

/**
 * Wraps HTMLImageElement loading in a Promise.
 */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img   = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode an image slice.'));
    img.src     = src;
  });
}

/* ─── Preview Rendering ──────────────────────────────────────────────────────── */

function renderPreview(canvas) {
  els.loadingSpinner.style.display = 'none';
  els.canvasWrapper .style.display = 'flex';

  // Mirror the stitched canvas into the visible preview canvas.
  // CSS max-width: 100% then scales it down to fit the viewport.
  els.previewCanvas.width  = canvas.width;
  els.previewCanvas.height = canvas.height;
  els.previewCanvas.getContext('2d').drawImage(canvas, 0, 0);

  // Size the overlay canvas to match the laid-out preview canvas.
  // Use requestAnimationFrame so CSS has applied max-width scaling first.
  requestAnimationFrame(syncOverlayCanvas);
}

/* ─── Export Guard ───────────────────────────────────────────────────────────── */

/**
 * Central guard called at the top of every export handler.
 * Returns true if the canvas is ready, false (with status message) if not.
 * Buttons are disabled by the HTML until enableButtons() runs, but this
 * guard also handles any future dynamic re-disable scenarios.
 */
function assertCanvasReady(exportName) {
  if (finalCanvas) return true;
  setStatus(`Cannot ${exportName} — screenshot not ready yet.`, 'error');
  return false;
}

/* ─── Export: PNG ────────────────────────────────────────────────────────────── */

async function onDownloadPng() {
  if (!assertCanvasReady('download PNG')) return;
  setStatus('Generating PNG…', 'active');

  try {
    const blob     = await canvasToBlob(finalCanvas, 'image/png');
    const url      = URL.createObjectURL(blob);
    const filename = buildFilename('png');

    triggerDownload(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), 8000);

    setStatus(`PNG saved — ${filename}`, 'success');
  } catch (err) {
    setStatus(`PNG export failed: ${err.message}`, 'error');
    console.error('[PagePilot] PNG error:', err);
  }
}

/* ─── Export: PDF ────────────────────────────────────────────────────────────── */

/**
 * Builds a multi-page PDF from the stitched canvas.
 * No external library required — uses the hand-written PDF 1.4 builder below.
 *
 * Layout: A4 (595.28 × 841.89 pts) full-bleed.
 * The canvas is scaled to fill the full page width.
 * Tall canvases are split into as many pages as needed.
 * Each page slice is exported as JPEG (92 %) to keep file size practical.
 */
async function onExportPdf() {
  if (!assertCanvasReady('export PDF')) return;
  setStatus('Building PDF…', 'active');

  try {
    const PDF_PAGE_W = 595.28;
    const PDF_PAGE_H = 841.89;

    const imgW        = finalCanvas.width;
    const imgH        = finalCanvas.height;
    const scale       = PDF_PAGE_W / imgW;
    const rowsPerPage = Math.floor(PDF_PAGE_H / scale);
    const numPages    = Math.ceil(imgH / rowsPerPage);

    setStatus(`Building ${numPages}-page PDF…`, 'active');

    const pageDescriptors = [];

    for (let p = 0; p < numPages; p++) {
      const srcY = p * rowsPerPage;
      const srcH = Math.min(rowsPerPage, imgH - srcY);

      const sliceCanvas        = document.createElement('canvas');
      sliceCanvas.width        = imgW;
      sliceCanvas.height       = srcH;
      const sliceCtx           = sliceCanvas.getContext('2d');
      sliceCtx.fillStyle       = '#ffffff';
      sliceCtx.fillRect(0, 0, imgW, srcH);
      sliceCtx.drawImage(finalCanvas, 0, -srcY);

      const jpegDataUrl  = sliceCanvas.toDataURL('image/jpeg', 0.92);
      const jpegBytes    = base64ToUint8Array(jpegDataUrl.split(',')[1]);

      pageDescriptors.push({
        jpegBytes,
        imgWidth:  imgW,
        imgHeight: srcH,
        pdfWidth:  PDF_PAGE_W,
        pdfHeight: srcH * scale,
      });
    }

    const pdfBytes = buildMultiPagePDF(pageDescriptors, PDF_PAGE_W, PDF_PAGE_H);
    const blob     = new Blob([pdfBytes], { type: 'application/pdf' });
    const url      = URL.createObjectURL(blob);
    const filename = buildFilename('pdf');

    triggerDownload(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), 8000);

    setStatus(
      `PDF saved (${numPages} page${numPages > 1 ? 's' : ''}) — ${filename}`,
      'success'
    );
  } catch (err) {
    setStatus(`PDF export failed: ${err.message}`, 'error');
    console.error('[PagePilot] PDF error:', err);
  }
}

/* ─── Raw PDF Builder ────────────────────────────────────────────────────────── */

/**
 * Builds a minimal but valid PDF-1.4 binary from an array of JPEG page images.
 * Returns a Uint8Array suitable for `new Blob([result], { type: 'application/pdf' })`.
 *
 * Object layout:
 *   1          → Catalog
 *   2          → Pages
 *   3 + i*3    → Page i
 *   3 + i*3+1  → Content stream for page i
 *   3 + i*3+2  → Image XObject for page i  (raw JPEG / DCTDecode)
 */
function buildMultiPagePDF(pages, pageWidth, pageHeight) {
  const enc    = new TextEncoder();
  const chunks = [];
  let bytePos  = 0;

  function pushStr(str)    { const b = enc.encode(str); chunks.push(b); bytePos += b.length; }
  function pushBytes(b)    { chunks.push(b); bytePos += b.length; }

  const offsets = {};
  function startObj(n) { offsets[n] = bytePos; pushStr(`${n} 0 obj\n`); }
  function endObj()    { pushStr('\nendobj\n'); }

  const n          = pages.length;
  const catalogNum = 1;
  const pagesNum   = 2;
  const base       = 3;

  const pageObjNum    = (i) => base + i * 3;
  const contentObjNum = (i) => base + i * 3 + 1;
  const imageObjNum   = (i) => base + i * 3 + 2;
  const totalObjs     = 2 + n * 3;

  // Header
  pushStr('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');

  // Catalog
  startObj(catalogNum);
  pushStr(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  endObj();

  // Pages
  startObj(pagesNum);
  pushStr(`<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObjNum(i)} 0 R`).join(' ')}] /Count ${n} >>`);
  endObj();

  for (let i = 0; i < n; i++) {
    const p    = pages[i];
    const pw   = p.pdfWidth .toFixed(3);
    const ph   = p.pdfHeight.toFixed(3);
    const pgH  = pageHeight .toFixed(3);
    // PDF origin is bottom-left; push image to top of page.
    const yPos = (pageHeight - p.pdfHeight).toFixed(3);

    // Page dictionary
    startObj(pageObjNum(i));
    pushStr(
      `<< /Type /Page /Parent ${pagesNum} 0 R ` +
      `/MediaBox [0 0 ${pw} ${pgH}] ` +
      `/Contents ${contentObjNum(i)} 0 R ` +
      `/Resources << /XObject << /Im${i + 1} ${imageObjNum(i)} 0 R >> >> >>`
    );
    endObj();

    // Content stream: place image
    const cs    = enc.encode(`q ${pw} 0 0 ${ph} 0 ${yPos} cm /Im${i + 1} Do Q`);
    startObj(contentObjNum(i));
    pushStr(`<< /Length ${cs.length} >>\nstream\n`);
    pushBytes(cs);
    pushStr('\nendstream');
    endObj();

    // Image XObject (JPEG via DCTDecode)
    startObj(imageObjNum(i));
    pushStr(
      `<< /Type /XObject /Subtype /Image ` +
      `/Width ${p.imgWidth} /Height ${p.imgHeight} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
      `/Filter /DCTDecode /Length ${p.jpegBytes.length} >>\nstream\n`
    );
    pushBytes(p.jpegBytes);
    pushStr('\nendstream');
    endObj();
  }

  // Cross-reference table
  const xrefOffset = bytePos;
  pushStr(`xref\n0 ${totalObjs + 1}\n`);
  pushStr('0000000000 65535 f \n');
  for (let i = 1; i <= totalObjs; i++) {
    pushStr(`${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`);
  }

  // Trailer
  pushStr(`trailer\n<< /Size ${totalObjs + 1} /Root ${catalogNum} 0 R >>\n`);
  pushStr(`startxref\n${xrefOffset}\n%%EOF`);

  // Flatten into a single Uint8Array
  const out    = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let cursor   = 0;
  for (const c of chunks) { out.set(c, cursor); cursor += c.length; }
  return out;
}

/* ─── Export: Clipboard ──────────────────────────────────────────────────────── */

/**
 * Copy the screenshot to the system clipboard as a PNG image.
 *
 * Support detection is layered:
 *   1. Check navigator.clipboard?.write exists (not available in all contexts).
 *   2. If ClipboardItem.supports() exists (Chrome 121+), confirm 'image/png'
 *      is accepted before attempting the write.
 *   3. Catch NotAllowedError separately — the user needs to grant permission.
 *   4. All other failures get a clear message with the fallback suggestion.
 */
async function onCopyClipboard() {
  if (!assertCanvasReady('copy to clipboard')) return;
  setStatus('Copying to clipboard…', 'active');

  // ── Tier 1: Check write API availability ────────────────────────────────────
  if (!navigator.clipboard?.write) {
    setStatus(
      'Clipboard write API is not available here. ' +
      'Right-click the preview image and choose "Copy image" as an alternative.',
      'error'
    );
    return;
  }

  // ── Tier 2: Check image/png format support (Chrome 121+) ────────────────────
  // ClipboardItem.supports() lets us probe format support without writing.
  // If the method doesn't exist we proceed optimistically (older Chrome accepts PNG).
  if (typeof ClipboardItem.supports === 'function' && !ClipboardItem.supports('image/png')) {
    setStatus(
      'Your browser does not support copying PNG images to the clipboard. ' +
      'Use Download PNG to save the file, then paste it manually.',
      'error'
    );
    return;
  }

  // ── Tier 3: Attempt the write ────────────────────────────────────────────────
  try {
    const blob = await canvasToBlob(finalCanvas, 'image/png');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    setStatus('Image copied to clipboard!', 'success');

  } catch (err) {
    if (err.name === 'NotAllowedError') {
      setStatus(
        'Clipboard permission was denied. ' +
        'Click "Allow" if your browser shows a permission prompt, then try again.',
        'error'
      );
    } else {
      setStatus(
        `Clipboard copy failed: ${err.message} — use Download PNG instead.`,
        'error'
      );
    }
    console.error('[PagePilot] Clipboard error:', err);
  }
}

/* ─── Shared Export Utilities ────────────────────────────────────────────────── */

/**
 * Promise-based canvas.toBlob().
 */
function canvasToBlob(canvas, mimeType = 'image/png', quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('canvas.toBlob() returned null — canvas may be too large or tainted.'));
      },
      mimeType,
      quality
    );
  });
}

/**
 * Decode a base64 string into a Uint8Array.
 * Used to embed raw JPEG bytes into the PDF binary stream.
 */
function base64ToUint8Array(b64) {
  const bin  = atob(b64);
  const out  = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Programmatically trigger a file download via a temporary <a> element.
 */
function triggerDownload(url, filename) {
  const a        = document.createElement('a');
  a.href         = url;
  a.download     = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * Build a sanitised filename: "pagepilot-example-com-2024-01-15.png".
 * Uses safeParseUrl so a malformed pageUrl never causes a crash here.
 */
function buildFilename(ext) {
  const parsed = safeParseUrl(captureData?.pageUrl);
  const domain = parsed
    ? parsed.hostname.replace(/^www\./, '').replace(/[^a-z0-9]/gi, '-')
    : 'screenshot';
  const date   = new Date().toISOString().slice(0, 10);
  return `pagepilot-${domain}-${date}.${ext}`;
}

/* ─── UI State Helpers ───────────────────────────────────────────────────────── */

/**
 * Update the status bar text and animated dot colour.
 * @param {string} msg
 * @param {'active'|'success'|'error'|''} state
 */
function setStatus(msg, state = '') {
  if (els.statusText) els.statusText.textContent = msg;
  if (els.statusDot)  els.statusDot.className    = state ? `pp-status-dot is-${state}` : 'pp-status-dot';
  if (els.loadingText) els.loadingText.textContent = msg;
}

/**
 * Hide the loading spinner, show the error panel with a message.
 */
function showError(msg) {
  if (els.loadingSpinner) els.loadingSpinner.style.display = 'none';
  if (els.canvasWrapper)  els.canvasWrapper .style.display = 'none';
  if (els.errorBox)       els.errorBox      .style.display = 'flex';
  if (els.errorMsg)       els.errorMsg.textContent         = msg;
  setStatus(msg, 'error');
}
