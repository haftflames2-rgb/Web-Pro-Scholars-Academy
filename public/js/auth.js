const msg = document.getElementById('msg');
if (msg && new URLSearchParams(location.search).get('notice') === 'nin-already-exists') msg.textContent = 'This NIN already exists in SMARTTEP records. Please log in to your existing account.';
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
  const requested = new URLSearchParams(location.search).get('returnTo');
  location = requested && requested.startsWith('/') && !requested.startsWith('//') ? requested : d.redirect;
};

// Passkey sign-in: the device performs local user verification. The biometric
// itself is never sent to SMARTTEP; only the signed WebAuthn response is sent.
const passkeyLoginButton = document.getElementById('passkeyLogin');
function passkeyB64ToBytes(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
function passkeyBytesToB64(value) {
  const bytes = new Uint8Array(value); let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function passkeyRequestOptions(options) {
  options.challenge = passkeyB64ToBytes(options.challenge);
  for (const item of options.allowCredentials || []) item.id = passkeyB64ToBytes(item.id);
  return options;
}
function passkeyCredentialJSON(credential) {
  const r = credential.response;
  return { id: credential.id, rawId: passkeyBytesToB64(credential.rawId), type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults?.() || {},
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    response: { clientDataJSON: passkeyBytesToB64(r.clientDataJSON), authenticatorData: passkeyBytesToB64(r.authenticatorData), signature: passkeyBytesToB64(r.signature), userHandle: r.userHandle ? passkeyBytesToB64(r.userHandle) : null } };
}
if (passkeyLoginButton) {
  if (!window.isSecureContext || !('PublicKeyCredential' in window) || !navigator.credentials) passkeyLoginButton.disabled = true;
  passkeyLoginButton.onclick = async () => {
    const email = String(document.getElementById('email')?.value || '').trim().toLowerCase();
    if (!email) { msg.textContent = 'Enter your account email first.'; return; }
    passkeyLoginButton.disabled = true; msg.textContent = 'Waiting for your device security prompt…';
    try {
      const optionsResponse = await fetch('/api/passkeys/login/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      const options = await optionsResponse.json();
      if (!optionsResponse.ok) throw new Error(options.error || 'Passkey sign-in is unavailable.');
      const credential = await navigator.credentials.get({ publicKey: passkeyRequestOptions(options) });
      if (!credential) throw new Error('Passkey sign-in was cancelled.');
      const verifyResponse = await fetch('/api/passkeys/login/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(passkeyCredentialJSON(credential)) });
      const result = await verifyResponse.json();
      if (!verifyResponse.ok) throw new Error(result.error || 'Passkey sign-in failed.');
      const requested = new URLSearchParams(location.search).get('returnTo');
      location = requested && requested.startsWith('/') && !requested.startsWith('//') ? requested : result.redirect;
    } catch (error) { msg.textContent = error.name === 'NotAllowedError' ? 'Passkey prompt was cancelled or timed out. You can use your password instead.' : error.message; }
    finally { passkeyLoginButton.disabled = false; }
  };
}

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
const admissionTypeControl = document.getElementById('admissionType');
if (admissionTypeControl) admissionTypeControl.addEventListener('change', () => { if (admissionTypeControl.value === 'scholarship') location.href = '/scholarship-apply.html'; });
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
  const admissionType = document.getElementById('admissionType')?.value || 'normal';
  if (admissionType === 'scholarship') {
    location.href = '/scholarship-apply.html';
    return;
  }

  const formData = new FormData();
  formData.append('name', nameInput.value);
  formData.append('email', emailInput.value);
  formData.append('nin', document.getElementById('nin')?.value || '');
  formData.append('ninConsent', document.getElementById('ninConsent')?.checked ? 'yes' : '');
  formData.append('password', password);
  formData.append('admissionType', admissionType);
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
  if (!res.ok) { msg.textContent = d.error; if (String(d.error||'').toLowerCase().includes('nin already exists')) { setTimeout(() => location.href='/login.html?notice=nin-already-exists', 1400); } return; }
  const requested = new URLSearchParams(location.search).get('returnTo');
  location = requested && requested.startsWith('/') && !requested.startsWith('//') ? requested : d.redirect;
};

const courseSelect = document.getElementById('courseIds');
if (courseSelect) {
  fetch('/api/public-courses').then(r => r.json()).then(d => {
    courseSelect.innerHTML = (d.courses || []).map(c => `<option value="${c.id}">${String(c.title).replace(/[&<>\"']/g, '')}</option>`).join('');
  }).catch(() => { msg.textContent = 'Could not load courses. Please refresh the page.'; });
}
