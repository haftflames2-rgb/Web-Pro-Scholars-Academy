function homeEscape(value) {
 return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function safeHttps(value) {
 try { const u = new URL(value); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; }
}
async function loadHome(){
 const me=await fetch('/api/me').then(r=>r.json());
 const login=document.getElementById('loginLink'), reg=document.getElementById('registerLink');
 const cert=document.getElementById('certLink'), ai=document.getElementById('aiLink'), out=document.getElementById('logoutBtn'), admin=document.getElementById('adminLink');
 if(me.user){login?.classList.add('hidden');reg?.classList.add('hidden');out?.classList.remove('hidden');cert?.classList.remove('hidden');if(ai)ai.classList.remove('hidden');if(me.user.role==='admin')admin?.classList.remove('hidden');}
 const data=await fetch('/api/public-courses').then(r=>r.json());
 const grid=document.getElementById('courseGrid');
 if(!data.courses?.length){grid.innerHTML='<div class="course-empty">New courses are being prepared. Please check back soon.</div>';}
 else grid.innerHTML=data.courses.map(c=>{
  const title=homeEscape(c.title), desc=homeEscape(c.description || 'Practical training designed to help you develop useful skills.');
  const image=safeHttps(c.thumbnail), video=safeHttps(c.introVideo);
  const outcomes=Array.isArray(c.outcomes)?c.outcomes.slice(0,6):[];
  return `<article class="course-card-public">
   ${image?`<img class="course-cover" src="${homeEscape(image)}" alt="${title}" loading="lazy">`:`<div class="course-cover course-cover-placeholder"><span>SMARTTEP ACADEMY</span></div>`}
   <div class="course-card-body"><div class="course-meta"><span>${homeEscape(c.level || 'Beginner')}</span><span>${Number(c.duration_weeks || 12)} weeks</span></div>
   <h3>${title}</h3><p>${desc}</p>
   ${outcomes.length?`<div class="course-outcomes"><b>What you will learn</b><ul>${outcomes.map(x=>`<li>${homeEscape(x)}</li>`).join('')}</ul></div>`:''}
   ${video?`<details class="course-preview"><summary>▶ Watch course preview</summary><video controls playsinline preload="none" src="${homeEscape(video)}">Your browser does not support video playback.</video></details>`:''}
   <div class="course-card-actions"><a class="btn small" href="/register.html">Enrol / Get started</a><span class="course-price">${Number(c.price||0)>0?'₦'+Number(c.price).toLocaleString('en-NG'):'Contact for fees'}</span></div></div>
  </article>`;
 }).join('');
 out?.addEventListener('click',async()=>{await fetch('/api/logout',{method:'POST'});location='/index.html'});
}
loadHome().catch(err=>{console.error('Homepage could not load:',err);const grid=document.getElementById('courseGrid');if(grid)grid.textContent='Courses could not be loaded right now. Please refresh the page.';});
