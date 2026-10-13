'use strict';

// Project v1 is additive to scene v2. Source is creator-visible, versioned and
// installed only in an unpublished dedicated Studio. This validator is NOT a
// Luau security sandbox: a production worker must also be account/OS isolated.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const PROJECT_LIMITS=Object.freeze({scripts:6,scriptBytes:24000,totalBytes:96000,components:32,artParts:1800});
const fail=message=>Object.assign(new Error(message),{status:400,code:'INVALID_PROJECT'});
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const object=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
const color=(value,label)=>{if(!Array.isArray(value)||value.length!==3||value.some(n=>!Number.isInteger(n)||n<0||n>255))throw fail(label+' must be an RGB color');return [...value];};
const name=(value,label,max=64)=>{if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>max||/[\x00-\x1f]/.test(value))throw fail('Invalid '+label);return value.trim();};
function validateSource(source){
 if(typeof source!=='string'||!source.trim()||Buffer.byteLength(source)>PROJECT_LIMITS.scriptBytes||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(source))throw fail('Project script must contain bounded Luau source');
 // Defense in depth, not a complete parser or proof of safety. The generated
 // code contract excludes external code, credentials, persistence and commerce.
 const denied=/\b(?:require|loadstring|getfenv|setfenv|HttpService|HttpGet|HttpPost|RequestAsync|GetAsync|PostAsync|HttpEnabled|DataStoreService|MemoryStoreService|MessagingService|InsertService|AssetService|TeleportService|MarketplaceService|ScriptEditorService|PluginManager|StudioService|ChangeHistoryService|LoadStringEnabled|OpenCloudService)\b|https?:\/\/|sk-(?:or|proj)-|\b(?:getgenv|readfile|writefile|setclipboard)\b/i;
 if(denied.test(source))throw fail('Project scripts cannot access external code, network, persistent storage, commerce or Studio/editor APIs');
 return source;
}
function validateProject(input){
 if(!object(input,['version','scripts','components'])||input.version!==1||!Array.isArray(input.scripts)||input.scripts.length>PROJECT_LIMITS.scripts)throw fail('Project version 1 and a bounded script list are required');
 const ids=new Set();let bytes=0;
 const scripts=input.scripts.map(script=>{if(!object(script,['id','target','source'])||!['server','client'].includes(script.target))throw fail('Choose server or client for every project script');const id=name(script.id,'script ID',48);if(!/^[A-Za-z][A-Za-z0-9_]*$/.test(id)||ids.has(id)||id==='ParallaxGameplay'||id==='RopadPresentation')throw fail('Project script IDs must be unique identifiers');ids.add(id);const source=validateSource(script.source);bytes+=Buffer.byteLength(source);return {id,target:script.target,source};});
 if(bytes>PROJECT_LIMITS.totalBytes)throw fail('Project source exceeds the total allowance');
 const components=input.components||{};
 if(!object(components,['hud','environment']))throw fail('Unknown project component');
 let hud;
 if(components.hud!==undefined){const h=components.hud;if(!object(h,['title','accent','panel']) )throw fail('Invalid HUD component');hud={title:name(h.title,'HUD title',64),accent:color(h.accent||[123,250,202],'HUD accent'),panel:color(h.panel||[12,20,34],'HUD panel')};}
 const environment=components.environment||[];
 if(!Array.isArray(environment)||environment.length>PROJECT_LIMITS.components)throw fail('Too many art components');
 const componentIds=new Set();
 const art=environment.map(c=>{if(!object(c,['id','kind','position','size','color','accent','yaw'])||!['building','tree','arch','planter','spire'].includes(c.kind))throw fail('Unknown environment component');const id=name(c.id,'component ID',48);if(!/^[A-Za-z][A-Za-z0-9_]*$/.test(id)||componentIds.has(id))throw fail('Component IDs must be unique identifiers');componentIds.add(id);if(c.yaw!==undefined&&(!Number.isFinite(c.yaw)||Math.abs(c.yaw)>180))throw fail('Invalid component yaw');for(const [k,min,max]of[['position',-2048,2048],['size',1,256]])if(!Array.isArray(c[k])||c[k].length!==3||c[k].some(v=>!Number.isFinite(v)||v<min||v>max))throw fail('Invalid component '+k);return {id,kind:c.kind,...(c.yaw!==undefined?{yaw:c.yaw}:{}),position:[...c.position],size:[...c.size],color:color(c.color||[35,49,62],'component color'),accent:color(c.accent||[123,250,202],'component accent')};});
 const validated={version:1,scripts,components:{...(hud?{hud}:{}),environment:art}};componentParts(validated);return validated;
}
function componentParts(project){
 if(!project)return [];
 const parts=[];
 for(const c of project.components.environment){let i=0;const [x,y,z]=c.position,[w,h,d]=c.size,yaw=(c.yaw||0)*Math.PI/180;
  const add=(offset,size,color=c.color,material='SmoothPlastic',shape='Block')=>{parts.push({id:'art_'+c.id+'_'+(++i),name:c.id+' '+i,position:[x+offset[0]*Math.cos(yaw)+offset[2]*Math.sin(yaw),y+offset[1],z-offset[0]*Math.sin(yaw)+offset[2]*Math.cos(yaw)],size,color,material,behavior:'decoration',value:1,shape,...(c.yaw?{rotation:[0,c.yaw,0]}:{})});};
  if(c.kind==='building'){
   add([0,0,0],[w,h,d],c.color,'Concrete');add([0,h/2+.25,0],[w+1,.5,d+1],c.accent,'Metal');
   const floors=Math.min(8,Math.max(1,Math.floor(h/5))),cols=Math.min(6,Math.max(1,Math.floor(w/5)));
   for(let floor=0;floor<floors;floor++)for(let col=0;col<cols;col++)for(const side of [-1,1])add([-w/2+(col+.5)*w/cols,-h/2+(floor+.5)*h/floors,side*(d/2+.04)],[Math.max(.3,w/cols-1.2),Math.max(.3,h/floors-1.5),.08],c.accent,'Neon');
   for(const side of [-1,1]){add([side*(w/2-.3),h/2+.8,0],[.6,1.1,d],c.color,'Concrete');add([0,h/2+.8,side*(d/2-.3)],[w,1.1,.6],c.color,'Concrete');}
  }else if(c.kind==='tree'){add([0,-h*.2,0],[Math.max(.4,w*.16),h*.6,Math.max(.4,d*.16)],[105,73,48],'WoodPlanks');add([0,h*.15,0],[w,h*.7,d],c.color,'Grass','Ball');add([w*.2,h*.3,d*.1],[w*.65,h*.45,d*.65],c.accent,'Grass','Ball');}
  else if(c.kind==='arch'){for(const side of[-1,1]){add([side*(w/2-.4),0,0],[.8,h,d],c.color,'Metal');add([side*(w/2-.4),0,-d/2-.08],[.18,h*.8,.16],c.accent,'Neon');}add([0,h/2-.4,0],[w,.8,d],c.color,'Metal');add([0,h/2-.3,-d/2-.08],[w*.8,.18,.16],c.accent,'Neon');}
  else if(c.kind==='planter'){add([0,-h*.3,0],[w,h*.4,d],c.color,'Concrete');for(const side of[-1,0,1])add([side*w*.27,h*.1,0],[w*.4,h*.8,d*.85],c.accent,'Grass','Ball');}
  else {add([0,-h*.15,0],[w,h*.7,d],c.color,'Metal');add([0,h*.25,0],[w*.55,h*.5,d*.55],c.accent,'SmoothPlastic');add([0,h*.5,0],[Math.max(.2,w*.1),h*.2,Math.max(.2,d*.1)],c.accent,'Neon');}
 }
 if(parts.length>PROJECT_LIMITS.artParts)throw fail('Expanded art exceeds the component allowance');
 return parts;
}
function projectContext(session,lua){return `local root = workspace:WaitForChild(${lua(session.rootName)}, 30)\nlocal deadline = os.clock() + 30\nwhile root and root:GetAttribute("ParallaxJob") == nil and os.clock() < deadline do task.wait(.1) end\nassert(root and root:GetAttribute("ParallaxJob") == ${lua(session.jobId)}, "Project root unavailable")\nlocal project = {root = root, gameName = ${lua(session.gameName||'Ropad game')}, template = ${lua(session.plan.template)}}\nscript:SetAttribute("RopadStarted", true)\n`;}
function projectScripts(session,lua){
 const p=session.plan.project;if(!p)return [];
 const scripts=p.scripts.map(s=>({...s,source:projectContext(session,lua)+s.source}));
 if(p.components.hud){const hud=p.components.hud;const source=fs.readFileSync(path.join(__dirname,'project-hud.luau'),'utf8');scripts.push({id:'RopadPresentation',target:'client',source:projectContext(session,lua)+`local HUD = ${lua(hud)}\n`+source});}
 return scripts;
}
function manifest(session){const p=session.plan?.project;if(!p)return null;return {version:1,sceneVersion:2,sourceHash:hash(JSON.stringify(session.plan)),scriptCount:p.scripts.length,artPartCount:componentParts(p).length,components:p.components,files:p.scripts.map(s=>({id:s.id,target:s.target,path:(s.target==='server'?'Server/':'Client/')+s.id+'.luau',bytes:Buffer.byteLength(s.source),hash:hash(s.source)})),validation:'bounded_source_review',sandboxed:false,playtested:false};}
function installProjectSource(session,lua){
 if(!session.plan.project)return '';
 const scripts=projectScripts(session,lua),parts=componentParts(session.plan.project);
 return `\n-- Versioned project installation: primitives plus real server/client source\nlocal art = Instance.new("Folder"); art.Name = "RopadArt"; art.Parent = gameplay\nfor _, item in ipairs(${lua(parts)}) do\n local p = Instance.new("Part"); p.Name = item.id; p.Anchored = true; p.CanCollide = false; p.CanTouch = false; p.CanQuery = false\n p.Size = Vector3.new(table.unpack(item.size)); p.Position = Vector3.new(table.unpack(item.position)); p.Color = Color3.fromRGB(table.unpack(item.color)); p.Material = Enum.Material[item.material]; p.Shape = Enum.PartType[item.shape]; if item.rotation then p.CFrame = CFrame.new(table.unpack(item.position)) * CFrame.Angles(0,math.rad(item.rotation[2]),0) end; p.Parent = art\nend\nfor _, item in ipairs(${lua(scripts)}) do\n local parent = item.target == "server" and gameplay or game:GetService("StarterPlayer"):FindFirstChildOfClass("StarterPlayerScripts")\n assert(parent, "StarterPlayerScripts is required")\n local scriptName = ${lua(session.rootName+'__')} .. item.id\n assert(not parent:FindFirstChild(scriptName), "Project script already exists")\n local code = Instance.new(item.target == "server" and "Script" or "LocalScript"); code.Name = scriptName\n code:SetAttribute("ParallaxJob", ${lua(session.jobId)}); code:SetAttribute("RopadProjectFile", item.id)\n game:GetService("ScriptEditorService"):UpdateSourceAsync(code, function() return item.source end); code.Parent = parent\nend\nroot:SetAttribute("RopadProjectVersion", 1)\nroot:SetAttribute("RopadProjectHash", ${lua(manifest(session).sourceHash)})\n`;
}
module.exports={PROJECT_LIMITS,validateProject,validateSource,componentParts,projectScripts,projectContext,installProjectSource,manifest,hash};
