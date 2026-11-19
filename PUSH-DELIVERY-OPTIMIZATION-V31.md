# SMARTTEP ACADEMY V31 — Push Delivery Optimization

V31 is built from V30 and keeps the working advertisement fallback and all existing application features.

## Push delivery changes
- Web Push requests now use **high urgency** so push services can prioritize time-sensitive notifications.
- TTL is reduced from 24 hours to **5 minutes** for immediate notifications; stale alerts are not queued for later delivery.
- Device deliveries are sent in bounded parallel batches (10 at a time) instead of waiting for each device sequentially.
- Delivery failures are counted separately from successful and expired/removed subscriptions.
- Notification payload includes a timestamp.
- Existing VAPID keys stored in MongoDB are preserved; no new Render environment variables are required.

## Important mobile limitation
These changes improve server/provider-side delivery latency but cannot override Android/iOS/browser power-management decisions. A phone in Doze, Battery Saver, restricted background mode, Data Saver, poor network coverage, or an unsupported browser can still delay a notification.

For Android, users should allow notifications and avoid restricting the browser's background activity. Chrome or another full-featured browser is recommended over Opera Mini for Web Push.

## Preserved
- V30 advertisement fallback fix.
- AdSense configuration.
- MongoDB/Cloudinary integration.
- Smart Security.
- Admin 2FA.
- Existing announcements and automatic lesson push notifications.
- Existing push subscription and VAPID storage system.

No new environment variables or paid notification service are required.
