'use strict';
// A changed or damaged ledger is never replaced by a stale in-memory copy.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function createFundingStore({directory,name,initial,validate}) {
  if(typeof directory!=='string'||!directory)throw new Error('A private durable funding directory is required');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});const file=path.join(directory,name);let state=structuredClone(initial),digest=null,fault=false;
  const failed=()=>Object.assign(new Error('Funding history is unreadable or changed; operations are paused and existing files are preserved'),{status:503,code:'FUNDING_STORAGE_UNAVAILABLE'});
  if(fs.existsSync(file)){try{const bytes=fs.readFileSync(file);state=JSON.parse(bytes);validate(state);digest=hash(bytes);}catch{throw failed();}}
  function check(){if(fault)throw failed();try{if((fs.existsSync(file)?hash(fs.readFileSync(file)):null)!==digest)throw Error();}catch{fault=true;throw failed();}}
  function read(){check();return structuredClone(state);}
  function write(next){check();validate(next);const temporary=file+'.'+crypto.randomUUID()+'.tmp';let fd;
    try{const bytes=JSON.stringify(next);fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,file);digest=hash(bytes);state=structuredClone(next);}
    catch{fault=true;throw failed();}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  }
  return {read,write};
}
module.exports={createFundingStore,hash};
