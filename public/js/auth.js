const msg = document.getElementById('msg');

const loginForm = document.getElementById('loginForm');
if (loginForm) loginForm.onsubmit = async (e) => {
  e.preventDefault();
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: emailInput.value, password: passwordInput.value })
  });
  const d = await res.json();
  if (!res.ok) { msg.textContent = d.error; return; }
  location = d.redirect;
};

const registerForm = document.getElementById('registerForm');
if (registerForm) registerForm.onsubmit = async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById('name');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const confirmInput = document.getElementById('confirm');
  const password = passwordInput.value;
  const confirmPassword = confirmInput.value;

  if (password !== confirmPassword) {
    msg.textContent = 'Passwords do not match.';
    return;
  }

  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nameInput.value, email: emailInput.value, password })
  });
  const d = await res.json();
  if (!res.ok) { msg.textContent = d.error; return; }
  location = d.redirect;
};
