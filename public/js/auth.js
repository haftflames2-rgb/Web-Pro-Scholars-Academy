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
  const courseSelect = document.getElementById('courseIds');
  const courseIds = courseSelect ? Array.from(courseSelect.selectedOptions).map(o => o.value) : [];

  if (password !== confirmPassword) {
    msg.textContent = 'Passwords do not match.';
    return;
  }

  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nameInput.value, email: emailInput.value, password, courseIds })
  });
  const d = await res.json();
  if (!res.ok) { msg.textContent = d.error; return; }
  location = d.redirect;
};

const courseSelect = document.getElementById('courseIds');
if (courseSelect) {
  fetch('/api/public-courses').then(r => r.json()).then(d => {
    courseSelect.innerHTML = (d.courses || []).map(c => `<option value="${c.id}">${String(c.title).replace(/[&<>\"']/g, '')}</option>`).join('');
  }).catch(() => { msg.textContent = 'Could not load courses. Please refresh the page.'; });
}
