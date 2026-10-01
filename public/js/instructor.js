async function api(url,opts={}){const r=await fetch(url,opts);let d={};try{d=await r.json()}catch{}if(!r.ok)throw Error(d.error||'Request failed');return d}
const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
let courses=[];
let instructorStudents=[];
let previewData=null;
const previewInstructorId=new URLSearchParams(location.search).get('adminView');
const previewApiBase=previewInstructorId?('/api/admin/instructors/'+encodeURIComponent(previewInstructorId)):'/api/instructor';
async function init(){
 try{
  if(previewInstructorId){
   document.body.classList.add('admin-instructor-preview');
   const d=await api(previewApiBase+'/portal');
   previewData=d;
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
  await refresh();
 }catch(e){document.getElementById('status').textContent=e.message}
 document.getElementById('logout').onclick=async()=>{await api('/api/logout',{method:'POST'});location='/'};
}
async function refresh(){
 if(previewInstructorId){
  const d=previewData||await api(previewApiBase+'/portal');
  previewData=d; courses=d.courses||[]; instructorStudents=d.students||[];
  document.getElementById('summary').innerHTML=`<div class="card"><h3>Courses</h3><strong>${courses.length}</strong></div><div class="card"><h3>Published</h3><strong>${courses.filter(c=>!c.locked).length}</strong></div><div class="card"><h3>Students</h3><strong>${instructorStudents.filter(s=>s.enrolled_course_ids?.length).length}</strong></div><div class="card"><h3>Lessons</h3><strong>${(d.lessons||[]).length}</strong></div>`;
  document.getElementById('courses').innerHTML=courses.length?courses.map(c=>`<div class="row"><span><b>${esc(c.title)}</b><br><small>${esc(c.description)} · ${c.price?'Price: '+c.price:'Free'} · ${c.locked?'🔒 Locked':'✓ Open'}</small></span></div>`).join(''):'<p>No courses yet.</p>';
  renderPreviewLessons(d.lessons||[]); renderStudents(); renderPreviewSubmissions(d.submissions||[]);
  return;
 }
 courses=(await api('/api/instructor/courses')).courses||[];
 document.getElementById('summary').innerHTML=`<div class="card"><h3>My Courses</h3><strong>${courses.length}</strong></div><div class="card"><h3>Published</h3><strong>${courses.filter(c=>!c.locked).length}</strong></div>`;
 const opts=courses.map(c=>`<option value="${c.id}">${esc(c.title)}</option>`).join('');
 document.getElementById('lessonCourse').innerHTML=opts;document.getElementById('assignmentCourse').innerHTML=opts;
 document.getElementById('enrollCourse').innerHTML=opts||'<option value="">Create a course first</option>';
 document.getElementById('courses').innerHTML=courses.length?courses.map(c=>`<div class="row"><span><b>${esc(c.title)}</b><br><small>${esc(c.description)} · ${c.price?'Price: '+c.price:'Free'} · ${c.locked?'🔒 Locked':'✓ Open'}</small></span><span><button class="btn small editCourse" data-id="${c.id}">Edit</button> <button class="btn small lockCourse" data-id="${c.id}">${c.locked?'Unlock':'Lock'}</button> <button class="ghost-btn small deleteCourse" data-id="${c.id}">Delete</button></span></div>`).join(''):'<p>No courses yet. Create your first course above.</p>';
 document.querySelectorAll('.editCourse').forEach(b=>b.onclick=()=>editCourse(b.dataset.id));
 document.querySelectorAll('.lockCourse').forEach(b=>b.onclick=async()=>{try{await api('/api/instructor/courses/'+b.dataset.id+'/toggle-lock',{method:'POST'});refresh()}catch(e){alert(e.message)}});
 document.querySelectorAll('.deleteCourse').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this course and its lessons, assignments and enrollment links?'))return;try{await api('/api/instructor/courses/'+b.dataset.id,{method:'DELETE'});refresh()}catch(e){alert(e.message)}});
 await loadLessons(); await loadStudents(); await loadSubmissions();
}
function editCourse(id){const c=courses.find(x=>x.id===id);if(!c)return;courseId.value=c.id;courseTitle.value=c.title;courseDescription.value=c.description;coursePrice.value=c.price;courseThumbnail.value=c.thumbnail||'';courseSave.textContent='Save Course';courseCancel.hidden=false}
courseCancel.onclick=()=>{courseId.value='';courseForm.reset();coursePrice.value=0;courseSave.textContent='Create Course';courseCancel.hidden=true};
courseForm.onsubmit=async e=>{e.preventDefault();try{const body={title:courseTitle.value,description:courseDescription.value,price:coursePrice.value,thumbnail:courseThumbnail.value};if(courseId.value)await api('/api/instructor/courses/'+courseId.value,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});else await api('/api/instructor/courses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});courseCancel.click();courseMsg.textContent='Course saved successfully.';refresh()}catch(e){courseMsg.textContent=e.message}};
lessonForm.onsubmit=async e=>{e.preventDefault();lessonMsg.textContent='Uploading…';try{const r=await api('/api/instructor/lessons',{method:'POST',body:new FormData(lessonForm)});lessonMsg.textContent=r.updated?'Lesson and selected media updated successfully.':'Lesson and selected media uploaded successfully.';lessonForm.reset();lessonId.innerHTML='<option value="">New lesson</option>';await refresh()}catch(e){lessonMsg.textContent=e.message}};
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
async function loadLessons(){
 if(previewInstructorId){ renderPreviewLessons(previewData?.lessons||[]); return; }
 const d=await api('/api/instructor/lessons');
 lessonId.innerHTML='<option value="">New lesson</option>'+d.lessons.map(l=>`<option value="${l.id}" data-course="${l.course_id}">${esc(l.title)}</option>`).join('');
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
async function loadSubmissions(){if(previewInstructorId){renderPreviewSubmissions(previewData?.submissions||[]);return}const d=await api('/api/instructor/submissions');document.getElementById('submissions').innerHTML=d.submissions.length?d.submissions.map(s=>`<div class="card"><h3>${esc(s.assignment_title)}</h3><p><b>${esc(s.student_name)}</b> — ${esc(s.course_title)}</p>${s.file_path?`<a class="btn small" href="${s.file_path}">Download ${esc(s.file_name||'submission')}</a>`:''}<form class="gradeForm" data-id="${s.id}"><input name="grade" value="${esc(s.grade)}" placeholder="Grade (e.g. 85/100 or A)"><textarea name="feedback" placeholder="Feedback">${esc(s.feedback)}</textarea><button class="btn small">Save Grade</button></form></div>`).join(''):'<p>No submissions yet.</p>';document.querySelectorAll('.gradeForm').forEach(f=>f.onsubmit=async e=>{e.preventDefault();try{await api('/api/instructor/submissions/'+f.dataset.id+'/grade',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});alert('Grade saved.')}catch(e){alert(e.message)}})}
document.getElementById('lessonCourse').onchange=()=>{const selected=document.querySelector('#lessonCourse').value;Array.from(lessonId.options).forEach(o=>{if(o.value)o.hidden=o.dataset.course!==selected})};
init();
