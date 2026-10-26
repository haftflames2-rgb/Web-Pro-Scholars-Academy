(function(){
  const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  function style(){
    if(document.getElementById('smartAnnouncementStyles')) return;
    const s=document.createElement('style');s.id='smartAnnouncementStyles';s.textContent=`
      .smart-announcement-backdrop{position:fixed;inset:0;background:rgba(7,18,13,.62);display:flex;align-items:center;justify-content:center;padding:16px;z-index:99999;backdrop-filter:blur(2px)}
      .smart-announcement{width:min(680px,100%);max-height:min(88vh,760px);overflow:auto;background:#fff;border-radius:20px;box-shadow:0 24px 80px rgba(0,0,0,.3);border:1px solid rgba(0,0,0,.12);position:relative}
      .smart-announcement-head{padding:20px 52px 10px 22px}.smart-announcement-head h2{margin:0;font-size:24px;line-height:1.2}.smart-announcement-body{padding:0 22px 20px}.smart-announcement-body p{white-space:pre-wrap;line-height:1.7;margin:0}.smart-announcement-image{display:block;width:100%;max-height:300px;object-fit:cover}.smart-announcement-close{position:absolute;right:12px;top:12px;width:42px;height:42px;border-radius:50%;border:1px solid rgba(0,0,0,.15);background:#f5f7f6;font-size:24px;cursor:pointer;line-height:1}.smart-announcement-actions{padding:14px 22px 20px;display:flex;justify-content:flex-end;gap:10px;border-top:1px solid #edf1ee}.smart-announcement-actions button{min-width:110px}.smart-announcement-label{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#65736b;margin-bottom:7px}
      @media(max-width:600px){.smart-announcement{border-radius:16px;max-height:92vh}.smart-announcement-head{padding:18px 52px 8px 18px}.smart-announcement-head h2{font-size:20px}.smart-announcement-body{padding:0 18px 16px}.smart-announcement-actions{padding:12px 18px 16px}.smart-announcement-close{width:38px;height:38px}}
    `;document.head.appendChild(s);
  }
  async function closePopup(item, backdrop){
    try{await fetch('/api/announcements/'+encodeURIComponent(item.id)+'/acknowledge',{method:'POST',credentials:'same-origin'});}catch(_){ }
    backdrop.remove();
  }
  function show(item){
    style();
    const backdrop=document.createElement('div');backdrop.className='smart-announcement-backdrop';backdrop.setAttribute('role','dialog');backdrop.setAttribute('aria-modal','true');backdrop.setAttribute('aria-labelledby','smartAnnouncementTitle');
    backdrop.innerHTML=`<article class="smart-announcement"><button class="smart-announcement-close" type="button" aria-label="Close announcement">×</button>${item.imageUrl?`<img class="smart-announcement-image" src="${esc(item.imageUrl)}" alt="${esc(item.imageAlt||'Announcement')}">`:''}<div class="smart-announcement-head"><div class="smart-announcement-label">SMARTTEP ACADEMY • Announcement</div><h2 id="smartAnnouncementTitle">${esc(item.title)}</h2></div><div class="smart-announcement-body"><p>${esc(item.message)}</p></div><div class="smart-announcement-actions"><button class="btn smart-announcement-ok" type="button">${item.displayMode==='every_login'?'Close':'Got it'}</button></div></article>`;
    document.body.appendChild(backdrop);
    const close=()=>closePopup(item,backdrop);
    backdrop.querySelector('.smart-announcement-close').addEventListener('click',close);
    backdrop.querySelector('.smart-announcement-ok').addEventListener('click',close);
    backdrop.addEventListener('keydown',e=>{if(e.key==='Escape')close()});
    setTimeout(()=>backdrop.querySelector('.smart-announcement-ok')?.focus(),50);
  }
  async function load(){
    try{
      const r=await fetch('/api/announcements/active',{credentials:'same-origin',cache:'no-store'});if(!r.ok)return;
      const d=await r.json();const items=Array.isArray(d.announcements)?d.announcements:[];
      // Show the highest-priority announcement first. Additional announcements remain
      // available after the current one is dismissed, avoiding stacked popups.
      for(const item of items){show(item);await new Promise(resolve=>{const timer=setInterval(()=>{if(!document.querySelector('.smart-announcement-backdrop')){clearInterval(timer);resolve();}},100);});}
    }catch(_){ }
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',load,{once:true});else load();
})();
