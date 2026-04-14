/**
 * PagePilot Capture — Content Script
 * ─────────────────────────────────────────────────────────────────────────────
 * Injected into the target page by the service worker.
 * Responsibilities:
 *   • Report page dimensions and current scroll position.
 *   • Prepare the page for capture (pause animations, hide sticky elements).
 *   • Perform scrolling on command.
 *   • Restore the page to its original state afterwards.
 *
 * Guard flag prevents duplicate listener registration on repeated injections.
 */

'use strict';

if (!window.__pagePilotCapture) {
  window.__pagePilotCapture = true;
  initPagePilotContentScript();
}

function initPagePilotContentScript() {

  /* ─── State ──────────────────────────────────────────────────────────────── */

  let savedAnimations    = []; // { el, animation, transition }
  let savedSticky        = []; // { el, visibility }
  let captureScrollOrigin = 0; // scroll position before capture started

  /* ─── Message Listener ───────────────────────────────────────────────────── */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {

      case 'PP_GET_METRICS':
        sendResponse(getMetrics());
        break;

      case 'PP_PREPARE':
        captureScrollOrigin = window.scrollY;
        prepareForCapture();
        sendResponse({ ok: true });
        break;

      case 'PP_SCROLL':
        // Instant scroll — no smooth behaviour so layout settles immediately.
        window.scrollTo(0, message.y);
        sendResponse({ ok: true });
        break;

      case 'PP_GET_SCROLL':
        sendResponse({ scrollY: window.scrollY });
        break;

      case 'PP_RESTORE':
        restorePage(
          message.originalScrollY !== undefined
            ? message.originalScrollY
            : captureScrollOrigin
        );
        sendResponse({ ok: true });
        break;

      case 'PP_RUN_AUDIT':
        // Collect DOM metrics and score all checks; never throws to the caller.
        try {
          const auditData = collectAuditData();
          const checks    = scoreAuditChecks(auditData);
          sendResponse({
            ok: true,
            meta: {
              foldY:         auditData.foldY,
              viewportWidth:  auditData.viewportWidth,
              viewportHeight: auditData.viewportHeight,
            },
            checks,
          });
        } catch (err) {
          sendResponse({ ok: false, error: `Audit collection failed: ${err.message}` });
        }
        break;

      default:
        // Unknown message — ignore silently.
        break;
    }
    return true; // keep the port open (required for async response paths)
  });

  /* ─── Metrics ────────────────────────────────────────────────────────────── */

  function getMetrics() {
    try {
      const body  = document.body;
      const docEl = document.documentElement;

      // Use the maximum of all height properties to handle edge-case layouts.
      const totalHeight = Math.max(
        body.scrollHeight,  docEl.scrollHeight,
        body.offsetHeight,  docEl.offsetHeight,
        body.clientHeight,  docEl.clientHeight
      );

      return {
        totalHeight,
        viewportWidth:   window.innerWidth,
        viewportHeight:  window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
        originalScrollY: window.scrollY,
      };
    } catch (err) {
      return { error: err.message };
    }
  }

  /* ─── Prepare ────────────────────────────────────────────────────────────── */

  function prepareForCapture() {
    pauseAnimations();
    hideStickyElements();
  }

  /**
   * Freeze CSS animations and transitions so frames don't shift mid-capture.
   * We only touch elements that actually have running animations/transitions.
   */
  function pauseAnimations() {
    try {
      document.querySelectorAll('*').forEach((el) => {
        const cs = window.getComputedStyle(el);
        const hasAnim       = cs.animationName       && cs.animationName       !== 'none';
        const hasTransition = cs.transitionDuration  && cs.transitionDuration  !== '0s';

        if (hasAnim || hasTransition) {
          savedAnimations.push({
            el,
            animation:  el.style.animation,
            transition: el.style.transition,
          });
          el.style.animation  = 'none';
          el.style.transition = 'none';
        }
      });
    } catch (_) {
      // Non-critical — proceed even if we can't freeze animations.
    }
  }

  /**
   * Hide fixed and sticky elements so they don't repeat in every captured frame.
   * Their visibility is fully restored once capture ends.
   */
  function hideStickyElements() {
    try {
      document.querySelectorAll('*').forEach((el) => {
        const pos = window.getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') {
          savedSticky.push({ el, visibility: el.style.visibility });
          el.style.visibility = 'hidden';
        }
      });
    } catch (_) {
      // Non-critical.
    }
  }

  /* ─── Restore ────────────────────────────────────────────────────────────── */

  function restorePage(originalScrollY) {
    restoreAnimations();
    restoreStickyElements();
    // Return to where the user was before capture started.
    window.scrollTo(0, originalScrollY || 0);
  }

  function restoreAnimations() {
    savedAnimations.forEach(({ el, animation, transition }) => {
      el.style.animation  = animation;
      el.style.transition = transition;
    });
    savedAnimations = [];
  }

  function restoreStickyElements() {
    savedSticky.forEach(({ el, visibility }) => {
      el.style.visibility = visibility;
    });
    savedSticky = [];
  }

  /* ─── Audit: DOM Collection ──────────────────────────────────────────────── */

  /**
   * Inspects the live DOM and returns a plain metrics object.
   * Pure — does NOT modify page state.
   */
  function collectAuditData() {
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    // ── H1 / Headline ─────────────────────────────────────────────────────────
    const h1Els      = Array.from(document.querySelectorAll('h1'));
    const firstH1    = h1Els[0] || null;
    const h1InFold   = h1Els.some(el => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.top < vh && r.width > 0 && r.height > 0;
    });
    const h1Text      = firstH1?.textContent?.trim() || '';
    const h1WordCount = h1Text ? h1Text.split(/\s+/).filter(Boolean).length : 0;

    // ── Subheadline: first <p> or <h2> within 3 siblings of the primary H1 ───
    let subheadline = null;
    if (firstH1) {
      const siblings = Array.from(firstH1.parentElement?.children || []);
      const idx      = siblings.indexOf(firstH1);
      for (let i = idx + 1; i < Math.min(idx + 4, siblings.length); i++) {
        const el   = siblings[i];
        const text = el.textContent.trim();
        if ((el.tagName === 'P' || el.tagName === 'H2') && text.length >= 20) {
          subheadline = { tag: el.tagName, text: text.slice(0, 200) };
          break;
        }
      }
    }

    // ── CTAs above the fold ───────────────────────────────────────────────────
    const actionPattern = /\b(get|start|try|sign[\s-]?up|buy|purchase|book|download|join|subscribe|register|request|demo|free trial|contact|shop|order)\b/i;
    const allClickable  = Array.from(document.querySelectorAll(
      'button, a[href], input[type="submit"], [role="button"]'
    ));
    const inFold = el => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.top < vh && r.width > 0 && r.height > 0;
    };
    const ctasAboveFold        = allClickable.filter(el => inFold(el) && el.textContent.trim().length > 1);
    const primaryCtasAboveFold = ctasAboveFold.filter(el => actionPattern.test(el.textContent));
    const primaryCtaTexts      = primaryCtasAboveFold.slice(0, 3).map(el => el.textContent.trim().slice(0, 60));

    // ── Hero visual ───────────────────────────────────────────────────────────
    const hasHeroVisual = Array.from(document.querySelectorAll('img, video')).some(el => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.top < vh && r.width > 80 && r.height > 80;
    });

    // ── Forms / lead capture ─────────────────────────────────────────────────
    const hasForms       = document.querySelectorAll('form').length > 0;
    const hasEmailInput  = document.querySelectorAll('input[type="email"]').length > 0;

    // ── Social proof signals ─────────────────────────────────────────────────
    const trustClassPattern = /testimonial|review|rating|logo|partner|client|award|badge|guarantee|secure|trust/i;
    const hasTrustElements  = Array.from(document.querySelectorAll('[class], [id]')).some(el => {
      const cls = (el.getAttribute('class') || '') + (el.getAttribute('id') || '');
      return trustClassPattern.test(cls);
    });
    const hasTrustText = /testimonial|review|customer said|clients include|trusted by|rated/i
      .test(document.body.textContent.slice(0, 8000));

    // ── Contact signals ───────────────────────────────────────────────────────
    const hasPhone   = !!document.querySelector('a[href^="tel:"]');
    const hasEmail   = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(document.body.textContent.slice(0, 8000));
    const hasChat    = !!document.querySelector('[class*="chat"i], [id*="chat"i], [class*="intercom"i], [class*="crisp"i], [class*="drift"i]');

    // ── Navigation complexity ─────────────────────────────────────────────────
    const navLinkCount = document.querySelectorAll('nav a, [role="navigation"] a, header nav a').length;

    return {
      foldY:         vh,
      viewportWidth:  vw,
      viewportHeight: vh,

      h1Count:    h1Els.length,
      h1InFold,
      h1Text,
      h1WordCount,

      h2Count:     document.querySelectorAll('h2').length,
      subheadline,

      ctasAboveFold:        ctasAboveFold.length,
      primaryCtasAboveFold: primaryCtasAboveFold.length,
      primaryCtaTexts,

      hasHeroVisual,

      hasForms,
      hasEmailInput,

      hasSocialProof:  hasTrustElements || hasTrustText,
      hasContactInfo:  hasPhone || hasEmail || hasChat,

      navLinkCount,
    };
  }

  /* ─── Audit: Scoring ─────────────────────────────────────────────────────── */

  /**
   * Converts raw DOM metrics into an array of scored check objects.
   * Returns: Array<{ id, category, name, status, detail, suggestion }>
   *   status: 'ok' | 'needs_attention' | 'not_found'
   */
  function scoreAuditChecks(d) {
    const ok = (detail, suggestion) => ({ status: 'ok',             detail, suggestion });
    const na = (detail, suggestion) => ({ status: 'needs_attention', detail, suggestion });
    const nf = (detail, suggestion) => ({ status: 'not_found',       detail, suggestion });

    // Concise headline snippet for display
    const h1Snippet = d.h1Text
      ? `"${d.h1Text.slice(0, 72)}${d.h1Text.length > 72 ? '…' : ''}"`
      : '(none)';

    const checks = [
      // ── Above the Fold ──────────────────────────────────────────────────────
      {
        id: 'hero_headline', category: 'Above the Fold', name: 'Headline visible above fold',
        ...(d.h1Count === 0
          ? nf('No H1 element found on the page.',
               "Add an H1 headline. It's the first thing visitors and search engines read.")
          : d.h1InFold
            ? ok(h1Snippet,
                 'Headline is visible without scrolling — good.')
            : na(h1Snippet,
                 'Your headline exists but is below the fold. Move it higher in the layout.')),
      },
      {
        id: 'cta_above_fold', category: 'Above the Fold', name: 'Primary CTA above fold',
        ...(d.primaryCtasAboveFold > 0
          ? ok(`Found: "${d.primaryCtaTexts[0]}"`,
               'A clear action button is visible on arrival.')
          : d.ctasAboveFold > 0
            ? na(`${d.ctasAboveFold} clickable element(s) above fold — none with clear action text.`,
                 'Rewrite your CTA text to include an action verb: "Get started free", "Book a demo", etc.')
            : nf('No buttons or CTA links detected above the fold.',
                 'Add a CTA button in the first viewport — it\'s the highest-leverage conversion element.')),
      },
      {
        id: 'hero_visual', category: 'Above the Fold', name: 'Hero image or visual',
        ...(d.hasHeroVisual
          ? ok('Image or video detected in the above-fold area.',
               'A visual anchors the hero and helps visitors orient quickly.')
          : na('No prominent image or video found above the fold.',
               'Add a product screenshot, hero photo, or short video. Visuals increase time-on-page.')),
      },

      // ── Clarity & Offer ─────────────────────────────────────────────────────
      {
        id: 'single_h1', category: 'Clarity & Offer', name: 'Single, focused headline',
        ...(d.h1Count === 0
          ? nf('No H1 found.',
               'Add one H1. It anchors the page for visitors and search engines.')
          : d.h1Count === 1
            ? ok('Exactly one H1 — clear page focus.',
                 'Good. One headline keeps attention on your main message.')
            : na(`${d.h1Count} H1 elements found.`,
                 'Multiple H1s split the page\'s focus. Pick one primary headline and demote the others to H2.')),
      },
      {
        id: 'headline_length', category: 'Clarity & Offer', name: 'Headline is concise',
        ...(d.h1WordCount === 0
          ? nf('No headline to evaluate.', 'Add an H1 headline first.')
          : d.h1WordCount >= 3 && d.h1WordCount <= 12
            ? ok(`${d.h1WordCount} words — readable at a glance.`,
                 'Headline length is in the sweet spot.')
            : d.h1WordCount < 3
              ? na(`${d.h1WordCount} word(s) — too brief.`,
                   'Your headline is too short to communicate value. Add context about what you offer.')
              : na(`${d.h1WordCount} words — too long.`,
                   'Aim for 5–10 words. Lead with the core benefit; move supporting detail to the subheadline.')),
      },
      {
        id: 'subheadline', category: 'Clarity & Offer', name: 'Supporting subheadline',
        ...(d.subheadline
          ? ok(`${d.subheadline.tag}: "${d.subheadline.text.slice(0, 80)}${d.subheadline.text.length > 80 ? '…' : ''}"`,
               'A subheadline adds context and keeps visitors reading.')
          : na('No supporting text found directly below the headline.',
               'Add a 1–2 sentence subheadline that clarifies who this is for and what they\'ll get.')),
      },
      {
        id: 'lead_capture', category: 'Clarity & Offer', name: 'Lead capture or conversion form',
        ...(d.hasEmailInput
          ? ok('Email input field detected.',
               'Email capture is present — make sure the value exchange is clear.')
          : d.hasForms
            ? ok('Form detected on page.',
                 'A conversion form is present.')
            : na('No form or email input found on this page.',
                 'Add an email field or contact form. Even a single field creates a conversion path.')),
      },

      // ── UX & Trust ──────────────────────────────────────────────────────────
      {
        id: 'social_proof', category: 'UX & Trust', name: 'Social proof visible',
        ...(d.hasSocialProof
          ? ok('Trust elements or testimonial signals detected.',
               'Social proof is present — keep quotes specific and attributed for maximum credibility.')
          : na('No testimonials, reviews, ratings, or client logos detected.',
               'Add customer quotes, a logo strip, or a review count. Trust signals reduce hesitation before purchase.')),
      },
      {
        id: 'contact_access', category: 'UX & Trust', name: 'Contact or support access',
        ...(d.hasContactInfo
          ? ok('Contact method found (email, phone, or chat widget).',
               'Visible contact access builds trust and handles objections before they kill the sale.')
          : na('No visible email address, phone number, or chat widget detected.',
               'Expose a contact method. Visitors who can\'t ask questions don\'t convert.')),
      },
      {
        id: 'nav_focus', category: 'UX & Trust', name: 'Navigation not overwhelming',
        ...(d.navLinkCount === 0
          ? na('No navigation links detected — could mean a clean landing page or a detection gap.',
               'If this is a landing page, minimal nav is intentional and often good.')
          : d.navLinkCount <= 7
            ? ok(`${d.navLinkCount} nav link(s) — focused.`,
                 'Fewer nav options mean less distraction from your primary CTA.')
            : na(`${d.navLinkCount} navigation links found.`,
                 `${d.navLinkCount} links is a lot. Consider removing low-priority items or collapsing them. Every extra link competes with your CTA.`)),
      },
    ];

    return checks;
  }

} // end initPagePilotContentScript
