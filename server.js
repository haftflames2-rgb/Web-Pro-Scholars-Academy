const express = require("express");
const session = require("express-session");
const { MongoStore } = require("connect-mongo");
const { MongoClient, ObjectId, ServerApiVersion } = require("mongodb");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");
const { Readable } = require("stream");
const PDFDocument = require("pdfkit");
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require("docx");
const { createTutorResponse, generateTutorText, enabled: aiEnabled, MODEL: AI_MODEL, BACKUP_MODEL: AI_BACKUP_MODEL, PROVIDER: AI_PROVIDER, client: openai } = require("./aiService");


function base32Encode(buffer) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(input || "").toUpperCase().replace(/=+$/g, "").replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch); if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret, timeMs = Date.now()) {
  const key = base32Decode(secret);
  const counter = Math.floor(timeMs / 1000 / 30);
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(code % 1000000).padStart(6, "0");
}
function verifyTotp(secret, code) {
  const clean = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const now = Date.now();
  // Allow one 30-second clock-drift step in either direction.
  return [-30000, 0, 30000].some(delta => crypto.timingSafeEqual(Buffer.from(totp(secret, now + delta)), Buffer.from(clean)));
}
function deriveAdmin2faKey() {
  return crypto.createHash("sha256").update(String(process.env.SESSION_SECRET)).digest();
}
function encryptAdmin2faSecret(secret) {
  const iv = crypto.randomBytes(12), key = deriveAdmin2faKey();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64url"), data: encrypted.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
}
function decryptAdmin2faSecret(record) {
  const key = deriveAdmin2faKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(record.data, "base64url")), decipher.final()]).toString("utf8");
}
function newRecoveryCode() {
  return `${crypto.randomBytes(4).toString("hex").toUpperCase()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}
function normalizeRecoveryCode(code) { return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, ""); }

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const MEDIA_FIX_VERSION = "2026-09-21-chat-media11-whatsapp-media";

// Smart inactivity protection: students are automatically suspended/portal-locked after
// 168 hours without real activity. At 336 hours of dormancy, Smart also blocks the
// student's last known public IP until an administrator overrides/unblocks it.
// No new Render environment variable is needed.
const STUDENT_IDLE_LOCK_MS = 168 * 60 * 60 * 1000;
const STUDENT_DORMANT_IP_BLOCK_MS = 336 * 60 * 60 * 1000;
const STUDENT_IDLE_CHECK_MS = 15 * 60 * 1000;

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "wps_academy";

if (!MONGODB_URI) {
  console.error("Missing MONGODB_URI environment variable.");
  process.exit(1);
}
if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.error("Missing Cloudinary environment variables.");
  process.exit(1);
}
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error("Missing or weak SESSION_SECRET. Set a random secret of at least 32 characters in Render.");
  process.exit(1);
}
if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) {
  console.error("Missing or weak ADMIN_PASSWORD. Set a strong admin password of at least 12 characters in Render.");
  process.exit(1);
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

function sanitizeUploadedFilename(value, fallback = "uploaded-file") {
  const base = path.basename(String(value || fallback)).replace(/[\r\n\x00-\x1f\x7f]/g, "_").replace(/[^a-zA-Z0-9._()\[\] -]/g, "_");
  return (base || fallback).slice(0, 180);
}
function uploadedBufferHasDangerousSignature(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2) return false;
  const head = buffer.subarray(0, Math.min(buffer.length, 4096));
  const ascii = head.toString("latin1");
  if (head[0] === 0x4d && head[1] === 0x5a) return true;
  if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return true;
  if (/^#!\s*\/.*(?:sh|bash|zsh|python|perl|ruby|node)\b/i.test(ascii)) return true;
  if (/^\s*<\?php\b/i.test(ascii)) return true;
  return false;
}
function secureMulter(instance) {
  const wrap = method => (...args) => {
    const middleware = instance[method](...args);
    return (req, res, next) => middleware(req, res, err => {
      if (err) return next(err);
      const files = [];
      if (req.file) files.push(req.file);
      if (Array.isArray(req.files)) files.push(...req.files);
      else if (req.files && typeof req.files === "object") Object.values(req.files).forEach(list => files.push(...(Array.isArray(list) ? list : [])));
      for (const file of files) {
        if (!file || !Buffer.isBuffer(file.buffer)) continue;
        if (uploadedBufferHasDangerousSignature(file.buffer)) {
          const e = new Error("Uploaded file content is not an allowed document or media type."); e.status = 400; e.code = "UNSAFE_FILE_CONTENT"; return next(e);
        }
        file.originalname = sanitizeUploadedFilename(file.originalname);
      }
      next();
    });
  };
  return { single: wrap("single"), array: wrap("array"), fields: wrap("fields"), any: wrap("any") };
}

const upload = secureMulter(multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
}));

const profileUpload = secureMulter(multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
}));

const announcementUpload = secureMulter(multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
}));

function validProfileImage(file) {
  if (!file) return false;
  const ext = path.extname(file.originalname || "").toLowerCase();
  const mime = String(file.mimetype || "").toLowerCase();
  return new Set([".jpg", ".jpeg", ".png", ".webp"]).has(ext) && new Set(["image/jpeg", "image/png", "image/webp"]).has(mime);
}

function hasAllowedExtension(file, allowed) {
  if (!file) return true;
  const ext = path.extname(file.originalname || "").toLowerCase();
  return allowed.has(ext);
}

// Some Android/iOS browsers and cloud-storage file pickers do not preserve
// the selected file's extension in multipart `originalname`, even though
// they send the correct MIME type. Keep extension checks strict, but allow
// known MIME types as a safe fallback for those clients.
function hasAllowedExtensionOrMime(file, allowed, mimeByExtension = {}) {
  if (!file) return true;
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (allowed.has(ext)) return true;

  const mime = String(file.mimetype || "").toLowerCase().split(";", 1)[0].trim();
  return Object.entries(mimeByExtension).some(([allowedExt, allowedMimes]) =>
    allowed.has(allowedExt) && Array.isArray(allowedMimes) && allowedMimes.includes(mime)
  );
}

function looksLikeAudio(buffer) {
  if (!buffer || buffer.length < 4) return false;
  const b = buffer;
  const ascii = (start, len) => b.subarray(start, start + len).toString("ascii");

  // Common container/signature checks.
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return true;
  if (ascii(0, 4) === "OggS") return true;
  if (ascii(0, 4) === "fLaC") return true;
  if (ascii(0, 4) === "FORM" && ["AIFF", "AIFC"].includes(ascii(8, 4))) return true;
  if (ascii(0, 6) === "#!AMR\n" || ascii(0, 9) === "#!AMR-WB\n") return true;
  if (ascii(0, 4) === "caff") return true;

  // MP4/M4A/3GP family. The presence of an ftyp box is enough for the
  // upload route; Cloudinary performs the final media validation.
  if (ascii(4, 4) === "ftyp") return true;

  // MP3: ID3 or MPEG audio frame sync. Search a little beyond byte 0 because
  // some downloaded files contain a short leading wrapper/padding.
  const scan = Math.min(b.length - 1, 4096);
  for (let i = 0; i < scan; i++) {
    if (b[i] === 0x49 && b[i + 1] === 0x44 && b[i + 2] === 0x33) return true;
    if (b[i] === 0xFF && b[i + 1] != null && (b[i + 1] & 0xE0) === 0xE0) {
      const layer = (b[i + 1] >> 1) & 0x03;
      const bitrateIndex = (b[i + 2] >> 4) & 0x0F;
      if (layer !== 0 && bitrateIndex !== 0 && bitrateIndex !== 15) return true;
    }
    // AAC ADTS frame sync: 0xFFF followed by MPEG-2/4 audio header.
    if (b[i] === 0xFF && b[i + 1] != null && (b[i + 1] & 0xF6) === 0xF0) return true;
  }

  // WebM / Matroska. This is used by some audio recorders and converters.
  if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return true;
  return false;
}

function audioUploadLooksAllowed(file) {
  if (!file) return true;
  const ext = path.extname(file.originalname || "").toLowerCase();
  const mime = String(file.mimetype || "").toLowerCase();
  if (audioExtensions.has(ext)) return true;
  if (mime.startsWith("audio/")) return true;
  if (looksLikeAudio(file.buffer)) return true;

  // Android/iOS/desktop file pickers can report valid audio as a generic
  // binary MIME when the downloaded filename has no normal extension. Do not
  // reject such files here: upload them as a Cloudinary video resource and
  // let Cloudinary inspect/transcode the actual media bytes.
  return ["application/octet-stream", "binary/octet-stream", "application/force-download", "application/x-binary", "application/download"].includes(mime);
}
const paymentExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".pdf"]);
const submissionExtensions = new Set([".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".java", ".cs", ".cpp", ".c", ".h", ".json", ".xml", ".txt", ".md", ".zip", ".doc", ".docx", ".pdf", ".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const submissionMimeByExtension = {
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".doc": ["application/msword"],
  ".zip": ["application/zip", "application/x-zip-compressed"],
  ".pdf": ["application/pdf"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".png": ["image/png"],
  ".webp": ["image/webp"],
  ".gif": ["image/gif"]
};
const noteExtensions = new Set([".pdf", ".doc", ".docx", ".txt", ".md"]);
const videoExtensions = new Set([".mp4", ".webm", ".mov", ".m4v"]);
const audioExtensions = new Set([".mp3", ".wav", ".m4a", ".ogg", ".aac", ".flac", ".opus", ".amr", ".webm", ".aif", ".aiff", ".caf", ".mka", ".3gp"]);

const courses = [
  "Web Development", "App Development", "Encoding and Decoding", "Python", "C#",
  "JavaScript", "CSS", "TypeScript", "Data Science", "Vue", "React", "Django", "AI"
];

let mongoClient;
let db;
let users;
let courseCollection;
let lessons;
let payments;
let assignments;
let submissions;
let aiConversations;
let lessonProgress;
let quizAttempts;
let quizzes;
let studyPlans;
let aiArtifacts;
let aiUsage;
let aiSettings;
let appSettings;
const DEFAULT_ADSENSE_PUBLISHER_ID = "ca-pub-7874038162382392";
let chatConversations;
let chatMessages;
let securityEvents;
let securityBlocks;
let instructorApplications;
let instructorSecurityEvents;
let instructorSecurityAlerts;
let courseEnrollments;
let attendanceRecords;
let exams;
let examAttempts;
let examSecurityEvents;
let certificateRequests;
let advertisements;
let adEvents;
let contactMessages;
let announcements;
let announcementReads;

function oid(id) {
  try { return new ObjectId(id); } catch { return null; }
}

function uploadBuffer(buffer, originalName, folder, resourceType = "auto") {
  return new Promise((resolve, reject) => {
    const safeBase = path.basename(originalName || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
    const publicId = `${Date.now()}-${safeBase.replace(/\.[^.]+$/, "")}`;
    const stream = cloudinary.uploader.upload_stream(
      { folder: `wps-academy/${folder}`, public_id: publicId, resource_type: resourceType },
      (error, result) => error ? reject(error) : resolve(result)
    );
    stream.end(buffer);
  });
}

function profilePictureUrl(asset) {
  if (!asset) return null;
  // Prefer rebuilding the delivery URL from the Cloudinary public ID.
  // This repairs old/badly stored URLs while keeping compatibility with
  // records that only contain a URL.
  if (asset.publicId) {
    try {
      return cloudinary.url(asset.publicId, {
        secure: true,
        resource_type: asset.resourceType || "image",
        type: asset.type || "upload"
      });
    } catch (e) {
      console.error("Profile picture URL generation failed:", e?.message || e);
    }
  }
  return asset.url || null;
}

async function deleteCloudinaryAsset(asset) {
  if (!asset?.publicId) return;
  try {
    await new Promise((resolve, reject) => {
      cloudinary.uploader.destroy(
        asset.publicId,
        { resource_type: asset.resourceType || "image", type: asset.type || "upload", invalidate: true },
        (error) => error ? reject(error) : resolve()
      );
    });
  } catch (e) {
    console.error("Cloudinary asset deletion failed:", asset.publicId, e?.message || e);
  }
}

function lessonMediaUrl(media, kind) {
  if (!media) return null;
  // Audio uploaded through Cloudinary's video resource type can be stored in
  // codecs such as FLAC/AMR/MKA that a mobile browser may not decode. When a
  // public ID is available, ask Cloudinary for an MP3 delivery version so the
  // LMS player has a broadly supported browser format.
  if (kind === "audio" && media.publicId) {
    try {
      return cloudinary.url(media.publicId, {
        secure: true,
        resource_type: media.resourceType || "video",
        type: media.type || "upload",
        format: "mp3"
      });
    } catch (error) {
      console.error("Cloudinary audio lesson URL generation failed:", error?.message || error);
    }
  }
  // For video and notes, use the exact secure URL returned by Cloudinary.
  if (media.url) return media.url;
  if (!media.publicId) return null;
  try {
    return cloudinary.url(media.publicId, {
      secure: true,
      resource_type: media.resourceType || "video",
      type: media.type || "upload"
    });
  } catch (error) {
    console.error(`Cloudinary ${kind} lesson URL generation failed:`, error?.message || error);
    return null;
  }
}

function uploadPrivateProof(buffer, originalName) {
  return new Promise((resolve, reject) => {
    const safeBase = path.basename(originalName || "proof").replace(/[^a-zA-Z0-9._-]/g, "_");
    const publicId = `${Date.now()}-${safeBase.replace(/\.[^.]+$/, "")}`;
    const ext = path.extname(safeBase).toLowerCase();
    const resourceType = [".pdf"].includes(ext) ? "raw" : "image";
    const stream = cloudinary.uploader.upload_stream(
      { folder: "wps-academy/payment-proofs", public_id: publicId, resource_type: resourceType, type: "authenticated", overwrite: false },
      (error, result) => error ? reject(error) : resolve(result)
    );
    stream.end(buffer);
  });
}

function privateCloudinaryUrl(proof) {
  if (!proof?.publicId) return null;

  try {
    // Payment proofs are uploaded with Cloudinary delivery type
    // "authenticated". Authenticated assets require a signed delivery
    // URL. Do not add an auth_token here: auth_token is a separate
    // token-based access mechanism and requires Cloudinary's dedicated
    // authentication key, which is not the same as the API secret.
    // A normal signed delivery URL is sufficient for these assets.
    return cloudinary.url(proof.publicId, {
      secure: true,
      resource_type: proof.resourceType || "image",
      type: "authenticated",
      sign_url: true
    });
  } catch (error) {
    console.error("Cloudinary proof URL generation failed:", error?.message || error);
    return null;
  }
}

function uploadGenerated(buffer, publicId, resourceType = "raw", format = undefined) {
  return new Promise((resolve, reject) => {
    const options = { folder: "wps-academy/ai-generated", public_id: publicId, resource_type: resourceType, overwrite: true };
    if (format) options.format = format;
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => error ? reject(error) : resolve(result));
    stream.end(buffer);
  });
}

function cloudinaryDownloadUrl(result) {
  if (!result) return null;
  try {
    return cloudinary.url(result.public_id, {
      secure: true,
      resource_type: result.resource_type || "raw",
      type: "upload",
      flags: "attachment",
      format: result.format || undefined
    });
  } catch { return result.secure_url || result.url || null; }
}

function destroyCloudinaryAsset(asset, fallbackResourceType = "raw") {
  if (!asset?.publicId) return Promise.resolve({ result: "not found" });
  const resourceType = asset.resourceType || fallbackResourceType;
  return new Promise((resolve, reject) => {
    cloudinary.uploader.destroy(asset.publicId, { resource_type: resourceType, type: asset.type || "upload", invalidate: true }, (error, result) => {
      if (error) return reject(error);
      if (result?.result && !["ok", "not found"].includes(result.result)) {
        return reject(new Error(`Cloudinary could not delete ${asset.publicId}: ${result.result}`));
      }
      resolve(result || { result: "ok" });
    });
  });
}

function createPdfBuffer(title, content) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(20).text(title || "SMARTTEP ACADEMY Document", { align: "center" });
    doc.moveDown();
    for (const paragraph of String(content || "").split(/\n\s*\n/)) {
      const clean = paragraph.replace(/^#{1,6}\s*/gm, "").replace(/\*\*/g, "");
      doc.fontSize(11).text(clean, { lineGap: 4 });
      doc.moveDown(0.6);
    }
    doc.end();
  });
}

async function createDocxBuffer(title, content) {
  const children = [new Paragraph({ text: title || "SMARTTEP ACADEMY Document", heading: HeadingLevel.TITLE })];
  for (const block of String(content || "").split(/\n\s*\n/)) {
    children.push(new Paragraph({ children: [new TextRun(block.replace(/^#{1,6}\s*/gm, "").replace(/\*\*/g, ""))] }));
  }
  const document = new Document({ sections: [{ properties: {}, children }] });
  return Packer.toBuffer(document);
}

async function start() {
  mongoClient = new MongoClient(MONGODB_URI, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
  });
  await mongoClient.connect();
  await mongoClient.db("admin").command({ ping: 1 });
  db = mongoClient.db(DB_NAME);

  users = db.collection("users");
  courseCollection = db.collection("courses");
  lessons = db.collection("lessons");
  payments = db.collection("payments");
  assignments = db.collection("assignments");
  submissions = db.collection("submissions");
  aiConversations = db.collection("ai_conversations");
  lessonProgress = db.collection("lesson_progress");
  quizAttempts = db.collection("quiz_attempts");
  quizzes = db.collection("quizzes");
  studyPlans = db.collection("study_plans");
  aiArtifacts = db.collection("ai_artifacts");
  aiUsage = db.collection("ai_usage");
  aiSettings = db.collection("ai_settings");
  appSettings = db.collection("app_settings");
  chatConversations = db.collection("chat_conversations");
  chatMessages = db.collection("chat_messages");
  securityEvents = db.collection("security_events");
  securityBlocks = db.collection("security_blocks");
  instructorApplications = db.collection("instructor_applications");
  instructorSecurityEvents = db.collection("instructor_security_events");
  instructorSecurityAlerts = db.collection("instructor_security_alerts");
  courseEnrollments = db.collection("course_enrollments");
  lessonAccessOverrides = db.collection("lesson_access_overrides");
  attendanceRecords = db.collection("attendance_records");
  exams = db.collection("exams");
  examAttempts = db.collection("exam_attempts");
  examSecurityEvents = db.collection("exam_security_events");
  certificateRequests = db.collection("certificate_requests");
  advertisements = db.collection("advertisements");
  adEvents = db.collection("ad_events");
  contactMessages = db.collection("contact_messages");
  announcements = db.collection("announcements");
  announcementReads = db.collection("announcement_reads");

  await users.createIndex({ email: 1 }, { unique: true });
  await users.createIndex({ studentIdNumber: 1 }, { unique: true, sparse: true });
  await users.createIndex({ instructorIdNumber: 1 }, { unique: true, sparse: true });
  await users.createIndex({ role: 1, name: 1 });
  await courseCollection.createIndex({ ownerInstructorId: 1, createdAt: -1 });
  // Instructor applications are stored on the user document as the authoritative
  // source of truth. Do NOT create/modify indexes on the legacy mirror collection
  // during startup: older deployments can contain a conflicting `userId_1` index,
  // and that must never be allowed to prevent the whole WPS server from starting.
  await instructorSecurityEvents.createIndex({ instructorId: 1, createdAt: -1 });
  await instructorSecurityAlerts.createIndex({ status: 1, createdAt: -1 });
  await instructorSecurityAlerts.createIndex({ instructorId: 1, createdAt: -1 });
  await courseEnrollments.createIndex({ studentId: 1, courseId: 1 }, { unique: true });
  await courseEnrollments.createIndex({ courseId: 1, enrolledAt: 1 });
  await lessonAccessOverrides.createIndex({ studentId: 1, lessonId: 1 }, { unique: true });
  await lessonAccessOverrides.createIndex({ lessonId: 1, updatedAt: -1 });
  await attendanceRecords.createIndex({ studentId: 1, courseId: 1, date: 1 }, { unique: true });
  await attendanceRecords.createIndex({ courseId: 1, date: 1 });
  await exams.createIndex({ courseId: 1, createdAt: -1 });
  await exams.createIndex({ ownerRole: 1, ownerId: 1, createdAt: -1 });
  await examAttempts.createIndex({ examId: 1, studentId: 1 }, { unique: true });
  await examAttempts.createIndex({ studentId: 1, submittedAt: -1 });
  await examAttempts.createIndex({ status: 1, securityLockedAt: -1 });
  await examSecurityEvents.createIndex({ createdAt: -1 });
  await examSecurityEvents.createIndex({ studentId: 1, createdAt: -1 });
  await examSecurityEvents.createIndex({ examId: 1, createdAt: -1 });
  await certificateRequests.createIndex({ status: 1, createdAt: -1 });
  await certificateRequests.createIndex({ studentId: 1, createdAt: -1 });
  await advertisements.createIndex({ active: 1, placement: 1, priority: -1, startAt: 1, endAt: 1 });
  await advertisements.createIndex({ advertiserName: 1, createdAt: -1 });

  // V25 schedule migration: V24 sent HTML datetime-local values without a timezone.
  // Render normally runs in UTC while the SMARTTEP admin workflow is used in Nigeria/WAT,
  // so legacy direct-ad dates were stored one hour ahead. Migrate those legacy records once.
  const legacyAds = await advertisements.find({ type: "direct", scheduleVersion: { $exists: false } }).toArray();
  if (legacyAds.length) {
    const ONE_HOUR = 60 * 60 * 1000;
    for (const ad of legacyAds) {
      const set = { scheduleVersion: 2, scheduleTimezone: "UTC" };
      if (ad.startAt instanceof Date && !Number.isNaN(ad.startAt.getTime())) set.startAt = new Date(ad.startAt.getTime() - ONE_HOUR);
      if (ad.endAt instanceof Date && !Number.isNaN(ad.endAt.getTime())) set.endAt = new Date(ad.endAt.getTime() - ONE_HOUR);
      await advertisements.updateOne({ _id: ad._id }, { $set: set });
    }
  }
  await adEvents.createIndex({ adId: 1, type: 1, createdAt: -1 });
  await adEvents.createIndex({ createdAt: -1 });
  await contactMessages.createIndex({ createdAt: -1 });
  await contactMessages.createIndex({ status: 1, createdAt: -1 });
  await contactMessages.createIndex({ email: 1, createdAt: -1 });
  await announcements.createIndex({ active: 1, audience: 1, startAt: 1, endAt: 1, priority: -1 });
  await announcements.createIndex({ createdAt: -1 });
  await announcementReads.createIndex({ announcementId: 1, userId: 1 }, { unique: true });
  await announcementReads.createIndex({ userId: 1, acknowledgedAt: -1 });
  await courseCollection.createIndex({ title: 1 }, { unique: true });
  await submissions.createIndex({ assignmentId: 1, studentId: 1 }, { unique: true });
  await aiConversations.createIndex({ userId: 1, updatedAt: -1 });
  await chatConversations.createIndex({ members: 1, updatedAt: -1 });
  await chatConversations.createIndex({ memberKey: 1 }, { unique: true, sparse: true });
  await chatMessages.createIndex({ conversationId: 1, createdAt: 1 });
  await chatMessages.createIndex({ conversationId: 1, _id: 1 });
  await lessonProgress.createIndex({ userId: 1, lessonId: 1 }, { unique: true });
  await quizAttempts.createIndex({ userId: 1, createdAt: -1 });
  await quizzes.createIndex({ userId: 1, createdAt: -1 });
  await studyPlans.createIndex({ userId: 1, createdAt: -1 });
  await aiArtifacts.createIndex({ userId: 1, createdAt: -1 });
  await aiArtifacts.createIndex({ jobId: 1 }, { unique: true, sparse: true });
  await aiUsage.createIndex({ userId: 1, dateKey: 1 }, { unique: true });
  await securityEvents.createIndex({ createdAt: -1 });
  await securityEvents.createIndex({ ip: 1, createdAt: -1 });
  await securityEvents.createIndex({ type: 1, createdAt: -1 });
  // Smart threat blocks remain device-scoped. Dormant-student IP blocks are a
  // separate explicit policy requested by the administrator and are keyed by IP.
  try { await securityBlocks.dropIndex("ip_1"); } catch (_) {}
  await securityBlocks.createIndex({ deviceKey: 1 }, { unique: true, partialFilterExpression: { deviceKey: { $type: "string" } } });
  await securityBlocks.createIndex({ ip: 1, blockType: 1 });
  await securityBlocks.createIndex({ until: 1 });
  await users.createIndex({ role: 1, portalLocked: 1, lastActivityAt: 1 });

  // Start inactivity tracking for older student accounts without changing their
  // current access state. Their 168-hour clock begins when this version first runs
  // only if they do not already have an activity timestamp.
  await users.updateMany(
    { role: "student", lastActivityAt: { $exists: false } },
    { $set: { lastActivityAt: new Date() } }
  );

  // Seed the built-in catalogue only once. This prevents an administrator
  // from having a deleted course reappear after a server restart.
  const seedMarker = await appSettings.findOne({ _id: "course_seed_v1" });
  if (!seedMarker) {
    for (const title of courses) {
      await courseCollection.updateOne(
        { title },
        { $setOnInsert: { title, description: `Learn ${title} from fundamentals to practical projects.`, price: 0, thumbnail: "", locked: false, createdAt: new Date(), updatedAt: new Date() } },
        { upsert: true }
      );
    }
    await appSettings.updateOne({ _id: "course_seed_v1" }, { $set: { completedAt: new Date() } }, { upsert: true });
  }

  // Attendance/course-duration compatibility: older courses receive a default 12-week duration.
  await courseCollection.updateMany({ durationWeeks: { $exists: false } }, { $set: { durationWeeks: 12 } });

  // Backward compatibility: existing student accounts created before individual
  // enrollment existed keep their current access. New registrations always save
  // an explicit enrolledCourseIds list. Admins can then remove any course.
  const allCourseDocs = await courseCollection.find({}).project({ _id: 1 }).toArray();
  await users.updateMany(
    { role: "student", enrolledCourseIds: { $exists: false } },
    { $set: { enrolledCourseIds: allCourseDocs.map(c => c._id.toString()) } }
  );

  const defaultAILimits = {
    dailyCredits: 10,
    unlimitedAdmins: true,
    costs: { chat: 1, image: 1, document: 1, video: 5, speech: 1, quiz: 1, studyPlan: 1 }
  };
  await aiSettings.updateOne(
    { _id: "global" },
    { $setOnInsert: { _id: "global", ...defaultAILimits, updatedAt: new Date() } },
    { upsert: true }
  );

  await appSettings.updateOne(
    { _id: "advertising" },
    { $setOnInsert: {
      _id: "advertising", enabled: false, network: "adsense", publisherId: DEFAULT_ADSENSE_PUBLISHER_ID,
      defaultSlots: { topBanner: "", dashboardBanner: "", contentBanner: "", footerBanner: "" },
      updatedAt: new Date()
    } },
    { upsert: true }
  );

  const defaultSmartSecurity = {
    _id: "smart_security",
    enabled: true,
    mode: "monitor",
    autoBlockHighRisk: false,
    autoBlockCritical: true,
    requireApprovalForCritical: false,
    blockDurationMinutes: 1440,
    retentionDays: 30,
    studentIdleLockHours: 168,
    studentDormantIpBlockHours: 336,
    autoSuspendInactiveStudents: true,
    autoBlockDormantStudentIps: true,
    securityPolicyVersion: 5,
    updatedAt: new Date()
  };
  await appSettings.updateOne(
    { _id: "smart_security" },
    { $setOnInsert: defaultSmartSecurity },
    { upsert: true }
  );
  // Upgrade older Smart Security configurations once. Existing administrators
  // can still switch Smart back to monitor mode from the Admin Portal.
  await appSettings.updateOne(
    { _id: "smart_security", $or: [{ securityPolicyVersion: { $exists: false } }, { securityPolicyVersion: { $lt: 5 } }] },
    { $set: { mode: "auto", autoBlockHighRisk: true, autoBlockCritical: true, requireApprovalForCritical: false, studentIdleLockHours: 168, studentDormantIpBlockHours: 336, autoSuspendInactiveStudents: true, autoBlockDormantStudentIps: true, securityPolicyVersion: 5, blockDurationMinutes: 1440, updatedAt: new Date() } }
  );

  const adminEmail = (process.env.ADMIN_EMAIL || "admin@wpsacademy.com").trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD;
  const hash = await bcrypt.hash(adminPassword, 12);
  await users.updateOne(
    { email: adminEmail },
    { $setOnInsert: { name: "SMARTTEP Administrator", email: adminEmail, passwordHash: hash, role: "admin", portalLocked: false, paymentStatus: "paid", approved: true, createdAt: new Date(), admin2fa: { enabled: false } } },
    { upsert: true }
  );

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
      directives: {
        "script-src": ["'self'", "https://pagead2.googlesyndication.com", "https://googleads.g.doubleclick.net"],
        "img-src": ["'self'", "data:", "blob:", "https:"],
        "frame-src": ["'self'", "https://googleads.g.doubleclick.net", "https://tpc.googlesyndication.com"],
        "connect-src": ["'self'", "https://pagead2.googlesyndication.com", "https://googleads.g.doubleclick.net"]
      }
    },
    hsts: process.env.NODE_ENV === "production" ? { maxAge: 31536000, includeSubDomains: true, preload: false } : false
  }));
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));

  // Lightweight in-process rate limiting. This intentionally has no extra dependency;
  // Render can run multiple instances, so keep the limits conservative and use a
  // reverse-proxy/WAF rate limiter as the stronger production layer if scaling out.
  const rateBuckets = new Map();
  setInterval(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [key, bucket] of rateBuckets) if (bucket.start < cutoff) rateBuckets.delete(key);
  }, 10 * 60 * 1000).unref();

  // Smart uses an opaque browser/device identifier in addition to the public IP.
  // This prevents one malicious device on a shared Wi-Fi/mobile NAT from
  // blocking every legitimate device that happens to share that public IP.
  function smartCookieValue(req, name) {
    const raw = String(req.headers?.cookie || "");
    const match = raw.split(";").map(v => v.trim()).find(v => v.startsWith(`${name}=`));
    return match ? decodeURIComponent(match.slice(name.length + 1)) : "";
  }
  function smartEnsureDeviceId(req, res) {
    const existing = smartCookieValue(req, "smart_device_id");
    if (/^[a-f0-9]{64}$/.test(existing)) return existing;
    const id = crypto.randomBytes(32).toString("hex");
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.append("Set-Cookie", `smart_device_id=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`);
    return id;
  }
  function smartRateKey(req, res, keyPrefix, by = "ip") {
    if (by === "device") return `${keyPrefix}:device:${smartEnsureDeviceId(req, res)}`;
    return `${keyPrefix}:ip:${req.ip || req.socket.remoteAddress || "unknown"}`;
  }
  function rateLimit({ windowMs, max, keyPrefix, by = "ip" }) {
    return (req, res, next) => {
      const key = smartRateKey(req, res, keyPrefix, by);
      const now = Date.now();
      let bucket = rateBuckets.get(key);
      if (!bucket || now - bucket.start >= windowMs) bucket = { start: now, count: 0 };
      bucket.count += 1;
      rateBuckets.set(key, bucket);
      if (bucket.count > max) {
        res.set("Retry-After", String(Math.ceil((bucket.start + windowMs - now) / 1000)));
        return res.status(429).json({ error: "Too many requests. Please try again later." });
      }
      next();
    };
  }

  // Broad abuse guard: protects the application from very high request bursts
  // without treating a shared public IP as a permanent device identity. The
  // stricter endpoint-specific limits above remain the primary controls.
  app.use(rateLimit({ windowMs: 60 * 1000, max: 300, keyPrefix: "global-device", by: "device" }));

  // Keep Mongo-backed sessions reliable on Render/free instances.
  // connect-mongo touches a session on every response by default; if an old
  // session document was already removed/expired, that touch can report
  // "Unable to find the session to touch" after the response has started.
  // A bounded touch interval avoids that noisy race while still extending
  // active sessions regularly.
  const sessionStore = MongoStore.create({
    mongoUrl: MONGODB_URI,
    dbName: DB_NAME,
    collectionName: "sessions",
    ttl: 60 * 60 * 24 * 7,
    touchAfter: 60 * 60
  });
  sessionStore.on("error", err => {
    const msg = String(err?.message || err || "");
    if (/Unable to find the session to touch/i.test(msg)) {
      console.warn("Session touch skipped for an expired/missing session.");
      return;
    }
    console.error("Mongo session store error:", err);
  });
  app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  }));

  // CSRF defense for browser sessions. Authenticated state-changing requests must
  // originate from the same site. No new dependency or environment variable.
  app.use((req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const cookieHeader = String(req.headers?.cookie || "");
    const hasSessionCookie = /(?:^|;)\s*(?:connect\.sid|__Host-smarttep\.sid)=/i.test(cookieHeader);
    if (!hasSessionCookie) return next();
    const candidate = String(req.headers?.origin || req.headers?.referer || "").trim();
    if (!candidate) return res.status(403).json({ error: "Security check failed: request origin is missing." });
    try {
      const expected = `${req.protocol}://${req.get("host")}`;
      if (new URL(candidate).origin !== expected) return res.status(403).json({ error: "Security check failed: cross-site request blocked." });
    } catch (_) { return res.status(403).json({ error: "Security check failed: invalid request origin." }); }
    next();
  });


  // Smart Security Agent: defensive request monitoring and controlled response.
  // The agent never stores passwords, cookies, authorization headers, or raw request bodies.
  // Smart Security uses a small in-memory cache for speed plus a MongoDB
  // collection for temporary blocks that must survive a Render restart/sleep.
  const smartBlocked = new Map();
  const SMART_PATTERNS = [
    // These patterns are deliberately narrow enough to reduce false positives while
    // catching common automated web-attack probes. Smart never executes the payload.
    { re: /(?:\bunion\s+(?:all\s+)?select\b|\bselect\b.{0,120}\bfrom\b.{0,120}(?:--|#|\bwhere\b)|\bdrop\s+(?:table|database)\b|\binsert\s+into\b.{0,120}\bvalues\b|\bdelete\s+from\b.{0,120}\bwhere\b)/i, type: "sql-injection", severity: "critical", score: 98 },
    { re: /(?:<script(?:\s|>)|javascript\s*:|(?:onerror|onload|onclick|onmouseover)\s*=|<iframe(?:\s|>))/i, type: "xss-probe", severity: "high", score: 90 },
    { re: /(?:\.\.\/(?:\.\.\/)*|%2e%2e(?:%2f|\/)|%252e%252e|\/etc\/(?:passwd|shadow)|(?:^|[\/])boot\.ini(?:$|[?#]))/i, type: "path-traversal", severity: "high", score: 92 },
    { re: /(?:<\?php|powershell(?:\.exe)?\s+-(?:enc|encodedcommand|command)|cmd(?:\.exe)?\s+\/c|\b(?:bash|sh)\s+-c\b|base64_decode\s*\()/i, type: "malicious-payload-probe", severity: "critical", score: 99 },
    { re: /(?:\b(?:wp-admin|wp-login\.php|xmlrpc\.php|phpmyadmin)\b|(?:^|[\/])\.env(?:$|[?#]))/i, type: "scanner-probe", severity: "medium", score: 65 }
  ];

  function smartClientIp(req) {
    return String(req.ip || req.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
  }
  function smartDeviceKey(req, res) {
    const existing = smartCookieValue(req, "smart_device_id");
    if (/^[a-f0-9]{64}$/.test(existing)) return existing;
    return res ? smartEnsureDeviceId(req, res) : `legacy:${smartClientIp(req)}:${smartSafeText(req.headers?.["user-agent"], 200)}`;
  }
  function smartSafeText(value, max = 800) {
    return String(value || "").slice(0, max);
  }
  function smartInspect(req) {
    // Inspect only non-secret request metadata/body fields. Passwords, cookies,
    // authorization headers and uploaded file contents are intentionally excluded.
    const pieces = [
      smartSafeText(req.originalUrl || req.url, 2000),
      smartSafeText(req.method, 20),
      smartSafeText(req.headers?.referer, 500)
    ];
    const body = req.body;
    const safeBodyParts = [];
    function collect(value, key = "", depth = 0) {
      if (depth > 3 || safeBodyParts.join(" ").length > 7000) return;
      if (/password|token|secret|authorization|cookie|credential/i.test(key)) return;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        safeBodyParts.push(String(value).slice(0, 1000));
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 20)) collect(item, key, depth + 1);
        return;
      }
      if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value).slice(0, 30)) collect(v, k, depth + 1);
      }
    }
    collect(body);
    pieces.push(safeBodyParts.join(" "));
    const target = pieces.join(" ");
    const hit = SMART_PATTERNS.find(x => x.re.test(target));
    if (hit) return hit;
    const statusHint = String(req.headers?.["user-agent"] || "");
    if (/sqlmap|nikto|nmap|masscan|zgrab|wpscan|nuclei/i.test(statusHint)) return { type: "scanner-user-agent", severity: "high", score: 88 };
    return null;
  }
  async function smartSettings() {
    const s = await appSettings.findOne({ _id: "smart_security" });
    return { ...defaultSmartSecurity, ...(s || {}) };
  }
  async function smartIsBlocked(deviceKey, ip = null) {
    const cachedUntil = smartBlocked.get(deviceKey);
    if (cachedUntil) {
      if (cachedUntil > Date.now()) return true;
      smartBlocked.delete(deviceKey);
    }
    const ipCacheKey = ip ? `ip:${ip}` : null;
    if (ipCacheKey) {
      const ipCachedUntil = smartBlocked.get(ipCacheKey);
      if (ipCachedUntil) {
        if (ipCachedUntil > Date.now()) return true;
        smartBlocked.delete(ipCacheKey);
      }
    }
    try {
      const now = new Date();
      const row = await securityBlocks.findOne({ deviceKey, until: { $gt: now } });
      if (row) {
        smartBlocked.set(deviceKey, new Date(row.until).getTime());
        return true;
      }
      if (ip) {
        const ipRow = await securityBlocks.findOne({ ip, blockType: "dormant-student-ip", until: { $gt: now } });
        if (ipRow) {
          const untilMs = new Date(ipRow.until).getTime();
          smartBlocked.set(ipCacheKey, untilMs);
          return true;
        }
      }
      return false;
    } catch (e) {
      console.error("Smart block lookup failed:", e?.message || e);
      return false;
    }
  }

  async function smartBlockIp(ip, minutes, reason, req, res) {
    const deviceKey = smartDeviceKey(req, res);
    const until = new Date(Date.now() + Math.max(5, Number(minutes || 60)) * 60 * 1000);
    smartBlocked.set(deviceKey, until.getTime());
    await securityBlocks.updateOne(
      { deviceKey },
      { $set: { deviceKey, ip, until, reason: String(reason || "smart-security"), updatedAt: new Date() } },
      { upsert: true }
    );
    if (req) await smartRecord(req, { type: "automatic-block", severity: "high", score: 90, action: "device-blocked", targetIp: ip, blockUntil: until, reason: String(reason || "smart-security") });
  }
  async function smartRecord(req, data) {
    try {
      await securityEvents.insertOne({
        createdAt: new Date(), ip: smartClientIp(req), deviceKey: smartDeviceKey(req, null), method: req.method, path: smartSafeText(req.path || req.originalUrl, 300),
        userAgent: smartSafeText(req.headers?.["user-agent"], 300), userId: req.user?._id || null,
        ...data
      });
    } catch (e) { console.error("Smart security event log failed:", e?.message || e); }
  }

  app.use(async (req, res, next) => {
    const ip = smartClientIp(req);
    const deviceKey = smartDeviceKey(req, res);
    // Administrator requests always bypass Smart enforcement so Admin retains
    // final override authority even when a device/IP has been blocked.
    let isAdminRequest = false;
    if (req.session?.userId && req.path.startsWith("/api/admin")) {
      try {
        const adminUser = await users.findOne({ _id: oid(req.session.userId), role: "admin" }, { projection: { _id: 1 } });
        isAdminRequest = !!adminUser;
      } catch (_) {}
    }
    if (!isAdminRequest && await smartIsBlocked(deviceKey, ip)) return res.status(403).json({ error: "This device or IP address has been blocked by Smart Security." });
    const settings = await smartSettings().catch(() => defaultSmartSecurity);
    if (!settings.enabled) return next();
    const finding = smartInspect(req);
    if (finding) {
      const criticalNeedsApproval = finding.severity === "critical" && settings.requireApprovalForCritical;
      const automaticAllowed = settings.mode === "auto" && !criticalNeedsApproval && ((finding.severity === "critical" && settings.autoBlockCritical) || (finding.severity === "high" && settings.autoBlockHighRisk));
      await smartRecord(req, { type: finding.type, severity: finding.severity, score: finding.score, action: automaticAllowed ? "blocked" : (settings.requireApprovalForCritical && finding.severity === "critical" ? "approval-required" : "logged") });
      if (automaticAllowed) {
        await smartBlockIp(ip, settings.blockDurationMinutes, finding.type, req, res);
        return res.status(403).json({ error: "Request blocked by Smart Security." });
      }
    }
    const originalEnd = res.end;
    res.end = function(...args) {
      const status = res.statusCode;
      if (settings.enabled && [401, 403, 429, 413, 500, 502, 503].includes(status)) {
        smartRecord(req, { type: "security-response", severity: status >= 500 ? "medium" : "low", score: status >= 500 ? 55 : 35, action: "logged", statusCode: status });
      }
      return originalEnd.apply(this, args);
    };
    next();
  });

  // Keep Smart's security database bounded. Expired temporary blocks and old
  // security events are cleanup data; this does not remove student records.
  const securityCleanupTimer = setInterval(async () => {
    try {
      const now = new Date();
      await securityBlocks.deleteMany({ until: { $lte: now } });
      const settings = await smartSettings();
      const cutoff = new Date(Date.now() - Math.max(1, Number(settings.retentionDays || 30)) * 24 * 60 * 60 * 1000);
      await securityEvents.deleteMany({ createdAt: { $lt: cutoff } });
      await instructorSecurityEvents.deleteMany({ createdAt: { $lt: cutoff } });
      await instructorSecurityAlerts.deleteMany({ createdAt: { $lt: cutoff }, status: { $in: ["resolved","restored"] } });
    } catch (e) {
      console.error("Smart security cleanup failed:", e?.message || e);
    }
  }, 60 * 60 * 1000);
  securityCleanupTimer.unref();

  app.use((req, res, next) => {
    if (req.path === "/instructor-apply.html") {
      res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.set("Pragma", "no-cache");
      res.set("Expires", "0");
    }
    next();
  });
  app.get("/robots.txt", (req, res) => {
    const base = `${req.protocol}://${req.get("host")}`;
    res.type("text/plain").send(`User-agent: *\nAllow: /\nAllow: /about.html\nAllow: /contact.html\nAllow: /privacy.html\nAllow: /terms.html\nAllow: /advertising.html\nAllow: /verify-student.html\nAllow: /verify-instructor.html\nAllow: /instructor-apply.html\nDisallow: /api/\nDisallow: /admin.html\nDisallow: /student.html\nDisallow: /instructor.html\nDisallow: /chat.html\nDisallow: /ai-tutor.html\nDisallow: /live-tutor.html\nDisallow: /payment.html\nDisallow: /change-password.html\nSitemap: ${base}/sitemap.xml\n`);
  });

  app.use(express.static(path.join(ROOT, "public")));

  function isStudentIdle(user, now = Date.now()) {
    if (!user || user.role !== "student" || user.portalLocked) return false;
    const last = user.lastActivityAt ? new Date(user.lastActivityAt).getTime() : now;
    return Number.isFinite(last) && (now - last) >= STUDENT_IDLE_LOCK_MS;
  }

  async function autoLockIdleStudent(user, reason = "168-hour inactivity") {
    if (!user || user.role !== "student" || user.portalLocked) return false;
    if (!isStudentIdle(user)) return false;
    const now = new Date();
    const result = await users.updateOne(
      { _id: user._id, role: "student", portalLocked: { $ne: true }, lastActivityAt: user.lastActivityAt || null },
      { $set: { portalLocked: true, lockSource: "smart-inactivity", inactivityLockedAt: now, smartSuspendedAt: now, lockReason: reason } }
    );
    if (result.modifiedCount === 1) {
      try { await securityEvents.insertOne({ createdAt: now, type: "student-inactivity-suspension", severity: "high", score: 90, action: "student-account-suspended", userId: user._id, ip: user.lastActivityIp || null, reason }); } catch (_) {}
    }
    return result.modifiedCount === 1;
  }

  async function touchStudentActivity(userId, ip = null) {
    const id = oid(userId);
    if (!id) return null;
    const user = await users.findOne({ _id: id });
    if (!user) return null;
    // Never silently unlock a manually/admin-locked account.
    if (user.role !== "student" || user.portalLocked) return user;
    const now = new Date();
    const patch = { lastActivityAt: now };
    if (ip) patch.lastActivityIp = String(ip);
    await users.updateOne({ _id: id }, { $set: patch });
    Object.assign(user, patch);
    return user;
  }

  async function enforceStudentInactivity() {
    const now = Date.now();
    const cutoff = new Date(now - STUDENT_IDLE_LOCK_MS);
    const dormantIpCutoff = new Date(now - STUDENT_DORMANT_IP_BLOCK_MS);
    const settings = await smartSettings().catch(() => defaultSmartSecurity);
    let suspended = 0;
    let ipBlocked = 0;

    if (settings.autoSuspendInactiveStudents !== false) {
      const rows = await users.find({ role: "student", portalLocked: { $ne: true }, lastActivityAt: { $exists: true, $lte: cutoff } }).project({ _id: 1, lastActivityAt: 1, lastActivityIp: 1 }).toArray();
      if (rows.length) {
        const ids = rows.map(x => x._id);
        const result = await users.updateMany(
          { _id: { $in: ids }, role: "student", portalLocked: { $ne: true }, lastActivityAt: { $lte: cutoff } },
          { $set: { portalLocked: true, lockSource: "smart-inactivity", inactivityLockedAt: new Date(), smartSuspendedAt: new Date(), lockReason: "168-hour inactivity" } }
        );
        suspended = result.modifiedCount || 0;
        for (const row of rows) {
          try { await securityEvents.insertOne({ createdAt: new Date(), type: "student-inactivity-suspension", severity: "high", score: 90, action: "student-account-suspended", userId: row._id, ip: row.lastActivityIp || null, reason: "168-hour inactivity" }); } catch (_) {}
        }
      }
    }

    if (settings.autoBlockDormantStudentIps !== false) {
      const dormant = await users.find({ role: "student", lastActivityAt: { $exists: true, $lte: dormantIpCutoff }, lastActivityIp: { $type: "string", $ne: "" } }).project({ _id: 1, lastActivityAt: 1, lastActivityIp: 1 }).toArray();
      for (const row of dormant) {
        const ip = String(row.lastActivityIp || "").trim();
        if (!ip) continue;
        const existing = await securityBlocks.findOne({ ip, blockType: "dormant-student-ip", until: { $gt: new Date() } });
        if (existing) continue;

        // Public IPs can be shared by schools, offices, households and hotspots.
        // Never turn a known multi-student IP into an automatic global block.
        // Instead, leave an admin-review event so the administrator can decide.
        const ipUsers = await users.find({ role: "student", lastActivityIp: ip }).project({ _id: 1, lastActivityAt: 1 }).limit(3).toArray();
        if (ipUsers.length > 1) {
          try {
            await securityEvents.insertOne({
              createdAt: new Date(),
              type: "dormant-student-ip-review",
              severity: "medium",
              score: 50,
              action: "shared-ip-auto-block-skipped",
              targetIp: ip,
              userId: row._id,
              reason: "336-hour dormancy detected, but the same public IP is associated with multiple student accounts; admin review required to avoid affecting other users."
            });
          } catch (_) {}
          continue;
        }

        const until = new Date("9999-12-31T23:59:59.999Z");
        await securityBlocks.updateOne(
          { ip, blockType: "dormant-student-ip" },
          { $set: { ip, blockType: "dormant-student-ip", until, reason: "student-ip-dormant-336-hours", studentId: row._id, dormantSince: row.lastActivityAt, updatedAt: new Date() } },
          { upsert: true }
        );
        ipBlocked++;
        try { await securityEvents.insertOne({ createdAt: new Date(), type: "dormant-student-ip-block", severity: "high", score: 90, action: "student-ip-blocked", targetIp: ip, userId: row._id, reason: "336-hour student dormancy; no other student account is known to share this IP" }); } catch (_) {}
      }
    }
    if (suspended || ipBlocked) console.log(`Smart inactivity: suspended ${suspended} student account(s); blocked ${ipBlocked} dormant student IP(s).`);
    return { suspended, ipBlocked };
  }

  const inactivityTimer = setInterval(() => {
    enforceStudentInactivity().catch(err => console.error("Smart inactivity check failed:", err?.message || err));
  }, STUDENT_IDLE_CHECK_MS);
  inactivityTimer.unref();


  async function getAdmin2fa(user) {
    return user?.role === "admin" ? (user.admin2fa || { enabled: false }) : { enabled: false };
  }
  async function requireAdmin2fa(req, res) {
    if (req.user?.role === "admin" && (await getAdmin2fa(req.user)).enabled && req.session.admin2faVerified !== true) {
      res.status(403).json({ error: "Admin two-factor authentication is required.", code: "ADMIN_2FA_REQUIRED" });
      return false;
    }
    return true;
  }
  async function admin2faGuard(req, res, next) {
    try {
      if (!req.user || req.user.role !== "admin") return next();
      if (!(await getAdmin2fa(req.user)).enabled) return next();
      if (req.session.admin2faVerified !== true) return res.status(403).json({ error: "Admin two-factor authentication is required.", code: "ADMIN_2FA_REQUIRED" });
      next();
    } catch (e) { next(e); }
  }

  function auth(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: "Authentication required" });
    const id = oid(req.session.userId);
    if (!id) return res.status(401).json({ error: "Session expired" });
    users.findOne({ _id: id }).then(async user => {
      if (!user) return res.status(401).json({ error: "Session expired" });
      const currentPasswordVersion = Number(user.passwordVersion || 0);
      const sessionPasswordVersion = req.session.passwordVersion == null ? 0 : Number(req.session.passwordVersion);
      if (sessionPasswordVersion !== currentPasswordVersion) {
        return req.session.destroy(() => res.status(401).json({ error: "Your session was ended because your password was reset. Please sign in again." }));
      }
      if (await autoLockIdleStudent(user)) {
        user.portalLocked = true;
        user.lockSource = "smart-inactivity";
        user.lockReason = "168-hour inactivity";
      }
      req.user = user;
      next();
    }).catch(next);
  }

  app.post("/api/activity", async (req, res, next) => {
    try {
      if (!req.session.userId) return res.status(401).json({ error: "Authentication required" });
      const user = await users.findOne({ _id: oid(req.session.userId) });
      if (!user) return res.status(401).json({ error: "Session expired" });
      if (user.role === "student" && user.portalLocked) {
        return res.status(423).json({ error: "Your student account is locked. Please contact the administrator." });
      }
      await touchStudentActivity(req.session.userId, smartClientIp(req));
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  async function admin(req, res, next) {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
    if (!(await requireAdmin2fa(req, res))) return;
    next();
  }

  async function recordInstructorSecurityEvent(req, statusCode) {
    if (req.user?.role !== "instructor") return;
    try {
      const now = new Date();
      const destructive = /\/(courses|lessons|assignments|students|submissions)/i.test(req.path || "") && ["POST","PUT","PATCH","DELETE"].includes(req.method);
      const unauthorized = [401,403,404,423].includes(Number(statusCode));
      const event = { instructorId: req.user._id, instructorName: req.user.name || "", instructorEmail: req.user.email || "", createdAt: now, method:req.method, path:smartSafeText(req.path || req.originalUrl,300), statusCode:Number(statusCode||200), ip:smartClientIp(req), userAgent:smartSafeText(req.headers?.["user-agent"],300), destructive, unauthorized };
      await instructorSecurityEvents.insertOne(event);
      const since = new Date(Date.now() - 5*60*1000);
      const recent = await instructorSecurityEvents.countDocuments({instructorId:req.user._id,createdAt:{$gte:since}});
      const recentUnauthorized = await instructorSecurityEvents.countDocuments({instructorId:req.user._id,createdAt:{$gte:since},unauthorized:true});
      const recentDestructive = await instructorSecurityEvents.countDocuments({instructorId:req.user._id,createdAt:{$gte:since},destructive:true});
      let severity = null, reason = null, action = "logged";
      if (recentUnauthorized >= 10) { severity="critical"; reason="Repeated unauthorized or invalid instructor requests"; }
      else if (recentUnauthorized >= 5 || recentDestructive >= 25) { severity="high"; reason=recentUnauthorized>=5 ? "Repeated denied instructor requests" : "Unusually high destructive activity"; }
      else if (recent >= 80) { severity="medium"; reason="Unusually high instructor request volume"; }
      if (severity) {
        const open = await instructorSecurityAlerts.findOne({instructorId:req.user._id,status:"open",reason});
        if (!open) {
          await instructorSecurityAlerts.insertOne({instructorId:req.user._id,instructorName:req.user.name||"",instructorEmail:req.user.email||"",createdAt:now,status:severity === "critical" ? "suspended" : "open",severity,reason,metrics:{recent,recentUnauthorized,recentDestructive},lastEventAt:now});
        }
        if (severity === "critical") {
          await users.updateOne({_id:req.user._id,role:"instructor"},{$set:{instructorSuspended:true,instructorSuspensionSource:"smart-instructor-monitor",instructorSuspensionReason:reason,instructorSuspendedAt:now}});
          action="auto-suspended";
        }
        await securityEvents.insertOne({createdAt:now,ip:smartClientIp(req),deviceKey:smartDeviceKey(req,null),method:req.method,path:smartSafeText(req.path||req.originalUrl,300),userAgent:smartSafeText(req.headers?.["user-agent"],300),userId:req.user._id,type:"instructor-risk",severity,score:severity==="critical"?95:severity==="high"?80:60,action});
      }
    } catch(e) { console.error("Instructor security monitor failed:",e?.message||e); }
  }

  function instructor(req, res, next) {
    if (req.user?.role !== "instructor" || req.user?.instructorApproved === false || req.user?.instructorSuspended) {
      return res.status(403).json({ error: "Instructor access is not active. Please contact the administrator." });
    }
    const originalEnd=res.end;
    res.end=function(...args){ const status=res.statusCode; recordInstructorSecurityEvent(req,status).catch(()=>{}); return originalEnd.apply(this,args); };
    next();
  }

  function teachingOwnerFilter(user, courseId) {
    return { _id: courseId, ownerInstructorId: user._id.toString() };
  }

  async function instructorOwnsCourse(user, courseId) {
    if (user?.role === "admin") return true;
    if (user?.role !== "instructor") return false;
    return !!(await courseCollection.findOne(teachingOwnerFilter(user, courseId), { projection: { _id: 1 } }));
  }

  function normalizeLessonUnlockAt(value) {
    if (value === undefined || value === null || String(value).trim() === "") return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  async function lessonAccessState(student, lesson, course, allLessons = null) {
    if (!student || student.role === "admin") return { allowed: true, reason: "admin" };
    if (student.role === "instructor" && String(course?.ownerInstructorId || "") === String(student._id)) return { allowed: true, reason: "course-owner" };
    if (!lesson || !course) return { allowed: false, reason: "not-found" };
    if (course.locked) return { allowed: false, reason: "course-locked" };
    if (!studentHasCourse(student, course._id)) return { allowed: false, reason: "not-enrolled" };

    const override = await lessonAccessOverrides.findOne({ studentId: student._id, lessonId: lesson._id });
    if (override?.grant === true) return { allowed: true, reason: "admin-override" };
    if (lesson.smartLockOverride === true) return { allowed: true, reason: "admin-override" };

    const progress = await lessonProgress.findOne({ userId: student._id, lessonId: lesson._id });
    if (progress?.accessedAt || progress?.completed === true) return { allowed: true, reason: "previously-accessed" };

    const unlockAt = lesson.unlockAt ? new Date(lesson.unlockAt) : null;
    if (unlockAt && !Number.isNaN(unlockAt.getTime()) && unlockAt.getTime() <= Date.now()) return { allowed: true, reason: "scheduled" };

    const list = allLessons || await lessons.find({ courseId: course._id }).sort({ createdAt: 1, _id: 1 }).toArray();
    const first = list.length ? String(list[0]._id) === String(lesson._id) : true;
    if (first && !unlockAt) return { allowed: true, reason: "first-lesson" };
    return { allowed: false, reason: unlockAt ? "scheduled-lock" : "smart-sequence-lock", unlockAt: unlockAt || null };
  }

  async function markLessonAccess(studentId, lessonId, courseId) {
    const now = new Date();
    await lessonProgress.updateOne(
      { userId: studentId, lessonId },
      { $set: { userId: studentId, lessonId, courseId, accessedAt: now, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true }
    );
  }

  function studentAccess(req, res, next) {
    if (req.user.role === "admin") return next();
    if (req.user.portalLocked) return res.status(423).json({ error: "Your student portal is locked by an administrator." });
    if (!req.user.approved) return res.status(403).json({ error: "Your account is awaiting admin approval." });
    next();
  }

  // Chat is shared by students, instructors and administrators. Instructors
  // are intentionally limited to direct communication with administrators so
  // the instructor portal has a private support/escalation channel without
  // turning the existing student chat into an instructor directory.
  function chatAccess(req, res, next) {
    if (req.user?.role === "admin") return next();
    if (req.user?.role === "instructor") {
      if (req.user.instructorApproved === false || req.user.instructorSuspended) {
        return res.status(403).json({ error: "Instructor chat access is not active. Please contact the administrator." });
      }
      return next();
    }
    return studentAccess(req, res, next);
  }

  function enrolledCourseIds(user) {
    return Array.isArray(user?.enrolledCourseIds) ? user.enrolledCourseIds.map(String) : [];
  }

  function studentHasCourse(user, courseId) {
    if (user?.role === "admin") return true;
    return enrolledCourseIds(user).includes(String(courseId));
  }

  async function getAILimits() {
    let settings = await aiSettings.findOne({ _id: "global" });
    if (!settings) {
      settings = { _id: "global", dailyCredits: 10, unlimitedAdmins: true, costs: { chat: 1, image: 1, document: 1, video: 5, speech: 1, quiz: 1, studyPlan: 1 } };
      await aiSettings.updateOne({ _id: "global" }, { $setOnInsert: { ...settings, updatedAt: new Date() } }, { upsert: true });
    }
    return {
      dailyCredits: Math.max(0, Number(settings.dailyCredits ?? 10)),
      unlimitedAdmins: settings.unlimitedAdmins !== false,
      costs: {
        chat: Math.max(0, Number(settings.costs?.chat ?? 1)),
        image: Math.max(0, Number(settings.costs?.image ?? 1)),
        document: Math.max(0, Number(settings.costs?.document ?? 1)),
        video: Math.max(0, Number(settings.costs?.video ?? 5)),
        speech: Math.max(0, Number(settings.costs?.speech ?? 1)),
        quiz: Math.max(0, Number(settings.costs?.quiz ?? 1)),
        studyPlan: Math.max(0, Number(settings.costs?.studyPlan ?? 1))
      }
    };
  }

  function aiDateKey() {
    try { return new Intl.DateTimeFormat("en-CA", { timeZone: process.env.AI_USAGE_TIMEZONE || "Africa/Lagos" }).format(new Date()); }
    catch { return new Date().toISOString().slice(0, 10); }
  }

  async function reserveAICredits(user, action) {
    const limits = await getAILimits();
    const cost = limits.costs[action] ?? 1;
    const unlimited = user.role === "admin" && limits.unlimitedAdmins;
    if (unlimited || cost === 0) {
      if (cost > 0) await aiUsage.updateOne({ userId: user._id, dateKey: aiDateKey() }, { $inc: { credits: cost, [`actions.${action}`]: 1 }, $set: { updatedAt: new Date() } }, { upsert: true });
      return { allowed: true, cost, unlimited: true, used: null, limit: null, remaining: null };
    }
    const limit = limits.dailyCredits;
    if (limit <= 0 || cost > limit) return { allowed: false, cost, used: 0, limit, remaining: 0 };
    const dateKey = aiDateKey();
    let doc = await aiUsage.findOneAndUpdate(
      { userId: user._id, dateKey, $expr: { $lte: [{ $add: [{ $ifNull: ["$credits", 0] }, cost] }, limit] } },
      { $inc: { credits: cost, [`actions.${action}`]: 1 }, $set: { updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    if (!doc) {
      try {
        await aiUsage.insertOne({ userId: user._id, dateKey, credits: cost, actions: { [action]: 1 }, createdAt: new Date(), updatedAt: new Date() });
        doc = await aiUsage.findOne({ userId: user._id, dateKey });
      } catch (e) {
        if (e?.code === 11000) return reserveAICredits(user, action);
        throw e;
      }
    }
    const used = Number(doc.credits || 0);
    return { allowed: true, cost, used, limit, remaining: Math.max(0, limit - used) };
  }

  async function refundAICredits(user, action, cost, dateKey = aiDateKey()) {
    if (!cost || (user.role === "admin" && (await getAILimits()).unlimitedAdmins)) return;
    await aiUsage.updateOne({ userId: user._id, dateKey }, { $inc: { credits: -cost, [`actions.${action}`]: -1 }, $set: { updatedAt: new Date() } });
  }

  async function requireAICredits(req, res, action) {
    const result = await reserveAICredits(req.user, action);
    if (!result.allowed) {
      return res.status(429).json({ error: `You have used all ${result.limit} AI credits for today. Your AI credits reset tomorrow.`, code: "DAILY_AI_LIMIT", usage: result });
    }
    return result;
  }

  function lagosDateString(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return `${map.year}-${map.month}-${map.day}`;
  }
  function parseDateOnly(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
    const [y,m,d] = String(value).split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  function dateOnlyString(date) {
    return date.toISOString().slice(0,10);
  }
  function addDays(date, days) {
    const d = new Date(date.getTime());
    d.setUTCDate(d.getUTCDate() + days);
    return d;
  }
  function attendanceSchedule(enrollment, course) {
    const start = parseDateOnly(enrollment?.enrolledAtDate || lagosDateString(enrollment?.enrolledAt || new Date()));
    if (!start) return [];
    const weeks = Math.min(104, Math.max(1, Number(course?.durationWeeks || 12)));
    const end = addDays(start, weeks * 7 - 1);
    const rows = [];
    for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
      const weekday = d.getUTCDay(); // 0 Sunday ... 6 Saturday
      if (weekday >= 1 && weekday <= 5) rows.push(dateOnlyString(d));
    }
    return rows;
  }
  async function ensureEnrollment(studentId, courseId, fallbackDate) {
    const sid = oid(studentId), cid = oid(courseId);
    if (!sid || !cid) return null;
    const existing = await courseEnrollments.findOne({ studentId: sid, courseId: cid });
    if (existing) return existing;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(fallbackDate || "")) ? String(fallbackDate) : lagosDateString();
    const doc = { studentId: sid, courseId: cid, enrolledAt: new Date(), enrolledAtDate: date, createdAt: new Date(), updatedAt: new Date() };
    try {
      await courseEnrollments.insertOne(doc);
      return doc;
    } catch (e) {
      if (e?.code === 11000) return await courseEnrollments.findOne({ studentId: sid, courseId: cid });
      throw e;
    }
  }
  async function getStudentAttendance(studentId) {
    const student = await users.findOne({ _id: oid(studentId), role: "student" });
    if (!student) return [];
    const courseIds = enrolledCourseIds(student).map(oid).filter(Boolean);
    const courses = courseIds.length ? await courseCollection.find({ _id: { $in: courseIds } }).sort({ title: 1 }).toArray() : [];
    const output = [];
    for (const course of courses) {
      const enrollment = await ensureEnrollment(student._id, course._id, student.registrationDate || (student.createdAt ? lagosDateString(student.createdAt) : lagosDateString()));
      const schedule = attendanceSchedule(enrollment, course);
      const marks = await attendanceRecords.find({ studentId: student._id, courseId: course._id, date: { $in: schedule } }).toArray();
      const marked = new Set(marks.map(x => x.date));
      const today = lagosDateString();
      output.push({
        course_id: course._id.toString(), course_title: course.title, duration_weeks: Number(course.durationWeeks || 12),
        enrollment_date: enrollment?.enrolledAtDate || schedule[0] || today,
        dates: schedule.map(date => ({ date, day: new Date(date+"T00:00:00Z").toLocaleDateString("en-US",{weekday:"long",timeZone:"UTC"}), marked: marked.has(date), is_today: date === today, can_mark: date === today && !marked.has(date) })),
        marked_count: marks.length, total_days: schedule.length
      });
    }
    return output;
  }
  function courseDurationPayload(course) {
    return Number(course?.durationWeeks || 12);
  }

  function cleanStudentIdentity(body) {
    const clean = value => String(value ?? "").trim().replace(/\s+/g, " ");
    const name = clean(body.name);
    const studentIdNumber = clean(body.studentIdNumber).toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 40);
    const courseCode = clean(body.courseCode).toUpperCase().slice(0, 50);
    const state = clean(body.state).slice(0, 80);
    const country = clean(body.country).slice(0, 80);
    const gender = clean(body.gender).slice(0, 30);
    const registrationDate = clean(body.registrationDate);
    const programmeEndDate = clean(body.programmeEndDate);
    const validDate = value => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
    if (studentIdNumber && !/^[A-Z0-9_-]{3,40}$/.test(studentIdNumber)) throw Object.assign(new Error("Invalid student ID number."), { status: 400 });
    if (!validDate(registrationDate) || !validDate(programmeEndDate)) throw Object.assign(new Error("Dates must use YYYY-MM-DD format."), { status: 400 });
    if (gender && !["Male", "Female", "Other", "Prefer not to say"].includes(gender)) throw Object.assign(new Error("Invalid gender selection."), { status: 400 });
    return { studentIdNumber: studentIdNumber || null, courseCode, state, country, gender, registrationDate: registrationDate || null, programmeEndDate: programmeEndDate || null };
  }

  async function generateStudentIdNumber() {
    for (let i = 0; i < 10; i++) {
      const candidate = `SMARTTEP-${new Date().getUTCFullYear()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      if (!(await users.findOne({ studentIdNumber: candidate }, { projection: { _id: 1 } }))) return candidate;
    }
    throw Object.assign(new Error("Could not generate a unique student ID number."), { status: 500 });
  }

  function cleanInstructorIdentity(body) {
    const clean = value => String(value ?? "").trim().replace(/\s+/g, " ");
    const instructorIdNumber = clean(body.instructorIdNumber).toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 40);
    const registrationDate = clean(body.registrationDate);
    const expiryDate = clean(body.expiryDate);
    const department = clean(body.department).slice(0, 100);
    const validDate = value => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
    if (instructorIdNumber && !/^[A-Z0-9_-]{3,40}$/.test(instructorIdNumber)) throw Object.assign(new Error("Invalid instructor ID number."), { status: 400 });
    if (!validDate(registrationDate) || !validDate(expiryDate)) throw Object.assign(new Error("Dates must use YYYY-MM-DD format."), { status: 400 });
    return { instructorIdNumber: instructorIdNumber || null, registrationDate: registrationDate || null, expiryDate: expiryDate || null, department };
  }

  async function generateInstructorIdNumber() {
    for (let i = 0; i < 10; i++) {
      const candidate = `SMARTTEP-INST-${new Date().getUTCFullYear()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      if (!(await users.findOne({ instructorIdNumber: candidate }, { projection: { _id: 1 } }))) return candidate;
    }
    throw Object.assign(new Error("Could not generate a unique instructor ID number."), { status: 500 });
  }

  app.post("/api/register", rateLimit({ windowMs: 60 * 60 * 1000, max: 10, keyPrefix: "register" }), profileUpload.single("profilePicture"), async (req, res, next) => {
    try {
      const { name, email, password } = req.body;
      const identity = cleanStudentIdentity(req.body);
      const rawCourseIds = Array.isArray(req.body.courseIds) ? req.body.courseIds : (req.body.courseIds ? [req.body.courseIds] : []);
      const cleanName = String(name || "").trim().slice(0, 120);
      const cleanEmail = String(email || "").trim().toLowerCase();
      if (!cleanName || !cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || !password || password.length < 8)
        return res.status(400).json({ error: "Enter a valid name, email and an 8+ character password." });
      const courseIds = [...new Set(rawCourseIds.map(oid).filter(Boolean).map(x => x.toString()))];
      if (courseIds.length) {
        const valid = await courseCollection.countDocuments({ _id: { $in: courseIds.map(x => new ObjectId(x)) } });
        if (valid !== courseIds.length) return res.status(400).json({ error: "One or more selected courses are invalid." });
      }
      const hash = await bcrypt.hash(password, 12);
      let profilePicture = null;
      if (req.file && !validProfileImage(req.file)) return res.status(400).json({ error: "Profile picture must be a JPG, PNG, or WEBP image." });
      if (req.file) {
        const uploaded = await uploadBuffer(req.file.buffer, req.file.originalname, "profile-pictures", "image");
        profilePicture = {
          url: uploaded.secure_url || uploaded.url,
          publicId: uploaded.public_id,
          resourceType: uploaded.resource_type || "image",
          type: uploaded.type || "upload",
          originalName: req.file.originalname
        };
      }
      const result = await users.insertOne({
        name: cleanName,
        email: cleanEmail,
        passwordHash: hash,
        role: "student",
        portalLocked: false,
        paymentStatus: "unpaid",
        approved: false,
        enrolledCourseIds: courseIds,
        profilePicture,
        studentIdNumber: null,
        courseCode: identity.courseCode,
        state: identity.state,
        country: identity.country || "Nigeria",
        gender: identity.gender,
        registrationDate: identity.registrationDate || new Date().toISOString().slice(0,10),
        programmeEndDate: identity.programmeEndDate,
        lastActivityAt: new Date(),
        createdAt: new Date()
      });
      req.session.userId = result.insertedId.toString();
      await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
      res.json({ ok: true, redirect: "/payment.html" });
    } catch (e) {
      if (e && e.code === 11000) return res.status(400).json({ error: "Email already registered." });
      next(e);
    }
  });


  app.post("/api/admin/2fa/verify", rateLimit({ windowMs: 10 * 60 * 1000, max: 8, keyPrefix: "admin-2fa-verify", by: "device" }), async (req, res, next) => {
    try {
      const pendingId = oid(req.session?.admin2faUserId);
      if (!pendingId || !req.session?.admin2faPendingAt || Date.now() - Number(req.session.admin2faPendingAt) > 10 * 60 * 1000) {
        return res.status(401).json({ error: "Admin verification session expired. Please sign in again." });
      }
      const user = await users.findOne({ _id: pendingId, role: "admin" });
      if (!user || !(await getAdmin2fa(user)).enabled) return res.status(401).json({ error: "Admin verification is not available for this session." });
      const cfg = user.admin2fa;
      let valid = false, usedRecovery = false;
      try { valid = verifyTotp(decryptAdmin2faSecret(cfg.secret), req.body?.code); } catch (_) { valid = false; }
      if (!valid) {
        const normalized = normalizeRecoveryCode(req.body?.recoveryCode || req.body?.code);
        if (normalized.length >= 8 && Array.isArray(cfg.recoveryCodeHashes)) {
          for (let i = 0; i < cfg.recoveryCodeHashes.length; i++) {
            if (cfg.recoveryCodeHashes[i].usedAt) continue;
            if (await bcrypt.compare(normalized, cfg.recoveryCodeHashes[i].hash)) { valid = true; usedRecovery = true; break; }
          }
          if (valid && usedRecovery) {
            const nextCodes = cfg.recoveryCodeHashes.map(x => ({ ...x }));
            for (const x of nextCodes) if (!x.usedAt && await bcrypt.compare(normalized, x.hash)) { x.usedAt = new Date(); break; }
            await users.updateOne({ _id: user._id }, { $set: { "admin2fa.recoveryCodeHashes": nextCodes } });
          }
        }
      }
      if (!valid) {
        await smartRecord(req, { type: "admin-2fa-failure", severity: "high", score: 70, action: "denied" });
        return res.status(401).json({ error: "Invalid authenticator or recovery code." });
      }
      await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
      req.session.userId = user._id.toString();
      req.session.admin2faVerified = true;
      await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
      await smartRecord(req, { type: "admin-2fa-success", severity: "info", score: 0, action: usedRecovery ? "recovery-code-used" : "verified" });
      res.json({ ok: true, redirect: "/admin.html", recoveryCodeUsed: usedRecovery });
    } catch (e) { next(e); }
  });

  app.get("/api/admin/2fa/status", auth, async (req, res, next) => {
    try {
      if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
      const cfg = await getAdmin2fa(req.user);
      res.json({ enabled: !!cfg.enabled, verified: req.session.admin2faVerified === true, remainingRecoveryCodes: (cfg.recoveryCodeHashes || []).filter(x => !x.usedAt).length });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/2fa/setup", auth, admin, async (req, res, next) => {
    try {
      if (req.user.admin2fa?.enabled) return res.status(400).json({ error: "Two-factor authentication is already enabled." });
      const secret = base32Encode(crypto.randomBytes(20));
      const issuer = "SMARTTEP ACADEMY";
      const label = `${issuer}:${req.user.email}`;
      const otpauth = `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
      const qrDataUrl = await QRCode.toDataURL(otpauth, { width: 240, margin: 2 });
      req.session.admin2faSetup = { secret: encryptAdmin2faSecret(secret), createdAt: Date.now() };
      await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
      res.json({ ok: true, secret, otpauth, qrDataUrl });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/2fa/enable", auth, admin, async (req, res, next) => {
    try {
      const pending = req.session.admin2faSetup;
      if (!pending || Date.now() - Number(pending.createdAt || 0) > 15 * 60 * 1000) return res.status(400).json({ error: "2FA setup has expired. Start setup again." });
      const secret = decryptAdmin2faSecret(pending.secret);
      if (!verifyTotp(secret, req.body?.code)) return res.status(400).json({ error: "Invalid authenticator code. Check your device time and try again." });
      const recoveryCodes = Array.from({ length: 10 }, newRecoveryCode);
      const recoveryCodeHashes = [];
      for (const code of recoveryCodes) recoveryCodeHashes.push({ hash: await bcrypt.hash(normalizeRecoveryCode(code), 12), usedAt: null });
      await users.updateOne({ _id: req.user._id, role: "admin" }, { $set: { admin2fa: { enabled: true, secret: pending.secret, recoveryCodeHashes, enabledAt: new Date() } } });
      delete req.session.admin2faSetup;
      req.session.admin2faVerified = true;
      await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
      await smartRecord(req, { type: "admin-2fa-enabled", severity: "info", score: 0, action: "enabled" });
      res.json({ ok: true, recoveryCodes });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/2fa/disable", auth, admin, async (req, res, next) => {
    try {
      const cfg = await getAdmin2fa(req.user);
      if (!cfg.enabled) return res.json({ ok: true, disabled: true });
      let valid = false;
      try { valid = verifyTotp(decryptAdmin2faSecret(cfg.secret), req.body?.code); } catch (_) {}
      if (!valid) return res.status(401).json({ error: "Enter a valid current authenticator code to disable 2FA." });
      await users.updateOne({ _id: req.user._id, role: "admin" }, { $set: { admin2fa: { enabled: false } } });
      await smartRecord(req, { type: "admin-2fa-disabled", severity: "high", score: 60, action: "disabled" });
      res.json({ ok: true, disabled: true });
    } catch (e) { next(e); }
  });

  app.post("/api/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyPrefix: "login", by: "device" }), async (req, res, next) => {
    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      const password = String(req.body.password || "");
      const user = await users.findOne({ email });
      const valid = !!user && await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        await smartRecord(req, { type: "login-failure", severity: "low", score: 35, action: "logged", target: email ? "known-format" : "missing-email" });
        const windowStart = new Date(Date.now() - 15 * 60 * 1000);
        const deviceKey = smartDeviceKey(req, res);
        const failures = await securityEvents.countDocuments({ deviceKey, type: "login-failure", createdAt: { $gte: windowStart } });
        // Repeated authentication failures trigger a temporary, persistent
        // device block. The public IP is retained for audit/forensics, but is
        // deliberately NOT used as the block key so shared networks are safe.
        if (failures >= 8) {
          await smartBlockIp(smartClientIp(req), 30, "repeated-login-failures", req, res);
        }
        return res.status(401).json({ error: "Invalid email or password." });
      }
      if (user.role === "student" && !user.portalLocked && isStudentIdle(user)) {
        await autoLockIdleStudent(user);
        user.portalLocked = true;
        user.lockSource = "smart-inactivity";
        user.lockReason = "168-hour inactivity";
      }
      if (user.role === "student" && user.portalLocked) {
        return res.status(423).json({ error: user.lockSource === "smart-inactivity" ? "Your account has been automatically suspended after 168 hours without activity. Please contact the administrator." : "Your student portal is locked by an administrator." });
      }
      // Regenerate the session after successful authentication to prevent
      // session-fixation attacks. Admins with 2FA enabled receive only a
      // short-lived pending session until the second factor is verified.
      await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
      if (user.role === "admin" && (await getAdmin2fa(user)).enabled) {
        req.session.admin2faUserId = user._id.toString();
        req.session.admin2faPendingAt = Date.now();
        req.session.admin2faVerified = false;
        await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
        await smartRecord(req, { type: "admin-2fa-required", severity: "info", score: 0, action: "second-factor-required" });
        return res.json({ ok: true, twoFactorRequired: true, redirect: "/login.html" });
      }
      req.session.userId = user._id.toString();
      req.session.passwordVersion = Number(user.passwordVersion || 0);
      if (user.role === "admin") req.session.admin2faVerified = true;
      if (user.role === "student") await touchStudentActivity(user._id, smartClientIp(req));
      await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
      await smartRecord(req, { type: "login-success", severity: "info", score: 0, action: "logged" });
      if (user.mustChangePassword && (user.role === "student" || user.role === "instructor")) {
        return res.json({ ok: true, mustChangePassword: true, redirect: "/change-password.html" });
      }
      res.json({ ok: true, redirect: user.role === "admin" ? "/admin.html" : user.role === "instructor" ? "/instructor.html" : "/index.html" });
    } catch (e) { next(e); }
  });
  app.post("/api/logout", (req, res) => {
    req.session.destroy(() => {
      res.clearCookie("connect.sid", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
      res.json({ ok: true, redirect: "/index.html" });
    });
  });

  // SMARTTEP ACADEMY Chat — WhatsApp-style messaging using the existing login/session,
  // MongoDB and Cloudinary infrastructure. Messages are delivered near-real-time
  // through lightweight polling, so no extra WebSocket service is required on Render.
  function chatUserView(user) {
    return { id: user._id.toString(), name: user.name || "SMARTTEP ACADEMY User", email: user.email || "", role: user.role || "student", profile_picture_url: user.profilePicture ? `/api/chat/profile-picture/${user._id.toString()}` : null };
  }

  function cleanChatText(value) {
    return String(value || "").replace(/\u0000/g, "").trim().slice(0, 5000);
  }

  async function chatCanAccessConversation(user, conversation) {
    return !!conversation && Array.isArray(conversation.members) && conversation.members.some(id => String(id) === String(user._id));
  }

  async function getChatConversationView(conversation, userId) {
    const memberIds = (conversation.members || []).map(oid).filter(Boolean);
    const memberDocs = memberIds.length ? await users.find({ _id: { $in: memberIds } }, { projection: { name: 1, email: 1, role: 1, profilePicture: 1 } }).toArray() : [];
    const members = memberDocs.map(chatUserView);
    let title = conversation.name || "Chat";
    if (conversation.type === "direct") {
      const other = members.find(m => m.id !== String(userId));
      title = other?.name || "Direct chat";
    }
    const unread = await chatMessages.countDocuments({ conversationId: conversation._id, senderId: { $ne: oid(userId) }, readBy: { $nin: [oid(userId)] } });
    return {
      id: conversation._id.toString(), type: conversation.type, name: title,
      members, memberCount: members.length, lastMessage: conversation.lastMessagePreview || "",
      lastMessageAt: conversation.lastMessageAt || conversation.updatedAt || conversation.createdAt,
      unread
    };
  }

  // SMARTTEP Chat profile images are served through the LMS origin instead of
  // exposing/loading Cloudinary delivery URLs directly in the chat UI.
  app.get("/api/chat/profile-picture/:id", auth, chatAccess, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).end();
      const user = await users.findOne({ _id: id }, { projection: { role: 1, approved: 1, portalLocked: 1, profilePicture: 1 } });
      if (!user) return res.status(404).end();
      if (user.role !== "admin" && user.role !== "instructor" && (!user.approved || user.portalLocked)) return res.status(404).end();
      if (user.role === "instructor" && (user.instructorApproved === false || user.instructorSuspended)) return res.status(404).end();

      const asset = user.profilePicture;
      if (!asset) return res.status(404).end();
      let url = asset.url || null;
      if (asset.publicId) {
        url = cloudinary.url(asset.publicId, {
          secure: true,
          resource_type: asset.resourceType || "image",
          type: asset.type || "upload"
        });
      }
      if (!url) return res.status(404).end();

      const upstream = await fetch(url, { redirect: "follow" });
      const contentType = upstream.headers.get("content-type") || "";
      if (!upstream.ok || !upstream.body || !contentType.toLowerCase().startsWith("image/")) return res.status(404).end();
      res.set("Cache-Control", "private, no-cache, no-store, must-revalidate");
      res.set("Pragma", "no-cache");
      res.set("X-Content-Type-Options", "nosniff");
      res.type(contentType.split(";")[0]);
      const contentLength = upstream.headers.get("content-length");
      if (contentLength) res.set("Content-Length", contentLength);
      Readable.fromWeb(upstream.body).pipe(res);
    } catch (e) { next(e); }
  });

  app.get("/api/chat/users", auth, chatAccess, async (req, res, next) => {
    try {
      const filter = req.user.role === "instructor"
        ? { _id: { $ne: req.user._id }, role: "admin" }
        : { _id: { $ne: req.user._id }, $or: [{ role: "admin" }, { role: "instructor", instructorApproved: { $ne: false }, instructorSuspended: { $ne: true } }, { role: "student", approved: true, portalLocked: { $ne: true } }] };
      const list = await users.find(filter, { projection: { name: 1, email: 1, role: 1, profilePicture: 1 } }).sort({ role: -1, name: 1 }).limit(500).toArray();
      res.json({ users: list.map(chatUserView) });
    } catch (e) { next(e); }
  });

  app.get("/api/chat/conversations", auth, chatAccess, async (req, res, next) => {
    try {
      const rows = await chatConversations.find({ members: req.user._id }).sort({ lastMessageAt: -1, updatedAt: -1 }).limit(100).toArray();
      const conversations = [];
      for (const row of rows) conversations.push(await getChatConversationView(row, req.user._id));
      res.json({ conversations });
    } catch (e) { next(e); }
  });

  app.post("/api/chat/direct", rateLimit({ windowMs: 60 * 1000, max: 30, keyPrefix: "chat-direct" }), auth, chatAccess, async (req, res, next) => {
    try {
      const otherId = oid(req.body?.userId);
      if (!otherId || String(otherId) === String(req.user._id)) return res.status(400).json({ error: "Choose another user to start a chat." });
      const other = await users.findOne({ _id: otherId }, { projection: { name: 1, email: 1, role: 1, approved: 1, portalLocked: 1, instructorApproved: 1, instructorSuspended: 1 } });
      if (!other) return res.status(404).json({ error: "That user is not available for chat." });
      if (req.user.role === "instructor" && other.role !== "admin") return res.status(403).json({ error: "Instructors can message administrators directly." });
      if (req.user.role !== "instructor" && other.role !== "admin" && other.role !== "instructor" && (!other.approved || other.portalLocked)) return res.status(404).json({ error: "That user is not available for chat." });
      if (req.user.role !== "instructor" && other.role === "instructor" && (other.instructorApproved === false || other.instructorSuspended)) return res.status(404).json({ error: "That instructor is not available for chat." });
      const memberKey = [String(req.user._id), String(otherId)].sort().join(":");
      let conversation = await chatConversations.findOne({ type: "direct", memberKey });
      if (!conversation) {
        try {
          const doc = { type: "direct", members: [req.user._id, otherId], memberKey, createdBy: req.user._id, createdAt: new Date(), updatedAt: new Date(), lastMessageAt: null, lastMessagePreview: "" };
          const result = await chatConversations.insertOne(doc);
          conversation = { _id: result.insertedId, ...doc };
        } catch (e) {
          if (e?.code !== 11000) throw e;
          conversation = await chatConversations.findOne({ type: "direct", memberKey });
        }
      }
      res.json({ conversation: await getChatConversationView(conversation, req.user._id) });
    } catch (e) { next(e); }
  });

  app.post("/api/chat/groups", rateLimit({ windowMs: 60 * 1000, max: 10, keyPrefix: "chat-group" }), auth, chatAccess, async (req, res, next) => {
    try {
      const name = String(req.body?.name || "").trim().slice(0, 80);
      const rawMembers = Array.isArray(req.body?.memberIds) ? req.body.memberIds : [];
      if (!name) return res.status(400).json({ error: "Enter a group name." });
      const ids = [...new Set(rawMembers.map(oid).filter(Boolean).map(String))].filter(id => id !== String(req.user._id));
      if (!ids.length) return res.status(400).json({ error: "Select at least one other member." });
      const memberObjects = ids.map(oid).filter(Boolean);
      const filter = req.user.role === "admin" ? { _id: { $in: memberObjects } } : { _id: { $in: memberObjects }, $or: [{ role: "admin" }, { role: "student", approved: true, portalLocked: { $ne: true } }] };
      const allowed = await users.find(filter, { projection: { _id: 1 } }).toArray();
      if (allowed.length !== memberObjects.length) return res.status(400).json({ error: "One or more selected members are unavailable." });
      const members = [req.user._id, ...memberObjects];
      const now = new Date();
      const doc = { type: "group", name, members, createdBy: req.user._id, createdAt: now, updatedAt: now, lastMessageAt: null, lastMessagePreview: "" };
      const result = await chatConversations.insertOne(doc);
      const conversation = { _id: result.insertedId, ...doc };
      res.json({ conversation: await getChatConversationView(conversation, req.user._id) });
    } catch (e) { next(e); }
  });

  app.get("/api/chat/conversations/:id/messages", auth, chatAccess, async (req, res, next) => {
    try {
      const conversationId = oid(req.params.id);
      if (!conversationId) return res.status(400).json({ error: "Invalid conversation." });
      const conversation = await chatConversations.findOne({ _id: conversationId });
      if (!(await chatCanAccessConversation(req.user, conversation))) return res.status(403).json({ error: "You do not have access to this chat." });
      const after = req.query.after ? oid(req.query.after) : null;
      const filter = { conversationId };
      if (after) filter._id = { $gt: after };
      const rows = await chatMessages.find(filter).sort({ createdAt: 1, _id: 1 }).limit(200).toArray();
      const senderIds = [...new Set(rows.map(m => String(m.senderId)))].map(oid).filter(Boolean);
      const senderDocs = senderIds.length ? await users.find({ _id: { $in: senderIds } }, { projection: { name: 1, role: 1, profilePicture: 1 } }).toArray() : [];
      const senderMap = new Map(senderDocs.map(u => [String(u._id), u]));
      res.json({ messages: rows.map(m => ({
        id: m._id.toString(),
        senderId: String(m.senderId),
        senderName: senderMap.get(String(m.senderId))?.name || "SMARTTEP ACADEMY User",
        senderRole: senderMap.get(String(m.senderId))?.role || "student",
        senderProfilePicture: senderMap.get(String(m.senderId))?.profilePicture ? `/api/chat/profile-picture/${String(m.senderId)}` : null,
        text: m.deleted ? "" : (m.text || ""),
        attachment: m.deleted ? null : (m.attachment || null),
        replyTo: m.replyTo || null,
        deleted: !!m.deleted,
        deletedAt: m.deletedAt || null,
        createdAt: m.createdAt,
        read: String(m.senderId) === String(req.user._id) ? (m.readBy || []).some(id => String(id) !== String(req.user._id)) : (m.readBy || []).some(id => String(id) === String(req.user._id))
      })) });
    } catch (e) { next(e); }
  });

  const chatAttachmentMaxBytes = 100 * 1024 * 1024;
  const chatImageExtensions = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".heif"]);
  const chatVideoExtensions = new Set([".mp4", ".webm", ".mov", ".m4v", ".3gp", ".avi", ".mkv"]);
  const chatDocExtensions = new Set([".docx"]);

  // Chat attachments can arrive from Android/iOS with an ambiguous container
  // extension (especially .webm). Prefer the actual MIME type over the extension
  // so an audio/webm voice note can never be rendered as a video.
  function effectiveChatAttachmentKind(attachment) {
    if (!attachment) return null;
    const mime = String(attachment.mime || "").toLowerCase();
    const ext = path.extname(attachment.name || "").toLowerCase();
    if (chatDocExtensions.has(ext)) return "document";
    // Repair legacy messages first. The previous bug stored MP4/MOV/etc. as
    // audio because an MP4 `ftyp` header was mistaken for an audio signature.
    const definiteVideoExt = new Set([".mp4", ".mov", ".m4v", ".avi", ".mkv"]);
    const definiteAudioExt = new Set([".mp3", ".wav", ".m4a", ".ogg", ".oga", ".opus", ".aac", ".flac", ".amr", ".aif", ".aiff", ".caf", ".mka"]);
    if (definiteVideoExt.has(ext)) return "video";
    if (definiteAudioExt.has(ext)) return "audio";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("video/")) return "video";
    // WEBM/3GP are genuinely ambiguous; when MIME is absent, preserve the
    // stored kind because there is no reliable extension-only distinction.
    return attachment.kind || null;
  }

  function uploadChatBuffer(buffer, originalName, info) {
    return new Promise((resolve, reject) => {
      const safeName = path.basename(originalName || "chat-file").replace(/[^a-zA-Z0-9._-]/g, "_");
      const ext = path.extname(safeName).toLowerCase();
      const base = safeName.replace(/\.[^.]+$/, "") || "chat-file";
      const publicId = `${Date.now()}-${base}${info.resourceType === "raw" ? ext : ""}`;
      const options = { folder: "wps-academy/chat", public_id: publicId, resource_type: info.resourceType, use_filename: false };
      if (info.resourceType === "raw" && ext) options.format = ext.slice(1);

      // Create the browser-playback copy during upload, not while the phone is
      // already trying to play it. This prevents Cloudinary from having to
      // generate a transformation during a mobile Range request.
      if (info.kind === "video") {
        options.eager = [{ format: "mp4", video_codec: "h264", audio_codec: "aac", quality: "auto" }];
      } else if (info.kind === "audio") {
        options.eager = [{ format: "mp3", audio_codec: "mp3", bit_rate: "128k" }];
      }

      const stream = cloudinary.uploader.upload_stream(options, (error, result) => error ? reject(error) : resolve(result));
      stream.end(buffer);
    });
  }

  function chatAttachmentInfo(file) {
    if (!file) return null;
    const ext = path.extname(file.originalname || "").toLowerCase();
    const mime = String(file.mimetype || "").toLowerCase();
    if (chatDocExtensions.has(ext)) return { kind: "document", resourceType: "raw", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: ".docx" };
    if (chatImageExtensions.has(ext) || mime.startsWith("image/")) return { kind: "image", resourceType: "image", mime: mime.startsWith("image/") ? mime : "image/*", ext };

    // IMPORTANT: classify unambiguous filename extensions before any byte
    // sniffing. MP4/MOV/etc. contain an `ftyp` box too, so a generic
    // `looksLikeAudio()` check would incorrectly turn every video into audio.
    const definiteVideoExt = new Set([".mp4", ".mov", ".m4v", ".avi", ".mkv"]);
    const definiteAudioExt = new Set([".mp3", ".wav", ".m4a", ".ogg", ".oga", ".opus", ".aac", ".flac", ".amr", ".aif", ".aiff", ".caf", ".mka"]);
    if (definiteVideoExt.has(ext)) return { kind: "video", resourceType: "video", mime: mime.startsWith("video/") ? mime : ({ ".mp4":"video/mp4", ".mov":"video/quicktime", ".m4v":"video/x-m4v", ".avi":"video/x-msvideo", ".mkv":"video/x-matroska" }[ext] || "video/*"), ext };
    if (definiteAudioExt.has(ext)) return { kind: "audio", resourceType: "video", mime: mime.startsWith("audio/") ? mime : ({ ".mp3":"audio/mpeg", ".wav":"audio/wav", ".m4a":"audio/mp4", ".ogg":"audio/ogg", ".oga":"audio/ogg", ".opus":"audio/ogg", ".aac":"audio/aac", ".flac":"audio/flac", ".amr":"audio/amr", ".aif":"audio/aiff", ".aiff":"audio/aiff", ".caf":"audio/x-caf", ".mka":"audio/x-matroska" }[ext] || "audio/*"), ext };

    // WEBM and 3GP can contain either audio or video. For these ambiguous
    // containers, the browser-provided MIME type is authoritative. Only use
    // the persisted kind as a final fallback.
    if (mime.startsWith("audio/")) return { kind: "audio", resourceType: "video", mime, ext };
    if (mime.startsWith("video/")) return { kind: "video", resourceType: "video", mime, ext };
    if (ext === ".webm" || ext === ".3gp") {
      return { kind: "video", resourceType: "video", mime: ext === ".webm" ? "video/webm" : "video/3gpp", ext };
    }
    if (looksLikeAudio(file.buffer)) return { kind: "audio", resourceType: "video", mime: "audio/*", ext };
    return null;
  }

  function chatPreviewText(text, attachment) {
    if (text) return text.slice(0, 120);
    if (!attachment) return "";
    return attachment.kind === "image" ? "📷 Image" : attachment.kind === "video" ? "🎥 Video" : attachment.kind === "audio" ? "🎤 Audio" : "📄 Document";
  }

  app.post("/api/chat/conversations/:id/messages", rateLimit({ windowMs: 10 * 1000, max: 30, keyPrefix: "chat-message" }), auth, chatAccess, async (req, res, next) => {
    try {
      const conversationId = oid(req.params.id);
      const text = cleanChatText(req.body?.text);
      if (!conversationId || !text) return res.status(400).json({ error: "Message cannot be empty." });
      const conversation = await chatConversations.findOne({ _id: conversationId });
      if (!(await chatCanAccessConversation(req.user, conversation))) return res.status(403).json({ error: "You do not have access to this chat." });
      const replyTo = await buildChatReplySnapshot(req.body?.replyToId, conversationId);
      if (req.body?.replyToId && !replyTo) return res.status(400).json({ error: "The message you are replying to could not be found in this chat." });
      const now = new Date();
      const doc = { conversationId, senderId: req.user._id, text, attachment: null, replyTo, readBy: [req.user._id], createdAt: now };
      const result = await chatMessages.insertOne(doc);
      await chatConversations.updateOne({ _id: conversationId }, { $set: { lastMessageAt: now, lastMessagePreview: chatPreviewText(text, null), updatedAt: now } });
      res.json({ ok: true, message: { id: result.insertedId.toString(), senderId: req.user._id.toString(), senderName: req.user.name, senderRole: req.user.role, senderProfilePicture: profilePictureUrl(req.user.profilePicture), text, attachment: null, replyTo, deleted: false, createdAt: now, read: true } });
    } catch (e) { next(e); }
  });

  app.post("/api/chat/conversations/:id/attachments", rateLimit({ windowMs: 60 * 1000, max: 20, keyPrefix: "chat-attachment" }), auth, chatAccess, upload.single("file"), async (req, res, next) => {
    try {
      const conversationId = oid(req.params.id);
      if (!conversationId) return res.status(400).json({ error: "Invalid conversation." });
      const conversation = await chatConversations.findOne({ _id: conversationId });
      if (!(await chatCanAccessConversation(req.user, conversation))) return res.status(403).json({ error: "You do not have access to this chat." });
      if (!req.file) return res.status(400).json({ error: "Choose an image, audio, video or DOCX file." });
      if (req.file.size > chatAttachmentMaxBytes) return res.status(413).json({ error: "Chat files must be 100 MB or smaller." });
      const info = chatAttachmentInfo(req.file);
      if (!info) return res.status(400).json({ error: "Only images, audio, video and .docx files can be sent in chat." });
      if (info.kind === "document" && !(req.file.buffer?.subarray(0, 2).toString("hex") === "504b")) return res.status(400).json({ error: "The selected DOCX file is not valid." });

      const replyTo = await buildChatReplySnapshot(req.body?.replyToId, conversationId);
      if (req.body?.replyToId && !replyTo) return res.status(400).json({ error: "The message you are replying to could not be found in this chat." });
      const uploaded = await uploadChatBuffer(req.file.buffer, req.file.originalname, info);
      const safeName = path.basename(req.file.originalname || `chat-file${info.ext || ""}`).replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180);
      // Always keep a browser-safe MP3 playback URL for chat audio attachments.
      // This covers WAV/M4A/OGG/WEBM uploads and also makes playback independent
      // of the browser's original MIME/container support.
      let eagerPlayback = Array.isArray(uploaded.eager) && uploaded.eager[0]?.secure_url ? uploaded.eager[0].secure_url : null;
      if (info.kind === "audio" && uploaded.public_id) {
        try {
          eagerPlayback = cloudinary.url(uploaded.public_id, {
            secure: true,
            resource_type: "video",
            format: "mp3",
            transformation: [{ audio_codec: "mp3", bit_rate: "128k" }]
          });
        } catch (e) {
          // Keep the eager URL if URL generation is unavailable.
        }
      }
      const attachment = { kind: info.kind, name: safeName, mime: info.mime, size: req.file.size, url: uploaded.secure_url || uploaded.url, playbackUrl: eagerPlayback, publicId: uploaded.public_id, resourceType: uploaded.resource_type || info.resourceType, createdAt: new Date() };
      const now = new Date();
      const doc = { conversationId, senderId: req.user._id, text: cleanChatText(req.body?.text), attachment, replyTo, readBy: [req.user._id], createdAt: now };
      const result = await chatMessages.insertOne(doc);
      await chatConversations.updateOne({ _id: conversationId }, { $set: { lastMessageAt: now, lastMessagePreview: chatPreviewText(doc.text, attachment), updatedAt: now } });
      res.json({ ok: true, message: { id: result.insertedId.toString(), senderId: req.user._id.toString(), senderName: req.user.name, senderRole: req.user.role, senderProfilePicture: profilePictureUrl(req.user.profilePicture), text: doc.text, attachment, replyTo, deleted: false, createdAt: now, read: true } });
    } catch (e) { next(e); }
  });

  async function buildChatReplySnapshot(replyToId, conversationId) {
    const id = oid(replyToId);
    if (!id) return null;
    const original = await chatMessages.findOne({ _id: id, conversationId });
    if (!original) return null;
    const sender = await users.findOne({ _id: original.senderId }, { projection: { name: 1, role: 1 } });
    return {
      messageId: original._id.toString(),
      senderId: String(original.senderId),
      senderName: sender?.name || "SMARTTEP ACADEMY User",
      senderRole: sender?.role || "student",
      text: original.deleted ? "This message was deleted" : String(original.text || ""),
      attachment: original.deleted ? null : (original.attachment ? {
        kind: original.attachment.kind,
        name: original.attachment.name,
        mime: original.attachment.mime,
        size: original.attachment.size
      } : null),
      createdAt: original.createdAt,
      deleted: !!original.deleted
    };
  }

  async function updateChatConversationPreview(conversationId) {
    const latest = await chatMessages.findOne({ conversationId, deleted: { $ne: true } }, { sort: { createdAt: -1, _id: -1 } });
    if (!latest) {
      const conversation = await chatConversations.findOne({ _id: conversationId }, { projection: { createdAt: 1, updatedAt: 1 } });
      await chatConversations.updateOne({ _id: conversationId }, { $set: { lastMessageAt: null, lastMessagePreview: "", updatedAt: new Date() } });
      return;
    }
    await chatConversations.updateOne({ _id: conversationId }, { $set: {
      lastMessageAt: latest.createdAt,
      lastMessagePreview: chatPreviewText(latest.text || "", latest.attachment || null),
      updatedAt: new Date()
    } });
  }

  async function deleteChatAttachment(attachment) {
    if (!attachment?.publicId) return;
    try {
      await cloudinary.uploader.destroy(attachment.publicId, {
        resource_type: attachment.resourceType || (attachment.kind === "image" ? "image" : attachment.kind === "video" || attachment.kind === "audio" ? "video" : "raw"),
        type: "upload",
        invalidate: true
      });
    } catch (e) {
      console.warn("Chat attachment cleanup warning:", e?.message || e);
    }
  }

  app.post("/api/chat/conversations/:conversationId/messages/:messageId/reply", auth, chatAccess, async (req, res, next) => {
    try {
      const conversationId = oid(req.params.conversationId), messageId = oid(req.params.messageId);
      if (!conversationId || !messageId) return res.status(400).json({ error: "Invalid chat message." });
      const conversation = await chatConversations.findOne({ _id: conversationId });
      if (!(await chatCanAccessConversation(req.user, conversation))) return res.status(403).json({ error: "You do not have access to this chat." });
      const replyTo = await buildChatReplySnapshot(messageId, conversationId);
      if (!replyTo) return res.status(404).json({ error: "The message you are replying to no longer exists." });
      const text = cleanChatText(req.body?.text);
      if (!text) return res.status(400).json({ error: "Reply cannot be empty." });
      const now = new Date();
      const doc = { conversationId, senderId: req.user._id, text, attachment: null, replyTo, readBy: [req.user._id], createdAt: now };
      const result = await chatMessages.insertOne(doc);
      await chatConversations.updateOne({ _id: conversationId }, { $set: { lastMessageAt: now, lastMessagePreview: chatPreviewText(text, null), updatedAt: now } });
      res.json({ ok: true, message: { id: result.insertedId.toString(), senderId: req.user._id.toString(), senderName: req.user.name, senderRole: req.user.role, senderProfilePicture: profilePictureUrl(req.user.profilePicture), text, attachment: null, replyTo, deleted: false, createdAt: now, read: true } });
    } catch (e) { next(e); }
  });

  app.delete("/api/chat/conversations/:conversationId/messages/:messageId", auth, chatAccess, async (req, res, next) => {
    try {
      const conversationId = oid(req.params.conversationId), messageId = oid(req.params.messageId);
      if (!conversationId || !messageId) return res.status(400).json({ error: "Invalid chat message." });
      const conversation = await chatConversations.findOne({ _id: conversationId });
      if (!(await chatCanAccessConversation(req.user, conversation))) return res.status(403).json({ error: "You do not have access to this chat." });
      const message = await chatMessages.findOne({ _id: messageId, conversationId });
      if (!message) return res.status(404).json({ error: "Message not found." });
      const isOwner = String(message.senderId) === String(req.user._id);
      if (!isOwner && req.user.role !== "admin") return res.status(403).json({ error: "You can only delete your own messages." });
      if (!message.deleted) await deleteChatAttachment(message.attachment);
      const now = new Date();
      await chatMessages.updateOne({ _id: messageId }, { $set: { deleted: true, deletedAt: now, deletedBy: req.user._id, text: "", attachment: null } });
      await updateChatConversationPreview(conversationId);
      res.json({ ok: true, messageId: messageId.toString(), deletedAt: now });
    } catch (e) { next(e); }
  });

  async function streamChatAttachment(req, res, messageId, disposition = "inline", forceOriginalMedia = false) {
    const id = oid(messageId);
    if (!id) return res.status(400).json({ error: "Invalid attachment." });
    const message = await chatMessages.findOne({ _id: id });
    if (!message?.attachment) return res.status(404).json({ error: "Attachment not found." });
    const conversation = await chatConversations.findOne({ _id: message.conversationId });
    if (!(await chatCanAccessConversation(req.user, conversation))) return res.status(403).json({ error: "You do not have access to this attachment." });
    const attachment = message.attachment;
    if (!attachment.url) return res.status(404).json({ error: "Attachment URL is unavailable." });
    const effectiveKind = effectiveChatAttachmentKind(attachment);

    const ext = path.extname(attachment.name || "").toLowerCase();
    const fallbackMime = {
      image: { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".heic": "image/heic", ".heif": "image/heif" },
      video: { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".3gp": "video/3gpp", ".avi": "video/x-msvideo", ".mkv": "video/x-matroska" },
      audio: { ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".aac": "audio/aac", ".flac": "audio/flac", ".webm": "audio/webm", ".amr": "audio/amr", ".aif": "audio/aiff", ".aiff": "audio/aiff", ".caf": "audio/x-caf", ".mka": "audio/x-matroska" }
    };

    const upstreamTypeHint = effectiveKind === "document"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : (attachment.mime && !attachment.mime.endsWith("/*") ? attachment.mime : (fallbackMime[effectiveKind]?.[ext] || (effectiveKind === "audio" ? "audio/wav" : effectiveKind === "video" ? "video/mp4" : "application/octet-stream")));

    // IMPORTANT: HTML5 media elements on Android/iOS routinely use byte-range
    // requests. A proxy that always converts those requests to a 200 response
    // can make playback stop after the first small chunk (often ~2 seconds).
    // Forward Range upstream and preserve the 206/Content-Range contract.
    const range = req.headers.range;
    const upstreamHeaders = { Accept: "*/*" };
    if (range && /bytes=\d*-\d*/i.test(range)) upstreamHeaders.Range = range;

    // Cloudinary can deliver the original upload exactly as received. Mobile
    // browsers are much more reliable when chat playback is normalized to a
    // browser-safe codec/container. Keep the original URL for downloads, but
    // use an on-the-fly derived MP4/H.264/AAC or MP3 for inline playback.
    let mediaUrl = attachment.url;
    // Voice notes are stored as WAV for reliable capture/classification, but
    // playback uses Cloudinary's eager MP3 derivative. Streaming the larger
    // WAV through Node delays startup on mobile. The MP3 is smaller and can
    // be fetched directly by the browser with normal range support.
    const isWpsVoiceNote = effectiveKind === "audio" && /^voice-message-/i.test(String(attachment.name || "")) && /\.wav$/i.test(String(attachment.name || ""));
    if (!forceOriginalMedia && disposition === "inline" && (effectiveKind === "video" || effectiveKind === "audio")) {
      // New uploads have an eager, already-generated playback asset. Use it
      // directly. Older messages are upgraded lazily with the same safe
      // delivery format.
      if (attachment.playbackUrl) {
        mediaUrl = attachment.playbackUrl;
      } else if (attachment.publicId) {
        try {
          mediaUrl = effectiveKind === "video"
            ? cloudinary.url(attachment.publicId, { secure: true, resource_type: "video", format: "mp4", transformation: [{ video_codec: "h264", audio_codec: "aac", quality: "auto" }] })
            : cloudinary.url(attachment.publicId, { secure: true, resource_type: "video", format: "mp3", transformation: [{ audio_codec: "mp3", bit_rate: "128k" }] });
        } catch (e) { mediaUrl = attachment.url; }
      }
    }

    let upstream;
    const fetchMedia = async (url) => req.method === "HEAD"
      ? fetch(url, { method: "HEAD", headers: upstreamHeaders, redirect: "follow" })
      : fetch(url, { headers: upstreamHeaders, redirect: "follow" });
    // Let the browser talk directly to Cloudinary for inline audio/video.
    // This is important on mobile: the browser controls its own byte-range
    // requests against the media origin. Proxying/transcoding those ranges
    // through Node can cause a 206 response to be restarted around the first
    // buffered segment (commonly ~2 seconds). The Cloudinary URL is already a
    // delivery URL, while the API route remains protected for discovery.
    if (!forceOriginalMedia && disposition === "inline" && (effectiveKind === "video" || effectiveKind === "audio") && mediaUrl && !isWpsVoiceNote) {
      // Do not HEAD-probe the transformed asset first. Some mobile/CDN edges
      // treat HEAD differently from the subsequent byte-range GET and the old
      // probe could incorrectly force an unplayable original file as fallback.
      // Let the browser make the real media request directly to Cloudinary.
      return res.redirect(302, mediaUrl);
    }

    upstream = await fetchMedia(mediaUrl);
    // If a derived Cloudinary representation is unavailable, fall back to the
    // original asset instead of making the chat attachment unusable.
    if (!upstream.ok && mediaUrl !== attachment.url) upstream = await fetchMedia(attachment.url);
    if (!upstream.ok || (!upstream.body && req.method !== "HEAD")) {
      console.error("Chat attachment fetch failed:", upstream.status, attachment.url);
      return res.status(upstream.status === 404 ? 404 : 502).json({ error: "The attachment could not be retrieved." });
    }

    const upstreamType = upstream.headers.get("content-type") || "";
    const normalizedMime = (!forceOriginalMedia && disposition === "inline" && effectiveKind === "video") ? "video/mp4"
      : (!forceOriginalMedia && disposition === "inline" && effectiveKind === "audio") ? "audio/mpeg"
      : null;
    const mime = normalizedMime || (effectiveKind === "document" ? upstreamTypeHint : (upstreamType && !/^application\/octet-stream(?:;|$)/i.test(upstreamType) ? upstreamType : upstreamTypeHint));
    const safeName = String(attachment.name || "attachment").replace(/[\"\r\n]/g, "_");

    // Preserve the exact status selected by Cloudinary for a Range request.
    res.status(upstream.status === 206 ? 206 : 200);
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `${disposition}; filename="${safeName}"`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=300");
    for (const name of ["content-length", "content-range", "etag", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (req.method === "HEAD") return res.end();

    const reader = upstream.body.getReader();
    let closed = false;
    const cancel = () => { closed = true; reader.cancel().catch(() => {}); };
    req.on("aborted", cancel);
    res.on("close", () => { if (!res.writableEnded) cancel(); });
    try {
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) await new Promise(resolve => res.once("drain", resolve));
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    if (!res.writableEnded) res.end();
  }

  // Inline media endpoint. It authenticates access, then redirects HTML5
  // audio/video playback to the browser-safe Cloudinary eager asset. This lets
  // mobile browsers handle byte ranges directly while keeping the original
  // upload private behind the authenticated discovery route.
  app.get("/api/chat/attachments/:messageId/media/:kind", auth, chatAccess, async (req, res, next) => {
    try {
      const kind = req.params.kind === "audio" ? "audio" : req.params.kind === "video" ? "video" : null;
      if (!kind) return res.status(400).json({ error: "Invalid chat media request." });
      const id = oid(req.params.messageId);
      if (!id) return res.status(400).json({ error: "Invalid attachment." });
      const message = await chatMessages.findOne({ _id: id });
      const storedKind = effectiveChatAttachmentKind(message?.attachment);
      if (!message?.attachment || storedKind !== kind) return res.status(404).json({ error: "Attachment not found." });
      // Lazily repair old messages created by the previous .webm classification
      // bug so future clients receive the correct attachment kind too.
      if (message.attachment.kind !== storedKind) {
        await chatMessages.updateOne({ _id: id }, { $set: { "attachment.kind": storedKind } });
      }
      await streamChatAttachment(req, res, req.params.messageId, "inline");
    } catch (e) { next(e); }
  });

  app.get("/api/chat/attachments/:messageId/content", auth, chatAccess, async (req, res, next) => {
    try { await streamChatAttachment(req, res, req.params.messageId, "inline"); } catch (e) { next(e); }
  });

  app.get("/api/chat/attachments/:messageId/download", auth, chatAccess, async (req, res, next) => {
    try { await streamChatAttachment(req, res, req.params.messageId, "attachment"); } catch (e) { next(e); }
  });

  app.post("/api/chat/conversations/:id/read", auth, chatAccess, async (req, res, next) => {
    try {
      const conversationId = oid(req.params.id);
      if (!conversationId) return res.status(400).json({ error: "Invalid conversation." });
      const conversation = await chatConversations.findOne({ _id: conversationId });
      if (!(await chatCanAccessConversation(req.user, conversation))) return res.status(403).json({ error: "You do not have access to this chat." });
      await chatMessages.updateMany({ conversationId, senderId: { $ne: req.user._id }, readBy: { $nin: [req.user._id] } }, { $addToSet: { readBy: req.user._id } });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.get("/api/media-fix-version", (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.json({ ok: true, mediaFixVersion: MEDIA_FIX_VERSION });
  });

  app.get("/api/me", async (req, res, next) => {
    try {
      if (!req.session.userId) return res.json({ user: null });
      const id = oid(req.session.userId);
      let user = id ? await users.findOne({ _id: id }) : null;
      if (!user) return res.json({ user: null });
      if (await autoLockIdleStudent(user)) {
        user.portalLocked = true;
        user.lockSource = "smart-inactivity";
        user.lockReason = "168-hour inactivity";
      }
      res.json({ user: {
        id: user._id.toString(), name: user.name, email: user.email, role: user.role,
        portal_locked: !!user.portalLocked, lock_source: user.lockSource || null,
        lock_reason: user.lockReason || null, last_activity_at: user.lastActivityAt || null,
        payment_status: user.paymentStatus, approved: !!user.approved,
        profile_picture_url: profilePictureUrl(user.profilePicture),
        student_id_number: user.studentIdNumber || null, course_code: user.courseCode || "",
        registration_date: user.registrationDate || (user.createdAt ? new Date(user.createdAt).toISOString().slice(0,10) : ""),
        programme_end_date: user.programmeEndDate || "", state: user.state || "", country: user.country || "", gender: user.gender || ""
      }});
    } catch (e) { next(e); }
  });

  app.get("/api/profile", auth, async (req, res, next) => {
    try {
      res.json({ profile: { id: req.user._id.toString(), name: req.user.name || "", email: req.user.email || "", profile_picture_url: profilePictureUrl(req.user.profilePicture), student_id_number: req.user.studentIdNumber || null, course_code: req.user.courseCode || "", registration_date: req.user.registrationDate || (req.user.createdAt ? new Date(req.user.createdAt).toISOString().slice(0,10) : ""), programme_end_date: req.user.programmeEndDate || "", state: req.user.state || "", country: req.user.country || "", gender: req.user.gender || "" } });
    } catch (e) { next(e); }
  });

  // Student My Profile image endpoint. The browser loads the picture from the
  // LMS origin instead of directly from Cloudinary. This avoids browser/CSP/cache
  // issues with older Cloudinary URLs while keeping the actual image in Cloudinary.
  app.get("/api/profile-picture/image", auth, async (req, res, next) => {
    try {
      const asset = req.user.profilePicture;
      if (!asset) return res.status(404).end();

      let url = asset.url || null;
      if (asset.publicId) {
        try {
          url = cloudinary.url(asset.publicId, {
            secure: true,
            resource_type: asset.resourceType || "image",
            type: asset.type || "upload"
          });
        } catch {}
      }
      if (!url) return res.status(404).end();

      const upstream = await fetch(url, { redirect: "follow" });
      if (!upstream.ok || !upstream.body) {
        return res.status(404).end();
      }

      res.set("Cache-Control", "private, no-cache, no-store, must-revalidate");
      res.set("Pragma", "no-cache");
      res.set("X-Content-Type-Options", "nosniff");
      const contentType = upstream.headers.get("content-type");
      if (contentType && contentType.toLowerCase().startsWith("image/")) {
        res.type(contentType.split(";")[0]);
      } else {
        return res.status(404).end();
      }
      const contentLength = upstream.headers.get("content-length");
      if (contentLength) res.set("Content-Length", contentLength);
      Readable.fromWeb(upstream.body).pipe(res);
    } catch (e) {
      next(e);
    }
  });

  // Admin profile image endpoint. The admin portal uses the LMS origin instead of
  // loading the student's Cloudinary delivery URL directly.
  app.get("/api/admin/profile-picture/:id", auth, admin, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).end();
      const user = await users.findOne({ _id: id }, { projection: { profilePicture: 1 } });
      const asset = user?.profilePicture;
      if (!asset) return res.status(404).end();

      let url = asset.url || null;
      if (asset.publicId) {
        url = cloudinary.url(asset.publicId, {
          secure: true,
          resource_type: asset.resourceType || "image",
          type: asset.type || "upload"
        });
      }
      if (!url) return res.status(404).end();

      const upstream = await fetch(url, { redirect: "follow" });
      const contentType = upstream.headers.get("content-type") || "";
      if (!upstream.ok || !upstream.body || !contentType.toLowerCase().startsWith("image/")) return res.status(404).end();
      res.set("Cache-Control", "private, no-cache, no-store, must-revalidate");
      res.set("Pragma", "no-cache");
      res.set("X-Content-Type-Options", "nosniff");
      res.type(contentType.split(";")[0]);
      const contentLength = upstream.headers.get("content-length");
      if (contentLength) res.set("Content-Length", contentLength);
      Readable.fromWeb(upstream.body).pipe(res);
    } catch (e) { next(e); }
  });

  // Public verification profile image endpoint. Only approved student accounts
  // can be resolved through this endpoint.
  app.get("/api/verify-student/profile-picture/:id", async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(404).end();
      const user = await users.findOne({ _id: id, role: "student", approved: true }, { projection: { profilePicture: 1 } });
      const asset = user?.profilePicture;
      if (!asset) return res.status(404).end();

      let url = asset.url || null;
      if (asset.publicId) {
        url = cloudinary.url(asset.publicId, {
          secure: true,
          resource_type: asset.resourceType || "image",
          type: asset.type || "upload"
        });
      }
      if (!url) return res.status(404).end();

      const upstream = await fetch(url, { redirect: "follow" });
      const contentType = upstream.headers.get("content-type") || "";
      if (!upstream.ok || !upstream.body || !contentType.toLowerCase().startsWith("image/")) return res.status(404).end();
      res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
      res.set("X-Content-Type-Options", "nosniff");
      res.type(contentType.split(";")[0]);
      const contentLength = upstream.headers.get("content-length");
      if (contentLength) res.set("Content-Length", contentLength);
      Readable.fromWeb(upstream.body).pipe(res);
    } catch (e) { next(e); }
  });

  app.post("/api/profile-picture", auth, profileUpload.single("profilePicture"), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Choose a JPG, PNG, or WEBP profile picture." });
      if (!validProfileImage(req.file)) return res.status(400).json({ error: "Profile picture must be a JPG, PNG, or WEBP image." });
      const uploaded = await uploadBuffer(req.file.buffer, req.file.originalname, "profile-pictures", "image");
      const profilePicture = {
        url: uploaded.secure_url || uploaded.url,
        publicId: uploaded.public_id,
        resourceType: uploaded.resource_type || "image",
        type: uploaded.type || "upload",
        originalName: req.file.originalname,
        updatedAt: new Date()
      };
      const oldPicture = req.user.profilePicture;
      await users.updateOne({ _id: req.user._id }, { $set: { profilePicture } });
      await deleteCloudinaryAsset(oldPicture);
      res.json({ ok: true, profile_picture_url: profilePictureUrl(profilePicture) });
    } catch (e) { next(e); }
  });

  app.get("/api/verify-student", rateLimit({ windowMs: 10 * 60 * 1000, max: 30, keyPrefix: "verify-student" }), async (req, res, next) => {
    try {
      const q = String(req.query.q || "").trim();
      if (q.length < 2) return res.status(400).json({ error: "Enter at least 2 characters of the student's name or ID number." });
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escaped, "i");
      const rows = await users.find({ role: "student", approved: true, $or: [{ studentIdNumber: re }, { name: re }] }, { projection: { name: 1, studentIdNumber: 1, courseCode: 1, registrationDate: 1, programmeEndDate: 1, state: 1, country: 1, gender: 1, profilePicture: 1, approved: 1 } }).sort({ name: 1 }).limit(20).toArray();
      res.json({ results: rows.map(u => ({ verified: true, name: u.name || "", student_id_number: u.studentIdNumber || "", course_code: u.courseCode || "", registration_date: u.registrationDate || "", programme_end_date: u.programmeEndDate || "", state: u.state || "", country: u.country || "", gender: u.gender || "", profile_picture_url: (u.profilePicture ? `/api/verify-student/profile-picture/${u._id.toString()}` : null), status: "Verified SMARTTEP ACADEMY student" })) });
    } catch (e) { next(e); }
  });

  // Public verification profile image endpoint for approved, active instructors.
  app.get("/api/verify-instructor/profile-picture/:id", async (req,res,next)=>{
    try {
      const id=oid(req.params.id);
      if(!id) return res.status(404).end();
      const user=await users.findOne({_id:id,role:"instructor",instructorApproved:{$ne:false},instructorSuspended:{$ne:true}},{projection:{profilePicture:1}});
      const asset=user?.profilePicture;
      if(!asset) return res.status(404).end();
      let url=asset.url||null;
      if(asset.publicId) url=cloudinary.url(asset.publicId,{secure:true,resource_type:asset.resourceType||"image",type:asset.type||"upload"});
      if(!url) return res.status(404).end();
      const upstream=await fetch(url,{redirect:"follow"});
      const contentType=upstream.headers.get("content-type")||"";
      if(!upstream.ok||!upstream.body||!contentType.toLowerCase().startsWith("image/")) return res.status(404).end();
      res.set("Cache-Control","public,max-age=300,stale-while-revalidate=600");
      res.set("X-Content-Type-Options","nosniff");
      res.type(contentType.split(";")[0]);
      const contentLength=upstream.headers.get("content-length"); if(contentLength) res.set("Content-Length",contentLength);
      Readable.fromWeb(upstream.body).pipe(res);
    } catch(e){next(e)}
  });

  app.get("/api/verify-instructor", rateLimit({windowMs:10*60*1000,max:30,keyPrefix:"verify-instructor"}), async(req,res,next)=>{
    try {
      const q=String(req.query.q||"").trim();
      if(q.length<2) return res.status(400).json({error:"Enter at least 2 characters of the instructor name or ID number."});
      const escaped=q.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
      const re=new RegExp(escaped,"i");
      const rows=await users.find({role:"instructor",instructorApproved:{$ne:false},instructorSuspended:{$ne:true},$or:[{instructorIdNumber:re},{name:re}]},{projection:{name:1,email:1,instructorIdNumber:1,instructorRegistrationDate:1,instructorExpiryDate:1,instructorDepartment:1,instructorApplication:1,profilePicture:1}}).sort({name:1}).limit(20).toArray();
      res.json({results:rows.map(u=>({verified:true,name:u.name||"",email:u.email||"",instructor_id_number:u.instructorIdNumber||"",registration_date:u.instructorRegistrationDate||"",expiry_date:u.instructorExpiryDate||"",department:u.instructorDepartment||u.instructorApplication?.teachingTopics||"",profile_picture_url:u.profilePicture?`/api/verify-instructor/profile-picture/${u._id.toString()}`:null,status:"Verified SMARTTEP ACADEMY instructor"}))});
    } catch(e){next(e)}
  });

  // Administrator read-only instructor portal preview. This deliberately
  // exposes only the selected instructor's portal data and never changes the
  // active administrator session into an instructor session.
  app.get("/api/admin/instructors/:id/portal", auth, admin, async (req, res, next) => {
    try {
      const instructorId = oid(req.params.id);
      if (!instructorId) return res.status(400).json({ error: "Invalid instructor." });
      const user = await users.findOne({ _id: instructorId, role: "instructor" }, { projection: { passwordHash: 0 } });
      if (!user) return res.status(404).json({ error: "Instructor not found." });
      const ownedCourses = await courseCollection.find({ ownerInstructorId: instructorId.toString() }).sort({ title: 1 }).toArray();
      const courseIds = ownedCourses.map(c => c._id);
      const lessonRows = courseIds.length ? await lessons.find({ courseId: { $in: courseIds } }).sort({ createdAt: -1 }).toArray() : [];
      const studentRows = await users.find({ role: "student" }).project({ passwordHash: 0 }).sort({ name: 1, email: 1 }).toArray();
      const courseMap = new Map(ownedCourses.map(c => [c._id.toString(), c]));
      const students = studentRows.map(u => {
        const enrolledIds = enrolledCourseIds(u).filter(id => courseMap.has(id));
        return { id: u._id.toString(), name: u.name || "Student", email: u.email || "", approved: !!u.approved, portal_locked: !!u.portalLocked, enrolled_course_ids: enrolledIds, courses: enrolledIds.map(id => courseMap.get(id)?.title).filter(Boolean) };
      });
      const submissionRows = await submissions.find({}).sort({ submittedAt: -1 }).toArray();
      const submissionsOut = [];
      for (const sub of submissionRows) {
        const a = await assignments.findOne({ _id: sub.assignmentId });
        if (!a || !a.courseId || !courseMap.has(String(a.courseId))) continue;
        const student = await users.findOne({ _id: sub.studentId }, { projection: { name: 1, email: 1 } });
        submissionsOut.push({ id: sub._id.toString(), assignment_title: a.title, course_title: courseMap.get(String(a.courseId))?.title || "Unknown", student_name: student?.name || "Unknown", email: student?.email || "", file_path: sub.file?.url ? `/api/admin/instructors/${instructorId}/submissions/${sub._id}/file` : "", file_name: sub.file?.originalName || "", grade: sub.grade || "", feedback: sub.feedback || "" });
      }
      res.json({
        instructor: { id: user._id.toString(), name: user.name || "Instructor", email: user.email || "", suspended: !!user.instructorSuspended, instructor_id_number:user.instructorIdNumber || "", registration_date:user.instructorRegistrationDate || (user.createdAt ? new Date(user.createdAt).toISOString().slice(0,10) : ""), expiry_date:user.instructorExpiryDate || "", department:user.instructorDepartment || "", profile_picture_url:user.profilePicture ? `/api/admin/profile-picture/${user._id.toString()}` : null },
        courses: ownedCourses.map(c => ({ id: c._id.toString(), title: c.title, description: c.description || "", price: Number(c.price || 0), thumbnail: c.thumbnail || "", locked: !!c.locked })),
        lessons: lessonRows.map(l => ({ id: l._id.toString(), course_id: l.courseId.toString(), title: l.title, note_path: l.note?.url ? `/api/admin/instructors/${instructorId}/lessons/${l._id}/note` : "", video_path: l.video ? `/api/admin/instructors/${instructorId}/lessons/${l._id}/media/video` : "", audio_path: l.audio ? `/api/admin/instructors/${instructorId}/lessons/${l._id}/media/audio` : "" })),
        students,
        submissions: submissionsOut
      });
    } catch (e) { next(e); }
  });

  app.get("/api/admin/instructors/:instructorId/lessons/:id/media/:kind", auth, admin, async (req, res, next) => {
    try {
      const instructorId = oid(req.params.instructorId), id = oid(req.params.id);
      const kind = req.params.kind === "audio" ? "audio" : req.params.kind === "video" ? "video" : null;
      if (!instructorId || !id || !kind) return res.status(400).json({ error: "Invalid lesson media request." });
      const lesson = await lessons.findOne({ _id: id });
      if (!lesson) return res.status(404).json({ error: "Lesson not found." });
      const course = await courseCollection.findOne({ _id: lesson.courseId, ownerInstructorId: instructorId.toString() }, { projection: { _id: 1 } });
      if (!course) return res.status(404).json({ error: "Lesson not found." });
      await streamLessonMedia(req, res, lesson, kind);
    } catch (e) { next(e); }
  });

  app.get("/api/admin/instructors/:instructorId/lessons/:id/note", auth, admin, async (req, res, next) => {
    try {
      const instructorId = oid(req.params.instructorId), id = oid(req.params.id);
      if (!instructorId || !id) return res.status(400).json({ error: "Invalid lesson request." });
      const lesson = await lessons.findOne({ _id: id });
      if (!lesson) return res.status(404).json({ error: "Lesson not found." });
      const course = await courseCollection.findOne({ _id: lesson.courseId, ownerInstructorId: instructorId.toString() }, { projection: { _id: 1 } });
      if (!course || !lesson.note?.url) return res.status(404).json({ error: "Lesson note is not available." });
      const upstream = await fetch(lesson.note.url, { redirect: "follow" });
      if (!upstream.ok || !upstream.body) return res.status(upstream.status === 404 ? 404 : 502).json({ error: "Lesson note could not be loaded." });
      const filename = path.basename(lesson.note.originalName || "lesson-note") || "lesson-note";
      const ext = path.extname(filename).toLowerCase();
      const mimeTypes = { ".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".doc":"application/msword", ".pdf":"application/pdf", ".txt":"text/plain; charset=utf-8", ".md":"text/markdown; charset=utf-8" };
      const contentType = mimeTypes[ext] || upstream.headers.get("content-type") || "application/octet-stream";
      const asciiFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      res.status(200).setHeader("Content-Type", contentType).setHeader("Content-Disposition", `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`).setHeader("X-Content-Type-Options", "nosniff").setHeader("Cache-Control", "private, max-age=300");
      const contentLength = upstream.headers.get("content-length"); if (contentLength) res.setHeader("Content-Length", contentLength);
      Readable.fromWeb(upstream.body).pipe(res);
    } catch (e) { next(e); }
  });

  app.get("/api/admin/instructors/:instructorId/submissions/:id/file", auth, admin, async (req, res, next) => {
    try {
      const instructorId = oid(req.params.instructorId), id = oid(req.params.id);
      const sub = id ? await submissions.findOne({ _id: id }) : null;
      if (!sub?.file?.url) return res.status(404).json({ error: "Submission file not found." });
      const assignment = await assignments.findOne({ _id: sub.assignmentId });
      if (!assignment) return res.status(404).json({ error: "Assignment not found." });
      const course = await courseCollection.findOne({ _id: assignment.courseId, ownerInstructorId: instructorId.toString() }, { projection: { _id: 1 } });
      if (!course) return res.status(404).json({ error: "Submission not found." });
      const upstream = await fetch(sub.file.url, { redirect: "follow" });
      if (!upstream.ok || !upstream.body) return res.status(upstream.status === 404 ? 404 : 502).json({ error: "Submission file could not be loaded." });
      const filename = path.basename(sub.file.originalName || "submission") || "submission";
      res.status(200).setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream").setHeader("Content-Disposition", `attachment; filename="${filename.replace(/["\r\n]/g, "_")}"`).setHeader("X-Content-Type-Options", "nosniff").setHeader("Cache-Control", "private, max-age=300");

      Readable.fromWeb(upstream.body).pipe(res);
    } catch (e) { next(e); }
  });

  app.get("/api/public-courses", async (req, res, next) => {
    try {
      const list = await courseCollection.find({}).sort({ title: 1 }).toArray();
      res.json({ courses: list.map(c => ({ id: c._id.toString(), title: c.title, description: c.description, price: Number(c.price || 0), thumbnail: c.thumbnail || "", duration_weeks: courseDurationPayload(c), instructor_owned: !!c.ownerInstructorId })) });
    } catch (e) { next(e); }
  });

  app.get("/api/courses", async (req, res, next) => {
    try {
      const list = await courseCollection.find({}).sort({ title: 1 }).toArray();
      let viewer = req.user || null;
      if (!viewer && req.session.userId) { const sid = oid(req.session.userId); if (sid) viewer = await users.findOne({ _id: sid }); }
      const filtered = viewer && viewer.role !== "admin" ? list.filter(c => studentHasCourse(viewer, c._id)) : list;
      res.json({ courses: filtered.map(c => ({ id: c._id.toString(), title: c.title, description: c.description, price: Number(c.price || 0), thumbnail: c.thumbnail || "", duration_weeks: courseDurationPayload(c), locked: !!c.locked, registered: viewer?.role === "admin" ? true : !!viewer && studentHasCourse(viewer, c._id), instructor_owned: !!c.ownerInstructorId, owner_instructor_id: c.ownerInstructorId ? String(c.ownerInstructorId) : null })) });
    } catch (e) { next(e); }
  });

  app.get("/api/dashboard", auth, studentAccess, async (req, res, next) => {
    try {
      const enrolled = enrolledCourseIds(req.user);
      const courseFilter = enrolled.length ? { $or: [{ courseId: { $in: enrolled.map(x => new ObjectId(x)) } }, { courseId: null }] } : { courseId: null };
      const rows = await assignments.find(courseFilter).sort({ createdAt: -1 }).toArray();
      const result = [];
      for (const a of rows) {
        const course = a.courseId ? await courseCollection.findOne({ _id: a.courseId }) : null;
        const s = await submissions.findOne({ assignmentId: a._id, studentId: req.user._id });
        result.push({
          id: a._id.toString(), title: a.title, instructions: a.instructions,
          due_date: a.dueDate || "", course_title: course?.title || "General",
          grade: s?.grade || "", feedback: s?.feedback || ""
        });
      }
      res.json({ user: {
        id: req.user._id.toString(), name: req.user.name, email: req.user.email, role: req.user.role,
        portal_locked: !!req.user.portalLocked, payment_status: req.user.paymentStatus || "unpaid", approved: !!req.user.approved,
        enrolled_course_ids: enrolledCourseIds(req.user), profile_picture_url: profilePictureUrl(req.user.profilePicture), student_id_number: req.user.studentIdNumber || null, course_code: req.user.courseCode || "", registration_date: req.user.registrationDate || (req.user.createdAt ? new Date(req.user.createdAt).toISOString().slice(0,10) : ""), programme_end_date: req.user.programmeEndDate || "", state: req.user.state || "", country: req.user.country || "", gender: req.user.gender || ""
      }, assignments: result });
    } catch (e) { next(e); }
  });

  app.post("/api/payments", rateLimit({ windowMs: 10 * 60 * 1000, max: 5, keyPrefix: "payments" }), auth, upload.single("proof"), async (req, res, next) => {
    try {
      const { method, reference, declaredPaid } = req.body;
      if (!["bank", "crypto"].includes(method)) return res.status(400).json({ error: "Invalid payment method" });
      let proof = null;
      if (req.file) {
        if (!hasAllowedExtension(req.file, paymentExtensions)) return res.status(400).json({ error: "Payment proof must be a JPG, PNG, WEBP, or PDF file." });
        const uploaded = await uploadPrivateProof(req.file.buffer, req.file.originalname);
        proof = { publicId: uploaded.public_id, resourceType: uploaded.resource_type || "image", originalName: req.file.originalname };
      }
      const result = await payments.insertOne({
        userId: req.user._id,
        method,
        reference: reference || "",
        proof,
        declaredPaid: declaredPaid === "true" || declaredPaid === "1",
        status: "pending",
        createdAt: new Date()
      });
      await users.updateOne({ _id: req.user._id }, { $set: { paymentStatus: "pending" } });
      res.json({ ok: true, paymentId: result.insertedId.toString(), message: "Payment submitted. Please wait for admin approval." });
    } catch (e) { next(e); }
  });


  // ---------------- Instructor / Course Creator Portal ----------------
  // A normal WPS user applies first. The administrator approves the application
  // and changes the account to role "instructor". Every instructor endpoint
  // verifies ownership of the course on the server.
  // Instructor applications are mirrored onto the user record as a durable fallback.
  function normalizeInstructorApplication(app) {
    if (!app) return null;
    // Accept both the current camelCase schema and older snake_case records.
    // This keeps existing MongoDB applications visible after a code update.
    const rawUserId = app.userId ?? app.user_id ?? app.userIdString ?? app.user_id_string ?? app.applicantId ?? app.applicant_id;
    const rawName = app.name ?? app.fullName ?? app.full_name ?? app.applicantName ?? app.applicant_name ?? "";
    const rawEmail = app.email ?? app.applicantEmail ?? app.applicant_email ?? "";
    const rawTopics = app.teachingTopics ?? app.teaching_topics ?? app.topics ?? app.teaching ?? "";
    const rawMessage = app.message ?? app.teachingPlan ?? app.teaching_plan ?? app.experience ?? app.plan ?? "";
    const rawStatus = app.status ?? app.applicationStatus ?? app.application_status ?? "pending";
    const rawCreated = app.createdAt ?? app.created_at ?? app.submittedAt ?? app.submitted_at ?? app.updatedAt ?? app.updated_at;
    const rawUpdated = app.updatedAt ?? app.updated_at ?? rawCreated;
    return {
      id: app._id ? String(app._id) : null,
      userId: rawUserId ? String(rawUserId) : null,
      name: String(rawName || ""), email: String(rawEmail || ""),
      teachingTopics: String(rawTopics || ""), message: String(rawMessage || ""),
      status: String(rawStatus || "pending"),
      createdAt: rawCreated || new Date(),
      updatedAt: rawUpdated || rawCreated || new Date()
    };
  }
  function getUserInstructorApplication(user) {
    if (!user) return null;
    // Support both the current embedded field and legacy snake_case records.
    const embedded = user.instructorApplication || user.instructor_application || user.instructorApplicationData || null;
    if (!embedded) return null;
    return normalizeInstructorApplication({ ...embedded, userId: embedded.userId || embedded.user_id || user._id });
  }

  app.get("/api/instructor/status", auth, async (req, res, next) => {
    try {
      // The embedded user application is authoritative and is available without
      // depending on the legacy mirror collection.
      const embedded = getUserInstructorApplication(req.user);
      let chosen = embedded;
      if (!chosen) {
        try {
          const application = await instructorApplications.findOne(
            { $or: [{ userId: req.user._id }, { userIdString: String(req.user._id) }] },
            { sort: { updatedAt: -1, createdAt: -1 }, maxTimeMS: 1500 }
          );
          chosen = normalizeInstructorApplication(application);
        } catch (mirrorError) {
          console.warn("Instructor status mirror read skipped:", mirrorError?.message || mirrorError);
        }
      }
      const courses = req.user.role === "instructor" ? await courseCollection.countDocuments({ ownerInstructorId: req.user._id.toString() }) : 0;
      res.json({ role:req.user.role, approved:req.user.role === "instructor" && req.user.instructorApproved !== false && !req.user.instructorSuspended, suspended:!!req.user.instructorSuspended, instructor_id_number:req.user.instructorIdNumber || null, registration_date:req.user.instructorRegistrationDate || (req.user.createdAt ? new Date(req.user.createdAt).toISOString().slice(0,10) : ""), expiry_date:req.user.instructorExpiryDate || "", department:req.user.instructorDepartment || "", profile_picture_url:req.user.profilePicture ? `/api/verify-instructor/profile-picture/${req.user._id.toString()}` : null, application:chosen ? {status:chosen.status,message:chosen.message || "",createdAt:chosen.createdAt} : null, courseCount:courses });
    } catch (e) { next(e); }
  });

  app.post("/api/instructor/apply", auth, async (req, res, next) => {
    try {
      if (req.user.role === "admin") return res.status(400).json({ error:"Administrator accounts do not need instructor approval." });
      if (req.user.role === "instructor") return res.status(400).json({ error:"This account is already an instructor." });

      const message = String(req.body.message || "").trim().slice(0,2000);
      const teachingTopics = String(req.body.teachingTopics || "").trim().slice(0,1000);
      if (!teachingTopics || !message) {
        return res.status(400).json({error:"Please provide both what you want to teach and your teaching plan/experience."});
      }

      const now = new Date();
      const userIdString = String(req.user._id);
      const previous = req.user.instructorApplication || req.user.instructor_application || req.user.instructorApplicationData || {};
      if (String(previous.status || previous.applicationStatus || previous.application_status || "").toLowerCase() === "pending") {
        return res.status(409).json({error:"Your instructor application is already awaiting admin review."});
      }

      // Store the application on the user record first. This is the source of truth
      // used by the admin portal, so an issue with the secondary collection can never
      // make a successfully submitted application disappear from the admin UI.
      const embeddedApplication = {
        userId: req.user._id,
        userIdString,
        name: req.user.name || "",
        email: req.user.email || "",
        teachingTopics,
        message,
        status: "pending",
        createdAt: previous.createdAt || now,
        updatedAt: now
      };
      const userWrite = await users.updateOne(
        {_id:req.user._id},
        {$set:{
          instructorApplication:embeddedApplication,
          instructorApproved:false,
          instructorSuspended:false
        }}
      );
      if (!userWrite.matchedCount) return res.status(404).json({error:"User account could not be found."});

      // Verify the durable source-of-truth write before telling the applicant that the
      // application was accepted. This prevents a false-success response when MongoDB
      // has rejected or failed the write.
      const verifyUser = await users.findOne({_id:req.user._id},{projection:{instructorApplication:1}});
      if (!verifyUser?.instructorApplication?.teachingTopics || !verifyUser?.instructorApplication?.message) {
        return res.status(500).json({error:"The instructor application could not be saved. Please try again."});
      }

      // The application is already durably saved on the user record. Never make the
      // legacy mirror collection part of the response path: a slow/conflicting mirror
      // index must not make the applicant wait or make a successful submission look
      // like it failed.
      const applicationId = userIdString;
      void (async () => {
        try {
          await instructorApplications.updateOne(
            { $or:[{userId:req.user._id},{userIdString}] },
            {$set:{
              userId:req.user._id,
              userIdString,
              name:embeddedApplication.name,
              email:embeddedApplication.email,
              message,
              teachingTopics,
              status:"pending",
              updatedAt:now
            },$setOnInsert:{createdAt:embeddedApplication.createdAt}},
            {upsert:true, maxTimeMS:1500}
          );
        } catch (mirrorError) {
          console.warn("Instructor application mirror skipped:", mirrorError?.message || mirrorError);
        }
      })();

      console.log(`Instructor application submitted: ${req.user.email || req.user._id}`);
      return res.status(201).json({ok:true,applicationId,userId:userIdString,status:"pending",message:"Instructor application submitted successfully. Please wait for administrator approval."});
    } catch (e) { next(e); }
  });

  app.get("/api/instructor/courses", auth, instructor, async (req, res, next) => {
    try {
      const list = await courseCollection.find({ ownerInstructorId: req.user._id.toString() }).sort({ createdAt: -1 }).toArray();
      res.json({ courses: list.map(c => ({ id: c._id.toString(), title: c.title, description: c.description || "", price: Number(c.price || 0), thumbnail: c.thumbnail || "", duration_weeks: courseDurationPayload(c), locked: !!c.locked, createdAt: c.createdAt })) });
    } catch (e) { next(e); }
  });

  app.post("/api/instructor/courses", auth, instructor, async (req, res, next) => {
    try {
      const title = String(req.body.title || "").trim().slice(0, 120);
      const description = String(req.body.description || "").trim().slice(0, 2000);
      const price = Number(req.body.price || 0);
      const thumbnail = String(req.body.thumbnail || "").trim().slice(0, 1000);
      const durationWeeks = Math.min(104, Math.max(1, Number(req.body.durationWeeks || 12)));
      if (!title) return res.status(400).json({ error: "Course title is required." });
      if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: "Price must be a non-negative number." });
      if (thumbnail && !/^https?:\/\//i.test(thumbnail)) return res.status(400).json({ error: "Thumbnail must be a valid http(s) URL." });
      const existing = await courseCollection.findOne({ title: { $regex: `^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });
      if (existing) return res.status(409).json({ error: "A course with that title already exists." });
      const result = await courseCollection.insertOne({ title, description, price, thumbnail, locked: false, durationWeeks, ownerInstructorId: req.user._id.toString(), createdAt: new Date(), updatedAt: new Date() });
      res.status(201).json({ ok: true, id: result.insertedId.toString() });
    } catch (e) { next(e); }
  });

  app.put("/api/instructor/courses/:id", auth, instructor, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id || !(await instructorOwnsCourse(req.user, id))) return res.status(404).json({ error: "Course not found." });
      const course = await courseCollection.findOne({ _id: id });
      const title = String(req.body.title ?? course.title).trim().slice(0, 120);
      const description = String(req.body.description ?? course.description ?? "").trim().slice(0, 2000);
      const price = Number(req.body.price ?? course.price ?? 0);
      const thumbnail = String(req.body.thumbnail ?? course.thumbnail ?? "").trim().slice(0, 1000);
      const durationWeeks = Math.min(104, Math.max(1, Number(req.body.durationWeeks ?? course.durationWeeks ?? 12)));
      const locked = req.body.locked === undefined ? !!course.locked : !!(req.body.locked === true || req.body.locked === "true");
      if (!title || !Number.isFinite(price) || price < 0) return res.status(400).json({ error: "Invalid course details." });
      const duplicate = await courseCollection.findOne({ _id: { $ne: id }, title: { $regex: `^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });
      if (duplicate) return res.status(409).json({ error: "A course with that title already exists." });
      await courseCollection.updateOne({ _id: id }, { $set: { title, description, price, thumbnail, durationWeeks, locked, updatedAt: new Date() } });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.delete("/api/instructor/courses/:id", auth, instructor, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id || !(await instructorOwnsCourse(req.user, id))) return res.status(404).json({ error: "Course not found." });
      const courseLessons = await lessons.find({ courseId: id }).toArray();
      const assignmentDocs = await assignments.find({ courseId: id }).toArray();
      await Promise.all(courseLessons.flatMap(l => [
        destroyCloudinaryAsset(l.note, "raw"), destroyCloudinaryAsset(l.video, "video"), destroyCloudinaryAsset(l.audio, "video")
      ]));
      const lessonIds = courseLessons.map(x => x._id), assignmentIds = assignmentDocs.map(x => x._id);
      await Promise.all([
        lessons.deleteMany({ courseId: id }),
        courseEnrollments.deleteMany({ courseId: id }),
        attendanceRecords.deleteMany({ courseId: id }),
        assignments.deleteMany({ courseId: id }),
        users.updateMany({ enrolledCourseIds: id.toString() }, { $pull: { enrolledCourseIds: id.toString() } }),
        users.updateMany({ enrolledCourseIds: id }, { $pull: { enrolledCourseIds: id } }),
        ...(lessonIds.length ? [lessonProgress.deleteMany({ lessonId: { $in: lessonIds } }), lessonAccessOverrides.deleteMany({ lessonId: { $in: lessonIds } })] : []),
        ...(assignmentIds.length ? [submissions.deleteMany({ assignmentId: { $in: assignmentIds } })] : []),
        courseCollection.deleteOne({ _id: id })
      ]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.post("/api/instructor/courses/:id/toggle-lock", auth, instructor, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id || !(await instructorOwnsCourse(req.user, id))) return res.status(404).json({ error: "Course not found." });
      const c = await courseCollection.findOne({ _id: id });
      await courseCollection.updateOne({ _id: id }, { $set: { locked: !c.locked, updatedAt: new Date() } });
      res.json({ ok: true, locked: !c.locked });
    } catch (e) { next(e); }
  });

  app.post("/api/instructor/lessons", auth, instructor, upload.fields([{ name: "note", maxCount: 1 }, { name: "video", maxCount: 1 }, { name: "audio", maxCount: 1 }]), async (req, res, next) => {
    try {
      const courseId = oid(req.body.courseId);
      const title = String(req.body.title || "").trim();
      const lessonId = req.body.lessonId ? oid(req.body.lessonId) : null;
      const unlockAt = normalizeLessonUnlockAt(req.body.unlockAt);
      if (req.body.unlockAt && !unlockAt) return res.status(400).json({ error: "Invalid lesson unlock date/time." });
      if (!courseId || !title || !(await instructorOwnsCourse(req.user, courseId))) return res.status(404).json({ error: "Course not found." });
      const noteFile = req.files?.note?.[0], videoFile = req.files?.video?.[0], audioFile = req.files?.audio?.[0];
      if (!noteFile && !videoFile && !audioFile && !lessonId) return res.status(400).json({ error: "Select at least one lesson file or choose an existing lesson to update its Smart Lock settings." });
      if (noteFile && !hasAllowedExtension(noteFile, noteExtensions)) return res.status(400).json({ error: "Lesson notes must be PDF, DOC, DOCX, TXT, or MD." });
      if (videoFile && !hasAllowedExtension(videoFile, videoExtensions)) return res.status(400).json({ error: "Lesson video must be MP4, WEBM, MOV, or M4V." });
      let existing = lessonId ? await lessons.findOne({ _id: lessonId, courseId }) : await lessons.findOne({ courseId, title });
      if (lessonId && !existing) return res.status(404).json({ error: "Lesson not found." });
      const patch = { updatedAt: new Date() };
      if (req.body.unlockAt !== undefined) patch.unlockAt = unlockAt;
      if (noteFile) { const r=await uploadBuffer(noteFile.buffer,noteFile.originalname,"instructor-lesson-notes","raw"); patch.note={url:r.secure_url,publicId:r.public_id,resourceType:r.resource_type||"raw",type:r.type||"upload",originalName:noteFile.originalname}; }
      if (videoFile) { const r=await uploadBuffer(videoFile.buffer,videoFile.originalname,"instructor-lesson-videos","video"); patch.video={url:r.secure_url,publicId:r.public_id,resourceType:r.resource_type||"video",type:r.type||"upload",originalName:videoFile.originalname}; }
      if (audioFile) { const r=await uploadBuffer(audioFile.buffer,audioFile.originalname,"instructor-lesson-audio","video"); patch.audio={url:r.secure_url,publicId:r.public_id,resourceType:r.resource_type||"video",type:r.type||"upload",originalName:audioFile.originalname}; }
      if (existing) {
        const oldAssets=[];
        if(noteFile&&existing.note)oldAssets.push([existing.note,"raw"]); if(videoFile&&existing.video)oldAssets.push([existing.video,"video"]); if(audioFile&&existing.audio)oldAssets.push([existing.audio,"video"]);
        await lessons.updateOne({_id:existing._id},{$set:patch}); await Promise.all(oldAssets.map(([a,t])=>destroyCloudinaryAsset(a,t)));
        return res.json({ok:true,id:existing._id.toString(),updated:true});
      }
      const result=await lessons.insertOne({courseId,title,note:patch.note||null,video:patch.video||null,audio:patch.audio||null,unlockAt:patch.unlockAt ?? null,createdAt:new Date(),updatedAt:new Date()});
      res.json({ok:true,id:result.insertedId.toString(),updated:false});
    } catch(e){ next(e); }
  });

  app.post("/api/instructor/lessons/:id/access-control", auth, instructor, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      const unlockAt = normalizeLessonUnlockAt(req.body.unlockAt);
      if (!id) return res.status(400).json({ error: "Invalid lesson id." });
      if (req.body.unlockAt && !unlockAt) return res.status(400).json({ error: "Invalid lesson unlock date/time." });
      const lesson = await lessons.findOne({ _id: id });
      if (!lesson || !(await instructorOwnsCourse(req.user, lesson.courseId))) return res.status(404).json({ error: "Lesson not found." });
      await lessons.updateOne({ _id: id }, { $set: { unlockAt, updatedAt: new Date() } });
      res.json({ ok: true, unlock_at: unlockAt, message: unlockAt ? "Lesson release date saved." : "Lesson will remain Smart Locked until an explicit release date or existing access applies." });
    } catch (e) { next(e); }
  });

  app.get("/api/instructor/lessons", auth, instructor, async (req,res,next)=>{
    try{
      const courseIds=(await courseCollection.find({ownerInstructorId:req.user._id.toString()}).project({_id:1}).toArray()).map(x=>x._id);
      const list=await lessons.find({courseId:{$in:courseIds}}).sort({createdAt:-1}).toArray();
      res.json({lessons:list.map(l=>({id:l._id.toString(),course_id:l.courseId.toString(),title:l.title,note_path:l.note?.url||"",video_path:lessonMediaUrl(l.video,"video")||"",audio_path:lessonMediaUrl(l.audio,"audio")||"",unlock_at:l.unlockAt||null}))});
    }catch(e){next(e)}
  });

  // Instructor-side media preview/download endpoints. These use the same
  // authenticated streaming path as the student player so MP4/WebM and audio
  // files receive the correct MIME type and HTTP Range headers on mobile.
  app.get("/api/instructor/lessons/:id/media/:kind", auth, instructor, async (req,res,next)=>{
    try{
      const id=oid(req.params.id);
      const kind=req.params.kind === "audio" ? "audio" : req.params.kind === "video" ? "video" : null;
      if(!id || !kind) return res.status(400).json({error:"Invalid lesson media request."});
      const lesson=await lessons.findOne({_id:id});
      if(!lesson || !(await instructorOwnsCourse(req.user,lesson.courseId))) return res.status(404).json({error:"Lesson not found."});
      await streamLessonMedia(req,res,lesson,kind);
    }catch(e){next(e)}
  });

  app.get("/api/instructor/lessons/:id/note", auth, instructor, async (req,res,next)=>{
    try{
      const id=oid(req.params.id);
      if(!id) return res.status(400).json({error:"Invalid lesson id."});
      const lesson=await lessons.findOne({_id:id});
      if(!lesson || !(await instructorOwnsCourse(req.user,lesson.courseId))) return res.status(404).json({error:"Lesson not found."});
      if(!lesson.note?.url) return res.status(404).json({error:"Lesson note is not available."});
      let upstream;
      try{ upstream=await fetch(lesson.note.url,{redirect:"follow"}); }
      catch(e){ console.error("Instructor lesson note fetch failed:",e?.message||e); return res.status(502).json({error:"Could not load the lesson note."}); }
      if(!upstream.ok) return res.status(upstream.status===404?404:502).json({error:"Lesson note could not be loaded."});
      const filename=path.basename(lesson.note.originalName||"lesson-note")||"lesson-note";
      const ext=path.extname(filename).toLowerCase();
      const mimeTypes={".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",".doc":"application/msword",".pdf":"application/pdf",".txt":"text/plain; charset=utf-8",".md":"text/markdown; charset=utf-8"};
      const contentType=mimeTypes[ext]||upstream.headers.get("content-type")||"application/octet-stream";
      const asciiFilename=filename.replace(/[^a-zA-Z0-9._-]/g,"_");
      res.status(200).setHeader("Content-Type",contentType).setHeader("Content-Disposition",`attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`).setHeader("X-Content-Type-Options","nosniff").setHeader("Cache-Control","private, max-age=300");
      const contentLength=upstream.headers.get("content-length"); if(contentLength) res.setHeader("Content-Length",contentLength);
      if(!upstream.body) return res.end();
      Readable.fromWeb(upstream.body).on("error",err=>{console.error("Instructor lesson note stream failed:",err?.message||err);if(!res.headersSent)res.status(502);res.end();}).pipe(res);
    }catch(e){next(e)}
  });

  app.delete("/api/instructor/lessons/:id", auth, instructor, async (req,res,next)=>{
    try{
      const id=oid(req.params.id); const lesson=id?await lessons.findOne({_id:id}):null;
      if(!lesson || !(await instructorOwnsCourse(req.user,lesson.courseId))) return res.status(404).json({error:"Lesson not found."});
      await Promise.all([destroyCloudinaryAsset(lesson.note,"raw"),destroyCloudinaryAsset(lesson.video,"video"),destroyCloudinaryAsset(lesson.audio,"video")]);
      await Promise.all([lessons.deleteOne({_id:id}),lessonProgress.deleteMany({lessonId:id})]);
      res.json({ok:true});
    }catch(e){next(e)}
  });

  app.post("/api/instructor/assignments", auth, instructor, async (req,res,next)=>{
    try{
      const courseId=req.body.courseId?oid(req.body.courseId):null;
      if(!courseId || !(await instructorOwnsCourse(req.user,courseId))) return res.status(404).json({error:"Course not found."});
      const title=String(req.body.title||"").trim(), instructions=String(req.body.instructions||"").trim();
      if(!title||!instructions) return res.status(400).json({error:"Title and instructions required."});
      const result=await assignments.insertOne({courseId,title,instructions,dueDate:req.body.dueDate||null,createdAt:new Date(),createdBy:req.user._id.toString()});
      res.json({ok:true,id:result.insertedId.toString()});
    }catch(e){next(e)}
  });

  app.get("/api/instructor/students", auth, instructor, async (req,res,next)=>{
    try{
      const courses=await courseCollection.find({ownerInstructorId:req.user._id.toString()}).sort({title:1}).toArray();
      const courseMap=new Map(courses.map(c=>[c._id.toString(),c]));
      // List every student account, not only students who are already enrolled.
      // Otherwise a new student can never appear in the instructor portal and
      // the instructor has no way to make the first enrollment.
      const students=await users.find({role:"student"}).project({passwordHash:0}).sort({name:1,email:1}).toArray();
      res.json({students:students.map(u=>{
        const enrolledIds=enrolledCourseIds(u).filter(id=>courseMap.has(id));
        return {
          id:u._id.toString(),
          name:u.name,
          email:u.email,
          approved:!!u.approved,
          portal_locked:!!u.portalLocked,
          enrolled_course_ids:enrolledIds,
          courses:enrolledIds.map(id=>courseMap.get(id)?.title).filter(Boolean)
        };
      })});
    }catch(e){next(e)}
  });

  app.post("/api/instructor/students/:studentId/enrollment", auth, instructor, async (req,res,next)=>{
    try{
      const studentId=oid(req.params.studentId), courseId=oid(req.body.courseId);
      if(!studentId||!courseId||!(await instructorOwnsCourse(req.user,courseId))) return res.status(404).json({error:"Course not found."});
      const student=await users.findOne({_id:studentId,role:"student"});
      if(!student) return res.status(404).json({error:"Student not found."});
      const enroll=req.body.enroll !== false && req.body.enroll !== "false";
      await users.updateOne({_id:studentId}, enroll ? {$addToSet:{enrolledCourseIds:courseId.toString()}} : {$pull:{enrolledCourseIds:courseId.toString()}});
      if (enroll) await ensureEnrollment(studentId, courseId, lagosDateString());
      else await courseEnrollments.deleteOne({studentId, courseId});
      res.json({ok:true,enrolled:enroll});
    }catch(e){next(e)}
  });

  // Admin attendance management. This uses the same attendance_records and
  // course-duration schedule as the student/instructor portals so there is only
  // one source of truth. Admins may view all scheduled Monday-Friday days and
  // correct historical records when necessary.
  app.get("/api/admin/attendance", auth, admin, async (req,res,next)=>{
    try {
      const courseId = oid(req.query.courseId);
      const dateFilter = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || "")) ? String(req.query.date) : "";
      const courses = await courseCollection.find(courseId ? {_id:courseId} : {}).sort({title:1}).toArray();
      const result = [];
      for (const course of courses) {
        const students = await users.find({role:"student", approved:true, enrolledCourseIds:course._id.toString()})
          .project({name:1,email:1,studentIdNumber:1,registrationDate:1,createdAt:1,profilePicture:1})
          .sort({name:1}).toArray();
        const rows = [];
        for (const student of students) {
          const enrollment = await ensureEnrollment(student._id, course._id, student.registrationDate || (student.createdAt ? lagosDateString(student.createdAt) : lagosDateString()));
          const schedule = attendanceSchedule(enrollment, course);
          const marks = await attendanceRecords.find({studentId:student._id,courseId:course._id,date:{$in:schedule}}).sort({date:1}).toArray();
          const marked = new Set(marks.map(x=>x.date));
          const visibleSchedule = dateFilter ? schedule.filter(d=>d===dateFilter) : schedule;
          const days = visibleSchedule.map(date=>({
            date,
            day:new Date(date+"T00:00:00Z").toLocaleDateString("en-US",{weekday:"short",timeZone:"UTC"}),
            marked:marked.has(date),
            marked_at:marks.find(x=>x.date===date)?.markedAt || null
          }));
          const today=lagosDateString();
          const elapsedDays=schedule.filter(d=>d<=today).length;
          const totalDays=schedule.length;
          const markedCount=marks.filter(m=>m.date<=today).length;
          rows.push({
            student_id:student._id.toString(),
            student_name:student.name||"Student",
            email:student.email||"",
            student_id_number:student.studentIdNumber||"",
            enrollment_date:enrollment?.enrolledAtDate||schedule[0]||"",
            duration_weeks:courseDurationPayload(course),
            total_days:totalDays,
            expected_days_to_date:elapsedDays,
            marked_count:markedCount,
            attendance_percentage:elapsedDays ? Math.round((markedCount/elapsedDays)*100) : 0,
            today_marked:marked.has(today),
            days
          });
        }
        result.push({course_id:course._id.toString(),course_title:course.title,duration_weeks:courseDurationPayload(course),students:rows});
      }
      res.json({today:lagosDateString(),weekdays:["Monday","Tuesday","Wednesday","Thursday","Friday"],courses:result,date_filter:dateFilter||null});
    } catch(e){next(e);}
  });

  app.post("/api/admin/attendance/mark", auth, admin, async (req,res,next)=>{
    try {
      const studentId=oid(req.body.studentId), courseId=oid(req.body.courseId);
      const date=String(req.body.date||"");
      if(!studentId||!courseId||!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({error:"Student, course and valid date are required."});
      const course=await courseCollection.findOne({_id:courseId});
      const student=await users.findOne({_id:studentId,role:"student"});
      if(!course||!student||!studentHasCourse(student,courseId)) return res.status(404).json({error:"Student or course not found/enrolled."});
      const enrollment=await ensureEnrollment(studentId,courseId,student.registrationDate || (student.createdAt ? lagosDateString(student.createdAt):date));
      const schedule=attendanceSchedule(enrollment,course);
      if(!schedule.includes(date)) return res.status(400).json({error:"That date is outside the student's course attendance schedule or is not Monday-Friday."});
      await attendanceRecords.updateOne({studentId,courseId,date},{$set:{studentId,courseId,date,markedAt:new Date(),markedBy:"admin"},$setOnInsert:{createdAt:new Date()}},{upsert:true});
      res.json({ok:true,message:"Attendance marked by administrator."});
    }catch(e){if(e?.code===11000)return res.json({ok:true});next(e);}
  });

  app.post("/api/admin/attendance/unmark", auth, admin, async (req,res,next)=>{
    try {
      const studentId=oid(req.body.studentId), courseId=oid(req.body.courseId), date=String(req.body.date||"");
      if(!studentId||!courseId||!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({error:"Student, course and valid date are required."});
      await attendanceRecords.deleteOne({studentId,courseId,date});
      res.json({ok:true,message:"Attendance record removed."});
    }catch(e){next(e);}
  });

  app.get("/api/admin/attendance/export.csv", auth, admin, async (req,res,next)=>{
    try {
      const courseId=oid(req.query.courseId);
      const courses=await courseCollection.find(courseId?{_id:courseId}:{}).sort({title:1}).toArray();
      const lines=[["Student ID","Student","Email","Course","Date","Day","Status","Marked At","Marked By"]];
      for(const course of courses){
        const students=await users.find({role:"student",approved:true,enrolledCourseIds:course._id.toString()}).project({name:1,email:1,studentIdNumber:1,registrationDate:1,createdAt:1}).sort({name:1}).toArray();
        for(const student of students){
          const enrollment=await ensureEnrollment(student._id,course._id,student.registrationDate || (student.createdAt ? lagosDateString(student.createdAt):lagosDateString()));
          const schedule=attendanceSchedule(enrollment,course);
          const marks=await attendanceRecords.find({studentId:student._id,courseId:course._id,date:{$in:schedule}}).toArray();
          const byDate=new Map(marks.map(m=>[m.date,m]));
          for(const date of schedule){
            const mark=byDate.get(date); const day=new Date(date+"T00:00:00Z").toLocaleDateString("en-US",{weekday:"long",timeZone:"UTC"});
            lines.push([student.studentIdNumber||"",student.name||"Student",student.email||"",course.title,date,day,mark?"Present":"Absent",mark?.markedAt?new Date(mark.markedAt).toISOString():"",mark?.markedBy||""]);
          }
        }
      }
      const csv=lines.map(row=>row.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\n");
      res.setHeader("Content-Type","text/csv; charset=utf-8");
      res.setHeader("Content-Disposition",`attachment; filename="smarttep-attendance-${lagosDateString()}.csv"`);
      res.send(csv);
    }catch(e){next(e);}
  });

  app.get("/api/attendance", auth, studentAccess, async (req,res,next)=>{
    try {
      const courses = await getStudentAttendance(req.user._id);
      res.json({ today: lagosDateString(), weekdays: ["Monday","Tuesday","Wednesday","Thursday","Friday"], courses });
    } catch(e){ next(e); }
  });

  app.post("/api/attendance/mark", auth, studentAccess, async (req,res,next)=>{
    try {
      const courseId = oid(req.body.courseId);
      if (!courseId) return res.status(400).json({error:"Invalid course."});
      const course = await courseCollection.findOne({_id:courseId});
      if (!course || !studentHasCourse(req.user, courseId)) return res.status(404).json({error:"You are not enrolled in this course."});
      const today = lagosDateString();
      const enrollment = await ensureEnrollment(req.user._id, courseId, req.user.registrationDate || (req.user.createdAt ? lagosDateString(req.user.createdAt) : today));
      const schedule = attendanceSchedule(enrollment, course);
      if (!schedule.includes(today)) return res.status(403).json({error:"Attendance is closed for this course today. Attendance is available Monday to Friday during your course duration."});
      const existing = await attendanceRecords.findOne({studentId:req.user._id,courseId,date:today});
      if (existing) return res.json({ok:true,already_marked:true,date:today});
      await attendanceRecords.insertOne({studentId:req.user._id,courseId,date:today,markedAt:new Date(),markedBy:"student"});
      res.json({ok:true,date:today,message:"Attendance marked successfully for today."});
    } catch(e){ if(e?.code===11000) return res.json({ok:true,already_marked:true,date:lagosDateString()}); next(e); }
  });

  // ===================== EXAM PORTAL =====================
  function cleanExamQuestion(q, index) {
    const type = String(q?.type || "objective").toLowerCase() === "theory" ? "theory" : "objective";
    const text = String(q?.text || "").trim().slice(0, 2000);
    const marks = Math.max(1, Math.min(100, Number(q?.marks || 1)));
    if (!text) throw Object.assign(new Error(`Question ${index + 1} is empty.`), { status: 400 });
    if (type === "theory") return { type, text, marks };
    const options = Array.isArray(q?.options) ? q.options.slice(0, 3).map(v => String(v || "").trim().slice(0, 500)) : [];
    if (options.length !== 3 || options.some(v => !v)) throw Object.assign(new Error(`Objective question ${index + 1} must have exactly 3 non-empty options.`), { status: 400 });
    const correctIndex = Number(q?.correctIndex);
    if (![0,1,2].includes(correctIndex)) throw Object.assign(new Error(`Objective question ${index + 1} needs a correct answer.`), { status: 400 });
    return { type, text, options, correctIndex, marks };
  }
  function examForClient(exam, includeAnswers=false) {
    return {
      id: exam._id.toString(), title: exam.title, instructions: exam.instructions || "", course_id: exam.courseId.toString(), course_title: exam.courseTitle || "",
      duration_minutes: Number(exam.durationMinutes || 60), published: exam.published !== false, starts_at: exam.startsAt || null, closes_at: exam.closesAt || null,
      questions: (exam.questions || []).map((q,i) => includeAnswers ? ({...q, number:i+1}) : ({ number:i+1, type:q.type, text:q.text, options:q.options || [], marks:q.marks }))
    };
  }
  async function ownedExamFilter(user, examId) {
    const exam = await exams.findOne({_id:examId});
    if (!exam) return null;
    if (user.role === "admin") return exam;
    if (user.role === "instructor" && exam.ownerRole === "instructor" && String(exam.ownerId) === String(user._id)) return exam;
    return null;
  }

  async function listTeachingExams(user) {
    const filter = user.role === "admin" ? {} : { ownerRole:"instructor", ownerId:user._id.toString() };
    return await exams.find(filter).sort({createdAt:-1}).toArray();
  }

  async function createExamForUser(req, res, next) {
    try {
      const courseId=oid(req.body.courseId), title=String(req.body.title||"").trim().slice(0,160), instructions=String(req.body.instructions||"").trim().slice(0,3000);
      const durationMinutes=Math.max(1,Math.min(480,Number(req.body.durationMinutes||60)));
      if(!courseId||!title) return res.status(400).json({error:"Course and exam title are required."});
      if(req.user.role === "instructor" && !(await instructorOwnsCourse(req.user,courseId))) return res.status(403).json({error:"You can only create exams for your own courses."});
      const course=await courseCollection.findOne({_id:courseId});
      if(!course) return res.status(404).json({error:"Course not found."});
      const rawQuestions=Array.isArray(req.body.questions)?req.body.questions:[];
      if(!rawQuestions.length) return res.status(400).json({error:"Add at least one question."});
      if(rawQuestions.length>100) return res.status(400).json({error:"An exam can contain at most 100 questions."});
      const questions=rawQuestions.map(cleanExamQuestion);
      const doc={title,instructions,courseId,courseTitle:course.title,durationMinutes,questions,published:req.body.published !== false,ownerRole:req.user.role,ownerId:req.user.role==='admin'?req.user._id.toString():req.user._id.toString(),startsAt:req.body.startsAt?new Date(req.body.startsAt):null,closesAt:req.body.closesAt?new Date(req.body.closesAt):null,createdAt:new Date(),updatedAt:new Date()};
      if(doc.startsAt && Number.isNaN(doc.startsAt.getTime())) doc.startsAt=null;
      if(doc.closesAt && Number.isNaN(doc.closesAt.getTime())) doc.closesAt=null;
      const r=await exams.insertOne(doc);
      res.json({ok:true,id:r.insertedId.toString(),exam:examForClient({...doc,_id:r.insertedId},true)});
    } catch(e){next(e)}
  }

  app.post("/api/admin/exams", auth, admin, createExamForUser);
  app.post("/api/instructor/exams", auth, instructor, createExamForUser);

  app.get("/api/admin/exams", auth, admin, async(req,res,next)=>{try{const rows=await listTeachingExams(req.user);res.json({exams:rows.map(e=>examForClient(e,true))});}catch(e){next(e)}});
  app.get("/api/instructor/exams", auth, instructor, async(req,res,next)=>{try{const rows=await listTeachingExams(req.user);res.json({exams:rows.map(e=>examForClient(e,true))});}catch(e){next(e)}});

  app.delete("/api/admin/exams/:id", auth, admin, async(req,res,next)=>{try{const id=oid(req.params.id);if(!id)return res.status(400).json({error:"Invalid exam."});await exams.deleteOne({_id:id});await examAttempts.deleteMany({examId:id});res.json({ok:true});}catch(e){next(e)}});
  app.delete("/api/instructor/exams/:id", auth, instructor, async(req,res,next)=>{try{const id=oid(req.params.id), exam=await ownedExamFilter(req.user,id);if(!exam)return res.status(404).json({error:"Exam not found."});await exams.deleteOne({_id:id});await examAttempts.deleteMany({examId:id});res.json({ok:true});}catch(e){next(e)}});

  app.get("/api/student/exams", auth, studentAccess, async(req,res,next)=>{
    try{
      const courseIds=enrolledCourseIds(req.user).map(oid).filter(Boolean);
      const rows=courseIds.length?await exams.find({courseId:{$in:courseIds},published:true}).sort({createdAt:-1}).toArray():[];
      const now=new Date();
      const attempts=await examAttempts.find({studentId:req.user._id}).project({examId:1,status:1,score:1,maxScore:1}).toArray();
      const by=new Map(attempts.map(a=>[String(a.examId),a]));
      const available=rows.filter(e=>(!e.startsAt||now>=new Date(e.startsAt))&&(!e.closesAt||now<=new Date(e.closesAt))).map(e=>({...examForClient(e,false),attempt:by.get(e._id.toString())||null}));
      res.json({exams:available});
    }catch(e){next(e)}
  });

  app.post("/api/student/exams/:id/start", auth, studentAccess, async(req,res,next)=>{
    try{
      const id=oid(req.params.id); const exam=await exams.findOne({_id:id,published:true}); if(!exam)return res.status(404).json({error:"Exam not found."});
      if(!studentHasCourse(req.user,exam.courseId))return res.status(403).json({error:"You are not enrolled in this course."});
      const now=new Date(); if(exam.startsAt&&now<new Date(exam.startsAt))return res.status(403).json({error:"This exam has not opened yet."}); if(exam.closesAt&&now>new Date(exam.closesAt))return res.status(403).json({error:"This exam is closed."});
      let attempt=await examAttempts.findOne({examId:id,studentId:req.user._id});
      if(attempt?.status==='submitted')return res.status(409).json({error:"You have already submitted this exam."});
      if(attempt?.status==='locked' || req.user.portalLocked) return res.status(423).json({error:"Your account is locked pending administrator approval because of an exam security violation."});
      if(!attempt){const r=await examAttempts.insertOne({examId:id,studentId:req.user._id,startedAt:now,status:"in_progress",answers:[],objectiveScore:0,theoryScore:0,score:0,maxScore:(exam.questions||[]).reduce((n,q)=>n+Number(q.marks||1),0),createdAt:now,updatedAt:now});attempt={_id:r.insertedId,startedAt:now,status:"in_progress"};}
      const started=new Date(attempt.startedAt); const expiresAt=new Date(started.getTime()+Number(exam.durationMinutes||60)*60000); if(now>expiresAt)return res.status(409).json({error:"Your exam time has expired. Please contact an administrator."});
      res.json({exam:examForClient(exam,false),attempt_id:attempt._id.toString(),started_at:attempt.startedAt,expires_at:expiresAt});
    }catch(e){next(e)}
  });

  // Exam Smart Security: a visibility change means the student has left the exam
  // page/tab (or minimized/switched away). The browser cannot inspect other apps
  // or the whole device screen, but it can reliably report document visibility.
  app.post("/api/student/exams/:id/security-violation", auth, async(req,res,next)=>{
    try {
      if (req.user?.role !== "student") return res.status(403).json({error:"Student access only."});
      const id=oid(req.params.id);
      const reason=String(req.body?.reason||"exam-page-left").slice(0,120);
      const attempt=await examAttempts.findOne({examId:id,studentId:req.user._id});
      const exam=await exams.findOne({_id:id,published:true});
      if(!attempt || !exam) return res.status(404).json({error:"Exam attempt not found."});
      if(attempt.status==='submitted') return res.status(409).json({error:"This exam has already been submitted."});
      const now=new Date();
      const event={examId:id,studentId:req.user._id,attemptId:attempt._id,reason,createdAt:now,userAgent:smartSafeText(req.headers?.["user-agent"],300),ip:smartClientIp(req),action:"account-locked"};
      await examSecurityEvents.insertOne(event);
      if(!req.user.portalLocked || req.user.lockSource !== "exam-security") {
        await users.updateOne({_id:req.user._id,role:"student"},{$set:{portalLocked:true,lockSource:"exam-security",lockReason:`Exam security violation: ${reason}`,lockedAt:now,examSecurityPending:true,examSecurityExamId:id.toString()}});
      }
      await examAttempts.updateOne({_id:attempt._id},{$set:{status:"locked",securityLockedAt:now,securityLockReason:reason,updatedAt:now}});
      await securityEvents.insertOne({createdAt:now,ip:smartClientIp(req),deviceKey:smartDeviceKey(req,null),method:req.method,path:smartSafeText(req.path||req.originalUrl,300),userAgent:smartSafeText(req.headers?.["user-agent"],300),userId:req.user._id,type:"exam-security-violation",severity:"critical",score:100,action:"student-account-locked",examId:id.toString(),reason});
      res.status(423).json({locked:true,pending_admin_approval:true,error:"Your account has been locked by Exam Smart Security because you left the exam page. It is pending administrator approval."});
    } catch(e){next(e)}
  });

  app.post("/api/student/exams/:id/submit", auth, studentAccess, async(req,res,next)=>{
    try{
      const id=oid(req.params.id), exam=await exams.findOne({_id:id,published:true}); if(!exam)return res.status(404).json({error:"Exam not found."});
      if(!studentHasCourse(req.user,exam.courseId))return res.status(403).json({error:"You are not enrolled in this course."});
      const attempt=await examAttempts.findOne({examId:id,studentId:req.user._id}); if(!attempt)return res.status(400).json({error:"Start the exam first."}); if(attempt.status==='submitted')return res.status(409).json({error:"This exam has already been submitted."});
      const now=new Date(), expiresAt=new Date(new Date(attempt.startedAt).getTime()+Number(exam.durationMinutes||60)*60000); const answers=Array.isArray(req.body.answers)?req.body.answers:[];
      let objectiveScore=0, theoryScore=0; const answerDocs=[];
      (exam.questions||[]).forEach((q,i)=>{const a=answers[i]||{}; if(q.type==='objective'){const selectedRaw=a.selectedIndex; const selected=[0,1,2].includes(Number(selectedRaw))?Number(selectedRaw):null; const correct=selected!==null && selected===Number(q.correctIndex); if(correct)objectiveScore+=Number(q.marks||1); answerDocs.push({selectedIndex:selected});}else{const text=String(a.text||"").trim().slice(0,10000); answerDocs.push({text});}});
      const total=(exam.questions||[]).reduce((n,q)=>n+Number(q.marks||1),0);
      await examAttempts.updateOne({_id:attempt._id},{$set:{answers:answerDocs,objectiveScore,theoryScore,score:objectiveScore+theoryScore,maxScore:total,status:"submitted",submittedAt:now,late:now>expiresAt,updatedAt:now}});
      res.json({ok:true,objective_score:objectiveScore,theory_pending:(exam.questions||[]).filter(q=>q.type==='theory').length,score:objectiveScore,max_score:total,message:"Exam submitted successfully. Theory questions will be marked by the administrator/instructor."});
    }catch(e){next(e)}
  });

  app.get("/api/admin/exam-security", auth, admin, async(req,res,next)=>{
    try {
      const events=await examSecurityEvents.find({}).sort({createdAt:-1}).limit(200).toArray();
      const studentIds=[...new Set(events.map(e=>String(e.studentId)).filter(Boolean))].map(oid).filter(Boolean);
      const examIds=[...new Set(events.map(e=>String(e.examId)).filter(Boolean))].map(oid).filter(Boolean);
      const [students,examDocs]=await Promise.all([
        studentIds.length?users.find({_id:{$in:studentIds}}).project({name:1,email:1,studentIdNumber:1,portalLocked:1,lockSource:1,lockReason:1}).toArray():[],
        examIds.length?exams.find({_id:{$in:examIds}}).project({title:1,courseTitle:1}).toArray():[]
      ]);
      const sm=new Map(students.map(x=>[String(x._id),x])); const em=new Map(examDocs.map(x=>[String(x._id),x]));
      res.json({events:events.map(e=>({id:e._id.toString(),created_at:e.createdAt,reason:e.reason,action:e.action,student_name:sm.get(String(e.studentId))?.name||"Unknown",email:sm.get(String(e.studentId))?.email||"",student_id_number:sm.get(String(e.studentId))?.studentIdNumber||"",portal_locked:!!sm.get(String(e.studentId))?.portalLocked,exam_title:em.get(String(e.examId))?.title||"Unknown exam",course_title:em.get(String(e.examId))?.courseTitle||"",attempt_id:String(e.attemptId||"")}))});
    } catch(e){next(e)}
  });

  app.post("/api/admin/exam-security/:attemptId/unlock", auth, admin, async(req,res,next)=>{
    try {
      const attemptId=oid(req.params.attemptId); if(!attemptId)return res.status(400).json({error:"Invalid attempt id."});
      const attempt=await examAttempts.findOne({_id:attemptId}); if(!attempt)return res.status(404).json({error:"Exam attempt not found."});
      const student=await users.findOne({_id:attempt.studentId,role:"student"}); if(!student)return res.status(404).json({error:"Student not found."});
      const now=new Date();
      await users.updateOne({_id:student._id},{$set:{portalLocked:false,lastActivityAt:now},$unset:{lockSource:"",lockReason:"",lockedAt:"",examSecurityPending:"",examSecurityExamId:""}});
      await examAttempts.updateOne({_id:attempt._id},{$set:{status:"in_progress",securityUnlockedAt:now,securityUnlockedBy:req.user._id,updatedAt:now}});
      await examSecurityEvents.insertOne({examId:attempt.examId,studentId:attempt.studentId,attemptId:attempt._id,reason:"Administrator approved/unlocked account",createdAt:now,action:"admin-unlocked",adminId:req.user._id});
      res.json({ok:true,message:"Student account unlocked and exam attempt restored."});
    } catch(e){next(e)}
  });

  async function resultsForExam(examId, viewer) {
    const exam=await exams.findOne({_id:examId}); if(!exam)return null;
    const filter=viewer.role==='admin'?{examId}:viewer.role==='instructor'?{examId}:{examId,studentId:viewer._id};
    const attempts=await examAttempts.find(filter).sort({submittedAt:-1}).toArray();
    const students=attempts.length?await users.find({_id:{$in:attempts.map(a=>a.studentId)}}).project({name:1,email:1,studentIdNumber:1}).toArray():[]; const sm=new Map(students.map(s=>[String(s._id),s]));
    return {exam:examForClient(exam,false),attempts:attempts.map(a=>({id:a._id.toString(),student_id:a.studentId.toString(),student_name:sm.get(String(a.studentId))?.name||"Student",email:sm.get(String(a.studentId))?.email||"",student_id_number:sm.get(String(a.studentId))?.studentIdNumber||"",answers:a.answers||[],objective_score:Number(a.objectiveScore||0),theory_score:Number(a.theoryScore||0),score:Number(a.score||0),max_score:Number(a.maxScore||0),status:a.status,submitted_at:a.submittedAt||null,late:!!a.late}))};
  }
  app.get("/api/admin/exams/:id/attempts", auth, admin, async(req,res,next)=>{try{const d=await resultsForExam(oid(req.params.id),req.user);if(!d)return res.status(404).json({error:"Exam not found."});res.json(d)}catch(e){next(e)}});
  app.get("/api/instructor/exams/:id/attempts", auth, instructor, async(req,res,next)=>{try{const id=oid(req.params.id),exam=await ownedExamFilter(req.user,id);if(!exam)return res.status(404).json({error:"Exam not found."});const d=await resultsForExam(id,req.user);res.json(d)}catch(e){next(e)}});
  app.get("/api/admin/exams/:id/results", auth, admin, async(req,res,next)=>{try{const d=await resultsForExam(oid(req.params.id),req.user);if(!d)return res.status(404).json({error:"Exam not found."});res.json(d)}catch(e){next(e)}});
  app.get("/api/instructor/exams/:id/results", auth, instructor, async(req,res,next)=>{try{const id=oid(req.params.id),exam=await ownedExamFilter(req.user,id);if(!exam)return res.status(404).json({error:"Exam not found."});res.json(await resultsForExam(id,req.user))}catch(e){next(e)}});
  app.get("/api/student/exams/:id/result", auth, studentAccess, async(req,res,next)=>{try{const id=oid(req.params.id);const d=await resultsForExam(id,req.user);if(!d)return res.status(404).json({error:"Exam not found."});res.json(d)}catch(e){next(e)}});

  async function markTheoryAttempt(req,res,next){
    try{
      const attemptId=oid(req.params.attemptId), attempt=await examAttempts.findOne({_id:attemptId}); if(!attempt)return res.status(404).json({error:"Attempt not found."});
      const exam=await exams.findOne({_id:attempt.examId}); if(!exam)return res.status(404).json({error:"Exam not found."});
      if(req.user.role==='instructor' && !(exam.ownerRole==='instructor'&&String(exam.ownerId)===String(req.user._id)))return res.status(403).json({error:"You can only mark your own course exams."});
      const grades=Array.isArray(req.body.grades)?req.body.grades:[]; let theoryScore=0; const answers=[...(attempt.answers||[])];
      (exam.questions||[]).forEach((q,i)=>{if(q.type!=='theory')return;const g=Number(grades[i]);const max=Number(q.marks||1);const score=Number.isFinite(g)?Math.max(0,Math.min(max,g)):0;theoryScore+=score;answers[i]={...(answers[i]||{}),theoryScore:score};});
      const score=Number(attempt.objectiveScore||0)+theoryScore; await examAttempts.updateOne({_id:attempt._id},{$set:{answers,theoryScore,score,updatedAt:new Date(),markedAt:new Date(),markedBy:req.user._id.toString()}});res.json({ok:true,theory_score:theoryScore,score});
    }catch(e){next(e)}
  }
  app.post("/api/admin/exams/attempts/:attemptId/mark-theory", auth, admin, markTheoryAttempt);
  app.post("/api/instructor/exams/attempts/:attemptId/mark-theory", auth, instructor, markTheoryAttempt);

  // ===================== CERTIFICATE REQUESTS =====================
  function cleanCertificateRequest(body){
    const email=String(body.email||"").trim().toLowerCase().slice(0,254), name=String(body.name||"").trim().replace(/\s+/g," ").slice(0,160), course=String(body.course||"").trim().slice(0,160), idNumber=String(body.idNumber||"").trim().toUpperCase().slice(0,60);
    if(!/^\S+@\S+\.\S+$/.test(email)||!name||!course||!idNumber) throw Object.assign(new Error("Email, name, course and ID number are required."),{status:400});
    return {email,name,course,idNumber};
  }
  app.post("/api/certificate-requests", auth, async(req,res,next)=>{try{if(req.user.role!=='student'&&req.user.role!=='admin')return res.status(403).json({error:"Only students and administrators can submit certificate requests."});const data=cleanCertificateRequest(req.body);const doc={...data,studentId:req.user.role==='student'?req.user._id:null,submittedByRole:req.user.role,status:"pending",createdAt:new Date(),updatedAt:new Date()};const r=await certificateRequests.insertOne(doc);res.json({ok:true,id:r.insertedId.toString(),message:"Certificate request submitted to the administrator."});}catch(e){next(e)}});
  app.get("/api/admin/certificate-requests", auth, admin, async(req,res,next)=>{try{const rows=await certificateRequests.find({}).sort({createdAt:-1}).limit(500).toArray();res.json({requests:rows.map(r=>({id:r._id.toString(),email:r.email,name:r.name,course:r.course,id_number:r.idNumber,status:r.status,created_at:r.createdAt,submitted_by_role:r.submittedByRole}))})}catch(e){next(e)}});
  app.post("/api/admin/certificate-requests/:id/status", auth, admin, async(req,res,next)=>{try{const id=oid(req.params.id),status=["pending","approved","issued","rejected"].includes(String(req.body.status))?String(req.body.status):"pending";if(!id)return res.status(400).json({error:"Invalid request."});await certificateRequests.updateOne({_id:id},{$set:{status,updatedAt:new Date(),reviewedBy:req.user._id.toString()}});res.json({ok:true,status});}catch(e){next(e)}});
  app.get("/api/instructor/certificate-requests", auth, instructor, async(req,res,next)=>{try{const rows=await certificateRequests.find({}).sort({createdAt:-1}).limit(500).toArray();res.json({requests:rows.map(r=>({id:r._id.toString(),email:r.email,name:r.name,course:r.course,id_number:r.idNumber,status:r.status,created_at:r.createdAt}))})}catch(e){next(e)}});

  app.get("/api/instructor/attendance", auth, instructor, async (req,res,next)=>{
    try {
      const owned = await courseCollection.find({ownerInstructorId:req.user._id.toString()}).sort({title:1}).toArray();
      const result=[];
      for(const course of owned){
        const students=await users.find({role:"student",enrolledCourseIds:course._id.toString(),approved:true}).project({name:1,email:1,registrationDate:1,createdAt:1}).sort({name:1}).toArray();
        const rows=[];
        for(const student of students){
          const enrollment=await ensureEnrollment(student._id,course._id,student.registrationDate || (student.createdAt ? lagosDateString(student.createdAt):lagosDateString()));
          const schedule=attendanceSchedule(enrollment,course);
          const marks=await attendanceRecords.find({studentId:student._id,courseId:course._id,date:{$in:schedule}}).toArray();
          const marked=new Set(marks.map(x=>x.date));
          rows.push({student_id:student._id.toString(),student_name:student.name||"Student",email:student.email||"",enrollment_date:enrollment?.enrolledAtDate||schedule[0]||"",marked_count:marks.length,total_days:schedule.length,today_marked:marked.has(lagosDateString())});
        }
        result.push({course_id:course._id.toString(),course_title:course.title,duration_weeks:courseDurationPayload(course),students:rows});
      }
      res.json({today:lagosDateString(),courses:result});
    } catch(e){next(e);}
  });

  app.get("/api/instructor/submissions", auth, instructor, async (req,res,next)=>{
    try{
      const courses=await courseCollection.find({ownerInstructorId:req.user._id.toString()}).project({_id:1}).toArray();
      const courseIds=courses.map(c=>c._id);
      const list=await submissions.find({}).sort({submittedAt:-1}).toArray();
      const result=[];
      for(const sub of list){
        const a=await assignments.findOne({_id:sub.assignmentId});
        if(!a || !a.courseId || !courseIds.some(id=>String(id)===String(a.courseId))) continue;
        const u=await users.findOne({_id:sub.studentId});
        result.push({id:sub._id.toString(),assignment_title:a.title,course_title:(await courseCollection.findOne({_id:a.courseId}))?.title||"Unknown",student_name:u?.name||"Unknown",email:u?.email||"",file_path:sub.file?.url?`/api/instructor/submissions/${sub._id}/file`:"",file_name:sub.file?.originalName||"",grade:sub.grade||"",feedback:sub.feedback||""});
      }
      res.json({submissions:result});
    }catch(e){next(e)}
  });

  app.get("/api/instructor/submissions/:id/file", auth, instructor, async (req,res,next)=>{
    try{
      const id=oid(req.params.id); const sub=id?await submissions.findOne({_id:id}):null;
      const a=sub?await assignments.findOne({_id:sub.assignmentId}):null;
      if(!sub||!a||!a.courseId||!(await instructorOwnsCourse(req.user,a.courseId))) return res.status(404).json({error:"Submission not found."});
      if(!sub.file?.url) return res.status(404).json({error:"Submission file not found."});
      const upstream=await fetch(sub.file.url,{redirect:"follow"});
      if(!upstream.ok||!upstream.body) return res.status(502).json({error:"Could not load submission file."});
      res.set("Content-Disposition",`attachment; filename="${String(sub.file.originalName||"submission").replace(/["\r\n]/g,"_")}"`);
      res.type(sub.file.mimeType||"application/octet-stream"); Readable.fromWeb(upstream.body).pipe(res);
    }catch(e){next(e)}
  });

  app.post("/api/instructor/submissions/:id/grade", auth, instructor, async(req,res,next)=>{
    try{
      const id=oid(req.params.id); const grade=String(req.body.grade||"").trim().slice(0,50); const feedback=String(req.body.feedback||"").trim().slice(0,3000);
      const sub=id?await submissions.findOne({_id:id}):null; const a=sub?await assignments.findOne({_id:sub.assignmentId}):null;
      if(!sub||!a||!a.courseId||!(await instructorOwnsCourse(req.user,a.courseId))) return res.status(404).json({error:"Submission not found."});
      await submissions.updateOne({_id:id},{$set:{grade,feedback,gradedAt:new Date(),gradedBy:req.user._id.toString()}});
      res.json({ok:true});
    }catch(e){next(e)}
  });

  // Admin review and control of instructor applications/accounts.
  app.get("/api/admin/instructor-applications", auth, admin, async(req,res,next)=>{
    try {
      // This endpoint is deliberately uncached because the administrator expects a
      // newly submitted application to appear immediately after pressing Refresh.
      res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.set("Pragma", "no-cache");
      res.set("Expires", "0");

      const merged = new Map();
      const put = (raw, fallbackUser = null) => {
        const n = normalizeInstructorApplication(raw);
        if (!n) return;
        const userId = n.userId ? String(n.userId) : (fallbackUser ? String(fallbackUser._id) : "");
        if (!userId) return;
        const candidate = {
          id: n.id || `user-${userId}`,
          user_id: userId,
          name: n.name || fallbackUser?.name || "Unknown applicant",
          email: n.email || fallbackUser?.email || "",
          teaching_topics: n.teachingTopics || "",
          message: n.message || "",
          status: n.status || "pending",
          created_at: n.createdAt || n.updatedAt || new Date(),
          updated_at: n.updatedAt || n.createdAt || new Date()
        };
        const current = merged.get(userId);
        if (!current || new Date(candidate.updated_at || 0) >= new Date(current.updated_at || 0)) {
          merged.set(userId, candidate);
        }
      };

      // Source 1: embedded application on the user. This is the authoritative source
      // and is intentionally read BEFORE the legacy mirror collection.
      const usersWithApps = await users.find({
        $or: [
          {instructorApplication:{$exists:true}},
          {instructor_application:{$exists:true}},
          {instructorApplicationData:{$exists:true}}
        ]
      }).project({_id:1,instructorApplication:1,instructor_application:1,instructorApplicationData:1,name:1,email:1,role:1,instructorApproved:1,instructorSuspended:1}).limit(1000).toArray();
      for (const u of usersWithApps) {
        const app = getUserInstructorApplication(u);
        if (app) put(app, u);
      }

      // Source 2: legacy mirror, bounded so it can never hold the admin request hostage.
      try {
        const apps = await instructorApplications.find({}).sort({updatedAt:-1,createdAt:-1}).limit(1000).maxTimeMS(1500).toArray();
        for (const app of apps) put(app);
        const unresolved = apps.map(normalizeInstructorApplication).filter(a => a && !a.userId && a.email);
        if (unresolved.length) {
          const emails = [...new Set(unresolved.map(a => String(a.email).toLowerCase()).filter(Boolean))];
          const legacyUsers = await users.find({email:{$in:emails}}).project({_id:1,name:1,email:1}).maxTimeMS(1500).toArray();
          const byEmail = new Map(legacyUsers.map(u => [String(u.email || "").toLowerCase(), u]));
          for (const n of unresolved) put(n, byEmail.get(String(n.email || "").toLowerCase()));
        }
      } catch (collectionError) {
        console.warn("Instructor application mirror read skipped:", collectionError?.message || collectionError);
      }

      const applications = [...merged.values()].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
      res.json({ok:true,pending_count:applications.filter(a=>String(a.status).toLowerCase()==='pending').length,applications});
    } catch(e){next(e);}
  });

  app.get("/api/admin/instructors", auth, admin, async(req,res,next)=>{
    try{
      // Keep this endpoint compatible with both the dedicated application collection
      // and the embedded user-document source of truth used by new submissions.
      const merged = new Map();
      const put = (raw, fallbackUser = null) => {
        const n = normalizeInstructorApplication(raw);
        if (!n) return;
        const userId = n.userId ? String(n.userId) : (fallbackUser ? String(fallbackUser._id) : "");
        if (!userId) return;
        const row = {
          id: n.id || `user-${userId}`,
          user_id: userId,
          name: n.name || fallbackUser?.name || "Unknown applicant",
          email: n.email || fallbackUser?.email || "",
          teaching_topics: n.teachingTopics || "",
          message: n.message || "",
          status: n.status || "pending",
          created_at: n.createdAt || n.updatedAt || new Date(),
          updated_at: n.updatedAt || n.createdAt || new Date()
        };
        const current = merged.get(userId);
        if (!current || new Date(row.updated_at || 0) >= new Date(current.updated_at || 0)) merged.set(userId, row);
      };

      const usersWithApps = await users.find({
        $or: [
          {instructorApplication:{$exists:true}},
          {instructor_application:{$exists:true}},
          {instructorApplicationData:{$exists:true}}
        ]
      }).project({_id:1,instructorApplication:1,instructor_application:1,instructorApplicationData:1,name:1,email:1}).limit(1000).toArray();
      for (const u of usersWithApps) put(getUserInstructorApplication(u), u);
      try {
        const apps = await instructorApplications.find({}).sort({updatedAt:-1,createdAt:-1}).limit(1000).maxTimeMS(1500).toArray();
        for (const app of apps) put(app);
      } catch (collectionError) {
        console.warn("Instructor application mirror read skipped:", collectionError?.message || collectionError);
      }

      const applications = [...merged.values()].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
      const usersList = await users.find({ role: "instructor" }).project({ passwordHash: 0 }).toArray();
      const courseCounts = await courseCollection.aggregate([
        {$match:{ownerInstructorId:{$exists:true,$ne:null}}},
        {$group:{_id:"$ownerInstructorId",count:{$sum:1}}}
      ]).toArray();
      const countMap = new Map(courseCounts.map(x=>[String(x._id),Number(x.count)]));
      res.json({
        ok:true,
        pending_count:applications.filter(a=>String(a.status).toLowerCase()==='pending').length,
        applications,
        instructors:usersList.map(u=>({
          id:u._id.toString(),name:u.name,email:u.email,
          suspended:!!u.instructorSuspended,
          approved:u.instructorApproved!==false,
          instructor_id_number:u.instructorIdNumber || "",
          registration_date:u.instructorRegistrationDate || (u.createdAt ? new Date(u.createdAt).toISOString().slice(0,10) : ""),
          expiry_date:u.instructorExpiryDate || "",
          department:u.instructorDepartment || "",
          profile_picture_url:u.profilePicture ? `/api/admin/profile-picture/${u._id.toString()}` : null,
          course_count:countMap.get(String(u._id))||0
        }))
      });
    }catch(e){next(e)}
  });

  app.post("/api/admin/instructors/:id/decision", auth, admin, async(req,res,next)=>{
    try{
      const id=oid(req.params.id); const action=String(req.body.action||"");
      const user=id?await users.findOne({_id:id}):null;
      if(!user) return res.status(404).json({error:"Instructor applicant not found."});
      if(!["approve","reject","suspend","unsuspend"].includes(action)) return res.status(400).json({error:"Invalid action."});
      const userIdString = String(id);
      if(action==="approve"){
        const reviewedAt = new Date();
        const instructorIdNumber = user.instructorIdNumber || await generateInstructorIdNumber();
        const instructorRegistrationDate = user.instructorRegistrationDate || (user.createdAt ? new Date(user.createdAt).toISOString().slice(0,10) : new Date().toISOString().slice(0,10));
        await users.updateOne({_id:id},{$set:{role:"instructor",instructorApproved:true,instructorSuspended:false,approved:true,instructorIdNumber,instructorRegistrationDate,"instructorApplication.status":"approved","instructorApplication.reviewedAt":reviewedAt,"instructorApplication.reviewedBy":req.user._id.toString()}});
        try { await instructorApplications.updateOne(
          {$or:[{userId:id},{userIdString}]},
          {$set:{userId:id,userIdString,status:"approved",reviewedAt,reviewedBy:req.user._id.toString()}},
          {upsert:true,maxTimeMS:1500}
        ); } catch (mirrorError) { console.warn("Instructor approval mirror skipped:", mirrorError?.message || mirrorError); }
      } else if(action==="reject"){
        const reviewedAt = new Date();
        await users.updateOne({_id:id},{$set:{instructorApproved:false,instructorSuspended:true,"instructorApplication.status":"rejected","instructorApplication.reviewedAt":reviewedAt,"instructorApplication.reviewedBy":req.user._id.toString()}});
        try { await instructorApplications.updateOne(
          {$or:[{userId:id},{userIdString}]},
          {$set:{userId:id,userIdString,status:"rejected",reviewedAt,reviewedBy:req.user._id.toString()}},
          {upsert:true,maxTimeMS:1500}
        ); } catch (mirrorError) { console.warn("Instructor rejection mirror skipped:", mirrorError?.message || mirrorError); }
      } else if(action==="suspend"){
        if(user.role!=="instructor") return res.status(400).json({error:"Only active instructors can be suspended."});
        await users.updateOne({_id:id},{$set:{instructorSuspended:true}});
      } else {
        await users.updateOne({_id:id},{$set:{instructorSuspended:false,instructorApproved:true}});
      }
      res.json({ok:true});
    }catch(e){next(e)}
  });

  app.post("/api/admin/instructors/:id/identity", auth, admin, async(req,res,next)=>{
    try {
      const id=oid(req.params.id);
      if(!id) return res.status(400).json({error:"Invalid instructor id."});
      const user=await users.findOne({_id:id,role:"instructor"});
      if(!user) return res.status(404).json({error:"Instructor not found."});
      const identity=cleanInstructorIdentity(req.body);
      const instructorIdNumber=identity.instructorIdNumber || user.instructorIdNumber || await generateInstructorIdNumber();
      const duplicate=await users.findOne({instructorIdNumber,_id:{$ne:id}},{projection:{_id:1}});
      if(duplicate) return res.status(409).json({error:"That instructor ID number is already assigned to another instructor."});
      const registrationDate=identity.registrationDate || user.instructorRegistrationDate || (user.createdAt ? new Date(user.createdAt).toISOString().slice(0,10) : new Date().toISOString().slice(0,10));
      await users.updateOne({_id:id},{$set:{instructorIdNumber,instructorRegistrationDate:registrationDate,instructorExpiryDate:identity.expiryDate,instructorDepartment:identity.department}});
      res.json({ok:true,instructor_id_number:instructorIdNumber});
    } catch(e){next(e)}
  });

  // Smart Security administration. Every override is itself audited.
  app.get("/api/admin/instructor-security", auth, admin, async (req,res,next)=>{
    try {
      const alerts=await instructorSecurityAlerts.find({}).sort({status:1,createdAt:-1}).limit(200).toArray();
      const events=await instructorSecurityEvents.find({}).sort({createdAt:-1}).limit(200).toArray();
      res.json({alerts:alerts.map(a=>({id:a._id.toString(),instructor_id:a.instructorId?.toString(),name:a.instructorName,email:a.instructorEmail,created_at:a.createdAt,status:a.status,severity:a.severity,reason:a.reason,metrics:a.metrics||{}})),events:events.map(e=>({id:e._id.toString(),instructor_id:e.instructorId?.toString(),name:e.instructorName,email:e.instructorEmail,created_at:e.createdAt,method:e.method,path:e.path,status_code:e.statusCode,ip:e.ip,unauthorized:!!e.unauthorized,destructive:!!e.destructive}))});
    } catch(e){next(e)}
  });

  app.post("/api/admin/instructor-security/:id/decision", auth, admin, async(req,res,next)=>{
    try {
      const alertId=oid(req.params.id); const action=String(req.body.action||"");
      if(!alertId || !["resolve","suspend","restore"].includes(action)) return res.status(400).json({error:"Invalid security action."});
      const alert=await instructorSecurityAlerts.findOne({_id:alertId}); if(!alert) return res.status(404).json({error:"Security alert not found."});
      const instructorId=alert.instructorId;
      if(action==="suspend") await users.updateOne({_id:instructorId,role:"instructor"},{$set:{instructorSuspended:true,instructorSuspensionSource:"admin-security",instructorSuspensionReason:"Suspended after Smart Security review",instructorSuspendedAt:new Date()}});
      if(action==="restore") await users.updateOne({_id:instructorId,role:"instructor"},{$set:{instructorSuspended:false,instructorApproved:true},$unset:{instructorSuspensionSource:"",instructorSuspensionReason:"",instructorSuspendedAt:""}});
      await instructorSecurityAlerts.updateOne({_id:alertId},{$set:{status:action==="resolve"?"resolved":action,reviewedAt:new Date(),reviewedBy:req.user._id.toString()}});
      await smartRecord(req,{type:"instructor-security-admin-action",severity:"medium",score:50,action, statusCode:200});
      res.json({ok:true});
    } catch(e){next(e)}
  });

  function cleanAdText(v, max = 180) { return smartSafeText(String(v || "").trim(), max); }
  function validAdUrl(v) {
    try { const u = new URL(String(v || "").trim()); return ["https:", "http:"].includes(u.protocol) ? u.toString() : null; } catch (_) { return null; }
  }
  function validPlacement(v) { return ["topBanner","dashboardBanner","contentBanner","footerBanner"].includes(String(v)); }
  function adDate(v) { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d : null; }
  function adIsLive(ad, now = new Date()) {
    if (!ad?.active) return false;
    if (ad.startAt && new Date(ad.startAt) > now) return false;
    if (ad.endAt && new Date(ad.endAt) < now) return false;
    return true;
  }
  function publicAdRow(ad) {
    return { id: String(ad._id), type: ad.type === "network" ? "network" : "direct", placement: ad.placement, title: ad.title || "", imageUrl: ad.imageUrl || "", clickUrl: `/api/ads/${ad._id}/click`, alt: ad.alt || ad.title || "Advertisement", priority: Number(ad.priority || 0), network: ad.network || "", slot: ad.slot || "", publisherId: ad.publisherId || "" };
  }
  async function recordAdEvent(req, ad, type) {
    try { await adEvents.insertOne({ adId: ad._id, type, createdAt: new Date(), ip: smartClientIp(req), userId: req.user?._id || null, userAgent: smartSafeText(req.headers?.["user-agent"], 300) }); } catch (_) {}
  }

  // SMARTTEP ACADEMY admin announcements. Announcements are server-targeted by role,
  // time-bounded, and can optionally be shown once per user or again at every login.
  function cleanAnnouncementText(v, max) { return smartSafeText(String(v || "").replace(/\u0000/g, "").trim(), max); }
  function announcementDate(v) { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d : null; }
  function announcementIsLive(a, now = new Date()) {
    if (!a?.active) return false;
    if (a.startAt && new Date(a.startAt) > now) return false;
    if (a.endAt && new Date(a.endAt) < now) return false;
    return true;
  }
  function publicAnnouncementRow(a) {
    return { id: String(a._id), title: a.title || "", message: a.message || "", imageUrl: a.imageUrl || "", imageAlt: a.imageAlt || "Announcement", audience: a.audience, priority: Number(a.priority || 0), displayMode: a.displayMode === "once" ? "once" : "every_login", startAt: a.startAt || null, endAt: a.endAt || null };
  }

  app.get("/api/announcements/active", auth, async (req, res, next) => {
    try {
      if (!req.user || !["student", "instructor"].includes(req.user.role)) return res.json({ announcements: [] });
      const now = new Date();
      const audienceFilter = { $in: ["all", req.user.role] };
      const rows = await announcements.find({ active: true, audience: audienceFilter, $or: [{ startAt: null }, { startAt: { $lte: now } }], $and: [{ $or: [{ endAt: null }, { endAt: { $gte: now } }] }] }).sort({ priority: -1, createdAt: -1 }).limit(20).toArray();
      const live = rows.filter(a => announcementIsLive(a, now));
      const onceIds = live.filter(a => a.displayMode === "once").map(a => a._id);
      let acknowledged = new Set();
      if (onceIds.length) {
        const reads = await announcementReads.find({ announcementId: { $in: onceIds }, userId: req.user._id }).project({ announcementId: 1 }).toArray();
        acknowledged = new Set(reads.map(r => String(r.announcementId)));
      }
      res.set("Cache-Control", "no-store, no-cache, must-revalidate");
      res.json({ announcements: live.filter(a => a.displayMode !== "once" || !acknowledged.has(String(a._id))).map(publicAnnouncementRow) });
    } catch (e) { next(e); }
  });

  app.post("/api/announcements/:id/acknowledge", auth, rateLimit({ windowMs: 10 * 60 * 1000, max: 60, keyPrefix: "announcement-ack", by: "device" }), async (req, res, next) => {
    try {
      if (!req.user || !["student", "instructor"].includes(req.user.role)) return res.status(403).json({ error: "Announcement acknowledgement is only available to students and instructors." });
      const id = oid(req.params.id); if (!id) return res.status(400).json({ error: "Invalid announcement." });
      const a = await announcements.findOne({ _id: id, active: true, audience: { $in: ["all", req.user.role] } });
      if (!a || !announcementIsLive(a)) return res.status(404).json({ error: "Announcement is no longer active." });
      await announcementReads.updateOne({ announcementId: id, userId: req.user._id }, { $set: { acknowledgedAt: new Date(), userRole: req.user.role } }, { upsert: true });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.get("/api/admin/announcements", auth, admin, async (req, res, next) => {
    try {
      const rows = await announcements.find({}).sort({ active: -1, priority: -1, createdAt: -1 }).limit(300).toArray();
      res.json({ announcements: rows.map(a => ({ ...publicAnnouncementRow(a), active: !!a.active, createdAt: a.createdAt || null, updatedAt: a.updatedAt || null })) });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/announcements", auth, admin, announcementUpload.single("image"), async (req, res, next) => {
    try {
      const title = cleanAnnouncementText(req.body?.title, 160);
      const message = cleanAnnouncementText(req.body?.message, 10000);
      const audience = ["all", "student", "instructor"].includes(String(req.body?.audience)) ? String(req.body.audience) : "all";
      const displayMode = req.body?.displayMode === "once" ? "once" : "every_login";
      const priority = Math.max(0, Math.min(100, Number(req.body?.priority || 0)));
      const startAt = announcementDate(req.body?.startAt);
      const endAt = announcementDate(req.body?.endAt);
      const imageAlt = cleanAnnouncementText(req.body?.imageAlt || title, 180) || "SMARTTEP ACADEMY announcement";
      if (!title || !message) return res.status(400).json({ error: "Title and message are required." });
      if (message.length < 3) return res.status(400).json({ error: "Announcement message is too short." });
      if (startAt && endAt && endAt < startAt) return res.status(400).json({ error: "End date/time must be after the start date/time." });
      let image = null;
      if (req.file) {
        const ext = path.extname(req.file.originalname || "").toLowerCase();
        const mime = String(req.file.mimetype || "").toLowerCase();
        if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext) || !["image/jpeg", "image/png", "image/webp"].includes(mime)) return res.status(400).json({ error: "Announcement picture must be a JPG, PNG, or WEBP image." });
        if (req.file.size > 8 * 1024 * 1024) return res.status(413).json({ error: "Announcement picture must be 8 MB or smaller." });
        const uploaded = await uploadBuffer(req.file.buffer, req.file.originalname, "announcements", "image");
        image = { url: uploaded.secure_url || uploaded.url, publicId: uploaded.public_id, resourceType: uploaded.resource_type || "image", originalName: req.file.originalname };
      }
      const doc = { title, message, audience, displayMode, priority, startAt, endAt, active: req.body?.active !== "false", imageUrl: image?.url || "", imageAlt, asset: image, createdAt: new Date(), updatedAt: new Date(), createdBy: req.user._id };
      const result = await announcements.insertOne(doc);
      await smartRecord(req, { type: "announcement-created", severity: "info", score: 0, action: "created", target: audience });
      res.json({ ok: true, id: String(result.insertedId) });
    } catch (e) { next(e); }
  });

  app.patch("/api/admin/announcements/:id", auth, admin, async (req, res, next) => {
    try {
      const id = oid(req.params.id); if (!id) return res.status(400).json({ error: "Invalid announcement." });
      const a = await announcements.findOne({ _id: id }); if (!a) return res.status(404).json({ error: "Announcement not found." });
      const set = { updatedAt: new Date() };
      if (req.body?.active !== undefined) set.active = req.body.active === true;
      if (req.body?.priority !== undefined) set.priority = Math.max(0, Math.min(100, Number(req.body.priority || 0)));
      await announcements.updateOne({ _id: id }, { $set: set });
      await smartRecord(req, { type: "announcement-updated", severity: "info", score: 0, action: "updated", target: String(id) });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.delete("/api/admin/announcements/:id", auth, admin, async (req, res, next) => {
    try {
      const id = oid(req.params.id); if (!id) return res.status(400).json({ error: "Invalid announcement." });
      const a = await announcements.findOne({ _id: id }); if (!a) return res.status(404).json({ error: "Announcement not found." });
      if (a.asset?.publicId) { try { await cloudinary.uploader.destroy(a.asset.publicId, { resource_type: a.asset.resourceType || "image" }); } catch (_) {} }
      await announcements.deleteOne({ _id: id });
      await announcementReads.deleteMany({ announcementId: id });
      await smartRecord(req, { type: "announcement-deleted", severity: "medium", score: 20, action: "deleted", target: String(id) });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Public trust, contact and crawler endpoints for AdSense/site review.
  app.get("/api/public/contact-info", rateLimit({ windowMs: 10 * 60 * 1000, max: 30, keyPrefix: "public-contact-info" }), (req, res) => {
    const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    res.json({ email: email && /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) ? email : null });
  });

  app.post("/api/public/contact", rateLimit({ windowMs: 10 * 60 * 1000, max: 5, keyPrefix: "public-contact" }), async (req, res, next) => {
    try {
      const name = smartSafeText(req.body?.name || "", 100).trim();
      const email = smartSafeText(req.body?.email || "", 160).trim().toLowerCase();
      const message = smartSafeText(req.body?.message || "", 3000).trim();
      if (!name || !email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) || !message) return res.status(400).json({ error: "Please provide a valid name, email and message." });
      if (message.length < 10) return res.status(400).json({ error: "Please provide a little more detail in your message." });
      await contactMessages.insertOne({ name, email, message, status: "new", createdAt: new Date(), ip: smartClientIp(req), userAgent: smartSafeText(req.headers?.["user-agent"], 300) });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.get("/sitemap.xml", (req, res) => {
    const base = `${req.protocol}://${req.get("host")}`;
    const pages = ["/", "/about.html", "/contact.html", "/privacy.html", "/terms.html", "/advertising.html", "/verify-student.html", "/verify-instructor.html", "/instructor-apply.html"];
    const body = pages.map(p => `<url><loc>${base}${p}</loc></url>`).join("");
    res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`);
  });

  app.get("/ads.txt", async (req, res, next) => {
    try {
      const cfg = await appSettings.findOne({ _id: "advertising" }) || {};
      const publisherId = String(cfg.publisherId || DEFAULT_ADSENSE_PUBLISHER_ID).trim();
      res.type("text/plain").send(publisherId && /^ca-pub-[0-9]{6,30}$/.test(publisherId) ? `google.com, ${publisherId.replace(/^ca-/, "")}, DIRECT, f08c47fec0942fa0\
` : "# SMARTTEP ACADEMY ads.txt\
# Add and save the Google AdSense publisher ID in Admin > Advertising after your AdSense account provides it.\
");
    } catch (e) { next(e); }
  });

  app.get("/api/admin/contact-messages", auth, admin, async (req, res, next) => {
    try {
      const rows = await contactMessages.find({}).sort({ createdAt: -1 }).limit(200).toArray();
      res.json({ messages: rows.map(m => ({ id: String(m._id), name: m.name, email: m.email, message: m.message, status: m.status, createdAt: m.createdAt })) });
    } catch (e) { next(e); }
  });

  app.patch("/api/admin/contact-messages/:id", auth, admin, async (req, res, next) => {
    try {
      const id = oid(req.params.id); if (!id) return res.status(400).json({ error: "Invalid message." });
      const status = ["new", "read", "resolved"].includes(String(req.body?.status)) ? String(req.body.status) : null;
      if (!status) return res.status(400).json({ error: "Invalid status." });
      await contactMessages.updateOne({ _id: id }, { $set: { status, updatedAt: new Date() } });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.get("/api/ads", async (req, res, next) => {
    try {
      const placement = validPlacement(req.query.placement) ? String(req.query.placement) : "topBanner";
      const now = new Date();
      const directRows = await advertisements.find({ type: "direct", placement, active: true, $or: [{ startAt: { $exists: false } }, { startAt: null }, { startAt: { $lte: now } }], $and: [{ $or: [{ endAt: { $exists: false } }, { endAt: null }, { endAt: { $gte: now } }] }] }).sort({ priority: -1, createdAt: -1 }).limit(10).toArray();
      const direct = directRows.filter(ad => {
        const imageOk = !!validAdUrl(ad.imageUrl);
        const datesOk = (!ad.startAt || !ad.endAt || new Date(ad.endAt) >= new Date(ad.startAt));
        return imageOk && datesOk;
      }).slice(0, 5);
      if (direct.length) { res.set("Cache-Control", "no-store, no-cache, must-revalidate"); return res.json({ ads: direct.map(publicAdRow), mode: "direct" }); }
      const cfg = await appSettings.findOne({ _id: "advertising" }) || {};
      if (cfg.enabled && cfg.network === "adsense" && cfg.publisherId) {
        const slot = cfg.defaultSlots?.[placement] || "";
        return res.json({ ads: [{ id: "network", type: "network", placement, network: "adsense", publisherId: cfg.publisherId, slot }], mode: "network" });
      }
      res.set("Cache-Control", "no-store, no-cache, must-revalidate");
      res.json({ ads: [], mode: "none" });
    } catch (e) { next(e); }
  });

  app.post("/api/ads/:id/impression", rateLimit({ windowMs: 60 * 1000, max: 60, keyPrefix: "ad-impression", by: "device" }), async (req, res, next) => {
    try { const id = oid(req.params.id); if (!id) return res.status(400).json({ error: "Invalid ad." }); const ad = await advertisements.findOne({ _id: id, type: "direct", active: true }); if (!ad || !adIsLive(ad)) return res.status(404).end(); await recordAdEvent(req, ad, "impression"); res.json({ ok: true }); } catch(e){ next(e); }
  });

  app.get("/api/ads/:id/click", rateLimit({ windowMs: 60 * 1000, max: 30, keyPrefix: "ad-click", by: "device" }), async (req, res, next) => {
    try { const id = oid(req.params.id); if (!id) return res.status(400).send("Invalid ad."); const ad = await advertisements.findOne({ _id: id, type: "direct", active: true }); if (!ad || !adIsLive(ad)) return res.status(404).send("Advertisement unavailable."); await recordAdEvent(req, ad, "click"); const target = validAdUrl(ad.destinationUrl); if (!target) return res.status(404).send("Advertisement destination unavailable."); res.redirect(302, target); } catch(e){ next(e); }
  });

  app.get("/api/admin/advertising", auth, admin, async (req, res, next) => {
    try {
      const cfg = await appSettings.findOne({ _id: "advertising" }) || { enabled:false, network:"adsense", publisherId:"", defaultSlots:{} };
      const ads = await advertisements.find({}).sort({ priority:-1, createdAt:-1 }).limit(200).toArray();
      const ids = ads.map(a=>a._id);
      const stats = ids.length ? await adEvents.aggregate([{ $match:{ adId:{ $in:ids } } },{ $group:{ _id:{ adId:"$adId", type:"$type" }, count:{ $sum:1 } } }]).toArray() : [];
      const statMap = new Map(stats.map(x=>[`${x._id.adId}:${x._id.type}`,x.count]));
      res.json({ config:cfg, ads:ads.map(a=>({id:String(a._id),type:a.type,placement:a.placement,title:a.title||"",advertiserName:a.advertiserName||"",imageUrl:a.imageUrl||"",destinationUrl:a.destinationUrl||"",alt:a.alt||"",priority:Number(a.priority||0),active:!!a.active,startAt:a.startAt||null,endAt:a.endAt||null,network:a.network||"",slot:a.slot||"",publisherId:a.publisherId||"",impressions:statMap.get(`${a._id}:impression`)||0,clicks:statMap.get(`${a._id}:click`)||0,createdAt:a.createdAt})) });
    } catch(e){ next(e); }
  });

  app.post("/api/admin/advertising/settings", auth, admin, async (req,res,next)=>{
    try { const b=req.body||{}; const publisherId=cleanAdText(b.publisherId,100); if(publisherId && !/^ca-pub-[0-9]{6,30}$/.test(publisherId)) return res.status(400).json({error:"Enter a valid Google AdSense publisher ID such as ca-pub-1234567890."}); const defaultSlots={topBanner:cleanAdText(b.topBanner,80),dashboardBanner:cleanAdText(b.dashboardBanner,80),contentBanner:cleanAdText(b.contentBanner,80),footerBanner:cleanAdText(b.footerBanner,80)}; await appSettings.updateOne({_id:"advertising"},{$set:{enabled:b.enabled===true,network:"adsense",publisherId,defaultSlots,updatedAt:new Date()}}, {upsert:true}); await smartRecord(req,{type:"advertising-settings-changed",severity:"info",score:0,action:"updated"}); res.json({ok:true}); } catch(e){next(e);}
  });

  app.post("/api/admin/advertising", auth, admin, upload.single("banner"), async(req,res,next)=>{
    try {
      const b=req.body||{}; const type=b.type==="network"?"network":"direct"; const placement=validPlacement(b.placement)?b.placement:null; if(!placement)return res.status(400).json({error:"Invalid ad placement."});
      const title=cleanAdText(b.title,160), advertiserName=cleanAdText(b.advertiserName,160), alt=cleanAdText(b.alt||title,180); if(!title)return res.status(400).json({error:"Ad title is required."});
      const destinationUrl=type==="direct"?validAdUrl(b.destinationUrl):null; if(type==="direct" && !destinationUrl)return res.status(400).json({error:"Direct ads require a valid HTTP/HTTPS destination URL."});
      const parsedStart=adDate(b.startAt), parsedEnd=adDate(b.endAt);
      if(parsedStart && parsedEnd && parsedEnd < parsedStart)return res.status(400).json({error:"Advertisement end date/time must be after the start date/time."});
      let imageUrl=validAdUrl(b.imageUrl); let asset=null;
      if(req.file){ const ext=path.extname(req.file.originalname||"").toLowerCase(); if(![".jpg",".jpeg",".png",".webp"].includes(ext) || !/^image\/(jpeg|png|webp)$/.test(String(req.file.mimetype||""))) return res.status(400).json({error:"Banner must be JPG, PNG or WebP."}); asset=await uploadBuffer(req.file.buffer,req.file.originalname,"advertisements","image"); imageUrl=asset.secure_url||asset.url; }
      if(type==="direct" && !imageUrl)return res.status(400).json({error:"Direct ads require a banner image upload or image URL."});
      const publisherId=cleanAdText(b.publisherId,100), slot=cleanAdText(b.slot,80); if(type==="network" && (!publisherId || !/^ca-pub-[0-9]{6,30}$/.test(publisherId))) return res.status(400).json({error:"Network ads require a valid AdSense publisher ID."});
      const doc={type,placement,title,advertiserName,imageUrl:imageUrl||"",destinationUrl:destinationUrl||"",alt,priority:Math.max(0,Math.min(100,Number(b.priority||0))),active:b.active!=="false",startAt:parsedStart,endAt:parsedEnd,scheduleVersion:2,scheduleTimezone:"UTC",network:type==="network"?"adsense":"",slot:type==="network"?slot:"",publisherId:type==="network"?publisherId:"",asset:asset?{publicId:asset.public_id,resourceType:asset.resource_type}:null,createdAt:new Date(),updatedAt:new Date()};
      const r=await advertisements.insertOne(doc); await smartRecord(req,{type:"advertisement-created",severity:"info",score:0,action:type}); res.json({ok:true,id:String(r.insertedId)});
    }catch(e){next(e);}
  });

  app.patch("/api/admin/advertising/:id", auth, admin, async(req,res,next)=>{
    try { const id=oid(req.params.id); if(!id)return res.status(400).json({error:"Invalid ad."}); const b=req.body||{}; const set={updatedAt:new Date(),scheduleVersion:2,scheduleTimezone:"UTC"}; if(b.title!==undefined)set.title=cleanAdText(b.title,160); if(b.advertiserName!==undefined)set.advertiserName=cleanAdText(b.advertiserName,160); if(b.alt!==undefined)set.alt=cleanAdText(b.alt,180); if(b.destinationUrl!==undefined){const u=validAdUrl(b.destinationUrl);if(!u)return res.status(400).json({error:"Invalid destination URL."});set.destinationUrl=u;} if(b.imageUrl!==undefined){const u=validAdUrl(b.imageUrl);if(!u)return res.status(400).json({error:"Invalid image URL."});set.imageUrl=u;} if(b.placement!==undefined){if(!validPlacement(b.placement))return res.status(400).json({error:"Invalid placement."});set.placement=b.placement;} if(b.priority!==undefined)set.priority=Math.max(0,Math.min(100,Number(b.priority||0))); if(b.active!==undefined)set.active=b.active===true || b.active==="true"; if(b.startAt!==undefined)set.startAt=adDate(b.startAt); if(b.endAt!==undefined)set.endAt=adDate(b.endAt); const finalStart=set.startAt!==undefined?set.startAt:undefined; const finalEnd=set.endAt!==undefined?set.endAt:undefined; if(finalStart && finalEnd && finalEnd < finalStart)return res.status(400).json({error:"Advertisement end date/time must be after the start date/time."}); const existing=await advertisements.findOne({_id:id},{projection:{startAt:1,endAt:1}}); const checkStart=finalStart!==undefined?finalStart:existing?.startAt; const checkEnd=finalEnd!==undefined?finalEnd:existing?.endAt; if(checkStart && checkEnd && new Date(checkEnd)<new Date(checkStart))return res.status(400).json({error:"Advertisement end date/time must be after the start date/time."}); await advertisements.updateOne({_id:id},{$set:set}); res.json({ok:true}); }catch(e){next(e);}
  });
  app.delete("/api/admin/advertising/:id", auth, admin, async(req,res,next)=>{ try{const id=oid(req.params.id);if(!id)return res.status(400).json({error:"Invalid ad."});const ad=await advertisements.findOne({_id:id});if(!ad)return res.status(404).json({error:"Ad not found."});if(ad.asset?.publicId)await deleteCloudinaryAsset(ad.asset);await advertisements.deleteOne({_id:id});await adEvents.deleteMany({adId:id});await smartRecord(req,{type:"advertisement-deleted",severity:"medium",score:20,action:"deleted"});res.json({ok:true});}catch(e){next(e);} });

  app.get("/api/admin/security-health", auth, admin, async (req, res, next) => {
    try {
      const cfg = await getAdmin2fa(req.user);
      const recent = await securityEvents.countDocuments({ createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, severity: { $in: ["high", "critical"] } });
      res.json({ checks: [
        { key:"https", label:"HTTPS / secure cookies", ok: process.env.NODE_ENV === "production" },
        { key:"helmet", label:"Security headers (Helmet)", ok:true },
        { key:"mongoSessions", label:"MongoDB-backed sessions", ok:true },
        { key:"rateLimit", label:"Application rate limiting", ok:true },
        { key:"admin2fa", label:"Admin two-factor authentication", ok:!!cfg.enabled },
        { key:"secrets", label:"Server-side secrets", ok:true },
        { key:"sharedIp", label:"Shared-IP protection", ok:true },
        { key:"csrf", label:"Authenticated request origin protection", ok:true },
        { key:"uploadSecurity", label:"Uploaded-file signature screening", ok:true },
        { key:"aiToolAuthorization", label:"AI tool authorization and explicit generation checks", ok:true },
        { key:"recentThreats", label:"High/critical events in last 24h", ok: recent === 0, detail: recent }
      ], recentHighCritical: recent });
    } catch (e) { next(e); }
  });

  app.get("/api/admin/smart-security", auth, admin, async (req, res, next) => {
    try {
      const settings = await smartSettings();
      const events = await securityEvents.find({}).sort({ createdAt: -1 }).limit(100).toArray();
      const persistedBlocks = await securityBlocks.find({ until: { $gt: new Date() } }).sort({ until: 1 }).limit(200).toArray();
      const blocked = persistedBlocks.map(b => ({ deviceKey: b.deviceKey || null, ip: b.ip || null, block_type: b.blockType || "device", until: b.until, reason: b.reason || "smart-security", student_id: b.studentId ? String(b.studentId) : null }));
      res.json({ settings, events: events.map(e => ({ id: e._id.toString(), created_at: e.createdAt, ip: e.ip, method: e.method, path: e.path, type: e.type, severity: e.severity, score: e.score, action: e.action, status_code: e.statusCode || null })) , blocked });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/smart-security/settings", auth, admin, async (req, res, next) => {
    try {
      const current = await smartSettings();
      const body = req.body || {};
      const nextSettings = {
        enabled: body.enabled !== false,
        mode: body.mode === "auto" ? "auto" : "monitor",
        autoBlockHighRisk: !!body.autoBlockHighRisk,
        autoBlockCritical: !!body.autoBlockCritical,
        requireApprovalForCritical: body.requireApprovalForCritical === true,
        blockDurationMinutes: Math.min(1440, Math.max(5, Number(body.blockDurationMinutes ?? current.blockDurationMinutes))),
        retentionDays: Math.min(365, Math.max(1, Number(body.retentionDays ?? current.retentionDays))),
        studentIdleLockHours: 168,
        studentDormantIpBlockHours: 336,
        autoSuspendInactiveStudents: body.autoSuspendInactiveStudents !== false,
        autoBlockDormantStudentIps: body.autoBlockDormantStudentIps !== false,
        updatedAt: new Date(), updatedBy: req.user._id
      };
      await appSettings.updateOne({ _id: "smart_security" }, { $set: nextSettings }, { upsert: true });
      await smartRecord(req, { type: "admin-override", severity: "info", score: 0, action: "settings-updated", details: { enabled: nextSettings.enabled, mode: nextSettings.mode, autoBlockHighRisk: nextSettings.autoBlockHighRisk, autoBlockCritical: nextSettings.autoBlockCritical } });
      res.json({ ok: true, settings: { ...current, ...nextSettings } });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/smart-security/unblock", auth, admin, async (req, res, next) => {
    try {
      const deviceKey = String(req.body?.deviceKey || "").trim();
      const ip = String(req.body?.ip || "").trim();
      if (!deviceKey && !ip) return res.status(400).json({ error: "Device or IP block identifier is required." });
      if (deviceKey) { smartBlocked.delete(deviceKey); await securityBlocks.deleteOne({ deviceKey }); }
      if (ip) { smartBlocked.delete(`ip:${ip}`); await securityBlocks.deleteMany({ ip, blockType: "dormant-student-ip" }); }
      await smartRecord(req, { type: "admin-override", severity: "info", score: 0, action: ip ? "ip-unblocked" : "device-unblocked", targetDevice: deviceKey || null, targetIp: ip || null });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.get("/api/admin/ai-settings", auth, admin, async (req, res, next) => {
    try {
      const settings = await getAILimits();
      const dateKey = aiDateKey();
      const usage = await aiUsage.aggregate([
        { $match: { dateKey } },
        { $group: { _id: "$userId", credits: { $sum: "$credits" }, actions: { $push: "$actions" } } },
        { $sort: { credits: -1 } },
        { $limit: 100 }
      ]).toArray();
      const rows = [];
      for (const row of usage) {
        const u = await users.findOne({ _id: row._id }, { projection: { name: 1, email: 1, role: 1 } });
        const merged = {};
        for (const a of row.actions || []) for (const [k,v] of Object.entries(a || {})) merged[k] = (merged[k] || 0) + Number(v || 0);
        rows.push({ name: u?.name || "Unknown", email: u?.email || "", role: u?.role || "student", credits: Number(row.credits || 0), actions: merged });
      }
      res.json({ settings, dateKey, usage: rows });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/ai-settings", auth, admin, async (req, res, next) => {
    try {
      const body = req.body || {};
      const dailyCredits = Math.min(100000, Math.max(0, Math.floor(Number(body.dailyCredits)) || 0));
      const costs = {};
      for (const key of ["chat", "image", "document", "video", "speech", "quiz", "studyPlan"]) {
        costs[key] = Math.min(1000, Math.max(0, Math.floor(Number(body.costs?.[key])) || 0));
      }
      const settings = { dailyCredits, unlimitedAdmins: body.unlimitedAdmins !== false, costs, updatedAt: new Date() };
      await aiSettings.updateOne({ _id: "global" }, { $set: settings }, { upsert: true });
      res.json({ ok: true, settings: await getAILimits() });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/ai-reset", auth, admin, async (req, res, next) => {
    try {
      const dateKey = aiDateKey();
      const result = await aiUsage.deleteMany({ dateKey });
      res.json({ ok: true, dateKey, deleted: result.deletedCount || 0 });
    } catch (e) { next(e); }
  });

  app.get("/api/admin/users", auth, admin, async (req, res, next) => {
    try {
      const list = await users.find({}).sort({ createdAt: -1 }).toArray();
      res.json({ users: list.map(u => ({ id: u._id.toString(), name: u.name, email: u.email, role: u.role, profile_picture_url: (u.profilePicture ? `/api/admin/profile-picture/${u._id.toString()}` : null), student_id_number: u.studentIdNumber || null, course_code: u.courseCode || "", registration_date: u.registrationDate || (u.createdAt ? new Date(u.createdAt).toISOString().slice(0,10) : ""), programme_end_date: u.programmeEndDate || "", state: u.state || "", country: u.country || "", gender: u.gender || "", portal_locked: !!u.portalLocked, lock_source: u.lockSource || null, lock_reason: u.lockReason || null, last_activity_at: u.lastActivityAt || null, last_activity_ip: u.lastActivityIp || null, inactivity_locked_at: u.inactivityLockedAt || null, smart_suspended_at: u.smartSuspendedAt || null, payment_status: u.paymentStatus, approved: !!u.approved, enrolled_course_ids: enrolledCourseIds(u), created_at: u.createdAt })) });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/users/:id/reset-password", auth, admin, rateLimit({ windowMs: 15 * 60 * 1000, max: 20, keyPrefix: "admin-password-reset", by: "device" }), async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid user id" });
      const user = await users.findOne({ _id: id });
      if (!user) return res.status(404).json({ error: "User not found" });
      if (!["student", "instructor"].includes(user.role)) return res.status(403).json({ error: "Only student and instructor passwords can be reset here." });

      const supplied = String(req.body?.password || "").trim();
      let temporaryPassword = supplied;
      if (!temporaryPassword) {
        temporaryPassword = crypto.randomBytes(9).toString("base64url").slice(0, 12);
      }
      if (temporaryPassword.length < 8 || temporaryPassword.length > 128) {
        return res.status(400).json({ error: "Temporary password must be between 8 and 128 characters." });
      }

      const passwordHash = await bcrypt.hash(temporaryPassword, 12);
      const passwordVersion = Number(user.passwordVersion || 0) + 1;
      const now = new Date();
      await users.updateOne(
        { _id: id },
        { $set: { passwordHash, passwordVersion, mustChangePassword: true, passwordResetAt: now, passwordResetBy: req.user._id } }
      );
      await smartRecord(req, {
        type: "admin-password-reset",
        severity: "high",
        score: 70,
        action: "password-reset-temporary",
        targetUserId: id,
        reason: `Administrator reset ${user.role} password; user must change it at next login.`
      });
      res.json({ ok: true, temporary_password: temporaryPassword, must_change_password: true, message: "Temporary password created. It will be shown only in this response; give it to the user through a trusted channel." });
    } catch (e) { next(e); }
  });

  app.post("/api/change-password", auth, rateLimit({ windowMs: 15 * 15 * 1000, max: 10, keyPrefix: "change-password", by: "device" }), async (req, res, next) => {
    try {
      if (!req.user || !["student", "instructor"].includes(req.user.role)) return res.status(403).json({ error: "Password changes are available for student and instructor accounts here." });
      const currentPassword = String(req.body?.currentPassword || "");
      const newPassword = String(req.body?.newPassword || "");
      const confirmPassword = String(req.body?.confirmPassword || "");
      if (newPassword.length < 8 || newPassword.length > 128) return res.status(400).json({ error: "New password must be between 8 and 128 characters." });
      if (newPassword !== confirmPassword) return res.status(400).json({ error: "New passwords do not match." });
      const currentValid = await bcrypt.compare(currentPassword, req.user.passwordHash || "");
      if (!currentValid) return res.status(401).json({ error: "Current password is incorrect." });
      if (currentPassword === newPassword) return res.status(400).json({ error: "Choose a new password different from the temporary/current password." });

      const passwordHash = await bcrypt.hash(newPassword, 12);
      const passwordVersion = Number(req.user.passwordVersion || 0) + 1;
      await users.updateOne({ _id: req.user._id }, { $set: { passwordHash, passwordVersion, mustChangePassword: false, passwordChangedAt: new Date() } });
      req.session.passwordVersion = passwordVersion;
      await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
      await smartRecord(req, { type: "password-changed", severity: "info", score: 0, action: "user-completed-password-reset", targetUserId: req.user._id });
      res.json({ ok: true, redirect: req.user.role === "instructor" ? "/instructor.html" : "/index.html", message: "Password changed successfully." });
    } catch (e) { next(e); }
  });

  app.delete("/api/admin/users/:id", auth, admin, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid user id" });
      const user = await users.findOne({ _id: id });
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.role !== "student") return res.status(403).json({ error: "Only student accounts can be deleted from this action." });
      if (String(user._id) === String(req.user._id)) return res.status(403).json({ error: "You cannot delete your own administrator account." });

      // Remove the user's Cloudinary assets first. Database records are still
      // removed even if one external asset is already missing.
      const paymentDocs = await payments.find({ userId: id }).toArray();
      const submissionDocs = await submissions.find({ studentId: id }).toArray();
      const messageDocs = await chatMessages.find({ senderId: id }).toArray();
      const artifactDocs = await aiArtifacts.find({ userId: id }).toArray();
      await deleteCloudinaryAsset(user.profilePicture);
      for (const doc of paymentDocs) await deleteCloudinaryAsset(doc.proof);
      for (const doc of submissionDocs) await deleteCloudinaryAsset(doc.file);
      for (const doc of messageDocs) await deleteCloudinaryAsset(doc.attachment);
      for (const doc of artifactDocs) await deleteCloudinaryAsset({ publicId: doc.publicId, resourceType: doc.resourceType || (doc.type === "video" ? "video" : "raw"), type: doc.typeName || "upload" });

      await Promise.all([
        payments.deleteMany({ userId: id }),
        submissions.deleteMany({ studentId: id }),
        aiConversations.deleteMany({ userId: id }),
        aiUsage.deleteMany({ userId: id }),
        lessonProgress.deleteMany({ userId: id }),
        quizAttempts.deleteMany({ userId: id }),
        quizzes.deleteMany({ userId: id }),
        studyPlans.deleteMany({ userId: id }),
        aiArtifacts.deleteMany({ userId: id }),
        courseEnrollments.deleteMany({ studentId: id }),
        attendanceRecords.deleteMany({ studentId: id }),
        chatMessages.deleteMany({ senderId: id }),
        chatConversations.updateMany({ members: id }, { $pull: { members: id } })
      ]);
      // Preserve Smart's security audit trail while detaching it from the deleted account.
      await securityEvents.updateMany({ userId: id }, { $set: { deletedUserId: id }, $unset: { userId: "" } });
      await users.deleteOne({ _id: id });
      await smartRecord(req, { type: "student-deleted", severity: "high", score: 0, action: "admin-deleted-student", targetUserId: id });
      res.json({ ok: true, deleted_user_id: id.toString() });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/users/:id/identity", auth, admin, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid user id" });
      const user = await users.findOne({ _id: id });
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.role !== "student") return res.status(400).json({ error: "Only student identity details can be edited here." });
      const identity = cleanStudentIdentity(req.body);
      let studentIdNumber = identity.studentIdNumber;
      if (!studentIdNumber) studentIdNumber = user.studentIdNumber || await generateStudentIdNumber();
      const duplicate = await users.findOne({ studentIdNumber, _id: { $ne: id } }, { projection: { _id: 1 } });
      if (duplicate) return res.status(409).json({ error: "That student ID number is already assigned to another student." });
      const registrationDate = identity.registrationDate || (user.registrationDate || (user.createdAt ? new Date(user.createdAt).toISOString().slice(0,10) : new Date().toISOString().slice(0,10)));
      await users.updateOne({ _id: id }, { $set: { studentIdNumber, courseCode: identity.courseCode, state: identity.state, country: identity.country || user.country || "Nigeria", gender: identity.gender, registrationDate, programmeEndDate: identity.programmeEndDate } });
      res.json({ ok: true, student_id_number: studentIdNumber });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/users/:id/toggle-lock", auth, admin, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid user id" });
      const u = await users.findOne({ _id: id });
      if (!u) return res.status(404).json({ error: "User not found" });
      const now = new Date();
      if (u.portalLocked) {
        await users.updateOne(
          { _id: id },
          { $set: { portalLocked: false, lastActivityAt: now }, $unset: { lockSource: "", lockReason: "", inactivityLockedAt: "", smartSuspendedAt: "", lockedAt: "", examSecurityPending: "", examSecurityExamId: "" } }
        );
      } else {
        await users.updateOne(
          { _id: id },
          { $set: { portalLocked: true, lockSource: "admin", lockReason: "Locked by administrator", lockedAt: now } }
        );
      }
      res.json({ ok: true, portal_locked: !u.portalLocked });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/users/:id/smart-override", auth, admin, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid user id" });
      const user = await users.findOne({ _id: id, role: "student" });
      if (!user) return res.status(404).json({ error: "Student not found." });
      const now = new Date();
      await users.updateOne({ _id: id }, { $set: { portalLocked: false, lastActivityAt: now }, $unset: { lockSource: "", lockReason: "", inactivityLockedAt: "", smartSuspendedAt: "", lockedAt: "", examSecurityPending: "", examSecurityExamId: "" } });
      await securityEvents.insertOne({ createdAt: now, type: "admin-override", severity: "info", score: 0, action: "smart-student-suspension-overridden", userId: id, ip: user.lastActivityIp || null, reason: "Administrator overrode Smart Security decision" });
      res.json({ ok: true, message: "Admin override applied. Student account restored." });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/users/:id/approve", auth, admin, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid user id" });
      await users.updateOne({ _id: id }, { $set: { approved: true, paymentStatus: "paid" } });
      await payments.updateMany({ userId: id, status: "pending" }, { $set: { status: "approved" } });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/users/:id/courses", auth, admin, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid user id" });
      const user = await users.findOne({ _id: id });
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.role === "admin") return res.status(400).json({ error: "Admin accounts do not use course enrollment restrictions." });
      const raw = Array.isArray(req.body.courseIds) ? req.body.courseIds : [];
      const ids = [...new Set(raw.map(oid).filter(Boolean).map(x => x.toString()))];
      const valid = await courseCollection.countDocuments({ _id: { $in: ids.map(x => new ObjectId(x)) } });
      if (valid !== ids.length) return res.status(400).json({ error: "One or more courses are invalid." });
      const previous = enrolledCourseIds(user);
      await users.updateOne({ _id: id }, { $set: { enrolledCourseIds: ids } });
      for (const cid of ids) await ensureEnrollment(id, cid, user.registrationDate || (user.createdAt ? lagosDateString(user.createdAt) : lagosDateString()));
      for (const oldCid of previous.filter(x => !ids.includes(String(x)))) await courseEnrollments.deleteOne({ studentId: id, courseId: oid(oldCid) });
      res.json({ ok: true, enrolled_course_ids: ids });
    } catch (e) { next(e); }
  });

  app.get("/api/admin/users/:id/portal", auth, admin, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid user id" });
      const student = await users.findOne({ _id: id }, { projection: { passwordHash: 0 } });
      if (!student) return res.status(404).json({ error: "User not found" });
      if (student.role === "admin") return res.status(400).json({ error: "Admin accounts do not have a student portal." });
      const enrolled = enrolledCourseIds(student);
      const courseDocs = await courseCollection.find({ _id: { $in: enrolled.map(x => new ObjectId(x)) } }).sort({ title: 1 }).toArray();
      const assignmentDocs = await assignments.find(enrolled.length ? { $or: [{ courseId: { $in: enrolled.map(x => new ObjectId(x)) } }, { courseId: null }] } : { courseId: null }).sort({ createdAt: -1 }).toArray();
      const assignmentRows = [];
      for (const a of assignmentDocs) {
        const course = a.courseId ? await courseCollection.findOne({ _id: a.courseId }) : null;
        const sub = await submissions.findOne({ assignmentId: a._id, studentId: id });
        assignmentRows.push({ title: a.title, instructions: a.instructions, course: course?.title || "General", dueDate: a.dueDate || "", grade: sub?.grade || "", feedback: sub?.feedback || "" });
      }
      const learning = await getLearningOverview(id, student);
      res.json({ student: { id: student._id.toString(), name: student.name, email: student.email, approved: !!student.approved, portalLocked: !!student.portalLocked, paymentStatus: student.paymentStatus || "unpaid" }, courses: courseDocs.map(c => ({ id: c._id.toString(), title: c.title, description: c.description || "", locked: !!c.locked })), assignments: assignmentRows, learning });
    } catch (e) { next(e); }
  });

  app.get("/api/admin/payments/:id/proof", auth, admin, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid payment id" });
      const payment = await payments.findOne({ _id: id });
      if (!payment?.proof?.publicId) return res.status(404).json({ error: "Payment proof not found." });
      const url = privateCloudinaryUrl(payment.proof);
      if (!url) return res.status(500).json({ error: "Could not create a proof URL." });
      return res.redirect(302, url);
    } catch (e) { next(e); }
  });

  app.get("/api/admin/payments", auth, admin, async (req, res, next) => {
    try {
      const list = await payments.find({}).sort({ createdAt: -1 }).toArray();
      const result = [];
      for (const p of list) {
        const u = await users.findOne({ _id: p.userId });
        result.push({
          id: p._id.toString(), name: u?.name || "Unknown", email: u?.email || "", method: p.method,
          reference: p.reference || "", proof_path: p.proof?.publicId ? `/api/admin/payments/${p._id.toString()}/proof` : "", status: p.status
        });
      }
      res.json({ payments: result });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/courses", auth, admin, async (req, res, next) => {
    try {
      const title = String(req.body.title || "").trim().slice(0, 120);
      const description = String(req.body.description || "").trim().slice(0, 2000);
      const price = Number(req.body.price || 0);
      const thumbnail = String(req.body.thumbnail || "").trim().slice(0, 1000);
      const durationWeeks = Math.min(104, Math.max(1, Number(req.body.durationWeeks || 12)));
      const locked = req.body.locked === true || req.body.locked === "true" || req.body.locked === "on";
      if (!title) return res.status(400).json({ error: "Course title is required." });
      if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: "Price must be a non-negative number." });
      if (thumbnail && !/^https?:\/\//i.test(thumbnail)) return res.status(400).json({ error: "Thumbnail must be a valid http(s) URL." });
      const existing = await courseCollection.findOne({ title: { $regex: `^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });
      if (existing) return res.status(409).json({ error: "A course with that title already exists." });
      const result = await courseCollection.insertOne({ title, description, price, thumbnail, locked, durationWeeks, ownerInstructorId: null, createdAt: new Date(), updatedAt: new Date() });
      res.status(201).json({ ok: true, course: { id: result.insertedId.toString(), title, description, price, thumbnail, duration_weeks: durationWeeks, locked } });
    } catch (e) { next(e); }
  });

  app.put("/api/admin/courses/:id", auth, admin, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid course id" });
      const course = await courseCollection.findOne({ _id: id });
      if (!course) return res.status(404).json({ error: "Course not found" });
      const title = String(req.body.title ?? course.title).trim().slice(0, 120);
      const description = String(req.body.description ?? course.description ?? "").trim().slice(0, 2000);
      const price = Number(req.body.price ?? course.price ?? 0);
      const thumbnail = String(req.body.thumbnail ?? course.thumbnail ?? "").trim().slice(0, 1000);
      const durationWeeks = Math.min(104, Math.max(1, Number(req.body.durationWeeks ?? course.durationWeeks ?? 12)));
      const locked = req.body.locked === undefined ? !!course.locked : (req.body.locked === true || req.body.locked === "true" || req.body.locked === "on");
      if (!title) return res.status(400).json({ error: "Course title is required." });
      if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: "Price must be a non-negative number." });
      if (thumbnail && !/^https?:\/\//i.test(thumbnail)) return res.status(400).json({ error: "Thumbnail must be a valid http(s) URL." });
      const duplicate = await courseCollection.findOne({ _id: { $ne: id }, title: { $regex: `^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });
      if (duplicate) return res.status(409).json({ error: "A course with that title already exists." });
      await courseCollection.updateOne({ _id: id }, { $set: { title, description, price, thumbnail, durationWeeks, locked, updatedAt: new Date() } });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.delete("/api/admin/courses/:id", auth, admin, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid course id" });
      const course = await courseCollection.findOne({ _id: id });
      if (!course) return res.status(404).json({ error: "Course not found" });
      const courseLessons = await lessons.find({ courseId: id }).project({ _id: 1 }).toArray();
      const lessonIds = courseLessons.map(x => x._id);
      const assignmentDocs = await assignments.find({ courseId: id }).project({ _id: 1 }).toArray();
      const assignmentIds = assignmentDocs.map(x => x._id);
      await Promise.all([
        lessons.deleteMany({ courseId: id }),
        courseEnrollments.deleteMany({ courseId: id }),
        attendanceRecords.deleteMany({ courseId: id }),
        assignments.deleteMany({ courseId: id }),
        users.updateMany({ enrolledCourseIds: id.toString() }, { $pull: { enrolledCourseIds: id.toString() } }),
        users.updateMany({ enrolledCourseIds: id }, { $pull: { enrolledCourseIds: id } }),
        ...(lessonIds.length ? [lessonProgress.deleteMany({ lessonId: { $in: lessonIds } }), lessonAccessOverrides.deleteMany({ lessonId: { $in: lessonIds } })] : []),
        ...(assignmentIds.length ? [submissions.deleteMany({ assignmentId: { $in: assignmentIds } })] : []),
        courseCollection.deleteOne({ _id: id })
      ]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/courses/:id/toggle-lock", auth, admin, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid course id" });
      const c = await courseCollection.findOne({ _id: id });
      if (!c) return res.status(404).json({ error: "Course not found" });
      await courseCollection.updateOne({ _id: id }, { $set: { locked: !c.locked, updatedAt: new Date() } });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Create a lesson or attach/replace media on an existing lesson.
  // This supports the common admin workflow of uploading the note first,
  // then adding audio/video later without creating duplicate lesson records.
  app.post("/api/admin/lessons", auth, admin, upload.fields([{ name: "note", maxCount: 1 }, { name: "video", maxCount: 1 }, { name: "audio", maxCount: 1 }]), async (req, res, next) => {
    try {
      const courseId = oid(req.body.courseId);
      const title = String(req.body.title || "").trim();
      const lessonId = req.body.lessonId ? oid(req.body.lessonId) : null;
      const unlockAt = normalizeLessonUnlockAt(req.body.unlockAt);
      if (req.body.unlockAt && !unlockAt) return res.status(400).json({ error: "Invalid lesson unlock date/time." });
      const smartLockOverride = req.body.smartLockOverride === "true" || req.body.smartLockOverride === true;
      if (!courseId || !title) return res.status(400).json({ error: "Course and lesson title required" });
      const course = await courseCollection.findOne({ _id: courseId });
      if (!course) return res.status(404).json({ error: "Course not found" });

      const noteFile = req.files?.note?.[0];
      const videoFile = req.files?.video?.[0];
      const audioFile = req.files?.audio?.[0];
      if (!noteFile && !videoFile && !audioFile && !lessonId) return res.status(400).json({ error: "Select at least one lesson file or choose an existing lesson to update its Smart Lock settings." });
      if (noteFile && !hasAllowedExtension(noteFile, noteExtensions)) return res.status(400).json({ error: "Lesson notes must be PDF, DOC, DOCX, TXT, or MD." });
      if (videoFile && !hasAllowedExtension(videoFile, videoExtensions)) return res.status(400).json({ error: "Lesson video must be MP4, WEBM, MOV, or M4V." });
      // Do not reject audio based on the browser-reported MIME type. Android and
      // some file managers often label valid audio as application/octet-stream.
      // The upload field itself is explicitly named "audio" and Cloudinary does
      // the final media inspection when the asset is uploaded as a video resource.

      let existing = null;
      if (lessonId) {
        existing = await lessons.findOne({ _id: lessonId });
        if (!existing) return res.status(404).json({ error: "Lesson not found" });
        if (String(existing.courseId) !== String(courseId)) return res.status(400).json({ error: "Selected lesson belongs to a different course." });
      }

      // If no explicit lesson was selected, create a new lesson. If an exact
      // course + title already exists, update that lesson instead of silently
      // creating a duplicate. This makes separate note/audio/video uploads safe.
      if (!existing) {
        existing = await lessons.findOne({ courseId, title });
      }

      const patch = { updatedAt: new Date(), unlockAt, smartLockOverride };
      if (noteFile) {
        const r = await uploadBuffer(noteFile.buffer, noteFile.originalname, "lesson-notes", "raw");
        patch.note = { url: r.secure_url, publicId: r.public_id, resourceType: r.resource_type || "raw", type: r.type || "upload", originalName: noteFile.originalname };
      }
      if (videoFile) {
        const r = await uploadBuffer(videoFile.buffer, videoFile.originalname, "lesson-videos", "video");
        patch.video = { url: r.secure_url, publicId: r.public_id, resourceType: r.resource_type || "video", type: r.type || "upload", originalName: videoFile.originalname };
      }
      if (audioFile) {
        const r = await uploadBuffer(audioFile.buffer, audioFile.originalname, "lesson-audio", "video");
        patch.audio = { url: r.secure_url, publicId: r.public_id, resourceType: r.resource_type || "video", type: r.type || "upload", originalName: audioFile.originalname };
      }

      if (existing) {
        // Remove replaced Cloudinary assets only after their replacements have
        // uploaded successfully.
        const oldAssets = [];
        if (noteFile && existing.note) oldAssets.push([existing.note, "raw"]);
        if (videoFile && existing.video) oldAssets.push([existing.video, "video"]);
        if (audioFile && existing.audio) oldAssets.push([existing.audio, "video"]);
        await lessons.updateOne({ _id: existing._id }, { $set: patch });
        await Promise.all(oldAssets.map(([asset, type]) => destroyCloudinaryAsset(asset, type)));
        return res.json({ ok: true, id: existing._id.toString(), updated: true, message: "Lesson updated successfully." });
      }

      const doc = { courseId, title, note: patch.note || null, video: patch.video || null, audio: patch.audio || null, unlockAt, smartLockOverride, createdAt: new Date(), updatedAt: new Date() };
      const result = await lessons.insertOne(doc);
      res.json({ ok: true, id: result.insertedId.toString(), updated: false, message: "Lesson uploaded successfully." });
    } catch (e) {
      console.error("Admin lesson upload error:", e);
      next(e);
    }
  });

  app.get("/api/admin/lessons", auth, admin, async (req, res, next) => {
    try {
      const list = await lessons.find({}).sort({ createdAt: -1 }).toArray();
      const result = [];
      for (const l of list) {
        const c = await courseCollection.findOne({ _id: l.courseId });
        result.push({ id: l._id.toString(), title: l.title, course_id: l.courseId?.toString() || "", course_title: c?.title || "Unknown", note_path: l.note?.url || "", video_path: lessonMediaUrl(l.video, "video") || "", audio_path: lessonMediaUrl(l.audio, "audio") || "", unlock_at: l.unlockAt || null, smart_lock_override: !!l.smartLockOverride });
      }
      res.json({ lessons: result });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/lessons/:id/access-control", auth, admin, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid lesson id." });
      const lesson = await lessons.findOne({ _id: id });
      if (!lesson) return res.status(404).json({ error: "Lesson not found." });
      const unlockAt = normalizeLessonUnlockAt(req.body.unlockAt);
      if (req.body.unlockAt && !unlockAt) return res.status(400).json({ error: "Invalid lesson unlock date/time." });
      const override = req.body.smartLockOverride === true || req.body.smartLockOverride === "true";
      await lessons.updateOne({ _id: id }, { $set: { unlockAt, smartLockOverride: override, updatedAt: new Date() } });
      res.json({ ok: true, unlock_at: unlockAt, smart_lock_override: override, message: override ? "Admin override enabled. Students can access this lesson now." : "Lesson Smart Lock settings saved." });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/students/:studentId/lessons/:lessonId/access", auth, admin, async (req, res, next) => {
    try {
      const studentId = oid(req.params.studentId), lessonId = oid(req.params.lessonId);
      if (!studentId || !lessonId) return res.status(400).json({ error: "Invalid student or lesson." });
      const student = await users.findOne({ _id: studentId, role: "student" });
      const lesson = await lessons.findOne({ _id: lessonId });
      if (!student || !lesson) return res.status(404).json({ error: "Student or lesson not found." });
      const grant = req.body.grant !== false && req.body.grant !== "false";
      if (grant) {
        await lessonAccessOverrides.updateOne({ studentId, lessonId }, { $set: { studentId, lessonId, grant: true, grantedBy: req.user._id, grantedAt: new Date(), updatedAt: new Date() } }, { upsert: true });
      } else {
        await lessonAccessOverrides.deleteOne({ studentId, lessonId });
      }
      res.json({ ok: true, grant, message: grant ? "Student granted access to this lesson by Admin." : "Student-specific lesson access override removed." });
    } catch (e) { next(e); }
  });

  app.get("/api/admin/lesson-access", auth, admin, async (req, res, next) => {
    try {
      const rows = await lessonAccessOverrides.find({ grant: true }).sort({ updatedAt: -1 }).limit(500).toArray();
      const result = [];
      for (const r of rows) {
        const [student, lesson] = await Promise.all([users.findOne({ _id: r.studentId }, { projection: { name: 1, email: 1 } }), lessons.findOne({ _id: r.lessonId }, { projection: { title: 1, courseId: 1 } })]);
        const course = lesson ? await courseCollection.findOne({ _id: lesson.courseId }, { projection: { title: 1 } }) : null;
        result.push({ id: r._id.toString(), student_id: String(r.studentId), student_name: student?.name || "Unknown", student_email: student?.email || "", lesson_id: String(r.lessonId), lesson_title: lesson?.title || "Deleted lesson", course_title: course?.title || "Unknown", granted_at: r.grantedAt || r.updatedAt });
      }
      res.json({ overrides: result });
    } catch (e) { next(e); }
  });

  app.delete("/api/admin/lesson-access/:studentId/:lessonId", auth, admin, async (req, res, next) => {
    try {
      const studentId = oid(req.params.studentId), lessonId = oid(req.params.lessonId);
      if (!studentId || !lessonId) return res.status(400).json({ error: "Invalid student or lesson." });
      await lessonAccessOverrides.deleteOne({ studentId, lessonId });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.delete("/api/admin/lessons/:id", auth, admin, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid lesson id" });
      const lesson = await lessons.findOne({ _id: id });
      if (!lesson) return res.status(404).json({ error: "Lesson not found" });

      await Promise.all([
        destroyCloudinaryAsset(lesson.note, "raw"),
        destroyCloudinaryAsset(lesson.video, "video"),
        destroyCloudinaryAsset(lesson.audio, "video")
      ]);

      await Promise.all([
        lessons.deleteOne({ _id: id }),
        lessonProgress.deleteMany({ lessonId: id }),
        lessonAccessOverrides.deleteMany({ lessonId: id })
      ]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/assignments", auth, admin, async (req, res, next) => {
    try {
      const courseId = req.body.courseId ? oid(req.body.courseId) : null;
      const title = String(req.body.title || "").trim();
      const instructions = String(req.body.instructions || "").trim();
      if (!title || !instructions) return res.status(400).json({ error: "Title and instructions required" });
      const result = await assignments.insertOne({ courseId, title, instructions, dueDate: req.body.dueDate || null, createdAt: new Date() });
      res.json({ ok: true, id: result.insertedId.toString() });
    } catch (e) { next(e); }
  });

  app.get("/api/admin/submissions", auth, admin, async (req, res, next) => {
    try {
      const list = await submissions.find({}).sort({ submittedAt: -1 }).toArray();
      const result = [];
      for (const s of list) {
        const [a, u] = await Promise.all([
          assignments.findOne({ _id: s.assignmentId }),
          users.findOne({ _id: s.studentId })
        ]);
        result.push({
          id: s._id.toString(),
          assignment_title: a?.title || "Unknown",
          student_name: u?.name || "Unknown",
          email: u?.email || "",
          file_path: s.file?.url ? `/api/admin/submissions/${s._id.toString()}/file` : "",
          file_name: s.file?.originalName || "",
          grade: s.grade || "",
          feedback: s.feedback || ""
        });
      }
      res.json({ submissions: result });
    } catch (e) { next(e); }
  });

  // Proxy student submission downloads through SMARTTEP ACADEMY so Office files
  // retain their real filename and MIME type instead of being saved as .bin.
  // This also works for submissions uploaded before this route was added.
  app.get("/api/admin/submissions/:id/file", auth, admin, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid submission id" });

      const submission = await submissions.findOne({ _id: id });
      if (!submission?.file?.url) return res.status(404).json({ error: "Submission file not found" });

      let upstream;
      try {
        upstream = await fetch(submission.file.url, { redirect: "follow" });
      } catch (e) {
        console.error("Submission file upstream fetch failed:", e?.message || e);
        return res.status(502).json({ error: "Could not load the submission file." });
      }

      if (!upstream.ok) {
        console.error(`Submission file upstream returned ${upstream.status} for ${submission.file.url}`);
        return res.status(upstream.status === 404 ? 404 : 502).json({ error: "Submission file could not be loaded." });
      }

      const filename = path.basename(submission.file.originalName || "submission-file") || "submission-file";
      const ext = path.extname(filename).toLowerCase();
      const mimeTypes = {
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".doc": "application/msword",
        ".pdf": "application/pdf",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".zip": "application/zip",
        ".txt": "text/plain; charset=utf-8",
        ".md": "text/markdown; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".htm": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".cjs": "text/javascript; charset=utf-8",
        ".ts": "text/plain; charset=utf-8",
        ".tsx": "text/plain; charset=utf-8",
        ".jsx": "text/javascript; charset=utf-8",
        ".py": "text/x-python; charset=utf-8",
        ".java": "text/x-java; charset=utf-8",
        ".cs": "text/plain; charset=utf-8",
        ".cpp": "text/x-c++; charset=utf-8",
        ".c": "text/x-c; charset=utf-8",
        ".h": "text/x-c; charset=utf-8",
        ".json": "application/json",
        ".xml": "application/xml"
      };
      const upstreamType = upstream.headers.get("content-type");
      const contentType = mimeTypes[ext] || (
        upstreamType && !/^(application\/octet-stream|binary\/octet-stream)(?:;|$)/i.test(upstreamType)
          ? upstreamType
          : "application/octet-stream"
      );
      const asciiFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");

      res.status(200);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-store");

      const contentLength = upstream.headers.get("content-length");
      if (contentLength) res.setHeader("Content-Length", contentLength);

      if (!upstream.body) return res.end();
      Readable.fromWeb(upstream.body).on("error", err => {
        console.error("Submission file stream failed:", err?.message || err);
        if (!res.headersSent) res.status(502);
        res.end();
      }).pipe(res);
    } catch (e) { next(e); }
  });

  app.post("/api/admin/submissions/:id/grade", auth, admin, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid submission id" });
      await submissions.updateOne({ _id: id }, { $set: { grade: req.body.grade || "", feedback: req.body.feedback || "" } });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.post("/api/submissions", auth, studentAccess, upload.single("codeFile"), async (req, res, next) => {
    try {
      const assignmentId = oid(req.body.assignmentId);
      if (!assignmentId) return res.status(400).json({ error: "Assignment required" });
      const assignment = await assignments.findOne({ _id: assignmentId });
      if (!assignment) return res.status(404).json({ error: "Assignment not found" });
      if (assignment.courseId && !studentHasCourse(req.user, assignment.courseId)) return res.status(403).json({ error: "You are not registered for this course." });
      let file = null;
      if (req.file) {
        if (!hasAllowedExtensionOrMime(req.file, submissionExtensions, submissionMimeByExtension)) {
          return res.status(400).json({ error: "Unsupported submission file type. Supported files include pictures (JPG, JPEG, PNG, WEBP, GIF), PDF, DOC/DOCX, ZIP, TXT, and common code files." });
        }
        const imageSubmission = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(path.extname(req.file.originalname || "").toLowerCase());
        const r = await uploadBuffer(req.file.buffer, req.file.originalname, "student-submissions", imageSubmission ? "image" : "raw");
        file = {
          url: r.secure_url,
          publicId: r.public_id,
          resourceType: r.resource_type || "raw",
          type: r.type || "upload",
          format: r.format || path.extname(req.file.originalname || "").replace(/^\\./, "").toLowerCase(),
          originalName: req.file.originalname
        };
      }
      await submissions.updateOne(
        { assignmentId, studentId: req.user._id },
        { $set: { textCode: req.body.textCode || "", file, submittedAt: new Date() }, $setOnInsert: { assignmentId, studentId: req.user._id, grade: "", feedback: "" } },
        { upsert: true }
      );
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ---------------- AI TUTOR ----------------
  const aiUpload = secureMulter(multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 }
  }));

  function aiFilePart(file) {
    if (!file) return null;
    const mime = file.mimetype || "application/octet-stream";
    const data = file.buffer.toString("base64");
    if (mime.startsWith("image/")) {
      return { type: "input_image", image_url: `data:${mime};base64,${data}`, detail: "auto" };
    }
    return {
      type: "input_file",
      filename: file.originalname || "uploaded-file",
      file_data: `data:${mime};base64,${data}`
    };
  }

  function academyWords(query) {
    return String(query || '').toLowerCase().split(/[^a-z0-9+#.]+/).filter(w => w.length > 2).slice(0, 14);
  }

  function scoreAcademyText(query, text) {
    const words = academyWords(query);
    const hay = String(text || '').toLowerCase();
    let score = 0;
    for (const w of words) {
      if (hay.includes(w)) score += 1;
    }
    return score;
  }

  async function searchAcademyMaterial(query, studentId) {
    const q = String(query || '').trim();
    const student = await users.findOne({ _id: studentId });
    const enrolled = enrolledCourseIds(student);
    const allCourses = enrolled.length
      ? await courseCollection.find({ _id: { $in: enrolled.map(x => new ObjectId(x)) }, locked: false }).sort({ title: 1 }).toArray()
      : [];
    const unlockedIds = new Set(allCourses.map(c => String(c._id)));
    const courseById = new Map(allCourses.map(c => [String(c._id), c]));
    const allLessons = await lessons.find({}).sort({ createdAt: 1 }).toArray();

    const normalized = q.toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim();
    const courseMatches = allCourses
      .map(course => {
        const title = String(course.title || '').toLowerCase();
        const exact = normalized === title;
        const contains = title && normalized.includes(title);
        const reverse = title && title.includes(normalized) && normalized.length >= 4;
        return { course, score: exact ? 100 : contains ? 80 : reverse ? 60 : scoreAcademyText(q, `${course.title} ${course.description || ''}`) };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);

    const matchedCourse = courseMatches[0]?.course || null;
    const scored = [];
    for (const lesson of allLessons) {
      if (!unlockedIds.has(String(lesson.courseId))) continue;
      const course = courseById.get(String(lesson.courseId));
      let score = scoreAcademyText(q, `${course?.title || ''} ${course?.description || ''} ${lesson.title || ''}`);
      if (matchedCourse && String(lesson.courseId) === String(matchedCourse._id)) score += 40;
      if (normalized === String(course?.title || '').toLowerCase()) score += 50;
      if (lesson.note?.url) score += 2;
      if (score > 0) scored.push({ score, lesson, course });
    }
    scored.sort((a, b) => b.score - a.score);

    const top = scored.slice(0, 8);
    const courseLessonRows = matchedCourse
      ? allLessons.filter(l => unlockedIds.has(String(l.courseId)) && String(l.courseId) === String(matchedCourse._id)).map(lesson => ({
          course: matchedCourse.title,
          lesson: lesson.title,
          lessonId: lesson._id.toString(),
          noteUrl: lesson.note?.url || null,
          noteName: lesson.note?.originalName || null,
          videoUrl: lesson.video?.url || null,
          audioUrl: lesson.audio?.url || null
        }))
      : [];

    const results = (matchedCourse ? courseLessonRows : top.map(({ lesson, course, score }) => ({
      score,
      course: course?.title || 'Unknown',
      lesson: lesson.title,
      lessonId: lesson._id.toString(),
      noteUrl: lesson.note?.url || null,
      noteName: lesson.note?.originalName || null,
      videoUrl: lesson.video?.url || null,
      audioUrl: lesson.audio?.url || null
    }))).slice(0, 8);

    return {
      query: q,
      matchedCourse: matchedCourse ? { id: matchedCourse._id.toString(), title: matchedCourse.title, description: matchedCourse.description || '' } : null,
      results,
      hint: matchedCourse
        ? `The student appears to be asking about the enrolled SMARTTEP ACADEMY course "${matchedCourse.title}". Use the supplied lesson notes as the primary source when explaining its lessons. If the student did not name a specific lesson, give a course-level overview first and offer the available lessons.`
        : results.length
          ? 'These are the closest enrolled SMARTTEP ACADEMY lessons. Use their attached lesson notes as source material when relevant.'
          : 'No closely matching enrolled SMARTTEP ACADEMY course or lesson was found.'
    };
  }

  async function getStudentProgress(studentId) {
    const userId = studentId;
    const student = await users.findOne({ _id: userId }, { projection: { passwordHash: 0 } });
    const enrolled = enrolledCourseIds(student);
    const assigned = await assignments.find(enrolled.length ? { $or: [{ courseId: { $in: enrolled.map(x => new ObjectId(x)) } }, { courseId: null }] } : { courseId: null }).sort({ createdAt: -1 }).limit(20).toArray();
    const rows = [];
    for (const a of assigned) {
      const course = a.courseId ? await courseCollection.findOne({ _id: a.courseId }) : null;
      const sub = await submissions.findOne({ assignmentId: a._id, studentId: userId });
      rows.push({
        title: a.title,
        course: course?.title || "General",
        dueDate: a.dueDate || null,
        submitted: !!sub,
        grade: sub?.grade || null,
        feedback: sub?.feedback || null
      });
    }
    const availableCourses = enrolled.length ? await courseCollection.find({ _id: { $in: enrolled.map(x => new ObjectId(x)) } }).sort({ title: 1 }).toArray() : [];
    return {
      student: { name: student?.name || "Student", email: student?.email || "", paymentStatus: student?.paymentStatus || "" },
      courses: availableCourses.map(c => ({ title: c.title, locked: !!c.locked })),
      assignments: rows
    };
  }

  async function findAssignments(query, studentId) {
    const q = String(query || "").toLowerCase();
    const student = await users.findOne({ _id: studentId });
    const enrolled = enrolledCourseIds(student);
    const list = await assignments.find(enrolled.length ? { $or: [{ courseId: { $in: enrolled.map(x => new ObjectId(x)) } }, { courseId: null }] } : { courseId: null }).sort({ createdAt: -1 }).toArray();
    const matches = [];
    for (const a of list) {
      const course = a.courseId ? await courseCollection.findOne({ _id: a.courseId }) : null;
      const text = `${a.title} ${a.instructions} ${course?.title || ""}`.toLowerCase();
      if (!q || q.split(/\s+/).some(w => w.length > 2 && text.includes(w))) {
        const sub = await submissions.findOne({ assignmentId: a._id, studentId });
        matches.push({ title: a.title, instructions: a.instructions, course: course?.title || "General", dueDate: a.dueDate || null, submitted: !!sub, grade: sub?.grade || null });
      }
      if (matches.length >= 5) break;
    }
    return { assignments: matches };
  }


  async function generateAIImage(prompt, userId) {
    if (!openai) throw new Error("AI is not configured.");
    const result = await openai.images.generate({ model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2", prompt: String(prompt).slice(0, 4000), size: "1024x1024" });
    const b64 = result?.data?.[0]?.b64_json;
    if (!b64) throw new Error("The image service did not return an image.");
    const uploaded = await uploadGenerated(Buffer.from(b64, "base64"), `image-${Date.now()}`, "image", "png");
    const downloadUrl = cloudinaryDownloadUrl(uploaded);
    const artifact = { userId, type: "image", title: String(prompt).slice(0, 100), url: downloadUrl, previewUrl: uploaded.secure_url, publicId: uploaded.public_id, createdAt: new Date() };
    const saved = await aiArtifacts.insertOne(artifact);
    return { id: saved.insertedId.toString(), type: artifact.type, title: artifact.title, url: downloadUrl, previewUrl: uploaded.secure_url };
  }

  async function generateAIDocument(title, content, format, userId) {
    const safeFormat = format === "docx" ? "docx" : "pdf";
    const buffer = safeFormat === "docx" ? await createDocxBuffer(title, content) : await createPdfBuffer(title, content);
    const uploaded = await uploadGenerated(buffer, `document-${Date.now()}-${safeFormat}`, "raw", safeFormat);
    const url = cloudinaryDownloadUrl(uploaded);
    const artifact = { userId, type: "document", format: safeFormat, title: String(title || "SMARTTEP ACADEMY Document").slice(0, 200), url, publicId: uploaded.public_id, createdAt: new Date() };
    const saved = await aiArtifacts.insertOne(artifact);
    return { id: saved.insertedId.toString(), type: "document", format: safeFormat, title: artifact.title, url };
  }

  async function startAIVideo(prompt, userId, quota = null) {
    if (!process.env.OPENAI_API_KEY) throw new Error("AI is not configured.");
    const form = new FormData();
    form.append("model", process.env.OPENAI_VIDEO_MODEL || "sora-2");
    form.append("prompt", String(prompt).slice(0, 4000));
    form.append("seconds", "4");
    form.append("size", process.env.OPENAI_VIDEO_SIZE || "1280x720");
    const response = await fetch("https://api.openai.com/v1/videos", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || "Video generation request failed.");
    await aiArtifacts.insertOne({ userId, type: "video", jobId: data.id, title: String(prompt).slice(0, 100), status: data.status || "queued", progress: data.progress || 0, quotaCost: quota?.cost || 0, quotaDateKey: aiDateKey(), quotaRefunded: false, createdAt: new Date(), updatedAt: new Date() });
    return { id: data.id, type: "video", status: data.status || "queued", progress: data.progress || 0, statusUrl: `/api/ai/video/${data.id}` };
  }

  async function refreshAIVideo(jobId, userId) {
    const artifact = await aiArtifacts.findOne({ jobId, userId, type: "video" });
    if (!artifact) throw new Error("Video job not found.");
    const response = await fetch(`https://api.openai.com/v1/videos/${encodeURIComponent(jobId)}`, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || "Could not check video status.");
    if (data.status === "completed" && !artifact.url) {
      const media = await fetch(`https://api.openai.com/v1/videos/${encodeURIComponent(jobId)}/content`, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
      if (!media.ok) throw new Error("Video finished but its media could not be downloaded yet.");
      const buffer = Buffer.from(await media.arrayBuffer());
      const uploaded = await uploadGenerated(buffer, `video-${jobId}`, "video", "mp4");
      const url = cloudinaryDownloadUrl(uploaded);
      await aiArtifacts.updateOne({ _id: artifact._id }, { $set: { status: "completed", progress: 100, url, previewUrl: uploaded.secure_url, publicId: uploaded.public_id, updatedAt: new Date() } });
      return { id: jobId, type: "video", status: "completed", progress: 100, url, previewUrl: uploaded.secure_url };
    }
    if (["failed", "canceled"].includes(data.status) && !artifact.quotaRefunded && artifact.quotaCost) {
      await refundAICredits(userId ? { _id: userId, role: "student" } : { _id: userId, role: "student" }, "video", artifact.quotaCost, artifact.quotaDateKey);
      await aiArtifacts.updateOne({ _id: artifact._id }, { $set: { quotaRefunded: true } });
    }
    await aiArtifacts.updateOne({ _id: artifact._id }, { $set: { status: data.status, progress: data.progress || 0, error: data.error || null, updatedAt: new Date() } });
    return { id: jobId, type: "video", status: data.status, progress: data.progress || 0, error: data.error?.message || null, url: artifact.url || null };
  }

  async function getLearningOverview(studentId, studentUser = null) {
    const student = studentUser || await users.findOne({ _id: studentId });
    const enrolled = enrolledCourseIds(student);
    const availableCourses = enrolled.length ? await courseCollection.find({ _id: { $in: enrolled.map(x => new ObjectId(x)) }, locked: false }).sort({ title: 1 }).toArray() : [];
    const courseRows = [];
    let totalLessons = 0, completedLessons = 0;
    for (const c of availableCourses) {
      const ls = await lessons.find({ courseId: c._id }).sort({ createdAt: 1 }).toArray();
      const ids = ls.map(l => l._id);
      const progressRows = ids.length ? await lessonProgress.find({ userId: studentId, lessonId: { $in: ids } }).toArray() : [];
      const progressMap = new Map(progressRows.map(x => [String(x.lessonId), x]));
      const lessonItems = await Promise.all(ls.map(async l => {
        const state = await lessonAccessState(student, l, c, ls);
        const p = progressMap.get(String(l._id));
        return { id: l._id.toString(), title: l.title, completed: !!p?.completed, accessed: !!(p?.accessedAt || p?.completed), locked: !state.allowed, lock_reason: state.reason, unlock_at: l.unlockAt || null, note_path: l.note?.url ? `/api/learning/lessons/${l._id}/note` : '', video_path: l.video?.url ? `/api/learning/lessons/${l._id}/media/video` : '', audio_path: l.audio?.url ? `/api/learning/lessons/${l._id}/media/audio` : '' };
      }));
      const doneSet = new Set(progressRows.filter(x => x.completed).map(x => String(x.lessonId)));
      totalLessons += ls.length; completedLessons += doneSet.size;
      courseRows.push({ id: c._id.toString(), title: c.title, description: c.description || '', lessonCount: ls.length, completed: doneSet.size, locked: !!c.locked, lessons: lessonItems });
    }
    const recentQuizzes = await quizAttempts.find({ userId: studentId }).sort({ createdAt: -1 }).limit(5).toArray();
    return { courses: courseRows, totals: { totalLessons, completedLessons, percent: totalLessons ? Math.round(completedLessons / totalLessons * 100) : 0 }, recentQuizzes: recentQuizzes.map(q => ({ title: q.title, score: q.score, total: q.total, createdAt: q.createdAt })) };
  }

  async function getRecommendedLessons(studentId) {
    const overview = await getLearningOverview(studentId);
    const recommendations = [];
    for (const c of overview.courses) {
      if (c.locked || !c.lessons.length) continue;
      const next = c.lessons.find(l => !l.completed);
      if (next) recommendations.push({ courseId: c.id, course: c.title, lessonId: next.id, lesson: next.title, reason: c.completed === 0 ? 'Start this course' : 'Continue where you left off' });
    }
    return recommendations.slice(0, 6);
  }

  app.get("/api/learning/overview", auth, studentAccess, async (req, res, next) => {
    try { res.json(await getLearningOverview(req.user._id)); } catch (e) { next(e); }
  });

  app.post("/api/learning/lessons/:id/progress", auth, studentAccess, async (req, res, next) => {
    try {
      const lessonId = oid(req.params.id); if (!lessonId) return res.status(400).json({ error: 'Invalid lesson id' });
      const lesson = await lessons.findOne({ _id: lessonId }); if (!lesson) return res.status(404).json({ error: 'Lesson not found' });
      const course = await courseCollection.findOne({ _id: lesson.courseId });
      if (!course || course.locked) return res.status(423).json({ error: 'This course is locked.' });
      if (!studentHasCourse(req.user, course._id)) return res.status(403).json({ error: 'You are not registered for this course.' });
      const completed = req.body.completed !== false;
      await lessonProgress.updateOne({ userId: req.user._id, lessonId }, { $set: { userId: req.user._id, lessonId, courseId: lesson.courseId, completed, accessedAt: new Date(), updatedAt: new Date(), ...(completed ? { completedAt: new Date() } : {}) } }, { upsert: true });
      res.json({ ok: true, completed });
    } catch (e) { next(e); }
  });

  app.get("/api/learning/recommendations", auth, studentAccess, async (req, res, next) => {
    try { res.json({ recommendations: await getRecommendedLessons(req.user._id) }); } catch (e) { next(e); }
  });

  app.get("/api/learning/quizzes", auth, studentAccess, async (req, res, next) => {
    try {
      const rows = await quizAttempts.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(20).toArray();
      res.json({ quizzes: rows.map(q => ({ id: q._id.toString(), title: q.title, score: q.score, total: q.total, percent: q.total ? Math.round(q.score/q.total*100) : 0, createdAt: q.createdAt })) });
    } catch (e) { next(e); }
  });

  app.post("/api/ai/quiz", rateLimit({ windowMs: 60 * 1000, max: 10, keyPrefix: "ai-quiz" }), auth, studentAccess, async (req, res, next) => {
    let quota;
    try {
      if (!aiEnabled) return res.status(503).json({ error: 'AI Tutor is not configured.' });
      quota = await requireAICredits(req, res, "quiz"); if (!quota) return;
      const topic = String(req.body.topic || '').trim().slice(0, 200) || 'Web Development';
      const count = Math.min(Math.max(Number(req.body.count) || 10, 3), 20);
      const difficulty = ['beginner','intermediate','advanced'].includes(req.body.difficulty) ? req.body.difficulty : 'beginner';
      const material = await searchAcademyMaterial(topic, req.user._id);
      const prompt = `Create a ${count}-question multiple-choice quiz for a SMARTTEP ACADEMY student. Topic: ${topic}. Difficulty: ${difficulty}. Use these academy search results when relevant: ${JSON.stringify(material.results)}. Return ONLY valid JSON with this shape: {"title":"...","questions":[{"question":"...","options":["A","B","C","D"],"answer":0,"explanation":"..."}]}. answer must be the zero-based correct option index. Keep explanations concise.`;
      const result = await generateTutorText({ user: req.user, prompt });
      let raw = result.text.trim().replace(/^```json\s*/i,'').replace(/```$/,'').trim();
      const start = raw.indexOf('{'), end = raw.lastIndexOf('}'); if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
      const quiz = JSON.parse(raw);
      if (!Array.isArray(quiz.questions) || !quiz.questions.length) throw new Error('AI returned an invalid quiz.');
      quiz.questions = quiz.questions.slice(0, count).map(q => {
        const options = Array.isArray(q.options) ? q.options.slice(0, 4).map(String) : [];
        const answer = Math.min(Math.max(Number(q.answer) || 0, 0), Math.max(options.length - 1, 0));
        return { question: String(q.question || "").slice(0, 1000), options, answer, explanation: String(q.explanation || "").slice(0, 1000) };
      }).filter(q => q.question && q.options.length >= 2);
      if (!quiz.questions.length) throw new Error("AI returned an invalid quiz.");
      const quizDoc = { userId: req.user._id, title: String(quiz.title || topic).slice(0, 200), questions: quiz.questions, createdAt: new Date(), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) };
      const saved = await quizzes.insertOne(quizDoc);
      const clientQuiz = { id: saved.insertedId.toString(), title: quizDoc.title, questions: quiz.questions.map(({ answer, explanation, ...q }) => q) };
      res.json({ quiz: clientQuiz, model: AI_MODEL });
    } catch (e) { console.error('Quiz error:', e); if (quota) await refundAICredits(req.user, "quiz", quota.cost); next(e); }
  });

  app.post("/api/learning/quizzes/submit", auth, studentAccess, async (req, res, next) => {
    try {
      const quizId = oid(req.body.quizId);
      const answers = Array.isArray(req.body.answers) ? req.body.answers : [];
      if (!quizId || !answers.length) return res.status(400).json({ error: "Invalid quiz submission." });
      const quiz = await quizzes.findOne({ _id: quizId, userId: req.user._id });
      if (!quiz) return res.status(404).json({ error: "Quiz not found or expired." });
      if (quiz.expiresAt && quiz.expiresAt < new Date()) return res.status(410).json({ error: "This quiz has expired. Please generate a new one." });
      if (answers.length !== quiz.questions.length) return res.status(400).json({ error: "Please answer all quiz questions." });
      let score = 0;
      quiz.questions.forEach((q, i) => { if (Number(answers[i]) === Number(q.answer)) score++; });
      const attempt = { userId: req.user._id, quizId, title: quiz.title, score, total: quiz.questions.length, createdAt: new Date() };
      const saved = await quizAttempts.insertOne(attempt);
      res.json({ ok: true, id: saved.insertedId.toString(), score, total: quiz.questions.length, percent: Math.round(score / quiz.questions.length * 100) });
    } catch (e) { next(e); }
  });

  app.post("/api/ai/study-plan", rateLimit({ windowMs: 60 * 1000, max: 10, keyPrefix: "ai-study-plan" }), auth, studentAccess, async (req, res, next) => {
    let quota;
    try {
      if (!aiEnabled) return res.status(503).json({ error: 'AI Tutor is not configured.' });
      quota = await requireAICredits(req, res, "studyPlan"); if (!quota) return;
      const goal = String(req.body.goal || 'Improve my SMARTTEP ACADEMY skills').trim().slice(0, 500);
      const days = Math.min(Math.max(Number(req.body.days) || 7, 3), 30);
      const overview = await getLearningOverview(req.user._id);
      const prompt = `Create a practical ${days}-day study plan for this SMARTTEP ACADEMY student. Goal: ${goal}. Current progress: ${JSON.stringify(overview)}. Return a concise plan with day-by-day tasks, estimated minutes, and one measurable outcome per day. Do not invent lessons that are not in the supplied progress data.`;
      const result = await generateTutorText({ user: req.user, prompt });
      const saved = await studyPlans.insertOne({ userId: req.user._id, goal, days, plan: result.text, createdAt: new Date() });
      res.json({ id: saved.insertedId.toString(), goal, days, plan: result.text });
    } catch (e) { if (quota) await refundAICredits(req.user, "studyPlan", quota.cost); next(e); }
  });

  app.get("/api/ai/status", auth, studentAccess, async (req, res, next) => {
    try {
      const limits = await getAILimits();
      const dateKey = aiDateKey();
      const usageDoc = await aiUsage.findOne({ userId: req.user._id, dateKey });
      const unlimited = req.user.role === "admin" && limits.unlimitedAdmins;
      const used = Number(usageDoc?.credits || 0);
      res.json({ enabled: aiEnabled, provider: AI_PROVIDER, model: AI_MODEL, backupModel: process.env.HF_TOKEN ? AI_BACKUP_MODEL : null, webSearch: String(process.env.OPENAI_ENABLE_WEB_SEARCH || "false").toLowerCase() === "true", quota: { dailyCredits: limits.dailyCredits, used, remaining: unlimited ? null : Math.max(0, limits.dailyCredits - used), unlimited, costs: limits.costs, dateKey } });
    } catch (e) { next(e); }
  });

  app.get("/api/ai/conversations", auth, studentAccess, async (req, res, next) => {
    try {
      const list = await aiConversations.find({ userId: req.user._id }, { projection: { messages: 0 } }).sort({ updatedAt: -1 }).limit(50).toArray();
      res.json({ conversations: list.map(c => ({ id: c._id.toString(), title: c.title || "New conversation", updatedAt: c.updatedAt })) });
    } catch (e) { next(e); }
  });

  app.get("/api/ai/conversations/:id", auth, studentAccess, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid conversation id" });
      const c = await aiConversations.findOne({ _id: id, userId: req.user._id });
      if (!c) return res.status(404).json({ error: "Conversation not found" });
      res.json({ conversation: { id: c._id.toString(), title: c.title || "New conversation", messages: c.messages || [] } });
    } catch (e) { next(e); }
  });

  app.delete("/api/ai/conversations/:id", auth, studentAccess, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid conversation id" });
      await aiConversations.deleteOne({ _id: id, userId: req.user._id });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.post("/api/ai/speech", rateLimit({ windowMs: 60 * 1000, max: 10, keyPrefix: "ai-speech" }), auth, studentAccess, async (req, res, next) => {
    let quota;
    try {
      const text = String(req.body.text || "").trim();
      if (!process.env.OPENAI_API_KEY) {
        return res.status(200).json({ fallback: true, text, provider: "browser" });
      }
      if (!text) return res.status(400).json({ error: "Text is required.", code: "EMPTY_SPEECH_TEXT" });
      if (text.length > 4096) return res.status(400).json({ error: "Text is too long for one speech request.", code: "SPEECH_TEXT_TOO_LONG" });

      quota = await reserveAICredits(req.user, "speech");
      if (!quota.allowed) {
        return res.status(200).json({ fallback: true, text, provider: "browser", reason: "DAILY_AI_LIMIT" });
      }

      // IMPORTANT: speech is deliberately a direct OpenAI -> Render -> browser
      // path. Do not upload temporary TTS audio to Cloudinary. This removes an
      // extra network hop and avoids Cloudinary delivery/format issues.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);
      let response;
      try {
        response = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
            Accept: "audio/mpeg"
          },
          body: JSON.stringify({
            model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
            voice: process.env.OPENAI_TTS_VOICE || "coral",
            input: text,
            instructions: "Speak in clear, natural English with a light, warm, friendly adult tutoring voice. Use a slightly higher, gentle pitch and avoid a deep, heavy or authoritative tone. Sound natural, calm, encouraging and conversational, like a friendly personal tutor. English is the primary language. Do not switch languages unless the text explicitly requires it.",
            response_format: "mp3"
          }),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const raw = await response.text().catch(() => "");
        let detail = {};
        try { detail = raw ? JSON.parse(raw) : {}; } catch {}
        const upstreamMessage = String(detail?.error?.message || raw || "Speech generation failed.").trim();
        const upstreamCode = String(detail?.error?.code || "").trim();

        // Return a useful JSON error to the browser instead of allowing the
        // generic Express handler to turn it into an unhelpful "Server error".
        if (response.status === 401) {
          const err = new Error("The OpenAI API key was rejected. Check OPENAI_API_KEY on Render.");
          err.status = 502; err.code = "OPENAI_AUTH_ERROR";
          throw err;
        }
        if (response.status === 429 || /credit|quota|billing|no credits|rate limit/i.test(upstreamMessage)) {
          if (quota) {
            try { await refundAICredits(req.user, "speech", quota.cost); } catch (refundError) { console.error("Failed to refund speech credit before browser fallback:", refundError); }
            quota = null;
          }
          return res.status(200).json({ fallback: true, text, provider: "browser", reason: "OPENAI_CREDITS_OR_LIMIT" });
        }
        if (quota) {
          try { await refundAICredits(req.user, "speech", quota.cost); } catch (refundError) { console.error("Failed to refund speech credit before browser fallback:", refundError); }
          quota = null;
        }
        return res.status(200).json({ fallback: true, text, provider: "browser", reason: "OPENAI_SPEECH_ERROR" });
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) {
        const err = new Error("OpenAI returned an empty audio response.");
        err.status = 502; err.code = "EMPTY_SPEECH_RESPONSE";
        throw err;
      }

      // Direct binary MP3 response. Nothing is stored in Cloudinary.
      res.status(200).set({
        "Content-Type": "audio/mpeg",
        "Content-Length": String(buffer.length),
        "Content-Disposition": 'inline; filename="wps-ai-speech.mp3"',
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
        "X-Content-Type-Options": "nosniff",
        "X-WPS-AI-Voice": "direct-openai-tts"
      }).send(buffer);
    } catch (e) {
      if (quota) {
        try { await refundAICredits(req.user, "speech", quota.cost); }
        catch (refundError) { console.error("Failed to refund speech AI credit:", refundError); }
      }
      if (e?.name === "AbortError") {
        return res.status(200).json({ fallback: true, text, provider: "browser", reason: "OPENAI_SPEECH_TIMEOUT" });
      }
      if (e?.status && e?.code) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      next(e);
    }
  });

  app.post("/api/ai/image", rateLimit({ windowMs: 60 * 1000, max: 10, keyPrefix: "ai-image" }), auth, studentAccess, async (req, res, next) => {
    let quota;
    try {
      if (!aiEnabled) return res.status(503).json({ error: "AI Tutor is not configured." });
      const prompt = String(req.body.prompt || "").trim();
      if (!prompt) return res.status(400).json({ error: "Image prompt is required." });
      quota = await requireAICredits(req, res, "image"); if (!quota) return;
      res.json(await generateAIImage(prompt, req.user._id));
    } catch (e) { if (quota) await refundAICredits(req.user, "image", quota.cost); next(e); }
  });

  app.post("/api/ai/document", rateLimit({ windowMs: 60 * 1000, max: 10, keyPrefix: "ai-document" }), auth, studentAccess, async (req, res, next) => {
    let quota;
    try {
      if (!aiEnabled) return res.status(503).json({ error: "AI Tutor is not configured." });
      const title = String(req.body.title || "SMARTTEP ACADEMY Study Document").trim().slice(0, 200);
      const content = String(req.body.content || "").trim().slice(0, 50000);
      const format = req.body.format === "docx" ? "docx" : "pdf";
      if (!content) return res.status(400).json({ error: "Document content is required." });
      quota = await requireAICredits(req, res, "document"); if (!quota) return;
      res.json(await generateAIDocument(title, content, format, req.user._id));
    } catch (e) { if (quota) await refundAICredits(req.user, "document", quota.cost); next(e); }
  });

  app.post("/api/ai/video", rateLimit({ windowMs: 60 * 1000, max: 10, keyPrefix: "ai-video" }), auth, studentAccess, async (req, res, next) => {
    let quota;
    try {
      if (!aiEnabled) return res.status(503).json({ error: "AI Tutor is not configured." });
      const prompt = String(req.body.prompt || "").trim();
      if (!prompt) return res.status(400).json({ error: "Video prompt is required." });
      quota = await requireAICredits(req, res, "video"); if (!quota) return;
      res.json(await startAIVideo(prompt, req.user._id, quota));
    } catch (e) {
      console.error("AI video error:", e);
      if (quota) await refundAICredits(req.user, "video", quota.cost, aiDateKey());
      if (e?.status === 401) return res.status(502).json({ error: "The AI service rejected the API key." });
      res.status(502).json({ error: e.message || "Video generation failed. Your OpenAI project may not have video access enabled." });
    }
  });

  app.get("/api/ai/video/:id", auth, studentAccess, async (req, res, next) => {
    try { res.json(await refreshAIVideo(req.params.id, req.user._id)); }
    catch (e) { next(e); }
  });

  app.get("/api/ai/artifacts", auth, studentAccess, async (req, res, next) => {
    try {
      const list = await aiArtifacts.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(50).toArray();
      res.json({ artifacts: list.map(x => ({ id: x._id.toString(), type: x.type, format: x.format, title: x.title, url: x.url || null, previewUrl: x.previewUrl || null, status: x.status || "completed", progress: x.progress || 0, createdAt: x.createdAt })) });
    } catch (e) { next(e); }
  });

  function aiExplicitGenerationRequest(message, kind) {
    const text = String(message || "").toLowerCase();
    const verbs = /\b(create|generate|make|write|produce|prepare|export|download|draw|design|start|render)\b/;
    if (!verbs.test(text)) return false;
    return kind === "document" ? /\b(pdf|word|docx|document|report|handout|study guide|notes)\b/.test(text) : new RegExp(`\\b${kind}\\b`).test(text);
  }
  function validateAIToolCall(name, args, originalMessage) {
    const allowed = new Set(["search_course_material", "get_student_progress", "get_assignment_details", "generate_image", "generate_document", "generate_video"]);
    if (!allowed.has(name)) throw Object.assign(new Error("AI tool is not authorized."), { status: 403 });
    if (["search_course_material", "get_assignment_details"].includes(name) && String(args?.query || "").length > 1000) throw Object.assign(new Error("AI search query is too long."), { status: 400 });
    if (["generate_image", "generate_document", "generate_video"].includes(name)) {
      const kind = name.replace("generate_", "");
      if (!aiExplicitGenerationRequest(originalMessage, kind)) throw Object.assign(new Error("This AI generation tool requires an explicit request from the student."), { status: 403, code: "EXPLICIT_TOOL_REQUEST_REQUIRED" });
    }
    if (["generate_image", "generate_video"].includes(name) && String(args?.prompt || "").length > 3000) throw Object.assign(new Error("AI generation prompt is too long."), { status: 400 });
    if (name === "generate_document" && (String(args?.title || "").length > 200 || String(args?.content || "").length > 30000)) throw Object.assign(new Error("Generated document content is too large."), { status: 400 });
  }

  app.post("/api/ai/chat", rateLimit({ windowMs: 60 * 1000, max: 20, keyPrefix: "ai-chat" }), auth, studentAccess, aiUpload.single("file"), async (req, res, next) => {
    let quota;
    try {
      if (!aiEnabled) return res.status(503).json({ error: "AI Tutor is not configured. Add OPENAI_API_KEY or HF_TOKEN to your Render environment variables." });
      const message = String(req.body.message || "").trim();
      if (!message && !req.file) return res.status(400).json({ error: "Type a message or attach a file." });
      if (message.length > 5000) return res.status(400).json({ error: "Message is too long. Please keep it under 5,000 characters." });
      quota = await requireAICredits(req, res, "chat"); if (!quota) return;

      const conversationId = req.body.conversationId ? oid(req.body.conversationId) : null;
      let conversation = conversationId ? await aiConversations.findOne({ _id: conversationId, userId: req.user._id }) : null;
      if (conversationId && !conversation) return res.status(404).json({ error: "Conversation not found." });
      if (!conversation) {
        const created = await aiConversations.insertOne({ userId: req.user._id, title: message.slice(0, 70) || "Uploaded file", messages: [], createdAt: new Date(), updatedAt: new Date() });
        conversation = { _id: created.insertedId, messages: [] };
      }

      const userMessage = { role: "user", content: message || `Please analyze the attached file: ${req.file.originalname}`, createdAt: new Date() };
      const prior = conversation.messages || [];
      const messages = [...prior, userMessage].slice(-20);
      const attached = req.file ? [aiFilePart(req.file)] : [];
      const webEnabled = String(process.env.OPENAI_ENABLE_WEB_SEARCH || "false").toLowerCase() === "true";
      let lessonContext = null;
      if (req.body.lessonId) {
        const lessonId = oid(req.body.lessonId);
        if (!lessonId) return res.status(400).json({ error: "Invalid lesson id." });
        const lesson = await lessons.findOne({ _id: lessonId });
        if (!lesson) return res.status(404).json({ error: "Lesson not found." });
        if (!studentHasCourse(req.user, lesson.courseId)) return res.status(403).json({ error: "You are not registered for this lesson's course." });
        const course = await courseCollection.findOne({ _id: lesson.courseId });
        if (course?.locked && req.user.role !== "admin") return res.status(403).json({ error: "This course is currently locked." });
        const lessonAccess = await lessonAccessState(req.user, lesson, course);
        if (!lessonAccess.allowed) return res.status(403).json({ error: "You do not currently have access to this lesson." });
        lessonContext = { lessonId: lesson._id.toString(), title: lesson.title, courseTitle: course?.title || "Unknown", noteUrl: lesson.note?.url || null, noteName: lesson.note?.originalName || null };
      }

      let academyContext = null;
      try {
        const material = await searchAcademyMaterial(message, req.user._id);
        if (material?.results?.length || material?.matchedCourse) academyContext = material;
      } catch (materialError) {
        console.warn("SMARTTEP ACADEMY material lookup failed:", materialError?.message || materialError);
      }

      const result = await createTutorResponse({
        user: req.user,
        messages,
        attachedFiles: attached.filter(Boolean),
        lessonContext,
        academyContext,
        useWeb: webEnabled,
        toolExecutor: async (name, args) => {
          validateAIToolCall(name, args, message);
          await smartRecord(req, { type: "ai-tool-call", severity: "info", score: 0, action: "tool-authorized", aiTool: name });
          if (name === "search_course_material") return searchAcademyMaterial(args.query, req.user._id);
          if (name === "get_student_progress") return getStudentProgress(req.user._id);
          if (name === "get_assignment_details") return findAssignments(args.query, req.user._id);
          if (name === "generate_image") { const q = await reserveAICredits(req.user, "image"); if (!q.allowed) throw Object.assign(new Error(`You have used all ${q.limit} AI credits for today. Your AI credits reset tomorrow.`), { status: 429, code: "DAILY_AI_LIMIT" }); try { return await generateAIImage(args.prompt, req.user._id); } catch (e) { await refundAICredits(req.user, "image", q.cost); throw e; } }
          if (name === "generate_document") { const q = await reserveAICredits(req.user, "document"); if (!q.allowed) throw Object.assign(new Error(`You have used all ${q.limit} AI credits for today. Your AI credits reset tomorrow.`), { status: 429, code: "DAILY_AI_LIMIT" }); try { return await generateAIDocument(args.title, args.content, args.format, req.user._id); } catch (e) { await refundAICredits(req.user, "document", q.cost); throw e; } }
          if (name === "generate_video") { const q = await reserveAICredits(req.user, "video"); if (!q.allowed) throw Object.assign(new Error(`You have used all ${q.limit} AI credits for today. Your AI credits reset tomorrow.`), { status: 429, code: "DAILY_AI_LIMIT" }); try { return await startAIVideo(args.prompt, req.user._id, q); } catch (e) { await refundAICredits(req.user, "video", q.cost); throw e; } }
          throw new Error("Unknown AI tool");
        }
      });

      const assistantMessage = { role: "assistant", content: result.text, createdAt: new Date() };
      try {
        await aiConversations.updateOne(
          { _id: conversation._id, userId: req.user._id },
          { $push: { messages: { $each: [userMessage, assistantMessage], $slice: -100 } }, $set: { updatedAt: new Date(), lastResponseId: result.responseId } }
        );
      } catch (saveError) {
        // A successful AI answer must not be turned into a server error just because conversation history could not be saved.
        console.error("AI conversation save warning:", saveError?.message || saveError);
      }
      res.json({ ok: true, conversationId: conversation._id.toString(), message: assistantMessage });
    } catch (e) {
      console.error("AI Tutor error:", e?.stack || e);
      if (e?.status === 401) { if (quota) await refundAICredits(req.user, "chat", quota.cost); return res.status(502).json({ error: "The AI providers rejected the configured credentials. Check OPENAI_API_KEY and HF_TOKEN on Render." }); }
      if (e?.status === 429) { if (quota) await refundAICredits(req.user, "chat", quota.cost); return res.status(429).json({ error: e?.code === "DAILY_AI_LIMIT" ? e.message : "The AI service is temporarily busy or your API limit was reached. Please try again shortly." }); }
      if (e instanceof multer.MulterError && e.code === "LIMIT_FILE_SIZE") { if (quota) await refundAICredits(req.user, "chat", quota.cost); return res.status(413).json({ error: "AI attachments must be 15 MB or smaller." }); }
      if (quota) await refundAICredits(req.user, "chat", quota.cost);
      return res.status(502).json({ error: "SMARTTEP AI could not complete that request right now. Please try again shortly. If it keeps happening, check the Render server logs for the detailed error." });
    }
  });

  app.get("/api/learning/lessons/:id/context", auth, studentAccess, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid lesson id." });
      const lesson = await lessons.findOne({ _id: id });
      if (!lesson) return res.status(404).json({ error: "Lesson not found." });
      if (!studentHasCourse(req.user, lesson.courseId)) return res.status(403).json({ error: "You are not registered for this lesson's course." });
      const course = await courseCollection.findOne({ _id: lesson.courseId });
      const access = await lessonAccessState(req.user, lesson, course);
      if (!access.allowed) return res.status(423).json({ error: access.reason === "scheduled-lock" && access.unlockAt ? `This lesson is locked until ${new Date(access.unlockAt).toLocaleString()}.` : "This lesson is currently locked by Smart Security." });
      await markLessonAccess(req.user._id, lesson._id, lesson.courseId);
      res.json({ lesson: { id: lesson._id.toString(), title: lesson.title, courseId: lesson.courseId.toString(), courseTitle: course?.title || "Unknown", noteUrl: lesson.note?.url ? `/api/learning/lessons/${lesson._id}/note` : null, videoUrl: lesson.video?.url ? `/api/learning/lessons/${lesson._id}/media/video` : null,
        audioUrl: lesson.audio?.url ? `/api/learning/lessons/${lesson._id}/media/audio` : null } });
    } catch (e) { next(e); }
  });

  // Serve lesson notes through SMARTTEP ACADEMY so downloaded files keep their
  // original filename and correct MIME type (especially DOCX). Cloudinary
  // raw assets can otherwise arrive as application/octet-stream, which some
  // mobile browsers save with a .bin extension.
  app.get("/api/learning/lessons/:id/note", auth, studentAccess, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid lesson id." });
      const lesson = await lessons.findOne({ _id: id });
      if (!lesson) return res.status(404).json({ error: "Lesson not found." });
      if (!studentHasCourse(req.user, lesson.courseId)) return res.status(403).json({ error: "You are not registered for this lesson's course." });
      const course = await courseCollection.findOne({ _id: lesson.courseId });
      const access = await lessonAccessState(req.user, lesson, course);
      if (!access.allowed) return res.status(423).json({ error: access.reason === "scheduled-lock" && access.unlockAt ? `This lesson is locked until ${new Date(access.unlockAt).toLocaleString()}.` : "This lesson is currently locked by Smart Security." });
      await markLessonAccess(req.user._id, lesson._id, lesson.courseId);
      if (!lesson.note?.url) return res.status(404).json({ error: "Lesson note is not available." });

      let upstream;
      try {
        upstream = await fetch(lesson.note.url, { redirect: "follow" });
      } catch (e) {
        console.error("Lesson note upstream fetch failed:", e?.message || e);
        return res.status(502).json({ error: "Could not load the lesson note." });
      }
      if (!upstream.ok) {
        console.error(`Lesson note upstream returned ${upstream.status} for ${lesson.note.url}`);
        return res.status(upstream.status === 404 ? 404 : 502).json({ error: "Lesson note could not be loaded." });
      }

      const filename = path.basename(lesson.note.originalName || "lesson-note") || "lesson-note";
      const ext = path.extname(filename).toLowerCase();
      const mimeTypes = {
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".doc": "application/msword",
        ".pdf": "application/pdf",
        ".txt": "text/plain; charset=utf-8",
        ".md": "text/markdown; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".htm": "text/html; charset=utf-8",
        ".csv": "text/csv; charset=utf-8",
        ".json": "application/json",
        ".rtf": "application/rtf",
        ".odt": "application/vnd.oasis.opendocument.text"
      };
      const contentType = mimeTypes[ext] || upstream.headers.get("content-type") || "application/octet-stream";
      const asciiFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");

      res.status(200);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, max-age=300");
      const contentLength = upstream.headers.get("content-length");
      if (contentLength) res.setHeader("Content-Length", contentLength);

      if (!upstream.body) return res.end();
      Readable.fromWeb(upstream.body).on("error", err => {
        console.error("Lesson note stream failed:", err?.message || err);
        if (!res.headersSent) res.status(502);
        res.end();
      }).pipe(res);
    } catch (e) { next(e); }
  });

  // Stream lesson media through the SMARTTEP ACADEMY server for student playback.
  // This keeps the browser request same-origin and preserves HTTP Range support,
  // while the admin portal can continue opening the direct Cloudinary URL.
  async function streamLessonMedia(req, res, lesson, kind) {
    const media = lesson?.[kind];
    if (!media?.url) return res.status(404).json({ error: `Lesson ${kind} is not available.` });

    let sourceUrl = media.url;
    // Always give browsers a common audio format when Cloudinary can generate
    // one from the stored audio asset. This fixes playback for FLAC/AMR/MKA and
    // other codecs that Android browsers may not support natively.
    if (kind === "audio" && media.publicId) {
      try {
        sourceUrl = cloudinary.url(media.publicId, {
          secure: true,
          resource_type: media.resourceType || "video",
          type: media.type || "upload",
          format: "mp3"
        });
      } catch (e) {
        console.error("Cloudinary audio playback URL generation failed:", e?.message || e);
      }
    }

    const range = req.headers.range;
    const headers = {};
    if (range) headers.Range = range;

    let upstream;
    try {
      upstream = await fetch(sourceUrl, { headers, redirect: "follow" });
    } catch (e) {
      console.error(`Lesson ${kind} upstream fetch failed:`, e?.message || e);
      return res.status(502).json({ error: `Could not load lesson ${kind}.` });
    }

    if (!upstream.ok && upstream.status !== 206) {
      console.error(`Lesson ${kind} upstream returned ${upstream.status} for ${sourceUrl}`);
      return res.status(upstream.status === 404 ? 404 : 502).json({ error: `Lesson ${kind} could not be loaded.` });
    }

    const ext = path.extname(media.originalName || "").toLowerCase();
    const fallbackTypes = {
      video: { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/x-m4v" },
      audio: { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".aac": "audio/aac", ".flac": "audio/flac", ".opus": "audio/ogg", ".amr": "audio/amr", ".aif": "audio/aiff", ".aiff": "audio/aiff", ".caf": "audio/x-caf", ".mka": "audio/x-matroska", ".3gp": "audio/3gpp", ".webm": "audio/webm" }
    };
    const upstreamType = upstream.headers.get("content-type");
    const contentType = kind === "audio"
      ? "audio/mpeg"
      : (upstreamType && upstreamType !== "application/octet-stream"
        ? upstreamType
        : (fallbackTypes[kind]?.[ext] || "video/mp4"));

    res.status(upstream.status);
    res.setHeader("Content-Type", contentType);
    const passthrough = ["content-length", "content-range", "accept-ranges", "etag", "last-modified"];
    for (const name of passthrough) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).on("error", err => {
      console.error(`Lesson ${kind} stream failed:`, err?.message || err);
      if (!res.headersSent) res.status(502);
      res.end();
    }).pipe(res);
  }

  app.get("/api/learning/lessons/:id/media/:kind", auth, studentAccess, async (req, res, next) => {
    try {
      const lessonId = oid(req.params.id);
      const kind = req.params.kind === "audio" ? "audio" : req.params.kind === "video" ? "video" : null;
      if (!lessonId || !kind) return res.status(400).json({ error: "Invalid lesson media request." });
      const lesson = await lessons.findOne({ _id: lessonId });
      if (!lesson) return res.status(404).json({ error: "Lesson not found." });
      const course = await courseCollection.findOne({ _id: lesson.courseId });
      if (!course) return res.status(404).json({ error: "Course not found." });
      if (!studentHasCourse(req.user, course._id)) return res.status(403).json({ error: "You are not registered for this course." });
      const access = await lessonAccessState(req.user, lesson, course);
      if (!access.allowed) return res.status(423).json({ error: access.reason === "scheduled-lock" && access.unlockAt ? `This lesson is locked until ${new Date(access.unlockAt).toLocaleString()}.` : "This lesson is currently locked by Smart Security." });
      await markLessonAccess(req.user._id, lesson._id, lesson.courseId);
      await streamLessonMedia(req, res, lesson, kind);
    } catch (e) { next(e); }
  });

  app.get("/api/courses/:id/content", auth, studentAccess, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid course id" });
      const course = await courseCollection.findOne({ _id: id });
      if (!course) return res.status(404).json({ error: "Course not found" });
      if (course.locked && req.user.role !== "admin" && !(req.user.role === "instructor" && String(course.ownerInstructorId) === String(req.user._id))) return res.status(423).json({ error: "This course is locked." });
      const isCourseOwner = req.user.role === "instructor" && String(course.ownerInstructorId) === String(req.user._id);
      if (!isCourseOwner && req.user.role !== "admin" && !studentHasCourse(req.user, course._id)) return res.status(403).json({ error: "You are not registered for this course." });
      const list = await lessons.find({ courseId: id }).sort({ createdAt: 1, _id: 1 }).toArray();
      const progress = await lessonProgress.find({ userId: req.user._id, lessonId: { $in: list.map(l => l._id) } }).toArray();
      const progressMap = new Map(progress.map(p => [String(p.lessonId), p]));
      const lessonRows = await Promise.all(list.map(async l => {
        const p = progressMap.get(String(l._id));
        const access = await lessonAccessState(req.user, l, course, list);
        return { id: l._id.toString(), title: l.title, note_path: l.note?.url ? `/api/learning/lessons/${l._id}/note` : "", video_path: l.video?.url ? `/api/learning/lessons/${l._id}/media/video` : "", audio_path: l.audio?.url ? `/api/learning/lessons/${l._id}/media/audio` : "", completed: !!p?.completed, accessed: !!(p?.accessedAt || p?.completed), locked: !access.allowed, lock_reason: access.reason, unlock_at: l.unlockAt || null };
      }));
      res.json({ course: { id: course._id.toString(), title: course.title, description: course.description, locked: !!course.locked }, lessons: lessonRows });
    } catch (e) { next(e); }
  });

  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "File is too large. Maximum upload size is 100 MB (AI attachments: 15 MB)." });
    if (err?.code === "UNSAFE_FILE_CONTENT") return res.status(400).json({ error: err.message || "Uploaded file content was rejected by security checks." });
    res.status(500).json({ error: "Server error. Please try again." });
  });

  app.listen(PORT, () => {
    console.log(`SMARTTEP ACADEMY running on port ${PORT}`);
    console.log(`MongoDB database: ${DB_NAME}`);
    console.log(`Admin: ${adminEmail}`);
  });
}

start().catch(err => {
  console.error("Failed to start SMARTTEP ACADEMY:", err);
  process.exit(1);
});
