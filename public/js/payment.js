async function initPayment() {
  const msg = document.getElementById('msg'); const qs=new URLSearchParams(location.search); const purpose=qs.get('purpose')||'tuition'; const requestId=qs.get('requestId')||'';
  try { const me=await fetch('/api/me').then(r=>r.json()); if(!me.user){location='/login.html';return;} } catch(_){location='/login.html';return;}
  if(purpose==='certificate'&&requestId){
    try{const d=await fetch('/api/student/certificate-payment/'+encodeURIComponent(requestId)).then(async r=>{const x=await r.json();if(!r.ok)throw new Error(x.error||'Unable to load certificate payment.');return x});document.getElementById('paymentHeading').textContent='Pay for certificate';document.getElementById('paymentIntro').textContent=`Certificate for ${d.request.course}. Amount due: ${d.request.currency} ${Number(d.request.fee).toFixed(2)}. Submit your payment proof below.`;}
    catch(e){msg.textContent=e.message;return;}
  }
  document.getElementById('paymentForm').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('button[type="submit"]')||e.target.querySelector('button');if(button){button.disabled=true;button.textContent='Submitting...'}msg.textContent='';const fd=new FormData(e.target);if(purpose==='certificate'){fd.append('purpose','certificate');fd.append('certificateRequestId',requestId)}try{const r=await fetch('/api/payments',{method:'POST',body:fd});const d=await r.json();if(!r.ok)throw new Error(d.error||'Payment submission failed.');msg.textContent=d.message||'Payment submitted successfully.';if(d.ok){e.target.reset();if(button){button.disabled=false;button.textContent='Submit payment'}}}catch(err){msg.textContent=err.message;if(button){button.disabled=false;button.textContent='Submit payment'}}};
}
initPayment();
