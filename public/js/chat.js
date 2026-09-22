const $ = id => document.getElementById(id);
let conversations = [], users = [], activeId = null, lastMessageId = null, pollTimer = null, loading = false, myId = '';
let mediaRecorder = null, recordedChunks = [], recordingStream = null, recordingStartedAt = 0, recordingTimer = null;
let audioContext = null, audioSource = null, audioProcessor = null, recordedPcmChunks = [], recordingSampleRate = 44100;
let pendingVoiceFile = null, pendingVoiceUrl = null, pendingAttachmentFile = null, pendingAttachmentUrl = null, replyTarget = null;

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
    window.currentUserRole = me.user.role || 'student'; $('chatUser').textContent = me.user.name || '';
    $('backPortal').href = me.user.role === 'admin' ? '/admin.html' : '/student.html';
    await loadUsers();
    await loadConversations();
    bind();
  } catch (e) { alert(e.message); location = '/login.html'; }
}
async function loadUsers() { const d = await api('/api/chat/users'); users = d.users || []; renderUsers(); }
async function loadConversations(refreshActiveMessages = false) {
  const d = await api('/api/chat/conversations'); conversations = d.conversations || [];
  renderConversations();
  if (activeId) { const c = conversations.find(x => x.id === activeId); if (c) { updateHeader(c); if (refreshActiveMessages) await loadMessages(true); } else closeRoom(); }
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

function replyMarkup(r) {
  if (!r) return '';
  const label = r.deleted ? 'This message was deleted' : (r.text || (r.attachment ? ({image:'📷 Image', video:'🎥 Video', audio:'🎤 Audio', document:'📄 Document'}[attachmentKind(r.attachment)] || 'Attachment') : 'Message'));
  return `<button type="button" class="chat-reply-quote" data-jump-message="${esc(r.messageId)}"><span class="chat-reply-line"></span><span><b>${esc(r.senderName || 'WPS Academy User')}</b><small>${esc(label)}</small></span></button>`;
}
function attachmentKind(a) {
  if (!a) return null;
  const mime = String(a.mime || '').toLowerCase();
  const ext = String(a.name || '').toLowerCase().split('.').pop();
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  if (['mp3','wav','m4a','ogg','oga','opus','aac','flac','amr','aif','aiff','caf','mka'].includes(ext)) return 'audio';
  if (['mp4','mov','m4v','3gp','avi','mkv'].includes(ext)) return 'video';
  return a.kind || null;
}
function attachmentMarkup(a, messageId) {
  if (!a) return '';
  const kind = attachmentKind(a);
  const name = esc(a.name || 'Attachment');
  const contentUrl = `/api/chat/attachments/${encodeURIComponent(messageId)}/content`;
  if (kind === 'image') return `<a class="chat-media-link" href="${contentUrl}" target="_blank" rel="noopener"><img class="chat-image" src="${contentUrl}" alt="${name}" loading="lazy"></a>`;
  if (kind === 'video') { const mediaUrl = `/api/chat/attachments/${encodeURIComponent(messageId)}/media/video`; return `<video class="chat-video" controls preload="metadata" playsinline><source src="${mediaUrl}" type="video/mp4">Your browser could not play this chat video.</video>`; }
  if (kind === 'audio') { const mediaUrl = `/api/chat/attachments/${encodeURIComponent(messageId)}/media/audio`; const sourceType = 'audio/mpeg'; return `<div class="chat-audio-wrap"><audio class="chat-audio" controls preload="metadata"><source src="${mediaUrl}" type="${sourceType}">Your browser could not play this chat audio.</audio></div>`; }
  const downloadUrl = `/api/chat/attachments/${encodeURIComponent(messageId)}/download`;
  return `<a class="chat-file" href="${downloadUrl}" target="_blank" rel="noopener"><span class="chat-file-icon">📄</span><span><b>${name}</b><small>DOCX document • Tap to download</small></span></a>`;
}
function messageReceipt(m) {
  if (m.senderId !== myId) return '';
  return m.read ? '<span class="chat-receipt read" aria-label="Read">✓✓</span>' : '<span class="chat-receipt" aria-label="Sent">✓</span>';
}
function messageActions(m) {
  if (m.deleted) return '';
  const mine = m.senderId === myId;
  return `<div class="chat-message-actions"><button type="button" class="chat-action-btn" data-reply-message="${esc(m.id)}" title="Reply">↩ Reply</button>${mine || window.currentUserRole === 'admin' ? `<button type="button" class="chat-action-btn danger" data-delete-message="${esc(m.id)}" title="Delete message">🗑 Delete</button>` : ''}</div>`;
}
function appendMessage(m) {
  const existing = document.querySelector(`[data-message-id="${m.id}"]`);
  if (existing) {
    if (m.deleted && !existing.querySelector('.chat-deleted-message')) {
      const bubble = existing.querySelector('.chat-bubble');
      if (bubble) bubble.innerHTML = `<div class="chat-deleted-message">🚫 This message was deleted</div><span class="chat-time">${fmtTime(m.deletedAt || m.createdAt)}</span>`;
    }
    return;
  }
  const mine = m.senderId === myId, wrap = document.createElement('div');
  wrap.className = 'chat-bubble-wrap ' + (mine ? 'mine' : 'theirs'); wrap.dataset.messageId = m.id;
  const bubble = document.createElement('div'); bubble.className = 'chat-bubble';
  if (m.deleted) {
    bubble.innerHTML = `<div class="chat-deleted-message">🚫 This message was deleted</div><span class="chat-time">${fmtTime(m.deletedAt || m.createdAt)}</span>`;
  } else {
    bubble.innerHTML = `${!mine ? `<div class="chat-sender">${esc(m.senderName)}</div>` : ''}${replyMarkup(m.replyTo)}${m.text ? `<div class="chat-text">${esc(m.text)}</div>` : ''}${attachmentMarkup(m.attachment, m.id)}<span class="chat-time">${fmtTime(m.createdAt)}${messageReceipt(m)}</span>${messageActions(m)}`;
  }
  wrap.appendChild(bubble); $('messageList').appendChild(wrap);
  wrap.querySelectorAll('[data-reply-message]').forEach(btn => btn.onclick = () => beginReply(m));
  wrap.querySelectorAll('[data-delete-message]').forEach(btn => btn.onclick = () => deleteMessage(m.id));
  wrap.querySelectorAll('[data-jump-message]').forEach(btn => btn.onclick = () => jumpToMessage(btn.dataset.jumpMessage));
}
async function markRead() { if (activeId) try { await api(`/api/chat/conversations/${activeId}/read`, {method:'POST'}); } catch {} }

async function sendMessage(e) {
  e.preventDefault();
  if (!activeId) return;
  const input = $('messageInput'), text = input.value.trim();
  if (pendingVoiceFile) {
    const file = pendingVoiceFile;
    await sendAttachment(file, text, true);
    return;
  }
  if (pendingAttachmentFile) {
    const file = pendingAttachmentFile;
    await sendAttachment(file, text, false);
    return;
  }
  if (!text) return;
  input.disabled = true;
  try {
    const body = { text, replyToId: replyTarget?.id || null };
    const d = await api(`/api/chat/conversations/${activeId}/messages`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    appendMessage(d.message); lastMessageId = d.message.id; input.value = ''; clearReplyTarget(); updateSendButton(); $('messageList').scrollTop = $('messageList').scrollHeight; await loadConversations(false);
  } catch (e) { alert(e.message); }
  finally { input.disabled = false; input.focus(); }
}
async function sendAttachment(file, caption = '', isVoice = false) {
  if (!activeId || !file) return;
  const form = new FormData(); form.append('file', file); if (caption) form.append('text', caption); if (replyTarget?.id) form.append('replyToId', replyTarget.id);
  setComposerBusy(true);
  try {
    const d = await api(`/api/chat/conversations/${activeId}/attachments`, {method:'POST', body:form});
    appendMessage(d.message); lastMessageId = d.message.id; $('messageInput').value = ''; if (isVoice) { pendingVoiceFile = null; hideVoicePreview(); } else { clearPendingAttachment(); } clearReplyTarget(); updateSendButton(); $('messageList').scrollTop = $('messageList').scrollHeight; await loadConversations(false);
  } catch (e) { alert(e.message); }
  finally { setComposerBusy(false); }
}
function beginReply(m) {
  if (!m || m.deleted) return;
  replyTarget = { id: m.id, senderName: m.senderName, text: m.text || '', attachment: m.attachment || null };
  renderReplyBar();
  $('messageInput').focus();
  $('messageInput').scrollIntoView({ block: 'nearest' });
}
function renderReplyBar() {
  let bar = document.getElementById('chatReplyBar');
  if (!replyTarget) { if (bar) bar.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'chatReplyBar'; bar.className = 'chat-reply-bar'; $('messageForm').prepend(bar); }
  const label = replyTarget.text || (replyTarget.attachment ? ({image:'📷 Image',video:'🎥 Video',audio:'🎤 Audio',document:'📄 Document'}[attachmentKind(replyTarget.attachment)] || 'Attachment') : 'Message');
  bar.innerHTML = `<div class="chat-reply-bar-content"><span class="chat-reply-line"></span><div><b>Replying to ${esc(replyTarget.senderName || 'WPS Academy User')}</b><small>${esc(label)}</small></div></div><button type="button" id="cancelReplyBtn" class="chat-cancel-reply" title="Cancel reply">×</button>`;
  bar.querySelector('#cancelReplyBtn').onclick = clearReplyTarget;
}
function clearReplyTarget() { replyTarget = null; const bar = document.getElementById('chatReplyBar'); if (bar) bar.remove(); }
function jumpToMessage(id) {
  const el = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior:'smooth', block:'center' });
  el.classList.add('chat-message-highlight');
  setTimeout(() => el.classList.remove('chat-message-highlight'), 1400);
}
async function deleteMessage(id) {
  if (!activeId || !id) return;
  if (!confirm('Delete this message?')) return;
  try {
    await api(`/api/chat/conversations/${encodeURIComponent(activeId)}/messages/${encodeURIComponent(id)}`, {method:'DELETE'});
    const el = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
    if (el) {
      const bubble = el.querySelector('.chat-bubble');
      if (bubble) bubble.innerHTML = `<div class="chat-deleted-message">🚫 This message was deleted</div><span class="chat-time">Just now</span>`;
    }
    if (replyTarget?.id === id) clearReplyTarget();
    await loadConversations();
  } catch (e) { alert(e.message); }
}
function updateSendButton() {
  const hasContent = !!($('messageInput')?.value.trim() || pendingAttachmentFile || pendingVoiceFile);
  if (!$('chatSend').disabled || hasContent) $('chatSend').disabled = !hasContent;
}

function setComposerBusy(busy) { $('messageInput').disabled = busy; $('attachBtn').disabled = busy; $('recordAudioBtn').disabled = busy || !!audioProcessor || !!mediaRecorder; $('chatSend').disabled = busy; }

function clearPendingAttachment() {
  pendingAttachmentFile = null;
  if (pendingAttachmentUrl) { URL.revokeObjectURL(pendingAttachmentUrl); pendingAttachmentUrl = null; }
  $('attachmentPreview')?.classList.add('hidden');
  const media = $('attachmentPreviewMedia'); if (media) { media.pause?.(); media.removeAttribute('src'); media.innerHTML = ''; }
  if ($('attachmentPreviewName')) $('attachmentPreviewName').textContent = '';
  if ($('attachmentPreviewMeta')) $('attachmentPreviewMeta').textContent = '';
  if ($('fileInput')) $('fileInput').value = '';
  const hasText = !!$('messageInput')?.value.trim();
  $('chatSend').disabled = !hasText && !pendingVoiceFile;
}
function showAttachmentPreview(file) {
  clearPendingAttachment();
  if (!file) return;
  if (pendingVoiceFile) clearPendingVoice();
  const type = String(file.type || '').toLowerCase();
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const isImage = type.startsWith('image/') || /^(jpg|jpeg|png|gif|webp|bmp|heic|heif)$/.test(ext);
  // .webm is used by both video and voice recording. The browser MIME type
  // must decide which player to show; never classify audio/webm as video.
  const definiteVideo = /^(mp4|mov|m4v|avi|mkv)$/.test(ext);
  const definiteAudio = /^(mp3|wav|m4a|ogg|oga|opus|aac|flac|amr|aif|aiff|caf|mka)$/.test(ext);
  const isVideo = type.startsWith('video/') || definiteVideo || (ext === 'webm' && type === '');
  const isAudio = type.startsWith('audio/') || definiteAudio || (ext === 'webm' && type === 'audio/webm');
  const isDoc = ext === 'docx';
  pendingAttachmentFile = file;
  const media = $('attachmentPreviewMedia');
  if (!media) return;
  $('attachmentPreviewName').textContent = file.name;
  $('attachmentPreviewMeta').textContent = `${isVideo ? 'Video' : isAudio ? 'Audio' : isImage ? 'Photo' : isDoc ? 'Document' : 'File'} • ${formatBytes(file.size)}`;
  media.innerHTML = '';
  pendingAttachmentUrl = URL.createObjectURL(file);
  if (isImage) {
    const img = document.createElement('img');
    img.src = pendingAttachmentUrl; img.className = 'chat-attachment-preview-image'; img.alt = file.name;
    media.appendChild(img);
  } else if (isVideo) {
    const video = document.createElement('video');
    video.src = pendingAttachmentUrl; video.className = 'chat-attachment-preview-video';
    video.controls = true; video.playsInline = true; video.preload = 'metadata';
    media.appendChild(video);
  } else if (isAudio) {
    const audio = document.createElement('audio');
    audio.src = pendingAttachmentUrl; audio.className = 'chat-attachment-preview-audio';
    audio.controls = true; audio.preload = 'metadata';
    media.appendChild(audio);
  } else {
    media.innerHTML = `<div class="chat-selected-file"><span class="chat-file-preview-icon">📄</span><span><b>${isDoc ? 'DOCX document ready' : 'File ready'}</b><small>You can add a caption before sending.</small></span></div>`;
  }
  $('attachmentPreview').classList.remove('hidden');
  $('chatSend').disabled = false;
  $('messageInput').focus();
}

function formatBytes(bytes) { const n=Number(bytes||0); if(n<1024)return `${n} B`; if(n<1048576)return `${(n/1024).toFixed(1)} KB`; if(n<1073741824)return `${(n/1048576).toFixed(1)} MB`; return `${(n/1073741824).toFixed(1)} GB`; }
function formatDuration(seconds) { const s = Math.max(0, Math.floor(seconds)); return `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`; }
function updateRecordingTimer() { if (!recordingStartedAt) return; $('recordingTime').textContent = formatDuration((Date.now() - recordingStartedAt) / 1000); }
function showRecordingPanel() { $('recordingPanel').classList.remove('hidden'); }
function hideRecordingPanel() { $('recordingPanel').classList.add('hidden'); }
function hideVoicePreview() {
  if (pendingVoiceUrl) { URL.revokeObjectURL(pendingVoiceUrl); pendingVoiceUrl = null; }
  $('voicePreview').classList.add('hidden'); $('voicePreviewAudio').removeAttribute('src'); $('voicePreviewAudio').load(); $('recordingPanel').classList.add('hidden');
  $('recordAudioBtn').textContent = '🎙️'; $('recordAudioBtn').title = 'Record audio'; $('recordingStatus').textContent = 'Record a voice message'; $('recordingTime').textContent = '00:00';
}
function clearPendingVoice() { pendingVoiceFile = null; hideVoicePreview(); const hasText = !!$('messageInput')?.value.trim(); $('chatSend').disabled = !hasText && !pendingAttachmentFile; $('messageInput').focus(); }
function mergePcm(chunks) {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const result = new Float32Array(length); let offset = 0;
  for (const c of chunks) { result.set(c, offset); offset += c.length; }
  return result;
}
function downsampleMono(samples, fromRate, toRate = 16000) {
  if (!samples?.length || !fromRate || fromRate <= toRate) return samples;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.floor(samples.length / ratio));
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    output[i] = sum / (end - start);
  }
  return output;
}
function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const write = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, samples.length * 2, true);
  let pos = 44;
  for (let i = 0; i < samples.length; i++, pos += 2) { const x = Math.max(-1, Math.min(1, samples[i])); view.setInt16(pos, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
  return new Blob([view], { type: 'audio/wav' });
}
async function finishPcmRecording() {
  const samples = mergePcm(recordedPcmChunks); recordedPcmChunks = [];
  if (audioProcessor) { audioProcessor.onaudioprocess = null; try { audioProcessor.disconnect(); } catch {} audioProcessor = null; }
  if (audioSource) { try { audioSource.disconnect(); } catch {} audioSource = null; }
  if (recordingStream) { recordingStream.getTracks().forEach(t => t.stop()); recordingStream = null; }
  if (audioContext) { try { await audioContext.close(); } catch {} audioContext = null; }
  clearInterval(recordingTimer); recordingTimer = null; recordingStartedAt = 0;
  $('recordAudioBtn').textContent = '🎙️'; $('recordAudioBtn').title = 'Record audio';
  if (!samples.length) { hideRecordingPanel(); return; }
  // Downsample speech to 16 kHz mono before encoding. This greatly reduces
  // upload size on phones while retaining clear speech quality.
  const voiceSamples = downsampleMono(samples, recordingSampleRate, 16000);
  const blob = encodeWav(voiceSamples, 16000);
  setVoiceRecordingBlob(blob, `voice-message-${Date.now()}.wav`);
}
async function audioBlobToWav(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('Audio decoding is not supported by this browser.');
  const ctx = new Ctx();
  try {
    const buffer = await blob.arrayBuffer();
    const decoded = await ctx.decodeAudioData(buffer.slice(0));
    const length = decoded.length;
    const mono = new Float32Array(length);
    const channels = decoded.numberOfChannels || 1;
    for (let ch = 0; ch < channels; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < length; i++) mono[i] += data[i] / channels;
    }
    return encodeWav(mono, decoded.sampleRate);
  } finally {
    try { await ctx.close(); } catch {}
  }
}
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not prepare audio preview.'));
    reader.readAsDataURL(blob);
  });
}
async function setVoiceRecordingBlob(blob, filename) {
  try {
    if (!blob || !blob.size) throw new Error('The recording is empty.');
    pendingVoiceFile = new File([blob], filename, { type: blob.type || 'audio/webm' });
    if (pendingVoiceUrl) { try { URL.revokeObjectURL(pendingVoiceUrl); } catch {} pendingVoiceUrl = null; }
    $('voicePreview').classList.remove('hidden');
    pendingVoiceUrl = URL.createObjectURL(pendingVoiceFile);
    const voiceAudio = $('voicePreviewAudio');
    voiceAudio.src = pendingVoiceUrl;
    voiceAudio.classList.remove('hidden');
    voiceAudio.load();
    $('recordingPanel').classList.remove('hidden');
    $('recordingStatus').textContent = 'Voice note ready to send';
    $('recordAudioBtn').textContent = '🎙️';
    $('recordAudioBtn').title = 'Record audio';
    $('chatSend').disabled = false;
  } catch (e) {
    console.error('Voice recording preparation failed:', e);
    pendingVoiceFile = null;
    hideRecordingPanel();
    alert('The voice recording could not be prepared. Please record again.');
  }
}

function chooseRecordingMime() {
  if (!window.MediaRecorder?.isTypeSupported) return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return candidates.find(x => MediaRecorder.isTypeSupported(x)) || '';
}
async function startAudioRecording() {
  if (audioProcessor || mediaRecorder) { stopAudioRecording(); return; }
  if (pendingVoiceFile) { clearPendingVoice(); return; }
  if (!navigator.mediaDevices?.getUserMedia) {
    alert('Audio recording is not supported by this browser.');
    return;
  }

  try {
    // Voice notes use PCM -> WAV only.  Do not use MediaRecorder/webm here:
    // Android Chrome commonly produces audio/webm, and that container can be
    // confused with video elsewhere in the chat media pipeline.
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('Audio recording is not supported by this browser.');

    recordingStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });

    audioContext = new Ctx();
    await audioContext.resume();
    recordingSampleRate = audioContext.sampleRate;
    audioSource = audioContext.createMediaStreamSource(recordingStream);
    audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    recordedPcmChunks = [];

    audioProcessor.onaudioprocess = e => {
      if (audioProcessor) recordedPcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };

    audioSource.connect(audioProcessor);
    audioProcessor.connect(silentGain);
    silentGain.connect(audioContext.destination);

    recordingStartedAt = Date.now();
    updateRecordingTimer();
    showRecordingPanel();
    $('recordingStatus').textContent = 'Recording… tap ■ to stop';
    $('recordAudioBtn').textContent = '⏹️';
    $('recordAudioBtn').title = 'Stop recording';
    $('chatSend').disabled = true;
    recordingTimer = setInterval(updateRecordingTimer, 250);
  } catch (e) {
    console.error('Voice recording failed:', e);
    if (recordingStream) recordingStream.getTracks().forEach(t => t.stop());
    recordingStream = null;
    if (audioSource) { try { audioSource.disconnect(); } catch {} }
    if (audioProcessor) { try { audioProcessor.disconnect(); } catch {} }
    audioSource = null;
    audioProcessor = null;
    if (audioContext) { try { await audioContext.close(); } catch {} }
    audioContext = null;
    recordedPcmChunks = [];
    clearInterval(recordingTimer); recordingTimer = null; recordingStartedAt = 0;
    hideRecordingPanel();
    alert('Microphone access was not allowed. Please allow microphone access in your browser.');
  }
}
function stopAudioRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') { mediaRecorder.stop(); return; }
  if (audioProcessor) { finishPcmRecording(); return; }
}

async function createGroup(e) { e.preventDefault(); const name = $('groupName').value.trim(); const ids = [...document.querySelectorAll('#groupUserList input:checked')].map(x => x.value); try { const d = await api('/api/chat/groups', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name,memberIds:ids})}); closeModal(); $('groupName').value=''; await loadConversations(); openRoom(d.conversation.id); } catch (e) { alert(e.message); } }
function showModal() { renderUsers(); $('newChatModal').classList.remove('hidden'); document.querySelector('[data-tab="direct"]').click(); }
function closeModal() { $('newChatModal').classList.add('hidden'); }
function closeRoom() { activeId=null; lastMessageId=null; clearPendingVoice(); clearPendingAttachment(); $('chatRoom').classList.add('hidden'); $('chatWelcome').classList.remove('hidden'); document.querySelector('.chat-shell').classList.remove('room-open'); renderConversations(); }

function bind() {
  $('logout').onclick = async () => { await fetch('/api/logout', {method:'POST'}); location='/'; };
  $('newChatBtn').onclick = showModal; $('startChatBtn').onclick = showModal; $('closeChatModal').onclick = closeModal;
  $('userSearch').oninput = renderUsers; $('chatSearch').oninput = renderConversations; $('messageForm').onsubmit = sendMessage; $('groupPanel').onsubmit = createGroup; $('mobileBack').onclick = closeRoom;
  $('attachBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = e => { const file = e.target.files?.[0]; if (file) showAttachmentPreview(file); };
  $('cancelAttachmentBtn').onclick = clearPendingAttachment;
  $('recordAudioBtn').onclick = startAudioRecording;
  $('deleteVoiceBtn').onclick = clearPendingVoice;
  $('messageInput').addEventListener('input', updateSendButton); $('messageInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(e); } });
  document.querySelectorAll('.chat-tab').forEach(tab => tab.onclick = () => { document.querySelectorAll('.chat-tab').forEach(x => x.classList.remove('active')); tab.classList.add('active'); const group=tab.dataset.tab==='group'; $('directPanel').classList.toggle('hidden',group); $('groupPanel').classList.toggle('hidden',!group); });
  pollTimer = setInterval(async () => { if (document.hidden) return; try { await loadConversations(false); if (activeId) await loadMessages(false); } catch {} }, 2500);
}
(async () => { await init(); })().catch(() => location='/login.html');
