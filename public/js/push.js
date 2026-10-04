(function(){
  const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  function supported(){return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;}
  async function api(url,opts={}){const r=await fetch(url,{credentials:'same-origin',...opts});let d={};try{d=await r.json()}catch{};if(!r.ok)throw new Error(d.error||'Request failed');return d;}
  function panel(role){
    if(document.getElementById('smartPushPanel')) return;
    const el=document.createElement('section');el.id='smartPushPanel';el.className='panel';
    el.innerHTML=`<h2>🔔 Phone Notifications</h2><p class="help-text">Allow SMARTTEP ACADEMY to send important updates to this phone, such as new lessons, lesson updates and announcements.</p><button type="button" class="btn" id="smartPushEnable">Enable phone notifications</button> <span id="smartPushStatus" class="msg"></span><p id="smartPushHelp" class="help-text"></p>`;
    const anchor=document.querySelector('main h1'); if(anchor?.parentElement) anchor.parentElement.insertBefore(el,anchor.nextElementSibling); else document.querySelector('main')?.prepend(el);
    const btn=el.querySelector('#smartPushEnable'), status=el.querySelector('#smartPushStatus'), help=el.querySelector('#smartPushHelp');
    if(!supported()){btn.disabled=true;status.textContent='This browser does not support web push notifications.';return;}
    async function refresh(){
      try{const d=await api('/api/push/status');if(d.subscriptions>0){btn.textContent='Notifications enabled on this device';btn.disabled=true;status.textContent='Active';}}
      catch(e){help.textContent=e.message;}
    }
    btn.onclick=async()=>{
      try{
        btn.disabled=true;status.textContent='Enabling…';
        const permission=await Notification.requestPermission();
        if(permission!=='granted'){btn.disabled=false;status.textContent='Notification permission was not granted.';return;}
        const reg=await navigator.serviceWorker.register('/sw.js',{scope:'/'});
        await navigator.serviceWorker.ready;
        const cfg=await api('/api/push/public-key');
        if(!cfg.publicKey) throw new Error('Push notifications are not configured on the server.');
        let sub=await reg.pushManager.getSubscription();
        if(!sub) sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:base64ToUint8(cfg.publicKey)});
        await api('/api/push/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscription:sub.toJSON()})});
        status.textContent='Enabled. This phone can now receive SMARTTEP notifications.';btn.textContent='Notifications enabled on this device';
      }catch(e){btn.disabled=false;status.textContent=e.message||'Unable to enable notifications.';}
    };
    refresh();
  }
  function base64ToUint8(base64){const padding='='.repeat((4-base64.length%4)%4);const raw=atob((base64+padding).replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));}
  async function init(){
    if(!supported()) return;
    try{const me=await api('/api/me');const role=me.user?.role;if(role==='student'||role==='instructor')panel(role);}catch(_){ }
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
