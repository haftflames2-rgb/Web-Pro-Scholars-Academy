const esc=s=>String(s??'').replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
let all=[];
async function load(){
 const [a,c]=await Promise.all([fetch('/api/public/articles').then(r=>{if(!r.ok)throw Error('Could not load articles');return r.json()}),fetch('/api/public-courses').then(r=>r.ok?r.json():({courses:[]}))]);
 all=a.articles||[];
 const seen=new Map();(c.courses||[]).filter(x=>!/^automobile\s+mechanic$/i.test(x.title)).forEach(x=>seen.set(x.id,x.title));
 document.getElementById('libraryCourse').innerHTML='<option value="">All available courses</option>'+[...seen].sort((x,y)=>x[1].localeCompare(y[1])).map(x=>'<option value="'+esc(x[0])+'">'+esc(x[1])+'</option>').join('');
 render();
}
function render(){
 const q=document.getElementById('librarySearch').value.toLowerCase().trim(),cid=document.getElementById('libraryCourse').value;
 const rows=all.filter(x=>(!cid||x.courseId===cid)&&(!q||(`${x.title} ${x.excerpt} ${x.courseTitle} ${(x.tags||[]).join(' ')}`).toLowerCase().includes(q)));
 document.getElementById('libraryCount').textContent=`Showing ${rows.length} of ${all.length} published articles`;
 document.getElementById('libraryArticles').innerHTML=rows.length?rows.map(x=>`<article class="article-card"><div class="article-meta">${esc(x.category||x.courseTitle)} · ${Number(x.readingMinutes||1)} min read</div><h2>${esc(x.title)}</h2><p>${esc(x.excerpt)}</p><div class="article-tags">${(x.tags||[]).slice(0,4).map(t=>`<span class="article-tag">${esc(t)}</span>`).join('')}</div><div><a class="btn small" href="${x.slug?'/articles/'+encodeURIComponent(x.slug):'/article.html?id='+encodeURIComponent(x.id)}">Read article</a></div></article>`).join(''):'<div class="library-empty"><h2>No matching articles</h2><p>Try a different keyword or choose another course.</p></div>';
}
document.getElementById('librarySearch').addEventListener('input',render);document.getElementById('libraryCourse').addEventListener('change',render);
load().catch(e=>{document.getElementById('libraryCount').textContent='';document.getElementById('libraryArticles').textContent=e.message});

