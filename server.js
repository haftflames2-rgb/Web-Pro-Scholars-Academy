const express = require("express");
const session = require("express-session");
const { MongoStore } = require("connect-mongo");
const { MongoClient, ObjectId, ServerApiVersion } = require("mongodb");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const path = require("path");
const PDFDocument = require("pdfkit");
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require("docx");
const { createTutorResponse, generateTutorText, enabled: aiEnabled, MODEL: AI_MODEL, client: openai } = require("./aiService");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

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
let studyPlans;
let aiArtifacts;
let aiUsage;
let aiSettings;

function oid(id) {
  try { return new ObjectId(id); } catch { return null; }
}

function uploadBuffer(buffer, originalName, folder) {
  return new Promise((resolve, reject) => {
    const safeBase = path.basename(originalName || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
    const publicId = `${Date.now()}-${safeBase.replace(/\.[^.]+$/, "")}`;
    const stream = cloudinary.uploader.upload_stream(
      { folder: `wps-academy/${folder}`, public_id: publicId, resource_type: "auto" },
      (error, result) => error ? reject(error) : resolve(result)
    );
    stream.end(buffer);
  });
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
  studyPlans = db.collection("study_plans");
  aiArtifacts = db.collection("ai_artifacts");
  aiUsage = db.collection("ai_usage");
  aiSettings = db.collection("ai_settings");

  await users.createIndex({ email: 1 }, { unique: true });
  await courseCollection.createIndex({ title: 1 }, { unique: true });
  await submissions.createIndex({ assignmentId: 1, studentId: 1 }, { unique: true });
  await aiConversations.createIndex({ userId: 1, updatedAt: -1 });
  await lessonProgress.createIndex({ userId: 1, lessonId: 1 }, { unique: true });
  await quizAttempts.createIndex({ userId: 1, createdAt: -1 });
  await studyPlans.createIndex({ userId: 1, createdAt: -1 });
  await aiArtifacts.createIndex({ userId: 1, createdAt: -1 });
  await aiArtifacts.createIndex({ jobId: 1 }, { unique: true, sparse: true });
  await aiUsage.createIndex({ userId: 1, dateKey: 1 }, { unique: true });

  for (const title of courses) {
    await courseCollection.updateOne(
      { title },
      { $setOnInsert: { title, description: `Learn ${title} from fundamentals to practical projects.`, locked: false, createdAt: new Date() } },
      { upsert: true }
    );
  }

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

  const adminEmail = (process.env.ADMIN_EMAIL || "admin@wpsacademy.com").trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || "ChangeThisAdminPassword123!";
  const hash = await bcrypt.hash(adminPassword, 12);
  await users.updateOne(
    { email: adminEmail },
    { $setOnInsert: { name: "WPS Administrator", email: adminEmail, passwordHash: hash, role: "admin", portalLocked: false, paymentStatus: "paid", approved: true, createdAt: new Date() } },
    { upsert: true }
  );

  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.use(session({
    store: MongoStore.create({
      mongoUrl: MONGODB_URI,
      dbName: DB_NAME,
      collectionName: "sessions",
      ttl: 60 * 60 * 24 * 7
    }),
    secret: process.env.SESSION_SECRET || "dev-only-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  }));

  app.use(express.static(path.join(ROOT, "public")));

  function auth(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: "Authentication required" });
    const id = oid(req.session.userId);
    if (!id) return res.status(401).json({ error: "Session expired" });
    users.findOne({ _id: id }).then(user => {
      if (!user) return res.status(401).json({ error: "Session expired" });
      req.user = user;
      next();
    }).catch(next);
  }

  function admin(req, res, next) {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
    next();
  }

  function studentAccess(req, res, next) {
    if (req.user.role === "admin") return next();
    if (req.user.portalLocked) return res.status(423).json({ error: "Your student portal is locked by an administrator." });
    if (!req.user.approved) return res.status(403).json({ error: "Your account is awaiting admin approval." });
    next();
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

  app.post("/api/register", async (req, res, next) => {
    try {
      const { name, email, password } = req.body;
      const cleanName = String(name || "").trim();
      const cleanEmail = String(email || "").trim().toLowerCase();
      if (!cleanName || !cleanEmail || !password || password.length < 8)
        return res.status(400).json({ error: "Name, email and an 8+ character password are required." });
      const hash = await bcrypt.hash(password, 12);
      const result = await users.insertOne({
        name: cleanName,
        email: cleanEmail,
        passwordHash: hash,
        role: "student",
        portalLocked: false,
        paymentStatus: "unpaid",
        approved: false,
        createdAt: new Date()
      });
      req.session.userId = result.insertedId.toString();
      res.json({ ok: true, redirect: "/payment.html" });
    } catch (e) {
      if (e && e.code === 11000) return res.status(400).json({ error: "Email already registered." });
      next(e);
    }
  });

  app.post("/api/login", async (req, res, next) => {
    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      const password = String(req.body.password || "");
      const user = await users.findOne({ email });
      if (!user || !(await bcrypt.compare(password, user.passwordHash)))
        return res.status(401).json({ error: "Invalid email or password." });
      req.session.userId = user._id.toString();
      res.json({ ok: true, redirect: user.role === "admin" ? "/admin.html" : "/index.html" });
    } catch (e) { next(e); }
  });

  app.post("/api/logout", (req, res) => {
    req.session.destroy(() => res.json({ ok: true, redirect: "/index.html" }));
  });

  app.get("/api/me", async (req, res, next) => {
    try {
      if (!req.session.userId) return res.json({ user: null });
      const id = oid(req.session.userId);
      const user = id ? await users.findOne({ _id: id }) : null;
      if (!user) return res.json({ user: null });
      res.json({ user: {
        id: user._id.toString(), name: user.name, email: user.email, role: user.role,
        portal_locked: !!user.portalLocked, payment_status: user.paymentStatus, approved: !!user.approved
      }});
    } catch (e) { next(e); }
  });

  app.get("/api/courses", async (req, res, next) => {
    try {
      const list = await courseCollection.find({}).sort({ title: 1 }).toArray();
      res.json({ courses: list.map(c => ({ id: c._id.toString(), title: c.title, description: c.description, locked: !!c.locked })) });
    } catch (e) { next(e); }
  });

  app.get("/api/dashboard", auth, studentAccess, async (req, res, next) => {
    try {
      const rows = await assignments.find({}).sort({ createdAt: -1 }).toArray();
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
      res.json({ user: req.user, assignments: result });
    } catch (e) { next(e); }
  });

  app.post("/api/payments", auth, upload.single("proof"), async (req, res, next) => {
    try {
      const { method, reference, declaredPaid } = req.body;
      if (!["bank", "crypto"].includes(method)) return res.status(400).json({ error: "Invalid payment method" });
      let proof = null;
      if (req.file) {
        const uploaded = await uploadBuffer(req.file.buffer, req.file.originalname, "payment-proofs");
        proof = { url: uploaded.secure_url, publicId: uploaded.public_id };
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
      res.json({ users: list.map(u => ({ id: u._id.toString(), name: u.name, email: u.email, role: u.role, portal_locked: !!u.portalLocked, payment_status: u.paymentStatus, approved: !!u.approved, created_at: u.createdAt })) });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/users/:id/toggle-lock", auth, admin, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid user id" });
      const u = await users.findOne({ _id: id });
      if (!u) return res.status(404).json({ error: "User not found" });
      await users.updateOne({ _id: id }, { $set: { portalLocked: !u.portalLocked } });
      res.json({ ok: true });
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

  app.get("/api/admin/payments", auth, admin, async (req, res, next) => {
    try {
      const list = await payments.find({}).sort({ createdAt: -1 }).toArray();
      const result = [];
      for (const p of list) {
        const u = await users.findOne({ _id: p.userId });
        result.push({
          id: p._id.toString(), name: u?.name || "Unknown", email: u?.email || "", method: p.method,
          reference: p.reference || "", proof_path: p.proof?.url || "", status: p.status
        });
      }
      res.json({ payments: result });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/courses/:id/toggle-lock", auth, admin, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid course id" });
      const c = await courseCollection.findOne({ _id: id });
      if (!c) return res.status(404).json({ error: "Course not found" });
      await courseCollection.updateOne({ _id: id }, { $set: { locked: !c.locked } });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.post("/api/admin/lessons", auth, admin, upload.fields([{ name: "note", maxCount: 1 }, { name: "video", maxCount: 1 }]), async (req, res, next) => {
    try {
      const courseId = oid(req.body.courseId);
      const title = String(req.body.title || "").trim();
      if (!courseId || !title) return res.status(400).json({ error: "Course and lesson title required" });
      const course = await courseCollection.findOne({ _id: courseId });
      if (!course) return res.status(404).json({ error: "Course not found" });

      const noteFile = req.files?.note?.[0];
      const videoFile = req.files?.video?.[0];
      let note = null;
      let video = null;
      if (noteFile) {
        const r = await uploadBuffer(noteFile.buffer, noteFile.originalname, "lesson-notes");
        note = { url: r.secure_url, publicId: r.public_id, originalName: noteFile.originalname };
      }
      if (videoFile) {
        const r = await uploadBuffer(videoFile.buffer, videoFile.originalname, "lesson-videos");
        video = { url: r.secure_url, publicId: r.public_id, originalName: videoFile.originalname };
      }
      const result = await lessons.insertOne({ courseId, title, note, video, createdAt: new Date() });
      res.json({ ok: true, id: result.insertedId.toString() });
    } catch (e) { next(e); }
  });

  app.get("/api/admin/lessons", auth, admin, async (req, res, next) => {
    try {
      const list = await lessons.find({}).sort({ createdAt: -1 }).toArray();
      const result = [];
      for (const l of list) {
        const c = await courseCollection.findOne({ _id: l.courseId });
        result.push({ id: l._id.toString(), title: l.title, course_title: c?.title || "Unknown", note_path: l.note?.url || "", video_path: l.video?.url || "" });
      }
      res.json({ lessons: result });
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
        result.push({ id: s._id.toString(), assignment_title: a?.title || "Unknown", student_name: u?.name || "Unknown", email: u?.email || "", file_path: s.file?.url || "", grade: s.grade || "", feedback: s.feedback || "" });
      }
      res.json({ submissions: result });
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
      let file = null;
      if (req.file) {
        const r = await uploadBuffer(req.file.buffer, req.file.originalname, "student-submissions");
        file = { url: r.secure_url, publicId: r.public_id, originalName: req.file.originalname };
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

  async function searchAcademyMaterial(query, studentId) {
    const q = String(query || "").trim();
    const words = q.toLowerCase().split(/[^a-z0-9+#.]+/).filter(w => w.length > 2).slice(0, 10);
    const allCourses = await courseCollection.find({ locked: false }).toArray();
    const unlockedIds = new Set(allCourses.map(c => String(c._id)));
    const allLessons = await lessons.find({}).sort({ createdAt: 1 }).toArray();
    const scored = [];
    for (const lesson of allLessons) {
      if (!unlockedIds.has(String(lesson.courseId))) continue;
      const course = allCourses.find(c => String(c._id) === String(lesson.courseId));
      const hay = `${course?.title || ""} ${course?.description || ""} ${lesson.title || ""}`.toLowerCase();
      const score = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
      if (score > 0) scored.push({ score, lesson, course });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 5);
    return {
      results: top.map(({ lesson, course, score }) => ({
        score,
        course: course?.title || "Unknown",
        lesson: lesson.title,
        lessonId: lesson._id.toString(),
        noteUrl: lesson.note?.url || null,
        videoUrl: lesson.video?.url || null
      })),
      hint: top.length ? "These are the closest WPS Academy lessons. If a note URL is supplied, use it as the source when appropriate." : "No closely matching lesson was found."
    };
  }

  async function getStudentProgress(studentId) {
    const userId = studentId;
    const student = await users.findOne({ _id: userId }, { projection: { passwordHash: 0 } });
    const assigned = await assignments.find({}).sort({ createdAt: -1 }).limit(20).toArray();
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
    const availableCourses = await courseCollection.find({}).sort({ title: 1 }).toArray();
    return {
      student: { name: student?.name || "Student", email: student?.email || "", paymentStatus: student?.paymentStatus || "" },
      courses: availableCourses.map(c => ({ title: c.title, locked: !!c.locked })),
      assignments: rows
    };
  }

  async function findAssignments(query, studentId) {
    const q = String(query || "").toLowerCase();
    const list = await assignments.find({}).sort({ createdAt: -1 }).toArray();
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

  async function getLearningOverview(studentId) {
    const availableCourses = await courseCollection.find({ locked: false }).sort({ title: 1 }).toArray();
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

  app.post("/api/ai/quiz", auth, studentAccess, async (req, res, next) => {
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
      quiz.questions = quiz.questions.slice(0, count).map(q => ({ question: String(q.question||''), options: Array.isArray(q.options) ? q.options.slice(0,4).map(String) : [], answer: Number(q.answer)||0, explanation: String(q.explanation||'') }));
      res.json({ quiz, model: AI_MODEL });
    } catch (e) { console.error('Quiz error:', e); if (quota) await refundAICredits(req.user, "quiz", quota.cost); next(e); }
  });

  app.post("/api/learning/quizzes/submit", auth, studentAccess, async (req, res, next) => {
    try {
      const title = String(req.body.title || 'WPS AI Quiz').slice(0, 200);
      const questions = Array.isArray(req.body.questions) ? req.body.questions : [];
      const answers = Array.isArray(req.body.answers) ? req.body.answers : [];
      if (!questions.length || answers.length !== questions.length) return res.status(400).json({ error: 'Invalid quiz submission.' });
      let score = 0;
      questions.forEach((q,i) => { if (Number(answers[i]) === Number(q.answer)) score++; });
      const attempt = { userId: req.user._id, title, score, total: questions.length, createdAt: new Date() };
      const saved = await quizAttempts.insertOne(attempt);
      res.json({ ok: true, id: saved.insertedId.toString(), score, total: questions.length, percent: Math.round(score/questions.length*100) });
    } catch (e) { next(e); }
  });

  app.post("/api/ai/study-plan", auth, studentAccess, async (req, res, next) => {
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
      res.json({ enabled: aiEnabled, model: AI_MODEL, webSearch: String(process.env.OPENAI_ENABLE_WEB_SEARCH || "false").toLowerCase() === "true", quota: { dailyCredits: limits.dailyCredits, used, remaining: unlimited ? null : Math.max(0, limits.dailyCredits - used), unlimited, costs: limits.costs, dateKey } });
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

  app.post("/api/ai/speech", auth, studentAccess, async (req, res, next) => {
    let quota;
    try {
      if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "AI Tutor is not configured." });
      const text = String(req.body.text || "").trim();
      if (!text) return res.status(400).json({ error: "Text is required." });
      if (text.length > 4096) return res.status(400).json({ error: "Text is too long for one speech request." });
      quota = await requireAICredits(req, res, "speech"); if (!quota) return;
      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts", voice: process.env.OPENAI_TTS_VOICE || "marin", input: text, instructions: "Speak in clear, natural English with a friendly professional tutoring voice. English is the primary language. Do not switch languages unless the text explicitly requires it.", response_format: "mp3" })
      });
      if (!response.ok) { const d = await response.json().catch(() => ({})); throw new Error(d?.error?.message || "Speech generation failed."); }
      const buffer = Buffer.from(await response.arrayBuffer());
      const uploaded = await uploadGenerated(buffer, `speech-${Date.now()}`, "video", "mp3");
      res.json({ url: uploaded.secure_url });
    } catch (e) { if (quota) await refundAICredits(req.user, "speech", quota.cost); next(e); }
  });

  app.post("/api/ai/image", auth, studentAccess, async (req, res, next) => {
    let quota;
    try {
      if (!aiEnabled) return res.status(503).json({ error: "AI Tutor is not configured." });
      const prompt = String(req.body.prompt || "").trim();
      if (!prompt) return res.status(400).json({ error: "Image prompt is required." });
      quota = await requireAICredits(req, res, "image"); if (!quota) return;
      res.json(await generateAIImage(prompt, req.user._id));
    } catch (e) { if (quota) await refundAICredits(req.user, "image", quota.cost); next(e); }
  });

  app.post("/api/ai/document", auth, studentAccess, async (req, res, next) => {
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

  app.post("/api/ai/video", auth, studentAccess, async (req, res, next) => {
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

  app.post("/api/ai/chat", auth, studentAccess, aiUpload.single("file"), async (req, res, next) => {
    let quota;
    try {
      if (!aiEnabled) return res.status(503).json({ error: "AI Tutor is not configured. Add OPENAI_API_KEY to your Render environment variables." });
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

      const result = await createTutorResponse({
        user: req.user,
        messages,
        attachedFiles: attached.filter(Boolean),
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
      await aiConversations.updateOne(
        { _id: conversation._id, userId: req.user._id },
        { $push: { messages: { $each: [userMessage, assistantMessage], $slice: -100 } }, $set: { updatedAt: new Date(), lastResponseId: result.responseId } }
      );
      res.json({ ok: true, conversationId: conversation._id.toString(), message: assistantMessage });
    } catch (e) {
      console.error("AI Tutor error:", e);
      if (e?.status === 401) { if (quota) await refundAICredits(req.user, "chat", quota.cost); return res.status(502).json({ error: "The AI service rejected the API key. Check OPENAI_API_KEY on Render." }); }
      if (e?.status === 429) { if (quota) await refundAICredits(req.user, "chat", quota.cost); return res.status(429).json({ error: e?.code === "DAILY_AI_LIMIT" ? e.message : "The AI service is temporarily busy or your API limit was reached. Please try again shortly." }); }
      if (e instanceof multer.MulterError && e.code === "LIMIT_FILE_SIZE") { if (quota) await refundAICredits(req.user, "chat", quota.cost); return res.status(413).json({ error: "AI attachments must be 15 MB or smaller." }); }
      if (quota) await refundAICredits(req.user, "chat", quota.cost);
      next(e);
    }
  });

  app.get("/api/courses/:id/content", auth, studentAccess, async (req, res, next) => {
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid course id" });
      const course = await courseCollection.findOne({ _id: id });
      if (!course) return res.status(404).json({ error: "Course not found" });
      if (course.locked && req.user.role !== "admin") return res.status(423).json({ error: "This course is locked." });
      const list = await lessons.find({ courseId: id }).sort({ createdAt: 1 }).toArray();
      const progress = await lessonProgress.find({ userId: req.user._id, lessonId: { $in: list.map(l => l._id) }, completed: true }).toArray();
      const done = new Set(progress.map(p => String(p.lessonId)));
      res.json({ course: { id: course._id.toString(), title: course.title, description: course.description, locked: !!course.locked }, lessons: list.map(l => ({ id: l._id.toString(), title: l.title, note_path: l.note?.url || "", video_path: l.video?.url || "", completed: done.has(l._id.toString()) })) });
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
