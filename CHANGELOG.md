# PagePilot Capture site — CHANGELOG

## 2026-07-03 — EXP-004b: fix dead "Install" CTAs
**Type:** targeted fix, no other content changed.
- Replaced all 5 instances of the `REPLACE_WITH_WEB_STORE_URL_AFTER_APPROVAL` placeholder with the real published store URL:
  `https://chromewebstore.google.com/detail/bncdedhnedojmmmbcmlmdedgocgnhgcd`
- Extension ID (`bncdedhnedojmmmbcmlmdedgocgnhgcd`) confirmed directly from the Chrome Web Store Developer Dashboard (Status: Published - public), and the final URL was independently verified live via fetch — exact title/description match, confirmed live listing.
- These CTAs had been dead since publish; likely suppressing installs. Fixed alongside the EXP-004 funnel work.

## 2026-07-03 — EXP-004 funnel (Chrome visitors → OperatorOS / ReviewBoost)
**Type:** additive, conservative. No existing content, CTAs, or functionality removed or changed.
- Added a "More tools for agencies & consultants" section, styled with the site's existing `.feature-card` / `.section-title` classes, placed above the final CTA banner.
- Two cards linking to existing offers:
  - **OperatorOS** → live demo (operatoros-demo.netlify.app) + Gumroad ($97).
  - **ReviewBoost Pro** → offer page (reviewboost.html).
- All outbound links carry UTM params for attribution at the destination:
  `?utm_source=pagepilot&utm_medium=ext_site&utm_campaign=exp004`
- **Tracking approach (privacy-respecting):** no cookies, no third-party analytics, no PII, no JS added. Attribution done by reading UTM-tagged traffic on destination pages we control (Vercel/Gumroad/Netlify).
