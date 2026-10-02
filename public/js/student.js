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
  document.getElementById('assignments').innerHTML=d.assignments.length?d.assignments.map(a=>`
   <div class="card"><h3>${esc(a.title)}</h3><p>${esc(a.instructions)}</p><small>Course: ${esc(a.course_title||'General')} ${a.due_date?'• Due '+esc(a.due_date):''}</small>
   ${a.grade?`<p><b>Grade:</b> ${esc(a.grade)}<br>${esc(a.feedback||'')}</p>`:''}
   <form class="submitForm" data-id="${a.id}" enctype="multipart/form-data"><textarea name="textCode" placeholder="Paste your code here"></textarea><input type="file" name="codeFile" accept=".jpg,.jpeg,.png,.webp,.gif,.pdf,.zip,.js,.ts,.py,.html,.css,.jsx,.tsx,.cs,.java,.txt,.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf,image/jpeg,image/png,image/webp,image/gif"><button class="btn">Submit Assignment</button></form></div>`).join(''):'<p>No assignments yet.</p>';
  document.querySelectorAll('.submitForm').forEach(f=>f.onsubmit=async e=>{e.preventDefault();try{let fd=new FormData(f);fd.append('assignmentId',f.dataset.id);let x=await api('/api/submissions',{method:'POST',body:fd});alert(x.error||'Submission saved.');}catch(err){alert(err.message)}});
  const learning=await api('/api/learning/overview');
  const summary=document.getElementById('learningSummary');
  if(summary) summary.innerHTML=`<div class="progress-card"><div><b>Learning progress</b><div class="progress-track"><span style="width:${learning.totals.percent}%"></span></div></div><strong>${learning.totals.percent}%</strong></div>`;
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
  async function openCourse(id){const target=document.getElementById('course-'+id);try{const x=await api('/api/courses/'+id+'/content');target.innerHTML=x.lessons.length?x.lessons.map(l=>`<div class="panel lesson-card"><div class="lesson-head"><h4>${esc(l.title)}</h4><button class="btn small lesson-complete" data-id="${l.id}" data-completed="${l.completed?'true':'false'}">${l.completed?'✓ Completed':'Mark complete'}</button></div>${l.note_path?`<p><a href="${l.note_path}" target="_blank" rel="noopener">📄 Download lecture note</a> <a class="btn small" href="/ai-tutor.html?lessonId=${encodeURIComponent(l.id)}">🤖 Explain with AI</a></p>`:`<p><a class="btn small" href="/ai-tutor.html?lessonId=${encodeURIComponent(l.id)}">🤖 Ask AI about lesson</a></p>`}${l.video_path?`<video controls preload="metadata" playsinline style="width:100%;border-radius:10px"><source src="${l.video_path}">Your browser could not play this lesson video.</video>`:''}${l.audio_path?`<div style="margin-top:12px"><p><b>🎵 Lesson audio</b></p><audio controls preload="metadata" style="width:100%"><source src="${l.audio_path}">Your browser could not play this lesson audio.</audio></div>`:''}</div>`).join(''):'<p>No lessons uploaded yet.</p>';document.querySelectorAll('.lesson-complete').forEach(btn=>btn.onclick=async()=>{const completed=btn.dataset.completed!=='true';try{await api('/api/learning/lessons/'+btn.dataset.id+'/progress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({completed})});btn.dataset.completed=String(completed);btn.textContent=completed?'✓ Completed':'Mark complete';loadLearningSummary();}catch(e){alert(e.message)}});}catch(e){target.innerHTML='<p>'+esc(e.message)+'</p>'}}

  async function loadLearningSummary(){const x=await api('/api/learning/overview');const s=document.getElementById('learningSummary');if(s)s.innerHTML=`<div class="progress-card"><div><b>Learning progress</b><div class="progress-track"><span style="width:${x.totals.percent}%"></span></div></div><strong>${x.totals.percent}%</strong></div>`}
  document.querySelectorAll('[data-nav]').forEach(btn=>btn.onclick=()=>{ location=btn.dataset.nav; });
  const runBtn=document.getElementById('runCodeBtn'); if(runBtn) runBtn.onclick=runCode;
  document.getElementById('logout').onclick=async()=>{await fetch('/api/logout',{method:'POST'});location='/'};
 }catch(e){location='/login.html'}
}
function runCode(){document.getElementById('preview').srcdoc=document.getElementById('sandboxCode').value}
init();

// ===== Student exams + certificate request =====
async function loadStudentExams(){const box=document.getElementById('studentExams');if(!box)return;try{const d=await api('/api/student/exams');const es=d.exams||[];box.innerHTML=es.length?es.map(e=>`<div class="card"><h3>${esc(e.title)}</h3><p>${esc(e.instructions||'')}</p><small>${esc(e.course_title)} · ${e.duration_minutes} minutes · ${e.questions.length} questions</small><p>${e.attempt?.status==='submitted'?`Submitted. Score: ${e.attempt.score}/${e.attempt.maxScore}`:`<button class="btn small startExam" data-id="${e.id}">Start exam</button>`}</p></div>`).join(''):'<p>No exams are currently available for your enrolled courses.</p>';document.querySelectorAll('.startExam').forEach(b=>b.onclick=()=>startStudentExam(b.dataset.id))}catch(e){box.innerHTML=`<p class="msg">${esc(e.message)}</p>`}}
async function startStudentExam(id){const runner=document.getElementById('studentExamRunner');try{const d=await api('/api/student/exams/'+id+'/start',{method:'POST'});let seconds=Math.max(1,Math.floor((new Date(d.expires_at)-Date.now())/1000));const render=()=>{runner.innerHTML=`<div class="panel"><h2>${esc(d.exam.title)}</h2><p id="examTimer"><b>Time remaining: ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}</b></p><form id="takeExam">${d.exam.questions.map(q=>q.type==='objective'?`<fieldset class="card"><legend>${q.number}. ${esc(q.text)} (${q.marks} marks)</legend>${q.options.map((o,i)=>`<label><input type="radio" name="q${q.number-1}" value="${i}"> ${String.fromCharCode(65+i)}. ${esc(o)}</label>`).join('')}</fieldset>`:`<fieldset class="card"><legend>${q.number}. ${esc(q.text)} (${q.marks} marks)</legend><textarea name="q${q.number-1}" rows="5" placeholder="Type your answer"></textarea></fieldset>`).join('')}<button class="btn" type="submit">Submit Exam</button></form></div>`;document.getElementById('takeExam').onsubmit=async e=>{e.preventDefault();if(!confirm('Submit this exam now?'))return;const fd=new FormData(e.target);const answers=d.exam.questions.map((q,i)=>q.type==='objective'?{selectedIndex:fd.get('q'+i)===null?null:Number(fd.get('q'+i))}:{text:fd.get('q'+i)||''});try{const r=await api('/api/student/exams/'+id+'/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({answers})});runner.innerHTML=`<div class="card"><h3>Exam submitted successfully</h3><p>Objective score: ${r.objective_score}/${r.max_score}. Theory questions will be marked by your instructor/administrator.</p></div>`;loadStudentExams()}catch(err){alert(err.message)}}};render();const timer=setInterval(()=>{seconds--;if(seconds<=0){clearInterval(timer);alert('Your exam time has expired. Please submit immediately if the form is still available.');}const el=document.getElementById('examTimer');if(el)el.innerHTML='<b>Time remaining: '+Math.floor(Math.max(0,seconds)/60)+':'+String(Math.max(0,seconds)%60).padStart(2,'0')+'</b>'},1000)}catch(e){runner.innerHTML=`<p class="msg">${esc(e.message)}</p>`}}
(function(){loadStudentExams();const f=document.getElementById('certificateForm');if(f)f.onsubmit=async e=>{e.preventDefault();const msg=document.getElementById('certificateMsg');try{const r=await api('/api/certificate-requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});msg.textContent=r.message;f.reset()}catch(err){msg.textContent=err.message}}})();
