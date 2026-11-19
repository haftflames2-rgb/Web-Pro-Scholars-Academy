async function api(url, opts={}){const r=await fetch(url,opts);let d={};try{d=await r.json()}catch{};if(!r.ok)throw new Error(d.error||'Request failed');return d}
function esc(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
async function init(){
 try{
  const d=await api('/api/dashboard');
  const profileArea=document.getElementById('profileArea');
  if(profileArea){
    const picture=d.user.profile_picture_url || '';
    // My Profile uses the authenticated same-origin image endpoint. This is
    // deliberately separate from the general profile URL used elsewhere.
    const profileImageUrl = picture ? '/api/profile-picture/image' : '';
    profileArea.innerHTML=`<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><div style="width:84px;height:84px;border-radius:50%;overflow:hidden;border:2px solid currentColor;display:flex;align-items:center;justify-content:center;font-size:30px;background:rgba(0,0,0,.05)">${profileImageUrl?`<img src="${profileImageUrl}?v=${Date.now()}" alt="Profile picture" style="width:100%;height:100%;object-fit:cover">`:'👤'}</div><div><p style="margin:0 0 8px"><b>${esc(d.user.name||'Student')}</b><br><small>${esc(d.user.email||'')}</small></p><form id="profilePictureForm" enctype="multipart/form-data"><input type="file" name="profilePicture" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" required><button class="btn small" type="submit">${picture?'Change picture':'Add profile picture'}</button></form><small>JPG, PNG or WEBP, maximum 5 MB.</small></div></div><hr><div class="ai-cost-grid"><div><b>SMARTTEP Student ID</b><br>${esc(d.user.student_id_number||'Not assigned yet')}</div><div><b>Course code</b><br>${esc(d.user.course_code||'Not assigned')}</div><div><b>Registration date</b><br>${esc(d.user.registration_date||'Not set')}</div><div><b>Programme ending</b><br>${esc(d.user.programme_end_date||'Not set')}</div><div><b>State</b><br>${esc(d.user.state||'Not set')}</div><div><b>Country</b><br>${esc(d.user.country||'Not set')}</div><div><b>Gender</b><br>${esc(d.user.gender||'Not set')}</div></div>`;
    // If the saved profile photo URL is missing or unavailable, show a safe avatar fallback.
    const profileImage = profileArea.querySelector('img[alt="Profile picture"]');
    if (profileImage) {
      profileImage.addEventListener('error', () => {
        const imageContainer = profileImage.parentElement;
        if (imageContainer) {
          imageContainer.innerHTML = '<span role="img" aria-label="Default profile avatar">👤</span>';
        }
      }, { once: true });
    }
    const pf=document.getElementById('profilePictureForm');
    pf.onsubmit=async e=>{e.preventDefault();try{await api('/api/profile-picture',{method:'POST',body:new FormData(pf)});alert('Profile picture updated.');location.reload();}catch(err){alert(err.message)}};
  }
  const assignmentStats={total:d.assignments.length,submitted:d.assignments.filter(a=>a.submission_status==='submitted'||a.submission_status==='graded').length,graded:d.assignments.filter(a=>a.submission_status==='graded').length,scores:d.assignments.filter(a=>a.score!==null&&a.score!==undefined&&Number.isFinite(Number(a.score))).map(a=>Number(a.score)/Math.max(1,Number(a.max_points||100))*100)};
  const assignmentSummary=document.getElementById('assignmentProgressSummary');
  if(assignmentSummary){const average=assignmentStats.scores.length?Math.round(assignmentStats.scores.reduce((x,y)=>x+y,0)/assignmentStats.scores.length):null;assignmentSummary.innerHTML=`<div class="ai-cost-grid"><div><b>${assignmentStats.total}</b><br><small>Assigned</small></div><div><b>${assignmentStats.submitted}</b><br><small>Submitted</small></div><div><b>${assignmentStats.graded}</b><br><small>Graded</small></div><div><b>${average===null?'—':average+'%'}</b><br><small>Average graded score</small></div></div>`;}
  document.getElementById('assignments').innerHTML=d.assignments.length?d.assignments.map(a=>`
   <div class="card"><h3>${esc(a.title)}</h3><p>${esc(a.instructions)}</p><small>Course: ${esc(a.course_title||'General')} · ${esc(a.assessment_type||'practical')} assessment · Due: ${a.due_date?esc(a.due_date):'No deadline'} · Maximum: ${Number(a.max_points||100)} points</small>
   ${a.rubric?.length?`<div class="panel"><b>Marking criteria</b><ul>${a.rubric.map(r=>`<li>${esc(r)}</li>`).join('')}</ul></div>`:''}
   <p><b>Submission status:</b> ${esc(a.submission_status||'not_submitted').replaceAll('_',' ')} · <b>Attempts:</b> ${Number(a.attempt_count||0)}</p>
   ${a.submitted_file_name?`<p>Latest uploaded file: ${esc(a.submitted_file_name)}</p>`:''}
   ${a.grade?`<p><b>Grade:</b> ${esc(a.grade)}${a.score!==null?` (${a.score}/${Number(a.max_points||100)} points)`:''}<br><b>Instructor feedback:</b> ${esc(a.feedback||'No feedback provided.')}</p>`:''}
   <form class="submitForm" data-id="${a.id}" enctype="multipart/form-data"><label>Your work / code<textarea name="textCode" maxlength="50000" placeholder="Paste your code, explanation, or project notes here"></textarea></label><label>Attach project file<input type="file" name="codeFile" accept=".jpg,.jpeg,.png,.webp,.gif,.pdf,.zip,.js,.ts,.py,.html,.css,.jsx,.tsx,.cs,.java,.txt,.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf,image/jpeg,image/png,image/webp,image/gif"></label><button class="btn">${a.attempt_count?'Submit revised work':'Submit assignment'}</button><small>Submitting again replaces the current version for marking while keeping the last 10 submission versions in your record.</small></form></div>`).join(''):'<p>No assignments yet.</p>';
  document.querySelectorAll('.submitForm').forEach(f=>f.onsubmit=async e=>{e.preventDefault();try{let fd=new FormData(f);fd.append('assignmentId',f.dataset.id);let x=await api('/api/submissions',{method:'POST',body:fd});alert(x.message||'Submission saved.');location.reload();}catch(err){alert(err.message)}});
  const learning=await api('/api/learning/overview');
  renderLearningDashboard(learning);
  await loadAttendance();
  async function loadAttendance(){
    const box=document.getElementById('attendanceArea'); if(!box)return;
    try{
      const d=await api('/api/attendance');
      if(!d.courses?.length){box.innerHTML='<div class="empty-state">You are not enrolled in a course yet, so there is no attendance calendar to generate.</div>';return}
      box.innerHTML=d.courses.map(c=>renderAttendanceCourse(c,d.today)).join('');
      box.querySelectorAll('.attendance-check').forEach(cb=>cb.addEventListener('change',async()=>{
        cb.disabled=true;
        try{
          const r=await api('/api/attendance/mark',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({courseId:cb.dataset.course})});
          cb.checked=true;
          cb.closest('.attendance-day')?.classList.add('attendance-present');
          const note=cb.closest('.attendance-course')?.querySelector('.attendance-msg');
          if(note) note.textContent=r.message||'Attendance marked successfully for today.';
        }catch(e){cb.checked=false;cb.disabled=false;alert(e.message)}
      }));
    }catch(e){box.innerHTML=`<p class="msg">${esc(e.message)}</p>`}
  }
  function renderAttendanceCourse(c,today){
    const weeks=new Map();
    (c.dates||[]).forEach(x=>{
      const d=new Date(x.date+'T00:00:00Z');
      const monday=new Date(d); monday.setUTCDate(d.getUTCDate()-(d.getUTCDay()||7)+1);
      const key=monday.toISOString().slice(0,10);
      if(!weeks.has(key))weeks.set(key,[]);
      weeks.get(key).push(x);
    });
    const weekHtml=Array.from(weeks.entries()).map(([start,days],i)=>`<div class="attendance-week"><div class="attendance-week-title">Week ${i+1} <small>${esc(start)}</small></div><div class="attendance-days">${days.map(x=>`<label class="attendance-day ${x.marked?'attendance-present':''} ${x.is_today?'attendance-today':''}"><input type="checkbox" class="attendance-check" data-course="${esc(c.course_id)}" data-date="${esc(x.date)}" ${x.marked?'checked':''} ${x.can_mark?'':'disabled'}><span><b>${esc(x.day)}</b><small>${esc(x.date)}</small>${x.is_today?'<em>Today</em>':''}</span></label>`).join('')}</div></div>`).join('');
    return `<div class="attendance-course"><div class="attendance-course-head"><div><b>${esc(c.course_title)}</b><small>${c.duration_weeks} week course · starts ${esc(c.enrollment_date)}</small></div><span>${c.marked_count}/${c.total_days} days marked</span></div><div class="attendance-msg msg"></div>${weekHtml}</div>`;
  }

  const coursesRes=await api('/api/courses'); const box=document.getElementById('courseContent');
  if(box) box.innerHTML=coursesRes.courses.map(c=>`<div class="card"><h3>${esc(c.title)}</h3><p>${esc(c.description)}</p><p>${c.locked?'🔒 Locked':'✓ Available'}</p><button class="btn small open-course" data-id="${c.id}" ${c.locked?'disabled':''}>View Lessons</button><div id="course-${c.id}" class="lesson-list"></div></div>`).join('');
  document.querySelectorAll('.open-course').forEach(btn=>btn.onclick=()=>openCourse(btn.dataset.id));
  async function openCourse(id){
    const target=document.getElementById('course-'+id);
    try{
      const x=await api('/api/courses/'+id+'/content');
      target.dataset.loaded='true';
      target.innerHTML=(x.lessons||[]).map(l=>{
        const lockLabel=l.unlock_at?' until '+esc(new Date(l.unlock_at).toLocaleString()):'';
        let html='<div class="panel lesson-card"><div class="lesson-head"><h4>'+esc(l.title)+'</h4>';
        html += l.locked ? '<span class="student-status">🔒 Locked'+lockLabel+'</span>' : '<button class="btn small lesson-complete" data-id="'+esc(l.id)+'" data-completed="'+(l.completed?'true':'false')+'">'+(l.completed?'✓ Completed':'Mark complete')+'</button>';
        html += '</div>';
        if(l.locked){
          html += '<p class="help-text">🛡️ Smart Security has locked this lesson. '+(l.unlock_at?'It will become available on '+esc(new Date(l.unlock_at).toLocaleString())+'.':'It will become available when Admin/Instructor releases it.')+'</p>';
        } else {
          html += '<p class="help-text">'+(l.accessed?'✓ You have access to this lesson.':'This lesson is now available to you.')+'</p>';
          html += l.note_path ? '<p><a href="'+esc(l.note_path)+'" target="_blank" rel="noopener">📄 Open lecture note</a> <a class="btn small" href="/ai-tutor.html?lessonId='+encodeURIComponent(l.id)+'">🤖 Explain with AI</a></p>' : '<p><a class="btn small" href="/ai-tutor.html?lessonId='+encodeURIComponent(l.id)+'">🤖 Ask AI about lesson</a></p>';
          if(l.video_path) html += '<video controls preload="metadata" playsinline style="width:100%;border-radius:10px"><source src="'+esc(l.video_path)+'">Your browser could not play this lesson video.</video>';
          if(l.audio_path) html += '<div style="margin-top:12px"><p><b>🎵 Lesson audio</b></p><audio controls preload="metadata" style="width:100%"><source src="'+esc(l.audio_path)+'">Your browser could not play this lesson audio.</audio></div>';
        }
        return html+'</div>';
      }).join('') || '<p>No lessons uploaded yet.</p>';
      document.querySelectorAll('.lesson-complete').forEach(btn=>btn.onclick=async()=>{const completed=btn.dataset.completed!=='true';try{await api('/api/learning/lessons/'+btn.dataset.id+'/progress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({completed})});btn.dataset.completed=String(completed);btn.textContent=completed?'✓ Completed':'Mark complete';loadLearningSummary();}catch(e){alert(e.message)}});
    }catch(e){target.innerHTML='<p>'+esc(e.message)+'</p>'}
  }
  async function loadLearningSummary(){const x=await api('/api/learning/overview');renderLearningDashboard(x)}
  document.querySelectorAll('[data-nav]').forEach(btn=>btn.onclick=()=>{ location=btn.dataset.nav; });
  initCodingPractice();
  document.getElementById('logout').onclick=async()=>{await fetch('/api/logout',{method:'POST'});location='/'};
 }catch(e){location='/login.html'}
}
function renderLearningDashboard(data){
 const box=document.getElementById('learningSummary');if(!box)return;
 const t=data.totals||{percent:0,totalLessons:0,completedLessons:0};
 const courses=data.courses||[];
 const courseCards=courses.map(c=>{const pct=c.lessonCount?Math.round(c.completed/c.lessonCount*100):0;const next=(c.lessons||[]).find(l=>!l.completed&&!l.locked);return `<article class="learning-course-card"><div class="learning-course-top"><b>${esc(c.title)}</b><strong>${pct}%</strong></div><div class="progress-track"><span style="width:${pct}%"></span></div><small>${c.completed} of ${c.lessonCount} lessons completed</small>${next?`<p class="learning-next">Next: ${esc(next.title)}</p><button class="btn small dashboard-open-course" data-id="${esc(c.id)}">Continue learning</button>`:c.lessonCount&&pct===100?'<p class="learning-next">🎓 All lessons completed</p>':'<p class="learning-next">No unlocked lesson is currently available.</p>'}</article>`}).join('');
 const quizzes=(data.recentQuizzes||[]).map(q=>`<li><span>${esc(q.title||'Practice quiz')}</span><b>${Number(q.score)||0}/${Number(q.total)||0}</b></li>`).join('');
 box.innerHTML=`<div class="learning-dashboard-head"><div><h2>My Learning Dashboard</h2><p>Progress is calculated from your actual course lessons marked complete.</p></div><div class="learning-overall"><strong>${t.percent||0}%</strong><small>Overall progress</small></div></div><div class="progress-track learning-overall-track"><span style="width:${Math.max(0,Math.min(100,Number(t.percent)||0))}%"></span></div><div class="learning-stats"><div><strong>${t.completedLessons||0}</strong><small>Lessons completed</small></div><div><strong>${t.totalLessons||0}</strong><small>Lessons available</small></div><div><strong>${courses.length}</strong><small>Enrolled courses</small></div></div><h3>Course progress</h3><div class="learning-course-grid">${courseCards||'<p>You have no active course enrolments yet.</p>'}</div><div class="learning-quiz-history"><h3>Recent practice quizzes</h3>${quizzes?`<ul>${quizzes}</ul>`:'<p>No practice quiz attempts recorded yet. Try the AI Tutor practice quiz.</p>'}</div>`;
 box.querySelectorAll('.dashboard-open-course').forEach(btn=>btn.addEventListener('click',()=>{const target=document.getElementById('course-'+btn.dataset.id);if(target){target.scrollIntoView({behavior:'smooth',block:'center'});if(!target.dataset.loaded){const open=document.querySelector('.open-course[data-id="'+CSS.escape(btn.dataset.id)+'"]');if(open)open.click();}}else{const open=document.querySelector('.open-course[data-id="'+CSS.escape(btn.dataset.id)+'"]');if(open)open.click();}}));
}

const codingTasks=[
 {name:'1. HTML profile card',goal:'Create a profile card with a heading, a short paragraph and a link. Use semantic HTML elements.',code:'<!doctype html>\n<html>\n<head><meta name="viewport" content="width=device-width, initial-scale=1"><title>My profile</title></head>\n<body>\n  <main>\n    <h1>My name</h1>\n    <p>I am learning web development at SMARTTEP ACADEMY.</p>\n    <a href="https://example.com">My favourite website</a>\n  </main>\n</body>\n</html>'},
 {name:'2. CSS design challenge',goal:'Style a card with spacing, a background colour, rounded corners and a button. Change the CSS values and run it again.',code:'<!doctype html>\n<html><head><style>\nbody { font-family: Arial, sans-serif; background: #f1f5f9; padding: 30px; }\n.card { max-width: 340px; margin: auto; padding: 24px; background: white; border-radius: 14px; box-shadow: 0 4px 16px #0002; }\nbutton { padding: 10px 16px; border: 0; border-radius: 8px; background: #155e75; color: white; }\n</style></head><body>\n<div class="card"><h1>My first card</h1><p>I styled this with CSS.</p><button>Learn more</button></div>\n</body></html>'},
 {name:'3. JavaScript interaction',goal:'Click the button. Then edit the JavaScript so it displays your own message or updates the page in a different way.',code:'<!doctype html>\n<html><body style="font-family:Arial;padding:24px">\n<h1>JavaScript practice</h1>\n<p id="message">The button has not been clicked yet.</p>\n<button id="change">Click me</button>\n<script>\ndocument.getElementById("change").addEventListener("click", function () {\n  document.getElementById("message").textContent = "Well done! You ran JavaScript.";\n});\n</script></body></html>'},
 {name:'4. JavaScript counter',goal:'The counter starts at zero. Add a second button that decreases the number, or add a reset button.',code:'<!doctype html>\n<html><body style="font-family:Arial;padding:24px">\n<h1>Counter</h1><h2 id="count">0</h2>\n<button id="add">Increase</button>\n<script>\nlet number = 0;\ndocument.getElementById("add").addEventListener("click", () => {\n number += 1; document.getElementById("count").textContent = number;\n});\n</script></body></html>'},
 {name:'5. Responsive layout',goal:'Resize the preview or your browser. Change the breakpoint and card width to see how a media query works.',code:'<!doctype html>\n<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>\n* { box-sizing: border-box; } body { font-family: Arial; margin: 0; padding: 20px; }\n.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }\n.card { background: #e0f2fe; padding: 24px; border-radius: 10px; }\n@media (max-width: 650px) { .cards { grid-template-columns: 1fr; } }\n</style></head><body><h1>Responsive cards</h1>\n<div class="cards"><div class="card">HTML</div><div class="card">CSS</div><div class="card">JavaScript</div></div>\n</body></html>'}
];
function initCodingPractice(){
 const select=document.getElementById('codingTask'),editor=document.getElementById('sandboxCode'),preview=document.getElementById('preview'),goal=document.getElementById('codingGoal'),run=document.getElementById('runCodeBtn'),reset=document.getElementById('resetCodeBtn');
 if(!select||!editor||!preview||!run)return;
 select.innerHTML=codingTasks.map((t,i)=>`<option value="${i}">${esc(t.name)}</option>`).join('');
 let selected=0;const loadTask=(i)=>{selected=Math.max(0,Math.min(codingTasks.length-1,Number(i)||0));select.value=String(selected);editor.value=codingTasks[selected].code;goal.textContent=codingTasks[selected].goal;preview.srcdoc='';};
 select.addEventListener('change',()=>loadTask(select.value));
 run.addEventListener('click',()=>{preview.srcdoc=editor.value;});
 if(reset)reset.addEventListener('click',()=>loadTask(selected));
 loadTask(0);
}
init();

// ===== Student exams + certificate request =====
async function loadStudentExams(){const box=document.getElementById('studentExams');if(!box)return;try{const d=await api('/api/student/exams');const es=d.exams||[];box.innerHTML=es.length?es.map(e=>`<div class="card"><h3>${esc(e.title)}</h3><p>${esc(e.instructions||'')}</p><small>${esc(e.course_title)} · ${e.duration_minutes} minutes · ${e.questions.length} questions</small><p>${e.attempt?.status==='submitted'?`Submitted. Score: ${e.attempt.score}/${e.attempt.maxScore}`:e.attempt?.status==='locked'?`Locked pending administrator review.`:`<button class="btn small startExam" data-id="${e.id}">${e.attempt?.status==='in_progress'?'Resume exam':'Start exam'}</button>`}</p></div>`).join(''):'<p>No exams are currently available for your enrolled courses.</p>';document.querySelectorAll('.startExam').forEach(b=>b.onclick=()=>startStudentExam(b.dataset.id))}catch(e){box.innerHTML=`<p class="msg">${esc(e.message)}</p>`}}
async function startStudentExam(id){
 const runner=document.getElementById('studentExamRunner');
 try{
  const d=await api('/api/student/exams/'+id+'/start',{method:'POST'});
  let seconds=Math.max(1,Math.floor((new Date(d.expires_at)-Date.now())/1000));
  let activeSecurityEvent=null, securityMode=d.exam.security_mode||'lock_after_grace', graceSeconds=Number(d.exam.security_grace_seconds||15), handlingSecurity=false, submitted=false;
  let timer=null, graceFallback=null;
  const showLocked=(message)=>{runner.innerHTML='<div class="card"><h3>🔒 Exam paused for administrator review</h3><p>'+esc(message||'The configured exam-security action was applied. Your attempt is pending administrator review.')+'</p><p>Please contact SMARTTEP ACADEMY administration.</p></div>';};
  const collectAnswers=()=>{const f=document.getElementById('takeExam');if(!f)return d.exam.questions.map(q=>q.type==='objective'?{selectedIndex:null}:{text:''});const fd=new FormData(f);return d.exam.questions.map((q,i)=>q.type==='objective'?{selectedIndex:fd.get('q'+i)===null?null:Number(fd.get('q'+i))}:{text:fd.get('q'+i)||''});};
  const doSubmit=async(confirmFirst=true)=>{
   if(submitted||handlingSecurity)return;
   if(confirmFirst&&!confirm('Submit this exam now?'))return;
   const answers=collectAnswers();
   try{const r=await api('/api/student/exams/'+id+'/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({answers})});submitted=true;document.removeEventListener('visibilitychange',securityVisibility);window.removeEventListener('pagehide',securityPageHide);if(timer)clearInterval(timer);if(graceFallback)clearTimeout(graceFallback);runner.innerHTML=`<div class="card"><h3>Exam submitted successfully</h3><p>Objective score: ${r.objective_score}/${r.max_score}. Theory questions will be marked by your instructor/administrator.</p>${r.theory_pending?'<p>Theory result: Pending instructor/administrator marking.</p>':''}</div>`;loadStudentExams();}
   catch(err){if(err.message.toLowerCase().includes('locked'))showLocked(err.message);else if(err.message.toLowerCase().includes('expired')){showLocked('The server deadline has passed. Your answers could not be accepted; contact an administrator if a technical issue prevented submission.');}else alert(err.message)}
  };
  const reportSecurityViolation=async(reason)=>{
   if(activeSecurityEvent||submitted||handlingSecurity)return;
   handlingSecurity=true;
   try{
    const r=await fetch('/api/student/exams/'+id+'/security-violation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason}),credentials:'same-origin',keepalive:true});
    const data=await r.json().catch(()=>({}));
    if(r.status===423||data.locked){showLocked(data.error);handlingSecurity=false;return;}
    if(!r.ok)throw new Error(data.error||'Could not record exam security event.');
    activeSecurityEvent=data.event_id;
    if(data.warning&&document.visibilityState==='visible') alert('Exam security warning: leaving the exam page has been recorded. Please remain on the exam page. '+(securityMode==='lock_after_grace'?'If you do not return within the hidden grace period, the configured action will apply.':'This event will follow the exam’s review settings.'));
    // This fallback is not visible to the student. The server remains authoritative.
    if(securityMode==='lock_after_grace')graceFallback=setTimeout(()=>{if(activeSecurityEvent&&document.visibilityState!=='visible'){showLocked('The security grace period elapsed. Your attempt is pending administrator review.');}},graceSeconds*1000+500);
   }catch(e){console.warn('Exam security event could not be confirmed:',e.message)}finally{handlingSecurity=false;}
  };
  const securityVisibility=async()=>{
   if(document.visibilityState==='hidden'){reportSecurityViolation('exam-page-hidden-or-tab-switched');return;}
   if(document.visibilityState==='visible'&&activeSecurityEvent){
    const eventId=activeSecurityEvent;activeSecurityEvent=null;if(graceFallback)clearTimeout(graceFallback);
    try{const r=await api('/api/student/exams/'+id+'/security-return',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({eventId})});if(r.locked)showLocked(r.message||r.error);else if(securityMode==='lock_after_grace')alert('You returned to the exam within the grace period. The event has been recorded, but no automatic lock was applied. Please stay on the exam page.');else if(securityMode==='review')alert('This exam security event has been recorded for administrator review. Your account has not been automatically locked.');}
    catch(e){if(e.message.toLowerCase().includes('locked'))showLocked(e.message);else console.warn(e.message)}
   }
  };
  const securityPageHide=()=>{if(!activeSecurityEvent&&!submitted)reportSecurityViolation('exam-page-left-or-closed');};
  document.addEventListener('visibilitychange',securityVisibility);
  window.addEventListener('pagehide',securityPageHide,{once:true});
  const render=()=>{runner.innerHTML=`<div class="panel"><h2>${esc(d.exam.title)}</h2><p id="examTimer"><b>Time remaining: ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}</b></p><p class="help-text">🛡️ Exam Smart Security is active. If you switch away from this page, the event may be recorded. Depending on the exam settings, you may receive a warning, an administrator review, or a lock after a hidden grace period.</p><form id="takeExam">${d.exam.questions.map(q=>q.type==='objective'?`<fieldset class="card"><legend>${q.number}. ${esc(q.text)} (${q.marks} marks)</legend>${q.options.map((o,i)=>`<label><input type="radio" name="q${q.number-1}" value="${i}"> ${String.fromCharCode(65+i)}. ${esc(o)}</label>`).join('')}</fieldset>`:`<fieldset class="card"><legend>${q.number}. ${esc(q.text)} (${q.marks} marks)</legend><textarea name="q${q.number-1}" rows="5" placeholder="Type your answer"></textarea></fieldset>`).join('')}<button class="btn" type="submit">Submit Exam</button></form></div>`;
   document.getElementById('takeExam').onsubmit=async e=>{e.preventDefault();await doSubmit(true)};
  };
  render();
  timer=setInterval(()=>{seconds=Math.max(0,Math.floor((new Date(d.expires_at)-Date.now())/1000));const el=document.getElementById('examTimer');if(el)el.innerHTML='<b>Time remaining: '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0')+'</b>';if(Date.now()>=new Date(d.expires_at).getTime()-1000){clearInterval(timer);const timerLabel=document.getElementById('examTimer');if(timerLabel)timerLabel.innerHTML='<b>Time is up. Submitting your answers…</b>';doSubmit(false);}},250);
 }catch(e){runner.innerHTML=`<p class="msg">${esc(e.message)}</p>`}
}
(function(){loadStudentExams();const f=document.getElementById('certificateForm');if(f)f.onsubmit=async e=>{e.preventDefault();const msg=document.getElementById('certificateMsg');try{const r=await api('/api/certificate-requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});msg.textContent=r.message;f.reset()}catch(err){msg.textContent=err.message}}})();
