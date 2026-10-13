'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,fs.existsSync(path.join(__dirname,'parallax'))?'parallax/dist/project-tools.js':'../dist/project-tools.js'),'utf8');
const ID='12345678-1234-4234-8234-123456789abc',NEXT='22345678-1234-4234-8234-123456789abc';
class Element{constructor(){this.innerHTML='';this.nodes=new Map();this.dataset={};this.values={};}querySelector(q){if(!this.nodes.has(q))this.nodes.set(q,new Element());return this.nodes.get(q);}closest(){return {close(){}};}}
function fixture({interrupt=false}={}){
 let host=new Element(),first=true,n=0;const calls=[];
 const window={openInfo(_,html){host.innerHTML=html;host.nodes.clear();},ParallaxBuilders:{refresh(){}}};
 vm.runInNewContext(source,{window,document:{getElementById:()=>host},AbortSignal,crypto:{randomUUID:()=>`op-${++n}`},FormData:class{constructor(form){this.form=form;}*[Symbol.iterator](){yield*Object.entries(this.form.values);}},fetch:async(url,options={})=>{
  const body=options.body?JSON.parse(options.body):undefined;calls.push({url,body});
  if(url.endsWith('/project/file')&&interrupt&&first){first=false;throw Error('Response interrupted');}
  const data=url==='/api/status'?{csrf:'OFFLINE'}:url.endsWith('/project')?{manifest:{sourceHash:'a'.repeat(64)},files:[{id:'Rules',target:'server',source:'print("one")'},{id:'Interface',target:'client',source:'print("two")'}]}:url.endsWith('/project/file')?{build:{id:NEXT}}:{};
  return {ok:true,json:async()=>data};
 }});
 return {window,host,calls};
}
test('project editor loads source without saving or running AI',async()=>{
 const h=fixture();await h.window.RopadProjectTools.edit(ID);assert.match(h.host.innerHTML,/print\(&quot;one&quot;\)/);assert.equal(h.calls.length,1);assert.equal(h.calls[0].body,undefined);assert.match(h.host.innerHTML,/not a security sandbox/);
});
test('code save retries reuse an operation key and preserve the original source fingerprint',async()=>{
 const h=fixture({interrupt:true});await h.window.RopadProjectTools.edit(ID);const f=h.host.querySelector('form');f.values={fileId:'Rules',target:'server',source:'print("updated")'};
 await f.onsubmit({preventDefault(){}});assert.match(f.querySelector('[data-project-message]').textContent,/interrupted/);assert.equal(f.querySelector('button').disabled,false);
 await f.onsubmit({preventDefault(){}});const saves=h.calls.filter(c=>c.url.endsWith('/project/file'));assert.equal(saves.length,2);assert.equal(saves[0].body.idempotencyKey,saves[1].body.idempotencyKey);assert.equal(saves[1].body.expectedHash,'a'.repeat(64));assert.equal(f.querySelector('button').disabled,true);assert.match(f.querySelector('[data-project-message]').innerHTML,new RegExp(NEXT));
});
test('switching files retains the unsaved source draft without sending it',async()=>{
 const h=fixture();await h.window.RopadProjectTools.edit(ID);let f=h.host.querySelector('form');f.values={fileId:'Rules',target:'server',source:'print("unsaved")'};f.querySelector('[name="file"]').onchange({target:{value:'Interface'}});
 f=h.host.querySelector('form');f.values={fileId:'Interface',target:'client',source:'print("two")'};f.querySelector('[name="file"]').onchange({target:{value:'Rules'}});assert.match(h.host.innerHTML,/unsaved/);assert.equal(h.calls.length,1);
});
