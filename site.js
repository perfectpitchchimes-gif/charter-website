document.body.classList.add('js');
const menu = document.querySelector('.menu-toggle');
const nav = document.querySelector('#navigation');
function closeMenu() { nav?.classList.remove('open'); menu?.setAttribute('aria-expanded','false'); }
menu?.addEventListener('click',()=>{ const open=menu.getAttribute('aria-expanded')!=='true'; menu.setAttribute('aria-expanded',String(open)); nav.classList.toggle('open',open); });
nav?.addEventListener('click',event=>{if(event.target.closest('a')) closeMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape' && menu?.getAttribute('aria-expanded')==='true'){closeMenu();menu.focus();}});
const motion = document.querySelector('.hero-motion');
const motionButton = document.querySelector('.motion-toggle');
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
let motionLoaded=false;
async function setMotion(play) {
  if(!motion || !motionButton) return;
  if(play && !reduced.matches){
    if(!motionLoaded){const source=motion.querySelector('source');source.src=source.dataset.src;motion.load();motionLoaded=true;}
    try{await motion.play();motion.classList.add('playing');motionButton.textContent='Pause sea motion';motionButton.setAttribute('aria-pressed','true');}catch{motionButton.textContent='Play sea motion';}
  }else{motion.pause();motion.classList.remove('playing');motionButton.textContent=reduced.matches?'Motion reduced':'Play sea motion';motionButton.setAttribute('aria-pressed','false');}
}
motionButton?.addEventListener('click',()=>setMotion(motion.paused));
reduced.addEventListener('change',()=>{if(motionButton) motionButton.disabled=reduced.matches;setMotion(false);});
if(motionButton){motionButton.disabled=reduced.matches;if(reduced.matches) motionButton.textContent='Motion reduced';}
if(motion && window.matchMedia('(min-width: 701px)').matches && !reduced.matches && !navigator.connection?.saveData){window.addEventListener('load',()=>setMotion(true),{once:true});}

const signup = document.querySelector('.signup-form');
signup?.addEventListener('submit',async event=>{
  event.preventDefault();
  if(!signup.reportValidity()) return;
  const status=signup.querySelector('.signup-status');
  const button=signup.querySelector('button[type="submit"]');
  const endpoint=signup.dataset.endpoint.trim();
  status.hidden=false;
  if(!endpoint){
    status.textContent='Email signups aren’t open yet. Please check back soon.';
    return;
  }
  // A same-origin adapter is connected to the chosen mailing provider before launch.
  const target=new URL(endpoint,location.href);
  if(target.origin!==location.origin){status.textContent='Signups are temporarily unavailable. Please try again later.';return;}
  signup.setAttribute('aria-busy','true');button.disabled=true;
  status.textContent='Submitting…';
  try{
    const response=await fetch(target,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:signup.elements.email.value.trim()}),signal:AbortSignal.timeout(12000)});
    const result=await response.json();
    if(!response.ok || result.status!=='confirmation_sent') throw new Error('Signup was not confirmed.');
    status.textContent='Check your inbox to confirm your signup.';
    signup.reset();
  }catch{status.textContent='We couldn’t complete your signup. Please try again later.';}
  finally{signup.removeAttribute('aria-busy');button.disabled=false;}
});
// Enable the prepared form only after its no-transmission fallback is attached.
if(signup) signup.querySelector('button[type="submit"]').disabled=false;
