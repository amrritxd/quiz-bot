// =====================================================================
//  Amrittt Edition - Quiz Video Auto Bot  (make-quiz-v2.mjs)
//  v5: hook sticker band, 'सवाल #N' series counter, loop ending (last 0.5s intro frame me fade -> Shorts replay)
//  v4: end card (CTA) ke saath apni banayi sound: whoosh + chime + 2 ting (music ke upar)
//  v3: video me sahi jawab / green NAHI dikhta; end me 'comment me jawab + Subscribe' CTA (7 sec sawal + 3 sec CTA)
//  v2: bina curiosity (classic) + ElevenLabs awaaz (4 keys auto-rotate)
//      + image match na ho to wo sawal skip, agla sawal banta hai
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

// ---------------------------------------------------------------------
//  ElevenLabs API keys (4). Baad me badalna ho to GitHub Secret
//  ELEVENLABS_KEYS me daalo (har key nayi line pe ya comma se alag).
//  Secret set hoga to wahi use hoga, warna ye neeche wali.
//  Ek key ke credits khatam / galat ho to script khud agli key lagati hai.
// ---------------------------------------------------------------------
const DEFAULT_ELEVEN_KEYS = [
  'sk_d6ecf5ed9a18d07b3b0fbf5c09270eba0106e6290c488af6',
  'sk_168722402f151c179e76bc33efe7fbd7996f2a5a33f3d7bc',
  'sk_1c1f2b244b0f668f803a101e48ab35e9fb9c4e920169d243'
];
const parseKeys = (t) => String(t || '').split(/[\n,;]+/).map((k) => k.replace(/\s+/g, '')).filter((k) => k.length > 10);
const envKeys = parseKeys(process.env.ELEVENLABS_KEYS);
const ELEVEN_KEYS = envKeys.length ? envKeys : DEFAULT_ELEVEN_KEYS;
const ELEVEN_VOICE = (process.env.ELEVEN_VOICE_ID || '').trim() || 'JBFqnCBsd6RMkjVDRZzb'; // George
const ELEVEN_MODEL = (process.env.ELEVEN_MODEL || '').trim() || 'eleven_multilingual_v2';   // Hindi best
const MAX_SKIP = 80;   // image match na hone par ek run me max itne sawal skip

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim() || DEFAULT_BOT_TOKEN;
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim() || DEFAULT_CHAT_ID;

// ---------------------------------------------------------------------
//  Video settings (HTML ke options jaise hi)
// ---------------------------------------------------------------------
const CONFIG = {
  fmt: process.env.QUIZ_FMT || 'classic',     // classic = bina curiosity (oldcur | cur me curiosity hoti hai)
  vlen: process.env.QUIZ_VLEN || '7+3',      // 5+1 | 7+1 | 9+1
  sfx: false,       // HTML ki apni awaazein band - sirf music.mp3 wali awaaz aayegi
  mo: true,
  fx: true,
  tick: false,      // tik-tik beep band
  vol: '1',
  voice: process.env.QUIZ_VOICE === '1',   // ElevenLabs/Edge awaaz BAND (chalu karni ho to QUIZ_VOICE=1)
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
//  ElevenLabs TTS (Node side) - keys rotate hoti hain
// ---------------------------------------------------------------------
const deadKeys = new Set();
const eleErrs = {};            // har key ka aakhri error (poore process me yaad rehta hai)
const voiceUsed = new Set();   // 'eleven' / 'edge'
let keyIdx = 0;
const EDGE_VOICE = (process.env.EDGE_VOICE || '').trim() || 'hi-IN-MadhurNeural';

function cleanSpeech(t) {
  // curiosity wali line awaaz me nahi bolni
  return String(t).replace('और कल का सवाल मिस ना हो, इसलिए अभी चैनल को सब्सक्राइब करें!', 'और चैनल को सब्सक्राइब करें!');
}
// mp3 bytes -> wav (base64). Browser me decode pakka chale.
function mp3ToWavB64(mp3) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-'));
  try {
    fs.writeFileSync(path.join(d, 'a.mp3'), mp3);
    const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', path.join(d, 'a.mp3'), '-ar', '44100', '-ac', '1', path.join(d, 'a.wav')], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('mp3->wav fail: ' + r.stderr);
    return fs.readFileSync(path.join(d, 'a.wav')).toString('base64');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

async function elevenTTS(text, model, voice) {
  let lastErr = 'koi key nahi mili';
  for (let n = 0; n < ELEVEN_KEYS.length; n++) {
    const i = (keyIdx + n) % ELEVEN_KEYS.length;
    if (deadKeys.has(i)) continue;
    for (let a = 1; a <= 3; a++) {
      try {
        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
          method: 'POST',
          headers: { 'xi-api-key': ELEVEN_KEYS[i], 'content-type': 'application/json', accept: 'audio/mpeg' },
          body: JSON.stringify({ text, model_id: model }),
          signal: AbortSignal.timeout(120000)
        });
        if (res.ok) {
          keyIdx = i;
          delete eleErrs['key' + (i + 1)];
          return mp3ToWavB64(Buffer.from(await res.arrayBuffer()));
        }
        const body = (await res.text().catch(() => '')).slice(0, 300);
        let why = body;
        try { const j = JSON.parse(body); why = (j.detail && (j.detail.status || j.detail.message)) || body; } catch {}
        eleErrs['key' + (i + 1)] = res.status + ' ' + String(why).slice(0, 70);
        lastErr = `key#${i + 1} HTTP ${res.status}: ${body}`;
        log(`ElevenLabs key#${i + 1} -> HTTP ${res.status} ${String(why).slice(0, 100)}`);
        if (res.status === 401 || res.status === 402 || /quota|credit|insufficient|limit_reached|unusual/i.test(body)) {
          deadKeys.add(i); break;
        }
        if (res.status === 429) { await sleep(5000 * a); continue; }
        if (res.status >= 500) { await sleep(3000 * a); continue; }
        break; // baaki 4xx: is key ko chhod ke agli try
      } catch (e) {
        lastErr = `key#${i + 1}: ${e && e.message ? e.message : e}`;
        eleErrs['key' + (i + 1)] = 'network ' + String(e && e.message ? e.message : e).slice(0, 60);
        await sleep(2000 * a);
      }
    }
  }
  throw new Error('ElevenLabs fail: ' + lastErr.slice(0, 160));
}

// Free backup awaaz (Microsoft Edge TTS, Hindi) - ElevenLabs na chale tab bhi video bina awaaz ke nahi jayegi
function edgeTTS(text) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-'));
  try {
    const txt = path.join(d, 't.txt'), out = path.join(d, 'a.mp3');
    fs.writeFileSync(txt, text, 'utf8');
    let r = spawnSync('python3', ['-m', 'edge_tts', '--file', txt, '--voice', EDGE_VOICE, '--write-media', out], { encoding: 'utf8', timeout: 120000 });
    if (r.status !== 0 || !fs.existsSync(out)) {
      r = spawnSync('python3', ['-m', 'edge_tts', '--text', text, '--voice', EDGE_VOICE, '--write-media', out], { encoding: 'utf8', timeout: 120000 });
    }
    if (r.status !== 0 || !fs.existsSync(out)) throw new Error('edge-tts fail: ' + String(r.stderr || r.error || '').slice(0, 200));
    return mp3ToWavB64(fs.readFileSync(out));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

async function makeSpeech(text, model, voice) {
  text = cleanSpeech(text);
  if (ELEVEN_KEYS.length && deadKeys.size < ELEVEN_KEYS.length) {
    try { const w = await elevenTTS(text, model, voice); voiceUsed.add('eleven'); return w; }
    catch (e) { log('ElevenLabs nahi chala, backup awaaz (Edge TTS):', e.message); }
  }
  const w = edgeTTS(text);
  voiceUsed.add('edge');
  return w;
}

// ---------------------------------------------------------------------
//  Local web server (HTML + optional music)
// ---------------------------------------------------------------------
function startServer(musicFile) {
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent((req.url || '/').split('?')[0]);
    try {
      if (u === '/' || u === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(HTML_PATH));
      } else if (u === '/music.mp3' && musicFile && fs.existsSync(musicFile)) {
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(fs.readFileSync(musicFile));
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

  // ---- ElevenLabs awaaz: Node se (key rotation wahan hai) ----
  window.ttsFetch = async function(text){
    const b64s = await window.__qTts(String(text), $('xm').value, $('xv').value);
    const bin = atob(b64s), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return await new OfflineAudioContext(2, 1, SR).decodeAudioData(u8.buffer);
  };

  // ---- Strict image match: sirf wahi photo jiske naam me keyword ho, warna null ----
  const GENERIC = new Set(['mount','river','lake','indian','india','national','flower','ocean','world','city','state','fort','temple','map','the','and','of','day','war']);
  window.autoFetch = async function(kw, q){
    const terms = enTerms(kw); if (!terms[0]) return null;
    const parts = terms[0].toLowerCase().split(/\s+/);
    let words = parts.filter(x => x.length >= 4 && !GENERIC.has(x));
    if (!words.length) words = parts.filter(x => x.length >= 3);
    if (!words.length) return null;
    const w0 = terms[0].split(/\s+/), qs = [terms[0]];
    if (w0.length > 1 && !GENERIC.has(w0[0].toLowerCase())) qs.push(w0[0]);
    const seen = new Set(), cands = [];
    let errs = 0;
    for (const qq of qs) {
      let list = null;
      for (let t = 0; t < 2 && list === null; t++) { try { list = await wikiList(qq, 'commons'); } catch (e) { await new Promise(r => setTimeout(r, 1500)); } }
      if (list === null) { errs++; continue; }
      for (const it of list) {
        const ttl = (it.title || '').toLowerCase();
        if (seen.has(it.thumb) || BAD_RE.test(it.title || '')) continue;
        seen.add(it.thumb);
        if (words.some(w => ttl.includes(w))) cands.push(it);
      }
      if (cands.length >= 3) break;
    }
    if (!cands.length && errs === qs.length) throw new Error('Wikimedia se photo search nahi ho paayi (network)');
    for (const it of cands.slice(0, 8)) {
      try { const im = await loadImg(it.thumb); if (im.width >= 600 && im.height >= 400) return im; } catch (e) {}
    }
    return null;
  };

  // ---- End card ki apni sound (synth): whoosh + chime + 2 ting. QUIZ_END_SOUND=0 se band ----
  window.__endSfx = function(oac, t0){
    const out = oac.createGain(); out.gain.value = 0.7; out.connect(oac.destination);   // music ke saath clip na ho
    const noise = (w, d, v) => {
      const n = Math.floor(oac.sampleRate * d), b = oac.createBuffer(1, n, oac.sampleRate), a = b.getChannelData(0);
      for (let i = 0; i < n; i++) a[i] = Math.random() * 2 - 1;
      const s = oac.createBufferSource(); s.buffer = b;
      const f = oac.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
      f.frequency.setValueAtTime(400, w); f.frequency.exponentialRampToValueAtTime(3500, w + d);
      const g = oac.createGain(); g.gain.setValueAtTime(0.0001, w); g.gain.linearRampToValueAtTime(v, w + d * 0.4); g.gain.exponentialRampToValueAtTime(0.001, w + d);
      s.connect(f); f.connect(g); g.connect(out); s.start(w); s.stop(w + d + 0.05);
    };
    const bell = (w, base, v) => {
      [1, 2.76, 5.4].forEach((m, i) => {
        const o = oac.createOscillator(), g = oac.createGain();
        o.type = 'sine'; o.frequency.value = base * m;
        g.gain.setValueAtTime(v / (i + 1), w); g.gain.exponentialRampToValueAtTime(0.0005, w + 1.0 / (i * 0.6 + 1));
        o.connect(g); g.connect(out); o.start(w); o.stop(w + 1.1);
      });
    };
    const thud = (w) => {
      const o = oac.createOscillator(), g = oac.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(150, w); o.frequency.exponentialRampToValueAtTime(45, w + 0.3);
      g.gain.setValueAtTime(0.5, w); g.gain.exponentialRampToValueAtTime(0.001, w + 0.35);
      o.connect(g); g.connect(out); o.start(w); o.stop(w + 0.4);
    };
    thud(t0 + 0.02); noise(t0 - 0.05, 0.4, 0.14);
    bell(t0 + 0.05, 880, 0.26);
    bell(t0 + 1.0, 1318, 0.2);    // ting 1 (Subscribe button pulse)
    bell(t0 + 1.7, 1760, 0.2);    // ting 2
  };

  window.makeMp4 = async function(item, buf, onProg){
    const total = QD + AD, sc = VW / W;
    const bc = document.createElement('canvas'); bc.width = VW; bc.height = VH; const bctx = bc.getContext('2d');
    const rc = document.createElement('canvas'); rc.width = VW; rc.height = VH; const rctx = rc.getContext('2d');
    const base = ans => { bctx.setTransform(1,0,0,1,0,0); bctx.clearRect(0,0,VW,VH); bctx.scale(sc,sc); render(bctx, {...item, ans}); bctx.setTransform(1,0,0,1,0,0); };
    await window.__qStart(JSON.stringify({ fps: FPS, total, w: VW, h: VH, sr: SR }));
    // ---- loop ending: aakhri 0.5 sec me video pehle frame jaisi ho jaati hai ----
    const LOOP = 0.5;
    const lc = document.createElement('canvas'); lc.width = VW; lc.height = VH; const lctx = lc.getContext('2d');
    if (item.fmt !== 'cur') {
      lctx.setTransform(1,0,0,1,0,0); lctx.clearRect(0,0,VW,VH); lctx.scale(sc,sc);
      render(lctx, {...item, ans: false, cur: item.fmt === 'oldcur', m: { t: 0 }});
      lctx.setTransform(1,0,0,1,0,0);
      fxFrame(lctx, 0, sc, item);
    }
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
      if (item.fmt !== 'cur' && el > total - LOOP) { const f = Math.min(1, (el - (total - LOOP)) / LOOP); rctx.save(); rctx.globalAlpha = f; rctx.drawImage(lc, 0, 0); rctx.restore(); }
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
    if (window.__END_SOUND !== false) window.__endSfx(oac, QD);
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

// music.mp3 -> wav (browser me decode pakka chale)
function prepareMusic(tmpDir) {
  if (!fs.existsSync(MUSIC_PATH)) return null;
  const out = path.join(tmpDir, 'music.wav');
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', MUSIC_PATH, '-ar', '48000', '-ac', '2', out], { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error('music.mp3 convert nahi hui: ' + String(r.stderr || '').slice(0, 200));
  return out;
}

// ---------------------------------------------------------------------
//  Ek poori koshish: video banao -> bhejo -> state save
// ---------------------------------------------------------------------
async function runOnce(attempt) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quizbot-'));
  const bridge = makeBridge(tmpDir);
  const musicFile = prepareMusic(tmpDir);
  if (!musicFile && process.env.QUIZ_ALLOW_SILENT !== '1' && !CONFIG.voice) throw Object.assign(new Error('music.mp3 repo me nahi mili (wahi awaaz video me lagni hai). Repo ke root me music.mp3 upload karo.'), { fatal: true });
  const server = await startServer(musicFile);
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

    await page.exposeFunction('__qTts', (t, m, v) => makeSpeech(t, m || ELEVEN_MODEL, v || ELEVEN_VOICE));
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

    await page.addScriptTag({ content: `window.__END_SOUND = ${process.env.QUIZ_END_SOUND === '0' ? 'false' : 'true'};` });
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
      set('wimg', false); set('vn', '1');
      // awaaz ON (asli ElevenLabs call Node karta hai)
      const xv = document.getElementById('xv');
      if (xv && ![...xv.options].some((o) => o.value === c.voiceId)) { const o = document.createElement('option'); o.value = c.voiceId; o.textContent = c.voiceId; xv.appendChild(o); }
      if (c.voice) { set('xk', 'managed-by-node'); set('xm', c.model); set('xv', c.voiceId); set('vo', true); }
      else set('vo', false);
    }, { ...CONFIG, model: ELEVEN_MODEL, voiceId: ELEVEN_VOICE });

    // music.mp3 = video ki awaaz (har attempt me)
    if (musicFile) {
      await page.evaluate(async () => {
        const ab = await (await fetch('/music.mp3')).arrayBuffer();
        await new OfflineAudioContext(2, 1, SR).decodeAudioData(ab.slice(0)); // decode test
        songData = { name: 'music.mp3', ab };
      });
      log('music.mp3 laga diya');
    }

    // saare sawal ban chuke ho to history reset
    const info = await page.evaluate(() => {
      const unused = BANK.filter((b) => !USED[b.n]).length;
      let reset = false;
      if (unused === 0) { USED = {}; try { localStorage.removeItem('sq_used'); } catch (e) {} reset = true; }
      refreshPick();
      return { total: BANK.length, unused, reset };
    });
    log('Sawal bank:', JSON.stringify(info));

    // image match wala pehla sawal dhoondo; match na ho to skip -> agla
    let picked = null, skipped = 0;
    for (let step = 0; step < MAX_SKIP; step++) {
      const r = await page.evaluate(async () => {
        const i = BANK.findIndex((b) => !USED[b.n]);
        if (i < 0) return { none: true };
        const b = BANK[i];
        const im = await autoFetch(b.kw, b.q);          // network error pe throw karta hai
        if (!im) {
          USED[b.n] = 'skip';
          try { localStorage.setItem('sq_used', JSON.stringify(USED)); } catch (e) {}
          return { skip: true, i, kw: b.kw };
        }
        photoCache[i] = im; load(i); refreshPick();
        return { ok: true, i, kw: b.kw };
      });
      if (r.none) break;
      if (r.skip) { skipped++; log(`Image match nahi (${r.kw}) -> sawal #${r.i + 1} skip`); continue; }
      picked = r; break;
    }
    if (!picked) throw new Error('Koi bhi sawal image-match ke saath nahi mila (skip: ' + skipped + ')');
    log(`Sawal #${picked.i + 1} (${picked.kw}) ready, skip hue: ${skipped}`);
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
    if (parts) {
      const noCur = (t) => String(t || '').split('\n').filter((l) => !/कल का सवाल/.test(l)).join('\n').trim();
      parts.title = noCur(parts.title); parts.desc = noCur(parts.desc); parts.pin = noCur(parts.pin);
    }
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
        const vnote = voiceUsed.has('edge') ? `\n\nℹ️ Awaaz: backup (Edge TTS). ElevenLabs ka haal: ${JSON.stringify(eleErrs)}` : '';
        await sendText(`#${qno}\nTITLE:\n${parts.title}\n\nDESCRIPTION:\n${parts.desc}\n\nPINNED COMMENT:\n${parts.pin}${vnote}`);
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
