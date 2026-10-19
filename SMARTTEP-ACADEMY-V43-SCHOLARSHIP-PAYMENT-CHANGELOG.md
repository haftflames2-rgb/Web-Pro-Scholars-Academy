# SMARTTEP ACADEMY V43 — Scholarship Application Payment Portal

## Changes
- Added a separate `scholarship-payment.html` portal for the ₦1,000 scholarship application fee.
- Displays the supplied Zenith Bank transfer details and requires sender name, sender email, transfer reference, payment proof, and confirmation checkbox.
- Scholarship form submission now redirects applicants to the payment portal with their application ID and email.
- Payment proof supports JPG, PNG, WEBP, and PDF, limited to 8 MB, and is uploaded using the existing authenticated/private Cloudinary payment-proof flow.
- Stores payment sender details, reference, proof metadata, amount, and submission time with the scholarship application.
- Admin Scholarship Applications panel displays payment status and details, with a link to inspect the uploaded proof.
- Admin approval is blocked unless payment proof has been submitted; clicking approval represents manual payment verification and scholarship approval.
- Application status check explains whether payment proof is still needed, under review, or approved.
- The application fee is not an award guarantee; a submitted payment does not itself grant a student account or scholarship access.

## Deployment notes
- No new environment variables or paid services were added.
- Uses the existing MongoDB `scholarship_applications` collection and existing Cloudinary payment-proof configuration.
- Keep existing Render environment variables and database settings. Back up the current project before deployment.
- Syntax checks passed for `server.js` and `public/js/scholarship-admin.js`. Full live Render/MongoDB/Cloudinary testing has not been performed.
