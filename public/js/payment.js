async function initPayment() {
  const msg = document.getElementById('msg');
  try {
    const me = await fetch('/api/me').then(r => r.json());
    if (!me.user) { location = '/login.html'; return; }
  } catch (_) { location = '/login.html'; return; }

  document.getElementById('paymentForm').onsubmit = async e => {
    e.preventDefault();
    const button = e.target.querySelector('button[type="submit"]') || e.target.querySelector('button');
    if (button) { button.disabled = true; button.textContent = 'Submitting...'; }
    msg.textContent = '';
    try {
      const res = await fetch('/api/payments', { method: 'POST', body: new FormData(e.target) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Payment submission failed.');
      msg.textContent = 'Payment proof submitted successfully. Your account is now pending admin approval. You can remain on this payment page.';
      if (d.ok) {
        e.target.reset();
        if (button) { button.disabled = false; button.textContent = 'Submit payment'; }
      }
    } catch (err) {
      msg.textContent = err.message;
      if (button) { button.disabled = false; button.textContent = 'Submit payment'; }
    }
  };
}
initPayment();
