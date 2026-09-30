# WPS Academy AI Agent — Deployment Guide

This build extends the WPS Academy LMS with a student-aware AI learning system.

## Included

- AI Tutor with persistent MongoDB conversations
- Course/lesson/assignment tools
- Student-specific progress lookup
- Lesson completion tracking
- Learning progress percentage
- Recommended next lessons
- AI-generated multiple-choice quizzes
- Quiz scoring and quiz history storage
- AI-generated personal study plans
- File/image/code attachments in AI Tutor
- Optional web search
- Browser voice input
- Existing MongoDB, Cloudinary, authentication, admin, payments and submissions remain in place

## Render environment variables

Keep your existing variables and add:

```text
OPENAI_API_KEY=your_real_key
OPENAI_MODEL=gpt-5.6-luna
OPENAI_ENABLE_WEB_SEARCH=false
```

Never place the API key in `public/` or commit it to GitHub.

## Deploy

1. Replace the old project files with this project.
2. Commit and push to the GitHub repository connected to Render.
3. Confirm the Render service still has all MongoDB, Cloudinary and session environment variables.
4. Add the three OpenAI variables above.
5. Deploy.
6. Log in as a student.
7. Open **Student Portal → AI Tutor**.

## New student features

### Learning progress
Students can mark lessons complete. Progress is stored in MongoDB and survives Render restarts.

### AI quizzes
The AI can generate 3–20 question quizzes. Quiz submissions are stored in MongoDB with scores.

### Study plans
The AI can create 3–30 day study plans based on the student's current WPS Academy lesson progress.

### AI tools
The Tutor can use academy-specific tools to find lessons, assignments and student progress. It is restricted to the logged-in student's data.

## Recommended production settings

Use a long random `SESSION_SECRET` and a strong admin password. Keep `OPENAI_ENABLE_WEB_SEARCH=false` until you intentionally want live web search because external tool usage can increase API usage.
