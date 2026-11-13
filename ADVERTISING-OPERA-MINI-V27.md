# SMARTTEP ACADEMY V27 — Safe Opera Mini Advertising Fallback

Built directly from V25, not V26.

## Why V26 was withdrawn
V26 introduced a page-level async middleware that could turn normal page requests into a generic 500 response on some Render/runtime conditions. V27 does not use that middleware.

## V27 fix
- Adds a small public `/ad-banner?placement=...` endpoint.
- Pages contain a same-origin iframe fallback for direct advertisements.
- The iframe is server-rendered and does not depend on JavaScript.
- Modern browsers can replace the fallback with the normal `ads.js` renderer.
- If JavaScript/API rendering fails, the fallback remains visible.
- AdSense remains client-side and is not used to bypass Opera Mini's own ad blocker.

## Preserved
- V25 MongoDB/Cloudinary architecture
- Direct ad scheduling and UTC handling
- Direct ad priority
- Click tracking
- Impression tracking
- AdSense publisher `ca-pub-7874038162382392`
- Smart Security
- Admin 2FA
- All existing application features
