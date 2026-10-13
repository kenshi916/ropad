'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createRobloxBuildService,recoverBuildState}=require('./parallax/roblox-builds.cjs');
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'parallax-builder-storage-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const service=createRobloxBuildService({stateDirectory:directory});
  const file=path.join(directory,'roblox-builds','sessions.json');
  const create=(name='Stored game')=>service.create({owner:'fixture-owner',gameName:name,brief:'A small course with checkpoints',template:'obby'});
  return {directory,file,service,create};
}
const unavailable=error=>error.status===503&&error.code==='BUILD_STORAGE_UNAVAILABLE';

test('each committed index has a readable prior-state backup, including its initial save',t=>{
  const f=fixture(t),first=f.create();
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file+'.bak')),JSON.parse(fs.readFileSync(f.file)));
  const before=fs.readFileSync(f.file);f.create('Second game');
  assert.deepEqual(fs.readFileSync(f.file+'.bak'),before);
  const restored=createRobloxBuildService({stateDirectory:f.directory});assert.equal(restored.list().length,2);assert.equal(restored.get(first.id,{owner:'fixture-owner'}).canManage,true);
});

test('corrupt saved history fails closed with a specific operator error and never silently resets',t=>{
  const f=fixture(t);f.create();const corruption=Buffer.alloc(1024);fs.writeFileSync(f.file,corruption);
  const backup=fs.readFileSync(f.file+'.bak');
  assert.throws(()=>createRobloxBuildService({stateDirectory:f.directory}),error=>unavailable(error)&&/backup is available/.test(error.message));
  assert.deepEqual(fs.readFileSync(f.file),corruption);assert.deepEqual(fs.readFileSync(f.file+'.bak'),backup);
  assert.equal(fs.readdirSync(path.dirname(f.file)).filter(name=>name.includes('.archive')).length,0);
});

test('explicit fresh recovery archives the exact corrupted bytes and preserves screen files',t=>{
  const f=fixture(t);f.create();const corruption=Buffer.alloc(13056);fs.writeFileSync(f.file,corruption);
  const oldBackup=fs.readFileSync(f.file+'.bak');const screen=path.join(path.dirname(f.file),'old-build.screen'),frame=Buffer.from('unchanged-screen-fixture');fs.writeFileSync(screen,frame);
  const result=recoverBuildState({stateDirectory:f.directory,mode:'startFresh',now:()=>123456});
  assert.deepEqual(fs.readFileSync(result.archivedFile),corruption);assert.deepEqual(fs.readFileSync(result.archivedBackup),oldBackup);assert.deepEqual(fs.readFileSync(screen),frame);
  const service=createRobloxBuildService({stateDirectory:f.directory});assert.equal(service.list().length,0);assert.deepEqual(service.queueStatus().recovery,{at:123456,mode:'startFresh',previousIndexPreserved:true,previousHistoryUnavailable:true,closedJobs:0});
  assert.doesNotMatch(JSON.stringify(service.queueStatus()),/fixture-owner|\.archive|archivedFile/);
  assert.equal(JSON.parse(fs.readFileSync(f.file+'.bak')).sessions.length,0);
});

test('backup recovery preserves confirmed builds and ownership but closes uncertain queued execution',t=>{
  const f=fixture(t),finished=f.create('Completed scene');f.service.prepare({id:finished.id,owner:'fixture-owner'});f.service.workerPresence({workerId:'worker',studioId:'studio',agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:true});f.service.enqueue({id:finished.id,owner:'fixture-owner'});
  const lease=f.service.claim({workerId:'worker',studioId:'studio'});f.service.report({...lease,status:'ready',objectCount:lease.plan.parts.length+1,playtest:{result:'passed',message:'Fixture runtime smoke check'}});
  const pending=f.create('Waiting scene');f.service.prepare({id:pending.id,owner:'fixture-owner'});f.service.workerPresence({workerId:'next-worker',studioId:'next-studio',agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:true});f.service.enqueue({id:pending.id,owner:'fixture-owner'});
  f.service.workerPresence({workerId:'worker',studioId:'studio'}); // Snapshot the queued state into the last-valid backup.
  const backup=fs.readFileSync(f.file+'.bak');fs.writeFileSync(f.file,Buffer.alloc(100));
  const result=recoverBuildState({stateDirectory:f.directory,mode:'backup'});assert.equal(result.closedJobs,1);assert.deepEqual(fs.readFileSync(result.archivedBackup),backup);
  const service=createRobloxBuildService({stateDirectory:f.directory}),ready=service.get(finished.id,{owner:'fixture-owner'}),stopped=service.get(pending.id,{owner:'fixture-owner'});
  assert.equal(ready.status,'ready');assert.equal(ready.canManage,true);assert.equal(ready.playtestReport.result,'passed');assert.equal(stopped.queue.state,'failed');assert.equal(stopped.queue.failureReason,'storage_recovery');assert.equal(stopped.status,'failed');assert.equal(stopped.canManage,true);
  assert.equal(service.queueStatus().workers.length,0);assert.equal(service.claim({workerId:'worker',studioId:'studio'}),null);assert.throws(()=>service.enqueue({id:pending.id,owner:'fixture-owner'}),/closed/);
});

test('recovery refuses a healthy primary and never substitutes an invalid backup',t=>{
  const f=fixture(t);f.create();const before=fs.readFileSync(f.file);
  assert.throws(()=>recoverBuildState({stateDirectory:f.directory,mode:'startFresh'}),error=>error.status===409);assert.deepEqual(fs.readFileSync(f.file),before);
  const corruption=Buffer.alloc(40);fs.writeFileSync(f.file,corruption);fs.writeFileSync(f.file+'.bak','{"version":1,"sessions":[{}]}');
  assert.throws(()=>recoverBuildState({stateDirectory:f.directory,mode:'backup'}),unavailable);assert.deepEqual(fs.readFileSync(f.file),corruption);assert.equal(fs.readdirSync(path.dirname(f.file)).filter(name=>name.includes('.archive')).length,0);
});

test('a failed fsync preserves the committed index and halts the in-memory service',t=>{
  const f=fixture(t);f.create();const primary=fs.readFileSync(f.file),backup=fs.readFileSync(f.file+'.bak');
  const original=fs.fsyncSync;let flushes=0;
  try{fs.fsyncSync=()=>{flushes++;throw Object.assign(new Error('Fixture disk flush failure'),{code:'EIO'});};assert.throws(()=>f.create('Uncommitted game'),unavailable);}finally{fs.fsyncSync=original;}
  assert.equal(flushes,1);assert.deepEqual(fs.readFileSync(f.file),primary);assert.deepEqual(fs.readFileSync(f.file+'.bak'),backup);assert.equal(fs.readdirSync(path.dirname(f.file)).filter(name=>name.endsWith('.tmp')).length,0);
  assert.throws(()=>f.service.list(),unavailable);assert.equal(createRobloxBuildService({stateDirectory:f.directory}).list().length,1);
});

test('a running service never replaces a corrupt disk index or overwrites its valid backup',t=>{
  const f=fixture(t);f.create();const backup=fs.readFileSync(f.file+'.bak'),corruption=Buffer.alloc(91);fs.writeFileSync(f.file,corruption);
  assert.throws(()=>f.create('Would overwrite corrupted history'),unavailable);assert.deepEqual(fs.readFileSync(f.file),corruption);assert.deepEqual(fs.readFileSync(f.file+'.bak'),backup);assert.throws(()=>f.service.queueStatus(),unavailable);
});

test('a missing primary with an existing backup is not mistaken for a new empty installation',t=>{
  const f=fixture(t);f.create();fs.unlinkSync(f.file);
  assert.throws(()=>createRobloxBuildService({stateDirectory:f.directory}),unavailable);assert.equal(fs.existsSync(f.file),false);
});
