const msg = document.getElementById('msg');
const twoFactorBox = document.getElementById('twoFactorBox');
const twoFactorCode = document.getElementById('twoFactorCode');
const verifyTwoFactor = document.getElementById('verifyTwoFactor');
const useRecoveryCode = document.getElementById('useRecoveryCode');
let usingRecoveryCode = false;

async function verifyAdmin2fa() {
  const code = String(twoFactorCode?.value || '').trim();
  if (!code) { msg.textContent = usingRecoveryCode ? 'Enter a recovery code.' : 'Enter your 6-digit authenticator code.'; return; }
  try {
    const body = usingRecoveryCode ? { recoveryCode: code } : { code };
    const res = await fetch('/api/admin/2fa/verify', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    const d = await res.json();
    if (!res.ok) { msg.textContent = d.error || 'Verification failed.'; return; }
    location = d.redirect || '/admin.html';
  } catch (_) { msg.textContent = 'Could not verify 2FA. Please try again.'; }
}
if (verifyTwoFactor) verifyTwoFactor.onclick = verifyAdmin2fa;
if (useRecoveryCode) useRecoveryCode.onclick = () => {
  usingRecoveryCode = !usingRecoveryCode;
  useRecoveryCode.textContent = usingRecoveryCode ? 'Use authenticator code instead' : 'Use a recovery code';
  twoFactorCode.value = '';
  twoFactorCode.placeholder = usingRecoveryCode ? 'XXXXXXXX-XXXXXXXX' : '';
  twoFactorCode.maxLength = usingRecoveryCode ? 17 : 6;
  msg.textContent = '';
};

const loginForm = document.getElementById('loginForm');
if (loginForm) loginForm.onsubmit = async (e) => {
  e.preventDefault();
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  msg.textContent = 'Signing in…';
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: emailInput.value, password: passwordInput.value })
  });
  const d = await res.json();
  if (!res.ok) { msg.textContent = d.error; return; }
  if (d.twoFactorRequired) {
    twoFactorBox.hidden = false;
    emailInput.disabled = true; passwordInput.disabled = true;
    verifyTwoFactor?.focus();
    msg.textContent = 'Password accepted. Complete Admin 2FA to continue.';
    return;
  }
  location = d.redirect;
};

const changePasswordForm = document.getElementById('changePasswordForm');
if (changePasswordForm) {
  changePasswordForm.onsubmit = async (e) => {
    e.preventDefault();
    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmNewPassword').value;
    msg.textContent = 'Changing password…';
    try {
      const res = await fetch('/api/change-password', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({currentPassword,newPassword,confirmPassword}) });
      const d = await res.json();
      if (!res.ok) { msg.textContent = d.error || 'Could not change password.'; return; }
      msg.textContent = d.message || 'Password changed successfully.';
      setTimeout(() => { location = d.redirect || '/index.html'; }, 500);
    } catch (_) { msg.textContent = 'Could not change password. Please try again.'; }
  };
}


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
  const profilePicture = document.getElementById('profilePicture');
  const gender = document.getElementById('gender');
  const state = document.getElementById('state');
  const country = document.getElementById('country');

  if (password !== confirmPassword) {
    msg.textContent = 'Passwords do not match.';
    return;
  }

  const formData = new FormData();
  formData.append('name', nameInput.value);
  formData.append('email', emailInput.value);
  formData.append('password', password);
  formData.append('gender', gender?.value || '');
  formData.append('state', state?.value || '');
  formData.append('country', country?.value || 'Nigeria');
  courseIds.forEach(id => formData.append('courseIds', id));
  if (profilePicture?.files?.[0]) formData.append('profilePicture', profilePicture.files[0]);

  const res = await fetch('/api/register', {
    method: 'POST',
    body: formData
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
