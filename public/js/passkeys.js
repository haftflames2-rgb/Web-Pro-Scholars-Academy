const passkeyMsg = document.getElementById('passkeyMsg');
const passkeyList = document.getElementById('passkeyList');

function b64urlToBytes(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
function bytesToB64url(value) {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function prepareCreationOptions(options) {
  options.challenge = b64urlToBytes(options.challenge);
  options.user.id = b64urlToBytes(options.user.id);
  for (const item of options.excludeCredentials || []) item.id = b64urlToBytes(item.id);
  return options;
}
function prepareRequestOptions(options) {
  options.challenge = b64urlToBytes(options.challenge);
  for (const item of options.allowCredentials || []) item.id = b64urlToBytes(item.id);
  return options;
}
function serializeCredential(credential) {
  const response = credential.response;
  const payload = { id: credential.id, rawId: bytesToB64url(credential.rawId), type: credential.type, clientExtensionResults: credential.getClientExtensionResults?.() || {}, authenticatorAttachment: credential.authenticatorAttachment || undefined, response: { clientDataJSON: bytesToB64url(response.clientDataJSON) } };
  if (response.attestationObject) {
    payload.response.attestationObject = bytesToB64url(response.attestationObject);
    if (response.getTransports) payload.response.transports = response.getTransports();
  } else {
    payload.response.authenticatorData = bytesToB64url(response.authenticatorData);
    payload.response.signature = bytesToB64url(response.signature);
    payload.response.userHandle = response.userHandle ? bytesToB64url(response.userHandle) : null;
  }
  return payload;
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}

async function refreshPasskeys() {
  try {
    const data = await api('/api/passkeys');
    const items = data.passkeys || [];
    if (!items.length) { passkeyList.textContent = 'No passkeys registered on this account yet.'; return; }
    passkeyList.replaceChildren();
    for (const item of items) {
      const row = document.createElement('div'); row.className = 'passkey-item';
      const details = document.createElement('div');
      const name = document.createElement('strong'); name.textContent = item.deviceName || 'Registered device';
      const date = document.createElement('div'); date.className = 'passkey-muted'; date.textContent = `Added ${item.createdAt ? new Date(item.createdAt).toLocaleString() : 'date unavailable'}`;
      details.append(name, date);
      const remove = document.createElement('button'); remove.className = 'ghost-btn small passkey-danger'; remove.type = 'button'; remove.textContent = 'Remove';
      remove.onclick = async () => {
        if (!confirm('Remove this passkey? You can still sign in with your password.')) return;
        try { await api(`/api/passkeys/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); passkeyMsg.textContent = 'Passkey removed.'; await refreshPasskeys(); }
        catch (error) { passkeyMsg.textContent = error.message; }
      };
      row.append(details, remove); passkeyList.append(row);
    }
  } catch (error) {
    passkeyList.textContent = error.message.includes('Authentication') ? 'Please sign in first, then open Passkey security from your dashboard.' : error.message;
  }
}

const addButton = document.getElementById('addPasskey');
if (!window.isSecureContext || !('PublicKeyCredential' in window) || !navigator.credentials) {
  addButton.disabled = true;
  passkeyMsg.textContent = 'This browser or connection does not support passkeys here. Use a current browser over HTTPS, then try again.';
}
addButton.addEventListener('click', async () => {
  addButton.disabled = true; passkeyMsg.textContent = 'Preparing secure device registration…';
  try {
    const options = await api('/api/passkeys/register/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const credential = await navigator.credentials.create({ publicKey: prepareCreationOptions(options) });
    if (!credential) throw new Error('Your device cancelled passkey registration.');
    const deviceName = prompt('Give this device a name (for example, My Android phone):', 'My device') || 'My device';
    const result = await api('/api/passkeys/register/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...serializeCredential(credential), deviceName }) });
    passkeyMsg.textContent = result.message || 'Passkey registered.';
    await refreshPasskeys();
  } catch (error) { passkeyMsg.textContent = error.name === 'NotAllowedError' ? 'Registration was cancelled or timed out. Try again.' : error.message; }
  finally { addButton.disabled = false; }
});
refreshPasskeys();

fetch('/api/me').then(r => r.json()).then(data => {
  const role = data.user?.role;
  const targets = { student: '/student.html', instructor: '/instructor.html', moderator: '/moderator.html', admin: '/admin.html', referral_agent: '/referrals.html' };
  const link = document.getElementById('dashboardLink');
  if (link && targets[role]) link.href = targets[role];
}).catch(() => {});
