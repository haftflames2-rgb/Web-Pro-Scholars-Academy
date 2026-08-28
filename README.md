# WPS Academy LMS

A deployable starter LMS using:
- HTML/CSS/vanilla JavaScript frontend
- Node.js + Express backend
- SQLite database
- Session authentication
- Student/admin roles
- Registration -> payment portal -> admin approval
- Bank transfer + crypto payment records
- Bank proof upload + "I have paid"
- Student portal locking
- Per-course locking
- Lecture note/video uploads
- Manual assignments/projects
- Code/file submissions
- Manual grading + feedback
- Browser HTML/CSS/JavaScript sandbox

## Run locally

1. Install Node.js 20+.
2. Copy `.env.example` to `.env` and change the secrets/password.
3. Run:
   npm install
   npm start
4. Open:
   http://localhost:3000

Default admin comes from:
ADMIN_EMAIL and ADMIN_PASSWORD

## Deployment

Deploy the Node application to a Node-compatible host and set environment variables there.

Important production settings:
- Set a long random SESSION_SECRET.
- Set a strong ADMIN_PASSWORD.
- Use HTTPS.
- Set the session cookie `secure: true` in `server.js` when HTTPS is enabled.
- Use persistent storage for `wps.sqlite`, `sessions.sqlite`, and `uploads/`, or move them to managed storage/database.
- Replace the placeholder bank details and configure your real crypto wallet details.
- Add an actual payment gateway if automatic payment verification is required. The included crypto/bank flow is manual: students submit proof and an admin approves them.

## Security note

The in-browser sandbox executes HTML/CSS/JavaScript in a sandboxed iframe. Do not execute arbitrary student Python/C#/Django server code directly on the LMS server. For those languages, use a separate isolated code-execution service/container with strict CPU, memory, filesystem and network limits.

## Main routes

- `/` landing page
- `/login.html`
- `/register.html`
- `/payment.html`
- `/student.html`
- `/admin.html`

The project is intentionally kept simple so you can extend the UI and database without a framework.
