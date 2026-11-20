(() => {
  const $ = id => document.getElementById(id);
  const form = $('learningPathForm');
  if (!form) return;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const message = (text, bad=false) => { $('learningPathMsg').textContent = text; $('learningPathMsg').style.color = bad ? '#b42318' : ''; };
  function readPreferences() { return { goal: $('learningPathGoal').value, hoursPerWeek: Number($('learningPathHours').value), pace: $('learningPathPace').value }; }
  function applyPreferences(p={}) { if (p.goal) $('learningPathGoal').value=p.goal; if (p.hoursPerWeek) $('learningPathHours').value=String(p.hoursPerWeek); if (p.pace) $('learningPathPace').value=p.pace; }
  function render(data) {
    const p=data.progress||{};
    $('learningPathProgress').innerHTML = `<b>Current progress:</b> ${Number(p.completedLessons||0)} of ${Number(p.totalLessons||0)} lessons completed (${Number(p.percent||0)}%). <b>${Number(data.remainingLessons||0)}</b> lessons remaining across <b>${Number(data.enrolledCourses||0)}</b> enrolled courses.`;
    const host=$('learningPathPlan');
    if (!data.enrolledCourses) { host.innerHTML='<div class="card"><h3>No enrolled courses found yet</h3><p>Once you are enrolled in a course, SMARTTEP can build your learning path from its lessons.</p></div>'; return; }
    if (!data.remainingLessons) { host.innerHTML='<div class="card"><h3>🎉 You have completed all currently available lessons!</h3><p>Check your course assessments, practical assignments and certificate eligibility. Your plan will update if new lessons become available.</p></div>'; return; }
    let html='';
    if ((data.lockedLessons||[]).length) html += `<div class="card"><h3>🔒 Lessons not yet available</h3><p>${data.lockedLessons.length} lesson(s) are currently locked by course access or release settings. They are not counted in your weekly plan.</p><ul>${data.lockedLessons.slice(0,8).map(x=>`<li><b>${esc(x.course)}</b>: ${esc(x.lesson)}${x.reason?` — ${esc(x.reason)}`:''}</li>`).join('')}</ul></div>`;
    if (!(data.weeks||[]).length) { host.innerHTML=html+'<p>No unlocked lessons are currently available. Check back when your instructor releases the next lesson.</p>'; return; }
    html += data.weeks.map(w=>`<article class="card learning-path-week"><h3>Week ${w.week}</h3><p>${w.tasks.length} lesson${w.tasks.length===1?'':'s'} planned</p><ol>${w.tasks.map(t=>`<li><b>${esc(t.course)}</b> — ${esc(t.lesson)} <a href="/student.html#courseContent">Open My Courses</a></li>`).join('')}</ol></article>`).join('');
    host.innerHTML=html;
  }
  async function load() {
    $('learningPathPlan').textContent='Preparing your personalized plan…';
    try { const r=await fetch('/api/student/learning-path',{cache:'no-store'}); const d=await r.json(); if(!r.ok) throw new Error(d.error||'Could not load your learning path.'); applyPreferences(d.preferences||{}); render(d); }
    catch(e) { $('learningPathPlan').innerHTML=`<p class="msg">${esc(e.message)}</p>`; }
  }
  form.addEventListener('submit',async e=>{e.preventDefault();message('Saving your preferences…');try{const r=await fetch('/api/student/learning-path',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(readPreferences())});const d=await r.json();if(!r.ok)throw new Error(d.error||'Could not save preferences.');message('Your preferences have been saved. Updating your plan…');await load();message('Your personalized learning path has been updated.');}catch(err){message(err.message,true);}});
  $('refreshLearningPath').addEventListener('click',load);
  load();
})();
