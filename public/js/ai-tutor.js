let conversationId = null;
let selectedFile = null;
let recognition = null;

const messages = document.getElementById('messages');
const input = document.getElementById('messageInput');
const form = document.getElementById('chatForm');
const sendBtn = document.getElementById('sendBtn');
const fileInput = document.getElementById('fileInput');
const attachmentPreview = document.getElementById('attachmentPreview');

function escapeHtml(text){
  return String(text).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
function renderMarkdown(text){
  let x=escapeHtml(text);
  x=x.replace(/```([\s\S]*?)```/g,'<pre><code>$1</code></pre>');
  x=x.replace(/`([^`]+)`/g,'<code>$1</code>');
  x=x.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  x=x.replace(/^### (.*)$/gm,'<h3>$1</h3>');
  x=x.replace(/^## (.*)$/gm,'<h2>$1</h2>');
  x=x.replace(/^# (.*)$/gm,'<h2>$1</h2>');
  x=x.replace(/\n/g,'<br>');
  return x;
}
function addMessage(role,text,temporary=false){
  const el=document.createElement('div'); el.className=`ai-message ${role}${temporary?' temporary':''}`;
  el.innerHTML=`<div class="ai-msg-avatar">${role==='user'?'👤':'🤖'}</div><div class="ai-msg-body"><div class="ai-msg-name">${role==='user'?'You':'WPS AI Tutor'}</div><div class="ai-msg-text">${role==='user'?escapeHtml(text):renderMarkdown(text)}</div></div>`;
  messages.appendChild(el); messages.scrollTop=messages.scrollHeight; return el;
}
function showWelcome(){
  messages.innerHTML=`<div class="ai-welcome panel"><div class="ai-avatar">🤖</div><h2>How can I help you learn?</h2><p>Ask me to explain a topic, review an assignment, create a quiz, or help you understand your WPS Academy lessons.</p><div class="suggestions"><button data-prompt="Explain JavaScript variables to me like I am a beginner.">Explain a topic</button><button data-prompt="Create a 10-question quiz for me on web development.">Create a quiz</button><button data-prompt="What assignments do I currently have?">My assignments</button><button data-prompt="What should I study next in WPS Academy?">What should I study next?</button></div></div>`;
  bindSuggestions();
}
function bindSuggestions(){document.querySelectorAll('[data-prompt]').forEach(b=>b.onclick=()=>{input.value=b.dataset.prompt;input.focus();});}
async function api(url,opts={}){const r=await fetch(url,opts);let d={};try{d=await r.json()}catch{};if(!r.ok)throw new Error(d.error||'Request failed');return d}
async function loadConversations(){
  const d=await api('/api/ai/conversations'); const list=document.getElementById('conversationList'); list.innerHTML='';
  if(!d.conversations.length){list.innerHTML='<div class="empty-conversations">No conversations yet.</div>';return;}
  d.conversations.forEach(c=>{const row=document.createElement('div');row.className='conversation-row'+(c.id===conversationId?' active':'');row.innerHTML=`<button>${escapeHtml(c.title)}</button><button class="delete-chat" title="Delete">×</button>`;row.querySelector('button').onclick=()=>loadConversation(c.id);row.querySelector('.delete-chat').onclick=async e=>{e.stopPropagation();if(confirm('Delete this conversation?')){await api('/api/ai/conversations/'+c.id,{method:'DELETE'});if(c.id===conversationId){conversationId=null;showWelcome()}loadConversations()}};list.appendChild(row)});
}
async function loadConversation(id){const d=await api('/api/ai/conversations/'+id);conversationId=id;messages.innerHTML='';(d.conversation.messages||[]).forEach(m=>addMessage(m.role,m.content));loadConversations();}
function setAttachment(file){selectedFile=file||null;if(!file){attachmentPreview.classList.add('hidden');attachmentPreview.innerHTML='';return;}attachmentPreview.classList.remove('hidden');attachmentPreview.innerHTML=`<span>📎 ${escapeHtml(file.name)}</span><button type="button" id="removeAttachment">×</button>`;document.getElementById('removeAttachment').onclick=()=>{fileInput.value='';setAttachment(null)}}
fileInput.onchange=()=>setAttachment(fileInput.files[0]);
document.getElementById('clearBtn').onclick=()=>{input.value='';fileInput.value='';setAttachment(null);input.focus()};
document.getElementById('newChat').onclick=()=>{conversationId=null;showWelcome();input.value='';fileInput.value='';setAttachment(null);loadConversations();input.focus()};
document.getElementById('logout').onclick=async()=>{await fetch('/api/logout',{method:'POST'});location='/'};

form.onsubmit=async e=>{
  e.preventDefault(); const text=input.value.trim(); if(!text&&!selectedFile)return;
  const sentText=text||`Please analyze the attached file: ${selectedFile.name}`;
  addMessage('user',sentText); input.value=''; sendBtn.disabled=true; sendBtn.textContent='Thinking...';
  const thinking=addMessage('assistant','Thinking…',true);
  const fd=new FormData();fd.append('message',text);if(conversationId)fd.append('conversationId',conversationId);if(selectedFile)fd.append('file',selectedFile);
  try{const d=await api('/api/ai/chat',{method:'POST',body:fd});thinking.remove();addMessage('assistant',d.message.content);conversationId=d.conversationId;loadConversations();}
  catch(err){thinking.remove();addMessage('assistant','Sorry, I could not complete that request. '+err.message)}
  finally{sendBtn.disabled=false;sendBtn.textContent='Send ➤';fileInput.value='';setAttachment(null);input.focus()}
};
input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();form.requestSubmit()}});

document.getElementById('voiceBtn').onclick=()=>{
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){alert('Voice input is not supported by this browser. You can still type your question.');return;}
  if(recognition){recognition.stop();recognition=null;return;}
  recognition=new SR();recognition.lang=navigator.language||'en-US';recognition.interimResults=false;recognition.continuous=false;
  recognition.onresult=e=>{input.value=(input.value+' '+e.results[0][0].transcript).trim();input.focus()};recognition.onend=()=>recognition=null;recognition.start();
};

async function init(){
 try{const me=await api('/api/me');if(!me.user){location='/login.html';return;}document.getElementById('welcome').textContent=`Welcome, ${me.user.name}. Ask questions, study lessons, and practice with your AI Tutor.`;const s=await api('/api/ai/status');document.getElementById('statusText').textContent=s.enabled?`Online • ${s.model}`:'Not configured';document.getElementById('statusDot').style.color=s.enabled?'#0a9b4a':'#c33';await loadConversations();bindSuggestions();}
 catch(e){document.getElementById('statusText').textContent=e.message;}
}
init();


const toolModal=document.getElementById('toolModal'), toolContent=document.getElementById('toolContent');
function openTool(html){toolContent.innerHTML=html;toolModal.classList.remove('hidden')}
function closeTool(){toolModal.classList.add('hidden')}
document.getElementById('closeTool').onclick=closeTool; toolModal.onclick=e=>{if(e.target===toolModal)closeTool()};

document.getElementById('quizTool').onclick=()=>openTool(`<h2>📝 Practice Quiz</h2><p>Create a quiz from your WPS Academy topics.</p><label>Topic<input id="quizTopic" value="Web Development"></label><label>Difficulty<select id="quizDifficulty"><option>beginner</option><option>intermediate</option><option>advanced</option></select></label><label>Questions<select id="quizCount"><option>5</option><option selected>10</option><option>15</option><option>20</option></select></label><button id="makeQuiz" class="btn">Generate Quiz</button><div id="quizArea"></div>`);
document.getElementById('planTool').onclick=()=>openTool(`<h2>🗓️ Personal Study Plan</h2><p>Let WPS AI create a practical plan based on your progress.</p><label>Goal<textarea id="planGoal">Improve my web development skills and complete my current lessons.</textarea></label><label>Days<select id="planDays"><option>7</option><option>14</option><option>21</option><option>30</option></select></label><button id="makePlan" class="btn">Create Study Plan</button><div id="planArea"></div>`);

toolContent.addEventListener('click',async e=>{
 if(e.target.id==='makeQuiz'){
  const area=document.getElementById('quizArea');area.innerHTML='<p>Generating your quiz…</p>';e.target.disabled=true;
  try{const d=await api('/api/ai/quiz',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic:document.getElementById('quizTopic').value,count:Number(document.getElementById('quizCount').value),difficulty:document.getElementById('quizDifficulty').value})});
   const q=d.quiz;area.innerHTML=`<h3>${escapeHtml(q.title||'Practice Quiz')}</h3><form id="quizForm">${q.questions.map((x,i)=>`<div class="quiz-q"><b>${i+1}. ${escapeHtml(x.question)}</b>${x.options.map((o,j)=>`<label class="quiz-option"><input type="radio" name="q${i}" value="${j}"> ${escapeHtml(o)}</label>`).join('')}</div>`).join('')}<button class="btn">Submit Quiz</button></form>`;
   document.getElementById('quizForm').onsubmit=async ev=>{ev.preventDefault();const answers=q.questions.map((_,i)=>{const x=document.querySelector(`input[name=q${i}]:checked`);return x?Number(x.value):-1});try{const r=await api('/api/learning/quizzes/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:q.title,questions:q.questions,answers})});area.innerHTML=`<div class="panel"><h3>Score: ${r.score}/${r.total} (${r.percent}%)</h3><p>${r.percent>=80?'Excellent work! 🎉':r.percent>=60?'Good work. Review the missed topics and try again.':'Keep practicing. Your AI Tutor can explain the difficult topics.'}</p></div>`}catch(err){alert(err.message)}};
  }catch(err){area.innerHTML='<p>'+escapeHtml(err.message)+'</p>'}finally{e.target.disabled=false}
 }
 if(e.target.id==='makePlan'){
  const area=document.getElementById('planArea');area.innerHTML='<p>Building your plan…</p>';e.target.disabled=true;
  try{const d=await api('/api/ai/study-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({goal:document.getElementById('planGoal').value,days:Number(document.getElementById('planDays').value)})});area.innerHTML=`<div class="plan-output">${renderMarkdown(d.plan)}</div>`}catch(err){area.innerHTML='<p>'+escapeHtml(err.message)+'</p>'}finally{e.target.disabled=false}
 }
});

const initialMode=new URLSearchParams(location.search).get('mode');
if(initialMode==='quiz')document.getElementById('quizTool').click();
if(initialMode==='plan')document.getElementById('planTool').click();
