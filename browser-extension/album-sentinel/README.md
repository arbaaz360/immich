# Album Sentinel

Chrome/Brave extension for checking whether the Instagram username in the current tab has a matching Immich album.

## Load Unpacked

1. Open `chrome://extensions/` or `brave://extensions/`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select this folder: `browser-extension/album-sentinel`.

## Usage

1. Open an Instagram profile.
2. Click the Album Sentinel extension icon.
3. Confirm the detected username.
4. Enter the Immich base URL, usually `http://localhost:2283`.
5. Enter an Immich API key.
6. Click **Check album**.

The extension checks:

- `GET /api/albums`
- `GET /api/albums?shared=true`

It looks for an album whose name exactly matches the Instagram username, case-insensitive.

## API Keys

API keys are intentionally not committed. Enter them in the extension popup, or fill local preset values in `popup.js` in your private unpacked copy.
