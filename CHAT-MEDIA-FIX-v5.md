# WPS Academy Chat Media Fix v5 — 2026-09-20

Fixes included:

1. Chat video/audio playback no longer proxies transformed Cloudinary media through Node. Authenticated requests redirect to Cloudinary's transformed MP4/MP3 delivery URL so the browser receives proper HTTP Range/206 responses and can play/seek the full recording.
2. Voice recording preview now uses the browser's native MediaRecorder when available, selecting a browser-supported audio MIME type (WebM/Opus, MP4/M4A, or Ogg) instead of relying primarily on a hand-built WAV preview.
3. Android `audio/webm` recordings are correctly classified as audio before the shared `.webm` extension can classify them as video.
4. Browser cache-busting version updated to `20260920media5`.
5. Existing MongoDB chat messages and Cloudinary originals are not deleted or replaced by this fix.

Changed files:
- `server.js`
- `public/js/chat.js`
- `public/chat.html`
