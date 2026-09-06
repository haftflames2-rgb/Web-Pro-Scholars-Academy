# WPS Academy AI Tutor

This version adds an AI Tutor to the existing WPS Academy LMS.

## Features
- Student-authenticated AI chat
- MongoDB conversation history
- Course/lesson search tools
- Assignment lookup
- Student progress lookup
- Lesson-note file context when a matching Cloudinary note is available
- Direct file attachments (PDF, documents, code, text and images)
- Optional live web search
- Browser voice input
- Mobile-friendly AI Tutor UI

## Render environment variables
Add these to the Render service. Never put the API key in `public/` files.

```text
OPENAI_API_KEY=your_real_key
OPENAI_MODEL=gpt-5.6-luna
OPENAI_ENABLE_WEB_SEARCH=false
```

The official OpenAI JavaScript SDK is installed through `package.json`. OpenAI's current documentation shows the SDK using `responses.create()` and environment-based API keys. GPT-5.6 Luna is documented as a cost-sensitive model and supports the Responses API and tools.

## Deployment
1. Upload/push this project to the same Git repository used by Render.
2. Keep your existing MongoDB and Cloudinary variables.
3. Add the three OpenAI variables above in Render Environment.
4. Deploy.
5. Log in as a student and open **Student Portal → Open AI Tutor**.

## Important
The AI Tutor uses your existing authentication. It cannot access another student's private information. Locked courses are not returned by the academy lesson-search tool for normal students.

If you enable live web search, remember that it can increase API usage/cost. It is disabled by default.
