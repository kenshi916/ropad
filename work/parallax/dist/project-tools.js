(() => {
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const validId=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
  async function request(path,body){
    const options={credentials:'same-origin',signal:AbortSignal.timeout(65000)};
    if(body!==undefined){const r=await fetch('/api/status',{credentials:'same-origin'});if(!r.ok)throw Error('Ropad is unavailable');const status=await r.json();Object.assign(options,{method:'POST',headers:{'Content-Type':'application/json','X-Parallax-Token':status.csrf},body:JSON.stringify(body)});}
    const r=await fetch(path,options);let data;try{data=await r.json();}catch{throw Error('The server response was unreadable');}if(!r.ok)throw Error(data.error||'The request did not complete');return data;
  }
  function dialog(title,html){window.openInfo(title,'<div class="rp-project-tools">'+html+'</div>');return document.getElementById('info-body');}
  async function edit(buildId){
    if(!validId(buildId))return;let host=dialog('ROPAD / PROJECT SOURCE','<h2>Loading your project</h2>');
    try{
      const project=await request('/api/builds/'+buildId+'/project');let fileId=project.files[0]?.id||'GameRules',drafts=new Map(project.files.map(f=>[f.id,{...f}])),pendingSave=null;
      function render(){const file=drafts.get(fileId)||{id:fileId,target:'server',source:'-- Your project root is available as project.root\n'};
        host=dialog('ROPAD / PROJECT SOURCE','<h2>Edit your game code</h2><p>Save an update as a new version, then run it in Studio The current version stays intact</p><form data-project-editor><label>Project file<select name="file">'+[...drafts.keys()].map(id=>'<option'+(id===fileId?' selected':'')+'>'+esc(id)+'</option>').join('')+(drafts.has(fileId)?'':'<option selected>'+esc(fileId)+'</option>')+'</select></label><div class="r-solana-form-pair"><label>File name<input name="fileId" value="'+esc(file.id)+'" pattern="[A-Za-z][A-Za-z0-9_]{0,47}" required></label><label>Runs on<select name="target"><option value="server"'+(file.target==='server'?' selected':'')+'>Server</option><option value="client"'+(file.target==='client'?' selected':'')+'>Client / UI</option></select></label></div><label>Luau source<textarea name="source" class="rp-source-editor" rows="20" spellcheck="false" maxlength="24000">'+esc(file.source)+'</textarea></label><p class="r-solana-note">Custom code runs in the dedicated Roblox place Source validation is not a security sandbox Review and playtest each version</p><button class="button primary" type="submit">Save code as new version ↗</button><p data-project-message role="status"></p></form>');
        const form=host.querySelector('form');form.querySelector('[name="file"]').onchange=e=>{const values=Object.fromEntries(new FormData(form));drafts.set(fileId,{id:values.fileId,target:values.target,source:values.source});fileId=e.target.value;render();};
        form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('button'),message=form.querySelector('[data-project-message]');button.disabled=true;
          try{const values=Object.fromEntries(new FormData(form)),payload={fileId:values.fileId,target:values.target,source:values.source,expectedHash:project.manifest.sourceHash};const fingerprint=JSON.stringify(payload);if(pendingSave?.fingerprint!==fingerprint)pendingSave={fingerprint,idempotencyKey:crypto.randomUUID()};const result=await request('/api/builds/'+buildId+'/project/file',{...payload,idempotencyKey:pendingSave.idempotencyKey});message.innerHTML='Saved <a href="#/workspace/'+encodeURIComponent(result.build.id)+'">Open the new version ↗</a>';message.querySelector('a').onclick=()=>host.closest('dialog')?.close();window.ParallaxBuilders?.refresh();button.dataset.saved='true';}
          catch(e){message.textContent=e.message;}finally{button.disabled=button.dataset.saved==='true';}
        };
      }render();
    }catch(e){host=dialog('ROPAD / PROJECT SOURCE','<h2>Project source</h2><p>'+esc(e.message)+'</p><p>New project builds include editable server and client scripts Older scene-only builds can still be downloaded or updated with a new prompt</p>');}
  }
  async function publish(buildId){
    if(!validId(buildId))return;let host=dialog('ROPAD / ROBLOX RELEASE','<h2>Reading publishing connection</h2>');
    try{
      const state=await request('/api/builds/'+buildId+'/publication'),c=state.configuration,latest=state.publications?.at(-1);
      host=dialog('ROPAD / ROBLOX RELEASE','<h2>Publish your reviewed game</h2><p>Upload this saved project version to your connected Roblox place after reviewing the target and exact project</p>'+ (c.connected?'<dl class="r-solana-quote"><div><dt>Universe</dt><dd>'+esc(c.target.universeId)+'</dd></div><div><dt>Place</dt><dd>'+esc(c.target.placeId)+'</dd></div></dl>':'<p class="r-solana-note">Connect an existing Roblox place and its scoped publishing permission on the server first You can also download the project and publish from Studio</p>')+(latest?'<p>Last upload: '+esc(latest.status)+(latest.versionNumber?' · Roblox version '+esc(latest.versionNumber):'')+'</p>':'')+'<button class="button primary" data-publish-review'+(c.configured&&c.connected?'':' disabled')+'>Review publication ↗</button><a class="button" href="/api/builds/'+buildId+'/artifact?format=rbxlx" download>Download project ↓</a><p data-project-message role="status"></p>');
      host.querySelector('[data-publish-review]').onclick=async()=>{const message=host.querySelector('[data-project-message]');try{
        const intent=await request('/api/builds/'+buildId+'/publication/prepare',{});
        if(intent.status!=='prepared'){message.textContent=intent.status==='published'?'This exact project is already published as Roblox version '+intent.versionNumber:'The previous upload needs review in Roblox version history before another attempt';return;}
        host=dialog('ROPAD / PUBLICATION REVIEW','<h2>'+esc(intent.gameName)+'</h2><dl class="r-solana-quote"><div><dt>Target place</dt><dd>'+esc(intent.placeId)+'</dd></div><div><dt>Project size</dt><dd>'+Math.ceil(intent.artifactBytes/1024)+' KB</dd></div><div><dt>Project fingerprint</dt><dd><code>'+esc(intent.artifactHash)+'</code></dd></div></dl><p>This uploads a new published version to that place Roblox experience access settings remain under your account’s control</p><button class="button primary" data-publish-confirm>Publish this version to Roblox ↗</button><p data-project-message role="status"></p>');
        host.querySelector('[data-publish-confirm]').onclick=async e=>{e.target.disabled=true;const m=host.querySelector('[data-project-message]');try{const r=await request('/api/builds/'+buildId+'/publication/publish',{intentId:intent.id,artifactHash:intent.artifactHash});m.innerHTML='Roblox confirmed version '+esc(r.versionNumber)+' <a href="https://www.roblox.com/games/'+encodeURIComponent(r.placeId)+'" target="_blank" rel="noopener">Open game ↗</a><br>Verify player access in Roblox before announcing the release';window.ParallaxBuilders?.refresh();}catch(error){m.textContent=error.message;}};
      }catch(e){message.textContent=e.message;}};
    }catch(e){dialog('ROPAD / ROBLOX RELEASE','<h2>Publishing unavailable</h2><p>'+esc(e.message)+'</p>');}
  }
  window.RopadProjectTools={edit,publish};
})();
