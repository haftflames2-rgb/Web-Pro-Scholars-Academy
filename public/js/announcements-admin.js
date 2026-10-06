(function(){
  const api=async(url,opts={})=>{const r=await fetch(url,{credentials:'same-origin',...opts});let d={};try{d=await r.json()}catch{};if(!r.ok)throw new Error(d.error||'Request failed');return d};
  const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const fmt=v=>v?new Date(v).toLocaleString():'';
  async function load(){
    const box=document.getElementById('announcementList');if(!box)return;
    try{const d=await api('/api/admin/announcements');const rows=d.announcements||[];
      box.innerHTML=rows.length?rows.map(a=>`<div class="announcement-admin-row"><div><strong>${esc(a.title)}</strong><div class="announcement-meta">Audience: ${esc(a.audience==='all'?'Students + Instructors':a.audience==='student'?'Students only':'Instructors only')} · ${esc(a.displayMode==='once'?'Once per user':'Every login until expiry')} · ${a.active?'<span class="status-live">Active</span>':'<span class="status-off">Paused</span>'}</div><div class="announcement-meta">${a.startAt?'Starts '+esc(fmt(a.startAt)): 'Starts immediately'}${a.endAt?' · Ends '+esc(fmt(a.endAt)): ' · No expiry set'}</div><p>${esc(a.message)}</p>${a.imageUrl?`<img class="announcement-admin-image" src="${esc(a.imageUrl)}" alt="${esc(a.imageAlt)}">`:''}</div><div class="announcement-actions"><button class="ghost-btn small ann-toggle" data-id="${esc(a.id)}" data-active="${a.active?'1':'0'}">${a.active?'Pause':'Activate'}</button><button class="ghost-btn small ann-renew" data-id="${esc(a.id)}">Renew</button><button class="ghost-btn small ann-delete" data-id="${esc(a.id)}">Delete</button></div></div>`).join(''):'<p>No announcements created yet.</p>';
      box.querySelectorAll('.ann-toggle').forEach(b=>b.onclick=async()=>{try{await api('/api/admin/announcements/'+b.dataset.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({active:b.dataset.active!=='1'})});load()}catch(e){alert(e.message)}});
      box.querySelectorAll('.ann-renew').forEach(b=>b.onclick=async()=>{const start=prompt('Renewal start date/time (optional, e.g. 2026-10-05T08:00)'); if(start===null)return; const end=prompt('Renewal end date/time (optional, e.g. 2026-10-12T23:59)'); if(end===null)return; try{await api('/api/admin/announcements/'+b.dataset.id+'/renew',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({startAt:start||null,endAt:end||null})});load()}catch(e){alert(e.message)}});
      box.querySelectorAll('.ann-delete').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this announcement? Its uploaded picture will also be removed.'))return;try{await api('/api/admin/announcements/'+b.dataset.id,{method:'DELETE'});load()}catch(e){alert(e.message)}});
    }catch(e){box.textContent=e.message||'Unable to load announcements.'}
  }
  function init(){
    const f=document.getElementById('announcementForm');if(!f)return;
    f.onsubmit=async e=>{e.preventDefault();const msg=document.getElementById('announcementMsg');msg.textContent='Sending…';try{const fd=new FormData(f);const r=await api('/api/admin/announcements',{method:'POST',body:fd});msg.textContent=r.ok?'Announcement created successfully.':'';f.reset();document.getElementById('annActive').checked=true;load()}catch(err){msg.textContent=err.message||'Unable to create announcement.'}};
    load();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
