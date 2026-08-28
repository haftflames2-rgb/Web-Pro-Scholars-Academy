const msg=document.getElementById('msg');
const loginForm=document.getElementById('loginForm');
if(loginForm) loginForm.onsubmit=async e=>{
 e.preventDefault();
 const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email.value,password:password.value})});
 const d=await res.json(); if(!res.ok){msg.textContent=d.error;return} location=d.redirect;
};
const registerForm=document.getElementById('registerForm');
if(registerForm) registerForm.onsubmit=async e=>{
 e.preventDefault();
 if(password.value!==confirm.value){msg.textContent='Passwords do not match.';return}
 const res=await fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name.value,email:email.value,password:password.value})});
 const d=await res.json(); if(!res.ok){msg.textContent=d.error;return} location=d.redirect;
};
