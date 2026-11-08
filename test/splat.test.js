// node test/splat.test.js <file.spz>
const fs = require('fs'), path = require('path');
const SP = require(path.join(__dirname, '../src/splat.js'));
(async () => {
  const f = process.argv[2]; const buf = fs.readFileSync(f); const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const t0 = Date.now(); const d = await SP.decode(ab, f); const t1 = Date.now();
  let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (let i = 0; i < d.n; i++) for (let k = 0; k < 3; k++) { const v = d.pos[i * 3 + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
  let qn = 0; for (let i = 0; i < 1000; i++) qn += Math.hypot(d.rot[i * 4], d.rot[i * 4 + 1], d.rot[i * 4 + 2], d.rot[i * 4 + 3]);
  console.log(d.format, 'n=', d.n, 'decode ms', t1 - t0, 'min', mn.map((x) => x.toFixed(2)), 'max', mx.map((x) => x.toFixed(2)), 'avg|q|', (qn / 1000).toFixed(3), 'rgba0', [...d.rgba.slice(0, 8)]);
  console.log('half(1.5)=', SP.toHalf(1.5).toString(16), 'half(0.0003)=', SP.toHalf(0.0003).toString(16));
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
