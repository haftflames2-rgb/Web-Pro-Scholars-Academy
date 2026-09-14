# WPS Academy LMS — MongoDB + Cloudinary Edition

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

## Existing WPS Academy features retained

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

The lesson media upload path is versioned as `2026-09-14-mediafix3`. After deploying, open `/api/media-fix-version` while logged out; it should return JSON containing that exact version. If it does not, Render is serving an older deployment.

Lesson videos are uploaded explicitly as Cloudinary `video` resources. Lesson audio is also uploaded as a Cloudinary `video` resource because Cloudinary stores/transcodes audio through that media resource type. Audio validation accepts normal audio MIME types, known audio extensions, common media signatures, and generic binary MIME types from mobile/desktop file pickers; Cloudinary performs final media validation.
