# SMARTTEP ACADEMY LMS — MongoDB + Cloudinary Edition

This version keeps the **HTML/CSS/vanilla JavaScript frontend** and Node/Express backend, but removes the Render-local SQLite database and local upload storage.

## New architecture

- **Render**: hosts the Node/Express website/API.
- **MongoDB Atlas**: stores students, admin, courses, lessons, payments, assignments, submissions and grades. MongoDB's official Node.js driver supports Atlas connections using a connection URI. 
- **Cloudinary**: stores lesson videos, lecture notes, payment proofs and student submission files.
- **MongoDB-backed sessions**: login sessions are stored in MongoDB through `connect-mongo`, instead of Render's temporary filesystem.

## Required environment variables

Copy `.env.example` to `.env` for local development, or add the same values under Render's Environment Variables.

Required:

- `MONGODB_URI`
- `MONGODB_DB`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `SESSION_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`

## Local setup

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## MongoDB Atlas setup

1. Create a MongoDB Atlas account and a free deployment.
2. Create a database user.
3. In Atlas, open **Connect → Drivers → Node.js** and copy the connection string.
4. Replace the password placeholder with the database user's password.
5. For development, allow your current IP in Atlas Network Access. For Render, add the Render service's permitted network access according to your Atlas configuration.
6. Put the URI in `MONGODB_URI`.

## Cloudinary setup

1. Create a Cloudinary account.
2. Open the Cloudinary Console.
3. Copy the **Cloud name**, **API Key**, and **API Secret**.
4. Put them in Render/local environment variables.
5. Never expose `CLOUDINARY_API_SECRET` in frontend JavaScript.

Student assignment submissions now also accept picture files (JPG, JPEG, PNG, WEBP, and GIF). Pictures are stored in Cloudinary under the same student-submissions folder and can be downloaded by admins.

The backend uploads files to these Cloudinary folders:

- `wps-academy/lesson-videos`
- `wps-academy/lesson-notes`
- `wps-academy/payment-proofs`
- `wps-academy/student-submissions`

## Render deployment

- Service type: **Web Service**
- Build Command: `npm install`
- Start Command: `npm start`
- Node version: `24.14.1` (also pinned by `.node-version`)

Add all environment variables from `.env.example` in Render.

### Important

Render Free services can still spin down after inactivity, so the first request after a sleep can be slow. The important improvement is that **persistent application data is no longer stored on Render's local filesystem**.

## Upload limit

This starter accepts uploads up to **100 MB** per file. Cloudinary supports larger/chunked uploads, but this starter intentionally keeps the server-side memory upload simple. For very large lecture videos, the next upgrade should be direct browser-to-Cloudinary signed uploads.

## Security

- Passwords are hashed with bcrypt.
- Session data is stored in MongoDB.
- Cloudinary API secret stays server-side.
- Student HTML/CSS/JavaScript exercises run inside a sandboxed iframe.
- Do not execute arbitrary Python/C#/Django server code directly on the LMS server.

## Existing SMARTTEP ACADEMY features retained

- Registration → payment portal → admin approval
- Bank transfer and crypto payment records
- Payment proof upload
- Student portal lock/unlock
- Course lock/unlock
- Lecture note/video upload
- Assignments/projects
- Student code/file submissions
- Grading and feedback
- Browser HTML/CSS/JavaScript sandbox

## Production hardening included in this corrected build

- `/api/dashboard` now returns a safe student profile and never exposes `passwordHash`.
- Registration now validates and persists selected `courseIds`.
- Login, registration, payment submission and AI endpoints have request-rate limits.
- `SESSION_SECRET` and `ADMIN_PASSWORD` are required at startup; weak/missing values stop the server from starting.
- Payment proof uploads are stored as authenticated/private Cloudinary assets and served to admins through a short-lived signed URL. Legacy payment records may still use their existing URL.
- Upload extensions are validated for payment proofs, lesson notes/videos and student submissions.
- AI Tutor no longer sends the student's email address to the AI model.
- AI quizzes are stored server-side with their correct answers; the browser receives only questions/options, and grading uses the stored answer key.

### Required Render secrets

Use a strong random `SESSION_SECRET` (32+ characters) and a strong `ADMIN_PASSWORD` (12+ characters). Do not commit `.env` or real API keys to source control.

## Course management (v2)

Administrators can now create, edit, lock/unlock, and delete courses from the Admin Portal. Course deletion also cleans the course's lessons, assignments, submissions, lesson-progress records, and student enrollment references. The initial built-in course catalogue is seeded only once, so deleted courses remain deleted across Render restarts.

## Media upload fix verification

The lesson media upload path is versioned as `2026-09-15-voicefix1`. After deploying, open `/api/media-fix-version` while logged out; it should return JSON containing that exact version. If it does not, Render is serving an older deployment.

Lesson videos are uploaded explicitly as Cloudinary `video` resources. Lesson audio is also uploaded as a Cloudinary `video` resource because Cloudinary stores/transcodes audio through that media resource type. Audio validation accepts normal audio MIME types, known audio extensions, common media signatures, and generic binary MIME types from mobile/desktop file pickers; Cloudinary performs final media validation.

## Smart 168-Hour Student Inactivity + 336-Hour Dormant IP Protection

Student accounts now have automatic inactivity protection. The system records `lastActivityAt` in MongoDB and automatically sets the existing `portalLocked` flag when a student has had no genuine browser activity for 168 hours. If the student remains dormant for 336 hours, Smart can also block the student's last known public IP until an administrator overrides the decision.

- Inactivity period: 168 hours
- Dormant IP block threshold: 336 hours
- Check interval while the server is awake: 15 minutes
- Render sleep/wake is handled by checking inactivity during authenticated access and `/api/me`
- Genuine browser interaction updates activity through `/api/activity`
- Passive tab idling does not reset the timer
- Administrator locks remain distinct from Smart inactivity locks
- Admin unlock resets the student's inactivity timer
- No new Render environment variable is required

## SMARTTEP Student Identity & Public Verification

This version adds an official student identity record for ID-card and verification use.

### Student identity fields
- SMARTTEP Student ID number (admin-assigned; unique)
- Course code
- Student name
- Registration date
- Programme ending date
- State
- Country
- Gender
- Profile picture

New registrations can provide gender, state and country. Administrators can add or correct the official ID number, course code and programme dates for both new and existing students from the Admin Portal.

### Public verification
The website now includes `/verify-student.html`. A member of the public can search by student name or SMARTTEP Student ID number. Only approved student records are returned, and the public result does not expose the student's email address or password.

The verification endpoint is rate-limited to reduce automated enumeration. Verification records are informational; administrators remain responsible for keeping identity information accurate.


### Smart Security Admin Override
Admin has final authority over Smart Security decisions. From the Admin Portal, an administrator can restore a student account suspended by Smart Security and can unblock a dormant student IP. Admin API requests bypass Smart device/IP enforcement so the administrator can always perform these overrides.

### Dormant IP note
A public IP can be shared by multiple students or devices (for example, a school, office, hotspot, or household). The 336-hour dormant-IP rule therefore blocks the public IP itself as requested and may affect other users sharing that address. Admin can immediately override/unblock the IP or disable the dormant-IP automation.

## V18 Admin Security Upgrade
- Optional Admin TOTP 2FA using any compatible authenticator app.
- QR setup plus manual secret; no SMS provider, paid authentication service, or new environment variable.
- Ten single-use recovery codes are generated by the academy server and stored only as hashes.
- Admin login requires the second factor once 2FA is enabled.
- TOTP secret is encrypted at rest using a key derived from the existing `SESSION_SECRET`.
- Admin 2FA enable/disable and verification events are recorded by Smart Security.
- Added Admin Security Health panel.
- Added `qrcode` as the only new npm dependency; Render installs it during normal deployment.
