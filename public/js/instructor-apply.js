async function api(u,o={}){
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),20000);
  try{
    const r=await fetch(u,{credentials:'same-origin',cache:'no-store',signal:controller.signal,...o});
    let d={}; try{d=await r.json()}catch{}
    if(!r.ok) throw Error(d.error||`Request failed (${r.status})`);
    return d;
  }catch(e){
    if(e?.name==='AbortError') throw Error('The server took too long to respond. Your application may still have been saved. Refresh this page to check before submitting again.');
    if(e instanceof TypeError) throw Error('Could not reach the server. Please check your internet connection and try again.');
    throw e;
  }finally{clearTimeout(timeout)}
}
function showStatus(type,title,message){
  const el=document.getElementById('status');
  el.className='application-status '+type;
  el.innerHTML='<strong>'+escapeHtml(title)+'</strong><span>'+escapeHtml(message)+'</span>';
  el.scrollIntoView({behavior:'smooth',block:'nearest'});
}
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function loadApplicationState(){
  try{
    const me=await api('/api/me');
    if(!me.user){showStatus('error','Login required','Please log in first, then return to this page.');document.getElementById('applyForm').style.display='none';return;}
    const s=await api('/api/instructor/status');
    if(s.approved){location='/instructor.html';return;}
    if(s.application?.status==='pending'){
      showStatus('success','Application already submitted','Your instructor application has been received and is awaiting administrator review.');
      const form=document.getElementById('applyForm'); form.style.display='none'; return;
    }
    if(s.application?.status==='rejected') showStatus('error','Previous application not approved','You may submit a new instructor application.');
  }catch(e){showStatus('error','Could not check application status',e.message||'Please refresh the page and try again.');}
}
loadApplicationState();

document.getElementById('applyForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const form=e.currentTarget;
  const topicsEl=document.getElementById('teachingTopics');
  const messageEl=document.getElementById('message');
  const submitBtn=form.querySelector('button');
  const topics=topicsEl.value.trim();
  const message=messageEl.value.trim();
  if(!topics||!message){showStatus('error','Incomplete application','Please complete both required sections before submitting.');return;}
  submitBtn.disabled=true;
  submitBtn.textContent='Submitting...';
  showStatus('loading','Submitting application','Saving your application. Please wait — do not close this page.');
  try{
    const d=await api('/api/instructor/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({teachingTopics:topics,message})});
    showStatus('success','Application submitted successfully',d.message||'Your instructor application has been received and is awaiting administrator review.');
    // Keep the confirmation and submitted content visible. Do not hide the form
    // until a later page load confirms the pending state from the database.
    submitBtn.textContent='Application Submitted';
    form.querySelectorAll('textarea').forEach(x=>x.readOnly=true);
  }catch(e){
    const msg=e.message||'We could not save your application. Please try again.';
    if(/already awaiting admin review|already submitted/i.test(msg)){
      showStatus('success','Application already submitted','Your application is already saved and awaiting administrator review.');
      submitBtn.textContent='Application Submitted';
      form.querySelectorAll('textarea').forEach(x=>x.readOnly=true);
    }else{
      showStatus('error','Application was not submitted',msg);
      submitBtn.disabled=false;
      submitBtn.textContent='Submit Instructor Application';
    }
  }
});
