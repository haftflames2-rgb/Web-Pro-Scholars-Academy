# WPS Chat Media Fix v4 — 2026-09-20

## Fixed
- Chat video playback now requests a browser-compatible MP4/H.264/AAC delivery representation from Cloudinary.
- Chat audio playback now requests a browser-compatible MP3 delivery representation.
- The authenticated chat media proxy continues forwarding HTTP Range requests so Android/iOS can seek and play the full media.
- The response MIME type now matches the transcoded playback representation (`video/mp4` or `audio/mpeg`) instead of the original upload MIME.
- Voice-note preview now resets and reloads the local Blob URL reliably and reports when the preview is ready.
- Updated the chat JavaScript cache-busting version.
- Media-fix endpoint version is now `2026-09-20-chat-media4`.

## Data safety
This fix does not delete or replace existing Cloudinary source files or MongoDB chat messages. Existing attachment records remain usable; playback is transformed only at delivery time.
