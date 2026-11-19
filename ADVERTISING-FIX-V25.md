# SMARTTEP ACADEMY V25 — Advertising Fix + AdSense Preserved

V25 is built directly from the deployed-ready V24 source. It preserves the existing AdSense publisher connection:

- Publisher/client: `ca-pub-7874038162382392`
- Existing `/ads.txt` system remains intact.
- Existing Smart Security, Admin TOTP 2FA, announcements, exams, lesson Smart Lock, attendance, certificates, AI protections and other V24 features are preserved.

## Advertising fixes

1. Added real `topBanner`, `dashboardBanner`, `contentBanner` and `footerBanner` containers to the pages that load the advertising renderer.
2. Direct Cloudinary banner ads are rendered only after a valid image loads.
3. Direct-ad impressions are recorded only after the ad is actually visible in the viewport; failed images do not count as impressions.
4. Direct ads continue to take priority over AdSense for the same placement.
5. AdSense fallback requires a configured `ca-pub-...` publisher ID and ad-unit slot for a manual placement.
6. The renderer no longer silently treats every failed request as a successful/visible ad.
7. Admin advertising now shows Live, Scheduled, Expired or Disabled status.
8. Admin `datetime-local` start/end values are converted from the administrator's browser local time to UTC before being stored. This fixes the common Render/UTC vs Nigeria/WAT scheduling mismatch.
9. Server validation rejects an advertisement whose end time is earlier than its start time.
10. Browser cache-busting is updated to `v25` for the advertising script.

## Important AdSense note

The AdSense site connection code remains in `<head>`. Google documents that site-connection AdSense code belongs in the `<head>`, while ad-unit code belongs in the `<body>`. V25 follows that distinction.

Google may still keep the site in **Getting ready** while it reviews the site. Direct advertiser banners do not depend on AdSense approval.
