const $ = (id) => document.getElementById(id);
let me = null, classes = [], liveRoom = null, localTracks = [], currentClass = null;
const status = (message, bad = false) => { $('liveStatus').textContent = message || ''; $('liveStatus').className = bad ? 'msg error' : 'msg'; };
async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function localDate(value) { try { return new Date(value).toLocaleString('en-NG', { dateStyle:'medium', timeStyle:'short' }); } catch { return ''; } }
async function load() {
  try {
    me = await api('/api/me');
    const role = me.user?.role || me.role;
    $('portalLink').href = role === 'admin' ? '/admin.html' : role === 'instructor' ? '/instructor.html' : '/student.html';
    if (role === 'admin' || role === 'instructor') {
      $('createPanel').hidden = false;
      const data = await api(role === 'admin' ? '/api/courses' : '/api/instructor/courses');
      const list = data.courses || [];
      $('courseId').innerHTML = list.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.title)}</option>`).join('');
      if (!list.length) $('createMsg').textContent = 'Create or obtain access to a course before scheduling a class.';
    }
    await loadClasses();
  } catch (e) { status(e.message, true); }
}
async function loadClasses() {
  const data = await api('/api/live-classes'); classes = data.classes || [];
  const role = me?.user?.role || me?.role;
  $('classList').innerHTML = classes.length ? classes.map(c => {
    const teacher = role === 'admin' || role === 'instructor';
    const mode = c.mode === 'built_in' ? 'Built-in video classroom' : 'External meeting';
    return `<article class="panel"><h3>${escapeHtml(c.title)}</h3><p>${escapeHtml(c.courseTitle)} · ${mode}</p><p>${escapeHtml(c.description)}</p><p><b>Starts:</b> ${escapeHtml(localDate(c.startsAt))}${c.endsAt ? ` · <b>Ends:</b> ${escapeHtml(localDate(c.endsAt))}` : ''}</p><p><b>Status:</b> ${escapeHtml(c.status)} ${c.recording ? '· <b>Recording available</b>' : ''}</p><div class="coding-actions">${c.mode === 'external' ? `<a class="btn" href="${escapeHtml(c.meetingUrl)}" target="_blank" rel="noopener noreferrer">Open meeting</a>` : `<button class="btn" data-join="${escapeHtml(c.id)}">Join classroom</button>`}${c.recording ? `<button class="ghost-btn" data-recording="${escapeHtml(c.id)}">Watch recording</button>` : ''}${teacher ? `<label class="ghost-btn">Upload recording<input type="file" accept="video/mp4,video/webm,video/quicktime" data-upload-recording="${escapeHtml(c.id)}" hidden></label><button class="ghost-btn" data-cancel="${escapeHtml(c.id)}">Cancel class</button>` : ''}</div></article>`;
  }).join('') : '<p>No live classes have been scheduled for your courses yet.</p>';
}
$('classMode').addEventListener('change', () => { $('meetingUrlWrap').hidden = $('classMode').value !== 'external'; $('meetingUrl').required = $('classMode').value === 'external'; });
$('createForm').addEventListener('submit', async e => {
  e.preventDefault(); $('createMsg').textContent = 'Saving…';
  try {
    const payload = { courseId:$('courseId').value, title:$('classTitle').value, description:$('classDescription').value, mode:$('classMode').value, meetingUrl:$('meetingUrl').value, startsAt:new Date($('startsAt').value).toISOString(), endsAt:$('endsAt').value ? new Date($('endsAt').value).toISOString() : '' };
    await api('/api/live-classes', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    $('createForm').reset(); $('createMsg').textContent = 'Class scheduled. Enrolled students have been notified.'; await loadClasses();
  } catch (err) { $('createMsg').textContent = err.message; }
});
$('refreshClasses').addEventListener('click', () => loadClasses().catch(e => status(e.message,true)));
$('classList').addEventListener('click', async e => {
  const join = e.target.closest('[data-join]')?.dataset.join;
  const recording = e.target.closest('[data-recording]')?.dataset.recording;
  const cancel = e.target.closest('[data-cancel]')?.dataset.cancel;
  if (join) return joinClass(join);
  if (recording) { try { const d = await api(`/api/live-classes/${recording}/recording`); window.open(d.url, '_blank', 'noopener'); } catch (err) { status(err.message,true); } }
  if (cancel && confirm('Cancel this class? Students will no longer be able to join.')) { try { await api(`/api/live-classes/${cancel}/cancel`, {method:'POST'}); await loadClasses(); } catch(err) { status(err.message,true); } }
});
$('classList').addEventListener('change', async e => {
  const id = e.target.dataset.uploadRecording; if (!id || !e.target.files?.[0]) return;
  const form = new FormData(); form.append('recording', e.target.files[0]);
  try { status('Uploading recording…'); await api(`/api/live-classes/${id}/recording`, {method:'POST', body:form}); status('Recording uploaded and made available to enrolled students.'); await loadClasses(); }
  catch(err) { status(err.message,true); } finally { e.target.value = ''; }
});
async function joinClass(id) {
  try {
    currentClass = classes.find(c => c.id === id);
    const data = await api(`/api/live-classes/${id}/join-token`, {method:'POST'});
    const { Room, RoomEvent, createLocalTracks } = await import('https://cdn.jsdelivr.net/npm/livekit-client@2.15.6/dist/livekit-client.esm.mjs');
    $('roomPanel').hidden = false; $('roomTitle').textContent = currentClass?.title || 'Live classroom'; $('roomInfo').textContent = 'Connecting securely…'; $('roomPanel').scrollIntoView({behavior:'smooth'});
    liveRoom = new Room({ adaptiveStream:true, dynacast:true });
    liveRoom.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      const element = track.attach(); element.dataset.participant = participant.identity; element.style.maxWidth='100%'; element.style.borderRadius='12px'; $('remoteVideos').appendChild(element);
    });
    liveRoom.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => { track.detach().forEach(el => el.remove()); });
    liveRoom.on(RoomEvent.Disconnected, () => { $('roomStatus').textContent = 'Disconnected from classroom.'; });
    await liveRoom.connect(data.serverUrl, data.token);
    localTracks = await createLocalTracks({ audio:true, video:{ facingMode:'user', resolution:{width:640,height:360} } });
    for (const track of localTracks) { await liveRoom.localParticipant.publishTrack(track); if (track.kind === 'video') track.attach($('localVideo')); }
    $('roomInfo').textContent = `Connected · ${data.role === 'host' ? 'Instructor / host' : 'Student'}`; $('roomStatus').textContent = 'You are connected. Use the controls to manage your microphone, camera and screen sharing.';
  } catch (err) { status(err.message || 'Could not join the built-in classroom.', true); await leaveRoom(); }
}
async function leaveRoom() { try { if (liveRoom) await liveRoom.disconnect(); } catch {} for (const t of localTracks) { try { t.stop(); } catch {} } localTracks=[]; liveRoom=null; $('localVideo').srcObject=null; $('remoteVideos').innerHTML=''; $('roomPanel').hidden=true; }
$('leaveRoom').addEventListener('click', leaveRoom);
$('micToggle').addEventListener('click', async () => { if (!liveRoom) return; const enabled = liveRoom.localParticipant.isMicrophoneEnabled; await liveRoom.localParticipant.setMicrophoneEnabled(!enabled); $('micToggle').textContent = enabled ? 'Unmute microphone' : 'Mute microphone'; });
$('cameraToggle').addEventListener('click', async () => { if (!liveRoom) return; const enabled = liveRoom.localParticipant.isCameraEnabled; await liveRoom.localParticipant.setCameraEnabled(!enabled); $('cameraToggle').textContent = enabled ? 'Turn camera on' : 'Turn camera off'; });
$('screenShare').addEventListener('click', async () => { if (!liveRoom) return; try { const enabled = liveRoom.localParticipant.isScreenShareEnabled; await liveRoom.localParticipant.setScreenShareEnabled(!enabled); $('screenShare').textContent = enabled ? 'Share screen' : 'Stop sharing'; } catch (e) { $('roomStatus').textContent = 'Screen sharing is unavailable or was cancelled.'; } });
$('logout').addEventListener('click', async () => { try { await api('/api/logout',{method:'POST'}); } finally { location.href='/login.html'; } });
load();
