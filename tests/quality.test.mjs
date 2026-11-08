import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMissingBuiltins, defaultState, validateState } from '../src/state.mjs';
test('quality models gain separate idle job ids without disturbing saved choices', () => {
 const state=defaultState();
 assert.ok(state.workloads.ltxvideo.fullGpuMiB >= 1600, 'full encoder pipeline needs more than the old800MiB estimate');
 assert.ok(state.workloads.flux2);
 assert.ok(state.workloads.sdxl);
 assert.ok(state.workloads.ltx098);
 for(const id of ['flux2','sdxl','ltx098']) {assert.equal(state.workloads[id].kind,'job');assert.equal(state.workloads[id].reserveWhenIdle,false);}
 state.order=['lfm3','ltxvideo','sd15','musetalk',...state.order.filter(x=>['flux2','sdxl','ltx098','immichvision'].includes(x))];
 for (const id of ['flux2','sdxl','ltx098']) {delete state.workloads[id];state.order=state.order.filter(x=>x!==id);}
 state.workloads.sd15.fullGpuMiB=1999; state.settings.reservedMiB=1024;
 assert.equal(addMissingBuiltins(state),true);
 assert.deepEqual(state.order.slice(0,4),['lfm3','ltxvideo','sd15','musetalk']);
 assert.equal(state.workloads.sd15.fullGpuMiB,1999);
 assert.equal(state.settings.reservedMiB,1024);
 assert.equal(validateState(state).ok,true);
 assert.equal(addMissingBuiltins(state),false);
});
