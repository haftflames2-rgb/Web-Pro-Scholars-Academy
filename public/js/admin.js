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
        if (x.role !== 'student') return `<div class="row"><span>${escapeHtml(x.name)} — ${escapeHtml(x.email)}<br><small>Administrator account</small></span></div>`;
        const selected = new Set(x.enrolled_course_ids || []);
        return `<div class="row" style="display:block">
          <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap">
            <span><b>${escapeHtml(x.name)}</b> — ${escapeHtml(x.email)}<br><small>${escapeHtml(x.payment_status || 'unpaid')} / ${x.approved ? 'approved' : 'awaiting approval'}</small></span>
            <span>
              ${!x.approved ? `<button class="btn small admin-action" data-action="approve" data-id="${x.id}">Approve</button>` : ''}
              <button class="btn small admin-action" data-action="lock-user" data-id="${x.id}">${x.portal_locked ? 'Unlock' : 'Lock'} Portal</button>
              <button class="btn small admin-action" data-action="view-portal" data-id="${x.id}">Open User Portal</button>
            </span>
          </div>
          <div style="margin-top:10px"><label>Registered courses</label><select class="user-course-select" multiple size="4" data-user-id="${x.id}">${c.courses.map(course => `<option value="${course.id}" ${selected.has(course.id) ? 'selected' : ''}>${escapeHtml(course.title)}</option>`).join('')}</select><br><button class="btn small admin-action" data-action="save-user-courses" data-id="${x.id}">Save Course Access</button></div>
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

    document.getElementById('logout').onclick = async () => {
      await fetch('/api/logout', { method: 'POST' });
      location = '/';
    };

    await refresh();
    await loadAILimits();
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
