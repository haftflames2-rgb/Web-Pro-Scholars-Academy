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

## AI provider fallback

The WPS AI Tutor now supports automatic provider fallback for text AI requests.

- Primary provider: OpenAI, using `OPENAI_MODEL` (default `gpt-6-astra`).
- Backup provider: Hugging Face Inference Providers, using `HF_MODEL` (default `openai/gpt-oss-120b:fastest`).
- If OpenAI returns an authentication, quota/credit, rate-limit, timeout, connection, or server-side failure and `HF_TOKEN` is configured, the server automatically retries the request through Hugging Face.
- Web search is used only by the primary OpenAI path. The fallback remains focused on the student's WPS Academy context and tools.
- Hugging Face credentials remain server-side in Render and are never sent to the browser.

Required Render variables for fallback:

```env
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-6-astra
HF_TOKEN=your_huggingface_token
HF_MODEL=openai/gpt-oss-120b:fastest
HF_BASE_URL=https://router.huggingface.co/v1
```

The fallback protects the text AI Tutor, quiz/study-plan text generation, and Live Tutor response generation. Image/video/TTS generation still uses their existing OpenAI-specific services unless a separate media fallback is added.
