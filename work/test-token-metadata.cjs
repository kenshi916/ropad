'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createTokenMetadataService,externalImage}=require('./parallax/token-metadata.cjs');
function fixture(t,options={}){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ropad-token-metadata-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return {directory,service:createTokenMetadataService({stateDirectory:directory,publicOrigin:'https://ropad.com',...options})};}
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

test('wallet rate limit survives restart, isolates creators and never blocks an existing hash',t=>{
  let time=100000;const opts={now:()=>time,storageLimits:{uploadsPerMinute:2}},f=fixture(t,opts),owner='1'.repeat(32),other='2'.repeat(32);
  const first=f.service.create(input,{owner});f.service.create({...input,description:'second'},{owner});
  const restarted=createTokenMetadataService({stateDirectory:f.directory,publicOrigin:'https://ropad.com',...opts});
  assert.throws(()=>restarted.create({...input,description:'third'},{owner}),e=>e.status===429&&/Wait a minute/.test(e.message));
  assert.deepEqual(restarted.create(input,{owner}),first);assert.doesNotThrow(()=>restarted.create({...input,description:'other creator'},{owner:other}));
  time+=60001;assert.doesNotThrow(()=>restarted.create({...input,description:'third'},{owner}));
});

test('per-wallet durable object allowance cannot reset on restart and includes pending writes',t=>{
  const opts={storageLimits:{walletFiles:1}},f=fixture(t,opts),owner='1'.repeat(32),first=f.service.create(input,{owner});
  const filename=new URL(first.metadataUri).pathname.split('/').at(-1);fs.unlinkSync(path.join(f.directory,'public-token-metadata',filename));
  const restarted=createTokenMetadataService({stateDirectory:f.directory,publicOrigin:'https://ropad.com',...opts});
  assert.throws(()=>restarted.create({...input,description:'new object'},{owner}),e=>e.status===429&&/wallet/.test(e.message));
  assert.deepEqual(restarted.create(input,{owner}),first);assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,'token-metadata-usage.json'),'utf8')).uploads.length,1);
  assert.doesNotThrow(()=>restarted.create({...input,description:'second wallet'},{owner:'2'.repeat(32)}));
});

test('global quota counts pre-existing untracked files and fails before writing any upload objects',t=>{
  const f=fixture(t,{storageLimits:{globalBytes:100}}),directory=path.join(f.directory,'public-token-metadata');fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'legacy.bin'),Buffer.alloc(100));
  assert.throws(()=>f.service.create(input,{owner:'1'.repeat(32)}),e=>e.status===429&&/storage is full/.test(e.message));
  assert.deepEqual(fs.readdirSync(directory),['legacy.bin']);assert.equal(fs.existsSync(path.join(f.directory,'token-metadata-usage.json')),false);
});

test('global file cap includes every wallet and preserves existing hash reuse',t=>{
  const f=fixture(t,{storageLimits:{globalFiles:1}}),first=f.service.create(input,{owner:'1'.repeat(32)});
  assert.throws(()=>f.service.create({...input,description:'another wallet'},{owner:'2'.repeat(32)}),e=>e.status===429);
  assert.deepEqual(f.service.create(input,{owner:'2'.repeat(32)}),first);assert.deepEqual(f.service.create(input),first);
});

test('image and metadata are reserved together so wallet byte limits leave no orphan upload',t=>{
  const f=fixture(t,{storageLimits:{walletBytes:300}}),bytes=Buffer.alloc(512);png().copy(bytes);
  assert.throws(()=>f.service.create({...input,imageUrl:undefined,imageBase64:bytes.toString('base64'),contentType:'image/png'},{owner:'1'.repeat(32)}),e=>e.status===429);
  assert.equal(fs.existsSync(path.join(f.directory,'public-token-metadata')),false);
});

test('quota journal corruption blocks new objects but preserves existing metadata and idempotent recovery',t=>{
  const f=fixture(t),first=f.service.create(input,{owner:'1'.repeat(32)}),journal=path.join(f.directory,'token-metadata-usage.json');fs.writeFileSync(journal,'damaged quota journal');
  assert.throws(()=>f.service.create({...input,description:'new object'},{owner:'1'.repeat(32)}),e=>e.status===503&&/quota history/.test(e.message));
  assert.deepEqual(f.service.create(input,{owner:'1'.repeat(32)}),first);assert.equal(fs.readFileSync(journal,'utf8'),'damaged quota journal');
});

test('quota reservation failures do not write image bytes or metadata',t=>{
  const f=fixture(t);fs.mkdirSync(path.join(f.directory,'token-metadata-usage.json'));
  assert.throws(()=>f.service.create(input,{owner:'1'.repeat(32)}),e=>e.status===503);assert.equal(fs.existsSync(path.join(f.directory,'public-token-metadata')),false);
});

function crashWriter(directory,phase,options={}){
  const script=`
    const fs=require('node:fs'),path=require('node:path');
    const [modulePath,directory,phase,serializedInput,serializedOptions]=process.argv.slice(1);
    const originalOpen=fs.openSync,originalWrite=fs.writeFileSync,originalLink=fs.linkSync;let stageFd;
    fs.openSync=function(file,...args){const fd=originalOpen.call(fs,file,...args);if(typeof file==='string'&&(phase==='journal'?file.endsWith('token-metadata-usage.json.tmp'):path.basename(file).startsWith('.ropad-upload-')))stageFd=fd;return fd;};
    fs.writeFileSync=function(fd,data,...args){if(fd===stageFd&&phase!=='linked'){originalWrite.call(fs,fd,Buffer.from(data).subarray(0,7));process.exit(77);}return originalWrite.call(fs,fd,data,...args);};
    fs.linkSync=function(from,to){const result=originalLink.call(fs,from,to);if(phase==='linked')process.exit(78);return result;};
    require(modulePath).createTokenMetadataService({stateDirectory:directory,publicOrigin:'https://ropad.com',now:()=>100000,...JSON.parse(serializedOptions)}).create(JSON.parse(serializedInput),{owner:'1'.repeat(32)});
    process.exit(99);
  `;
  const result=require('node:child_process').spawnSync(process.execPath,['-e',script,require.resolve('./parallax/token-metadata.cjs'),directory,phase,JSON.stringify(input),JSON.stringify(options)],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,phase==='linked'?78:77,result.stderr||String(result.error||''));
}

test('a process crash during object writing leaves no partial public hash and retries the same reservation once',t=>{
  const options={storageLimits:{globalFiles:1,walletFiles:1,uploadsPerMinute:1}},f=fixture(t,options),owner='1'.repeat(32),directory=path.join(f.directory,'public-token-metadata'),journal=path.join(f.directory,'token-metadata-usage.json');
  crashWriter(f.directory,'object',options);
  const before=fs.readFileSync(journal),files=fs.readdirSync(directory);assert.equal(files.length,1);assert.match(files[0],/^\.ropad-upload-[a-f0-9]{64}\.json\.tmp$/);assert.equal(fs.statSync(path.join(directory,files[0])).size,7);
  assert.equal(JSON.parse(before).uploads.length,1);
  const restarted=createTokenMetadataService({stateDirectory:f.directory,publicOrigin:'https://ropad.com',...options});
  assert.throws(()=>restarted.create({...input,description:'another wallet cannot bypass pending storage'},{owner:'2'.repeat(32)}),e=>e.status===429);
  const recovered=restarted.create(input,{owner}),name=new URL(recovered.metadataUri).pathname.split('/').at(-1);
  assert.deepEqual(fs.readdirSync(directory),[name]);assert.equal(sha(restarted.read(name).bytes)+'.json',name);assert.deepEqual(fs.readFileSync(journal),before);
  assert.deepEqual(restarted.create(input,{owner}),recovered);assert.deepEqual(fs.readFileSync(journal),before);
});

test('crash after atomic install reuses the complete immutable object and removes only its exact complete stage',t=>{
  const options={storageLimits:{globalFiles:1}},f=fixture(t,options),directory=path.join(f.directory,'public-token-metadata');crashWriter(f.directory,'linked',options);
  const before=fs.readFileSync(path.join(f.directory,'token-metadata-usage.json'));assert.equal(fs.readdirSync(directory).length,2);
  const recovered=f.service.create(input,{owner:'1'.repeat(32)}),name=new URL(recovered.metadataUri).pathname.split('/').at(-1);
  assert.deepEqual(fs.readdirSync(directory),[name]);assert.deepEqual(fs.readFileSync(path.join(f.directory,'token-metadata-usage.json')),before);assert.equal(sha(f.service.read(name).bytes)+'.json',name);
});

test('atomic install never overwrites a conflicting final file that appears during the write',t=>{
  const f=fixture(t),originalLink=fs.linkSync;let final;
  fs.linkSync=(from,to)=>{final=to;fs.writeFileSync(to,'preserve corrupt final');return originalLink(from,to);};
  try{assert.throws(()=>f.service.create(input,{owner:'1'.repeat(32)}),e=>e.status===503&&/integrity/.test(e.message));}finally{fs.linkSync=originalLink;}
  assert.equal(fs.readFileSync(final,'utf8'),'preserve corrupt final');assert.throws(()=>f.service.create(input,{owner:'1'.repeat(32)}),/integrity/);
  assert.deepEqual(fs.readdirSync(path.dirname(final)),[path.basename(final)]);
});

test('repeated crashes during quota saves leave only one bounded stage and recover without duplicate reservations',t=>{
  const f=fixture(t);crashWriter(f.directory,'journal');crashWriter(f.directory,'journal');
  assert.deepEqual(fs.readdirSync(f.directory),['token-metadata-usage.json.tmp']);assert.equal(fs.statSync(path.join(f.directory,'token-metadata-usage.json.tmp')).size,7);
  f.service.create(input,{owner:'1'.repeat(32)});assert.equal(fs.existsSync(path.join(f.directory,'token-metadata-usage.json.tmp')),false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,'token-metadata-usage.json'),'utf8')).uploads.length,1);
});

test('unowned staging debris counts toward capacity and is preserved rather than deleted by a new upload',t=>{
  const f=fixture(t,{storageLimits:{globalBytes:100}}),directory=path.join(f.directory,'public-token-metadata'),name='.ropad-upload-'+('a'.repeat(64))+'.png.tmp';fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,name),Buffer.alloc(100));
  assert.throws(()=>f.service.create(input,{owner:'1'.repeat(32)}),e=>e.status===429);assert.deepEqual(fs.readdirSync(directory),[name]);assert.equal(fs.statSync(path.join(directory,name)).size,100);
});
