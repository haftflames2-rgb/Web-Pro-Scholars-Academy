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
      const [u, c, p, s] = await Promise.all([
        api('/api/admin/users'),
        api('/api/courses'),
        api('/api/admin/payments'),
        api('/api/admin/submissions')
      ]);

      document.getElementById('users').innerHTML = u.users.map(x => `
        <div class="row">
          <span>${escapeHtml(x.name)} — ${escapeHtml(x.email)}<br>
            <small>${escapeHtml(x.payment_status || 'unpaid')} / ${x.approved ? 'approved' : 'awaiting approval'}</small>
          </span>
          <span>
            ${x.role === 'student' && !x.approved ? `<button class="btn small admin-action" data-action="approve" data-id="${x.id}">Approve</button>` : ''}
            ${x.role === 'student' ? `<button class="btn small admin-action" data-action="lock-user" data-id="${x.id}">${x.portal_locked ? 'Unlock' : 'Lock'} Portal</button>` : ''}
          </span>
        </div>`).join('');

      const opts = c.courses.map(x => `<option value="${x.id}">${escapeHtml(x.title)}</option>`).join('');
      document.getElementById('lessonCourse').innerHTML = opts;
      document.getElementById('assignmentCourse').innerHTML = opts;

      document.getElementById('courses').innerHTML = c.courses.map(x => `
        <div class="row"><span>${escapeHtml(x.title)}</span>
          <button class="btn small admin-action" data-action="lock-course" data-id="${x.id}">${x.locked ? 'Unlock' : 'Lock'}</button>
        </div>`).join('');

      document.getElementById('payments').innerHTML = p.payments.map(x => `
        <div class="row"><span>${escapeHtml(x.name)} (${escapeHtml(x.email)}) — ${escapeHtml(x.method)}<br>
          Reference: ${escapeHtml(x.reference || '-')} ${x.proof_path ? `<a href="${x.proof_path}" target="_blank" rel="noopener">Proof</a>` : ''}
        </span><span>${escapeHtml(x.status)}</span></div>`).join('');

      document.getElementById('submissions').innerHTML = s.submissions.map(x => `
        <div class="row"><span>${escapeHtml(x.student_name)} — ${escapeHtml(x.assignment_title)}<br>
          ${x.file_path ? `<a href="${x.file_path}" target="_blank" rel="noopener">Code file</a>` : ''}
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

    document.getElementById('lessonForm').onsubmit = async e => {
      e.preventDefault();
      try {
        await api('/api/admin/lessons', { method: 'POST', body: new FormData(e.target) });
        e.target.reset();
        alert('Lesson uploaded successfully.');
        await refresh();
      } catch (err) { alert(err.message); }
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
