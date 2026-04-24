# Cognitive Load Meter

A production-minded Chrome extension that detects likely cognitive overload from lightweight interaction patterns and gently adapts the browsing experience in real time.

## What It Does

- Tracks tab switching, scroll intensity, and idle recovery locally
- Computes a live cognitive load score from `0` to `100`
- Learns which domains tend to feel heavier or calmer and adapts the score over time
- Shows a floating in-page indicator with low, medium, and high states
- Offers subtle interventions like quick reset guidance and focus mode
- Includes a premium popup dashboard and a local-first settings page

## Tech Stack

- Chrome Extension Manifest V3
- HTML, CSS, JavaScript
- `chrome.storage.local`
- `chrome.storage.session`
- `chrome.idle`
- `chrome.alarms`

## Project Structure

```text
.
├── manifest.json
├── background.js
├── content.js
├── popup.html
├── popup.js
├── options.html
├── options.js
├── style.css
└── assets/
```

## Local Development

1. Open Chrome and go to `chrome://extensions/`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this folder

## Notes

- All interaction analysis is processed locally.
- No page content is collected or sent to any remote service.
- The extension is designed as a product-quality local-first MVP with a stronger MV3-safe runtime model.

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.
