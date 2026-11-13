# SMARTTEP ACADEMY V53 — Video Advertising

## Added
- Admin can create a direct image-banner advert or a video advert from the existing Advertising & Banner Revenue panel.
- Video uploads accept MP4 and WebM files up to 50 MB and are stored using the existing Cloudinary account/configuration.
- Video adverts use the same four existing placements: top website banner, student/instructor dashboard, learning content, and footer.
- Video playback is muted by default, inline, with viewer controls; browsers may block autoplay, in which case the viewer can press Play. A separate Visit advertiser link records clicks.
- Existing scheduling, priority, enable/disable, delete, impression/click statistics, and advertiser destination URL continue to apply.
- The low-bandwidth same-origin ad fallback can display video adverts as well as image banners.
- Existing image banners and Google AdSense fallback remain supported. Direct adverts continue to take priority for a placement.
- Fixed malformed ad-placement HTML attributes on the public, student, and instructor pages so the existing ad renderer can identify those slots consistently.

## Environment and cost
- No new environment variables, accounts, or application dependencies are introduced.
- Reuses the project's existing Cloudinary credentials and existing MongoDB advertisements collection.
- Video storage and playback consume Cloudinary storage/bandwidth. The 50 MB upload cap does not mean unlimited free hosting; monitor the Cloudinary usage dashboard and applicable plan limits.

## Validation
- `node --check server.js` passed.
- `node --check public/js/admin.js` passed.
- `node --check public/js/ads.js` passed.
- ZIP integrity checked after packaging.
- Not deployed or live-tested against the user's Render/Cloudinary accounts.
