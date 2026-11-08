import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultState,addMissingBuiltins,validateState} from '../src/state.mjs';
import {createAppServer} from '../src/server.mjs';
test('vision is an idle lease job and migration preserves existing choices',()=>{
 const s=defaultState();
 assert.equal(s.workloads.immichvision?.kind,'job');
 assert.equal(s.workloads.immichvision.reserveWhenIdle,false);
 assert.equal(s.workloads.immichvision.fullGpuMiB,2900);
 delete s.workloads.immichvision;s.order=s.order.filter(x=>x!=='immichvision');
 const previous=s.order.slice();s.settings.reservedMiB=1024;
 assert.equal(addMissingBuiltins(s),true);
 assert.deepEqual(s.order.filter(x=>x!=='immichvision'),previous);
 assert.equal(s.settings.reservedMiB,1024);
 assert.equal(validateState(s).ok,true);
});
test('vision lease endpoint is supported without borrowing another job',async()=>{
 let called=false;
 const manager={acquireLease:async opts=>{assert.equal(opts.jobId,'immichvision');called=true;return {ok:true,leaseId:'test'};}};
 const config={localPort:0};
 const server=createAppServer({manager,config,publicDir:'.',authDeps:{}});
 const port=await server.listen(0);config.localPort=port;
 try {
 const r=await fetch(`http://127.0.0.1:${port}/api/leases/immichvision/acquire`,{method:'POST',headers:{'content-type':'application/json',origin:`http://127.0.0.1:${port}`},body:JSON.stringify({holder:'test'})});
 assert.equal(r.status,200);assert.equal(called,true);
 } finally {await server.close();}
});
