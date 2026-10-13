'use strict';
// A local request needs the local Host, not Docker's service hostname: the
// server rejects unrecognized Host headers before routing /api/health.
const port=Number(process.env.PORT||61281);
if(!Number.isInteger(port)||port<1||port>65535)process.exit(1);
fetch('http://127.0.0.1:'+port+'/api/health',{headers:{Host:'127.0.0.1:'+port},redirect:'error',signal:AbortSignal.timeout(4000)})
  .then(async r=>{if(!r.ok)throw Error();const body=await r.json();if(body.ok!==true||body.service!=='ropad')throw Error();})
  .catch(()=>{process.exitCode=1;});
