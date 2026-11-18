// =====================================================================
//  Amrittt Edition - Quiz Video Auto Bot  (make-quiz-v1.mjs)
//  Kaam: quiz-maker HTML se 1 video banao -> Telegram bot pe bhejo.
//  GitHub Actions din me 3 baar chalata hai (subah / dophar / shaam).
// =====================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------
//  >>> BAAD ME YAHAN UPDATE KARNA (ya GitHub Secrets me daalna) <<<
//  Secrets set honge to wahi use honge, warna ye neeche wale.
// ---------------------------------------------------------------------
const DEFAULT_BOT_TOKEN = '9259265199:AAFOQD7bc-zOo6qr5EXE7bDIBVoOTPyiJ2A';
const DEFAULT_CHAT_ID = '8918487470';

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim() || DEFAULT_BOT_TOKEN;
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim() || DEFAULT_CHAT_ID;

// ---------------------------------------------------------------------
//  Video settings (HTML ke options jaise hi)
// ---------------------------------------------------------------------
const CONFIG = {
  fmt: process.env.QUIZ_FMT || 'oldcur',     // oldcur | cur | classic
  vlen: process.env.QUIZ_VLEN || '7+1',      // 5+1 | 7+1 | 9+1
  sfx: true,
  mo: true,
  fx: true,
  tick: true,
  vol: '0.4',
  hook: '',
  mc: ''
};

const HTML_NAME = process.env.HTML_FILE || 'quiz-maker-math-gk-hindi-science.html';
const HTML_PATH = path.resolve(__dirname, HTML_NAME);
const MUSIC_PATH = path.resolve(__dirname, 'music.mp3');        // optional
const STATE_PATH = path.resolve(__dirname, 'quiz-state.json');
const OUT_DIR = path.resolve(__dirname, 'out');
const DRY_RUN = process.env.DRY_RUN === '1';                    // test: Telegram pe na bheje
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), '|', ...a);

// ---------------------------------------------------------------------
//  State (kaun se sawal ban chuke)
// ---------------------------------------------------------------------
function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return {
      used: j && typeof j.used === 'object' && j.used ? j.used : {},
      last: Number.isFinite(+j.last) ? +j.last : 0,
      total: Number.isFinite(+j.total) ? +j.total : 0
    };
  } catch {
    return { used: {}, last: 0, total: 0 };
  }
}
function writeState(st) {
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...st, updated: new Date().toISOString() }, null, 1));
  fs.renameSync(tmp, STATE_PATH);
}

// ---------------------------------------------------------------------
//  Telegram
// ---------------------------------------------------------------------
async function tg(method, makeBody, isForm) {
  if (DRY_RUN) { log('[DRY_RUN] Telegram', method, 'skip'); return { ok: true, result: {} }; }
  const url = `${(process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, '')}/bot${BOT_TOKEN}/${method}`;
  let lastErr = 'unknown';
  for (let a = 1; a <= 5; a++) {
    try {
      const init = { method: 'POST', signal: AbortSignal.timeout(180000) };
      if (isForm) init.body = makeBody();
      else { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(makeBody()); }
      const res = await fetch(url, init);
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) return j;
      lastErr = `${method}: ${j.description || 'HTTP ' + res.status}`;
      const ra = j && j.parameters && j.parameters.retry_after;
      if (res.status === 429 && ra) { await sleep((ra + 1) * 1000); continue; }
      // 4xx (token/chat galat, bot start nahi kiya) -> retry ka fayda nahi
      if (res.status >= 400 && res.status < 500) throw Object.assign(new Error('Telegram ' + lastErr), { fatal: true });
    } catch (e) {
      if (e && e.fatal) throw e;
      lastErr = `${method}: ${e && e.message ? e.message : e}`;
    }
    await sleep(3000 * a);
  }
  throw new Error('Telegram ' + lastErr);
}

async function sendText(text) {
  const t = String(text).slice(0, 4000);
  return tg('sendMessage', () => ({ chat_id: CHAT_ID, text: t, disable_web_page_preview: true }), false);
}

async function sendVideo(file, caption) {
  const buf = fs.readFileSync(file);
  return tg('sendVideo', () => {
    const f = new FormData();
    f.append('chat_id', CHAT_ID);
    f.append('caption', String(caption || '').slice(0, 1000));
    f.append('supports_streaming', 'true');
    f.append('width', '1080');
    f.append('height', '1920');
    f.append('video', new Blob([buf], { type: 'video/mp4' }), path.basename(file));
    return f;
  }, true);
}

// ---------------------------------------------------------------------
//  Local web server (HTML + optional music)
// ---------------------------------------------------------------------
function startServer() {
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent((req.url || '/').split('?')[0]);
    try {
      if (u === '/' || u === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(HTML_PATH));
      } else if (u === '/music.mp3' && fs.existsSync(MUSIC_PATH)) {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        res.end(fs.readFileSync(MUSIC_PATH));
      } else { res.writeHead(404); res.end('not found'); }
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------------
//  Page ke andar chalne wala override:
//  makeMp4 ko replace karte hain - frames + audio Node ko bhejte hain,
//  aur MP4 ffmpeg (libx264 + aac) banata hai. Isse Chrome ke
//  H.264/AAC encoder pe depend nahi rehna padta (error ka sabse bada karan).
//  Frame drawing ka logic HTML ke original makeMp4 jaisa hi hai.
// ---------------------------------------------------------------------
const PAGE_OVERRIDE = String.raw`
(function(){
  // agar CDN/encoder missing ho to HTML ka check na ruke
  if (typeof window.VideoEncoder === 'undefined') window.VideoEncoder = function(){};
  if (typeof window.AudioEncoder === 'undefined') window.AudioEncoder = function(){};
  if (typeof window.Mp4Muxer === 'undefined') window.Mp4Muxer = {};
  window.save = function(){};   // download ki zarurat nahi

  const b64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };

  window.makeMp4 = async function(item, buf, onProg){
    const total = QD + AD, sc = VW / W;
    const bc = document.createElement('canvas'); bc.width = VW; bc.height = VH; const bctx = bc.getContext('2d');
    const rc = document.createElement('canvas'); rc.width = VW; rc.height = VH; const rctx = rc.getContext('2d');
    const base = ans => { bctx.setTransform(1,0,0,1,0,0); bctx.clearRect(0,0,VW,VH); bctx.scale(sc,sc); render(bctx, {...item, ans}); bctx.setTransform(1,0,0,1,0,0); };
    await window.__qStart(JSON.stringify({ fps: FPS, total, w: VW, h: VH, sr: SR }));
    let last = null;
    const N = total * FPS;
    for (let i = 0; i < N; i++) {
      const el = i / FPS, isQ = el < QD;
      if (item.fmt === 'cur') {}
      else if (item.mo || item.fmt === 'oldcur') {
        bctx.setTransform(1,0,0,1,0,0); bctx.clearRect(0,0,VW,VH); bctx.scale(sc,sc);
        render(bctx, {...item, ans: !isQ, cur: item.fmt === 'oldcur', m: { t: isQ ? (item.fmt === 'oldcur' ? Math.max(0, el - (HKE - 0.2)) : el) : el - QD }});
        bctx.setTransform(1,0,0,1,0,0);
      }
      else if (last !== isQ) { base(!isQ); last = isQ; }
      if (item.fmt === 'cur') { rctx.setTransform(sc,0,0,sc,0,0); renderCur(rctx, item, el); rctx.setTransform(1,0,0,1,0,0); }
      else { rctx.drawImage(bc, 0, 0); fxFrame(rctx, el, sc, item); }
      const url = rc.toDataURL('image/jpeg', 0.95);
      await window.__qFrame(url.slice(url.indexOf(',') + 1));
      if (i % 15 === 0) { onProg(i / N * 0.9); await yieldNow(); }
    }
    await window.__qVideoEnd();
    onProg(0.92);
    // ---- audio (original jaisa) ----
    const oac = new OfflineAudioContext(2, SR * total, SR);
    if (item.voice) { const vs = oac.createBufferSource(); vs.buffer = item.voice; const vg = oac.createGain(); vg.gain.value = 1; vs.connect(vg); vg.connect(oac.destination); vs.start(isCA(item.fmt) ? HKE : 0.3); }
    if (item.voiceA) { const va = oac.createBufferSource(); va.buffer = item.voiceA; const vag = oac.createGain(); vag.gain.value = 1; va.connect(vag); vag.connect(oac.destination); va.start(QD + 0.35); }
    if (buf) { const sn = oac.createBufferSource(); sn.buffer = buf; sn.loop = true; const g = oac.createGain(), vl = +$('vol').value * (item.voice ? 0.35 : 1); g.gain.setValueAtTime(vl, 0); g.gain.setValueAtTime(vl, total - 0.8); g.gain.linearRampToValueAtTime(0.0001, total); sn.connect(g); g.connect(oac.destination); sn.start(0); }
    if ($('tick').checked && !isCA(item.fmt)) {
      for (let k = item.voice ? Math.max(0, QD - 3) : 0; k < QD; k++) beep(oac, oac.destination, k + 0.05, k >= QD - 3 ? 1000 : 700, .08, .25);
      if (!item.sfx) { beep(oac, oac.destination, QD + 0.05, 1250, .5, .35); beep(oac, oac.destination, QD + 0.2, 1600, .5, .3); }
    }
    if (item.sfx) { if (isCA(item.fmt)) addSfxCur(oac, QD, item.fmt === 'oldcur'); else addSfx(oac, QD); }
    const ab = await oac.startRendering();
    const L = ab.getChannelData(0), R = ab.getChannelData(1);
    const inter = new Float32Array(L.length * 2);
    for (let i = 0; i < L.length; i++) { inter[2*i] = L[i]; inter[2*i+1] = R[i]; }
    const bytes = new Uint8Array(inter.buffer), CH = 1 << 20;
    for (let o = 0; o < bytes.length; o += CH) await window.__qAudio(b64(bytes.subarray(o, Math.min(o + CH, bytes.length))));
    onProg(0.97);
    await window.__qFinish(JSON.stringify({ qno: item.qno, q: item.q }));
    onProg(1);
    return new Blob([new Uint8Array(16)], { type: 'video/mp4' });
  };
})();
`;

// ---------------------------------------------------------------------
//  ffmpeg bridge
// ---------------------------------------------------------------------
function makeBridge(tmpDir) {
  const b = { ff: null, ffErr: '', ffExit: null, framesIn: 0, videoTmp: path.join(tmpDir, 'video.mp4'),
              audioTmp: path.join(tmpDir, 'audio.f32'), out: path.join(tmpDir, 'quiz.mp4'), meta: null, audioFd: null, m: null };

  b.start = (json) => {
    b.m = JSON.parse(json);
    b.ffErr = ''; b.ffExit = null; b.framesIn = 0;
    try { fs.rmSync(b.audioTmp, { force: true }); } catch {}
    const args = ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'image2pipe', '-framerate', String(b.m.fps), '-c:v', 'mjpeg', '-i', 'pipe:0',
      '-c:v', 'libx264', '-preset', process.env.X264_PRESET || 'medium', '-crf', '20',
      '-profile:v', 'high', '-level', '4.0', '-pix_fmt', 'yuv420p', '-r', String(b.m.fps),
      '-g', String(b.m.fps * 2), '-an', b.videoTmp];
    b.ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    b.ff.stderr.on('data', (d) => { b.ffErr += d.toString(); if (b.ffErr.length > 6000) b.ffErr = b.ffErr.slice(-6000); });
    b.ff.stdin.on('error', (e) => { b.ffErr += '\nstdin: ' + e.message; });
    b.ffDone = new Promise((res) => { b.ff.on('close', (c) => { b.ffExit = c; res(c); }); b.ff.on('error', (e) => { b.ffErr += '\nspawn: ' + e.message; b.ffExit = -1; res(-1); }); });
  };
  b.frame = async (base64) => {
    if (!b.ff || b.ffExit !== null) throw new Error('ffmpeg band ho gaya: ' + b.ffErr);
    const buf = Buffer.from(base64, 'base64');
    b.framesIn++;
    if (!b.ff.stdin.write(buf)) await new Promise((res) => b.ff.stdin.once('drain', res));
  };
  b.videoEnd = async () => {
    b.ff.stdin.end();
    const code = await b.ffDone;
    if (code !== 0) throw new Error('ffmpeg video encode fail (code ' + code + '): ' + b.ffErr);
    if (b.framesIn < 10) throw new Error('bahut kam frames mile: ' + b.framesIn);
    b.audioFd = fs.openSync(b.audioTmp, 'w');
  };
  b.audio = (base64) => { fs.writeSync(b.audioFd, Buffer.from(base64, 'base64')); };
  b.finish = (metaJson) => {
    b.meta = JSON.parse(metaJson);
    fs.closeSync(b.audioFd); b.audioFd = null;
    try { fs.rmSync(b.out, { force: true }); } catch {}
    const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
      '-i', b.videoTmp, '-f', 'f32le', '-ar', String(b.m.sr), '-ac', '2', '-i', b.audioTmp,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', b.out],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (r.status !== 0) throw new Error('ffmpeg mux fail: ' + (r.stderr || r.error));
    const sz = fs.statSync(b.out).size;
    if (sz < 20000) throw new Error('video file bahut chhoti: ' + sz + ' bytes');
    if (sz > 49 * 1024 * 1024) throw new Error('video 50MB se badi hai, Telegram nahi lega');
  };
  return b;
}

// ---------------------------------------------------------------------
//  Ek poori koshish: video banao -> bhejo -> state save
// ---------------------------------------------------------------------
async function runOnce(attempt) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quizbot-'));
  const bridge = makeBridge(tmpDir);
  const server = await startServer();
  const port = server.address().port;
  const state = readState();
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows', '--force-color-profile=srgb']
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    await context.addInitScript((s) => {
      try {
        localStorage.setItem('sq_used', JSON.stringify(s.used));
        localStorage.setItem('sq_last', String(s.last));
      } catch (e) {}
    }, state);
    const page = await context.newPage();
    page.setDefaultTimeout(120000);
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    page.on('dialog', (d) => d.accept().catch(() => {}));

    await page.exposeFunction('__qStart', (j) => bridge.start(j));
    await page.exposeFunction('__qFrame', (d) => bridge.frame(d));
    await page.exposeFunction('__qVideoEnd', () => bridge.videoEnd());
    await page.exposeFunction('__qAudio', (d) => bridge.audio(d));
    await page.exposeFunction('__qFinish', (j) => bridge.finish(j));

    log(`Attempt ${attempt}: page khul raha hai...`);
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => typeof BANK !== 'undefined' && BANK.length > 0 && !!document.getElementById('vid'), null, { timeout: 60000 });

    // fonts (Poppins + Devanagari)
    await page.evaluate(async () => {
      try { await Promise.race([document.fonts.load('700 100px Poppins', 'Quiz गणित ✔ 0123'), new Promise((r) => setTimeout(r, 20000))]); } catch (e) {}
      try { await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 10000))]); } catch (e) {}
    });

    await page.addScriptTag({ content: PAGE_OVERRIDE });

    // settings
    await page.evaluate((c) => {
      const set = (id, v) => {
        const e = document.getElementById(id); if (!e) return;
        if (e.type === 'checkbox') e.checked = !!v; else e.value = v;
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set('fmt', c.fmt); set('vlen', c.vlen); set('sfx', c.sfx); set('mo', c.mo); set('fx', c.fx);
      set('tick', c.tick); set('vol', c.vol); set('hook', c.hook); set('mc', c.mc);
      set('wimg', false); set('vo', false); set('vn', '1');
    }, CONFIG);

    // optional music
    if (attempt === 1 && fs.existsSync(MUSIC_PATH)) {
      try {
        await page.evaluate(async () => {
          const ab = await (await fetch('/music.mp3')).arrayBuffer();
          await new OfflineAudioContext(2, 1, SR).decodeAudioData(ab.slice(0)); // decode test
          songData = { name: 'music.mp3', ab };
        });
        log('music.mp3 laga diya');
      } catch (e) { log('music.mp3 nahi chala, bina music ke:', e.message); }
    }

    // saare sawal ban chuke ho to history reset
    const info = await page.evaluate(() => {
      const unused = BANK.filter((b) => !USED[b.n]).length;
      let reset = false;
      if (unused === 0) { USED = {}; try { localStorage.removeItem('sq_used'); } catch (e) {} reset = true; }
      const f0 = BANK.findIndex((b) => !USED[b.n]);
      load(f0 < 0 ? 0 : f0); refreshPick();
      return { total: BANK.length, unused, reset, cur };
    });
    log('Sawal bank:', JSON.stringify(info));
    if (info.reset) { try { await sendText('♻️ Saare sawal ban chuke the, history reset karke dobara shuru kar raha hoon.'); } catch {} }

    // video banao
    await page.evaluate(() => { document.getElementById('vmsg').textContent = ''; });
    log('Video banana shuru...');
    const t0 = Date.now();
    await page.evaluate(() => document.getElementById('vid').click());
    await page.waitForFunction(() => {
      const t = (document.getElementById('vmsg').textContent || '');
      return /^Ho gaya/.test(t) || /^Video nahi ban payi/.test(t) || /ban chuk[ae]|Chrome \(naya/.test(t);
    }, null, { timeout: 25 * 60 * 1000, polling: 1000 });
    const msg = await page.$eval('#vmsg', (e) => e.textContent || '');
    if (!/^Ho gaya/.test(msg)) throw new Error('Video nahi bani: ' + msg);
    if (!bridge.meta || !fs.existsSync(bridge.out)) throw new Error('video file nahi mili');
    log(`Video ready (${Math.round((Date.now() - t0) / 1000)}s, ${(fs.statSync(bridge.out).size / 1048576).toFixed(2)} MB)`);

    // title / description / pinned comment
    const parts = await page.evaluate((q) => {
      const b = BANK.find((x) => x.q === q);
      if (!b) return null;
      const p = genParts(b);
      return { title: p.title, desc: p.desc, pin: p.pin, sub: b.s, n: b.n };
    }, bridge.meta.q);
    const qno = bridge.meta.qno;
    const caption = parts ? `#${qno} ${parts.title}\n\n${parts.desc}` : `Quiz #${qno}`;

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const finalPath = path.join(OUT_DIR, `quiz-${String(qno).padStart(3, '0')}.mp4`);
    fs.copyFileSync(bridge.out, finalPath);

    // Telegram
    log('Telegram pe bhej raha hoon...');
    await sendVideo(finalPath, caption);
    if (parts) {
      try {
        await sendText(`#${qno}\nTITLE:\n${parts.title}\n\nDESCRIPTION:\n${parts.desc}\n\nPINNED COMMENT:\n${parts.pin}`);
      } catch (e) { log('Text message nahi gaya (video chala gaya):', e.message); }
    }

    // state save (bhejne ke baad)
    const st = await page.evaluate(() => ({ used: USED, last: LAST }));
    writeState({ used: st.used, last: st.last, total: (state.total || 0) + 1 });
    log('Done. Sent quiz #' + qno);
    return true;
  } finally {
    try { if (browser) await browser.close(); } catch {}
    try { server.close(); } catch {}
    try { if (bridge.ff && bridge.ffExit === null) bridge.ff.kill('SIGKILL'); } catch {}
    try { if (bridge.audioFd !== null) fs.closeSync(bridge.audioFd); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------
//  main
// ---------------------------------------------------------------------
async function main() {
  if (!fs.existsSync(HTML_PATH)) throw new Error('HTML file nahi mili: ' + HTML_PATH + ' (repo me quiz-maker-math-gk-hindi-science.html rakho)');
  const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (ff.status !== 0) throw new Error('ffmpeg install nahi hai');
  if (!DRY_RUN && (!BOT_TOKEN || !CHAT_ID)) throw new Error('Bot token / chat id missing');

  let lastErr = null;
  for (let a = 1; a <= MAX_ATTEMPTS; a++) {
    try {
      await runOnce(a);
      return;
    } catch (e) {
      lastErr = e;
      log(`Attempt ${a} fail:`, e && e.message ? e.message : e);
      if (e && e.fatal) break;           // token/chat galat - dobara try bekaar
      if (a < MAX_ATTEMPTS) await sleep(15000);
    }
  }
  const run = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
    ? `\n${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : '';
  try { await sendText('❌ Quiz bot fail ho gaya:\n' + String(lastErr && lastErr.message ? lastErr.message : lastErr).slice(0, 800) + run); } catch {}
  throw lastErr;
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e && e.message ? e.message : e); process.exit(1); });
