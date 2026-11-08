// node build.js [out.html] [autostateJSON]
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const src = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
const out = process.argv[2] || path.join(__dirname, 'dist', '插电工坊.html');
const auto = process.argv[3] ? `window.CDG_AUTOSTATE=${process.argv[3]};\nwindow.addEventListener('error',function(e){document.body.insertAdjacentHTML('beforeend','<pre style="position:fixed;top:40px;left:10px;z-index:9999;background:#fff;color:#c00;font-size:12px;white-space:pre-wrap;max-width:90vw">ERR '+e.message+' @'+e.lineno+':'+e.colno+'</pre>')});window.addEventListener('unhandledrejection',function(e){document.body.insertAdjacentHTML('beforeend','<pre style="position:fixed;top:80px;left:10px;z-index:9999;background:#fff;color:#c00;font-size:12px">REJ '+(e.reason&&e.reason.stack||e.reason)+'</pre>')});\n` : '';
const files = ['engine.js', 'model.js', 'splat.js', 'data.js', 'hsk.js', 'script.js', 'logic.js', 'lexicon.js', 'world.js', 'characters.js', 'net.js', 'speech.js', 'pronunciation.js', 'npc-voice.js', 'voice-output.js', 'npc-timing.js', 'app.js'];
const characterCatalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'content/characters.json'), 'utf8'));
const readyCharacters = characterCatalog.characters.filter(asset => asset.status === 'verified').map(asset => {
  if (!/^[a-z][a-z0-9-]+$/.test(asset.id) || !asset.taskId || !/^[a-f0-9]{64}$/.test(asset.sha256 || '') || !Number.isFinite(asset.height) || asset.height <= 0 || asset.height > 3) throw new Error('Character must have verified provenance and scale');
  const file = path.resolve(__dirname, asset.model), base = path.resolve(__dirname,'assets/models') + path.sep;
  if (!file.startsWith(base) || !file.endsWith('.glb')) throw new Error('Character asset path must be inside assets/models');
  const bytes = fs.readFileSync(file);
  if (bytes.length > 64*1024*1024 || bytes.subarray(0,4).toString() !== 'glTF' || crypto.createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Character artifact integrity check failed');
  return {id:asset.id,name:asset.name,height:asset.height,rotationY:asset.rotationY,taskId:asset.taskId,b64:bytes.toString('base64')};
});
const characterBoot = `window.CDG_CHARACTER_ASSETS=${JSON.stringify({default:characterCatalog.default,characters:readyCharacters})};\n`;
const vocabulary = JSON.parse(fs.readFileSync(path.join(__dirname, 'content/hsk/vocabulary-2025.json'), 'utf8'));
require('./src/lexicon.js').create(vocabulary);
const lessonDir = path.join(__dirname, 'content', 'lessons');
const lessonRunner = require('./src/lesson.js');
const lessons = Object.fromEntries(fs.readdirSync(lessonDir).filter(name => /^nev-l\d+\.json$/.test(name)).map(name => {
  const lesson = JSON.parse(fs.readFileSync(path.join(lessonDir, name), 'utf8'));
  lessonRunner.validate(lesson);
  if (name !== lesson.id + '.json') throw new Error('Lesson filename must match id');
  return [lesson.id, lesson];
}));
const lessonBoot = `window.CDG_HSK_VOCAB=${JSON.stringify(vocabulary)};window.CDG_LESSONS=${JSON.stringify(lessons)};
(function(){
 const requested=new URLSearchParams(location.search).get('lesson');
 const lesson=window.CDG_LESSONS[requested]||window.CDG_LESSONS['nev-l4'];
 window.CDG_CURRENT_LESSON=lesson;
 Object.assign(window.CDG_DATA.DICT,lesson.dict);
 window.CDG_DATA.CARD=lesson.cards;window.CDG_DATA.EV=lesson.evidence;window.CDG_DATA.CH=lesson.channels;
 window.CDG_HSK=lesson.hsk;
})();\n`;
files.splice(files.indexOf('app.js'), 0, 'lesson.js');
let marble = '';
if (process.env.MARBLE) {
  const b64 = fs.readFileSync(process.env.MARBLE).toString('base64');
  const meta = process.env.META ? JSON.parse(fs.readFileSync(process.env.META, 'utf8')) : null;
  const place = process.env.PLACE ? JSON.parse(process.env.PLACE) : null;
  marble = `window.CDG_MARBLE=${JSON.stringify({ name: path.basename(process.env.MARBLE), meta, place })};window.CDG_MARBLE.b64="${b64}";\n`;
}
const js = (marble + characterBoot + auto + files.map((f) => (f === 'logic.js' ? lessonBoot : '') + `/* ---- ${f} ---- */\n` + src(f)).join('\n')).replace(/<\/(script)/gi, '<\\/$1');
let html = src('index.html');
html = html.replace('/*STYLE*/', () => src('style.css')).replace('/*SCRIPTS*/', () => js);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
fs.copyFileSync(path.join(__dirname, 'src', 'teacher.html'), path.join(path.dirname(out), 'teacher.html'));
console.log('built', out, (html.length / 1024).toFixed(0) + ' KB');
console.log('verified character assets:', readyCharacters.length, '/', characterCatalog.characters.length);
