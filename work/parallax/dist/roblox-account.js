(() => {
  'use strict';
  const instances=new WeakMap();
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function authorizationUrl(value){
    if(typeof value!=='string')throw Error('The Roblox connection could not be opened');
    let url;try{url=new URL(value);}catch{throw Error('The Roblox connection could not be opened');}
    if(url.protocol!=='https:'||url.hostname!=='apis.roblox.com'||url.port||url.username||url.password||url.pathname!=='/oauth/v1/authorize'||url.hash)throw Error('The Roblox connection could not be opened');
    return url.href;
  }
  async function request(url,body,signal){
    const options={credentials:'same-origin',signal};
    if(body!==undefined){
      const status=await fetch('/api/status',{credentials:'same-origin',signal});if(!status.ok)throw Error('Ropad is unavailable Please try again');
      const value=await status.json();if(typeof value.csrf!=='string'||!value.csrf)throw Error('Your Ropad session needs refreshing');
      Object.assign(options,{method:'POST',headers:{'Content-Type':'application/json','X-Parallax-Token':value.csrf},body:JSON.stringify(body)});
    }
    const response=await fetch(url,options);if(!response.ok)throw Error(response.status===401?'Connect and verify your creator wallet to continue':'The Roblox connection could not be updated Please try again');
    return response.json();
  }
  function valid(state,epoch){return instances.get(state.host)===state&&state.host.isConnected&&epoch===state.epoch;}
  function identity(value){
    const account=value?.account;if(value?.connected!==true||value.authenticated!==true||!account||!/^\d+$/.test(String(account.id||'')))return null;
    return{id:String(account.id),displayName:String(account.displayName||account.username||'Roblox creator').slice(0,80),username:String(account.username||'').slice(0,80)};
  }
  function render(state){
    if(instances.get(state.host)!==state||!state.host.isConnected)return;
    const data=state.data,account=identity(data),configured=data?.configured===true,pending=state.authorization&&state.expiresAt>Date.now();
    let heading='Your Roblox account',description='Connect the creator identity you want to use for this game',action='';
    if(state.loading&&!data)description='Checking your Roblox connection';
    else if(account){heading=account.displayName;description=account.username?'@'+account.username:'Roblox creator identity verified';action=`<a class="ra-profile" href="https://www.roblox.com/users/${encodeURIComponent(account.id)}/profile" target="_blank" rel="noopener noreferrer">View profile ↗</a><button type="button" class="ra-link" data-ra-disconnect${state.busy?' disabled':''}>Disconnect</button>`;}
    else if(data?.configured===false){heading='Roblox connection setup pending';description='You can build now and publish from your own Roblox Studio account';action='<button type="button" class="ra-link" data-ra-details aria-expanded="'+state.details+'">Connection details</button>';}
    else if(pending){heading='Continue with Roblox';description='Complete the connection in a new tab, then return here';action=`<a class="ra-connect" href="${esc(state.authorization)}" target="_blank" rel="noopener noreferrer">Continue on Roblox ↗</a><button type="button" class="ra-link" data-ra-check${state.loading?' disabled':''}>Check connection</button>`;}
    else if(configured)action=`<button type="button" class="ra-connect" data-ra-connect${state.busy?' disabled':''}>${state.busy?'Preparing connection…':'Connect Roblox'}</button>`;
    else if(!state.loading)action='<button type="button" class="ra-link" data-ra-check>Check connection</button>';
    state.host.innerHTML=`<section class="ra-card" aria-label="Roblox creator account"><div class="ra-card-main"><span class="ra-avatar${account?' is-connected':''}" aria-hidden="true">${account?esc(account.displayName.slice(0,1).toUpperCase()):'R'}</span><div class="ra-identity"><span class="ra-eyebrow">ROBLOX ACCOUNT${account?' · CONNECTED':''}</span><h3>${esc(heading)}</h3><p>${esc(description)}</p></div></div>${action?'<div class="ra-actions">'+action+'</div>':''}${state.details?'<div class="ra-details">'+(data?.reason?'<p>'+esc(data.reason)+'</p>':'')+'<p>The Ropad operator must register a Roblox OAuth app and configure its callback before account connection is available</p><p>You do not need to send a password or API key here Your build can continue while this is set up</p></div>':''}<p class="ra-boundary">This identifies the creator Publishing still requires your own Roblox experience and a separate publishing permission</p>${state.message?`<p class="ra-message${state.error?' is-error':''}" role="status">${esc(state.message)}</p>`:''}</section>`;
    state.host.querySelector('[data-ra-connect]')?.addEventListener('click',()=>connect(state));
    state.host.querySelector('[data-ra-disconnect]')?.addEventListener('click',()=>disconnect(state));
    state.host.querySelector('[data-ra-check]')?.addEventListener('click',()=>refresh(state,true));
    state.host.querySelector('[data-ra-details]')?.addEventListener('click',()=>{state.details=!state.details;render(state);});
  }
  async function refresh(state,explicit=false){
    if(!state.host.isConnected){unmount(state.host);return;}if(state.busy)return;
    state.controller?.abort();const controller=new AbortController(),epoch=++state.epoch;state.controller=controller;state.loading=true;if(explicit){state.message='';state.error=false;}render(state);
    try{
      await window.RopadSolana?.whenInvalidated?.();if(!valid(state,epoch))return;
      const value=await request('/api/roblox/account',undefined,controller.signal);if(!valid(state,epoch))return;
      state.data=value;if(identity(value)){state.authorization=null;state.message=explicit?'Roblox creator identity connected':'';state.error=false;}
      else if(explicit){state.message=state.authorization?'Connection is not complete yet Finish the Roblox step, then check again':'';state.error=false;}
    }catch(error){if(valid(state,epoch)&&error.name!=='AbortError'){state.message='Roblox connection status is unavailable Please try again';state.error=true;}}
    finally{if(valid(state,epoch)){state.loading=false;render(state);}}
  }
  async function authenticate(state){
    const wallet=window.RopadSolana?.get?.();if(!wallet){window.RopadSolana?.connect?.();throw Error('Connect your creator wallet, then select Connect Roblox again');}
    await window.RopadSolana.authenticate();return window.RopadSolana.check(wallet.address).address;
  }
  async function connect(state){
    if(state.busy||state.data?.configured!==true)return;state.controller?.abort();const controller=new AbortController(),epoch=++state.epoch;state.controller=controller;state.busy=true;state.message='';state.error=false;render(state);
    try{
      const owner=await authenticate(state);if(!valid(state,epoch))return;
      const result=await request('/api/roblox/account/start',{},controller.signal);window.RopadSolana.check(owner);if(!valid(state,epoch))return;
      const url=authorizationUrl(result.authorizationUrl),expires=typeof result.expiresAt==='number'?result.expiresAt:Date.parse(result.expiresAt);
      if(!Number.isFinite(expires)||expires<=Date.now())throw Error('This connection link has expired Please try again');
      state.authorization=url;state.expiresAt=expires;state.message='Only your Roblox profile identity is requested';
    }catch(error){if(valid(state,epoch)&&error.name!=='AbortError'){state.authorization=null;state.message=error.message;state.error=true;}}
    finally{if(valid(state,epoch)){state.busy=false;render(state);}}
  }
  async function disconnect(state){
    if(state.busy)return;state.controller?.abort();const controller=new AbortController(),epoch=++state.epoch;state.controller=controller;state.busy=true;state.message='';state.error=false;render(state);
    try{const owner=await authenticate(state);if(!valid(state,epoch))return;const result=await request('/api/roblox/account/disconnect',{},controller.signal);window.RopadSolana.check(owner);if(!valid(state,epoch))return;state.authorization=null;state.data=result?.configured!==undefined?result:{...state.data,connected:false,account:null};state.message='Roblox account disconnected';}
    catch(error){if(valid(state,epoch)&&error.name!=='AbortError'){state.message=error.message;state.error=true;}}
    finally{if(valid(state,epoch)){state.busy=false;render(state);}}
  }
  function mount(host){
    if(!host)return;if(instances.has(host))return refresh(instances.get(host));
    const state={host,epoch:0,data:null,loading:false,busy:false,details:false,error:false,message:'',authorization:null,expiresAt:0,controller:null};instances.set(host,state);
    state.focus=()=>refresh(state);
    state.wallet=()=>{state.controller?.abort();state.epoch++;state.data=null;state.authorization=null;state.expiresAt=0;state.busy=false;state.loading=false;state.message='';state.error=false;state.details=false;render(state);void refresh(state);};
    window.addEventListener('focus',state.focus);window.addEventListener('ropad-solana-wallet-change',state.wallet);return refresh(state);
  }
  function unmount(host){const state=instances.get(host);if(!state)return;state.epoch++;state.controller?.abort();window.removeEventListener('focus',state.focus);window.removeEventListener('ropad-solana-wallet-change',state.wallet);instances.delete(host);}
  window.RopadRobloxAccount={mount,unmount};
})();
