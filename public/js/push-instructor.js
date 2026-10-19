(function(){
  async function api(url,opts={}){const r=await fetch(url,{credentials:'same-origin',...opts});let d={};try{d=await r.json()}catch{};if(!r.ok)throw new Error(d.error||'Request failed');return d;}
  async function loadCourses(){
    const sel=document.getElementById('instructorPushCourse');if(!sel)return;
    try{const r=await api('/api/instructor/courses');const rows=r.courses||r||[];sel.innerHTML=rows.map(c=>`<option value="${String(c.id||c._id).replace(/"/g,'&quot;')}">${String(c.title||'Course').replace(/[&<>"']/g,'')}</option>`).join('');}catch(_){ }
  }
  async function init(){const f=document.getElementById('instructorPushForm');if(!f)return;await loadCourses();f.onsubmit=async e=>{e.preventDefault();const m=document.getElementById('instructorPushMsg');m.textContent='Sending…';try{const d=Object.fromEntries(new FormData(f).entries());const r=await api('/api/instructor/push/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});m.textContent=`Sent to ${r.sent} enrolled device(s).`;f.reset();}catch(err){m.textContent=err.message||'Unable to send.';}};}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
