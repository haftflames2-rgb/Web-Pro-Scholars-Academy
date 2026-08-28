const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const UPLOADS = path.join(ROOT, "uploads");
fs.mkdirSync(UPLOADS, { recursive: true });

const db = new Database(path.join(ROOT, "wps.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student',
  portal_locked INTEGER NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT UNIQUE NOT NULL,
  description TEXT DEFAULT '',
  locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  note_path TEXT,
  video_path TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(course_id) REFERENCES courses(id)
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  reference TEXT,
  proof_path TEXT,
  declared_paid INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  due_date TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  text_code TEXT,
  file_path TEXT,
  grade TEXT,
  feedback TEXT,
  submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(assignment_id, student_id),
  FOREIGN KEY(assignment_id) REFERENCES assignments(id),
  FOREIGN KEY(student_id) REFERENCES users(id)
);
`);

const courses = [
  "Web Development","App Development","Encoding and Decoding","Python","C#",
  "JavaScript","CSS","TypeScript","Data Science","Vue","React","Django","AI"
];
for (const title of courses) {
  db.prepare("INSERT OR IGNORE INTO courses (title, description) VALUES (?, ?)")
    .run(title, `Learn ${title} from fundamentals to practical projects.`);
}

const adminEmail = process.env.ADMIN_EMAIL || "admin@wpsacademy.com";
const adminPassword = process.env.ADMIN_PASSWORD || "ChangeThisAdminPassword123!";
const existingAdmin = db.prepare("SELECT id FROM users WHERE email=?").get(adminEmail);
if (!existingAdmin) {
  const hash = bcrypt.hashSync(adminPassword, 12);
  db.prepare("INSERT INTO users (name,email,password_hash,role,approved,payment_status) VALUES (?,?,?,?,?,?)")
    .run("WPS Administrator", adminEmail, hash, "admin", 1, "paid");
}

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new SQLiteStore({ db: "sessions.sqlite", dir: ROOT }),
  secret: process.env.SESSION_SECRET || "dev-only-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: false, maxAge: 1000*60*60*24*7 }
}));
app.use("/uploads", express.static(UPLOADS));
app.use(express.static(path.join(ROOT, "public")));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS),
  filename: (_, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${safe}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

function auth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Authentication required" });
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.session.userId);
  if (!user) return res.status(401).json({ error: "Session expired" });
  req.user = user;
  next();
}
function admin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}
function studentAccess(req, res, next) {
  if (req.user.role === "admin") return next();
  if (req.user.portal_locked) return res.status(423).json({ error: "Your student portal is locked by an administrator." });
  if (!req.user.approved) return res.status(403).json({ error: "Your account is awaiting admin approval." });
  next();
}

app.post("/api/register", async (req,res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password || password.length < 8)
      return res.status(400).json({ error: "Name, email and an 8+ character password are required." });
    const hash = await bcrypt.hash(password, 12);
    const info = db.prepare("INSERT INTO users (name,email,password_hash) VALUES (?,?,?)").run(name.trim(), email.trim().toLowerCase(), hash);
    req.session.userId = info.lastInsertRowid;
    res.json({ ok: true, redirect: "/payment.html" });
  } catch(e) {
    res.status(400).json({ error: e.message.includes("UNIQUE") ? "Email already registered." : "Registration failed." });
  }
});

app.post("/api/login", async (req,res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email=?").get((email||"").trim().toLowerCase());
  if (!user || !(await bcrypt.compare(password||"", user.password_hash)))
    return res.status(401).json({ error: "Invalid email or password." });
  req.session.userId = user.id;
  res.json({ ok: true, redirect: user.role === "admin" ? "/admin.html" : "/index.html" });
});

app.post("/api/logout", (req,res) => {
  req.session.destroy(() => res.json({ ok: true, redirect: "/index.html" }));
});

app.get("/api/me", (req,res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = db.prepare("SELECT id,name,email,role,portal_locked,payment_status,approved FROM users WHERE id=?").get(req.session.userId);
  res.json({ user: user || null });
});

app.get("/api/courses", (req,res) => {
  res.json({ courses: db.prepare("SELECT * FROM courses ORDER BY title").all() });
});

app.get("/api/dashboard", auth, studentAccess, (req,res) => {
  const assignments = db.prepare(`
    SELECT a.*, c.title course_title, s.grade, s.feedback
    FROM assignments a
    LEFT JOIN courses c ON c.id=a.course_id
    LEFT JOIN submissions s ON s.assignment_id=a.id AND s.student_id=?
    ORDER BY a.created_at DESC
  `).all(req.user.id);
  res.json({ user: req.user, assignments });
});

app.post("/api/payments", auth, upload.single("proof"), (req,res) => {
  const { method, reference, declaredPaid } = req.body;
  if (!["bank","crypto"].includes(method)) return res.status(400).json({error:"Invalid payment method"});
  const proof = req.file ? `/uploads/${req.file.filename}` : null;
  const info = db.prepare(`
    INSERT INTO payments (user_id,method,reference,proof_path,declared_paid)
    VALUES (?,?,?,?,?)
  `).run(req.user.id, method, reference || "", proof, declaredPaid === "true" || declaredPaid === "1" ? 1 : 0);
  db.prepare("UPDATE users SET payment_status='pending' WHERE id=?").run(req.user.id);
  res.json({ ok:true, paymentId: info.lastInsertRowid, message:"Payment submitted. Please wait for admin approval." });
});

app.get("/api/admin/users", auth, admin, (req,res) => {
  res.json({ users: db.prepare(`
    SELECT id,name,email,role,portal_locked,payment_status,approved,created_at
    FROM users ORDER BY created_at DESC
  `).all() });
});

app.post("/api/admin/users/:id/toggle-lock", auth, admin, (req,res) => {
  const u = db.prepare("SELECT portal_locked FROM users WHERE id=?").get(req.params.id);
  if (!u) return res.status(404).json({error:"User not found"});
  db.prepare("UPDATE users SET portal_locked=? WHERE id=?").run(u.portal_locked ? 0 : 1, req.params.id);
  res.json({ok:true});
});

app.post("/api/admin/users/:id/approve", auth, admin, (req,res) => {
  db.prepare("UPDATE users SET approved=1,payment_status='paid' WHERE id=?").run(req.params.id);
  db.prepare("UPDATE payments SET status='approved' WHERE user_id=? AND status='pending'").run(req.params.id);
  res.json({ok:true});
});

app.get("/api/admin/payments", auth, admin, (req,res) => {
  res.json({ payments: db.prepare(`
    SELECT p.*, u.name,u.email
    FROM payments p JOIN users u ON u.id=p.user_id
    ORDER BY p.created_at DESC
  `).all() });
});

app.post("/api/admin/courses/:id/toggle-lock", auth, admin, (req,res) => {
  const c = db.prepare("SELECT locked FROM courses WHERE id=?").get(req.params.id);
  if (!c) return res.status(404).json({error:"Course not found"});
  db.prepare("UPDATE courses SET locked=? WHERE id=?").run(c.locked ? 0 : 1, req.params.id);
  res.json({ok:true});
});

app.post("/api/admin/lessons", auth, admin, upload.fields([{name:"note",maxCount:1},{name:"video",maxCount:1}]), (req,res) => {
  const { courseId, title } = req.body;
  if (!courseId || !title) return res.status(400).json({error:"Course and lesson title required"});
  const note = req.files?.note?.[0]?.filename ? `/uploads/${req.files.note[0].filename}` : null;
  const video = req.files?.video?.[0]?.filename ? `/uploads/${req.files.video[0].filename}` : null;
  const info = db.prepare("INSERT INTO lessons(course_id,title,note_path,video_path) VALUES(?,?,?,?)")
    .run(courseId,title,note,video);
  res.json({ok:true,id:info.lastInsertRowid});
});

app.get("/api/admin/lessons", auth, admin, (req,res) => {
  res.json({lessons: db.prepare(`
    SELECT l.*, c.title course_title FROM lessons l JOIN courses c ON c.id=l.course_id
    ORDER BY l.created_at DESC
  `).all()});
});

app.post("/api/admin/assignments", auth, admin, (req,res) => {
  const { courseId, title, instructions, dueDate } = req.body;
  if (!title || !instructions) return res.status(400).json({error:"Title and instructions required"});
  const info = db.prepare("INSERT INTO assignments(course_id,title,instructions,due_date) VALUES(?,?,?,?)")
    .run(courseId || null,title,instructions,dueDate || null);
  res.json({ok:true,id:info.lastInsertRowid});
});

app.get("/api/admin/submissions", auth, admin, (req,res) => {
  res.json({submissions: db.prepare(`
    SELECT s.*, a.title assignment_title, u.name student_name, u.email
    FROM submissions s
    JOIN assignments a ON a.id=s.assignment_id
    JOIN users u ON u.id=s.student_id
    ORDER BY s.submitted_at DESC
  `).all()});
});

app.post("/api/admin/submissions/:id/grade", auth, admin, (req,res) => {
  const { grade, feedback } = req.body;
  db.prepare("UPDATE submissions SET grade=?,feedback=? WHERE id=?").run(grade,feedback || "",req.params.id);
  res.json({ok:true});
});

app.post("/api/submissions", auth, studentAccess, upload.single("codeFile"), (req,res) => {
  const { assignmentId, textCode } = req.body;
  if (!assignmentId) return res.status(400).json({error:"Assignment required"});
  const file = req.file ? `/uploads/${req.file.filename}` : null;
  db.prepare(`
    INSERT INTO submissions(assignment_id,student_id,text_code,file_path)
    VALUES(?,?,?,?)
    ON CONFLICT(assignment_id,student_id) DO UPDATE SET
      text_code=excluded.text_code,file_path=excluded.file_path,submitted_at=CURRENT_TIMESTAMP
  `).run(assignmentId,req.user.id,textCode || "",file);
  res.json({ok:true});
});

app.get("/api/courses/:id/content", auth, studentAccess, (req,res) => {
  const course = db.prepare("SELECT * FROM courses WHERE id=?").get(req.params.id);
  if (!course) return res.status(404).json({error:"Course not found"});
  if (course.locked && req.user.role !== "admin") return res.status(423).json({error:"This course is locked."});
  const lessons = db.prepare("SELECT * FROM lessons WHERE course_id=? ORDER BY created_at").all(req.params.id);
  res.json({course,lessons});
});

app.listen(PORT, () => {
  console.log(`WPS Academy running on http://localhost:${PORT}`);
  console.log(`Admin: ${adminEmail}`);
});
