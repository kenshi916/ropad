(() => {
  'use strict';
  const query=new URLSearchParams(window.location.search),code=query.get('code'),state=query.get('state'),error=query.get('error');
  window.history.replaceState(null,'',window.location.pathname);
  const heading=document.getElementById('ra-callback-heading'),status=document.getElementById('ra-callback-status'),account=document.getElementById('ra-callback-account');
  function fail(message){heading.textContent='Roblox connection not completed';status.textContent=message;account.hidden=true;}
  if(error){fail('The Roblox connection was cancelled or declined Return to your original Ropad tab to try again');return;}
  if(!code||!state||code.length>8192||state.length>512){fail('This connection link is incomplete or expired Start a new connection from your original Ropad tab');return;}
  (async()=>{
    try{
      const options={credentials:'same-origin',signal:AbortSignal.timeout(45000)},session=await fetch('/api/status',options);if(!session.ok)throw Error();const value=await session.json();if(typeof value.csrf!=='string'||!value.csrf)throw Error();
      const response=await fetch('/api/roblox/account/complete',{...options,method:'POST',headers:{'Content-Type':'application/json','X-Parallax-Token':value.csrf},body:JSON.stringify({code,state})});if(!response.ok)throw Error();
      const result=await response.json(),identity=result.account;if(result.connected!==true||!identity||!/^\d+$/.test(String(identity.id||'')))throw Error();
      heading.textContent='Roblox account connected';status.textContent='Return to your original Ropad tab Your launch details are still there';account.textContent=String(identity.displayName||identity.username||'Roblox creator')+(identity.username?' · @'+String(identity.username):'');account.hidden=false;
    }catch{fail('We could not complete this connection Return to your original Ropad tab, check your creator wallet, and try again');}
  })();
})();
