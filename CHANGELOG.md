# PagePilot Capture site — CHANGELOG

## 2026-07-03 — EXP-004 funnel (Chrome visitors → OperatorOS / ReviewBoost)
**Type:** additive, conservative. No existing content, CTAs, or functionality removed or changed.
- Added a "More tools for agencies & consultants" section, styled with the site's existing `.feature-card` / `.section-title` classes, placed above the final CTA banner.
- Two cards linking to existing offers:
  - **OperatorOS** → live demo (operatoros-demo.netlify.app) + Gumroad ($97).
  - **ReviewBoost Pro** → offer page (reviewboost.html).
- All outbound links carry UTM params for attribution at the destination:
  `?utm_source=pagepilot&utm_medium=ext_site&utm_campaign=exp004`
- **Tracking approach (privacy-respecting):** no cookies, no third-party analytics, no PII, no JS added. Attribution done by reading UTM-tagged traffic on destination pages we control (Vercel/Gumroad/Netlify).

### Known issue (not changed here — needs the real URL)
- The "Install PagePilot Capture" CTAs (5 instances) still point to `REPLACE_WITH_WEB_STORE_URL_AFTER_APPROVAL`. PagePilot Capture is published; these should be the live store URL. Left untouched — the correct CWS URL could not be verified this session (see PORTFOLIO EXP-004 notes). Same issue confirmed on the SEOPilot site.
