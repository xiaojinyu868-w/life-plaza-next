// Publish only the verified single-file classroom and public version metadata.
// No server, credentials, teacher data, or local deliverables enter the Pages artifact.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist', 'pages');
execFileSync(process.execPath, [path.join(root, 'build.js')], { cwd: root, stdio: 'inherit' });
fs.mkdirSync(output, { recursive: true });
const allowed = new Set(['index.html', '.nojekyll', 'version.json']);
if (fs.readdirSync(output).some(name => !allowed.has(name))) throw new Error('Unexpected file in Pages output directory');
const html = fs.readFileSync(path.join(root, 'dist', '插电工坊.html'));
const commit = process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid source commit');
const version = {
  sourceCommit: commit,
  htmlSha256: createHash('sha256').update(html).digest('hex'),
  htmlBytes: html.length,
  hosting: 'github-pages-static',
  backendDeployed: false,
};
fs.writeFileSync(path.join(output, 'index.html'), html);
fs.writeFileSync(path.join(output, '.nojekyll'), '');
fs.writeFileSync(path.join(output, 'version.json'), JSON.stringify(version, null, 2) + '\n');
console.log(JSON.stringify(version));
