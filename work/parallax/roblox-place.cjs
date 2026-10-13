'use strict';

// Standalone XML place generation, not a Studio save or a gameplay certification.
// Format: https://github.com/RobloxAPI/spec/blob/master/formats/rbxlx.md
// Enum values: https://create.roblox.com/docs/reference/engine/enums/Material
const MATERIAL_IDS = Object.freeze({SmoothPlastic:272,Neon:288,Concrete:816,Grass:1280,WoodPlanks:528,Metal:1088});
const {componentParts,projectScripts,manifest}=require('./builder-project.cjs');
const xml = value => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,'\ufffd').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const prop = (type, name, value) => `<${type} name="${name}">${xml(value)}</${type}>`;
const vec = (name, value) => `<Vector3 name="${name}"><X>${value[0]}</X><Y>${value[1]}</Y><Z>${value[2]}</Z></Vector3>`;
const frame = (value, rotation) => { const yaw = (rotation?.[1] || 0) * Math.PI / 180, c = Math.cos(yaw), s = Math.sin(yaw); return `<CoordinateFrame name="CFrame"><X>${value[0]}</X><Y>${value[1]}</Y><Z>${value[2]}</Z><R00>${c}</R00><R01>0</R01><R02>${s}</R02><R10>0</R10><R11>1</R11><R12>0</R12><R20>${-s}</R20><R21>0</R21><R22>${c}</R22></CoordinateFrame>`; };
function item(className, referent, properties, children = '') {return `<Item class="${className}" referent="${referent}"><Properties>${properties}</Properties>${children}</Item>`;}

function artifactPlace(session, gameplaySource, lua) {
  if (!session?.plan?.parts || typeof gameplaySource !== 'string' || typeof lua !== 'function') throw new Error('A validated scene and fixed gameplay source are required');
  const parts = session.plan.parts.map((part, index) => {
    const color = (0xff000000 | (Math.round(part.color[0]) << 16) | (Math.round(part.color[1]) << 8) | Math.round(part.color[2])) >>> 0;
    const properties = prop('string','Name',part.name) + prop('bool','Anchored',true) + prop('bool','CanCollide',!['coin','decoration'].includes(part.behavior)) + prop('bool','CanTouch',part.behavior !== 'decoration') + prop('float','Transparency',0) + prop('Color3uint8','Color3uint8',color) + vec('size',part.size) + frame(part.position,part.rotation) + prop('token','Material',MATERIAL_IDS[part.material]) + prop('token','TopSurface',0) + prop('token','BottomSurface',0) + (part.behavior === 'spawn' ? prop('bool','Neutral',true) + prop('int','Duration',0) + prop('bool','Enabled',true) + prop('bool','AllowTeamChangeOnTouch',false) : prop('token','shape',part.behavior === 'coin' ? 0 : ({Block:1,Ball:0,Cylinder:2}[part.shape] ?? 1)));
    return item(part.behavior === 'spawn' ? 'SpawnLocation' : 'Part',`RBXPART${index}`,properties);
  }).join('');

  // ObjectValue references preserve exact identity even if display names repeat.
  // Attributes are initialized before gameplay in the same Script: no reliance on
  // undocumented binary AttributesSerialize encoding or script scheduling order.
  const bindings = session.plan.parts.map((part,index) => item('ObjectValue',`RBXBIND${index}`,prop('string','Name',part.id)+prop('Ref','Value',`RBXPART${index}`))).join('');
  const metadata = item('Folder','RBXMETA',prop('string','Name','ParallaxBindings'),bindings);
  const runtime = `-- Generated project from a validated Parallax scene plan\n-- Open in Studio and playtest before publishing\nlocal exportRoot = script.Parent\nlocal exportBindings = exportRoot:WaitForChild("ParallaxBindings")\nlocal exportParts = ${lua(session.plan.parts.map(part => ({id:part.id,behavior:part.behavior,value:part.value})))}\nexportRoot:SetAttribute("Template", ${lua(session.plan.template)})\nexportRoot:SetAttribute("ParallaxJob", ${lua(session.jobId)})\nfor _, data in ipairs(exportParts) do\n local binding = exportBindings:FindFirstChild(data.id)\n local part = binding and binding.Value\n assert(part and part:IsA("BasePart"), "Generated project part binding is missing")\n part:SetAttribute("PlanId", data.id)\n part:SetAttribute("Behavior", data.behavior)\n part:SetAttribute("Value", data.value)\nend\n\n${gameplaySource}`;
  const allScripts=projectScripts(session,lua);
  const art=componentParts(session.plan.project).map((p,i)=>item('Part','RBXART'+i,prop('string','Name',p.id)+prop('bool','Anchored',true)+prop('bool','CanCollide',false)+prop('bool','CanTouch',false)+prop('bool','CanQuery',false)+vec('size',p.size)+frame(p.position,p.rotation)+prop('Color3uint8','Color3uint8',(0xff000000|(p.color[0]<<16)|(p.color[1]<<8)|p.color[2])>>>0)+prop('token','Material',MATERIAL_IDS[p.material])+prop('token','shape',({Block:1,Ball:0,Cylinder:2}[p.shape])))).join('');
  const scriptXml=(s,i)=>item(s.target==='server'?'Script':'LocalScript','RBXPROJECTSCRIPT'+i,prop('string','Name',session.rootName+'__'+s.id)+prop('bool','Disabled',false)+prop('ProtectedString','Source',s.source));
  const serverScripts=allScripts.map((s,i)=>s.target==='server'?scriptXml(s,i):'').join('');
  const projectSetup=session.plan.project?`root:SetAttribute("RopadProjectVersion", 1)\nroot:SetAttribute("RopadProjectHash", ${lua(manifest(session).sourceHash)})\n`:'';
  const script = item('Script','RBXSCRIPT',prop('string','Name','ParallaxGameplay')+prop('bool','Disabled',false)+prop('ProtectedString','Source',projectSetup?runtime.replace('local exportRoot = script.Parent','local exportRoot = script.Parent\nlocal root = exportRoot\n'+projectSetup):runtime),serverScripts+(session.plan.project?item('Folder','RBXARTFOLDER',prop('string','Name','RopadArt'),art):''));
  const root = item('Folder','RBXROOT',prop('string','Name',session.rootName),parts+metadata+script);
  const workspace = item('Workspace','RBXWORKSPACE',prop('string','Name','Workspace')+prop('float','Gravity',196.2),root);
  const style = session.plan.presentation?.lighting;
  const ambient = style ? `<Color3 name="Ambient"><R>${style.ambient[0]/255}</R><G>${style.ambient[1]/255}</G><B>${style.ambient[2]/255}</B></Color3>` : '';
  const lighting = item('Lighting','RBXLIGHTING',prop('string','Name','Lighting')+prop('float','Brightness',style?.brightness ?? 2)+prop('float','ClockTime',style?.clockTime ?? 14)+ambient);
  const clients=allScripts.map((s,i)=>s.target==='client'?scriptXml(s,i):'').join('');
  const starter=session.plan.project?item('StarterPlayer','RBXSTARTER',prop('string','Name','StarterPlayer'),item('StarterPlayerScripts','RBXSTARTERSCRIPTS',prop('string','Name','StarterPlayerScripts'),clients)):'';
  const restrictions=session.plan.project?item('HttpService','RBXHTTP',prop('string','Name','HttpService')+prop('bool','HttpEnabled',false))+item('ServerScriptService','RBXSERVERSCRIPTS',prop('string','Name','ServerScriptService')+prop('bool','LoadStringEnabled',false)):'';
  return `<roblox version="4"><External>null</External><External>nil</External>${workspace}${lighting}${starter}${restrictions}</roblox>`;
}

module.exports = {artifactPlace};
