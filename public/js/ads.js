(function(){
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const loadedScripts={};
  function loadScript(src){if(loadedScripts[src])return loadedScripts[src];loadedScripts[src]=new Promise((resolve,reject)=>{const s=document.createElement('script');s.async=true;s.src=src;s.onload=resolve;s.onerror=reject;document.head.appendChild(s)});return loadedScripts[src]}
  async function renderSlot(el){
    const placement=el.dataset.adPlacement||'topBanner';
    try{
      const r=await fetch('/api/ads?placement='+encodeURIComponent(placement),{credentials:'same-origin'});const d=await r.json();
      if(!d.ads?.length){el.hidden=true;return}
      const ad=d.ads[0];el.hidden=false;
      if(ad.type==='network' && ad.network==='adsense'){
        el.innerHTML='<div class="ad-label">Advertisement</div><ins class="adsbygoogle" style="display:block" data-ad-client="'+esc(ad.publisherId)+'" data-ad-slot="'+esc(ad.slot||'')+'" data-ad-format="auto" data-full-width-responsive="true"></ins>';
        try{await loadScript('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client='+encodeURIComponent(ad.publisherId));(window.adsbygoogle=window.adsbygoogle||[]).push({});}catch(_){el.hidden=true}
        return;
      }
      el.innerHTML='<div class="ad-label">Advertisement</div><a class="direct-ad" href="'+esc(ad.clickUrl)+'" target="_blank" rel="sponsored noopener noreferrer"><img src="'+esc(ad.imageUrl)+'" alt="'+esc(ad.alt||'Advertisement')+'" loading="lazy"></a>';
      fetch('/api/ads/'+encodeURIComponent(ad.id)+'/impression',{method:'POST',credentials:'same-origin',keepalive:true}).catch(()=>{});
    }catch(_){el.hidden=true}
  }
  function init(){document.querySelectorAll('[data-ad-placement]').forEach(renderSlot)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
