const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const E = require('../src/engine.js');
const MODEL = require('../src/model.js');

// A real, decodable 2x2 RGBA PNG: top red/green, bottom blue/white.
function png(alpha = 255) {
  const crc = bytes => { let value = 0xffffffff; for (const b of bytes) { value ^= b; for (let k=0;k<8;k++) value=(value>>>1)^((value&1)?0xedb88320:0); } return (value^0xffffffff)>>>0; };
  const chunk = (name, bytes) => { const type=Buffer.from(name), out=Buffer.alloc(bytes.length+12);out.writeUInt32BE(bytes.length);type.copy(out,4);bytes.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([type,bytes])),out.length-4);return out; };
  const header=Buffer.alloc(13);header.writeUInt32BE(2);header.writeUInt32BE(2,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(Buffer.from([0,255,0,0,alpha,0,255,0,alpha,0,0,0,255,alpha,255,255,255,alpha]))),chunk('IEND',Buffer.alloc(0))]);
}
function pack(json, binary) {
  let source=Buffer.from(JSON.stringify(json));source=Buffer.concat([source,Buffer.alloc((4-source.length%4)%4,32)]);
  const body=Buffer.concat([binary,Buffer.alloc((4-binary.length%4)%4)]), glb=Buffer.alloc(12+8+source.length+8+body.length);
  glb.writeUInt32LE(0x46546c67);glb.writeUInt32LE(2,4);glb.writeUInt32LE(glb.length,8);
  glb.writeUInt32LE(source.length,12);glb.writeUInt32LE(0x4e4f534a,16);source.copy(glb,20);
  const offset=20+source.length;glb.writeUInt32LE(body.length,offset);glb.writeUInt32LE(0x004e4942,offset+4);body.copy(glb,offset+8);
  return glb.buffer.slice(glb.byteOffset,glb.byteOffset+glb.byteLength);
}
function fixture({ transformed = true, nonindexed = false, textured = true, alpha = 255, imageBytes, imageMime = 'image/png', alter = () => {} } = {}) {
  const corners=[[-1,-1,0],[1,-1,0],[1,1,0],[-1,1,0]], coordinates=[[0,1],[1,1],[1,0],[0,0]], order=nonindexed?[0,1,2,0,2,3]:[0,1,2,3];
  const vertices=Buffer.alloc(order.length*32);
  order.forEach((source,i)=>{const at=i*32;corners[source].forEach((v,k)=>vertices.writeFloatLE(v,at+k*4));vertices.writeFloatLE(1,at+20);coordinates[source].forEach((v,k)=>vertices.writeUInt16LE(v*65535,at+24+k*2));vertices.writeUInt32LE(0xaabbccdd,at+28);});
  const indices=Buffer.from([0,1,2,0,2,3,0,0]), image=imageBytes||png(alpha), binary=Buffer.concat([vertices,indices,image]);
  const json={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{translation:transformed?[2,3,4]:[0,0,0],rotation:transformed?[0,0,Math.SQRT1_2,Math.SQRT1_2]:[0,0,0,1],scale:transformed?[2,1,1]:[1,1,1],children:[1]},
    {matrix:[1,0,0,0,0,1,0,0,0,0,1,0,transformed?1:0,0,0,1],mesh:0}],
    buffers:[{byteLength:binary.length}],bufferViews:[{buffer:0,byteOffset:0,byteLength:vertices.length,byteStride:32},
      {buffer:0,byteOffset:vertices.length,byteLength:6},{buffer:0,byteOffset:vertices.length+8,byteLength:image.length}],
    accessors:[{bufferView:0,byteOffset:0,componentType:5126,count:order.length,type:'VEC3'},
      {bufferView:0,byteOffset:12,componentType:5126,count:order.length,type:'VEC3'},
      {bufferView:0,byteOffset:24,componentType:5123,normalized:true,count:order.length,type:'VEC2'},
      {bufferView:1,componentType:5121,count:6,type:'SCALAR'}],
    meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1,TEXCOORD_0:2},...(nonindexed?{}:{indices:3}),material:0}]}],
    materials:[{pbrMetallicRoughness:{baseColorFactor:[1,1,1,1],metallicFactor:0,roughnessFactor:1,...(textured?{baseColorTexture:{index:0}}:{})},extensions:{KHR_materials_unlit:{}}}],
    extensionsUsed:['KHR_materials_unlit'],extensionsRequired:['KHR_materials_unlit'],
    images:[{bufferView:2,mimeType:imageMime}],textures:[{source:0,sampler:0}],samplers:[{magFilter:9728,minFilter:9728,wrapS:33071,wrapT:33071}]};
  alter(json,binary);return {buffer:pack(json,binary),json,binary};
}
const meshOf = model => { let result;model.root.traverse(n=>{if(n.mesh)result=n;});return result; };
const near = (actual, expected, eps=1e-5) => {assert.equal(actual.length,expected.length);actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<eps,`${i}: ${v} != ${expected[i]}`));};
function decoder(log=[]) { return async(bytes,mime)=>{log.push({bytes:Buffer.from(bytes),mime});return{width:2,height:2,close(){log.push('closed');}}; }; }

test('real GLB chunks, interleaved float normals/positions and normalized uint16 UVs preserve hierarchy and tight bounds',async()=>{
  const log=[], model=await MODEL.loadGLB(fixture().buffer,{decodeImage:decoder(log)}), node=meshOf(model);
  near(model.bounds.min,[1,3,4]);near(model.bounds.max,[3,7,4]);near(model.bounds.size,[2,4,0]);
  near(node.mesh.p,[-1,-1,0,1,-1,0,1,1,0,-1,1,0]);near(node.mesh.uv,[0,1,1,1,1,0,0,0]);
  assert.deepEqual([...node.mesh.i],[0,1,2,0,2,3]);assert.equal(node.mesh.i.constructor,Uint16Array);
  near(node.worldPos([-1,-1,0]),[3,3,4]);assert.equal(model.stats.triangles,2);assert.equal(model.stats.vertices,4);assert.equal(model.stats.textures,1);
  assert.equal(log[0].mime,'image/png');assert.deepEqual(log[0].bytes,png());assert.equal(node.material.baseColorTexture.sampler.magFilter,9728);
  const wrapper=MODEL.normalize(model,{height:2});let min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  wrapper.traverse(n=>{if(n.mesh)for(let i=0;i<n.mesh.p.length;i+=3){const v=n.worldPos(n.mesh.p.subarray(i,i+3));for(let k=0;k<3;k++){min[k]=Math.min(min[k],v[k]);max[k]=Math.max(max[k],v[k]);}}});
  near(min,[-.5,0,0]);near(max,[.5,2,0]);
  model.dispose();model.dispose();assert.equal(log.filter(x=>x==='closed').length,1);assert.equal(node.mesh.disposed,true);
});

test('nonindexed triangles and missing normals use flat normals without dropping UV or texture data',async()=>{
  for(const nonindexed of [false,true]){
    const f=fixture({nonindexed,alter:j=>delete j.meshes[0].primitives[0].attributes.NORMAL}),m=await MODEL.loadGLB(f.buffer,{decodeImage:decoder()}),g=meshOf(m).mesh;
    assert.equal(g.i,null);assert.equal(g.count,6);assert.equal(g.uv.length,12);near(g.n,[0,0,1,0,0,1,0,0,1,0,0,1,0,0,1,0,0,1]);assert.equal(m.stats.triangles,2);m.dispose();
  }
});

test('normal, occlusion, emissive and metallic/roughness maps share decoded resources and compute valid tangents',async()=>{
  const log=[],m=await MODEL.loadGLB(fixture({alter:j=>{const mat=j.materials[0];mat.normalTexture={index:0,scale:.5};mat.occlusionTexture={index:0,strength:.4};mat.emissiveTexture={index:0};mat.emissiveFactor=[.1,.2,.3];mat.pbrMetallicRoughness.metallicRoughnessTexture={index:0};mat.alphaMode='MASK';mat.alphaCutoff=.25;mat.doubleSided=true;}}).buffer,{decodeImage:decoder(log)});
  const n=meshOf(m);assert.equal(log.length,1);assert.equal(n.material.normalTexture,n.material.baseColorTexture);assert.equal(n.material.alphaMode,'MASK');assert.equal(n.material.doubleSided,true);
  near(n.mesh.t,[1,0,0,-1,1,0,0,-1,1,0,0,-1,1,0,0,-1]);near(n.emis,[.1,.2,.3]);m.dispose();
});

test('same mesh instantiated twice shares geometry but reports both draw instances and transformed bounds',async()=>{
  const m=await MODEL.loadGLB(fixture({textured:false,transformed:false,alter:j=>{j.nodes[0].children.push(2);j.nodes.push({mesh:0,translation:[10,0,0]});}}).buffer);
  const nodes=[];m.root.traverse(n=>{if(n.mesh)nodes.push(n);});assert.equal(nodes[0].mesh,nodes[1].mesh);assert.equal(m.stats.primitives,2);assert.equal(m.stats.triangles,4);near(m.bounds.min,[-1,-1,0]);near(m.bounds.max,[11,1,0]);m.dispose();
});

test('unused indexed vertices cannot enlarge bounds, shrink normalization or enlarge picking boxes',async()=>{
  const model=await MODEL.loadGLB(fixture({textured:false,transformed:false,alter(j,b){j.accessors[3].count=3;b.writeFloatLE(1000000,3*32+4);}}).buffer);
  const node=meshOf(model);near(model.bounds.min,[-1,-1,0]);near(model.bounds.max,[1,1,0]);near(node.mesh.max,[1,1,0]);
  MODEL.normalize(model,{height:1.35});const ys=[...node.mesh.i].map(i=>node.worldPos(node.mesh.p.subarray(i*3,i*3+3))[1]);
  near([Math.min(...ys),Math.max(...ys)],[0,1.35]);model.dispose();
});

test('normalized uint8 RGBA vertex colors use accessor offsets and interleaved stride',async()=>{
  const model=await MODEL.loadGLB(fixture({textured:false,alter:j=>{j.accessors.push({bufferView:0,byteOffset:28,componentType:5121,count:4,type:'VEC4',normalized:true});j.meshes[0].primitives[0].attributes.COLOR_0=4;}}).buffer);
  near([...meshOf(model).mesh.c].slice(0,4),[221,204,187,170].map(x=>x/255));assert.equal(meshOf(model).mesh.c.length,16);model.dispose();
});

test('uint32 index range above 65535 is preserved and embedded data URIs never fetch',async()=>{
  const count=65537,p=Buffer.alloc(count*12),n=Buffer.alloc(count*12),i=Buffer.alloc(12);
  for(let k=0;k<count;k++)n.writeFloatLE(1,k*12+8);i.writeUInt32LE(0);i.writeUInt32LE(1,4);i.writeUInt32LE(65536,8);
  p.writeFloatLE(1,12);p.writeFloatLE(1,65536*12+4);
  const binary=Buffer.concat([p,n,i]),json={asset:{version:'2.0'},buffers:[{byteLength:binary.length}],bufferViews:[{buffer:0,byteLength:p.length},{buffer:0,byteOffset:p.length,byteLength:n.length},{buffer:0,byteOffset:p.length+n.length,byteLength:i.length}],
    accessors:[{bufferView:0,componentType:5126,type:'VEC3',count},{bufferView:1,componentType:5126,type:'VEC3',count},{bufferView:2,componentType:5125,type:'SCALAR',count:3}],
    meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1},indices:2}]}],nodes:[{mesh:0}],scenes:[{nodes:[0]}]};
  const model=await MODEL.loadGLB(pack(json,binary));assert.equal(meshOf(model).mesh.i.constructor,Uint32Array);assert.deepEqual([...meshOf(model).mesh.i],[0,1,65536]);model.dispose();
  const log=[],inline=await MODEL.loadGLB(fixture({alter:j=>{j.images[0]={uri:'data:image/png;base64,'+png().toString('base64')};}}).buffer,{decodeImage:decoder(log)});
  assert.deepEqual(log[0].bytes,png());inline.dispose();
});

test('unsupported animation, skin, morph, required extensions, compression, UV transforms and external resources fail explicitly',async()=>{
  for(const [alter,code] of [
    [j=>{j.animations=[{}];},'model_animation_unsupported'],[j=>{j.skins=[{}];},'model_skin_unsupported'],
    [j=>{j.meshes[0].primitives[0].targets=[{}];},'model_morph_unsupported'],[j=>{j.extensionsRequired=['KHR_draco_mesh_compression'];},'model_required_extension_unsupported'],
    [j=>{j.meshes[0].primitives[0].extensions={KHR_draco_mesh_compression:{}};},'model_compression_unsupported'],
    [j=>{j.materials[0].pbrMetallicRoughness.baseColorTexture.texCoord=1;},'model_texture_coordinates_unsupported'],
    [j=>{j.materials[0].pbrMetallicRoughness.baseColorTexture.extensions={KHR_texture_transform:{}};},'model_texture_coordinates_unsupported'],
    [j=>{j.buffers[0].uri='https://not-requested.invalid/buffer.bin';},'model_external_buffer_unsupported'],
    [j=>{j.images[0].uri='https://not-requested.invalid/image.png';},'model_external_image_unsupported'],
    [j=>{j.accessors[0].sparse={};},'model_sparse_accessor_unsupported'],
    [j=>{j.meshes[0].primitives[0].mode=5;},'model_primitive_mode_unsupported'],
  ]) await assert.rejects(MODEL.loadGLB(fixture({alter}).buffer,{decodeImage:decoder()}),{code});
});

test('malformed lengths, accessor ranges, indices, cycles, nonfinite positions and geometry/image budgets reject before upload',async()=>{
  for(const [alter,code] of [
    [j=>{j.accessors[0].count=200;},'model_accessor_out_of_bounds'],
    [(j,b)=>{b[j.bufferViews[1].byteOffset]=9;},'model_invalid_indices'],
    [j=>{j.nodes[1].children=[0];},'model_invalid_node_graph'],
    [j=>{j.nodes[0].children=[1,1];},'model_invalid_node_graph'],
    [(j,b)=>{b.writeFloatLE(NaN,0);},'model_nonfinite_attribute'],
    [j=>{j.nodes[0].rotation=[0,0,0,0];},'model_invalid_quaternion'],
    [j=>{j.nodes[1].translation=[1,2,3];},'model_conflicting_transform'],
  ]) await assert.rejects(MODEL.loadGLB(fixture({alter}).buffer,{decodeImage:decoder()}),{code});
  const f=fixture();await assert.rejects(MODEL.loadGLB(f.buffer.slice(0,-1)),{code:'model_invalid_glb'});
  await assert.rejects(MODEL.loadGLB(f.buffer,{maxTexturePixels:3,decodeImage:decoder()}),{code:'model_texture_budget'});
  await assert.rejects(MODEL.loadGLB(f.buffer,{maxVertices:3,decodeImage:decoder()}),{code:'model_invalid_position'});
  await assert.rejects(MODEL.loadGLB(f.buffer,{maxTriangles:1,decodeImage:decoder()}),{code:'model_geometry_budget'});
});

test('aborted image decode closes late results; errors after decoding release allocated bitmaps',async()=>{
  const c=new AbortController();let release,closed=0;
  const pending=MODEL.loadGLB(fixture().buffer,{signal:c.signal,decodeImage:()=>new Promise(r=>{release=r;})});
  while(!release)await Promise.resolve();c.abort();await assert.rejects(pending,{code:'model_aborted'});
  release({width:2,height:2,close(){closed++;}});await Promise.resolve();await Promise.resolve();assert.equal(closed,1);
  const log=[];await assert.rejects(MODEL.loadGLB(fixture({alter:j=>{j.nodes[1].children=[0];}}).buffer,{decodeImage:decoder(log)}),{code:'model_invalid_node_graph'});assert.equal(log.filter(x=>x==='closed').length,1);
});

test('world matrix offsets and inverse-transpose normals remain correct for mirrored nonuniform transforms',()=>{
  const root=new E.Node({rot:[0,Math.PI/2,0],scl:[-2,3,4],pos:[1,2,3]}),child=root.add(new E.Node({matrix:E.M4.trs([1,0,0],[0,0,0],[1,1,1]),pos:[0,1,0]}));
  E.updateWorld(root);near(child.worldPos(),[1,5,5]);
  const normal=E.M4.normal(root.world),v=[1,1,1].map(x=>x/Math.sqrt(3)),transformed=[normal[0]*v[0]+normal[3]*v[1]+normal[6]*v[2],normal[1]*v[0]+normal[4]*v[1]+normal[7]*v[2],normal[2]*v[0]+normal[5]*v[1]+normal[8]*v[2]];
  near(transformed,[1/4,1/3,1/2].map(x=>x/Math.sqrt(3)));
});

test('actual offline browser GPU preserves PNG orientation, factors, mask/blend, mirror culling, legacy primitives and splat state', { timeout:60000 }, async()=>{
  const {chromium}=require('playwright'),browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'msedge',headless:true});
  try{
    const context=await browser.newContext({offline:true}),page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.setContent('<canvas id="view" style="width:128px;height:128px"></canvas>');
    await page.addScriptTag({content:fs.readFileSync(require.resolve('../src/engine.js'),'utf8')});
    await page.addScriptTag({content:fs.readFileSync(require.resolve('../src/model.js'),'utf8')});
    const bytes=[...new Uint8Array(fixture({transformed:false}).buffer)];
    const result=await page.evaluate(async bytes=>{
      const m=await CDG_MODEL.loadGLB(Uint8Array.from(bytes).buffer),r=new E.Renderer(document.getElementById('view')),cam=new E.Camera();
      cam.target=[0,0,0];cam.yaw=0;cam.pitch=0;cam.dist=3;cam.fov=Math.PI/2;
      r.env.clear=[0,0,0];r.env.fogN=100;r.env.fogF=200;
      let node;m.root.traverse(n=>{if(n.mesh)node=n;});m.root.pick='fixture';
      const pixel=(x,y)=>{const v=new Uint8Array(4);r.gl.readPixels(x,y,1,1,r.gl.RGBA,r.gl.UNSIGNED_BYTE,v);return [...v];};
      r.render(m.root,cam);const colors=[pixel(48,80),pixel(80,80),pixel(48,48),pixel(80,48)],first={...r.info.render};
      const picked=r.pick(cam,64,64)===m.root;
      node.color=[.25,1,1];r.render(m.root,cam);const factor=pixel(48,80);node.color=[1,1,1];
      node.material.alphaMode='MASK';node.alpha=.25;node.material.alphaCutoff=.5;r.render(m.root,cam);const mask=pixel(48,80);
      node.material.alphaMode='BLEND';node.alpha=.5;r.render(m.root,cam);const blend=pixel(48,80);
      node.material.alphaMode='OPAQUE';node.alpha=1;m.root.scl=[-1,1,1];r.render(m.root,cam);const mirror=pixel(80,80);m.root.scl=[1,1,1];
      m.root.rot=[0,Math.PI,0];r.render(m.root,cam);const culled=pixel(48,80);node.material.doubleSided=true;r.render(m.root,cam);const doubleSided=pixel(80,80);m.root.rot=[0,0,0];
      const legacy=new E.Node({mesh:E.Prim.box(1.5,1.5,.1),color:[.3,.5,.7]});r.render(legacy,cam);const before=pixel(64,64);
      r.render(m.root,cam);r.render(legacy,cam);const after=pixel(64,64);
      node.material.alphaMode='BLEND';node.alpha=.5;
      // This injected draw intentionally disturbs program/VAO/texture/cull state like SplatWorld.
      const gl=r.gl,foreign=gl.createVertexArray();r.splat={n:4,visible:true,draw(){gl.bindVertexArray(foreign);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,null);gl.useProgram(null);gl.enable(gl.CULL_FACE);gl.frontFace(gl.CW);}};
      r.render(m.root,cam);const restored=pixel(48,80),stats={...r.info.render},memory={...r.info.memory},glError=gl.getError();
      m.dispose(r);const remaining={...r.info.memory};r.dispose();gl.deleteVertexArray(foreign);
      return{colors,first,picked,factor,mask,blend,mirror,culled,doubleSided,before,after,restored,stats,memory,remaining,glError};
    },bytes);
    const close=(color,expected)=>near(color,expected,5);
    close(result.colors[0],[255,0,0,255]);close(result.colors[1],[0,255,0,255]);close(result.colors[2],[0,0,255,255]);close(result.colors[3],[255,255,255,255]);
    assert.equal(result.first.calls,1);assert.equal(result.first.triangles,2);assert.equal(result.picked,true);
    assert.ok(result.factor[0]>125&&result.factor[0]<140);close(result.mask,[0,0,0,255]);assert.ok(result.blend[0]>120&&result.blend[0]<135);
    close(result.mirror,[255,0,0,255]);close(result.culled,[0,0,0,255]);close(result.doubleSided,[255,0,0,255]);
    assert.deepEqual(result.before,result.after);assert.deepEqual(result.restored,result.blend);assert.equal(result.stats.splatCalls,1);assert.equal(result.stats.points,4);assert.equal(result.stats.calls,2);
    assert.equal(result.memory.textures,1);assert.equal(result.remaining.textures,0);assert.equal(result.glError,0);assert.deepEqual(errors,[]);
    const jpeg=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=3;c.height=2;const x=c.getContext('2d');x.fillStyle='#00ff00';x.fillRect(0,0,3,2);return [...Uint8Array.from(atob(c.toDataURL('image/jpeg',1).split(',')[1]),c=>c.charCodeAt(0))];});
    const jpgBytes=[...new Uint8Array(fixture({transformed:false,imageBytes:Buffer.from(jpeg),imageMime:'image/jpeg',alter:j=>{j.samplers[0]={wrapS:10497,wrapT:10497,minFilter:9987,magFilter:9729};}}).buffer)];
    const jpgResult=await page.evaluate(async bytes=>{
      const canvas=document.createElement('canvas');canvas.style.cssText='width:128px;height:128px';document.body.append(canvas);const native=canvas.getContext.bind(canvas);canvas.getContext=(kind,opts)=>kind==='webgl2'?null:native(kind,opts);
      const model=await CDG_MODEL.loadGLB(Uint8Array.from(bytes).buffer),r=new E.Renderer(canvas),cam=new E.Camera();cam.target=[0,0,0];cam.yaw=0;cam.pitch=0;cam.dist=3;cam.fov=Math.PI/2;
      r.render(model.root,cam);const pixel=new Uint8Array(4);r.gl.readPixels(64,64,1,1,r.gl.RGBA,r.gl.UNSIGNED_BYTE,pixel);const error=r.gl.getError(),webgl2=r.webgl2;model.dispose(r);r.dispose();return{pixel:[...pixel],error,webgl2};
    },jpgBytes);
    assert.equal(jpgResult.webgl2,false);assert.equal(jpgResult.error,0);assert.ok(jpgResult.pixel[1]>245&&jpgResult.pixel[0]<8&&jpgResult.pixel[2]<8);
  }finally{await browser.close();}
});

test('GPU preparation validates the whole subtree first and rolls back failed uploads without damaging an existing scene', { timeout:60000 }, async()=>{
  const {chromium}=require('playwright'),browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'msedge',headless:true});
  try{
    const context=await browser.newContext({offline:true}),page=await context.newPage();await page.setContent('<canvas id="view" style="width:128px;height:128px"></canvas>');
    for(const file of ['engine','model'])await page.addScriptTag({content:fs.readFileSync(require.resolve('../src/'+file+'.js'),'utf8')});
    const result=await page.evaluate(async bytes=>{
      const old=await CDG_MODEL.loadGLB(Uint8Array.from(bytes).buffer),replacement=await CDG_MODEL.loadGLB(Uint8Array.from(bytes).buffer),renderer=new E.Renderer(document.getElementById('view')),gl=renderer.gl,cam=new E.Camera();
      const prepared=renderer.prepareModel(old),drawCallsBefore=renderer.info.render.calls;
      cam.target=[0,0,0];cam.yaw=0;cam.pitch=0;cam.dist=3;cam.fov=Math.PI/2;
      const pixel=()=>{renderer.render(old.root,cam);const rgba=new Uint8Array(4);gl.readPixels(48,80,1,1,gl.RGBA,gl.UNSIGNED_BYTE,rgba);return [...rgba];};
      const beforePixel=pixel(),memory={...renderer.info.memory},oldBuffers=[...renderer.meshes.values()].flatMap(x=>['p','n','uv','c','t','i'].map(k=>x[k]).filter(Boolean)),oldTextures=[...renderer.textures.values()].map(x=>x.handle);
      const scene=new E.Node();scene.add(new E.Node({mesh:E.Prim.box(1,1,1)}));scene.add(replacement.root);
      const createdBuffers=[],createdTextures=[],nativeCreateBuffer=gl.createBuffer.bind(gl),nativeCreateTexture=gl.createTexture.bind(gl);
      gl.createBuffer=()=>{const b=nativeCreateBuffer();createdBuffers.push(b);return b;};gl.createTexture=()=>{const t=nativeCreateTexture();createdTextures.push(t);return t;};
      const nativeGet=gl.getParameter.bind(gl);gl.getParameter=k=>k===gl.MAX_TEXTURE_SIZE?1:nativeGet(k);
      let preflightError;try{renderer.prepareScene(scene);}catch(e){preflightError=e.code;}
      const preflightAllocations=createdBuffers.length+createdTextures.length;gl.getParameter=nativeGet;
      // Inject a real-WebGL error result after bufferData, emulating driver allocation failure.
      const nativeData=gl.bufferData.bind(gl),nativeError=gl.getError.bind(gl);let pendingError=false;
      gl.bufferData=(...args)=>{nativeData(...args);pendingError=true;};gl.getError=()=>{if(pendingError){pendingError=false;return gl.OUT_OF_MEMORY;}return nativeError();};
      let oomError;try{renderer.prepareScene(scene);}catch(e){oomError=e.code;}
      gl.bufferData=nativeData;gl.getError=nativeError;
      const afterOOM={...renderer.info.memory},allFailedBuffersDeleted=createdBuffers.every(b=>!gl.isBuffer(b));
      // Exercise failure after all new geometry uploads; preserve prior bindings and allocations.
      const nativeImage=gl.texImage2D.bind(gl);gl.texImage2D=(...args)=>{nativeImage(...args);throw new Error('injected texture upload failure');};
      gl.bindBuffer(gl.ARRAY_BUFFER,oldBuffers[0]);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,oldBuffers.at(-1));gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,oldTextures[0]);
      const bindings={array:gl.getParameter(gl.ARRAY_BUFFER_BINDING),element:gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING),active:gl.getParameter(gl.ACTIVE_TEXTURE),texture:gl.getParameter(gl.TEXTURE_BINDING_2D)};
      let uploadError;try{renderer.prepareScene(scene);}catch(e){uploadError=e.message;}
      const restoredBindings=gl.getParameter(gl.ARRAY_BUFFER_BINDING)===bindings.array&&gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING)===bindings.element&&gl.getParameter(gl.ACTIVE_TEXTURE)===bindings.active&&gl.getParameter(gl.TEXTURE_BINDING_2D)===bindings.texture;
      gl.texImage2D=nativeImage;
      const afterFailure={...renderer.info.memory},newResourcesDeleted=createdBuffers.every(b=>!gl.isBuffer(b))&&createdTextures.every(t=>!gl.isTexture(t)),oldResourcesAlive=oldBuffers.every(b=>gl.isBuffer(b))&&oldTextures.every(t=>gl.isTexture(t)),afterPixel=pixel();
      const success=renderer.prepareScene(scene),again=renderer.prepareModel(replacement),error=gl.getError();
      old.dispose(renderer);replacement.dispose(renderer);renderer.dispose();
      return {prepared,drawCallsBefore,preflightError,preflightAllocations,oomError,memory,afterOOM,allFailedBuffersDeleted,uploadError,restoredBindings,afterFailure,newResourcesDeleted,oldResourcesAlive,beforePixel,afterPixel,success,again,error};
    },[...new Uint8Array(fixture({transformed:false}).buffer)]);
    assert.equal(result.prepared.geometries,1);assert.equal(result.prepared.textures,1);assert.equal(result.drawCallsBefore,0);
    assert.equal(result.preflightError,'model_texture_size_unsupported');assert.equal(result.preflightAllocations,0);
    assert.equal(result.oomError,'model_gpu_out_of_memory');assert.deepEqual(result.afterOOM,result.memory);assert.equal(result.allFailedBuffersDeleted,true);
    assert.equal(result.uploadError,'injected texture upload failure');assert.equal(result.restoredBindings,true);assert.deepEqual(result.afterFailure,result.memory);
    assert.equal(result.newResourcesDeleted,true);assert.equal(result.oldResourcesAlive,true);assert.deepEqual(result.afterPixel,result.beforePixel);
    assert.equal(result.success.geometries,2);assert.equal(result.success.textures,1);assert.deepEqual(result.again,{geometries:0,textures:0,geometryBytes:0,textureBytes:0});assert.equal(result.error,0);
  }finally{await browser.close();}
});
