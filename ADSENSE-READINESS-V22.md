# SMARTTEP ACADEMY V22 — AdSense Readiness Upgrade

This release is built on V21 Advertising and preserves the existing LMS/security features.

## Added
- Public Privacy Policy
- Public Terms & Conditions
- Public About page
- Public Contact page with MongoDB-backed contact messages
- Public Cookie & Advertising Disclosure
- Admin contact-message inbox
- Public crawler-friendly sitemap.xml
- robots.txt with public pages allowed and private application areas excluded
- Dynamic /ads.txt endpoint that uses the Admin-configured AdSense publisher ID when present
- Clear advertising disclosures and user-facing sponsored-ad labeling
- Removed advertising script from private chat/payment/live-tutor/authentication pages

## After AdSense account creation
1. Add the website in Google AdSense.
2. Use Google's provided site-verification method.
3. Enter the `ca-pub-...` publisher ID in Admin > Advertising.
4. Add the required ad slot IDs when Google provides them.
5. Enable AdSense only after the site is connected/reviewed.
6. Check `https://YOUR-DOMAIN/ads.txt` and Google AdSense's ads.txt status.

No new environment variables are required.

AdSense approval is controlled by Google and cannot be guaranteed by the application.
