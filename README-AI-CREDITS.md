# WPS Academy AI Daily Credit System

This upgrade adds a MongoDB-backed daily AI credit system for students.

## Default limits

Each student starts with **10 AI credits per day**.

| AI action | Default cost |
|---|---:|
| Chat question | 1 credit |
| Image | 1 credit |
| PDF / DOCX | 1 credit |
| Video | 5 credits |
| Voice / Read aloud | 1 credit |
| Practice quiz | 1 credit |
| Study plan | 1 credit |

So with the default settings, a student could generate up to **2 videos per day** if they spend all 10 credits on video. If they use other AI features, those uses reduce the remaining balance.

## Automatic reset

Usage is stored in MongoDB in `ai_usage` and keyed by date. The default reset timezone is `Africa/Lagos`.

You can change it in Render with:

`AI_USAGE_TIMEZONE=Africa/Lagos`

The system does not depend on Render's local filesystem, so usage survives Render restarts.

## Admin controls

The Admin Portal now has an **AI Daily Limits** panel where the administrator can:

- Change the daily credit allowance for students.
- Change the credit cost of chat, image, document, video, voice, quiz and study plan.
- Give administrators unlimited AI credits.
- See today's AI usage by student.
- Reset today's student usage manually.

## Important behavior

- A student cannot exceed the configured daily credit allowance.
- Failed AI generations refund the reserved credits where the failure is detected.
- A queued video consumes its video credits while it is being generated; if the video later fails/cancels, the credits are refunded.
- Admins are unlimited by default.
- OpenAI's own API rate limits, spending limits, prepaid balance and model availability still apply separately. The WPS Academy credit system is an application-level limit, not a replacement for OpenAI limits.
