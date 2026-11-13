(function(){
  const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  async function api(url,opts={}){const r=await fetch(url,{credentials:'same-origin',...opts});let d={};try{d=await r.json()}catch{};if(!r.ok)throw new Error(d.error||'Request failed');return d;}
  async function init(){
    const form=document.getElementById('adminPushForm'); if(!form)return;
    try{const s=await api('/api/admin/push/stats');document.getElementById('pushStats').textContent=`Registered notification devices: ${s.total} total (${s.students} students, ${s.instructors} instructors).`;}catch(_){ }
    form.onsubmit=async e=>{e.preventDefault();const msg=document.getElementById('adminPushMsg');msg.textContent='Sending…';try{const fd=new FormData(form);const d=Object.fromEntries(fd.entries());const r=await api('/api/admin/push/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});msg.textContent=`Sent to ${r.sent} device(s). ${r.removed||0} expired device(s) removed.`;}catch(err){msg.textContent=err.message||'Unable to send.';}};
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
