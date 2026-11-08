const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const SP = require('../src/splat.js');

// Explicit GL command recorder, not a browser/GPU or a performance measurement.
class RecordingGL {
  constructor() {
    for (const [i,k] of ['VERTEX_SHADER','FRAGMENT_SHADER','COMPILE_STATUS','LINK_STATUS','ARRAY_BUFFER','STATIC_DRAW','DYNAMIC_DRAW','FLOAT','INT','TEXTURE_2D','TEXTURE_MIN_FILTER','TEXTURE_MAG_FILTER','NEAREST','TEXTURE_WRAP_S','TEXTURE_WRAP_T','CLAMP_TO_EDGE','RGBA32UI','RGBA_INTEGER','UNSIGNED_INT','MAX_TEXTURE_SIZE','TEXTURE0','DEPTH_TEST','BLEND','SRC_ALPHA','ONE_MINUS_SRC_ALPHA','TRIANGLE_FAN'].entries()) this[k]=i+1;
    this.calls=[];
  }
  createShader(){return{};} shaderSource(){} compileShader(){} getShaderParameter(){return true;} deleteShader(){}
  createProgram(){return{};} attachShader(){} linkProgram(){} getProgramParameter(){return true;} getUniformLocation(_,k){return k;}
  createVertexArray(){return{};} bindVertexArray(){} createBuffer(){return{};} bindBuffer(){}
  bufferData(_,value){this.calls.push(['bufferData',typeof value==='number'?value:value.byteLength]);}
  bufferSubData(_,offset,data){this.indices=Int32Array.from(data);this.calls.push(['bufferSubData',offset,data.length]);}
  getAttribLocation(_,name){return name==='a_pos'?0:1;} enableVertexAttribArray(){} vertexAttribPointer(){} vertexAttribIPointer(){} vertexAttribDivisor(){}
  createTexture(){return{};} bindTexture(){} texParameteri(){}
  texImage2D(...a){this.texture=Uint32Array.from(a[8]);this.textureWidth=a[3];this.textureHeight=a[4];}
  getParameter(){return 4096;} useProgram(){} activeTexture(){} uniform1i(){} uniformMatrix4fv(){} uniform2f(){} uniform1f(){}
  enable(k){this.calls.push(['enable',k]);} disable(k){this.calls.push(['disable',k]);} depthMask(x){this.calls.push(['depthMask',x]);} blendFunc(){}
  drawArraysInstanced(_,first,count,n){this.calls.push(['draw',first,count,n]);}
  deleteTexture(){this.calls.push(['deleteTexture']);} deleteBuffer(){this.calls.push(['deleteBuffer']);} deleteVertexArray(){} deleteProgram(){}
}
global.WebGL2RenderingContext=RecordingGL;
function cloud(n, position = i => [i % 17, Math.floor(i / 17) % 13, i / 221]) {
  const d={n,pos:new Float32Array(n*3),scale:new Float32Array(n*3),rot:new Float32Array(n*4),rgba:new Uint8Array(n*4),format:'test cloud'};
  for(let i=0;i<n;i++) {
    d.pos.set(position(i),i*3);d.scale.set([.01+(i%7)*.003,.02+(i%5)*.002,.03+(i%3)*.005],i*3);
    const a=i*.023;d.rot.set([Math.sin(a)/Math.sqrt(3),Math.sin(a)/Math.sqrt(3),Math.sin(a)/Math.sqrt(3),Math.cos(a)],i*4);
    d.rgba.set([i%256,(i*7)%256,(i*11)%256,100+i%156],i*4);
  }
  return d;
}
const hash=d=>{const h=crypto.createHash('sha256');for(const k of ['pos','scale','rot','rgba'])h.update(new Uint8Array(d[k].buffer,d[k].byteOffset,d[k].byteLength));return h.digest('hex');};
const cell=(d,i,b)=>{let code=0;for(let a=0;a<3;a++){const span=b.max[a]-b.min[a];const q=span?Math.max(0,Math.min(31,Math.floor((d.pos[i*3+a]-b.min[a])/span*32))):0;for(let j=0;j<5;j++)code|=((q>>>j)&1)<<(3*j+a);}return code;};
const ID=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);

test('spatial hierarchy covers sparse far octants before filling a dense foreground; all budgets are deterministic prefixes',()=>{
  const d=cloud(10008,i=>i<10000?[.1+(i%100)/2000,.1+Math.floor(i/100)/2000,.1]:[(i-10000)&1?100:0,(i-10000)&2?100:0,(i-10000)&4?100:0]);
  const before=hash(d),a=SP.createLOD(d),b=SP.createLOD(d);
  assert.deepEqual(a.order,b.order);assert.equal(new Set(a.order).size,d.n);
  assert.equal(a.occupiedOctants,8);
  for(const depth of [1,2,3,4,5]) {
    const shift=3*(5-depth),expected=new Set(Array.from({length:d.n},(_,i)=>cell(d,i,a.bounds)>>>shift));
    // At most one new representative per occupied region at each level, with all ancestors retained.
    let prefix=0;for(let level=1;level<=depth;level++)prefix+=new Set(Array.from({length:d.n},(_,i)=>cell(d,i,a.bounds) >>> (3*(5-level)))).size;
    const found=new Set(Array.from(a.order.slice(0,Math.min(prefix,a.occupiedCells)),i=>cell(d,i,a.bounds)>>>shift));
    assert.deepEqual(found,expected);
  }
  assert.equal(new Set(Array.from(a.order.slice(0,8),i=>cell(d,i,a.bounds)>>>12)).size,8);
  assert.equal(new Set(Array.from(a.order.slice(0,a.occupiedCells),i=>cell(d,i,a.bounds))).size,a.occupiedCells);
  assert.equal(hash(d),before);assert.equal(a.persistentBytes,d.n*4);
  assert.ok(a.buildPeakBytes<d.n*8+600000);
});
test('degenerate coincident and flat clouds still select every original point exactly once',()=>{
  for(const d of [cloud(1,()=>[0,0,0]),cloud(1001,()=>[3,-2,7]),cloud(1025,i=>[i,0,0])]) {
    const a=SP.createLOD(d);assert.equal(a.order.length,d.n);assert.equal(new Set(a.order).size,d.n);assert.ok(Array.from(a.order).every(i=>i<d.n));
  }
  const opaque=cloud(100,()=>[1,1,1]);for(let i=0;i<100;i++)opaque.rgba[i*4+3]=0;opaque.rgba[77*4+3]=255;
  assert.equal(SP.createLOD(opaque).order[0],77);
});
test('renderer budget switches preserve exact packed position, RGBA, covariance/rotation and original cloud',()=>{
  const d=cloud(420),before=hash(d),gl=new RecordingGL(),w=new SP.SplatWorld(gl,{pointBudget:420,maxActivePoints:420});
  w.setPlacement({flip:false,scale:1,yaw:.4,x:2,y:3,z:-4});w.setData(d);
  const fullSelection=w.getSelection(),fullTexture=gl.texture.slice(),layout=w.stats();
  const floats=new Float32Array(fullTexture.buffer),P=w.place,cy=Math.cos(P.yaw),sy=Math.sin(P.yaw);
  for(let i=0;i<d.n;i++) {
    const j=fullSelection[i],p=Array.from(d.pos.subarray(j*3,j*3+3));
    assert.equal(floats[i*8],Math.fround(cy*p[0]+sy*p[2]+P.x));assert.equal(floats[i*8+1],Math.fround(p[1]+P.y));assert.equal(floats[i*8+2],Math.fround(-sy*p[0]+cy*p[2]+P.z));
    assert.equal(fullTexture[i*8+7],(d.rgba[j*4]|d.rgba[j*4+1]<<8|d.rgba[j*4+2]<<16|d.rgba[j*4+3]<<24)>>>0);
    // Independent matrix-product reference ties quaternion and scale to the selected SOURCE index.
    const [x,y,z,q]=d.rot.subarray(j*4,j*4+4),s=d.scale.subarray(j*3,j*3+3);
    const rotation=[[1-2*(y*y+z*z),2*(x*y-q*z),2*(x*z+q*y)],[2*(x*y+q*z),1-2*(x*x+z*z),2*(y*z-q*x)],[2*(x*z-q*y),2*(y*z+q*x),1-2*(x*x+y*y)]];
    const placement=[[cy,0,sy],[0,1,0],[-sy,0,cy]];
    const m=placement.map(row=>[0,1,2].map(c=>row.reduce((sum,v,k)=>sum+v*rotation[k][c],0)*s[c]));
    const cov=m.map(row=>m.map(other=>row.reduce((sum,v,k)=>sum+v*other[k],0)));
    const pack=(a,b)=>(SP.toHalf(a)|(SP.toHalf(b)<<16))>>>0;
    assert.equal(fullTexture[i*8+4],pack(cov[0][0],cov[0][1]));assert.equal(fullTexture[i*8+5],pack(cov[0][2],cov[1][1]));assert.equal(fullTexture[i*8+6],pack(cov[1][2],cov[2][2]));
  }
  const progress=[];w.onProgress=event=>progress.push(event);
  for(const n of [8,64,3,200,420]) {
    progress.length=0;
    w.setPointBudget(n);assert.equal(w.n,n);assert.deepEqual(w.getSelection(),fullSelection.slice(0,n));assert.deepEqual(w.stats(),layout);
    assert.deepEqual(progress.map(event=>event.phase),['pack','ready']);
    assert.equal(progress.at(-1).activePoints,n);assert.equal(progress.at(-1).requestedBudget,n);
    // A compacted subset keeps source index correspondence across all 8 packed words.
    for(let i=0;i<n;i++)assert.deepEqual(gl.texture.subarray(i*8,i*8+8),fullTexture.subarray(i*8,i*8+8));
    assert.equal(w.getMetadata().memory.gpuTextureBytes,Math.ceil(n/1024)*32768);
  }
  assert.equal(hash(d),before);assert.equal(w.getMetadata().allocatedPointCapacity,420);
  const external=w.getSelection();external[0]=99999;assert.notEqual(w.getSelection()[0],99999);
});
test('depth ordering only reorders the spatial subset and draw keeps mesh depth layering',()=>{
  const gl=new RecordingGL(),w=new SP.SplatWorld(gl,{pointBudget:73});w.setPlacement({flip:false});w.setData(cloud(1100));
  const selected=w.getSelection(),keyStorage=w.keys;
  const cam={view:ID,proj:ID,fov:Math.PI/3},renderer={w:800,h:600,pr:{}};
  w.draw(cam,renderer);assert.equal(gl.indices.length,73);assert.equal(new Set(gl.indices).size,73);
  for(let i=1;i<gl.indices.length;i++)assert.ok(w.wpos[gl.indices[i-1]*3+2]<=w.wpos[gl.indices[i]*3+2]);
  const reverse=ID.slice();reverse[10]=-1;w.sort(reverse);assert.deepEqual(w.getSelection(),selected);assert.equal(w.keys,keyStorage);
  assert.ok(gl.calls.some(c=>c[0]==='draw'&&c[3]===73));
  const lastDraw=gl.calls.findLastIndex(c=>c[0]==='draw');assert.ok(gl.calls.slice(0,lastDraw).some(c=>c[0]==='depthMask'&&c[1]===false));assert.ok(gl.calls.slice(lastDraw).some(c=>c[0]==='depthMask'&&c[1]===true));
  assert.ok(gl.calls.some(c=>c[0]==='enable'&&c[1]===gl.DEPTH_TEST));
});
test('sustained frame time downgrades with windows/cooldown, ignores isolated pauses, and manual quality restores original prefix',()=>{
  const gl=new RecordingGL(),w=new SP.SplatWorld(gl,{pointBudget:1000});w.setData(cloud(1200));
  const full=w.getSelection();w.setAutoLOD({enabled:true,targetMs:30,minPoints:100,window:5,slowWindows:2,cooldownFrames:10,factor:.5});
  assert.equal(w.observeFrame(5000),false);for(let i=0;i<5;i++)assert.equal(w.observeFrame(50),false);for(let i=0;i<5;i++)assert.equal(w.observeFrame(20),false);assert.equal(w.n,1000);
  for(let i=0;i<9;i++)assert.equal(w.observeFrame(50),false);assert.equal(w.observeFrame(50),true);assert.equal(w.n,500);
  for(let i=0;i<10;i++)assert.equal(w.observeFrame(100),false);assert.equal(w.n,500);
  assert.deepEqual(w.getSelection(),full.slice(0,500));assert.equal(w.getMetadata().autoLOD.lastMeanMs,50);
  w.setPointBudget(1000);assert.deepEqual(w.getSelection(),full);assert.equal(w.n,1000);
  assert.throws(()=>w.setAutoLOD({factor:1}),/参数/);
});
test('limits, malformed data and disposal are explicit; failed source validation keeps old usable data',async()=>{
  const gl=new RecordingGL(),w=new SP.SplatWorld(gl,{pointBudget:100,maxActivePoints:25});const d=cloud(100);w.setData(d);assert.equal(w.n,25);
  assert.equal(w.getMetadata().requestedBudget,100);assert.throws(()=>w.setPointBudget(0));assert.throws(()=>w.setPlacement({scale:NaN}));
  const broken=cloud(10);broken.pos[0]=NaN;assert.throws(()=>w.setData(broken));assert.equal(w.src,d);
  assert.throws(()=>SP.createLOD({...cloud(10),n:11}));assert.throws(()=>SP.createLOD(cloud(10),{maxSourcePoints:9}));
  await assert.rejects(()=>SP.decode(new ArrayBuffer(33),'bad.splat'),/长度/);
  await assert.rejects(()=>SP.decode(new ArrayBuffer(32),'large.splat',{maxInputBytes:16}),/预算/);
  const gz=zlib.gzipSync(Buffer.alloc(128));await assert.rejects(()=>SP.gunzip(gz.buffer.slice(gz.byteOffset,gz.byteOffset+gz.byteLength),32),/预算/);
  w.dispose();assert.equal(w.getMetadata().activePoints,0);assert.equal(w.getMetadata().memory.cpuWorkingBytes,0);assert.throws(()=>w.setData(d),/释放/);w.dispose();
});
test('loader reports decode/select/pack/ready phases without changing source attributes',async()=>{
  const packed=new ArrayBuffer(32*3),dv=new DataView(packed),u8=new Uint8Array(packed);
  for(let i=0;i<3;i++){dv.setFloat32(i*32,i,true);for(let j=0;j<3;j++)dv.setFloat32(i*32+12+j*4,.1,true);u8.set([100,150,200,255,255,128,128,128],i*32+24);}
  const phases=[],w=new SP.SplatWorld(new RecordingGL(),{pointBudget:2});
  const meta=await w.load(packed,'small.splat',{onProgress:m=>phases.push(m.phase)});
  assert.equal(meta.sourcePoints,3);assert.equal(meta.activePoints,2);assert.equal(meta.inputBytes,96);assert.ok(meta.decodeMs>=0&&meta.selectionMs>=0&&meta.packMs>=0);
  for(const p of ['loading','decode','decoded','select','pack','ready'])assert.ok(phases.includes(p));
});
test('a later source or disposal cancels an outstanding async load',async()=>{
  const w=new SP.SplatWorld(new RecordingGL());
  const pending=w.load(new ArrayBuffer(32),'old.splat');w.setData(cloud(3));await assert.rejects(()=>pending,/替换/);assert.equal(w.src.n,3);
  const disposed=w.load(new ArrayBuffer(32),'old.splat');w.dispose();await assert.rejects(()=>disposed,/释放/);
});
const official=path.join(__dirname,'../artifacts/splat-check/official-v3/official-v3.spz');
test('optional local real official-encoded v3: all attrs unchanged, 500k source with reversible 1k/8k renderer packing', {skip:!fs.existsSync(official)}, async t=>{
  const bytes=fs.readFileSync(official),ab=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),'07ce1f1fd0472c4cf2285b7ff2c4d3841940900fd7a56d346a045f71322aa696');
  const d=await SP.decode(ab,'official-v3.spz'),before=hash(d),gl=new RecordingGL(),w=new SP.SplatWorld(gl,{pointBudget:8000});
  const meta=w.setData(d),top=w.getSelection(),packed=gl.texture.slice();
  assert.equal(d.n,500000);assert.equal(d.format,'SPZ v3');assert.equal(meta.sourcePoints,500000);assert.equal(meta.activePoints,8000);
  w.setPointBudget(1000);assert.deepEqual(w.getSelection(),top.slice(0,1000));w.setPointBudget(8000);assert.deepEqual(gl.texture,packed);assert.equal(hash(d),before);
  t.diagnostic(JSON.stringify({sourcePoints:d.n,activePoints:w.n,decodeMs:meta.decodeMs,selectMs:meta.selectionMs,packMs:meta.packMs,coverage:meta.selection,memory:meta.memory}));
});
