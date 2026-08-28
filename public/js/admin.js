async function init(){
 const me=await fetch('/api/me').then(r=>r.json()); if(!me.user||me.user.role!=='admin'){location='/login.html';return}
 const refresh=async()=>{
  const [u,c,p,s,l]=await Promise.all([
   fetch('/api/admin/users').then(r=>r.json()),fetch('/api/courses').then(r=>r.json()),
   fetch('/api/admin/payments').then(r=>r.json()),fetch('/api/admin/submissions').then(r=>r.json()),
   fetch('/api/admin/lessons').then(r=>r.json())
  ]);
  document.getElementById('users').innerHTML=u.users.map(x=>`<div class="row"><span>${x.name} — ${x.email}<br><small>${x.payment_status} / ${x.approved?'approved':'awaiting approval'}</small></span><span><button class="btn small" onclick="approve(${x.id})">Approve</button><button class="btn small" onclick="lockUser(${x.id})">${x.portal_locked?'Unlock':'Lock'} Portal</button></span></div>`).join('');
  const opts=c.courses.map(x=>`<option value="${x.id}">${x.title}</option>`).join('');
  document.getElementById('lessonCourse').innerHTML=opts;document.getElementById('assignmentCourse').innerHTML=opts;
  document.getElementById('courses').innerHTML=c.courses.map(x=>`<div class="row"><span>${x.title}</span><button class="btn small" onclick="lockCourse(${x.id})">${x.locked?'Unlock':'Lock'}</button></div>`).join('');
  document.getElementById('payments').innerHTML=p.payments.map(x=>`<div class="row"><span>${x.name} (${x.email}) — ${x.method}<br>Reference: ${x.reference||'-'} ${x.proof_path?`<a href="${x.proof_path}" target="_blank">Proof</a>`:''}</span><span>${x.status}</span></div>`).join('');
  document.getElementById('submissions').innerHTML=s.submissions.map(x=>`<div class="row"><span>${x.student_name} — ${x.assignment_title}<br>${x.file_path?`<a href="${x.file_path}" target="_blank">Code file</a>`:''}</span><span><input id="g${x.id}" placeholder="Grade" value="${x.grade||''}"><input id="f${x.id}" placeholder="Feedback" value="${x.feedback||''}"><button class="btn small" onclick="grade(${x.id})">Save grade</button></span></div>`).join('');
 };
 window.approve=async id=>{await fetch('/api/admin/users/'+id+'/approve',{method:'POST'});refresh()};
 window.lockUser=async id=>{await fetch('/api/admin/users/'+id+'/toggle-lock',{method:'POST'});refresh()};
 window.lockCourse=async id=>{await fetch('/api/admin/courses/'+id+'/toggle-lock',{method:'POST'});refresh()};
 window.grade=async id=>{await fetch('/api/admin/submissions/'+id+'/grade',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grade:document.getElementById('g'+id).value,feedback:document.getElementById('f'+id).value})});refresh()};
 document.getElementById('lessonForm').onsubmit=async e=>{e.preventDefault();await fetch('/api/admin/lessons',{method:'POST',body:new FormData(e.target)});e.target.reset();refresh()};
 document.getElementById('assignmentForm').onsubmit=async e=>{e.preventDefault();await fetch('/api/admin/assignments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});e.target.reset();refresh()};
 document.getElementById('logout').onclick=async()=>{await fetch('/api/logout',{method:'POST'});location='/'};
 refresh();
}
init();
