# WPS Academy AI Media Upgrade

This upgrade adds:

- AI answers can be read aloud with a natural OpenAI voice.
- Live AI Tutor page with microphone conversation and spoken replies.
- AI image generation and downloadable images.
- AI PDF and Word document generation/downloads.
- AI video generation jobs using Sora, with progress polling and Cloudinary download storage.
- AI-generated files are stored in Cloudinary so Render's ephemeral disk is not used for permanent media.

## Render environment variables

Keep the existing variables and add:

```text
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-5.6-luna
OPENAI_ENABLE_WEB_SEARCH=false
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TTS_VOICE=marin
OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_VIDEO_MODEL=sora-2
OPENAI_VIDEO_SIZE=1280x720
```

The API key must stay only in Render environment variables. Never put it in browser JavaScript.

## Important

Image, voice and text generation require an OpenAI API project with available usage/billing. Video generation is a separate capability and may require access to Sora; if the project does not have access, WPS Academy will show the API error instead of pretending the video was created.

The Live AI Tutor is a browser voice turn-taking experience: it listens, sends the recognized question to the AI, then reads the answer aloud and listens again. It does not expose the OpenAI API key to the browser.
