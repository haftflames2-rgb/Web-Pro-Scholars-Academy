async function init(){
 const res=await fetch('/api/dashboard');
 const d=await res.json();
 if(!res.ok){location='/login.html';return}
 document.getElementById('assignments').innerHTML=d.assignments.length?d.assignments.map(a=>`
 <div class="card"><h3>${a.title}</h3><p>${a.instructions}</p><small>Course: ${a.course_title||'General'} ${a.due_date?'• Due '+a.due_date:''}</small>
 ${a.grade?`<p><b>Grade:</b> ${a.grade}<br>${a.feedback||''}</p>`:''}
 <form class="submitForm" data-id="${a.id}" enctype="multipart/form-data"><textarea name="textCode" placeholder="Paste your code here"></textarea><input type="file" name="codeFile" accept=".zip,.js,.ts,.py,.html,.css,.jsx,.tsx,.cs,.java,.txt"><button class="btn">Submit Code</button></form></div>`).join(''):'<p>No assignments yet.</p>';
 document.querySelectorAll('.submitForm').forEach(f=>f.onsubmit=async e=>{e.preventDefault();let fd=new FormData(f);fd.append('assignmentId',f.dataset.id);let r=await fetch('/api/submissions',{method:'POST',body:fd});let x=await r.json();alert(x.error||'Submission saved.');});
 document.getElementById('logout').onclick=async()=>{await fetch('/api/logout',{method:'POST'});location='/'};
}
function runCode(){document.getElementById('preview').srcdoc=document.getElementById('sandboxCode').value}
init();
