(function () {
  // Smart 48-hour inactivity tracker. Only genuine browser interaction resets
  // the student's inactivity timer; passive tab idling does not.
  let pending = false;
  let lastSent = 0;
  const SEND_COOLDOWN = 10 * 60 * 1000;

  async function sendActivity() {
    const now = Date.now();
    if (pending || now - lastSent < SEND_COOLDOWN) return;
    pending = true;
    try {
      const r = await fetch('/api/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: '{}'
      });
      if (r.status === 423) {
        try {
          const d = await r.json();
          alert(d.error || 'Your account is locked. Please contact the administrator.');
        } catch {}
        location.href = '/login.html';
        return;
      }
      if (r.ok) lastSent = now;
    } catch {}
    finally { pending = false; }
  }

  ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(type => {
    window.addEventListener(type, sendActivity, { passive: true });
  });
})();
