(() => {
const $=s=>document.querySelector(s);
const target=$('#target'), input=$('#typingInput'), msg=$('#message');
const words=[
"asdf jkl; asdf jkl;","sad lad ask flask;","read red desk deal","fast task safe fall",
"qwerty poiuy asdf jkl;","type with both hands","keep your eyes on the screen",
"practice builds keyboard muscle memory","smarttep academy helps learners grow",
"accuracy first then speed","do not look down at the keyboard",
"professional typing requires rhythm focus and consistency",
"the quick brown fox jumps over the lazy dog",
"learning to type without looking makes digital work faster"
];
const levels=Array.from({length:12},(_,i)=>i+1);
let state={mode:'training',text:'',started:0,errors:0,correct:0,finished:false,score:0,level:1,xp:0,keyErrors:{}};
let progress={bestWpm:0,bestAccuracy:0,bestScore:0,totalSessions:0,totalSeconds:0,streak:0,level:1,xp:0,weakestKeys:[]};
let local=JSON.parse(localStorage.getItem('smartTypingVilla')||'null'); if(local) progress={...progress,...local};

function saveLocal(){localStorage.setItem('smartTypingVilla',JSON.stringify(progress));}
function renderTarget(){
 target.innerHTML=[...state.text].map((c,i)=>`<span class="${i<input.value.length?(input.value[i]===c?'done':'bad'):i===input.value.length?'current':''}">${c===' '?'&nbsp;':c.replace(/&/g,'&amp;')}</span>`).join('');
}
function pickText(){state.text=words[Math.min(words.length-1,Math.floor((state.level-1)*1.2))];input.value='';renderTarget();}
function updateStats(){
 const elapsed=state.started?Math.max(.2,(Date.now()-state.started)/60000):0;
 const chars=Math.max(1,input.value.length);
 const wpm=Math.round((state.correct/5)/elapsed)||0;
 const acc=Math.round((state.correct/Math.max(1,state.correct+state.errors))*100);
 $('#wpm').textContent=wpm; $('#accuracy').textContent=acc+'%'; $('#score').textContent=Math.round(state.score);
 $('#level').textContent=state.level; $('#xp').textContent=state.xp;
 return {wpm,acc,elapsed};
}
function showProgress(){
 $('#bestWpm').textContent=progress.bestWpm; $('#bestAccuracy').textContent=Math.round(progress.bestAccuracy)+'%';
 $('#sessions').textContent=progress.totalSessions; $('#practiceTime').textContent=Math.round(progress.totalSeconds/60)+' min';
 $('#streak').textContent=progress.streak; $('#courseProgress').style.width=Math.min(100,(progress.level/12)*100)+'%';
 $('#courseLabel').textContent=`Level ${progress.level} of 12`;
 const weak=(progress.weakestKeys||[]).slice(0,5);
 $('#coach').textContent=weak.length?`Focus on: ${weak.join('  ')}. Slow down and repeat those keys.`:'Start a session to identify keys that need more practice.';
}
function buildKeys(){
 const chars='qwertyuiopasdfghjkl;zxcvbnm,./1234567890';
 $('#keygrid').innerHTML=[...chars].map(c=>`<span data-key="${c}">${c}</span>`).join('');
}
function finish(){
 if(state.finished)return; state.finished=true;
 const {wpm,acc,elapsed}=updateStats(); const seconds=Math.round(elapsed*60);
 progress.bestWpm=Math.max(progress.bestWpm,wpm); progress.bestAccuracy=Math.max(progress.bestAccuracy,acc);
 progress.bestScore=Math.max(progress.bestScore,Math.round(state.score)); progress.totalSessions++;
 progress.totalSeconds+=seconds; progress.streak=Math.max(progress.streak,1);
 progress.level=Math.max(progress.level,state.level); progress.xp=Math.max(progress.xp,state.xp);
 const weak=Object.entries(state.keyErrors).sort((a,b)=>b[1]-a[1]).map(x=>x[0]).slice(0,8); if(weak.length)progress.weakestKeys=weak;
 saveLocal(); showProgress();
 fetch('/api/typing/progress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wpm,accuracy:acc,score:state.score,seconds,correct:state.correct,errors:state.errors,level:state.level,xp:state.xp,mode:state.mode,weakestKeys:progress.weakestKeys})}).catch(()=>{});
 msg.textContent=`Session complete: ${wpm} WPM • ${acc}% accuracy`;
}
function start(){state={mode:state.mode,text:'',started:0,errors:0,correct:0,finished:false,score:0,level:progress.level||1,xp:progress.xp||0,keyErrors:{}};pickText();msg.textContent='';input.focus();}
input.addEventListener('input',()=>{
 if(state.finished)return;
 if(!state.started)state.started=Date.now();
 const v=input.value, idx=v.length-1;
 if(idx>=0){if(v[idx]===state.text[idx]){state.correct++;state.score+=10;state.xp+=1}else{state.errors++;state.keyErrors[state.text[idx]]=(state.keyErrors[state.text[idx]]||0)+1;state.score=Math.max(0,state.score-4)}}
 renderTarget();updateStats();
 if(v===state.text){state.level=Math.min(12,Math.max(state.level,Math.floor(state.correct/18)+1));state.score+=100;state.xp+=25;finish();}
 if(state.mode==='accuracy' && state.errors>=3)finish();
 if(state.mode==='survival' && state.errors>=5)finish();
});
document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-mode]').forEach(x=>x.classList.remove('active'));b.classList.add('active');state.mode=b.dataset.mode;start();});
$('#restart').onclick=start;
$('#hideKeyboard').onclick=()=>{const g=$('#keygrid').parentElement;g.style.display=g.style.display==='none'?'block':'none';$('#hideKeyboard').textContent=g.style.display==='none'?'Show Keyboard':'Hide Keyboard';};
buildKeys();showProgress();start();
fetch('/api/typing/progress').then(r=>r.ok?r.json():null).then(d=>{if(d?.progress){progress={...progress,...d.progress};saveLocal();showProgress();}}).catch(()=>{});
})();