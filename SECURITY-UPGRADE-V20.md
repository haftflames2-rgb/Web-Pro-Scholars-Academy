# SMARTTEP ACADEMY V20 Security Upgrade

This build adds application-level protections without adding a subscription, external security service, Redis, WAF/CDN, external monitoring, or external backup service.

## Added

- Authenticated browser CSRF protection using same-origin Origin/Referer validation.
- Uploaded-file security screening for dangerous executable/script signatures before Cloudinary processing.
- Uploaded filenames sanitized before they are persisted or sent to media storage.
- The same upload screening is applied to general uploads, profile uploads, and AI attachments.
- AI prompt-injection hardening: lesson notes, uploaded files, search results, and user-provided material are treated as untrusted data rather than instructions.
- AI tool authorization: only the six application-approved tutor tools can execute.
- AI generation tools require an explicit student request for image/document/video generation and have bounded argument sizes.
- AI tool calls are written to Smart Security audit events without storing passwords, cookies, or raw request bodies.
- AI lesson-context access now uses the same lesson-access policy before lesson material can be supplied to the AI.
- Security Health dashboard now reports CSRF, upload-signature screening, and AI tool authorization checks.
- Unsafe upload errors return a controlled 400 response instead of a generic server error.
- Existing password-version session invalidation, role checks, course ownership checks, Admin 2FA, Smart Security, exam security, lesson locks, Cloudinary protection, and password-reset controls are preserved.

## Deliberately NOT added

These four optional infrastructure improvements were specifically excluded:

1. Redis/shared external rate limiting.
2. External WAF/CDN security service.
3. External security monitoring/alerting service.
4. External backup/replication service.

## Environment variables

No new environment variables are required by this security upgrade.

Existing environment variables remain unchanged, including MongoDB, session, Admin, Cloudinary, and existing AI variables.

## Important limitation

This improves the application's security posture substantially, but it does not make the website mathematically or absolutely immune to hacking. A real production penetration test against the deployed Render service is still the final verification step.
