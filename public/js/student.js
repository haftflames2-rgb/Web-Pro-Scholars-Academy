async function api(url, opts={}){const r=await fetch(url,opts);let d={};try{d=await r.json()}catch{};if(!r.ok)throw new Error(d.error||'Request failed');return d}
function esc(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
async function init(){
 try{
  const d=await api('/api/dashboard');
  document.getElementById('assignments').innerHTML=d.assignments.length?d.assignments.map(a=>`
   <div class="card"><h3>${esc(a.title)}</h3><p>${esc(a.instructions)}</p><small>Course: ${esc(a.course_title||'General')} ${a.due_date?'• Due '+esc(a.due_date):''}</small>
   ${a.grade?`<p><b>Grade:</b> ${esc(a.grade)}<br>${esc(a.feedback||'')}</p>`:''}
   <form class="submitForm" data-id="${a.id}" enctype="multipart/form-data"><textarea name="textCode" placeholder="Paste your code here"></textarea><input type="file" name="codeFile" accept=".zip,.js,.ts,.py,.html,.css,.jsx,.tsx,.cs,.java,.txt"><button class="btn">Submit Code</button></form></div>`).join(''):'<p>No assignments yet.</p>';
  document.querySelectorAll('.submitForm').forEach(f=>f.onsubmit=async e=>{e.preventDefault();try{let fd=new FormData(f);fd.append('assignmentId',f.dataset.id);let x=await api('/api/submissions',{method:'POST',body:fd});alert(x.error||'Submission saved.');}catch(err){alert(err.message)}});
  const learning=await api('/api/learning/overview');
  const summary=document.getElementById('learningSummary');
  if(summary) summary.innerHTML=`<div class="progress-card"><div><b>Learning progress</b><div class="progress-track"><span style="width:${learning.totals.percent}%"></span></div></div><strong>${learning.totals.percent}%</strong></div>`;
  const coursesRes=await api('/api/courses'); const box=document.getElementById('courseContent');
  if(box) box.innerHTML=coursesRes.courses.map(c=>`<div class="card"><h3>${esc(c.title)}</h3><p>${esc(c.description)}</p><p>${c.locked?'🔒 Locked':'✓ Available'}</p><button class="btn small" onclick="openCourse('${c.id}')" ${c.locked?'disabled':''}>View Lessons</button><div id="course-${c.id}" class="lesson-list"></div></div>`).join('');
  window.openCourse=async id=>{const target=document.getElementById('course-'+id);try{const x=await api('/api/courses/'+id+'/content');target.innerHTML=x.lessons.length?x.lessons.map(l=>`<div class="panel lesson-card"><div class="lesson-head"><h4>${esc(l.title)}</h4><button class="btn small lesson-complete" data-id="${l.id}" data-completed="${l.completed?'true':'false'}">${l.completed?'✓ Completed':'Mark complete'}</button></div>${l.note_path?`<p><a href="${l.note_path}" target="_blank" rel="noopener">📄 Open lecture note</a></p>`:''}${l.video_path?`<video controls preload="metadata" style="width:100%;border-radius:10px" src="${l.video_path}"></video>`:''}</div>`).join(''):'<p>No lessons uploaded yet.</p>';document.querySelectorAll('.lesson-complete').forEach(btn=>btn.onclick=async()=>{const completed=btn.dataset.completed!=='true';try{await api('/api/learning/lessons/'+btn.dataset.id+'/progress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({completed})});btn.dataset.completed=String(completed);btn.textContent=completed?'✓ Completed':'Mark complete';loadLearningSummary();}catch(e){alert(e.message)}});}catch(e){target.innerHTML='<p>'+esc(e.message)+'</p>'}};
  async function loadLearningSummary(){const x=await api('/api/learning/overview');const s=document.getElementById('learningSummary');if(s)s.innerHTML=`<div class="progress-card"><div><b>Learning progress</b><div class="progress-track"><span style="width:${x.totals.percent}%"></span></div></div><strong>${x.totals.percent}%</strong></div>`}
  document.getElementById('logout').onclick=async()=>{await fetch('/api/logout',{method:'POST'});location='/'};
 }catch(e){location='/login.html'}
}
function runCode(){document.getElementById('preview').srcdoc=document.getElementById('sandboxCode').value}
init();
