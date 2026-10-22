# SMARTTEP ACADEMY Instructor Portal

This version adds a controlled course-creator/instructor system.

## Roles
- **Student:** learns from enrolled courses and submits assignments.
- **Instructor:** approved by an administrator; owns and manages only their courses.
- **Admin:** retains platform-wide control and can manage existing courses, lessons, assignments, students, payments, security, and instructor approvals.

## Instructor workflow
1. A logged-in user opens **Teach on SMARTTEP**.
2. They submit an instructor application.
3. The administrator approves or rejects it from Admin Portal.
4. After approval, login redirects the account to `instructor.html`.
5. The instructor can create courses and upload lesson notes, video and audio.
6. Students can enroll in instructor-created courses using the normal WPS course registration flow.
7. The instructor can manage enrollment for their own courses, create assignments, download submissions, and grade them.

## Security
Instructor endpoints enforce course ownership on the server. An instructor cannot use their own API routes to edit another instructor's course, lesson, assignment, enrollment, or submission.

## Storage
Instructor lesson media uses the existing Cloudinary integration and MongoDB records, so it is not stored on Render's temporary filesystem.

## Environment variables
No new environment variables are required. The feature uses the existing MongoDB, Cloudinary, session, and authentication configuration.
