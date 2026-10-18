# SMARTTEP ACADEMY V32

## Included
- Student certificate eligibility detection based on completing every lesson in an enrolled course.
- In-portal certificate eligibility notification plus Web Push notification when available.
- Student certificate application workflow.
- Configurable certificate fee in Admin (MongoDB-backed; no new environment variable).
- Certificate payment uses the existing bank/crypto proof-of-payment workflow.
- Admin payment approval/rejection support for certificate payments.
- Admin certificate issue workflow with certificate number and public verification URL.
- QR code embedded in the downloadable certificate PDF.
- Public certificate verification page that displays certificate number, student name, course, student ID and issue date.
- Admin certificate PDF download.
- Academy-wide course performance dashboard for Admin.
- Instructor course performance dashboard for Admin.
- SMARTTEP Learning Library with course-linked public articles.
- Automobile Mechanic excluded from the Learning Library.
- Admin and instructors can create/publish/edit articles; Admin can delete any article.
- Student notification center.
- Student support-ticket submission and Admin support-ticket management.
- Admin system-health snapshot.
- PWA manifest/installability foundation without adding offline lesson storage.
- Existing V31 Web Push and V30 advertising functionality preserved.

## Explicitly not included
- Automatic certificate issuance without student application/payment.
- Offline lesson support.
- No new paid third-party service.
- No new environment variable.
- No manual MongoDB index deletion is required; V32 creates its own indexes at startup.

## Deployment
Target remains:
- Render
- Existing MongoDB
- Existing Cloudinary

Deploy this ZIP over the existing service. Preserve the existing environment variables and MongoDB database.
