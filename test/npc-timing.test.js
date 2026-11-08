const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/npc-timing.js');

test('waiting audio, service reply, frame and answer audio have separate clocks; none becomes model first token', () => {
  let at = 100; const timing = create({ clock: () => at });
  const turn = timing.begin({ role:'dragon',kind:'question' });
  at = 1000; turn.cueRequested(); at = 1100; turn.speechStarted('cue');
  at = 2200; turn.received({ source:'llm',latencyMs:2000 }); turn.speechFinished('cue',{reason:'cancelled'});
  at = 2232; turn.frame(); at = 2300; turn.speechStarted('answer');
  at = 3000; turn.speechFinished('answer',{reason:'ended'});
  assert.deepEqual(timing.snapshot()[0], {id:1,kind:'question',role:'dragon',status:'rendered',source:'llm',responseReceivedMs:2100,serverMs:2000,answerFrameMs:2132,cueRequestedMs:900,cueSpeechStartMs:1000,cueSpeechResult:'cancelled',answerSpeechStartMs:2200,answerSpeechResult:'ended',cancelledMs:null,cancelReason:null,modelFirstTokenMs:null,streaming:false});
});

test('cancelled or unpainted replies cannot be counted as visible answers', () => {
  let at = 0;const timing=create({clock:()=>at});const cancelled=timing.begin();
  at=50;cancelled.cancel('dialog_closed');at=200;cancelled.received({source:'llm'});cancelled.frame();cancelled.speechStarted('cue');
  const hidden=timing.begin();at=300;hidden.received({source:'script'});
  assert.equal(timing.snapshot()[0].answerFrameMs,null);assert.equal(timing.snapshot()[0].cueSpeechStartMs,null);
  assert.equal(timing.snapshot()[1].status,'received');assert.equal(timing.snapshot()[1].answerFrameMs,null);
});

test('diagnostics are bounded, detached and do not capture arbitrary content or error messages', () => {
  let at=0;const timing=create({clock:()=>at,capacity:2});
  for(let i=0;i<3;i++){const row=timing.begin({role:'private-name',kind:'secret question',text:'secret'});at+=10;row.received({source:'untrusted secret',latencyMs:NaN,zh:'secret answer'});row.speechFinished('answer',{reason:'secret error'});row.frame();}
  const rows=timing.snapshot();assert.deepEqual(rows.map(r=>r.id),[2,3]);assert.ok(!JSON.stringify(rows).includes('secret'));
  rows[0].source='mutated';assert.equal(timing.snapshot()[0].source,'unknown');timing.clear();assert.deepEqual(timing.snapshot(),[]);
});

test('a backwards or invalid clock produces unknown time instead of a false fast result', () => {
  let at=100;const timing=create({clock:()=>at});const row=timing.begin();
  at=99;row.cueRequested();at=NaN;row.received({source:'llm',latencyMs:-1});row.frame();
  const result=timing.snapshot()[0];assert.equal(result.cueRequestedMs,null);assert.equal(result.answerFrameMs,null);assert.equal(result.serverMs,null);
});

test('submission time includes synchronous UI and checking work before the request begins', () => {
  let at=150;const timing=create({clock:()=>at});const row=timing.begin({submittedAt:100});
  at=300;row.received({source:'script'});at=320;row.frame();
  assert.equal(timing.snapshot()[0].responseReceivedMs,200);assert.equal(timing.snapshot()[0].answerFrameMs,220);
});
