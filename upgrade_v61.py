from pathlib import Path
p=Path('/mnt/data/v61work/server.js')
s=p.read_text()
old='''        result.push({
          id: a._id.toString(), title: a.title, instructions: a.instructions,
          due_date: a.dueDate || "", course_title: course?.title || "General",
          grade: s?.grade || "", feedback: s?.feedback || ""
        });'''
new='''        result.push({
          id: a._id.toString(), title: a.title, instructions: a.instructions,
          due_date: a.dueDate || "", course_title: course?.title || "General",
          assessment_type: a.assessmentType || "practical", max_points: Number(a.maxPoints || 100),
          rubric: Array.isArray(a.rubric) ? a.rubric : [],
          grade: s?.grade || "", score: Number.isFinite(Number(s?.score)) ? Number(s.score) : null,
          feedback: s?.feedback || "", submission_status: s?.submittedAt ? (s?.gradedAt ? "graded" : "submitted") : "not_submitted",
          submitted_at: s?.submittedAt || null, attempt_count: Number(s?.attemptCount || (s?.submittedAt ? 1 : 0)),
          submitted_file_name: s?.file?.originalName || ""
        });'''
assert old in s
s=s.replace(old,new,1)
# Replace admin create route insert payload
old='''      const result = await assignments.insertOne({ courseId, title, instructions, dueDate: req.body.dueDate || null, createdAt: new Date() });'''
new='''      const maxPoints = Math.max(1, Math.min(1000, Number(req.body.maxPoints || 100)));
      const rubric = String(req.body.rubric || "").split(/\\r?\\n/).map(x => smartSafeText(x, 240)).filter(Boolean).slice(0, 12);
      const assessmentType = ["practical", "project", "written"].includes(String(req.body.assessmentType)) ? String(req.body.assessmentType) : "practical";
      const result = await assignments.insertOne({ courseId, title: smartSafeText(title, 160), instructions: smartSafeText(instructions, 5000), dueDate: req.body.dueDate || null, assessmentType, maxPoints, rubric, createdAt: new Date(), createdBy: req.user._id.toString(), createdByRole: "admin" });'''
assert old in s
s=s.replace(old,new,1)
# Instructor create route
old='''      const result=await assignments.insertOne({courseId,title,instructions,dueDate:req.body.dueDate||null,createdAt:new Date(),createdBy:req.user._id.toString()});'''
new='''      const maxPoints=Math.max(1,Math.min(1000,Number(req.body.maxPoints||100)));
      const rubric=String(req.body.rubric||"").split(/\\r?\\n/).map(x=>smartSafeText(x,240)).filter(Boolean).slice(0,12);
      const assessmentType=["practical","project","written"].includes(String(req.body.assessmentType))?String(req.body.assessmentType):"practical";
      const result=await assignments.insertOne({courseId,title:smartSafeText(title,160),instructions:smartSafeText(instructions,5000),dueDate:req.body.dueDate||null,assessmentType,maxPoints,rubric,createdAt:new Date(),createdBy:req.user._id.toString(),createdByRole:"instructor"});'''
assert old in s
s=s.replace(old,new,1)
# instructor submissions payload
old='''        result.push({id:sub._id.toString(),assignment_title:a.title,course_title:(await courseCollection.findOne({_id:a.courseId}))?.title||"Unknown",student_name:u?.name||"Unknown",email:u?.email||"",file_path:sub.file?.url?`/api/instructor/submissions/${sub._id}/file`:"",file_name:sub.file?.originalName||"",grade:sub.grade||"",feedback:sub.feedback||""});'''
new='''        result.push({id:sub._id.toString(),assignment_title:a.title,course_title:(await courseCollection.findOne({_id:a.courseId}))?.title||"Unknown",student_name:u?.name||"Unknown",email:u?.email||"",file_path:sub.file?.url?`/api/instructor/submissions/${sub._id}/file`:"",file_name:sub.file?.originalName||"",text_code:sub.textCode||"",grade:sub.grade||"",score:Number.isFinite(Number(sub.score))?Number(sub.score):null,max_points:Number(a.maxPoints||100),rubric:Array.isArray(a.rubric)?a.rubric:[],assessment_type:a.assessmentType||"practical",feedback:sub.feedback||"",attempt_count:Number(sub.attemptCount||1),submitted_at:sub.submittedAt||null,history:(sub.submissionHistory||[]).slice(-5).map(h=>({submittedAt:h.submittedAt,fileName:h.file?.originalName||"",textCode:h.textCode||""}))});'''
assert old in s
s=s.replace(old,new,1)
# Instructor grading route
old='''      const id=oid(req.params.id); const grade=String(req.body.grade||"").trim().slice(0,50); const feedback=String(req.body.feedback||"").trim().slice(0,3000);
      const sub=id?await submissions.findOne({_id:id}):null; const a=sub?await assignments.findOne({_id:sub.assignmentId}):null;
      if(!sub||!a||!a.courseId||!(await instructorOwnsCourse(req.user,a.courseId))) return res.status(404).json({error:"Submission not found."});
      await submissions.updateOne({_id:id},{$set:{grade,feedback,gradedAt:new Date(),gradedBy:req.user._id.toString()}});'''
new='''      const id=oid(req.params.id); const grade=String(req.body.grade||"").trim().slice(0,50); const feedback=smartSafeText(String(req.body.feedback||""),3000);
      const sub=id?await submissions.findOne({_id:id}):null; const a=sub?await assignments.findOne({_id:sub.assignmentId}):null;
      if(!sub||!a||!a.courseId||!(await instructorOwnsCourse(req.user,a.courseId))) return res.status(404).json({error:"Submission not found."});
      const hasScore=req.body.score!==undefined && req.body.score!==""; const score=hasScore?Number(req.body.score):null; const maxPoints=Math.max(1,Number(a.maxPoints||100));
      if(hasScore&&(!Number.isFinite(score)||score<0||score>maxPoints)) return res.status(400).json({error:`Enter a score between 0 and ${maxPoints}.`});
      await submissions.updateOne({_id:id},{$set:{grade:hasScore?`${score}/${maxPoints}`:grade,score:hasScore?score:sub.score,feedback,gradedAt:new Date(),gradedBy:req.user._id.toString(),gradedByRole:"instructor"}});'''
assert old in s
s=s.replace(old,new,1)
# submission route replace upsert update
old='''      await submissions.updateOne(
        { assignmentId, studentId: req.user._id },
        { $set: { textCode: req.body.textCode || "", file, submittedAt: new Date() }, $setOnInsert: { assignmentId, studentId: req.user._id, grade: "", feedback: "" } },
        { upsert: true }
      );'''
new='''      const textCode=String(req.body.textCode||"").slice(0,50000);
      if(!textCode.trim()&&!file) return res.status(400).json({error:"Add your written work/code or attach a project file before submitting."});
      if(assignment.dueDate){const due=new Date(`${assignment.dueDate}T23:59:59`);if(!Number.isNaN(due.getTime())&&new Date()>due)return res.status(403).json({error:"The submission deadline has passed. Contact your instructor if you need an extension."});}
      const now=new Date();
      const previous=await submissions.findOne({assignmentId,studentId:req.user._id});
      const snapshot={textCode,file,submittedAt:now};
      await submissions.updateOne(
        { assignmentId, studentId: req.user._id },
        { $set: { textCode, file, submittedAt: now, grade: "", score: null, feedback: "", gradedAt: null }, $inc:{attemptCount:1}, $push:{submissionHistory:{ $each:[snapshot], $slice:-10 }}, $setOnInsert: { assignmentId, studentId: req.user._id, createdAt:now } },
        { upsert: true }
      );'''
assert old in s
s=s.replace(old,new,1)
p.write_text(s)
