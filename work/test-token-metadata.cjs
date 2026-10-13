'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createTokenMetadataService,externalImage}=require('./parallax/token-metadata.cjs');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ropad-token-metadata-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return {directory,service:createTokenMetadataService({stateDirectory:directory,publicOrigin:'https://ropad.com'})};}
const input={name:'Skyline Circuit',symbol:'SKY',description:'Rooftop racing',imageUrl:'https://images.ropad.com/skyline.png'};
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function png(){const b=Buffer.alloc(32);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);return b;}
test('metadata requires durable directory/public origin and never pretends localhost is public hosting',t=>{const f=fixture(t),s=createTokenMetadataService({stateDirectory:f.directory});assert.equal(s.config().available,false);assert.throws(()=>s.create(input),/public Ropad HTTPS domain/);assert.throws(()=>createTokenMetadataService({stateDirectory:f.directory,publicOrigin:'http://localhost:61281'}));});
test('metadata is content addressed, repeatable, immutable and independently hash checked on every read',t=>{
  const f=fixture(t),r=f.service.create(input),name=new URL(r.metadataUri).pathname.split('/').at(-1),read=f.service.read(name);assert.equal(name,sha(read.bytes)+'.json');assert.equal(read.contentType,'application/json');assert.deepEqual(JSON.parse(read.bytes),r.metadata);assert.deepEqual(f.service.create(input),r);
  const changed=f.service.create({...input,description:'Changed description'});assert.notEqual(changed.metadataUri,r.metadataUri);assert.deepEqual(f.service.read(name).bytes,read.bytes);
  const target=path.join(f.directory,'public-token-metadata',name);fs.writeFileSync(target,'corrupt');assert.throws(()=>f.service.read(name),/integrity/);assert.throws(()=>f.service.create(input),/integrity/);assert.equal(fs.readFileSync(target,'utf8'),'corrupt');
});
test('uploaded image bytes are content addressed and image type/base64/limits validated',t=>{
  const f=fixture(t),bytes=png(),r=f.service.create({...input,imageUrl:undefined,imageBase64:bytes.toString('base64'),contentType:'image/png'}),name=new URL(r.imageUrl).pathname.split('/').at(-1);assert.equal(name,sha(bytes)+'.png');assert.deepEqual(f.service.read(name).bytes,bytes);
  for(const change of [{contentType:'image/jpeg'},{imageUrl:input.imageUrl},{imageBase64:'<svg/>'},{imageBase64:Buffer.from('this is not valid png content').toString('base64')},{imageBase64:Buffer.alloc(2*1024*1024+1).toString('base64')}])assert.throws(()=>f.service.create({...input,imageUrl:undefined,imageBase64:bytes.toString('base64'),contentType:'image/png',...change}));
});
test('metadata inputs reject path traversal and private/protocol/credential image URL inputs without fetching any URL',t=>{
  const f=fixture(t);for(const url of ['file:///etc/passwd','data:image/png;base64,AAAA','http://images.ropad.com/x','https://127.0.0.1/a','https://localhost/a','https://host.internal/a','https://u:SECRET@images.ropad.com/a','https://images.ropad.com:444/a'])assert.throws(()=>externalImage(url),error=>!error.message.includes('SECRET'));
  for(const name of ['../ropad-config.json','a'.repeat(64)+'.html','%2e%2e%2fprivate','a'.repeat(63)+'.json'])assert.throws(()=>f.service.read(name),error=>error.status===404);
  for(const change of [{name:'x'.repeat(33)},{name:'bad\nname'},{symbol:'space token'},{description:'x'.repeat(2401)}])assert.throws(()=>f.service.create({...input,...change}));
});
