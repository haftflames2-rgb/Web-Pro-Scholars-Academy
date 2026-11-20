(() => {
  const $ = (id) => document.getElementById(id);
  const form = $('careerForm');
  if (!form) return;
  const fields = ['fullName','email','phone','location','headline','summary','skills','experience','education','certifications','links'];
  const esc = (s) => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const values = () => Object.fromEntries(fields.map(k => [k, $(k).value.trim()]));
  const setValues = data => fields.forEach(k => { if (data && data[k] != null) $(k).value = data[k]; });
  const status = (message, bad=false) => { $('careerMsg').textContent = message; $('careerMsg').style.color = bad ? '#b42318' : ''; };
  async function load() {
    try {
      const r = await fetch('/api/student/career-profile');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not load career profile.');
      setValues(d.profile || {});
      renderPreview();
    } catch (e) { status(e.message, true); }
  }
  async function save() {
    status('Saving…');
    try {
      const r = await fetch('/api/student/career-profile', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(values())});
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not save your CV.');
      status('Your career profile has been saved securely to your SMARTTEP account.');
      renderPreview();
    } catch(e) { status(e.message, true); }
  }
  function renderPreview() {
    const v = values();
    const section = (heading, text) => text ? `<section><h2>${heading}</h2><p>${esc(text).replace(/\n/g,'<br>')}</p></section>` : '';
    $('careerPreview').innerHTML = `<article class="cv-paper"><header><h1>${esc(v.fullName || 'Your Name')}</h1><p>${[v.email,v.phone,v.location].filter(Boolean).map(esc).join(' · ')}</p><h3>${esc(v.headline)}</h3></header>${section('Professional Profile',v.summary)}${section('Skills',v.skills)}${section('Work Experience & Projects',v.experience)}${section('Education',v.education)}${section('Certifications',v.certifications)}${section('Professional Links',v.links)}</article>`;
  }
  form.addEventListener('submit', e => { e.preventDefault(); save(); });
  fields.forEach(k => $(k).addEventListener('input', renderPreview));
  $('careerPrint').addEventListener('click', () => {
    renderPreview();
    const w = window.open('', '_blank');
    if (!w) { status('Allow pop-ups for this site to print or save your CV as PDF.', true); return; }
    w.document.write(`<!doctype html><html><head><title>CV - ${esc($('fullName').value || 'SMARTTEP Student')}</title><style>body{font:14px Arial,sans-serif;color:#222;line-height:1.55;margin:35px}h1{font-size:26px;margin:0}h2{font-size:16px;border-bottom:1px solid #aaa;padding-bottom:4px;margin-top:22px}h3{font-size:15px;color:#444}p{white-space:normal}</style></head><body>${$('careerPreview').innerHTML}</body></html>`);
    w.document.close(); w.focus(); w.print();
  });
  const questions = [
    ['Tell me about yourself.','Give a 45–90 second answer: your current learning focus, relevant skills, one project, and the role you want. Avoid sharing your whole life story.'],
    ['Describe a project you are proud of.','Explain the problem, your role, tools used, a challenge, how you solved it, and the result. Link to a project in your SMARTTEP portfolio if it is public.'],
    ['What do you do when you get stuck?','Show a repeatable process: define the problem, read the error, reproduce it, research trusted documentation, test one change at a time, and ask a clear question when needed.'],
    ['Why should we select you?','Connect the role requirements to evidence: skills, completed work, reliability, communication and willingness to learn. Do not claim skills you cannot demonstrate.'],
    ['Tell us about a mistake or challenge.','Choose a real, appropriate example. Explain what happened, what you changed, and what you learned without blaming others.'],
    ['Do you have any questions for us?','Ask about the team, first 90-day expectations, tools, mentoring, success measures and next steps.']
  ];
  $('interviewQuestions').innerHTML = questions.map((q,i) => `<details class="career-question"><summary>${i+1}. ${esc(q[0])}</summary><p>${esc(q[1])}</p></details>`).join('');
  load();
})();
