(() => {
  "use strict";
  const esc = (v) => String(v ?? "").replace(/[<>&"']/g, ch => ({"<":"&lt;",">":"&gt;","&":"&amp;","\"":"&quot;","'":"&#39;"}[ch]));
  async function loadPublicContactMessages(){
    const el=document.getElementById("contactMessages");
    if(!el)return;
    try{
      const r=await fetch("/api/admin/contact-messages",{credentials:"same-origin"});
      const d=await r.json();
      if(!r.ok)throw new Error(d.error||"Unable to load messages");
      el.innerHTML=d.messages?.length?d.messages.map(m=>{
        const next=m.status==="new"?"read":"resolved";
        return `<div class="panel" style="margin:.75rem 0"><b>${esc(m.name)}</b> · <a href="mailto:${encodeURIComponent(m.email||"").replace(/%40/g,"@")}\">${esc(m.email)}</a><small style="display:block">${new Date(m.createdAt).toLocaleString()} · ${esc(m.status)}</small><p>${esc(m.message)}</p><button class="ghost-btn small contact-status-btn" data-id="${esc(m.id)}" data-next="${next}">Mark ${next}</button></div>`;
      }).join(""):"<p>No public contact messages yet.</p>";
      el.querySelectorAll(".contact-status-btn").forEach(btn=>btn.addEventListener("click",()=>updateContactStatus(btn.dataset.id,btn.dataset.next)));
    }catch(e){el.innerHTML=`<p style="color:#b91c1c">Unable to load contact messages: ${esc(e.message)}</p>`;}
  }
  async function updateContactStatus(id,status){
    try{
      const r=await fetch(`/api/admin/contact-messages/${encodeURIComponent(id)}`,{method:"PATCH",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({status})});
      const d=await r.json();
      if(!r.ok)throw new Error(d.error||"Unable to update message");
      await loadPublicContactMessages();
    }catch(e){alert(e.message||"Unable to update message");}
  }
  window.loadPublicContactMessages=loadPublicContactMessages;
  window.updateContactStatus=updateContactStatus;
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",loadPublicContactMessages);else loadPublicContactMessages();
})();
