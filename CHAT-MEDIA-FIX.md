# WPS Academy Chat Media Update

Updated 2026-09-20.

## Chat attachments
Students and administrators can now send:
- Images: JPG, PNG, GIF, WEBP, BMP, HEIC/HEIF
- Video: MP4, WEBM, MOV, M4V, 3GP, AVI, MKV
- Audio: MP3, WAV, M4A, OGG, AAC, FLAC, OPUS, AMR and browser-recorded WEBM/OGG voice messages
- Microsoft Word DOCX documents

The chat composer includes:
- 📎 attachment picker
- 🎙️ microphone recording button
- Normal text captions/messages alongside an attachment

Files are stored using the existing Cloudinary credentials. No new environment variables are required.

DOCX chat downloads use an authenticated server download endpoint and the official DOCX MIME type:
`application/vnd.openxmlformats-officedocument.wordprocessingml.document`

Maximum chat attachment size: 100 MB.

## Voice note playback performance

- Recorded voice notes are downsampled to 16 kHz mono before upload to reduce mobile upload size.
- Voice-note playback uses the Cloudinary eager MP3 derivative directly instead of streaming the larger WAV through the Node server.
- The original WAV remains the stored source asset.
