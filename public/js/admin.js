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

async function loadAdminAttendance() {
  const container = document.getElementById('adminAttendance');
  if (!container) return;
  try {
    const courseFilter = document.getElementById('adminAttendanceCourse')?.value || '';
    const q = courseFilter ? '?courseId=' + encodeURIComponent(courseFilter) : '';
    const d = await api('/api/admin/attendance' + q);
    const today = d.today;
    const courses = d.courses || [];
    const allCourses = window.__adminCourses || courses.map(c => ({id:c.course_id,title:c.course_title}));
    const courseSelect = document.getElementById('adminAttendanceCourse');
    if (courseSelect) {
      const previous = courseSelect.value;
      courseSelect.innerHTML = '<option value="">All courses</option>' + allCourses.map(c => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.title)}</option>`).join('');
      if (previous && allCourses.some(c => String(c.id) === String(previous))) courseSelect.value = previous;
    }
    if (!courses.length) { container.innerHTML = '<p>No courses or enrolled students have attendance records yet.</p>'; return; }

    const dayNames = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
    const isoDay = date => new Date(date + 'T00:00:00Z').toLocaleDateString('en-US',{weekday:'long',timeZone:'UTC'});
    const weekKey = date => {
      const d = new Date(date + 'T00:00:00Z');
      const day = d.getUTCDay();
      const diff = day === 0 ? -6 : 1 - day;
      d.setUTCDate(d.getUTCDate() + diff);
      return d.toISOString().slice(0,10);
    };
    const esc = escapeAttr;
    let html = '';
    for (const course of courses) {
      html += `<div class="admin-att-course" data-course-id="${esc(course.course_id)}"><h3>${escapeHtml(course.course_title)} <small>(${Number(course.duration_weeks || 12)} weeks)</small></h3>`;
      if (!course.students.length) { html += '<p>No approved students enrolled in this course.</p></div>'; continue; }
      html += `<div class="table-wrap"><table class="attendance-admin-table"><thead><tr><th>Student</th><th>ID</th><th>Expected / attended</th><th>Attendance</th><th>Today</th><th>Details</th></tr></thead><tbody>`;
      for (const student of course.students) {
        const weeks = new Map();
        for (const day of student.days) { const key=weekKey(day.date); if(!weeks.has(key)) weeks.set(key,[]); weeks.get(key).push(day); }
        // student.days contains the complete course schedule; group into Monday-Friday weeks.
        const grid = Array.from(weeks.entries()).map(([week, days]) => {
          const byDate = new Map(days.map(x=>[x.date,x]));
          const cells = dayNames.map(name => {
            const day = days.find(x=>x.day === name.slice(0,3));
            if (!day) return `<td class="attendance-empty">—</td>`;
            const future = day.date > today;
            return `<td class="attendance-cell"><label title="${escapeAttr(day.date)} ${escapeAttr(name)}"><input type="checkbox" class="admin-attendance-check" data-student-id="${esc(student.student_id)}" data-course-id="${esc(course.course_id)}" data-date="${esc(day.date)}" ${day.marked?'checked':''} ${future?'disabled':''}><span>${day.marked?'Present':'Absent'}</span></label><small>${escapeHtml(day.date)}</small></td>`;
          }).join('');
          return `<div class="attendance-week"><b>Week of ${escapeHtml(week)}</b><div class="attendance-week-grid"><div class="attendance-week-head">${dayNames.map(x=>`<span>${x}</span>`).join('')}</div><div class="attendance-week-row">${cells}</div></div></div>`;
        }).join('');
        html += `<tr><td><b>${escapeHtml(student.student_name)}</b><br><small>${escapeHtml(student.email)}</small></td><td>${escapeHtml(student.student_id_number || '-')}</td><td>${Number(student.expected_days_to_date || 0)} / ${Number(student.marked_count || 0)}<br><small>${Number(student.total_days || 0)} scheduled days</small></td><td>${Number(student.attendance_percentage || 0)}%</td><td>${student.today_marked ? '<b>Present</b>' : '<span>Not marked</span>'}</td><td><details><summary>Monday–Friday attendance</summary>${grid}</details></td></tr>`;
      }
      html += '</tbody></table></div></div>';
    }
    container.innerHTML = html;
    document.querySelectorAll('.admin-attendance-check').forEach(box => box.addEventListener('change', async () => {
      const payload = {studentId:box.dataset.studentId,courseId:box.dataset.courseId,date:box.dataset.date};
      box.disabled = true;
      try {
        await api('/api/admin/attendance/' + (box.checked ? 'mark' : 'unmark'), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        await loadAdminAttendance();
      } catch (e) {
        box.checked = !box.checked;
        alert(e.message);
        box.disabled = false;
      }
    }));
  } catch (e) {
    container.innerHTML = `<p class="msg">Could not load attendance: ${escapeHtml(e.message)}</p>`;
  }
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
  const container = document.getElementById('instructorApplications');
  const accountsEl = document.getElementById('instructorAccounts');
  try {
    const d = await api('/api/admin/instructor-applications?ts=' + Date.now());
    let accountRows = [];
    try { const combined = await api('/api/admin/instructors'); accountRows = combined.instructors || []; } catch (_) { /* applications remain available even if account list fails */ }
    const apps = d.applications || [];
    const active = accountRows;
    const pending = Number(d.pending_count || apps.filter(a => a.status === 'pending').length);
    container.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px"><b>Applications awaiting review: ${pending}</b><button class="ghost-btn small" id="refreshInstructorApplications">Refresh applications</button></div>` + (apps.length ? `<div class="table-wrap"><table><thead><tr><th>Applicant</th><th>What they want to teach</th><th>Teaching plan / experience</th><th>Status</th><th>Action</th></tr></thead><tbody>${apps.map(a => `<tr><td><b>${escapeHtml(a.name)}</b><br><small>${escapeHtml(a.email)}</small></td><td>${escapeHtml(a.teaching_topics || '-')}</td><td>${escapeHtml(a.message || '-')}<br><small>Submitted: ${escapeHtml(new Date(a.created_at).toLocaleString())}</small></td><td>${escapeHtml(a.status)}</td><td>${a.status === 'pending' ? `<button class="btn small instructor-action" data-id="${a.user_id}" data-action="approve">Approve</button> <button class="ghost-btn small instructor-action" data-id="${a.user_id}" data-action="reject">Reject</button>` : '-'}</td></tr>`).join('')}</tbody></table></div>` : '<p>No instructor applications yet.</p>');
    accountsEl.innerHTML = active.length ? `<h3>Active instructor accounts</h3><div class="table-wrap"><table><thead><tr><th>Instructor</th><th>Official ID</th><th>Dates / department</th><th>Status</th><th>Courses</th><th>Action</th></tr></thead><tbody>${active.map(a => `<tr><td><b>${escapeHtml(a.name)}</b><br><small>${escapeHtml(a.email)}</small></td><td><input class="instructor-id-input" data-instructor-id="${a.id}" value="${escapeAttr(a.instructor_id_number || '')}" placeholder="SMARTTEP-INST-2026-ABC123" maxlength="40"><button class="btn small save-instructor-id" data-id="${a.id}" style="margin-top:6px">Save ID</button></td><td><input class="instructor-reg-input" data-id="${a.id}" type="date" value="${escapeAttr(a.registration_date || '')}" title="Registration date"><input class="instructor-expiry-input" data-id="${a.id}" type="date" value="${escapeAttr(a.expiry_date || '')}" title="Expiry date" style="margin-top:6px"><input class="instructor-dept-input" data-id="${a.id}" value="${escapeAttr(a.department || '')}" placeholder="Department / subject" style="margin-top:6px"></td><td>${a.suspended ? 'Suspended' : 'Active'}</td><td>${Number(a.course_count || 0)}</td><td><a class="ghost-btn small" href="/instructor.html?adminView=${encodeURIComponent(a.id)}">View portal</a> <a class="ghost-btn small" href="/verify-instructor.html?q=${encodeURIComponent(a.instructor_id_number || '')}" target="_blank" rel="noopener">Verify ID</a> <button class="ghost-btn small instructor-action" data-id="${a.id}" data-action="${a.suspended ? 'unsuspend' : 'suspend'}">${a.suspended ? 'Restore access' : 'Suspend'}</button></td></tr>`).join('')}</tbody></table></div>` : '<p>No active instructor accounts yet.</p>';
    document.querySelectorAll('.save-instructor-id').forEach(btn => btn.onclick = async () => {
      const id=btn.dataset.id;
      const input=document.querySelector(`.instructor-id-input[data-instructor-id="${id}"]`);
      const reg=document.querySelector(`.instructor-reg-input[data-id="${id}"]`);
      const expiry=document.querySelector(`.instructor-expiry-input[data-id="${id}"]`);
      const dept=document.querySelector(`.instructor-dept-input[data-id="${id}"]`);
      btn.disabled=true;
      try { await api('/api/admin/instructors/'+id+'/identity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instructorIdNumber:input.value,registrationDate:reg.value,expiryDate:expiry.value,department:dept.value})}); alert('Instructor ID and identity details saved.'); await loadInstructors(); } catch(e){ alert(e.message); btn.disabled=false; }
    });
    document.getElementById('refreshInstructorApplications')?.addEventListener('click', loadInstructors);
    document.querySelectorAll('.instructor-action').forEach(btn => btn.onclick = async () => {
      const action = btn.dataset.action;
      const question = action === 'approve' ? 'Approve this instructor application and give the user instructor portal access?' : action === 'reject' ? 'Reject this instructor application?' : action === 'suspend' ? 'Suspend this instructor account?' : 'Restore this instructor access?';
      if (!confirm(question)) return;
      btn.disabled = true;
      try { await api('/api/admin/instructors/' + btn.dataset.id + '/decision', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action})}); await loadInstructors(); await refresh(); } catch(e) { alert(e.message); btn.disabled = false; }
    });
  } catch (e) {
    container.innerHTML = `<p class="msg">Could not load instructor applications: ${escapeHtml(e.message)}. <button class="ghost-btn small" id="retryInstructorApplications">Retry</button></p>`;
    document.getElementById('retryInstructorApplications')?.addEventListener('click', loadInstructors);
  }
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
          <div style="margin-top:10px"><div class="ai-cost-grid"><label>SMARTTEP Student ID<input class="student-identity-id" data-user-id="${x.id}" value="${escapeAttr(x.student_id_number || '')}" placeholder="e.g. SMARTTEP-2026-ABC123"></label><label>Course code<input class="student-identity-course-code" data-user-id="${x.id}" value="${escapeAttr(x.course_code || '')}" placeholder="e.g. WEB-101"></label><label>Registration date<input class="student-identity-registration" data-user-id="${x.id}" type="date" value="${escapeAttr(x.registration_date || '')}"></label><label>Programme ending<input class="student-identity-ending" data-user-id="${x.id}" type="date" value="${escapeAttr(x.programme_end_date || '')}"></label><label>State<input class="student-identity-state" data-user-id="${x.id}" value="${escapeAttr(x.state || '')}" placeholder="State"></label><label>Country<input class="student-identity-country" data-user-id="${x.id}" value="${escapeAttr(x.country || 'Nigeria')}" placeholder="Country"></label><label>Gender<select class="student-identity-gender" data-user-id="${x.id}"><option value="">Select gender</option><option ${x.gender==='Male'?'selected':''}>Male</option><option ${x.gender==='Female'?'selected':''}>Female</option><option ${x.gender==='Other'?'selected':''}>Other</option><option ${x.gender==='Prefer not to say'?'selected':''}>Prefer not to say</option></select></label></div><button class="btn small admin-action" data-action="save-student-identity" data-id="${x.id}">Save ID & Student Details</button></div>
        </div>`;
      }).join('');

      const opts = allCourseOptions;
      document.getElementById('lessonCourse').innerHTML = opts;
      document.getElementById('assignmentCourse').innerHTML = opts;

      document.getElementById('courses').innerHTML = c.courses.map(x => `
        <div class="row" style="display:block">
          <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap">
            <span><b>${escapeHtml(x.title)}</b><br><small>${escapeHtml(x.description || '')} · Price: ${Number(x.price || 0).toFixed(2)} · ${Number(x.duration_weeks || 12)} weeks · ${x.locked ? 'Locked' : 'Open'}</small></span>
            <span><button class="btn small admin-action" data-action="edit-course" data-id="${x.id}">Edit</button> <button class="btn small admin-action" data-action="lock-course" data-id="${x.id}">${x.locked ? 'Unlock' : 'Lock'}</button> <button class="ghost-btn small admin-action" data-action="delete-course" data-id="${x.id}">Delete</button></span>
          </div>
        </div>`).join('');
      window.__adminCourses = c.courses;
      const examCourseSelect=document.getElementById("adminExamCourse"); if(examCourseSelect) examCourseSelect.innerHTML=allCourseOptions;
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
            document.getElementById('courseDurationWeeks').value = Number(course.duration_weeks || 12);
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
      document.getElementById('courseDurationWeeks').value = '12';
      document.getElementById('courseSaveBtn').textContent = 'Create course';
      document.getElementById('courseCancelBtn').hidden = true;
      document.getElementById('courseMsg').textContent = '';
    };
    document.getElementById('courseCancelBtn').onclick = resetCourseForm;
    courseForm.onsubmit = async e => {
      e.preventDefault();
      const msg = document.getElementById('courseMsg');
      const id = document.getElementById('courseId').value;
      const payload = { title: document.getElementById('courseTitle').value, description: document.getElementById('courseDescription').value, price: Number(document.getElementById('coursePrice').value || 0), durationWeeks: Number(document.getElementById('courseDurationWeeks').value || 12), thumbnail: document.getElementById('courseThumbnail').value, locked: document.getElementById('courseLocked').checked };
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

    // Load the main admin dashboard, but do not let an unrelated dashboard
    // widget failure prevent instructor applications from appearing.
    try {
      await refresh();
    } catch (dashboardError) {
      console.error('Admin dashboard refresh failed:', dashboardError);
    }
    await Promise.allSettled([loadAILimits(), loadSmartSecurity(), loadInstructorSecurity()]);
    // Instructor applications have their own API/data path and must always be attempted.
    await loadInstructors();
    await loadAdminAttendance();
    document.getElementById('adminAttendanceCourse')?.addEventListener('change', loadAdminAttendance);
    document.getElementById('refreshAdminAttendance')?.addEventListener('click', loadAdminAttendance);
    document.getElementById('exportAdminAttendance')?.addEventListener('click', () => {
      const courseId = document.getElementById('adminAttendanceCourse')?.value || '';
      window.location = '/api/admin/attendance/export.csv' + (courseId ? '?courseId=' + encodeURIComponent(courseId) : '');
    });
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

// ===== Exam + certificate management =====
function examQuestionHtml(prefix, q, i){
  if(q.type==='theory') return `<div class="card exam-q" data-index="${i}" data-type="theory"><b>Theory question ${i+1}</b><button type="button" class="ghost-btn small remove-exam-q">Remove</button><textarea class="exam-text" placeholder="Theory question" required>${escapeHtml(q.text||'')}</textarea><input class="exam-marks" type="number" min="1" value="${Number(q.marks||1)}" placeholder="Marks"></div>`;
  return `<div class="card exam-q" data-index="${i}" data-type="objective"><b>Objective question ${i+1}</b><button type="button" class="ghost-btn small remove-exam-q">Remove</button><textarea class="exam-text" placeholder="Question" required>${escapeHtml(q.text||'')}</textarea><div class="ai-cost-grid"><input class="exam-opt" placeholder="Option A" value="${escapeAttr(q.options?.[0]||'')}"><input class="exam-opt" placeholder="Option B" value="${escapeAttr(q.options?.[1]||'')}"><input class="exam-opt" placeholder="Option C" value="${escapeAttr(q.options?.[2]||'')}"></div><label>Correct answer<select class="exam-correct"><option value="0" ${q.correctIndex===0?'selected':''}>A</option><option value="1" ${q.correctIndex===1?'selected':''}>B</option><option value="2" ${q.correctIndex===2?'selected':''}>C</option></select></label><input class="exam-marks" type="number" min="1" value="${Number(q.marks||1)}" placeholder="Marks"></div>`;
}
function setupExamBuilder(root, prefix){
 const state=[]; const render=()=>{root.innerHTML=state.map((q,i)=>examQuestionHtml(prefix,q,i)).join('');root.querySelectorAll('.remove-exam-q').forEach((b,i)=>b.onclick=()=>{state.splice(i,1);render()})};
 return {add(type){state.push(type==='theory'?{type:'theory',text:'',marks:1}:{type:'objective',text:'',options:['','',''],correctIndex:0,marks:1});render()},collect(){return [...root.querySelectorAll('.exam-q')].map(q=>{const type=q.dataset.type;return type==='theory'?{type,text:q.querySelector('.exam-text').value,marks:Number(q.querySelector('.exam-marks').value||1)}:{type,text:q.querySelector('.exam-text').value,options:[...q.querySelectorAll('.exam-opt')].map(x=>x.value),correctIndex:Number(q.querySelector('.exam-correct').value),marks:Number(q.querySelector('.exam-marks').value||1)}})}};
}
async function loadAdminExamSecurity(){
 const box=document.getElementById('adminExamSecurity'); if(!box)return;
 try{
  const d=await api('/api/admin/exam-security'); const rows=d.events||[];
  box.innerHTML=rows.length?`<div class="table-wrap"><table><thead><tr><th>Time</th><th>Student</th><th>Exam</th><th>Reason</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows.map(a=>`<tr><td>${escapeHtml(new Date(a.created_at).toLocaleString())}</td><td><b>${escapeHtml(a.student_name)}</b><br><small>${escapeHtml(a.email)} · ${escapeHtml(a.student_id_number||'No ID')}</small></td><td>${escapeHtml(a.exam_title)}<br><small>${escapeHtml(a.course_title)}</small></td><td>${escapeHtml(a.reason)}</td><td>${a.portal_locked?'<b>LOCKED — PENDING APPROVAL</b>':'Reviewed/unlocked'}</td><td>${a.portal_locked&&a.attempt_id?`<button class="btn small exam-security-unlock" data-id="${escapeAttr(a.attempt_id)}">Approve & Unlock</button>`:'-'}</td></tr>`).join('')}</tbody></table></div>`:'<p>No exam security violations recorded.</p>';
  document.querySelectorAll('.exam-security-unlock').forEach(btn=>btn.onclick=async()=>{if(!confirm('Approve this student and unlock the account?'))return;btn.disabled=true;try{await api('/api/admin/exam-security/'+btn.dataset.id+'/unlock',{method:'POST'});await loadAdminExamSecurity();}catch(e){alert(e.message);btn.disabled=false;}});
 }catch(e){box.innerHTML=`<p class="msg">${escapeHtml(e.message)}</p>`}
}

async function loadAdminExams(){
 const box=document.getElementById('adminExams'); if(!box)return;
 try{const d=await api('/api/admin/exams');const exams=d.exams||[];box.innerHTML='<h3>Created exams</h3>'+(exams.length?`<div class="table-wrap"><table><thead><tr><th>Exam</th><th>Course</th><th>Questions</th><th>Duration</th><th>Actions</th></tr></thead><tbody>${exams.map(e=>`<tr><td>${escapeHtml(e.title)}</td><td>${escapeHtml(e.course_title)}</td><td>${e.questions.length}</td><td>${e.duration_minutes} min</td><td><button class="btn small exam-attempts" data-id="${e.id}">Student attempts</button> <button class="ghost-btn small exam-results" data-id="${e.id}">Results</button> <button class="ghost-btn small exam-delete" data-id="${e.id}">Delete</button></td></tr>`).join('')}</tbody></table></div>`:'<p>No exams created yet.</p>');document.querySelectorAll('.exam-attempts,.exam-results').forEach(b=>b.onclick=()=>loadAdminExamAttempts(b.dataset.id));document.querySelectorAll('.exam-delete').forEach(b=>b.onclick=async()=>{if(confirm('Delete this exam and its attempts?')){await api('/api/admin/exams/'+b.dataset.id,{method:'DELETE'});loadAdminExams()}})}catch(e){box.innerHTML=`<p class="msg">${escapeHtml(e.message)}</p>`}
}
async function loadAdminExamAttempts(id){
 const box=document.getElementById('adminExamAttempts');
 try{
  const d=await api('/api/admin/exams/'+id+'/attempts');
  let html='<h3>'+escapeHtml(d.exam.title)+' — Student Attempts</h3>';
  if(!d.attempts.length){html+='<p>No student attempts yet.</p>';box.innerHTML=html;return;}
  html+='<div class="exam-attempts">'+d.attempts.map(a=>{
   const theory=d.exam.questions.some(q=>q.type==='theory');
   const form=theory?'<form class="theoryMarkForm" data-id="'+a.id+'">'+d.exam.questions.map((q,i)=>q.type==='theory'?'<label>'+i+1+'. '+escapeHtml(q.text)+' ('+q.marks+' marks)<textarea disabled>'+escapeHtml(a.answers?.[i]?.text||'No answer')+'</textarea><input name="g'+i+'" type="number" min="0" max="'+q.marks+'" value="'+(a.answers?.[i]?.theoryScore??'')+'" placeholder="Mark"></label>':'').join('')+'<button class="btn small">Save theory marks</button></form>':'';
   return '<div class="card"><b>'+escapeHtml(a.student_name)+'</b> — '+escapeHtml(a.email)+'<br><small>'+escapeHtml(a.student_id_number||'No ID')+' · Submitted: '+(a.submitted_at?escapeHtml(new Date(a.submitted_at).toLocaleString()):'-')+'</small><p>Objective: '+a.objective_score+' · Theory: '+a.theory_score+' · <b>Total: '+a.score+'/'+a.max_score+'</b></p>'+form+'</div>';
  }).join('')+'</div>';
  box.innerHTML=html;
  document.querySelectorAll('.theoryMarkForm').forEach(f=>f.onsubmit=async e=>{e.preventDefault();const fd=new FormData(f);const grades=d.exam.questions.map((q,i)=>q.type==='theory'?Number(fd.get('g'+i)||0):null);try{await api('/api/admin/exams/attempts/'+f.dataset.id+'/mark-theory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grades})});await loadAdminExamAttempts(id);}catch(err){alert(err.message);}});
 }catch(e){box.innerHTML='<p class="msg">'+escapeHtml(e.message)+'</p>';}
}
async function loadAdminCertificates(){const box=document.getElementById('adminCertificateRequests');if(!box)return;try{const d=await api('/api/admin/certificate-requests');box.innerHTML=d.requests.length?`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Course</th><th>ID</th><th>Status</th><th>Action</th></tr></thead><tbody>${d.requests.map(r=>`<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.email)}</td><td>${escapeHtml(r.course)}</td><td>${escapeHtml(r.id_number)}</td><td>${escapeHtml(r.status)}</td><td><select class="cert-status" data-id="${r.id}"><option ${r.status==='pending'?'selected':''}>pending</option><option ${r.status==='approved'?'selected':''}>approved</option><option ${r.status==='issued'?'selected':''}>issued</option><option ${r.status==='rejected'?'selected':''}>rejected</option></select><button class="btn small save-cert" data-id="${r.id}">Save</button></td></tr>`).join('')}</tbody></table></div>`:'<p>No certificate requests yet.</p>';document.querySelectorAll('.save-cert').forEach(b=>b.onclick=async()=>{const s=document.querySelector('.cert-status[data-id="'+b.dataset.id+'"]');await api('/api/admin/certificate-requests/'+b.dataset.id+'/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:s.value})});loadAdminCertificates()})}catch(e){box.innerHTML=`<p class="msg">${escapeHtml(e.message)}</p>`}}
(function(){const b=document.getElementById('adminExamQuestions');if(!b)return;const builder=setupExamBuilder(b,'admin');document.getElementById('adminAddObjective').onclick=()=>builder.add('objective');document.getElementById('adminAddTheory').onclick=()=>builder.add('theory');document.getElementById('adminExamForm').onsubmit=async e=>{e.preventDefault();try{const r=await api('/api/admin/exams',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({courseId:adminExamCourse.value,title:adminExamTitle.value,instructions:adminExamInstructions.value,durationMinutes:Number(adminExamDuration.value),questions:builder.collect(),published:true})});document.getElementById('adminExamMsg').textContent='Exam created successfully.';e.target.reset();b.innerHTML='';loadAdminExams()}catch(err){document.getElementById('adminExamMsg').textContent=err.message}};loadAdminExams();loadAdminExamSecurity();loadAdminCertificates();api('/api/courses').then(d=>{const sel=document.getElementById('adminExamCourse');if(sel)sel.innerHTML=(d.courses||[]).map(c=>`<option value="${escapeAttr(c.id)}">${escapeHtml(c.title)}</option>`).join('')}).catch(()=>{})})();

(function(){const f=document.getElementById('adminCertificateForm');if(f)f.onsubmit=async e=>{e.preventDefault();try{const r=await api('/api/certificate-requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});document.getElementById('adminCertificateMsg').textContent=r.message;f.reset();loadAdminCertificates()}catch(err){document.getElementById('adminCertificateMsg').textContent=err.message}}})();
