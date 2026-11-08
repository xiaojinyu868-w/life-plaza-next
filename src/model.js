/* Static, self-contained glTF 2 GLB loader. No network or executable asset content. */
(function (G) {
  'use strict';
  const DEFAULTS = { maxBytes: 128 * 1024 * 1024, maxVertices: 2000000, maxTriangles: 2000000, maxTextureSize: 8192, maxTexturePixels: 32 * 1024 * 1024 };
  const fail = code => { const error = new Error(code); error.code = code; throw error; };
  const integer = (n, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= min && n <= max;
  function array(v, n, fallback, min = -Infinity, max = Infinity) {
    if (v === undefined) return [...fallback];
    if (!Array.isArray(v) || v.length !== n || v.some(x => !Number.isFinite(x) || x < min || x > max)) fail('model_invalid_value');
    return [...v];
  }
  function index(items, i) { if (!Array.isArray(items) || !integer(i, 0, items.length - 1) || !items[i] || typeof items[i] !== 'object' || Array.isArray(items[i])) fail('model_invalid_index'); return items[i]; }
  function dimensions(bytes, mime) {
    const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (mime === 'image/png') {
      if (bytes.length < 24 || d.getUint32(0) !== 0x89504e47 || d.getUint32(4) !== 0x0d0a1a0a || d.getUint32(12) !== 0x49484452) fail('model_invalid_image');
      return [d.getUint32(16), d.getUint32(20)];
    }
    if (mime !== 'image/jpeg' || bytes.length < 4 || d.getUint16(0) !== 0xffd8) fail('model_invalid_image');
    let p = 2;
    while (p + 4 <= bytes.length) {
      if (bytes[p++] !== 255) fail('model_invalid_image');
      while (bytes[p] === 255) p++;
      const marker = bytes[p++]; if (marker === 0xd9 || marker === 0xda) break;
      const length = p + 2 <= bytes.length ? d.getUint16(p) : 0;
      if (length < 2 || p + length > bytes.length) fail('model_invalid_image');
      if ([0xc0, 0xc1, 0xc2].includes(marker)) { if (length < 8) fail('model_invalid_image'); return [d.getUint16(p + 5), d.getUint16(p + 3)]; }
      p += length;
    }
    fail('model_invalid_image');
  }
  async function decodeImage(bytes, mime) {
    const blob = new Blob([bytes], { type: mime });
    if (typeof G.createImageBitmap === 'function') return G.createImageBitmap(blob, { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    if (typeof G.Image !== 'function' || !G.URL?.createObjectURL) fail('model_image_decoder_unavailable');
    return new Promise((resolve, reject) => {
      const image = new G.Image(), url = G.URL.createObjectURL(blob);
      const done = error => { G.URL.revokeObjectURL(url); image.onload = image.onerror = null; error ? reject(error) : resolve(image); };
      image.onload = () => done(); image.onerror = () => done(Object.assign(new Error('model_image_decode_failed'), { code: 'model_image_decode_failed' })); image.src = url;
    });
  }
  // Hard deadline also covers a decoder that ignores AbortSignal. Close a late bitmap.
  function imageWithin(decode, bytes, mime, signal) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, value) => { if (done) { value?.close?.(); return; } done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
      const abort = () => finish(Object.assign(new Error('model_aborted'), { code: 'model_aborted' }));
      const timer = setTimeout(() => finish(Object.assign(new Error('model_image_timeout'), { code: 'model_image_timeout' })), 15000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      if (!done) Promise.resolve().then(() => decode(bytes, mime, { signal })).then(v => finish(null, v), () => finish(Object.assign(new Error('model_image_decode_failed'), { code: 'model_image_decode_failed' })));
    });
  }
  function quaternionMatrix(E, node) {
    if (node.matrix !== undefined) {
      if (node.translation || node.rotation || node.scale) fail('model_conflicting_transform');
      const m = array(node.matrix, 16, []);
      if (m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) fail('model_invalid_transform');
      return Float32Array.from(m);
    }
    const p = array(node.translation, 3, [0, 0, 0]), s = array(node.scale, 3, [1, 1, 1]), q = array(node.rotation, 4, [0, 0, 0, 1]);
    const length = Math.hypot(...q); if (Math.abs(length - 1) > 0.001) fail('model_invalid_quaternion');
    const [x, y, z, w] = q.map(v => v / length), m = E.M4.ident();
    m.set([(1 - 2 * (y*y + z*z))*s[0], 2*(x*y + z*w)*s[0], 2*(x*z - y*w)*s[0], 0,
      2*(x*y - z*w)*s[1], (1 - 2*(x*x + z*z))*s[1], 2*(y*z + x*w)*s[1], 0,
      2*(x*z + y*w)*s[2], 2*(y*z - x*w)*s[2], (1 - 2*(x*x + y*y))*s[2], 0, ...p, 1]);
    return m;
  }
  function boundsOf(E, root) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    E.updateWorld(root);
    root.traverse(node => {
      if (!node.mesh) return;
      // Only drawn vertices contribute; indexed buffers may contain unused outliers.
      const p = node.mesh.p, indices = node.mesh.i, count = indices ? indices.length : p.length / 3;
      for (let j = 0; j < count; j++) {
        const i = (indices ? indices[j] : j) * 3;
        const v = E.M4.point(node.world, p.subarray(i, i + 3));
        for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], v[k]); max[k] = Math.max(max[k], v[k]); }
      }
    });
    if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) fail('model_empty_scene');
    return { min, max, size: max.map((v, i) => v - min[i]), center: max.map((v, i) => (v + min[i]) / 2) };
  }
  function tangents(mesh) {
    const { p, n, uv, i: indices } = mesh, sums = new Float32Array(p.length), bitangents = new Float32Array(p.length);
    const count = indices ? indices.length : p.length / 3;
    for (let k = 0; k < count; k += 3) {
      const ids = [0, 1, 2].map(j => indices ? indices[k + j] : k + j), [a, b, c] = ids;
      const x = [0, 1, 2].map(j => p[b*3+j]-p[a*3+j]), y = [0, 1, 2].map(j => p[c*3+j]-p[a*3+j]);
      const u = uv[b*2]-uv[a*2], v = uv[b*2+1]-uv[a*2+1], u2 = uv[c*2]-uv[a*2], v2 = uv[c*2+1]-uv[a*2+1], det = u*v2-u2*v;
      if (Math.abs(det) < 1e-10) continue;
      for (const id of ids) for (let j = 0; j < 3; j++) { sums[id*3+j] += (x[j]*v2-y[j]*v)/det; bitangents[id*3+j] += (y[j]*u-x[j]*u2)/det; }
    }
    const out = new Float32Array(p.length / 3 * 4);
    for (let k = 0; k < p.length / 3; k++) {
      const normal = n.subarray(k*3, k*3+3), t = [...sums.subarray(k*3, k*3+3)], dot = t.reduce((a, v, j) => a + v*normal[j], 0);
      for (let j = 0; j < 3; j++) t[j] -= normal[j]*dot;
      let len = Math.hypot(...t);
      if (len < 1e-10) { const [x,y,z] = normal; t.splice(0, 3, ...(Math.abs(y) < 0.9 ? [-z,0,x] : [0,z,-y])); len = Math.hypot(...t) || 1; }
      const cross = [normal[1]*t[2]-normal[2]*t[1], normal[2]*t[0]-normal[0]*t[2], normal[0]*t[1]-normal[1]*t[0]];
      const hand = cross.reduce((a, v, j) => a + v*bitangents[k*3+j], 0) < 0 ? -1 : 1;
      out.set([...t.map(v => v/len), hand], k*4);
    }
    return out;
  }
  async function loadGLB(buffer, options = {}) {
    const E = options.engine || G.E, limits = { ...DEFAULTS };
    for (const k of Object.keys(limits)) if (options[k] !== undefined) { if (!integer(options[k], 1, DEFAULTS[k] * 4)) fail('model_invalid_limit'); limits[k] = options[k]; }
    if (!E?.Node || !E?.updateWorld) fail('model_engine_unavailable');
    const check = () => { if (options.signal?.aborted) fail('model_aborted'); }; check();
    if (Object.prototype.toString.call(buffer) !== '[object ArrayBuffer]' || buffer.byteLength < 20 || buffer.byteLength > limits.maxBytes) fail('model_invalid_glb');
    const dv = new DataView(buffer);
    if (dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2 || dv.getUint32(8, true) !== buffer.byteLength) fail('model_invalid_glb');
    let document, bin, offset = 12, chunkIndex = 0;
    while (offset < buffer.byteLength) {
      if (offset + 8 > buffer.byteLength) fail('model_invalid_chunk');
      const length = dv.getUint32(offset, true), type = dv.getUint32(offset + 4, true); offset += 8;
      if (length % 4 || offset + length > buffer.byteLength || (chunkIndex === 0 && type !== 0x4e4f534a)) fail('model_invalid_chunk');
      if (type === 0x4e4f534a) { if (document) fail('model_invalid_chunk'); try { document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buffer, offset, length))); } catch (_) { fail('model_invalid_json'); } }
      else if (type === 0x004e4942) { if (bin) fail('model_invalid_chunk'); bin = new Uint8Array(buffer, offset, length); }
      offset += length; chunkIndex++;
    }
    if (!document || document.asset?.version !== '2.0' || (document.asset.minVersion && document.asset.minVersion !== '2.0')) fail('model_invalid_version');
    const warnings = [];
    for (const key of ['extensionsRequired', 'extensionsUsed']) if (document[key] !== undefined && (!Array.isArray(document[key]) || document[key].length > 100 || document[key].some(e => typeof e !== 'string'))) fail('model_invalid_extensions');
    if ((document.extensionsRequired || []).some(e => e !== 'KHR_materials_unlit')) fail('model_required_extension_unsupported');
    if (document.skins?.length || document.nodes?.some(n => n.skin !== undefined)) fail('model_skin_unsupported');
    if (document.animations?.length) fail('model_animation_unsupported');
    for (const ext of document.extensionsUsed || []) if (ext !== 'KHR_materials_unlit') warnings.push('Optional extension not implemented: ' + String(ext).slice(0, 100));
    for (const key of ['nodes', 'meshes', 'accessors', 'bufferViews', 'materials', 'textures', 'images', 'scenes']) {
      if (document[key] !== undefined && (!Array.isArray(document[key]) || document[key].length > 10000)) fail('model_structure_limit');
    }
    if (!bin || document.buffers?.length !== 1 || document.buffers[0].uri !== undefined) fail('model_external_buffer_unsupported');
    const byteLength = document.buffers[0].byteLength;
    if (!integer(byteLength, 1, bin.length) || bin.length - byteLength > 3) fail('model_invalid_buffer');
    function view(id) {
      const v = index(document.bufferViews, id), offset = v.byteOffset || 0;
      if (v.extensions?.EXT_meshopt_compression) fail('model_compression_unsupported');
      if (v.buffer !== 0 || !integer(offset) || !integer(v.byteLength, 1) || offset + v.byteLength > byteLength) fail('model_invalid_buffer_view');
      return { ...v, offset };
    }
    const components = { 5120: ['getInt8', 1, 127], 5121: ['getUint8', 1, 255], 5122: ['getInt16', 2, 32767], 5123: ['getUint16', 2, 65535], 5125: ['getUint32', 4, 4294967295], 5126: ['getFloat32', 4, 1] };
    const accessorCache = new Map();
    function accessor(id, types) {
      const a = index(document.accessors, id);
      if (!types.includes(a.type) || !integer(a.count, 1, Math.max(limits.maxVertices, limits.maxTriangles * 3))) fail('model_invalid_accessor');
      if (a.sparse) fail('model_sparse_accessor_unsupported');
      if (accessorCache.has(id)) return accessorCache.get(id);
      const [getter, size, norm] = components[a.componentType] || [];
      if (!getter || (a.normalized && [5125, 5126].includes(a.componentType))) fail('model_invalid_component');
      const dims = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type], v = view(a.bufferView), start = a.byteOffset || 0, packed = dims*size, stride = v.byteStride ?? packed;
      if (!dims || !integer(start) || !integer(stride, packed, 252) || stride % size || start % size || (v.offset + start) % size || start + (a.count - 1)*stride + packed > v.byteLength) fail('model_accessor_out_of_bounds');
      const output = a.componentType === 5125 ? new Uint32Array(a.count*dims) : new Float32Array(a.count*dims), data = new DataView(bin.buffer, bin.byteOffset + v.offset, v.byteLength);
      for (let i = 0; i < a.count; i++) for (let k = 0; k < dims; k++) {
        let value = data[getter](start + i*stride + k*size, true);
        if (!Number.isFinite(value)) fail('model_nonfinite_attribute');
        if (a.normalized) value = Math.max(-1, value / norm);
        output[i*dims+k] = value;
      }
      const result = { ...a, data: output, dims }; accessorCache.set(id, result); return result;
    }
    const images = new Map(), textures = new Map(), materials = new Map(), meshes = new Map(), geometries = new Set();
    let texturePixels = 0, geometryVertices = 0, geometryTriangles = 0, disposed = false;
    const stats = { meshes: 0, primitives: 0, vertices: 0, triangles: 0, textures: 0, texturePixels: 0, geometryBytes: 0, sourceBytes: buffer.byteLength };
    async function texture(info) {
      if (!info) return null;
      if ((info.texCoord ?? 0) !== 0 || info.extensions?.KHR_texture_transform) fail('model_texture_coordinates_unsupported');
      const id = info.index, t = index(document.textures, id);
      if (textures.has(id)) return textures.get(id);
      if (t.extensions?.KHR_texture_basisu || t.extensions?.EXT_texture_webp) fail('model_texture_format_unsupported');
      const source = index(document.images, t.source);
      let image = images.get(t.source);
      if (!image) {
        let bytes, mime = source.mimeType;
        if (source.uri !== undefined) {
          if (typeof source.uri !== 'string' || source.uri.length > limits.maxBytes * 1.4 || source.bufferView !== undefined) fail('model_external_image_unsupported');
          const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]*={0,2})$/.exec(source.uri);
          if (!match || match[2].length % 4 || (mime && mime !== match[1])) fail('model_external_image_unsupported');
          mime = match[1];
          try { bytes = Uint8Array.from(G.atob(match[2]), c => c.charCodeAt(0)); } catch (_) { fail('model_invalid_image'); }
        } else {
          const v = view(source.bufferView); bytes = bin.subarray(v.offset, v.offset + v.byteLength);
        }
        if (!['image/png', 'image/jpeg'].includes(mime)) fail('model_texture_format_unsupported');
        const [width, height] = dimensions(bytes, mime);
        if (!width || !height || width > limits.maxTextureSize || height > limits.maxTextureSize || texturePixels + width*height > limits.maxTexturePixels) fail('model_texture_budget');
        image = await imageWithin(options.decodeImage || decodeImage, bytes, mime, options.signal);
        if (!image || image.width !== width || image.height !== height) { image?.close?.(); fail('model_invalid_decoded_image'); }
        images.set(t.source, image); texturePixels += width*height; check();
      }
      const sampler = t.sampler === undefined ? {} : index(document.samplers, t.sampler);
      for (const [key, valid] of Object.entries({ magFilter: [9728,9729], minFilter: [9728,9729,9984,9985,9986,9987], wrapS: [33071,33648,10497], wrapT: [33071,33648,10497] })) if (sampler[key] !== undefined && !valid.includes(sampler[key])) fail('model_invalid_sampler');
      const result = { image, sampler: { ...sampler }, disposed: false }; textures.set(id, result); return result;
    }
    async function material(id) {
      if (materials.has(id)) return materials.get(id);
      const m = id === undefined ? {} : index(document.materials, id), pbr = m.pbrMetallicRoughness || {};
      if (m.extensions?.KHR_materials_pbrSpecularGlossiness) fail('model_material_extension_unsupported');
      const base = array(pbr.baseColorFactor, 4, [1,1,1,1], 0, 1), emissive = array(m.emissiveFactor, 3, [0,0,0], 0, 1);
      const scalar = (x, fallback, low = 0, high = 1) => { x ??= fallback; if (!Number.isFinite(x) || x < low || x > high) fail('model_invalid_material'); return x; };
      if (m.alphaMode !== undefined && !['OPAQUE','MASK','BLEND'].includes(m.alphaMode)) fail('model_invalid_material');
      const result = { baseColorFactor: base, emissiveFactor: emissive, metallicFactor: scalar(pbr.metallicFactor, 1), roughnessFactor: scalar(pbr.roughnessFactor, 1),
        alphaMode: m.alphaMode || 'OPAQUE', alphaCutoff: scalar(m.alphaCutoff, 0.5, 0, 100), doubleSided: m.doubleSided === true, unlit: !!m.extensions?.KHR_materials_unlit,
        normalScale: scalar(m.normalTexture?.scale, 1, -100, 100), occlusionStrength: scalar(m.occlusionTexture?.strength, 1),
        baseColorTexture: await texture(pbr.baseColorTexture), metallicRoughnessTexture: await texture(pbr.metallicRoughnessTexture), normalTexture: await texture(m.normalTexture),
        occlusionTexture: await texture(m.occlusionTexture), emissiveTexture: await texture(m.emissiveTexture) };
      materials.set(id, result); return result;
    }
    async function primitives(id) {
      if (meshes.has(id)) return meshes.get(id);
      const mesh = index(document.meshes, id);
      if (mesh.weights || !Array.isArray(mesh.primitives) || !mesh.primitives.length || mesh.primitives.length > 1000) fail('model_invalid_mesh');
      const result = [];
      for (const primitive of mesh.primitives) {
        check();
        if (primitive.targets?.length) fail('model_morph_unsupported');
        if (primitive.extensions?.KHR_draco_mesh_compression) fail('model_compression_unsupported');
        if ((primitive.mode ?? 4) !== 4) fail('model_primitive_mode_unsupported');
        const attrs = primitive.attributes || {}, pos = accessor(attrs.POSITION, ['VEC3']);
        if (pos.componentType !== 5126 || pos.count > limits.maxVertices) fail('model_invalid_position');
        if (attrs.JOINTS_0 !== undefined || attrs.WEIGHTS_0 !== undefined) fail('model_skin_unsupported');
        const geom = { p: Float32Array.from(pos.data), n: null, uv: null, c: null, t: null, i: null, count: pos.count, min: [Infinity,Infinity,Infinity], max: [-Infinity,-Infinity,-Infinity], buf: null };
        for (const [attr, key, types] of [['NORMAL','n',['VEC3']], ['TEXCOORD_0','uv',['VEC2']], ['COLOR_0','c',['VEC3','VEC4']], ['TANGENT','t',['VEC4']]]) {
          if (attrs[attr] === undefined) continue;
          const a = accessor(attrs[attr], types);
          if (a.count !== pos.count || (!['uv','c'].includes(key) && a.componentType !== 5126) || (['uv','c'].includes(key) && a.componentType !== 5126 && !([5121,5123].includes(a.componentType) && a.normalized))) fail('model_attribute_mismatch');
          geom[key] = Float32Array.from(a.data);
          if (key === 'c' && a.dims === 3) { geom.c = new Float32Array(pos.count*4); for (let i=0;i<pos.count;i++) geom.c.set([...a.data.subarray(i*3,i*3+3),1],i*4); }
        }
        if (primitive.indices !== undefined) {
          const a = accessor(primitive.indices, ['SCALAR']);
          if (![5121,5123,5125].includes(a.componentType) || a.normalized || a.count % 3) fail('model_invalid_indices');
          let max = 0; for (const value of a.data) { if (!integer(value, 0, pos.count-1)) fail('model_invalid_indices'); max = Math.max(max, value); }
          geom.i = max > 65535 ? Uint32Array.from(a.data) : Uint16Array.from(a.data);
        } else if (pos.count % 3) fail('model_invalid_indices');
        const mat = await material(primitive.material);
        if (Object.keys(mat).some(k => k.endsWith('Texture') && mat[k]) && !geom.uv) fail('model_missing_uv');
        if (!geom.n) {
          // glTF missing normals mean flat shading, including indexed primitives.
          if (geom.i) {
            for (const [key, size] of [['p',3],['uv',2],['c',4],['t',4]]) if (geom[key]) {
              const old = geom[key], expanded = new Float32Array(geom.i.length*size);
              for (let i=0;i<geom.i.length;i++) expanded.set(old.subarray(geom.i[i]*size,geom.i[i]*size+size),i*size); geom[key]=expanded;
            }
            geom.count = geom.i.length; geom.i = null;
          }
          geom.n = new Float32Array(geom.p.length);
          for (let k=0;k<geom.p.length;k+=9) {
            const a=geom.p.subarray(k,k+3), b=geom.p.subarray(k+3,k+6), c=geom.p.subarray(k+6,k+9), n=E.V3.norm(E.V3.cross(E.V3.sub(b,a),E.V3.sub(c,a)));
            for(let j=0;j<3;j++)geom.n.set(n,k+j*3);
          }
        }
        for (let k=0;k<geom.n.length;k+=3) { const n=E.V3.norm(geom.n.subarray(k,k+3)); if (!Math.hypot(...n)) fail('model_zero_normal'); geom.n.set(n,k); }
        if (mat.normalTexture && !geom.t) geom.t = tangents(geom);
        geometryVertices += geom.count; geometryTriangles += (geom.i ? geom.i.length : geom.count)/3;
        if (geometryVertices > limits.maxVertices || geometryTriangles > limits.maxTriangles) fail('model_geometry_budget');
        const drawCount = geom.i ? geom.i.length : geom.count;
        for (let i=0;i<drawCount;i++) { const vertex = geom.i ? geom.i[i] : i; for (let k=0;k<3;k++){geom.min[k]=Math.min(geom.min[k],geom.p[vertex*3+k]);geom.max[k]=Math.max(geom.max[k],geom.p[vertex*3+k]);} }
        geometries.add(geom); result.push({ geom, mat });
      }
      meshes.set(id,result); return result;
    }
    const root = new E.Node({ name: 'glTF scene' }), visited = new Set();
    function dispose(renderer) {
      if (renderer) { for (const mesh of geometries) renderer.disposeMesh(mesh); for (const texture of textures.values()) renderer.disposeTexture(texture); }
      if (disposed) return; disposed = true; root.visible = false;
      for (const mesh of geometries) mesh.disposed = true;
      for (const texture of textures.values()) texture.disposed = true;
      for (const image of images.values()) image.close?.();
    }
    try {
      async function nodeAt(id, parent, depth) {
        check(); if (depth > 128 || visited.has(id)) fail('model_invalid_node_graph'); visited.add(id);
        const source = index(document.nodes, id);
        if (source.weights) fail('model_morph_unsupported');
        const node = parent.add(new E.Node({ name: typeof source.name === 'string' ? source.name.slice(0,256) : '', matrix: quaternionMatrix(E,source) }));
        if (source.mesh !== undefined) for (const { geom, mat } of await primitives(source.mesh)) {
          node.add(new E.Node({ mesh: geom, material: mat, color: mat.baseColorFactor.slice(0,3), alpha: mat.alphaMode === 'OPAQUE' ? 1 : mat.baseColorFactor[3], emis: [...mat.emissiveFactor] }));
          stats.primitives++; stats.vertices += geom.count; stats.triangles += (geom.i ? geom.i.length : geom.count)/3;
          if (stats.vertices > limits.maxVertices || stats.triangles > limits.maxTriangles) fail('model_geometry_budget');
        }
        if (source.children !== undefined && !Array.isArray(source.children)) fail('model_invalid_node_graph');
        for (const child of source.children || []) await nodeAt(child,node,depth+1);
      }
      const scene = index(document.scenes, document.scene ?? 0);
      if (!Array.isArray(scene.nodes) || !scene.nodes.length) fail('model_empty_scene');
      for (const id of scene.nodes) await nodeAt(id,root,0);
      check(); const bounds = boundsOf(E,root);
      for (const geom of geometries) for (const k of ['p','n','uv','c','t','i']) stats.geometryBytes += geom[k]?.byteLength || 0;
      stats.meshes = meshes.size; stats.textures = textures.size; stats.texturePixels = texturePixels;
      return { root, bounds, stats, warnings, dispose };
    } catch (error) { dispose(); throw error; }
  }
  // Center X/Z, place min-Y at ground, keep the glTF Y-up orientation and all child matrices.
  function normalize(model, { engine = G.E, height = 1.5, ground = true, center = true } = {}) {
    if (!engine?.Node || !model?.root || !Number.isFinite(height) || height <= 0 || !(model.bounds?.size[1] > 0)) fail('model_invalid_normalization');
    const scale = height/model.bounds.size[1], root = new engine.Node({ name: 'normalized model', scl: [scale,scale,scale] });
    const offset = new engine.Node({ pos: [center ? -model.bounds.center[0] : 0, ground ? -model.bounds.min[1] : 0, center ? -model.bounds.center[2] : 0] });
    root.add(offset); offset.add(model.root); engine.updateWorld(root); return root;
  }
  G.CDG_MODEL = { loadGLB, normalize, DEFAULTS };
  if (typeof module !== 'undefined') module.exports = G.CDG_MODEL;
})(typeof window !== 'undefined' ? window : globalThis);
