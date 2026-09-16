let recognition=null, running=false, busy=false, audioSource=null, audioCtx=null;
const statusEl=document.getElementById('liveStatus'), transcript=document.getElementById('liveTranscript'), orb=document.getElementById('liveOrb');
function api(url,opts={}){return fetch(url,opts).then(async r=>{let d={};try{d=await r.json()}catch{};if(!r.ok)throw new Error(d.error||'Request failed');return d;});}
function setState(text, cls=''){statusEl.textContent=text;orb.className='live-orb '+cls;}
async function unlockAudio(){
  if(!audioCtx){const C=window.AudioContext||window.webkitAudioContext;if(C)audioCtx=new C();}
  if(audioCtx&&audioCtx.state==='suspended')await audioCtx.resume();
}
async function playSpeech(text){
  await unlockAudio();
  const r=await fetch('/api/ai/speech',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:String(text).replace(/[*_`#>\[\]()]/g,'').slice(0,4096)})});
  if(!r.ok){let msg='Voice generation failed.';try{const d=await r.json();msg=d.error||msg}catch{}throw new Error(msg);}
  const data=await r.arrayBuffer();
  if(audioCtx){
    const decoded=await audioCtx.decodeAudioData(data.slice(0));
    if(audioSource){try{audioSource.stop()}catch{}audioSource=null;}
    const source=audioCtx.createBufferSource();source.buffer=decoded;source.connect(audioCtx.destination);audioSource=source;
    await new Promise((resolve,reject)=>{source.onended=()=>{if(audioSource===source)audioSource=null;resolve()};try{source.start()}catch(e){reject(e)}});
    return;
  }
  const blob=new Blob([data],{type:'audio/mpeg'});const url=URL.createObjectURL(blob);const a=new Audio(url);
  try{await a.play();await new Promise(resolve=>{a.onended=resolve;a.onerror=resolve})}finally{URL.revokeObjectURL(url)}
}
async function ask(text){
 busy=true;setState('Thinking…','thinking');transcript.innerHTML=`<b>You:</b> ${escapeHtml(text)}<br><br><b>WPS AI:</b> Thinking…`;
 try{const fd=new FormData();fd.append('message',text);const d=await api('/api/ai/chat',{method:'POST',body:fd});const answer=d.message.content;transcript.innerHTML=`<b>You:</b> ${escapeHtml(text)}<br><br><b>WPS AI:</b> ${escapeHtml(answer).replace(/\n/g,'<br>')}`;setState('Speaking…','speaking');await playSpeech(answer);}
 catch(e){transcript.innerHTML=`<b>Error:</b> ${escapeHtml(e.message)}`;setState('Error');}
 busy=false;if(running)startListening();
}
function startListening(){
 if(!running||busy)return;const SR=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SR){setState('Your browser does not support live speech recognition.');return;}
 recognition=new SR();recognition.lang='en-US';recognition.interimResults=false;recognition.continuous=false;
 recognition.onstart=()=>setState('Listening…','listening');
 recognition.onresult=e=>{const text=e.results[0][0].transcript.trim();if(text)ask(text)};
 recognition.onerror=e=>{if(running&&!busy){setState('Microphone issue: '+e.error);setTimeout(startListening,1000)}};
 recognition.onend=()=>{recognition=null;if(running&&!busy)setTimeout(startListening,250)};
 try{recognition.start()}catch{}
}
function stop(){running=false;if(recognition){try{recognition.stop()}catch{}recognition=null}if(audioSource){try{audioSource.stop()}catch{}audioSource=null}if(audioCtx){try{audioCtx.suspend()}catch{}}speechSynthesis?.cancel();setState('Stopped');document.getElementById('startLive').disabled=false;document.getElementById('stopLive').disabled=true;}
document.getElementById('startLive').onclick=async()=>{if(running)return;running=true;document.getElementById('startLive').disabled=true;document.getElementById('stopLive').disabled=false;try{await unlockAudio()}catch{}const topic=document.getElementById('liveTopic').value.trim();if(topic)ask(topic);else startListening();};
document.getElementById('stopLive').onclick=stop;
document.getElementById('logout').onclick=async()=>{stop();await fetch('/api/logout',{method:'POST'});location='/'};
function escapeHtml(t){return String(t).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
(async()=>{try{const d=await api('/api/me');if(!d.user)location='/login.html';}catch{location='/login.html';}})();
