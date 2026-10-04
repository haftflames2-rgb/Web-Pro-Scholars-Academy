# SMARTTEP ACADEMY V24 — AdSense Connection

This V24 package is based on V23 and adds the Google AdSense site-connection code for publisher `ca-pub-7874038162382392`.

## What was changed

- Added Google's exact AdSense site-connection snippet to the `<head>` of the public/ad-supported HTML pages.
- Kept the existing V23 advertising system and direct-ad functionality.
- Updated `ads.js` so it reuses the AdSense script already present in the page instead of injecting a duplicate copy.
- Added the publisher ID as the server's deployment-safe default for the existing `/ads.txt` route and advertising configuration seed.
- Preserved the existing Admin Advertising settings, Smart Security, announcements, 2FA, exams, attendance, instructor application, and other V23 functionality.

## Publisher

`ca-pub-7874038162382392`

## Google verification

After deploying this ZIP, open the live site and confirm the homepage source contains the AdSense script between `<head>` and `</head>`. Then in AdSense select **AdSense code snippet**, tick **I've placed the code**, and click **Verify**. Google documents that the code should be placed between the `<head>` and `</head>` tags and that the published page must be reachable by its crawler.

The existing `/ads.txt` route remains available and uses the publisher ID above when the Admin advertising setting has not yet been customized.
