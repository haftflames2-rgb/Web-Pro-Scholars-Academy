# SMARTTEP ACADEMY V26

## Advertising: Opera Mini / Low-Bandwidth Compatibility

Built directly from SMARTTEP-ACADEMY-V25-ADVERTISING-FIX-ADSENSE-PRESERVED.zip.

### Main fix
Direct advertisements on the home, student and instructor pages are now progressively rendered by the server into the initial HTML response. This means the direct banner does not depend on a post-load JavaScript fetch to become visible.

### Preserved
- Direct advertiser priority over AdSense
- AdSense publisher `ca-pub-7874038162382392`
- `/ads.txt`
- Cloudinary advertisement images
- Existing ad scheduling and UTC handling
- Advertisement click/impression APIs
- Smart Security
- Admin TOTP 2FA
- Existing V25 application features and environment variables

### Client-side fallback
The existing `ads.js` renderer remains active as a fallback. It skips a direct ad when V26 has already rendered that ad in the initial HTML.

### Browser limitation
V26 does not bypass a user's browser ad blocker. Opera Mini's built-in ad blocking can still block advertising. If Opera Mini's ad blocking is enabled, Google/third-party ads may not appear; this is browser behavior, not an application failure.
