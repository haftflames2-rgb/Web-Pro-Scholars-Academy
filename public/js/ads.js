/* SMARTTEP ACADEMY V25 Advertising Renderer
 * Direct ads take priority over AdSense. AdSense site/publisher code is preserved.
 * Direct-ad impressions are recorded only after a valid image loads and the ad is
 * actually visible in the viewport. Network ads require a configured ad-unit slot.
 */
(function(){
  'use strict';
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const loadedScripts={};
  const rendered=new WeakSet();

  function waitForAdSense(timeout=8000){
    if(Array.isArray(window.adsbygoogle)) return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const started=Date.now();
      const timer=setInterval(()=>{
        if(Array.isArray(window.adsbygoogle)){clearInterval(timer);resolve();return;}
        if(Date.now()-started>=timeout){clearInterval(timer);reject(new Error('AdSense script did not become ready.'));}
      },100);
    });
  }

  function loadScript(src){
    if(Array.isArray(window.adsbygoogle)) return Promise.resolve();
    if(loadedScripts[src]) return loadedScripts[src];
    const existing=document.querySelector('script[src*="adsbygoogle.js"]');
    if(existing){loadedScripts[src]=waitForAdSense();return loadedScripts[src];}
    loadedScripts[src]=new Promise((resolve,reject)=>{
      const s=document.createElement('script');
      s.async=true;s.src=src;
      s.onload=()=>waitForAdSense().then(resolve).catch(reject);
      s.onerror=()=>reject(new Error('AdSense script failed to load.'));
      document.head.appendChild(s);
    });
    return loadedScripts[src];
  }

  function setError(el,message){
    el.hidden=true;
    el.dataset.adError=message||'Advertisement unavailable';
  }

  function observeImpression(el,ad,img){
    if(el.dataset.impressionSent==='1') return;
    const record=()=>{
      if(el.dataset.impressionSent==='1') return;
      el.dataset.impressionSent='1';
      fetch('/api/ads/'+encodeURIComponent(ad.id)+'/impression',{
        method:'POST',credentials:'same-origin',keepalive:true,
        headers:{'X-Requested-With':'XMLHttpRequest'}
      }).catch(()=>{});
    };
    if(!('IntersectionObserver' in window)){record();return;}
    const io=new IntersectionObserver(entries=>{
      if(entries.some(e=>e.isIntersecting && e.intersectionRatio>=0.5)){
        io.disconnect();record();
      }
    },{threshold:[0.5]});
    io.observe(el);
  }

  async function renderDirect(el,ad){
    if(!ad.imageUrl){setError(el,'Direct advertisement has no banner image.');return;}
    el.innerHTML='<div class="ad-label">Advertisement</div><a class="direct-ad" href="'+esc(ad.clickUrl)+'" target="_blank" rel="sponsored noopener noreferrer"><img alt="'+esc(ad.alt||ad.title||'Advertisement')+'" loading="eager"></a>';
    const img=el.querySelector('img');
    img.src=ad.imageUrl;
    img.addEventListener('error',()=>setError(el,'Advertisement image could not be loaded.'),{once:true});
    try{
      if(!img.complete) await new Promise((resolve,reject)=>{img.addEventListener('load',resolve,{once:true});img.addEventListener('error',reject,{once:true});});
      if(!img.naturalWidth){setError(el,'Advertisement image could not be loaded.');return;}
      el.hidden=false;
      observeImpression(el,ad,img);
    }catch(_){setError(el,'Advertisement image could not be loaded.');}
  }

  async function renderNetwork(el,ad){
    if(!ad.publisherId || !/^ca-pub-[0-9]{6,30}$/.test(ad.publisherId) || !ad.slot){
      setError(el,'AdSense banner slot is not configured yet.');
      return;
    }
    el.hidden=false;
    el.innerHTML='<div class="ad-label">Advertisement</div><ins class="adsbygoogle" style="display:block;min-width:250px;min-height:50px" data-ad-client="'+esc(ad.publisherId)+'" data-ad-slot="'+esc(ad.slot)+'" data-ad-format="auto" data-full-width-responsive="true"></ins>';
    try{
      await loadScript('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client='+encodeURIComponent(ad.publisherId));
      (window.adsbygoogle=window.adsbygoogle||[]).push({});
    }catch(_){setError(el,'AdSense is not ready yet.');}
  }

  async function renderSlot(el){
    if(rendered.has(el)) return;
    rendered.add(el);
    const placement=el.dataset.adPlacement||'topBanner';
    const fallbackFrame=el.querySelector('.ad-fallback-frame');
    // Keep the server-rendered fallback visible until the API result is known.
    // This is important for Opera Mini/low-bandwidth browsers.
    if(!fallbackFrame) el.hidden=true;
    try{
      const r=await fetch('/api/ads?placement='+encodeURIComponent(placement),{credentials:'same-origin',cache:'no-store',headers:{'Accept':'application/json','X-Requested-With':'XMLHttpRequest'}});
      if(!r.ok) throw new Error('Ad service returned HTTP '+r.status);
      const d=await r.json();
      if(!d || !Array.isArray(d.ads) || !d.ads.length){
        if(fallbackFrame){el.hidden=false;return;}
        el.innerHTML='';return;
      }
      const ad=d.ads[0];
      // A direct ad returned by the normal API is preferred in browsers that
      // support JavaScript. Remove the iframe before rendering the richer path.
      if(fallbackFrame) fallbackFrame.remove();
      if(ad.type==='network' && ad.network==='adsense') await renderNetwork(el,ad);
      else await renderDirect(el,ad);
    }catch(_){
      // Keep the same-origin fallback iframe visible when the API/JS path fails.
      if(fallbackFrame){el.hidden=false;return;}
      setError(el,'Advertisement service unavailable.');
    }
  }

  function init(){document.querySelectorAll('[data-ad-placement]').forEach(renderSlot);}
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init,{once:true}); else init();
})();
