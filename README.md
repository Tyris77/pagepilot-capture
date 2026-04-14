# PagePilot Capture

> Full-page screenshots for Chrome — one click, no sign-up, 100% local.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-blue?logo=googlechrome)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

## What it does

PagePilot Capture scrolls your page, stitches every viewport into one seamless image, and opens an instant preview tab — ready to export as PNG, PDF, or copy to clipboard.

- **Alt+Shift+P** or toolbar click to trigger
- Full-page stitching — no gaps, no repeated headers
- Multi-page PDF export (no external library)
- Clipboard copy — paste directly into Figma, Notion, Slack
- Quick Site Audit — 10-point conversion check with fold-line overlay
- 100% local — nothing leaves your browser

## Install

[**Add to Chrome →**](REPLACE_WITH_WEB_STORE_URL_AFTER_APPROVAL)

Or load unpacked for development (see below).

## Development

```
git clone https://github.com/tyris77/pagepilot-capture.git
```

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `pagepilot-capture/` folder

## Extension file structure

```
manifest.json          MV3 manifest
service-worker.js      Background: capture pipeline, storage, audit router
content-script.js      Injected: scroll control, metrics, audit DOM collection
results.html           Preview tab: layout
results.js             Preview tab: stitching, exports, audit panel UI
results.css            Preview tab: styles
icons/                 icon16/32/48/128.png
```

## Privacy

All processing is local. No analytics, no servers, no data collection.  
[Full Privacy Policy](https://tyris77.github.io/pagepilot-capture/privacy.html)

## License

MIT
