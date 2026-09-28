async function api(url, opts={}){const r=await fetch(url,opts);let d={};try{d=await r.json()}catch{};if(!r.ok)throw new Error(d.error||'Request failed');return d}
function esc(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
async function init(){
 try{
  const d=await api('/api/dashboard');
  const profileArea=document.getElementById('profileArea');
  if(profileArea){
    const picture=d.user.profile_picture_url || '';
    profileArea.innerHTML=`<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><div style="width:84px;height:84px;border-radius:50%;overflow:hidden;border:2px solid currentColor;display:flex;align-items:center;justify-content:center;font-size:30px;background:rgba(0,0,0,.05)">${picture?`<img src="${esc(picture)}" alt="Profile picture" style="width:100%;height:100%;object-fit:cover">`:'👤'}</div><div><p style="margin:0 0 8px"><b>${esc(d.user.name||'Student')}</b><br><small>${esc(d.user.email||'')}</small></p><form id="profilePictureForm" enctype="multipart/form-data"><input type="file" name="profilePicture" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" required><button class="btn small" type="submit">${picture?'Change picture':'Add profile picture'}</button></form><small>JPG, PNG or WEBP, maximum 5 MB.</small></div></div><hr><div class="ai-cost-grid"><div><b>WPS Student ID</b><br>${esc(d.user.student_id_number||'Not assigned yet')}</div><div><b>Course code</b><br>${esc(d.user.course_code||'Not assigned')}</div><div><b>Registration date</b><br>${esc(d.user.registration_date||'Not set')}</div><div><b>Programme ending</b><br>${esc(d.user.programme_end_date||'Not set')}</div><div><b>State</b><br>${esc(d.user.state||'Not set')}</div><div><b>Country</b><br>${esc(d.user.country||'Not set')}</div><div><b>Gender</b><br>${esc(d.user.gender||'Not set')}</div></div>`;
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
