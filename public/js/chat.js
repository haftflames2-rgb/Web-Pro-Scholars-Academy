const $ = id => document.getElementById(id);
let conversations = [], users = [], activeId = null, lastMessageId = null, pollTimer = null, loading = false, myId = '';
let mediaRecorder = null, recordedChunks = [], recordingStream = null, recordingStartedAt = 0, recordingTimer = null;
let pendingVoiceFile = null;

async function api(url, opts = {}) {
  const r = await fetch(url, opts);
  let d = {};
  try { d = await r.json(); } catch {}
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}
function esc(s) { return String(s ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c])); }
function fmtTime(v) { if (!v) return ''; const d = new Date(v), now = new Date(); return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : d.toLocaleDateString([], {day:'2-digit', month:'short'}); }
function avatar(name) { return esc((String(name || 'W').trim()[0] || 'W').toUpperCase()); }

async function init() {
  try {
    const me = await api('/api/me');
    if (!me.user) return location = '/login.html';
    myId = me.user.id || me.user._id?.toString() || '';
    $('chatUser').textContent = me.user.name || '';
    $('backPortal').href = me.user.role === 'admin' ? '/admin.html' : '/student.html';
    await loadUsers();
    await loadConversations();
    bind();
  } catch (e) { alert(e.message); location = '/login.html'; }
}
async function loadUsers() { const d = await api('/api/chat/users'); users = d.users || []; renderUsers(); }
async function loadConversations() {
  const d = await api('/api/chat/conversations'); conversations = d.conversations || [];
  renderConversations();
  if (activeId) { const c = conversations.find(x => x.id === activeId); if (c) { updateHeader(c); await loadMessages(true); } else closeRoom(); }
}
function renderConversations() {
  const q = ($('chatSearch').value || '').toLowerCase();
  const list = conversations.filter(c => (c.name + ' ' + c.lastMessage).toLowerCase().includes(q));
  $('conversationList').innerHTML = list.length ? list.map(c => `<div class="chat-row ${c.id === activeId ? 'active' : ''}" data-id="${c.id}"><div class="chat-avatar">${avatar(c.name)}</div><div class="chat-row-info"><div class="chat-row-top"><span class="chat-row-name">${esc(c.name)}${c.type === 'group' ? ' 👥' : ''}</span><span class="chat-row-time">${fmtTime(c.lastMessageAt)}</span></div><div class="chat-row-preview">${esc(c.lastMessage || 'Start a conversation')}</div></div>${c.unread ? `<span class="chat-unread">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</div>`).join('') : '<div class="chat-empty">No chats yet.<br>Start a conversation.</div>';
  document.querySelectorAll('.chat-row').forEach(x => x.onclick = () => openRoom(x.dataset.id));
}
function renderUsers() {
  const q = ($('userSearch').value || '').toLowerCase();
  const rows = users.filter(u => (u.name + ' ' + u.email).toLowerCase().includes(q));
  $('userList').innerHTML = rows.length ? rows.map(u => `<div class="chat-user direct-user" data-id="${u.id}"><div class="chat-avatar">${avatar(u.name)}</div><div><div class="chat-user-name">${esc(u.name)}</div><div class="chat-user-role">${esc(u.role)}</div></div></div>`).join('') : '<div class="chat-empty">No people found.</div>';
  $('groupUserList').innerHTML = users.map(u => `<label class="chat-user"><input type="checkbox" value="${u.id}"><div class="chat-avatar">${avatar(u.name)}</div><div><div class="chat-user-name">${esc(u.name)}</div><div class="chat-user-role">${esc(u.role)}</div></div></label>`).join('') || '<div class="chat-empty">No people available.</div>';
  document.querySelectorAll('.direct-user').forEach(x => x.onclick = () => startDirect(x.dataset.id));
}
async function startDirect(id) { try { const d = await api('/api/chat/direct', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId:id})}); closeModal(); await loadConversations(); openRoom(d.conversation.id); } catch (e) { alert(e.message); } }
async function openRoom(id) {
  activeId = id; lastMessageId = null;
  const c = conversations.find(x => x.id === id); if (!c) return;
  updateHeader(c); $('chatWelcome').classList.add('hidden'); $('chatRoom').classList.remove('hidden'); document.querySelector('.chat-shell').classList.add('room-open');
  renderConversations(); $('messageList').innerHTML = '<div class="chat-empty">Loading messages…</div>'; await loadMessages(true); await markRead();
}
function updateHeader(c) { $('roomTitle').textContent = c.name; $('roomMeta').textContent = c.type === 'group' ? `${c.memberCount} members` : (c.members?.find(m => m.id !== myId)?.role || 'Direct chat'); $('roomAvatar').textContent = String(c.name || 'W')[0].toUpperCase(); }
async function loadMessages(full = false) {
  if (!activeId || loading) return; loading = true;
  try {
    const d = await api(`/api/chat/conversations/${activeId}/messages${full || !lastMessageId ? '' : '?after=' + encodeURIComponent(lastMessageId)}`);
    const msgs = d.messages || []; if (full) $('messageList').innerHTML = '';
    for (const m of msgs) appendMessage(m);
    if (msgs.length) { lastMessageId = msgs[msgs.length - 1].id; $('messageList').scrollTop = $('messageList').scrollHeight; }
    if (!full && msgs.length) await markRead();
  } catch (e) { if (full) $('messageList').innerHTML = `<div class="chat-empty">${esc(e.message)}</div>`; }
  finally { loading = false; }
}

function attachmentMarkup(a, messageId) {
  if (!a) return '';
  const name = esc(a.name || 'Attachment');
  const contentUrl = `/api/chat/attachments/${encodeURIComponent(messageId)}/content`;
  if (a.kind === 'image') return `<a class="chat-media-link" href="${contentUrl}" target="_blank" rel="noopener"><img class="chat-image" src="${contentUrl}" alt="${name}" loading="lazy"></a>`;
  if (a.kind === 'video') return `<video class="chat-video" controls preload="metadata" playsinline src="${contentUrl}"></video>`;
  if (a.kind === 'audio') return `<audio class="chat-audio" controls preload="metadata" src="${contentUrl}"></audio>`;
  const downloadUrl = `/api/chat/attachments/${encodeURIComponent(messageId)}/download`;
  return `<a class="chat-file" href="${downloadUrl}" target="_blank" rel="noopener"><span class="chat-file-icon">📄</span><span><b>${name}</b><small>DOCX document</small></span></a>`;
}
function appendMessage(m) {
  if (document.querySelector(`[data-message-id="${m.id}"]`)) return;
  const mine = m.senderId === myId, wrap = document.createElement('div');
  wrap.className = 'chat-bubble-wrap ' + (mine ? 'mine' : 'theirs'); wrap.dataset.messageId = m.id;
  const bubble = document.createElement('div'); bubble.className = 'chat-bubble';
  bubble.innerHTML = `${!mine ? `<div class="chat-sender">${esc(m.senderName)}</div>` : ''}${m.text ? `<div class="chat-text">${esc(m.text)}</div>` : ''}${attachmentMarkup(m.attachment, m.id)}<span class="chat-time">${fmtTime(m.createdAt)}${mine ? ' ✓' : ''}</span>`;
  wrap.appendChild(bubble); $('messageList').appendChild(wrap);
}
async function markRead() { if (activeId) try { await api(`/api/chat/conversations/${activeId}/read`, {method:'POST'}); } catch {} }

async function sendMessage(e) {
  e.preventDefault();
  if (!activeId) return;
  const input = $('messageInput'), text = input.value.trim();
  if (pendingVoiceFile) {
    const file = pendingVoiceFile;
    pendingVoiceFile = null;
    hideVoicePreview();
    await sendAttachment(file, text);
    return;
  }
  if (!text) return;
  input.disabled = true;
  try {
    const d = await api(`/api/chat/conversations/${activeId}/messages`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text})});
    appendMessage(d.message); lastMessageId = d.message.id; input.value = ''; $('messageList').scrollTop = $('messageList').scrollHeight; await loadConversations();
  } catch (e) { alert(e.message); }
  finally { input.disabled = false; input.focus(); }
}
async function sendAttachment(file, caption = '') {
  if (!activeId || !file) return;
  const form = new FormData(); form.append('file', file); if (caption) form.append('text', caption);
  setComposerBusy(true);
  try {
    const d = await api(`/api/chat/conversations/${activeId}/attachments`, {method:'POST', body:form});
    appendMessage(d.message); lastMessageId = d.message.id; $('messageInput').value = ''; $('messageList').scrollTop = $('messageList').scrollHeight; await loadConversations();
  } catch (e) { alert(e.message); }
  finally { setComposerBusy(false); }
}
function setComposerBusy(busy) { $('messageInput').disabled = busy; $('attachBtn').disabled = busy; $('recordAudioBtn').disabled = busy || !!mediaRecorder; $('chatSend').disabled = busy; }

function formatDuration(seconds) { const s = Math.max(0, Math.floor(seconds)); return `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`; }
function updateRecordingTimer() { if (!recordingStartedAt) return; $('recordingTime').textContent = formatDuration((Date.now() - recordingStartedAt) / 1000); }
function showRecordingPanel() { $('recordingPanel').classList.remove('hidden'); }
function hideRecordingPanel() { $('recordingPanel').classList.add('hidden'); }
function hideVoicePreview() {
  $('voicePreview').classList.add('hidden'); $('voicePreviewAudio').removeAttribute('src'); $('voicePreviewAudio').load(); $('recordingPanel').classList.add('hidden');
  $('recordAudioBtn').textContent = '🎙️'; $('recordAudioBtn').title = 'Record audio'; $('recordingStatus').textContent = 'Record a voice message'; $('recordingTime').textContent = '00:00';
}
function clearPendingVoice() { pendingVoiceFile = null; hideVoicePreview(); $('messageInput').focus(); }

async function startAudioRecording() {
  if (mediaRecorder) { stopAudioRecording(); return; }
  if (pendingVoiceFile) { clearPendingVoice(); return; }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { alert('Audio recording is not supported by this browser. You can still attach an audio file.'); return; }
  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({audio:true});
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'].find(x => MediaRecorder.isTypeSupported(x)) || '';
    mediaRecorder = new MediaRecorder(recordingStream, mime ? {mimeType:mime} : undefined);
    recordedChunks = []; recordingStartedAt = Date.now(); updateRecordingTimer(); showRecordingPanel();
    $('recordingStatus').textContent = 'Recording… tap ■ to stop'; $('recordAudioBtn').textContent = '⏹️'; $('recordAudioBtn').title = 'Stop recording'; $('chatSend').disabled = true;
    recordingTimer = setInterval(updateRecordingTimer, 250);
    mediaRecorder.ondataavailable = e => { if (e.data.size) recordedChunks.push(e.data); };
    mediaRecorder.onerror = () => finishRecording(true);
    mediaRecorder.onstop = () => {
      const type = mediaRecorder?.mimeType || mime || 'audio/webm';
      const ext = type.includes('ogg') ? '.ogg' : '.webm';
      const blob = new Blob(recordedChunks, {type});
      if (recordingStream) recordingStream.getTracks().forEach(t => t.stop());
      recordingStream = null; recordedChunks = []; mediaRecorder = null;
      clearInterval(recordingTimer); recordingTimer = null;
      $('recordAudioBtn').textContent = '🎙️'; $('recordAudioBtn').title = 'Record audio';
      if (!blob.size) { hideRecordingPanel(); return; }
      pendingVoiceFile = new File([blob], `voice-message-${Date.now()}${ext}`, {type});
      $('recordingStatus').textContent = 'Voice message ready — preview or delete it before sending';
      $('voicePreviewAudio').src = URL.createObjectURL(blob); $('voicePreview').classList.remove('hidden'); $('recordingPanel').classList.remove('hidden');
      $('chatSend').disabled = false;
    };
    mediaRecorder.start(250);
  } catch (e) {
    if (recordingStream) recordingStream.getTracks().forEach(t => t.stop()); recordingStream = null; mediaRecorder = null;
    hideRecordingPanel(); alert('Microphone access was not allowed. Please allow microphone access in your browser.');
  }
}
function finishRecording(cancel = false) {
  if (cancel) { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); return; }
  stopAudioRecording();
}
function stopAudioRecording() { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); }

async function createGroup(e) { e.preventDefault(); const name = $('groupName').value.trim(); const ids = [...document.querySelectorAll('#groupUserList input:checked')].map(x => x.value); try { const d = await api('/api/chat/groups', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name,memberIds:ids})}); closeModal(); $('groupName').value=''; await loadConversations(); openRoom(d.conversation.id); } catch (e) { alert(e.message); } }
function showModal() { renderUsers(); $('newChatModal').classList.remove('hidden'); document.querySelector('[data-tab="direct"]').click(); }
function closeModal() { $('newChatModal').classList.add('hidden'); }
function closeRoom() { activeId=null; lastMessageId=null; clearPendingVoice(); $('chatRoom').classList.add('hidden'); $('chatWelcome').classList.remove('hidden'); document.querySelector('.chat-shell').classList.remove('room-open'); renderConversations(); }

function bind() {
  $('logout').onclick = async () => { await fetch('/api/logout', {method:'POST'}); location='/'; };
  $('newChatBtn').onclick = showModal; $('startChatBtn').onclick = showModal; $('closeChatModal').onclick = closeModal;
  $('userSearch').oninput = renderUsers; $('chatSearch').oninput = renderConversations; $('messageForm').onsubmit = sendMessage; $('groupPanel').onsubmit = createGroup; $('mobileBack').onclick = closeRoom;
  $('attachBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = async e => { const file = e.target.files?.[0]; e.target.value=''; if (file) await sendAttachment(file, $('messageInput').value.trim()); };
  $('recordAudioBtn').onclick = startAudioRecording;
  $('deleteVoiceBtn').onclick = clearPendingVoice;
  $('messageInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(e); } });
  document.querySelectorAll('.chat-tab').forEach(tab => tab.onclick = () => { document.querySelectorAll('.chat-tab').forEach(x => x.classList.remove('active')); tab.classList.add('active'); const group=tab.dataset.tab==='group'; $('directPanel').classList.toggle('hidden',group); $('groupPanel').classList.toggle('hidden',!group); });
  pollTimer = setInterval(async () => { if (document.hidden) return; try { await loadConversations(); if (activeId) await loadMessages(false); } catch {} }, 2500);
}
(async () => { await init(); })().catch(() => location='/login.html');
