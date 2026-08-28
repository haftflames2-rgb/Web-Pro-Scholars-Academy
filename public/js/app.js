async function loadHome(){
 const me=await fetch('/api/me').then(r=>r.json());
 const login=document.getElementById('loginLink'), reg=document.getElementById('registerLink');
 const cert=document.getElementById('certLink'), out=document.getElementById('logoutBtn'), admin=document.getElementById('adminLink');
 if(me.user){login.classList.add('hidden');reg.classList.add('hidden');out.classList.remove('hidden');cert.classList.remove('hidden');if(me.user.role==='admin')admin.classList.remove('hidden');}
 const data=await fetch('/api/courses').then(r=>r.json());
 document.getElementById('courseGrid').innerHTML=data.courses.map(c=>`<div class="card"><h3>${c.title}</h3><p>${c.description}</p><small>${c.locked?'🔒 Locked':'✓ Available'}</small></div>`).join('');
 out.onclick=async()=>{await fetch('/api/logout',{method:'POST'});location='/index.html'};
}
loadHome();
