async function api(url,opts={}){const r=await fetch(url,opts);let d={};try{d=await r.json()}catch{}if(!r.ok)throw Error(d.error||'Request failed');return d}
const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
let courses=[];
let instructorStudents=[];
let previewData=null;
let instructorIdentity=null;
const previewInstructorId=new URLSearchParams(location.search).get('adminView');
const previewApiBase=previewInstructorId?('/api/admin/instructors/'+encodeURIComponent(previewInstructorId)):'/api/instructor';
async function init(){
 try{
  if(previewInstructorId){
   document.body.classList.add('admin-instructor-preview');
   const d=await api(previewApiBase+'/portal');
   previewData=d;
   instructorIdentity=d.instructor||null;
   renderInstructorCard(instructorIdentity,true);
   document.getElementById('status').innerHTML=`<div class="msg">Admin view-only mode — <b>${esc(d.instructor?.name||'Instructor')}</b> · ${esc(d.instructor?.email||'')} <a class="ghost-btn small" href="/admin.html">Back to Admin Portal</a></div>`;
   document.querySelector('h1').textContent='Instructor Portal — Admin View';
   document.querySelector('main > p').textContent='Read-only view of this instructor’s portal. Changes must be made from the instructor account or administrator controls.';
   document.querySelectorAll('form').forEach(f=>f.style.display='none');
   document.querySelector('.enrollment-bar')?.style.setProperty('display','none');
   document.querySelectorAll('.deleteCourse,.lockCourse,.editCourse,.deleteLesson,.enrollBtn,#enrollStudentBtn').forEach(b=>b.style.display='none');
   await refresh();
   return;
  }
  const st=await api('/api/instructor/status'); if(!st.approved){location='/instructor-apply.html';return}
  instructorIdentity=st; renderInstructorCard(st,false);
  await refresh();
 }catch(e){document.getElementById('status').textContent=e.message}
 document.getElementById('logout').onclick=async()=>{await api('/api/logout',{method:'POST'});location='/'};
}

function renderInstructorCard(d,adminPreview){
 const box=document.getElementById('instructorIdCard'); if(!box) return;
 const id=d?.instructor_id_number||'';
 const picture=d?.profile_picture_url||'';
 box.innerHTML=`<div class="instructor-id-card">
   <div class="instructor-id-card-top"><img src="/images/smarttep-academy-logo.png" alt="SMARTTEP ACADEMY"><div><b>SMARTTEP ACADEMY</b><span>OFFICIAL INSTRUCTOR ID</span></div></div>
   <div class="instructor-id-card-body"><div class="instructor-id-photo">${picture?`<img src="${esc(picture+'?v='+Date.now())}" alt="Instructor profile picture">`:'👤'}</div><div class="instructor-id-info"><h2>${esc(d?.name||'Instructor')}</h2><p><b>ID:</b> ${esc(id||'Not assigned')}</p><p><b>Department:</b> ${esc(d?.department||'Not set')}</p><p><b>Issued:</b> ${esc(d?.registration_date||'Not set')}</p>${d?.expiry_date?`<p><b>Expires:</b> ${esc(d.expiry_date)}</p>`:''}</div></div>
   <div class="instructor-id-card-bottom"><span>Verification: <b>${id?'Available online':'Pending ID assignment'}</b></span><span>${d?.suspended?'SUSPENDED':'VALID'}</span></div></div>
 <div class="id-card-actions">${id?`<a class="ghost-btn small" href="/verify-instructor.html?q=${encodeURIComponent(id)}" target="_blank" rel="noopener">Verify this ID</a>`:''}<button type="button" class="btn small" id="printInstructorId">Print ID Card</button></div>`;
 document.getElementById('printInstructorId')?.addEventListener('click',()=>window.print());
}
async function refresh(){
 if(previewInstructorId){
  const d=previewData||await api(previewApiBase+'/portal');
  previewData=d; courses=d.courses||[]; instructorStudents=d.students||[];
  document.getElementById('summary').innerHTML=`<div class="card"><h3>Courses</h3><strong>${courses.length}</strong></div><div class="card"><h3>Published</h3><strong>${courses.filter(c=>!c.locked).length}</strong></div><div class="card"><h3>Students</h3><strong>${instructorStudents.filter(s=>s.enrolled_course_ids?.length).length}</strong></div><div class="card"><h3>Lessons</h3><strong>${(d.lessons||[]).length}</strong></div>`;
  document.getElementById('courses').innerHTML=courses.length?courses.map(c=>`<div class="row"><span><b>${esc(c.title)}</b><br><small>${esc(c.description)} · ${c.price?'Price: '+c.price:'Free'} · ${Number(c.duration_weeks||12)} weeks · ${c.locked?'🔒 Locked':'✓ Open'}</small></span></div>`).join(''):'<p>No courses yet.</p>';
  renderPreviewLessons(d.lessons||[]); renderStudents(); renderPreviewSubmissions(d.submissions||[]);
  return;
 }
 courses=(await api('/api/instructor/courses')).courses||[];
 document.getElementById('summary').innerHTML=`<div class="card"><h3>My Courses</h3><strong>${courses.length}</strong></div><div class="card"><h3>Published</h3><strong>${courses.filter(c=>!c.locked).length}</strong></div>`;
 const opts=courses.map(c=>`<option value="${c.id}">${esc(c.title)}</option>`).join('');
 document.getElementById('lessonCourse').innerHTML=opts;document.getElementById('assignmentCourse').innerHTML=opts;document.getElementById('instructorExamCourse').innerHTML=opts;
 document.getElementById('enrollCourse').innerHTML=opts||'<option value="">Create a course first</option>';
 document.getElementById('courses').innerHTML=courses.length?courses.map(c=>`<div class="row"><span><b>${esc(c.title)}</b><br><small>${esc(c.description)} · ${c.price?'Price: '+c.price:'Free'} · ${Number(c.duration_weeks||12)} weeks · ${c.locked?'🔒 Locked':'✓ Open'}</small></span><span><button class="btn small editCourse" data-id="${c.id}">Edit</button> <button class="btn small lockCourse" data-id="${c.id}">${c.locked?'Unlock':'Lock'}</button> <button class="ghost-btn small deleteCourse" data-id="${c.id}">Delete</button></span></div>`).join(''):'<p>No courses yet. Create your first course above.</p>';
 document.querySelectorAll('.editCourse').forEach(b=>b.onclick=()=>editCourse(b.dataset.id));
 document.querySelectorAll('.lockCourse').forEach(b=>b.onclick=async()=>{try{await api('/api/instructor/courses/'+b.dataset.id+'/toggle-lock',{method:'POST'});refresh()}catch(e){alert(e.message)}});
 document.querySelectorAll('.deleteCourse').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this course and its lessons, assignments and enrollment links?'))return;try{await api('/api/instructor/courses/'+b.dataset.id,{method:'DELETE'});refresh()}catch(e){alert(e.message)}});
 await loadLessons(); await loadStudents(); await loadSubmissions(); await loadInstructorAttendance();
}
function editCourse(id){const c=courses.find(x=>x.id===id);if(!c)return;courseId.value=c.id;courseTitle.value=c.title;courseDescription.value=c.description;coursePrice.value=c.price;courseThumbnail.value=c.thumbnail||'';courseDurationWeeks.value=Number(c.duration_weeks||12);courseSave.textContent='Save Course';courseCancel.hidden=false}
courseCancel.onclick=()=>{courseId.value='';courseForm.reset();coursePrice.value=0;courseDurationWeeks.value=12;courseSave.textContent='Create Course';courseCancel.hidden=true};
courseForm.onsubmit=async e=>{e.preventDefault();try{const body={title:courseTitle.value,description:courseDescription.value,price:coursePrice.value,durationWeeks:Number(courseDurationWeeks.value||12),thumbnail:courseThumbnail.value};if(courseId.value)await api('/api/instructor/courses/'+courseId.value,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});else await api('/api/instructor/courses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});courseCancel.click();courseMsg.textContent='Course saved successfully.';refresh()}catch(e){courseMsg.textContent=e.message}};
lessonForm.onsubmit=async e=>{e.preventDefault();lessonMsg.textContent='Uploading…';try{const fd=new FormData(lessonForm);const unlockValue=fd.get('unlockAt');if(unlockValue){const parsedUnlock=new Date(unlockValue);if(!Number.isNaN(parsedUnlock.getTime()))fd.set('unlockAt',parsedUnlock.toISOString());}const r=await api('/api/instructor/lessons',{method:'POST',body:fd});lessonMsg.textContent=r.updated?'Lesson and selected media updated successfully.':'Lesson and selected media uploaded successfully.';lessonForm.reset();lessonId.innerHTML='<option value="">New lesson</option>';await refresh()}catch(e){lessonMsg.textContent=e.message}};
function mediaMarkup(l){
 let html='<div class="lesson-media-preview">';
 if(l.note_path) html+=`<a class="btn small" href="${esc(l.note_path)}">📄 Open / download note</a>`;
 if(l.video_path) html+=`<div class="lesson-media-item"><b>🎥 Video</b><video controls preload="metadata" playsinline src="${esc(l.video_path)}">Your browser could not play this lesson video.</video></div>`;
 if(l.audio_path) html+=`<div class="lesson-media-item"><b>🎵 Audio</b><audio controls preload="metadata" src="${esc(l.audio_path)}">Your browser could not play this lesson audio.</audio></div>`;
 return html+'</div>';
}
function renderPreviewLessons(lessons){
 document.getElementById('lessons').innerHTML=lessons.length?lessons.map(l=>`<div class="row lesson-row"><span><b>${esc(l.title)}</b><br><small>${esc(courses.find(c=>c.id===l.course_id)?.title||'Course')}</small>${mediaMarkup(l)}</span></div>`).join(''):'<p>No lessons uploaded yet.</p>';
}
function renderPreviewSubmissions(items){
 document.getElementById('submissions').innerHTML=items.length?items.map(s=>`<div class="card"><h3>${esc(s.assignment_title)}</h3><p><b>${esc(s.student_name)}</b> — ${esc(s.course_title)}</p>${s.file_path?`<a class="btn small" href="${esc(s.file_path)}">Download ${esc(s.file_name||'submission')}</a>`:''}<p>${s.grade?`<b>Grade:</b> ${esc(s.grade)}`:'Not graded yet'}${s.feedback?`<br><b>Feedback:</b> ${esc(s.feedback)}`:''}</p></div>`).join(''):'<p>No submissions yet.</p>';
}
function localDateTimeValue(value){ if(!value)return ''; const d=new Date(value); if(Number.isNaN(d.getTime()))return ''; const pad=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
async function loadLessons(){
 if(previewInstructorId){ renderPreviewLessons(previewData?.lessons||[]); return; }
 const d=await api('/api/instructor/lessons');
 lessonId.innerHTML='<option value="">New lesson</option>'+d.lessons.map(l=>`<option value="${l.id}" data-course="${l.course_id}" data-unlock="${esc(l.unlock_at||'')}">${esc(l.title)}</option>`).join('');
 const syncLessonSettings=()=>{const l=d.lessons.find(x=>x.id===lessonId.value);const u=document.getElementById('lessonUnlockAt');if(u)u.value=localDateTimeValue(l?.unlock_at);}; lessonId.onchange=syncLessonSettings; syncLessonSettings();
 document.getElementById('lessons').innerHTML=d.lessons.length?d.lessons.map(l=>`<div class="row lesson-row"><span><b>${esc(l.title)}</b><br><small>${esc(courses.find(c=>c.id===l.course_id)?.title||'Course')}</small>${mediaMarkup(l)}</span><span><button class="ghost-btn small deleteLesson" data-id="${l.id}">Delete</button></span></div>`).join(''):'<p>No lessons uploaded yet.</p>';
 document.querySelectorAll('.deleteLesson').forEach(b=>b.onclick=async()=>{if(confirm('Delete this lesson and its media?')){await api('/api/instructor/lessons/'+b.dataset.id,{method:'DELETE'});refresh()}})
}
assignmentForm.onsubmit=async e=>{e.preventDefault();try{await api('/api/instructor/assignments',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(assignmentForm))),headers:{'Content-Type':'application/json'}});assignmentForm.reset();alert('Assignment created.')}catch(e){alert(e.message)}};
async function loadStudents(){
 if(previewInstructorId){ instructorStudents=previewData?.students||[]; renderStudents(); return; }
 const d=await api('/api/instructor/students');
 instructorStudents=d.students||[];
 const studentSelect=document.getElementById('enrollStudent');
 studentSelect.innerHTML=instructorStudents.length?instructorStudents.map(s=>`<option value="${s.id}">${esc(s.name)} — ${esc(s.email)}</option>`).join(''):'<option value="">No student accounts found</option>';
 renderStudents();
}
function renderStudents(){
 const box=document.getElementById('students');
 if(!instructorStudents.length){box.innerHTML='<div class="empty-state"><b>No student accounts found.</b><p>Students must create student accounts before they can be enrolled.</p></div>';return}
 box.innerHTML=instructorStudents.map(s=>`<div class="student-card"><div class="student-card-head"><div><b>${esc(s.name||'Student')}</b><small>${esc(s.email||'')}</small></div><span class="student-status">${s.approved?'Approved':'Awaiting approval'}${s.portal_locked?' · Locked':''}</span></div><div class="student-course-status">${courses.length?courses.map(c=>{const enrolled=s.enrolled_course_ids.includes(c.id);return `<div class="student-course-row"><span>${esc(c.title)}${enrolled?' · Enrolled':''}</span>${previewInstructorId?'':`<button type="button" class="${enrolled?'ghost-btn':'btn'} small enrollBtn" data-student="${s.id}" data-course="${c.id}" data-enrolled="${enrolled}">${enrolled?'Remove enrollment':'Enroll student'}</button>`}</div>`}).join(''):'<small>Create a course to enable enrollment.</small>'}</div></div>`).join('');
 document.querySelectorAll('.enrollBtn').forEach(b=>b.onclick=()=>setEnrollment(b.dataset.student,b.dataset.course,b.dataset.enrolled!=='true'));
}
async function setEnrollment(studentId,courseId,enroll){
 const msg=document.getElementById('enrollMsg');msg.textContent=enroll?'Enrolling…':'Removing…';
 try{await api('/api/instructor/students/'+studentId+'/enrollment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({courseId,enroll})});msg.textContent=enroll?'Student enrolled successfully.':'Student removed from the course.';await loadStudents()}catch(e){msg.textContent=e.message}
}
document.getElementById('enrollStudentBtn').onclick=async()=>{const studentId=document.getElementById('enrollStudent').value,courseId=document.getElementById('enrollCourse').value;if(!studentId||!courseId){document.getElementById('enrollMsg').textContent='Select a student and course first.';return}const student=instructorStudents.find(s=>s.id===studentId);const already=student?.enrolled_course_ids.includes(courseId);await setEnrollment(studentId,courseId,!already)};
async function loadInstructorAttendance(){
 const box=document.getElementById('instructorAttendance'); if(!box)return;
 if(previewInstructorId){box.innerHTML='<p class="help-text">Attendance is available to the active instructor account only.</p>';return}
 try{
  const d=await api('/api/instructor/attendance');
  if(!d.courses?.length){box.innerHTML='<div class="empty-state">Create a course and enroll students to start attendance.</div>';return}
  box.innerHTML=d.courses.map(c=>`<div class="attendance-course"><div class="attendance-course-head"><div><b>${esc(c.course_title)}</b><small>${c.duration_weeks} week course</small></div><span>${c.students.length} student(s)</span></div>${c.students.length?`<div class="attendance-table-wrap"><table><thead><tr><th>Student</th><th>Enrollment</th><th>Attendance</th><th>Today</th></tr></thead><tbody>${c.students.map(s=>`<tr><td><b>${esc(s.student_name)}</b><br><small>${esc(s.email)}</small></td><td>${esc(s.enrollment_date||'')}</td><td>${s.marked_count}/${s.total_days}</td><td>${s.today_marked?'✓ Present':'Not marked'}</td></tr>`).join('')}</tbody></table></div>`:'<p class="empty-state">No approved students enrolled in this course.</p>'}</div>`).join('');
 }catch(e){box.innerHTML=`<p class="msg">${esc(e.message)}</p>`}
}
async function loadSubmissions(){if(previewInstructorId){renderPreviewSubmissions(previewData?.submissions||[]);return}const d=await api('/api/instructor/submissions');document.getElementById('submissions').innerHTML=d.submissions.length?d.submissions.map(s=>`<div class="card"><h3>${esc(s.assignment_title)}</h3><p><b>${esc(s.student_name)}</b> — ${esc(s.course_title)}</p>${s.file_path?`<a class="btn small" href="${s.file_path}">Download ${esc(s.file_name||'submission')}</a>`:''}<form class="gradeForm" data-id="${s.id}"><input name="grade" value="${esc(s.grade)}" placeholder="Grade (e.g. 85/100 or A)"><textarea name="feedback" placeholder="Feedback">${esc(s.feedback)}</textarea><button class="btn small">Save Grade</button></form></div>`).join(''):'<p>No submissions yet.</p>';document.querySelectorAll('.gradeForm').forEach(f=>f.onsubmit=async e=>{e.preventDefault();try{await api('/api/instructor/submissions/'+f.dataset.id+'/grade',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});alert('Grade saved.')}catch(e){alert(e.message)}})}
document.getElementById('lessonCourse').onchange=()=>{const selected=document.querySelector('#lessonCourse').value;Array.from(lessonId.options).forEach(o=>{if(o.value)o.hidden=o.dataset.course!==selected})};
init();

// ===== Instructor exams + read-only certificate requests =====
function examQuestionHtmlI(q,i){if(q.type==='theory')return `<div class="card exam-q" data-type="theory"><b>Theory question ${i+1}</b><button type="button" class="ghost-btn small remove-exam-q">Remove</button><textarea class="exam-text" placeholder="Theory question" required></textarea><input class="exam-marks" type="number" min="1" value="1"></div>`;return `<div class="card exam-q" data-type="objective"><b>Objective question ${i+1}</b><button type="button" class="ghost-btn small remove-exam-q">Remove</button><textarea class="exam-text" placeholder="Question" required></textarea><div class="ai-cost-grid"><input class="exam-opt" placeholder="Option A"><input class="exam-opt" placeholder="Option B"><input class="exam-opt" placeholder="Option C"></div><label>Correct answer<select class="exam-correct"><option value="0">A</option><option value="1">B</option><option value="2">C</option></select></label><input class="exam-marks" type="number" min="1" value="1"></div>`}
function setupInstructorExamBuilder(root){const state=[];const render=()=>{root.innerHTML=state.map(examQuestionHtmlI).join('');root.querySelectorAll('.remove-exam-q').forEach((b,i)=>b.onclick=()=>{state.splice(i,1);render()})};return{add(t){state.push(t==='theory'?{type:t}:{type:'objective'});render()},collect(){return [...root.querySelectorAll('.exam-q')].map(q=>{const type=q.dataset.type;return type==='theory'?{type,text:q.querySelector('.exam-text').value,marks:Number(q.querySelector('.exam-marks').value||1)}:{type,text:q.querySelector('.exam-text').value,options:[...q.querySelectorAll('.exam-opt')].map(x=>x.value),correctIndex:Number(q.querySelector('.exam-correct').value),marks:Number(q.querySelector('.exam-marks').value||1)}})}}}
async function loadInstructorExams(){const box=document.getElementById('instructorExams');if(!box||previewInstructorId)return;try{const d=await api('/api/instructor/exams');const es=d.exams||[];box.innerHTML=es.length?`<h3>My created exams</h3><div class="table-wrap"><table><thead><tr><th>Exam</th><th>Course</th><th>Questions</th><th>Actions</th></tr></thead><tbody>${es.map(e=>`<tr><td>${esc(e.title)}</td><td>${esc(e.course_title)}</td><td>${e.questions.length}</td><td><button class="btn small inst-attempts" data-id="${e.id}">Student attempts</button> <button class="ghost-btn small inst-delete" data-id="${e.id}">Delete</button></td></tr>`).join('')}</tbody></table></div>`:'<p>No exams created yet.</p>';document.querySelectorAll('.inst-attempts').forEach(b=>b.onclick=()=>loadInstructorExamAttempts(b.dataset.id));document.querySelectorAll('.inst-delete').forEach(b=>b.onclick=async()=>{if(confirm('Delete this exam?')){await api('/api/instructor/exams/'+b.dataset.id,{method:'DELETE'});loadInstructorExams()}})}catch(e){box.innerHTML=`<p class="msg">${esc(e.message)}</p>`}}
async function loadInstructorExamAttempts(id){
 const box=document.getElementById('instructorExamAttempts');
 try{
  const d=await api('/api/instructor/exams/'+id+'/attempts');
  let html='<h3>'+esc(d.exam.title)+' — Student Attempts</h3>';
  if(!d.attempts.length){html+='<p>No attempts yet.</p>';box.innerHTML=html;return;}
  html+='<div class="exam-attempts">'+d.attempts.map(a=>{
   const theory=d.exam.questions.some(q=>q.type==='theory');
   const form=theory?'<form class="instTheoryMark" data-id="'+a.id+'">'+d.exam.questions.map((q,i)=>q.type==='theory'?'<label>'+i+1+'. '+esc(q.text)+' ('+q.marks+')<textarea disabled>'+esc(a.answers?.[i]?.text||'No answer')+'</textarea><input name="g'+i+'" type="number" min="0" max="'+q.marks+'" value="'+(a.answers?.[i]?.theoryScore??'')+'"></label>':'').join('')+'<button class="btn small">Save theory marks</button></form>':'';
   return '<div class="card"><b>'+esc(a.student_name)+'</b> — '+esc(a.email)+'<p>Objective: '+a.objective_score+' · Theory: '+a.theory_score+' · <b>Total: '+a.score+'/'+a.max_score+'</b></p>'+form+'</div>';
  }).join('')+'</div>';
  box.innerHTML=html;
  document.querySelectorAll('.instTheoryMark').forEach(f=>f.onsubmit=async e=>{e.preventDefault();const fd=new FormData(f);const grades=d.exam.questions.map((q,i)=>q.type==='theory'?Number(fd.get('g'+i)||0):null);try{await api('/api/instructor/exams/attempts/'+f.dataset.id+'/mark-theory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grades})});await loadInstructorExamAttempts(id);}catch(err){alert(err.message);}});
 }catch(e){box.innerHTML='<p class="msg">'+esc(e.message)+'</p>';}
}
async function loadInstructorCertificates(){const box=document.getElementById('instructorCertificateRequests');if(!box||previewInstructorId)return;try{const d=await api('/api/instructor/certificate-requests');box.innerHTML=d.requests.length?`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Course</th><th>ID</th><th>Status</th></tr></thead><tbody>${d.requests.map(r=>`<tr><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td>${esc(r.course)}</td><td>${esc(r.id_number)}</td><td>${esc(r.status)}</td></tr>`).join('')}</tbody></table></div>`:'<p>No certificate requests yet.</p>'}catch(e){box.innerHTML=`<p class="msg">${esc(e.message)}</p>`}}
(function(){const root=document.getElementById('instructorExamQuestions');if(!root)return;const b=setupInstructorExamBuilder(root);document.getElementById('instructorAddObjective').onclick=()=>b.add('objective');document.getElementById('instructorAddTheory').onclick=()=>b.add('theory');document.getElementById('instructorExamForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/instructor/exams',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({courseId:instructorExamCourse.value,title:instructorExamTitle.value,instructions:instructorExamInstructions.value,durationMinutes:Number(instructorExamDuration.value),questions:b.collect(),published:true})});alert('Exam created successfully.');e.target.reset();root.innerHTML='';loadInstructorExams()}catch(err){alert(err.message)}};loadInstructorExams();loadInstructorCertificates();api('/api/instructor/courses').then(d=>{const sel=document.getElementById('instructorExamCourse');if(sel)sel.innerHTML=(d.courses||[]).map(c=>`<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('')}).catch(()=>{})})();
