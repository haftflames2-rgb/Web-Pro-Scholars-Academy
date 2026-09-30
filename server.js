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
const { Readable } = require("stream");
const PDFDocument = require("pdfkit");
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require("docx");
const { createTutorResponse, generateTutorText, enabled: aiEnabled, MODEL: AI_MODEL, BACKUP_MODEL: AI_BACKUP_MODEL, PROVIDER: AI_PROVIDER, client: openai } = require("./aiService");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const MEDIA_FIX_VERSION = "2026-09-21-chat-media11-whatsapp-media";

// Smart inactivity protection: students are automatically portal-locked after
// 48 hours without real activity. No new Render environment variable is needed.
const STUDENT_IDLE_LOCK_MS = 48 * 60 * 60 * 1000;
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

const profileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

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
let chatConversations;
let chatMessages;
let securityEvents;
let securityBlocks;

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
  // Use the exact secure URL returned by Cloudinary first. This avoids
  // generating a second delivery URL that may request a transformation
  // unavailable for a particular uploaded codec/container.
  if (media?.url) return media.url;
  if (!media?.publicId) return null;
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
    doc.fontSize(20).text(title || "WPS Academy Document", { align: "center" });
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
  const children = [new Paragraph({ text: title || "WPS Academy Document", heading: HeadingLevel.TITLE })];
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

  await users.createIndex({ email: 1 }, { unique: true });
  await users.createIndex({ studentIdNumber: 1 }, { unique: true, sparse: true });
  await users.createIndex({ role: 1, name: 1 });
  await courseCollection.createIndex({ ownerInstructorId: 1, createdAt: -1 });
  await instructorApplications.createIndex({ userId: 1 }, { unique: true });
  await instructorApplications.createIndex({ status: 1, createdAt: -1 });
  await instructorSecurityEvents.createIndex({ instructorId: 1, createdAt: -1 });
  await instructorSecurityAlerts.createIndex({ status: 1, createdAt: -1 });
  await instructorSecurityAlerts.createIndex({ instructorId: 1, createdAt: -1 });
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
  // Smart blocks are keyed by the opaque device identifier, not the public IP.
  // Drop the old IP-unique index so multiple devices behind one NAT can coexist.
  try { await securityBlocks.dropIndex("ip_1"); } catch (_) {}
  // Legacy Smart versions stored active blocks by IP only. They are deliberately
  // removed from enforcement after this upgrade because keeping them would
  // preserve the shared-IP false-positive problem this fix is addressing.
  await securityBlocks.deleteMany({ deviceKey: { $exists: false } });
  await securityBlocks.createIndex({ deviceKey: 1 }, { unique: true, partialFilterExpression: { deviceKey: { $type: "string" } } });
  await securityBlocks.createIndex({ until: 1 });
  await users.createIndex({ role: 1, portalLocked: 1, lastActivityAt: 1 });

  // Start inactivity tracking for older student accounts without changing their
  // current access state. Their 48-hour clock begins when this version first runs.
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

  const defaultSmartSecurity = {
    _id: "smart_security",
    enabled: true,
    mode: "monitor",
    autoBlockHighRisk: false,
    autoBlockCritical: true,
    requireApprovalForCritical: false,
    blockDurationMinutes: 1440,
    retentionDays: 30,
    securityPolicyVersion: 4,
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
    { _id: "smart_security", $or: [{ securityPolicyVersion: { $exists: false } }, { securityPolicyVersion: { $lt: 4 } }] },
    { $set: { mode: "auto", autoBlockHighRisk: true, autoBlockCritical: true, requireApprovalForCritical: false, securityPolicyVersion: 4, blockDurationMinutes: 1440, updatedAt: new Date() } }
  );

  const adminEmail = (process.env.ADMIN_EMAIL || "admin@wpsacademy.com").trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD;
  const hash = await bcrypt.hash(adminPassword, 12);
  await users.updateOne(
    { email: adminEmail },
    { $setOnInsert: { name: "WPS Administrator", email: adminEmail, passwordHash: hash, role: "admin", portalLocked: false, paymentStatus: "paid", approved: true, createdAt: new Date() } },
    { upsert: true }
  );

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
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

  app.use(session({
    store: MongoStore.create({
      mongoUrl: MONGODB_URI,
      dbName: DB_NAME,
      collectionName: "sessions",
      ttl: 60 * 60 * 24 * 7
    }),
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
  async function smartIsBlocked(deviceKey) {
    const cachedUntil = smartBlocked.get(deviceKey);
    if (cachedUntil) {
      if (cachedUntil > Date.now()) return true;
      smartBlocked.delete(deviceKey);
    }
    try {
      const row = await securityBlocks.findOne({ deviceKey });
      if (!row) return false;
      if (new Date(row.until).getTime() <= Date.now()) {
        await securityBlocks.deleteOne({ _id: row._id });
        return false;
      }
      smartBlocked.set(deviceKey, new Date(row.until).getTime());
      return true;
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
    if (await smartIsBlocked(deviceKey)) return res.status(403).json({ error: "This device has been temporarily blocked by Smart Security." });
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

  app.use(express.static(path.join(ROOT, "public")));

  function isStudentIdle(user, now = Date.now()) {
    if (!user || user.role !== "student" || user.portalLocked) return false;
    const last = user.lastActivityAt ? new Date(user.lastActivityAt).getTime() : now;
    return Number.isFinite(last) && (now - last) >= STUDENT_IDLE_LOCK_MS;
  }

  async function autoLockIdleStudent(user, reason = "48-hour inactivity") {
    if (!user || user.role !== "student" || user.portalLocked) return false;
    if (!isStudentIdle(user)) return false;
    const now = new Date();
    const result = await users.updateOne(
      { _id: user._id, role: "student", portalLocked: { $ne: true }, lastActivityAt: user.lastActivityAt || null },
      { $set: { portalLocked: true, lockSource: "smart-inactivity", inactivityLockedAt: now, lockReason: reason } }
    );
    return result.modifiedCount === 1;
  }

  async function touchStudentActivity(userId) {
    const id = oid(userId);
    if (!id) return null;
    const user = await users.findOne({ _id: id });
    if (!user) return null;
    // Never silently unlock a manually/admin-locked account.
    if (user.role !== "student" || user.portalLocked) return user;
    const now = new Date();
    await users.updateOne({ _id: id }, { $set: { lastActivityAt: now } });
    user.lastActivityAt = now;
    return user;
  }

  async function enforceStudentInactivity() {
    const cutoff = new Date(Date.now() - STUDENT_IDLE_LOCK_MS);
    const result = await users.updateMany(
      { role: "student", portalLocked: { $ne: true }, lastActivityAt: { $exists: true, $lte: cutoff } },
      { $set: { portalLocked: true, lockSource: "smart-inactivity", inactivityLockedAt: new Date(), lockReason: "48-hour inactivity" } }
    );
    if (result.modifiedCount) console.log(`Smart inactivity: locked ${result.modifiedCount} student account(s) after 48 hours of inactivity.`);
    return result.modifiedCount || 0;
  }

  // Check periodically while the server is awake. The auth/API checks below
  // also enforce the rule immediately after a sleeping Render instance wakes.
  const inactivityTimer = setInterval(() => {
    enforceStudentInactivity().catch(err => console.error("Smart inactivity check failed:", err?.message || err));
  }, STUDENT_IDLE_CHECK_MS);
  inactivityTimer.unref();

  function auth(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: "Authentication required" });
    const id = oid(req.session.userId);
    if (!id) return res.status(401).json({ error: "Session expired" });
    users.findOne({ _id: id }).then(async user => {
      if (!user) return res.status(401).json({ error: "Session expired" });
      if (await autoLockIdleStudent(user)) {
        user.portalLocked = true;
        user.lockSource = "smart-inactivity";
        user.lockReason = "48-hour inactivity";
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
      await touchStudentActivity(req.session.userId);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  function admin(req, res, next) {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
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

  function studentAccess(req, res, next) {
    if (req.user.role === "admin") return next();
    if (req.user.portalLocked) return res.status(423).json({ error: "Your student portal is locked by an administrator." });
    if (!req.user.approved) return res.status(403).json({ error: "Your account is awaiting admin approval." });
    next();
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
      const candidate = `WPS-${new Date().getUTCFullYear()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      if (!(await users.findOne({ studentIdNumber: candidate }, { projection: { _id: 1 } }))) return candidate;
    }
    throw Object.assign(new Error("Could not generate a unique student ID number."), { status: 500 });
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
      res.json({ ok: true, redirect: "/payment.html" });
    } catch (e) {
      if (e && e.code === 11000) return res.status(400).json({ error: "Email already registered." });
      next(e);
    }
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
        user.lockReason = "48-hour inactivity";
      }
      if (user.role === "student" && user.portalLocked) {
        return res.status(423).json({ error: user.lockSource === "smart-inactivity" ? "Your account has been automatically locked after 48 hours without activity. Please contact the administrator." : "Your student portal is locked by an administrator." });
      }
      // Regenerate the session after successful authentication to prevent
      // session-fixation attacks, then attach the authenticated user.
      await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
      req.session.userId = user._id.toString();
      if (user.role === "student") await touchStudentActivity(user._id);
      await smartRecord(req, { type: "login-success", severity: "info", score: 0, action: "logged" });
      res.json({ ok: true, redirect: user.role === "admin" ? "/admin.html" : user.role === "instructor" ? "/instructor.html" : "/index.html" });
    } catch (e) { next(e); }
  });
  app.post("/api/logout", (req, res) => {
    req.session.destroy(() => {
      res.clearCookie("connect.sid", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
      res.json({ ok: true, redirect: "/index.html" });
    });
  });

  // WPS Academy Chat — WhatsApp-style messaging using the existing login/session,
  // MongoDB and Cloudinary infrastructure. Messages are delivered near-real-time
  // through lightweight polling, so no extra WebSocket service is required on Render.
  function chatUserView(user) {
    return { id: user._id.toString(), name: user.name || "WPS Academy User", email: user.email || "", role: user.role || "student", profile_picture_url: user.profilePicture ? `/api/chat/profile-picture/${user._id.toString()}` : null };
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

  // WPS Chat profile images are served through the LMS origin instead of
  // exposing/loading Cloudinary delivery URLs directly in the chat UI.
  app.get("/api/chat/profile-picture/:id", auth, studentAccess, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).end();
      const user = await users.findOne({ _id: id }, { projection: { role: 1, approved: 1, portalLocked: 1, profilePicture: 1 } });
      if (!user) return res.status(404).end();
      if (user.role !== "admin" && (!user.approved || user.portalLocked)) return res.status(404).end();

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

  app.get("/api/chat/users", auth, studentAccess, async (req, res, next) => {
    try {
      const filter = { _id: { $ne: req.user._id }, $or: [{ role: "admin" }, { role: "student", approved: true, portalLocked: { $ne: true } }] };
      const list = await users.find(filter, { projection: { name: 1, email: 1, role: 1, profilePicture: 1 } }).sort({ role: -1, name: 1 }).limit(500).toArray();
      res.json({ users: list.map(chatUserView) });
    } catch (e) { next(e); }
  });

  app.get("/api/chat/conversations", auth, studentAccess, async (req, res, next) => {
    try {
      const rows = await chatConversations.find({ members: req.user._id }).sort({ lastMessageAt: -1, updatedAt: -1 }).limit(100).toArray();
      const conversations = [];
      for (const row of rows) conversations.push(await getChatConversationView(row, req.user._id));
      res.json({ conversations });
    } catch (e) { next(e); }
  });

  app.post("/api/chat/direct", rateLimit({ windowMs: 60 * 1000, max: 30, keyPrefix: "chat-direct" }), auth, studentAccess, async (req, res, next) => {
    try {
      const otherId = oid(req.body?.userId);
      if (!otherId || String(otherId) === String(req.user._id)) return res.status(400).json({ error: "Choose another user to start a chat." });
      const other = await users.findOne({ _id: otherId }, { projection: { name: 1, email: 1, role: 1, approved: 1, portalLocked: 1 } });
      if (!other || (other.role !== "admin" && (!other.approved || other.portalLocked))) return res.status(404).json({ error: "That user is not available for chat." });
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

  app.post("/api/chat/groups", rateLimit({ windowMs: 60 * 1000, max: 10, keyPrefix: "chat-group" }), auth, studentAccess, async (req, res, next) => {
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

  app.get("/api/chat/conversations/:id/messages", auth, studentAccess, async (req, res, next) => {
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
        senderName: senderMap.get(String(m.senderId))?.name || "WPS Academy User",
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

  app.post("/api/chat/conversations/:id/messages", rateLimit({ windowMs: 10 * 1000, max: 30, keyPrefix: "chat-message" }), auth, studentAccess, async (req, res, next) => {
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

  app.post("/api/chat/conversations/:id/attachments", rateLimit({ windowMs: 60 * 1000, max: 20, keyPrefix: "chat-attachment" }), auth, studentAccess, upload.single("file"), async (req, res, next) => {
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
      senderName: sender?.name || "WPS Academy User",
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

  app.post("/api/chat/conversations/:conversationId/messages/:messageId/reply", auth, studentAccess, async (req, res, next) => {
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

  app.delete("/api/chat/conversations/:conversationId/messages/:messageId", auth, studentAccess, async (req, res, next) => {
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
  app.get("/api/chat/attachments/:messageId/media/:kind", auth, studentAccess, async (req, res, next) => {
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

  app.get("/api/chat/attachments/:messageId/content", auth, studentAccess, async (req, res, next) => {
    try { await streamChatAttachment(req, res, req.params.messageId, "inline"); } catch (e) { next(e); }
  });

  app.get("/api/chat/attachments/:messageId/download", auth, studentAccess, async (req, res, next) => {
    try { await streamChatAttachment(req, res, req.params.messageId, "attachment"); } catch (e) { next(e); }
  });

  app.post("/api/chat/conversations/:id/read", auth, studentAccess, async (req, res, next) => {
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
        user.lockReason = "48-hour inactivity";
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
      res.json({ results: rows.map(u => ({ verified: true, name: u.name || "", student_id_number: u.studentIdNumber || "", course_code: u.courseCode || "", registration_date: u.registrationDate || "", programme_end_date: u.programmeEndDate || "", state: u.state || "", country: u.country || "", gender: u.gender || "", profile_picture_url: (u.profilePicture ? `/api/verify-student/profile-picture/${u._id.toString()}` : null), status: "Verified WPS Academy student" })) });
    } catch (e) { next(e); }
  });

  app.get("/api/public-courses", async (req, res, next) => {
    try {
      const list = await courseCollection.find({}).sort({ title: 1 }).toArray();
      res.json({ courses: list.map(c => ({ id: c._id.toString(), title: c.title, description: c.description, price: Number(c.price || 0), thumbnail: c.thumbnail || "", instructor_owned: !!c.ownerInstructorId })) });
    } catch (e) { next(e); }
  });

  app.get("/api/courses", async (req, res, next) => {
    try {
      const list = await courseCollection.find({}).sort({ title: 1 }).toArray();
      let viewer = req.user || null;
      if (!viewer && req.session.userId) { const sid = oid(req.session.userId); if (sid) viewer = await users.findOne({ _id: sid }); }
      const filtered = viewer && viewer.role !== "admin" ? list.filter(c => studentHasCourse(viewer, c._id)) : list;
      res.json({ courses: filtered.map(c => ({ id: c._id.toString(), title: c.title, description: c.description, price: Number(c.price || 0), thumbnail: c.thumbnail || "", locked: !!c.locked, registered: viewer?.role === "admin" ? true : !!viewer && studentHasCourse(viewer, c._id), instructor_owned: !!c.ownerInstructorId, owner_instructor_id: c.ownerInstructorId ? String(c.ownerInstructorId) : null })) });
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
  app.get("/api/instructor/status", auth, async (req, res, next) => {
    try {
      const application = await instructorApplications.findOne({ $or: [{ userId: req.user._id }, { userIdString: String(req.user._id) }] }, { sort: { updatedAt: -1, createdAt: -1 } });
      const courses = req.user.role === "instructor"
        ? await courseCollection.countDocuments({ ownerInstructorId: req.user._id.toString() })
        : 0;
      res.json({
        role: req.user.role,
        approved: req.user.role === "instructor" && req.user.instructorApproved !== false && !req.user.instructorSuspended,
        suspended: !!req.user.instructorSuspended,
        application: application ? { status: application.status, message: application.message || "", createdAt: application.createdAt } : null,
        courseCount: courses
      });
    } catch (e) { next(e); }
  });

  app.post("/api/instructor/apply", auth, async (req, res, next) => {
    try {
      if (req.user.role === "admin") return res.status(400).json({ error: "Administrator accounts do not need instructor approval." });
      if (req.user.role === "instructor") return res.status(400).json({ error: "This account is already an instructor." });
      const existing = await instructorApplications.findOne({ $or: [{ userId: req.user._id }, { userIdString: String(req.user._id) }] }, { sort: { updatedAt: -1, createdAt: -1 } });
      if (existing?.status === "pending") return res.status(409).json({ error: "Your instructor application is already awaiting admin review." });
      const message = String(req.body.message || "").trim().slice(0, 2000);
      const teachingTopics = String(req.body.teachingTopics || "").trim().slice(0, 1000);
      if (!teachingTopics || !message) return res.status(400).json({ error: "Please provide both what you want to teach and your teaching plan/experience." });
      const now = new Date();
      const filter = existing ? { _id: existing._id } : { userId: req.user._id };
      const update = { $set: { userId: req.user._id, userIdString: String(req.user._id), name: req.user.name || "", email: req.user.email || "", message, teachingTopics, status: "pending", updatedAt: now }, $setOnInsert: { createdAt: now } };
      await instructorApplications.updateOne(filter, update, { upsert: true });
      const application = await instructorApplications.findOne(filter);
      console.log(`Instructor application submitted: ${req.user.email || req.user._id} (${application?._id || "unknown"})`);
      res.json({ ok: true, applicationId: application?._id?.toString() || null, status: "pending", message: "Instructor application submitted successfully. Please wait for administrator approval." });
    } catch (e) { next(e); }
  });

  app.get("/api/instructor/courses", auth, instructor, async (req, res, next) => {
    try {
      const list = await courseCollection.find({ ownerInstructorId: req.user._id.toString() }).sort({ createdAt: -1 }).toArray();
      res.json({ courses: list.map(c => ({ id: c._id.toString(), title: c.title, description: c.description || "", price: Number(c.price || 0), thumbnail: c.thumbnail || "", locked: !!c.locked, createdAt: c.createdAt })) });
    } catch (e) { next(e); }
  });

  app.post("/api/instructor/courses", auth, instructor, async (req, res, next) => {
    try {
      const title = String(req.body.title || "").trim().slice(0, 120);
      const description = String(req.body.description || "").trim().slice(0, 2000);
      const price = Number(req.body.price || 0);
      const thumbnail = String(req.body.thumbnail || "").trim().slice(0, 1000);
      if (!title) return res.status(400).json({ error: "Course title is required." });
      if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: "Price must be a non-negative number." });
      if (thumbnail && !/^https?:\/\//i.test(thumbnail)) return res.status(400).json({ error: "Thumbnail must be a valid http(s) URL." });
      const existing = await courseCollection.findOne({ title: { $regex: `^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });
      if (existing) return res.status(409).json({ error: "A course with that title already exists." });
      const result = await courseCollection.insertOne({ title, description, price, thumbnail, locked: false, ownerInstructorId: req.user._id.toString(), createdAt: new Date(), updatedAt: new Date() });
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
      const locked = req.body.locked === undefined ? !!course.locked : !!(req.body.locked === true || req.body.locked === "true");
      if (!title || !Number.isFinite(price) || price < 0) return res.status(400).json({ error: "Invalid course details." });
      const duplicate = await courseCollection.findOne({ _id: { $ne: id }, title: { $regex: `^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });
      if (duplicate) return res.status(409).json({ error: "A course with that title already exists." });
      await courseCollection.updateOne({ _id: id }, { $set: { title, description, price, thumbnail, locked, updatedAt: new Date() } });
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
        assignments.deleteMany({ courseId: id }),
        users.updateMany({ enrolledCourseIds: id.toString() }, { $pull: { enrolledCourseIds: id.toString() } }),
        users.updateMany({ enrolledCourseIds: id }, { $pull: { enrolledCourseIds: id } }),
        ...(lessonIds.length ? [lessonProgress.deleteMany({ lessonId: { $in: lessonIds } })] : []),
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
      if (!courseId || !title || !(await instructorOwnsCourse(req.user, courseId))) return res.status(404).json({ error: "Course not found." });
      const noteFile = req.files?.note?.[0], videoFile = req.files?.video?.[0], audioFile = req.files?.audio?.[0];
      if (!noteFile && !videoFile && !audioFile) return res.status(400).json({ error: "Select at least one lesson file." });
      if (noteFile && !hasAllowedExtension(noteFile, noteExtensions)) return res.status(400).json({ error: "Lesson notes must be PDF, DOC, DOCX, TXT, or MD." });
      if (videoFile && !hasAllowedExtension(videoFile, videoExtensions)) return res.status(400).json({ error: "Lesson video must be MP4, WEBM, MOV, or M4V." });
      let existing = lessonId ? await lessons.findOne({ _id: lessonId, courseId }) : await lessons.findOne({ courseId, title });
      if (lessonId && !existing) return res.status(404).json({ error: "Lesson not found." });
      const patch = { updatedAt: new Date() };
      if (noteFile) { const r=await uploadBuffer(noteFile.buffer,noteFile.originalname,"instructor-lesson-notes","raw"); patch.note={url:r.secure_url,publicId:r.public_id,resourceType:r.resource_type||"raw",type:r.type||"upload",originalName:noteFile.originalname}; }
      if (videoFile) { const r=await uploadBuffer(videoFile.buffer,videoFile.originalname,"instructor-lesson-videos","video"); patch.video={url:r.secure_url,publicId:r.public_id,resourceType:r.resource_type||"video",type:r.type||"upload",originalName:videoFile.originalname}; }
      if (audioFile) { const r=await uploadBuffer(audioFile.buffer,audioFile.originalname,"instructor-lesson-audio","video"); patch.audio={url:r.secure_url,publicId:r.public_id,resourceType:r.resource_type||"video",type:r.type||"upload",originalName:audioFile.originalname}; }
      if (existing) {
        const oldAssets=[];
        if(noteFile&&existing.note)oldAssets.push([existing.note,"raw"]); if(videoFile&&existing.video)oldAssets.push([existing.video,"video"]); if(audioFile&&existing.audio)oldAssets.push([existing.audio,"video"]);
        await lessons.updateOne({_id:existing._id},{$set:patch}); await Promise.all(oldAssets.map(([a,t])=>destroyCloudinaryAsset(a,t)));
        return res.json({ok:true,id:existing._id.toString(),updated:true});
      }
      const result=await lessons.insertOne({courseId,title,note:patch.note||null,video:patch.video||null,audio:patch.audio||null,createdAt:new Date(),updatedAt:new Date()});
      res.json({ok:true,id:result.insertedId.toString(),updated:false});
    } catch(e){ next(e); }
  });

  app.get("/api/instructor/lessons", auth, instructor, async (req,res,next)=>{
    try{
      const courseIds=(await courseCollection.find({ownerInstructorId:req.user._id.toString()}).project({_id:1}).toArray()).map(x=>x._id);
      const list=await lessons.find({courseId:{$in:courseIds}}).sort({createdAt:-1}).toArray();
      res.json({lessons:list.map(l=>({id:l._id.toString(),course_id:l.courseId.toString(),title:l.title,note_path:l.note?.url||"",video_path:lessonMediaUrl(l.video,"video")||"",audio_path:lessonMediaUrl(l.audio,"audio")||""}))});
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
      const courses=await courseCollection.find({ownerInstructorId:req.user._id.toString()}).toArray();
      const courseMap=new Map(courses.map(c=>[c._id.toString(),c]));
      const ids=courses.map(c=>c._id.toString());
      const students=await users.find({role:"student",enrolledCourseIds:{$in:ids}}).project({passwordHash:0}).toArray();
      res.json({students:students.map(u=>({id:u._id.toString(),name:u.name,email:u.email,approved:!!u.approved,portal_locked:!!u.portalLocked,enrolled_course_ids:enrolledCourseIds(u).filter(id=>courseMap.has(id)),courses:enrolledCourseIds(u).filter(id=>courseMap.has(id)).map(id=>courseMap.get(id)?.title).filter(Boolean)}))});
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
      res.json({ok:true,enrolled:enroll});
    }catch(e){next(e)}
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
      const apps = await instructorApplications.find({}).sort({ status: 1, createdAt: -1, updatedAt: -1 }).limit(500).toArray();
      const ids = apps.map(a => a.userId).filter(Boolean);
      const usersById = ids.length ? await users.find({ _id: { $in: ids } }).project({ passwordHash: 0 }).toArray() : [];
      const userMap = new Map(usersById.map(u => [String(u._id), u]));
      const applications = apps.map(a => {
        const u = userMap.get(String(a.userId || a.userIdString || ""));
        return { id:String(a._id), user_id:a.userId ? String(a.userId) : String(a.userIdString || u?._id || ""), name:a.name || u?.name || "Unknown applicant", email:a.email || u?.email || "", teaching_topics:a.teachingTopics || "", message:a.message || "", status:a.status || "pending", created_at:a.createdAt || a.updatedAt || new Date(), updated_at:a.updatedAt || a.createdAt || new Date() };
      });
      res.json({ok:true,pending_count:applications.filter(a=>a.status==='pending').length,applications});
    } catch(e) { next(e); }
  });

  app.get("/api/admin/instructors", auth, admin, async(req,res,next)=>{
    try{
      const apps = await instructorApplications.find({}).sort({ status: 1, createdAt: -1, updatedAt: -1 }).limit(500).toArray();
      const usersList = await users.find({ role: "instructor" }).project({ passwordHash: 0 }).toArray();
      const ids = apps.map(a=>a.userId).filter(Boolean);
      const applicantUsers = ids.length ? await users.find({_id:{$in:ids}}).project({passwordHash:0}).toArray() : [];
      const userMap = new Map(applicantUsers.map(u=>[String(u._id),u]));
      const courseCounts = await courseCollection.aggregate([{$match:{ownerInstructorId:{$exists:true,$ne:null}}},{$group:{_id:"$ownerInstructorId",count:{$sum:1}}}]).toArray();
      const countMap = new Map(courseCounts.map(x=>[String(x._id),Number(x.count)]));
      const applications = apps.map(a=>{const u=userMap.get(String(a.userId||a.userIdString||""));return {id:String(a._id),user_id:a.userId?String(a.userId):String(a.userIdString||u?._id||""),name:a.name||u?.name||"Unknown applicant",email:a.email||u?.email||"",teaching_topics:a.teachingTopics||"",message:a.message||"",status:a.status||"pending",created_at:a.createdAt||a.updatedAt||new Date(),updated_at:a.updatedAt||a.createdAt||new Date()};});
      res.json({ok:true,pending_count:applications.filter(a=>a.status==='pending').length,applications,instructors:usersList.map(u=>({id:u._id.toString(),name:u.name,email:u.email,suspended:!!u.instructorSuspended,approved:u.instructorApproved!==false,course_count:countMap.get(String(u._id))||0}))});
    }catch(e){next(e)}
  });

  app.post("/api/admin/instructors/:id/decision", auth, admin, async(req,res,next)=>{
    try{
      const id=oid(req.params.id); const action=String(req.body.action||"");
      const user=id?await users.findOne({_id:id}):null;
      if(!user) return res.status(404).json({error:"Instructor applicant not found."});
      if(!["approve","reject","suspend","unsuspend"].includes(action)) return res.status(400).json({error:"Invalid action."});
      if(action==="approve"){
        await users.updateOne({_id:id},{$set:{role:"instructor",instructorApproved:true,instructorSuspended:false,approved:true}});
        await instructorApplications.updateOne({userId:id},{$set:{status:"approved",reviewedAt:new Date(),reviewedBy:req.user._id.toString()}},{upsert:true});
      } else if(action==="reject"){
        await users.updateOne({_id:id},{$set:{instructorApproved:false,instructorSuspended:true}});
        await instructorApplications.updateOne({userId:id},{$set:{status:"rejected",reviewedAt:new Date(),reviewedBy:req.user._id.toString()}},{upsert:true});
      } else if(action==="suspend"){
        if(user.role!=="instructor") return res.status(400).json({error:"Only active instructors can be suspended."});
        await users.updateOne({_id:id},{$set:{instructorSuspended:true}});
      } else {
        await users.updateOne({_id:id},{$set:{instructorSuspended:false,instructorApproved:true}});
      }
      res.json({ok:true});
    }catch(e){next(e)}
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

  app.get("/api/admin/smart-security", auth, admin, async (req, res, next) => {
    try {
      const settings = await smartSettings();
      const events = await securityEvents.find({}).sort({ createdAt: -1 }).limit(100).toArray();
      const persistedBlocks = await securityBlocks.find({ until: { $gt: new Date() } }).sort({ until: 1 }).limit(200).toArray();
      const blocked = persistedBlocks.map(b => ({ deviceKey: b.deviceKey, ip: b.ip, until: b.until, reason: b.reason || "smart-security" }));
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
      if (!deviceKey) return res.status(400).json({ error: "Device block identifier is required." });
      smartBlocked.delete(deviceKey);
      await securityBlocks.deleteOne({ deviceKey });
      await smartRecord(req, { type: "admin-override", severity: "info", score: 0, action: "device-unblocked", targetDevice: deviceKey });
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
      res.json({ users: list.map(u => ({ id: u._id.toString(), name: u.name, email: u.email, role: u.role, profile_picture_url: (u.profilePicture ? `/api/admin/profile-picture/${u._id.toString()}` : null), student_id_number: u.studentIdNumber || null, course_code: u.courseCode || "", registration_date: u.registrationDate || (u.createdAt ? new Date(u.createdAt).toISOString().slice(0,10) : ""), programme_end_date: u.programmeEndDate || "", state: u.state || "", country: u.country || "", gender: u.gender || "", portal_locked: !!u.portalLocked, lock_source: u.lockSource || null, lock_reason: u.lockReason || null, last_activity_at: u.lastActivityAt || null, inactivity_locked_at: u.inactivityLockedAt || null, payment_status: u.paymentStatus, approved: !!u.approved, enrolled_course_ids: enrolledCourseIds(u), created_at: u.createdAt })) });
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
          { $set: { portalLocked: false, lastActivityAt: now }, $unset: { lockSource: "", lockReason: "", inactivityLockedAt: "" } }
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
      await users.updateOne({ _id: id }, { $set: { enrolledCourseIds: ids } });
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
      const locked = req.body.locked === true || req.body.locked === "true" || req.body.locked === "on";
      if (!title) return res.status(400).json({ error: "Course title is required." });
      if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: "Price must be a non-negative number." });
      if (thumbnail && !/^https?:\/\//i.test(thumbnail)) return res.status(400).json({ error: "Thumbnail must be a valid http(s) URL." });
      const existing = await courseCollection.findOne({ title: { $regex: `^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });
      if (existing) return res.status(409).json({ error: "A course with that title already exists." });
      const result = await courseCollection.insertOne({ title, description, price, thumbnail, locked, ownerInstructorId: null, createdAt: new Date(), updatedAt: new Date() });
      res.status(201).json({ ok: true, course: { id: result.insertedId.toString(), title, description, price, thumbnail, locked } });
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
      const locked = req.body.locked === undefined ? !!course.locked : (req.body.locked === true || req.body.locked === "true" || req.body.locked === "on");
      if (!title) return res.status(400).json({ error: "Course title is required." });
      if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: "Price must be a non-negative number." });
      if (thumbnail && !/^https?:\/\//i.test(thumbnail)) return res.status(400).json({ error: "Thumbnail must be a valid http(s) URL." });
      const duplicate = await courseCollection.findOne({ _id: { $ne: id }, title: { $regex: `^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });
      if (duplicate) return res.status(409).json({ error: "A course with that title already exists." });
      await courseCollection.updateOne({ _id: id }, { $set: { title, description, price, thumbnail, locked, updatedAt: new Date() } });
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
        assignments.deleteMany({ courseId: id }),
        users.updateMany({ enrolledCourseIds: id.toString() }, { $pull: { enrolledCourseIds: id.toString() } }),
        users.updateMany({ enrolledCourseIds: id }, { $pull: { enrolledCourseIds: id } }),
        ...(lessonIds.length ? [lessonProgress.deleteMany({ lessonId: { $in: lessonIds } })] : []),
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
      if (!courseId || !title) return res.status(400).json({ error: "Course and lesson title required" });
      const course = await courseCollection.findOne({ _id: courseId });
      if (!course) return res.status(404).json({ error: "Course not found" });

      const noteFile = req.files?.note?.[0];
      const videoFile = req.files?.video?.[0];
      const audioFile = req.files?.audio?.[0];
      if (!noteFile && !videoFile && !audioFile) return res.status(400).json({ error: "Select at least one lesson file (note, video, or audio)." });
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

      const patch = { updatedAt: new Date() };
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

      const doc = { courseId, title, note: patch.note || null, video: patch.video || null, audio: patch.audio || null, createdAt: new Date(), updatedAt: new Date() };
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
        result.push({ id: l._id.toString(), title: l.title, course_id: l.courseId?.toString() || "", course_title: c?.title || "Unknown", note_path: l.note?.url || "", video_path: lessonMediaUrl(l.video, "video") || "", audio_path: lessonMediaUrl(l.audio, "audio") || "" });
      }
      res.json({ lessons: result });
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
        lessonProgress.deleteMany({ lessonId: id })
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

  // Proxy student submission downloads through WPS Academy so Office files
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
  const aiUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 }
  });

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
        ? `The student appears to be asking about the enrolled WPS Academy course "${matchedCourse.title}". Use the supplied lesson notes as the primary source when explaining its lessons. If the student did not name a specific lesson, give a course-level overview first and offer the available lessons.`
        : results.length
          ? 'These are the closest enrolled WPS Academy lessons. Use their attached lesson notes as source material when relevant.'
          : 'No closely matching enrolled WPS Academy course or lesson was found.'
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
    const artifact = { userId, type: "document", format: safeFormat, title: String(title || "WPS Academy Document").slice(0, 200), url, publicId: uploaded.public_id, createdAt: new Date() };
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
      const done = ids.length ? await lessonProgress.find({ userId: studentId, lessonId: { $in: ids }, completed: true }).toArray() : [];
      const doneSet = new Set(done.map(x => String(x.lessonId)));
      const lessonItems = ls.map(l => ({ id: l._id.toString(), title: l.title, completed: doneSet.has(l._id.toString()), note_path: l.note?.url || '', video_path: l.video?.url || '' }));
      totalLessons += ls.length; completedLessons += done.length;
      courseRows.push({ id: c._id.toString(), title: c.title, description: c.description || '', lessonCount: ls.length, completed: done.length, locked: !!c.locked, lessons: lessonItems });
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
      await lessonProgress.updateOne({ userId: req.user._id, lessonId }, { $set: { userId: req.user._id, lessonId, courseId: lesson.courseId, completed, updatedAt: new Date(), ...(completed ? { completedAt: new Date() } : {}) } }, { upsert: true });
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
      const prompt = `Create a ${count}-question multiple-choice quiz for a WPS Academy student. Topic: ${topic}. Difficulty: ${difficulty}. Use these academy search results when relevant: ${JSON.stringify(material.results)}. Return ONLY valid JSON with this shape: {"title":"...","questions":[{"question":"...","options":["A","B","C","D"],"answer":0,"explanation":"..."}]}. answer must be the zero-based correct option index. Keep explanations concise.`;
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
      const goal = String(req.body.goal || 'Improve my WPS Academy skills').trim().slice(0, 500);
      const days = Math.min(Math.max(Number(req.body.days) || 7, 3), 30);
      const overview = await getLearningOverview(req.user._id);
      const prompt = `Create a practical ${days}-day study plan for this WPS Academy student. Goal: ${goal}. Current progress: ${JSON.stringify(overview)}. Return a concise plan with day-by-day tasks, estimated minutes, and one measurable outcome per day. Do not invent lessons that are not in the supplied progress data.`;
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
      const title = String(req.body.title || "WPS Academy Study Document").trim().slice(0, 200);
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
        lessonContext = { lessonId: lesson._id.toString(), title: lesson.title, courseTitle: course?.title || "Unknown", noteUrl: lesson.note?.url || null, noteName: lesson.note?.originalName || null };
      }

      let academyContext = null;
      try {
        const material = await searchAcademyMaterial(message, req.user._id);
        if (material?.results?.length || material?.matchedCourse) academyContext = material;
      } catch (materialError) {
        console.warn("WPS Academy material lookup failed:", materialError?.message || materialError);
      }

      const result = await createTutorResponse({
        user: req.user,
        messages,
        attachedFiles: attached.filter(Boolean),
        lessonContext,
        academyContext,
        useWeb: webEnabled,
        toolExecutor: async (name, args) => {
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
      return res.status(502).json({ error: "WPS AI could not complete that request right now. Please try again shortly. If it keeps happening, check the Render server logs for the detailed error." });
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
      if (course?.locked && req.user.role !== "admin") return res.status(403).json({ error: "This course is currently locked." });
      res.json({ lesson: { id: lesson._id.toString(), title: lesson.title, courseId: lesson.courseId.toString(), courseTitle: course?.title || "Unknown", noteUrl: lesson.note?.url || null, videoUrl: lesson.video?.url || null,
        audioUrl: lesson.audio?.url || null } });
    } catch (e) { next(e); }
  });

  // Serve lesson notes through WPS Academy so downloaded files keep their
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

  // Stream lesson media through the WPS Academy server for student playback.
  // This keeps the browser request same-origin and preserves HTTP Range support,
  // while the admin portal can continue opening the direct Cloudinary URL.
  async function streamLessonMedia(req, res, lesson, kind) {
    const media = lesson?.[kind];
    if (!media?.url) return res.status(404).json({ error: `Lesson ${kind} is not available.` });

    const range = req.headers.range;
    const headers = {};
    if (range) headers.Range = range;

    let upstream;
    try {
      upstream = await fetch(media.url, { headers, redirect: "follow" });
    } catch (e) {
      console.error(`Lesson ${kind} upstream fetch failed:`, e?.message || e);
      return res.status(502).json({ error: `Could not load lesson ${kind}.` });
    }

    if (!upstream.ok && upstream.status !== 206) {
      console.error(`Lesson ${kind} upstream returned ${upstream.status} for ${media.url}`);
      return res.status(upstream.status === 404 ? 404 : 502).json({ error: `Lesson ${kind} could not be loaded.` });
    }

    const ext = path.extname(media.originalName || "").toLowerCase();
    const fallbackTypes = {
      video: { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/x-m4v" },
      audio: { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".aac": "audio/aac", ".flac": "audio/flac", ".opus": "audio/ogg", ".amr": "audio/amr", ".aif": "audio/aiff", ".aiff": "audio/aiff", ".caf": "audio/x-caf", ".mka": "audio/x-matroska", ".3gp": "audio/3gpp", ".webm": "audio/webm" }
    };
    const upstreamType = upstream.headers.get("content-type");
    const contentType = upstreamType && upstreamType !== "application/octet-stream"
      ? upstreamType
      : (fallbackTypes[kind]?.[ext] || (kind === "video" ? "video/mp4" : "audio/mpeg"));

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
      if (!course || course.locked) return res.status(423).json({ error: "This course is locked." });
      if (!studentHasCourse(req.user, course._id)) return res.status(403).json({ error: "You are not registered for this course." });
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
      const list = await lessons.find({ courseId: id }).sort({ createdAt: 1 }).toArray();
      const progress = await lessonProgress.find({ userId: req.user._id, lessonId: { $in: list.map(l => l._id) }, completed: true }).toArray();
      const done = new Set(progress.map(p => String(p.lessonId)));
      res.json({ course: { id: course._id.toString(), title: course.title, description: course.description, locked: !!course.locked }, lessons: list.map(l => ({ id: l._id.toString(), title: l.title, note_path: l.note?.url ? `/api/learning/lessons/${l._id}/note` : "", video_path: l.video?.url ? `/api/learning/lessons/${l._id}/media/video` : "", audio_path: l.audio?.url ? `/api/learning/lessons/${l._id}/media/audio` : "", completed: done.has(l._id.toString()) })) });
    } catch (e) { next(e); }
  });

  app.use((err, req, res, next) => {
    console.error(err);
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "File is too large. Maximum upload size is 100 MB." });
    res.status(500).json({ error: "Server error. Please try again." });
  });

  app.listen(PORT, () => {
    console.log(`WPS Academy running on port ${PORT}`);
    console.log(`MongoDB database: ${DB_NAME}`);
    console.log(`Admin: ${adminEmail}`);
  });
}

start().catch(err => {
  console.error("Failed to start WPS Academy:", err);
  process.exit(1);
});
