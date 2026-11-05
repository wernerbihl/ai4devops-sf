import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoordinator } from '../../src/service/coordinator.ts';
import { createFixture } from '../helpers/store.ts';
const flush=async()=>{await Promise.resolve();await Promise.resolve()};

test('running takt follows shorter and longer current settings without replay and preserves deadline timer',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const f=createFixture();let dispatches=0;let controls=0;
 const change=(seconds:number)=>f.store.patchSettings({taktSeconds:seconds},f.store.getSettings().revision);
 change(100);
 const coordinator=createCoordinator({taktMs:()=>f.store.getSettings().config.taktSeconds*1000,controlMs:5,dispatch:async()=>{dispatches++},control:async()=>{controls++},reconcile:async()=>{}});
 try{
  coordinator.start();await flush();assert.equal(dispatches,1);
  t.mock.timers.tick(40);await flush();change(1);t.mock.timers.tick(5);await flush();
  t.mock.timers.tick(999);await flush();assert.equal(dispatches,1);
  t.mock.timers.tick(1);await flush();assert.equal(dispatches,2);
  change(2);t.mock.timers.tick(5);await flush();const priorControls=controls;
  t.mock.timers.tick(1999);await flush();assert.equal(dispatches,2,'old shorter timer must be cancelled');
  t.mock.timers.tick(1);await flush();assert.equal(dispatches,3);assert.ok(controls>priorControls,'rescheduling must not replace the deadline lane');
 }finally{coordinator.stop();f.close()}
});

test('takt changes during hung dispatch discard elapsed opportunities and never burst when it completes',async t=>{
 t.mock.timers.enable({apis:['setInterval']});let taktMs=100;let dispatches=0;let controls=0;let release!:()=>void;
 const hung=new Promise<void>(resolve=>{release=resolve});
 const coordinator=createCoordinator({taktMs:()=>taktMs,controlMs:5,dispatch:async()=>{dispatches++;if(dispatches===1)await hung},control:async()=>{controls++},reconcile:async()=>{}});
 try{
  coordinator.start();await flush();t.mock.timers.tick(1000);await flush();assert.equal(dispatches,1);assert.ok(controls>0);
  taktMs=20;t.mock.timers.tick(5);await flush();t.mock.timers.tick(1000);await flush();assert.equal(dispatches,1);
  release();await flush();assert.equal(dispatches,1,'completing old dispatch must not replay missed ticks');
  t.mock.timers.tick(19);await flush();assert.equal(dispatches,1);t.mock.timers.tick(1);await flush();assert.equal(dispatches,2);
 }finally{release();coordinator.stop()}
});

test('paused settings changes and stop/resume create only current admission opportunities',async t=>{
 t.mock.timers.enable({apis:['setInterval']});let taktMs=100;let paused=true;let admitted=0;const triggers:string[]=[];
 const coordinator=createCoordinator({taktMs:()=>taktMs,controlMs:5,dispatch:async trigger=>{triggers.push(trigger);if(!paused)admitted++},control:async()=>{},reconcile:async()=>{}});
 try{
  coordinator.start();await flush();taktMs=20;t.mock.timers.tick(5);await flush();t.mock.timers.tick(1000);await flush();assert.equal(admitted,0);
  paused=false;await flush();assert.equal(admitted,0);t.mock.timers.tick(19);await flush();assert.equal(admitted,0);t.mock.timers.tick(1);await flush();assert.equal(admitted,1);
  coordinator.stop();taktMs=50;t.mock.timers.tick(1000);await flush();assert.equal(admitted,1);
  coordinator.start();await flush();assert.equal(admitted,2);assert.equal(triggers.at(-1),'resume');
  t.mock.timers.tick(49);await flush();assert.equal(admitted,2);t.mock.timers.tick(1);await flush();assert.equal(admitted,3);
 }finally{coordinator.stop()}
});
