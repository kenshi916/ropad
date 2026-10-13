'use strict';
const crypto=require('node:crypto');

// A single provider request must pass all three limits before it can begin.
// Settlement is attempted once in each ledger even if another ledger fails.
function createBuildCompute({input,ledger,provider,reserveDaily,settleDaily,recordSettlement,completeSettlement,failSettlement}){
  const projectId=input.build.lineage?.projectId||input.build.id;
  const operationId=input.operationId||crypto.randomUUID();
  let held=false,settled=false,estimate,releaseDaily,releaseRun,released=false,runReserved=false;
  function settle(reservation,actual){
    if(!held||settled)return;
    settled=true;let firstError;
    for(const commit of [()=>recordSettlement?.({operationId,projectId,buildId:input.build.id,estimateUsd:estimate,actualUsd:actual}),()=>ledger.settle({operationId,actualUsd:actual}),()=>{if(runReserved)input.settle?.(estimate,actual);},()=>settleDaily(estimate,actual,operationId)]){
      try{commit();}catch(error){firstError??=error;}
    }
    if(!firstError){try{completeSettlement?.(operationId);}catch(error){firstError=error;}}
    if(firstError){try{failSettlement?.(operationId);}catch{}throw firstError;}
  }
  return {
    reserve(amount){
      if(held||released)throw Object.assign(new Error('This compute operation has already been reserved'),{status:409});
      releaseDaily=reserveDaily(amount,operationId);estimate=amount;
      try{
        ledger.reserve({projectId,buildId:input.build.id,operationId,purpose:input.purpose||'planning',estimateUsd:amount,provider});
      }catch(error){try{settleDaily(amount,0,operationId);}finally{releaseDaily();released=true;}throw error;}
      held=true;
      try{releaseRun=input.reserve?.(amount);runReserved=!!input.reserve;}catch(error){try{settle(amount,0);}finally{releaseDaily();released=true;}throw error;}
      return ()=>{
        if(released)return;released=true;
        try{if(!settled)settle(amount,null);}finally{try{releaseRun?.();}finally{releaseDaily();}}
      };
    },
    settle
  };
}
module.exports={createBuildCompute};
