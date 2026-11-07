/* Smart Typing Villa — Admin performance dashboard */
(() => {
  async function loadTypingStats() {
    const summary = document.getElementById('typingAdminSummary');
    const rowsEl = document.getElementById('typingAdminRows');
    if (!summary || !rowsEl) return;

    try {
      const r = await fetch('/api/admin/typing/stats', { credentials: 'same-origin', cache: 'no-store' });
      let d = {};
      try { d = await r.json(); } catch (_) {}

      if (!r.ok) {
        if (d.code === 'ADMIN_2FA_REQUIRED') {
          summary.innerHTML = '<p><strong>Admin verification required.</strong> Complete your Admin 2FA verification, then refresh this page.</p>';
        } else if (r.status === 401) {
          summary.innerHTML = '<p><strong>Admin session expired.</strong> Sign in again and reopen the Admin Portal.</p>';
        } else if (r.status === 403) {
          summary.innerHTML = `<p><strong>Access denied.</strong> ${String(d.error || 'Admin access is required.').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}</p>`;
        } else {
          throw new Error(d.error || 'Unable to load typing statistics.');
        }
        rowsEl.innerHTML = '';
        return;
      }

      const t = d.totals || {};
      summary.innerHTML = `
        <div class="grid">
          <div class="panel"><b>${Number(t.learners || 0)}</b><br>Learners</div>
          <div class="panel"><b>${Number(t.sessions || 0)}</b><br>Sessions</div>
          <div class="panel"><b>${Number(t.minutes || 0)}</b><br>Practice minutes</div>
          <div class="panel"><b>${Number(t.averageBestWpm || 0)}</b><br>Average best WPM</div>
        </div>`;

      const rows = Array.isArray(d.students) ? d.students : [];
      if (!rows.length) {
        rowsEl.innerHTML = '<p>No typing sessions have been recorded yet.</p>';
        return;
      }

      const esc = value => String(value ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
      rowsEl.innerHTML = `<div style="overflow:auto"><table>
        <thead><tr><th>Learner</th><th>ID</th><th>Best WPM</th><th>Accuracy</th><th>Level</th><th>Sessions</th></tr></thead>
        <tbody>${rows.map(x => `<tr>
          <td>${esc(x.name)}</td>
          <td>${esc(x.studentIdNumber || '')}</td>
          <td>${Number(x.bestWpm || 0)}</td>
          <td>${Math.round(Number(x.bestAccuracy || 0))}%</td>
          <td>${Number(x.level || 1)}</td>
          <td>${Number(x.totalSessions || 0)}</td>
        </tr>`).join('')}</tbody>
      </table></div>`;
    } catch (e) {
      summary.innerHTML = `<p><strong>Unable to load typing statistics.</strong> ${String(e.message || e).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}</p>`;
      rowsEl.innerHTML = '';
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadTypingStats);
  else loadTypingStats();
})();
