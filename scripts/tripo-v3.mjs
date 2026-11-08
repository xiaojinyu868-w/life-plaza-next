// Tripo domestic v3 asset intake. Credentials stay in the process environment.
// Official contract: https://developers.tripo3d.com/zh/docs/introduction
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const BASE = 'https://openapi.tripo3d.com/v3';
const key = process.env.TRIPO_API_KEY;
const [command, journalPath, imagePath, outputDir, imageOption] = process.argv.slice(2);
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
async function api(route, method = 'GET', body) {
  if (!key) throw new Error('TRIPO_API_KEY missing');
  let response;
  try {
    response = await fetch(BASE + route, { method, redirect: 'error', signal: AbortSignal.timeout(90000),
      headers: { Authorization: `Bearer ${key}`, ...(body && !(body instanceof FormData) ? {'Content-Type':'application/json'} : {}) },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  } catch { throw new Error(`${method} ${route}: network/timeout; do not repeat uncertain generation submission`); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 0) throw new Error(`${method} ${route}: HTTP ${response.status}, provider code ${data.code ?? 'unknown'}, ${String(data.message || data.error || '').replace(/https?:\/\/\S+/g,'[URL]').slice(0,200)}`);
  return data.data;
}
async function save(journal) {
  await fs.mkdir(path.dirname(path.resolve(journalPath)), {recursive: true});
  await fs.writeFile(journalPath + '.tmp', JSON.stringify(journal, null, 2) + '\n');
  await fs.rename(journalPath + '.tmp', journalPath);
}
async function status(journal) {
  if (!journal.taskId) throw new Error('No accepted task ID. Reconcile provider history; never blindly resubmit.');
  const data = await api('/tasks/' + encodeURIComponent(journal.taskId));
  journal.status = data.status; journal.progress = data.progress; journal.creditsConsumed = data.credits_consumed;
  journal.checkedAt = new Date().toISOString(); journal.errorCode = data.error_code;
  if (data.status === 'success') {
    journal.files ??= {};
    for (const [name, value] of Object.entries(data.output || {})) {
      if (typeof value !== 'string' || !/^https:\/\//.test(value)) continue;
      if (!/model|image/.test(name)) continue;
      if (journal.files[name]) {
        const old = await fs.readFile(journal.files[name].path).catch(() => null);
        if (old && hash(old) === journal.files[name].sha256) continue;
      }
      const res = await fetch(value, { signal: AbortSignal.timeout(90000) });
      if (!res.ok) throw new Error(`Asset download HTTP ${res.status}; refresh the same task`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const ext = bytes.subarray(0,4).toString() === 'glTF' ? '.glb' : bytes[0]===137 && bytes[1]===80 ? '.png' : bytes[0]===255 && bytes[1]===216 ? '.jpg' : path.extname(new URL(value).pathname);
      if (!['.glb','.png','.jpg','.webp','.fbx'].includes(ext)) continue;
      const dest = path.join(journal.outDir, name.replace(/[^a-zA-Z0-9_-]/g,'_') + ext);
      await fs.mkdir(journal.outDir, {recursive:true}); await fs.writeFile(dest, bytes);
      journal.files[name] = {path:dest, bytes:bytes.length, sha256:hash(bytes)};
      await save(journal);
    }
  }
  await save(journal);
  console.log(JSON.stringify({taskId:journal.taskId,status:journal.status,progress:journal.progress,creditsConsumed:journal.creditsConsumed,errorCode:journal.errorCode,files:journal.files}));
}
try {
  if (command === 'balance') {
    const d = await api('/account/balance'); console.log(JSON.stringify({balance:d.balance,frozen:d.frozen}));
  } else if (command === 'image') {
    if (!journalPath || !imagePath || !outputDir) throw new Error('Usage: image CHECKPOINT IMAGE OUTPUT_DIR');
    if (imageOption && imageOption !== '--no-autofix') throw new Error('Unknown image option');
    const bytes = await fs.readFile(imagePath);
    const journal = {version:1,provider:BASE,input:{path:path.resolve(imagePath),sha256:hash(bytes)},outDir:path.resolve(outputDir),createdAt:new Date().toISOString(),status:'created'};
    await fs.mkdir(path.dirname(path.resolve(journalPath)),{recursive:true});
    // Exclusive creation prevents accidental duplicate jobs on a rerun.
    await fs.writeFile(journalPath, JSON.stringify(journal,null,2), {flag:'wx'});
    const form = new FormData(); form.append('file',new Blob([bytes],{type:/\.png$/i.test(imagePath)?'image/png':'image/jpeg'}),path.basename(imagePath));
    const upload = await api('/files','POST',form);
    if (!upload.file_token) throw new Error('Upload has no file_token');
    journal.options={model:'v3.1-20260211',texture:true,pbr:true,texture_quality:'detailed',geometry_quality:'detailed',face_limit:40000,texture_alignment:'original_image',enable_image_autofix:imageOption !== '--no-autofix'};
    journal.status='submitting'; await save(journal);
    const task = await api('/generation/image-to-model','POST',{input:upload.file_token,...journal.options});
    if (!task.task_id) throw new Error('Submission has no task ID; reconcile provider history');
    journal.taskId=task.task_id;journal.status='accepted';await save(journal);
    console.log(JSON.stringify({taskId:journal.taskId,status:journal.status,checkpoint:journalPath}));
  } else if (command === 'status') {
    await status(JSON.parse(await fs.readFile(journalPath,'utf8')));
  } else { throw new Error('Commands: balance | image CHECKPOINT IMAGE OUTPUT_DIR | status CHECKPOINT'); }
} catch (error) { console.error(String(error.message).split(key || '\0').join('[REDACTED]')); process.exitCode=1; }
