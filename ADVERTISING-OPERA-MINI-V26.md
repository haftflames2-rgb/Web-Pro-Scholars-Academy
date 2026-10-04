# SMARTTEP ACADEMY V26 — Opera Mini / Low-Bandwidth Advertising Compatibility

V26 is built directly from V25. The advertising system keeps the V25 API, direct-ad priority, Cloudinary banners, AdSense publisher configuration, Smart Security and Admin 2FA.

## Why V25 could fail in Opera Mini

V25 rendered direct advertisements after page load with `ads.js` by fetching `/api/ads`. Opera Mini uses a proxy/transcoding architecture and JavaScript can be paused before asynchronous client-side work completes.

## V26 fix

For the home, student and instructor pages, the server now renders an active direct advertisement into the initial HTML response. This is progressive enhancement: the banner is present before `ads.js` runs. `ads.js` detects the server-rendered banner and does not replace it with another request.

If server-side rendering is unavailable, the existing JavaScript API path remains as a fallback.

## AdSense

Google AdSense remains client-side. V26 does not attempt to bypass browser ad blocking. If Opera Mini's built-in ad blocker is enabled, Google/network ads may still be blocked by the browser.

## Scheduling

V25's UTC schedule handling is preserved. Direct ads are selected only when active and within their start/end window.
