async function loadAILimits() {
  const d = await api('/api/admin/ai-settings');
  const s = d.settings;
  document.getElementById('aiDailyCredits').value = s.dailyCredits;
  document.getElementById('aiUnlimitedAdmins').checked = !!s.unlimitedAdmins;
  for (const key of ['chat','image','document','video','speech','quiz','studyPlan']) document.getElementById('cost' + key.charAt(0).toUpperCase() + key.slice(1)).value = s.costs[key];
  const rows = d.usage || [];
  document.getElementById('aiUsageSummary').innerHTML = rows.length ? `<h3>Today's usage (${escapeHtml(d.dateKey)})</h3><div class="table-wrap"><table><thead><tr><th>Student</th><th>Credits</th><th>Breakdown</th></tr></thead><tbody>${rows.map(x => `<tr><td>${escapeHtml(x.name)}<br><small>${escapeHtml(x.email)}</small></td><td>${x.credits}</td><td>${Object.entries(x.actions||{}).map(([k,v]) => `${escapeHtml(k)}: ${v}`).join(' · ') || '-'}</td></tr>`).join('')}</tbody></table></div>` : `<p>No AI usage recorded today.</p>`;
}

async function api(url, opts = {}) {
  const r = await fetch(url, opts);
  let d = {};
  try { d = await r.json(); } catch (_) {}
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}

async function loadSmartSecurity() {
  const d = await api('/api/admin/smart-security');
  const s = d.settings || {};
  document.getElementById('smartEnabled').checked = s.enabled !== false;
  document.getElementById('smartMode').value = s.mode === 'auto' ? 'auto' : 'monitor';
  document.getElementById('smartAutoHigh').checked = !!s.autoBlockHighRisk;
  document.getElementById('smartAutoCritical').checked = !!s.autoBlockCritical;
  document.getElementById('smartApprovalCritical').checked = s.requireApprovalForCritical !== false;
  document.getElementById('smartBlockMinutes').value = Number(s.blockDurationMinutes || 1440);
  document.getElementById('smartRetentionDays').value = Number(s.retentionDays || 30);

  const blocked = d.blocked || [];
  document.getElementById('smartBlocked').innerHTML = `<h3>Active temporary blocks (${blocked.length})</h3>` + (blocked.length ? `<div class="table-wrap"><table><thead><tr><th>IP</th><th>Device</th><th>Expires</th><th>Admin action</th></tr></thead><tbody>${blocked.map(x => `<tr><td>${escapeHtml(x.ip || '-')}</td><td title="${escapeAttr(x.deviceKey || '')}">${escapeHtml(x.deviceKey ? '…' + x.deviceKey.slice(-10) : 'legacy IP block')}</td><td>${escapeHtml(new Date(x.until).toLocaleString())}</td><td><button class="ghost-btn small smart-unblock" data-device-key="${escapeAttr(x.deviceKey || '')}">Unblock</button></td></tr>`).join('')}</tbody></table></div>` : '<p>No active Smart blocks.</p>');

  const events = d.events || [];
  document.getElementById('smartEvents').innerHTML = `<h3>Recent Smart events</h3>` + (events.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Severity</th><th>Type</th><th>IP</th><th>Path</th><th>Action</th></tr></thead><tbody>${events.map(x => `<tr><td>${escapeHtml(new Date(x.created_at).toLocaleString())}</td><td>${escapeHtml(String(x.severity || '').toUpperCase())}</td><td>${escapeHtml(x.type || '-')}</td><td>${escapeHtml(x.ip || '-')}</td><td>${escapeHtml(x.path || '-')}</td><td>${escapeHtml(x.action || '-')}</td></tr>`).join('')}</tbody></table></div>` : '<p>No security events recorded yet.</p>');

  document.querySelectorAll('.smart-unblock').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm(`Unblock this Smart device block?`)) return;
    try { await api('/api/admin/smart-security/unblock', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({deviceKey:btn.dataset.deviceKey}) }); await loadSmartSecurity(); }
    catch (e) { alert(e.message); }
  }));
}

async function loadInstructorSecurity() {
  const d = await api('/api/admin/instructor-security');
  const alerts=d.alerts||[]; const events=d.events||[];
  document.getElementById('instructorSecurityAlerts').innerHTML='<h3>Security alerts</h3>'+(alerts.length?`<div class="table-wrap"><table><thead><tr><th>Time</th><th>Instructor</th><th>Severity</th><th>Reason</th><th>Status</th><th>Action</th></tr></thead><tbody>${alerts.map(a=>`<tr><td>${escapeHtml(new Date(a.created_at).toLocaleString())}</td><td><b>${escapeHtml(a.name||'-')}</b><br><small>${escapeHtml(a.email||'')}</small></td><td>${escapeHtml(String(a.severity||'').toUpperCase())}</td><td>${escapeHtml(a.reason||'-')}<br><small>5m requests: ${Number(a.metrics?.recent||0)} · denied: ${Number(a.metrics?.recentUnauthorized||0)} · destructive: ${Number(a.metrics?.recentDestructive||0)}</small></td><td>${escapeHtml(a.status)}</td><td>${a.status==='open'?`<button class="btn small instructor-security-action" data-id="${a.id}" data-action="suspend">Suspend</button> <button class="ghost-btn small instructor-security-action" data-id="${a.id}" data-action="resolve">Resolve</button>`:a.status==='suspended'?`<button class="btn small instructor-security-action" data-id="${a.id}" data-action="restore">Restore</button>`:'-'}</td></tr>`).join('')}</tbody></table></div>`:'<p>No instructor security alerts.</p>');
  document.getElementById('instructorSecurityEvents').innerHTML='<h3>Recent instructor activity</h3>'+(events.length?`<div class="table-wrap"><table><thead><tr><th>Time</th><th>Instructor</th><th>Request</th><th>Status</th><th>Flags</th><th>IP</th></tr></thead><tbody>${events.slice(0,100).map(e=>`<tr><td>${escapeHtml(new Date(e.created_at).toLocaleString())}</td><td>${escapeHtml(e.name||e.email||'-')}</td><td>${escapeHtml(e.method||'')} ${escapeHtml(e.path||'')}</td><td>${escapeHtml(e.status_code)}</td><td>${e.unauthorized?'Denied/invalid ':''}${e.destructive?'Destructive':''||'-'}</td><td>${escapeHtml(e.ip||'-')}</td></tr>`).join('')}</tbody></table></div>`:'<p>No instructor activity recorded yet.</p>');
  document.querySelectorAll('.instructor-security-action').forEach(btn=>btn.onclick=async()=>{
    const labels={suspend:'Suspend this instructor after reviewing the alert?',restore:'Restore this instructor access?',resolve:'Resolve this security alert?'};
    if(!confirm(labels[btn.dataset.action]||'Continue?')) return;
    try { await api('/api/admin/instructor-security/'+btn.dataset.id+'/decision',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:btn.dataset.action})}); await loadInstructorSecurity(); await loadInstructors(); } catch(e){alert(e.message);}
  });
}

async function loadInstructors() {
  const d = await api('/api/admin/instructors');
  const apps = d.applications || [];
  const active = d.instructors || [];
  document.getElementById('instructorApplications').innerHTML = apps.length ? `<div class="table-wrap"><table><thead><tr><th>Applicant</th><th>Teaching topics</th><th>Status</th><th>Action</th></tr></thead><tbody>${apps.map(a => `<tr><td><b>${escapeHtml(a.name)}</b><br><small>${escapeHtml(a.email)}</small></td><td>${escapeHtml(a.teaching_topics || '-')}<br><small>${escapeHtml(a.message || '')}</small></td><td>${escapeHtml(a.status)}</td><td>${a.status === 'pending' ? `<button class="btn small instructor-action" data-id="${a.user_id}" data-action="approve">Approve</button> <button class="ghost-btn small instructor-action" data-id="${a.user_id}" data-action="reject">Reject</button>` : '-'}</td></tr>`).join('')}</tbody></table></div>` : '<p>No instructor applications yet.</p>';
  document.getElementById('instructorAccounts').innerHTML = active.length ? `<h3>Active instructor accounts</h3><div class="table-wrap"><table><thead><tr><th>Instructor</th><th>Status</th><th>Action</th></tr></thead><tbody>${active.map(a => `<tr><td><b>${escapeHtml(a.name)}</b><br><small>${escapeHtml(a.email)}</small></td><td>${a.suspended ? 'Suspended' : 'Active'}</td><td><button class="ghost-btn small instructor-action" data-id="${a.id}" data-action="${a.suspended ? 'unsuspend' : 'suspend'}">${a.suspended ? 'Restore access' : 'Suspend'}</button></td></tr>`).join('')}</tbody></table></div>` : '';
  document.querySelectorAll('.instructor-action').forEach(btn => btn.onclick = async () => {
    if (!confirm(`${btn.dataset.action.charAt(0).toUpperCase()+btn.dataset.action.slice(1)} this instructor account?`)) return;
    try { await api('/api/admin/instructors/' + btn.dataset.id + '/decision', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:btn.dataset.action})}); await loadInstructors(); await refresh(); } catch(e) { alert(e.message); }
  });
}
async function init() {
  try {
    const me = await api('/api/me');
    if (!me.user || me.user.role !== 'admin') {
      location = '/login.html';
      return;
    }

    const refresh = async () => {
      const [u, c, p, s, l] = await Promise.all([
        api('/api/admin/users'),
        api('/api/courses'),
        api('/api/admin/payments'),
        api('/api/admin/submissions'),
        api('/api/admin/lessons')
      ]);

      const allCourseOptions = c.courses.map(course => `<option value="${course.id}">${escapeHtml(course.title)}</option>`).join('');
      document.getElementById('users').innerHTML = u.users.map(x => {
        if (x.role !== 'student') return `<div class="row"><span>${escapeHtml(x.name)} — ${escapeHtml(x.email)}<br><small>${x.role === 'instructor' ? 'Instructor account' : 'Administrator account'}</small></span></div>`;
        const selected = new Set(x.enrolled_course_ids || []);
        return `<div class="row" style="display:block">
          <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap">
            <span style="display:flex;align-items:center;gap:12px"><span style="width:52px;height:52px;border-radius:50%;overflow:hidden;border:1px solid currentColor;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.05)">${x.profile_picture_url ? `<img src="${escapeAttr(x.profile_picture_url + `?v=${Date.now()}`)}" alt="Profile picture" style="width:100%;height:100%;object-fit:cover">` : '👤'}</span><span><b>${escapeHtml(x.name)}</b> — ${escapeHtml(x.email)}<br><small>${escapeHtml(x.payment_status || 'unpaid')} / ${x.approved ? 'approved' : 'awaiting approval'}</small></span></span>
            <span>
              ${!x.approved ? `<button class="btn small admin-action" data-action="approve" data-id="${x.id}">Approve</button>` : ''}
              <button class="btn small admin-action" data-action="lock-user" data-id="${x.id}">${x.portal_locked ? 'Unlock' : 'Lock'} Portal</button>
              <button class="btn small admin-action" data-action="view-portal" data-id="${x.id}">Open User Portal</button>
              <button class="ghost-btn small admin-action" data-action="delete-user" data-id="${x.id}">Delete Student</button>
            </span>
          </div>
          <div style="margin-top:10px"><label>Registered courses</label><select class="user-course-select" multiple size="4" data-user-id="${x.id}">${c.courses.map(course => `<option value="${course.id}" ${selected.has(course.id) ? 'selected' : ''}>${escapeHtml(course.title)}</option>`).join('')}</select><br><button class="btn small admin-action" data-action="save-user-courses" data-id="${x.id}">Save Course Access</button></div>
          <div style="margin-top:10px"><div class="ai-cost-grid"><label>WPS Student ID<input class="student-identity-id" data-user-id="${x.id}" value="${escapeAttr(x.student_id_number || '')}" placeholder="e.g. WPS-2026-ABC123"></label><label>Course code<input class="student-identity-course-code" data-user-id="${x.id}" value="${escapeAttr(x.course_code || '')}" placeholder="e.g. WEB-101"></label><label>Registration date<input class="student-identity-registration" data-user-id="${x.id}" type="date" value="${escapeAttr(x.registration_date || '')}"></label><label>Programme ending<input class="student-identity-ending" data-user-id="${x.id}" type="date" value="${escapeAttr(x.programme_end_date || '')}"></label><label>State<input class="student-identity-state" data-user-id="${x.id}" value="${escapeAttr(x.state || '')}" placeholder="State"></label><label>Country<input class="student-identity-country" data-user-id="${x.id}" value="${escapeAttr(x.country || 'Nigeria')}" placeholder="Country"></label><label>Gender<select class="student-identity-gender" data-user-id="${x.id}"><option value="">Select gender</option><option ${x.gender==='Male'?'selected':''}>Male</option><option ${x.gender==='Female'?'selected':''}>Female</option><option ${x.gender==='Other'?'selected':''}>Other</option><option ${x.gender==='Prefer not to say'?'selected':''}>Prefer not to say</option></select></label></div><button class="btn small admin-action" data-action="save-student-identity" data-id="${x.id}">Save ID & Student Details</button></div>
        </div>`;
      }).join('');

      const opts = allCourseOptions;
      document.getElementById('lessonCourse').innerHTML = opts;
      document.getElementById('assignmentCourse').innerHTML = opts;

      document.getElementById('courses').innerHTML = c.courses.map(x => `
        <div class="row" style="display:block">
          <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap">
            <span><b>${escapeHtml(x.title)}</b><br><small>${escapeHtml(x.description || '')} · Price: ${Number(x.price || 0).toFixed(2)} · ${x.locked ? 'Locked' : 'Open'}</small></span>
            <span><button class="btn small admin-action" data-action="edit-course" data-id="${x.id}">Edit</button> <button class="btn small admin-action" data-action="lock-course" data-id="${x.id}">${x.locked ? 'Unlock' : 'Lock'}</button> <button class="ghost-btn small admin-action" data-action="delete-course" data-id="${x.id}">Delete</button></span>
          </div>
        </div>`).join('');
      window.__adminCourses = c.courses;
      window.__adminUsers = u.users || [];

      window.__adminLessons = l.lessons || [];
      const lessonSelect = document.getElementById('lessonId');
      if (lessonSelect) {
        const selectedId = lessonSelect.value;
        const selectedCourse = document.getElementById('lessonCourse')?.value || '';
        const matches = (l.lessons || []).filter(x => !selectedCourse || String(x.course_id || '') === String(selectedCourse));
        lessonSelect.innerHTML = '<option value="">Create new lesson / match course + title</option>' + matches.map(x => `<option value="${escapeAttr(x.id)}">Update: ${escapeHtml(x.title)} — ${escapeHtml(x.course_title || 'Unknown course')}</option>`).join('');
        if (selectedId && matches.some(x => x.id === selectedId)) lessonSelect.value = selectedId;
      }
      document.getElementById('lessons').innerHTML = (l.lessons || []).map(x => `
        <div class="row"><span><b>${escapeHtml(x.title)}</b><br><small>${escapeHtml(x.course_title || 'Unknown course')}</small><br>
          ${x.note_path ? `<a href="${escapeAttr(x.note_path)}" target="_blank" rel="noopener">Lesson note</a>` : ''}${x.note_path && (x.video_path || x.audio_path) ? ' · ' : ''}${x.video_path ? `<a href="${escapeAttr(x.video_path)}" target="_blank" rel="noopener">Video</a>` : ''}${x.video_path && x.audio_path ? ' · ' : ''}${x.audio_path ? `<a href="${escapeAttr(x.audio_path)}" target="_blank" rel="noopener">Audio</a>` : ''}
        </span><span><button class="ghost-btn small admin-action" data-action="delete-lesson" data-id="${x.id}">Delete Lesson</button></span></div>`).join('') || '<p>No lessons uploaded yet.</p>';

      document.getElementById('payments').innerHTML = p.payments.map(x => `
        <div class="row"><span>${escapeHtml(x.name)} (${escapeHtml(x.email)}) — ${escapeHtml(x.method)}<br>
          Reference: ${escapeHtml(x.reference || '-')} ${x.proof_path ? `<a href="${x.proof_path}" target="_blank" rel="noopener">Proof</a>` : ''}
        </span><span>${escapeHtml(x.status)}</span></div>`).join('');

      document.getElementById('submissions').innerHTML = s.submissions.map(x => `
        <div class="row"><span>${escapeHtml(x.student_name)} — ${escapeHtml(x.assignment_title)}<br>
          ${x.file_path ? `<a href="${x.file_path}" rel="noopener">Download${x.file_name ? ` ${escapeHtml(x.file_name)}` : ' file'}</a>` : ''}
        </span><span>
          <input id="g${x.id}" placeholder="Grade" value="${escapeAttr(x.grade || '')}">
          <input id="f${x.id}" placeholder="Feedback" value="${escapeAttr(x.feedback || '')}">
          <button class="btn small admin-action" data-action="grade" data-id="${x.id}">Save grade</button>
        </span></div>`).join('');
    };

    document.getElementById('users').addEventListener('click', async e => {
      const btn = e.target.closest('.admin-action');
      if (!btn) return;
      await runAdminAction(btn, refresh);
    });

    document.getElementById('courses').addEventListener('click', async e => {
      const btn = e.target.closest('.admin-action');
      if (!btn) return;
      await runAdminAction(btn, refresh);
    });

    document.getElementById('lessons').addEventListener('click', async e => {
      const btn = e.target.closest('.admin-action');
      if (!btn) return;
      await runAdminAction(btn, refresh);
    });

    document.getElementById('submissions').addEventListener('click', async e => {
      const btn = e.target.closest('.admin-action');
      if (!btn) return;
      await runAdminAction(btn, refresh);
    });

    async function runAdminAction(btn, refreshFn) {
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      const oldText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Please wait...';
      try {
        if (action === 'approve') {
          await api('/api/admin/users/' + id + '/approve', { method: 'POST' });
        } else if (action === 'lock-user') {
          await api('/api/admin/users/' + id + '/toggle-lock', { method: 'POST' });
        } else if (action === 'delete-user') {
          const student = (window.__adminUsers || []).find(x => x.id === id);
          const name = student?.name || 'this student';
          if (!confirm(`Delete ${name}? This permanently removes the student's account, submissions, payment records, AI history, chat messages and stored profile/media files. This action cannot be undone.`)) {
            btn.disabled = false; btn.textContent = oldText; return;
          }
          const typed = prompt(`Type DELETE to permanently delete ${name}.`);
          if (typed !== 'DELETE') {
            btn.disabled = false; btn.textContent = oldText; return;
          }
          await api('/api/admin/users/' + id, { method: 'DELETE' });
        } else if (action === 'lock-course') {
          await api('/api/admin/courses/' + id + '/toggle-lock', { method: 'POST' });
        } else if (action === 'edit-course') {
          const course = (window.__adminCourses || []).find(x => x.id === id);
          if (course) {
            document.getElementById('courseId').value = course.id;
            document.getElementById('courseTitle').value = course.title || '';
            document.getElementById('courseDescription').value = course.description || '';
            document.getElementById('coursePrice').value = Number(course.price || 0);
            document.getElementById('courseThumbnail').value = course.thumbnail || '';
            document.getElementById('courseLocked').checked = !!course.locked;
            document.getElementById('courseSaveBtn').textContent = 'Save changes';
            document.getElementById('courseCancelBtn').hidden = false;
            document.getElementById('courseMsg').textContent = 'Editing ' + course.title;
            document.getElementById('courseForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          btn.disabled = false; btn.textContent = oldText; return;
        } else if (action === 'delete-course') {
          const course = (window.__adminCourses || []).find(x => x.id === id);
          if (!confirm(`Delete "${course?.title || 'this course'}"? This permanently removes its lessons, assignments, submissions, progress and student enrollment references.`)) {
            btn.disabled = false; btn.textContent = oldText; return;
          }
          await api('/api/admin/courses/' + id, { method: 'DELETE' });
        } else if (action === 'delete-lesson') {
          const lesson = (window.__adminLessons || []).find(x => x.id === id);
          if (!confirm(`Delete "${lesson?.title || 'this lesson'}"? This permanently deletes the lesson and its uploaded note/video from Cloudinary.`)) {
            btn.disabled = false; btn.textContent = oldText; return;
          }
          await api('/api/admin/lessons/' + id, { method: 'DELETE' });
        } else if (action === 'save-student-identity') {
          const val = selector => document.querySelector(`${selector}[data-user-id=\"${id}\"]`)?.value || '';
          const payload = { studentIdNumber: val('.student-identity-id'), courseCode: val('.student-identity-course-code'), registrationDate: val('.student-identity-registration'), programmeEndDate: val('.student-identity-ending'), state: val('.student-identity-state'), country: val('.student-identity-country'), gender: val('.student-identity-gender') };
          await api('/api/admin/users/' + id + '/identity', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
          alert('Student ID and identity details saved.');
        } else if (action === 'save-user-courses') {
          const select = document.querySelector(`.user-course-select[data-user-id="${id}"]`);
          const courseIds = select ? Array.from(select.selectedOptions).map(o => o.value) : [];
          await api('/api/admin/users/' + id + '/courses', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({courseIds}) });
        } else if (action === 'view-portal') {
          window.open('/admin-student.html?user=' + encodeURIComponent(id), '_blank', 'noopener');
          btn.disabled = false;
          btn.textContent = oldText;
          return;
        } else if (action === 'grade') {
          await api('/api/admin/submissions/' + id + '/grade', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              grade: document.getElementById('g' + id).value,
              feedback: document.getElementById('f' + id).value
            })
          });
        }
        await refreshFn();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = oldText;
        alert(err.message);
      }
    }

    const courseForm = document.getElementById('courseForm');
    const resetCourseForm = () => {
      courseForm.reset();
      document.getElementById('courseId').value = '';
      document.getElementById('coursePrice').value = '0';
      document.getElementById('courseSaveBtn').textContent = 'Create course';
      document.getElementById('courseCancelBtn').hidden = true;
      document.getElementById('courseMsg').textContent = '';
    };
    document.getElementById('courseCancelBtn').onclick = resetCourseForm;
    courseForm.onsubmit = async e => {
      e.preventDefault();
      const msg = document.getElementById('courseMsg');
      const id = document.getElementById('courseId').value;
      const payload = { title: document.getElementById('courseTitle').value, description: document.getElementById('courseDescription').value, price: Number(document.getElementById('coursePrice').value || 0), thumbnail: document.getElementById('courseThumbnail').value, locked: document.getElementById('courseLocked').checked };
      msg.textContent = 'Saving...';
      try {
        await api(id ? '/api/admin/courses/' + id : '/api/admin/courses', { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        resetCourseForm();
        msg.textContent = id ? 'Course updated.' : 'Course created.';
        await refresh();
      } catch (err) { msg.textContent = err.message; }
    };

    document.getElementById('aiLimitsForm').onsubmit = async e => {
      e.preventDefault();
      const msg = document.getElementById('aiLimitMsg'); msg.textContent = 'Saving...';
      try {
        const costs = {};
        for (const key of ['chat','image','document','video','speech','quiz','studyPlan']) costs[key] = Number(document.getElementById('cost' + key.charAt(0).toUpperCase() + key.slice(1)).value);
        await api('/api/admin/ai-settings', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ dailyCredits:Number(document.getElementById('aiDailyCredits').value), unlimitedAdmins:document.getElementById('aiUnlimitedAdmins').checked, costs }) });
        msg.textContent = 'AI limits saved.'; await loadAILimits();
      } catch (err) { msg.textContent = err.message; }
    };
    document.getElementById('resetAiUsage').onclick = async () => {
      if (!confirm("Reset all students' AI credits for today?")) return;
      try { await api('/api/admin/ai-reset', {method:'POST'}); document.getElementById('aiLimitMsg').textContent = "Today's usage reset."; await loadAILimits(); } catch (err) { alert(err.message); }
    };

    document.getElementById('lessonCourse').addEventListener('change', () => {
      const select = document.getElementById('lessonId');
      if (select) select.value = '';
    });

    document.getElementById('lessonForm').onsubmit = async e => {
      e.preventDefault();
      const msg = document.getElementById('lessonMsg');
      const btn = document.getElementById('lessonSubmitBtn');
      const fd = new FormData(e.target);
      const hasFile = ['note','video','audio'].some(name => fd.get(name) instanceof File && fd.get(name).size > 0);
      if (!hasFile) { msg.textContent = 'Select at least one note, video, or audio file.'; return; }
      btn.disabled = true; msg.textContent = 'Uploading… please wait.';
      try {
        const result = await api('/api/admin/lessons', { method: 'POST', body: fd });
        msg.textContent = result.updated ? 'Lesson updated successfully.' : 'Lesson uploaded successfully.';
        const course = document.getElementById('lessonCourse').value;
        const title = document.getElementById('lessonTitle').value;
        e.target.reset();
        document.getElementById('lessonCourse').value = course;
        document.getElementById('lessonTitle').value = title;
        await refresh();
      } catch (err) { msg.textContent = err.message; }
      finally { btn.disabled = false; }
    };

    document.getElementById('assignmentForm').onsubmit = async e => {
      e.preventDefault();
      try {
        await api('/api/admin/assignments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.fromEntries(new FormData(e.target)))
        });
        e.target.reset();
        alert('Assignment created successfully.');
        await refresh();
      } catch (err) { alert(err.message); }
    };

    document.getElementById('smartSecurityForm').onsubmit = async e => {
      e.preventDefault();
      const msg = document.getElementById('smartSettingsMsg'); msg.textContent = 'Saving...';
      try {
        await api('/api/admin/smart-security/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
          enabled: document.getElementById('smartEnabled').checked,
          mode: document.getElementById('smartMode').value,
          autoBlockHighRisk: document.getElementById('smartAutoHigh').checked,
          autoBlockCritical: document.getElementById('smartAutoCritical').checked,
          requireApprovalForCritical: document.getElementById('smartApprovalCritical').checked,
          blockDurationMinutes: Number(document.getElementById('smartBlockMinutes').value),
          retentionDays: Number(document.getElementById('smartRetentionDays').value)
        }) });
        msg.textContent = 'Smart controls saved.'; await loadSmartSecurity();
      } catch (err) { msg.textContent = err.message; }
    };

    document.getElementById('logout').onclick = async () => {
      await fetch('/api/logout', { method: 'POST' });
      location = '/';
    };

    await refresh();
    await loadAILimits();
    await loadSmartSecurity();
    await loadInstructors();
    await loadInstructorSecurity();
  } catch (err) {
    console.error(err);
    location = '/login.html';
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

init();
