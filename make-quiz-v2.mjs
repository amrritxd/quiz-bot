// =====================================================================
//  Amrittt Edition - Quiz Video Auto Bot  (make-quiz-v2.mjs)
//  v14: HTML ab sirf CLASSIC design + 7 rang-theme (classic/bubble/sky/jungle/sunset/magic/night/auto); Telegram pe 1-7 / rang ka naam likho YA chat ke neeche ke BUTTONS dabao to agla video usi rang me; token / keys code se hata di (sirf GitHub Secrets / env se)
//  v13: video ab 'Simple saaf design' (cur) me banta hai -> Safed + neela 2x2 (style d) default; Telegram pe colour ka naam likho to agla video usi style me; title / description / comment 3 alag message (alag copy)
//  v12: BUG FIX - GitHub cron raat 12 ke baad late chale to wo agle din ke slot ko 'bhej diya' likh deta tha (aaj ka 5 baje wala video chhut jaata); ab cron apne asli slot ka hi maana jaata hai
//  v11: workflow ka koi bhi step fail ho to Telegram pe turant khabar (--notify-fail)
//  v10: har slot ke 11 trigger (GitHub cron late/skip ho to bhi chale); slot cron ke time se apne aap pehchana jaata hai; manual/external run me SEND_SLOT=HH:MM bhi chalta hai
//  v9: har slot ke 2 backup run (target+25 / +55 min); slot-log.json me 'bhej diya' ka nishan, taaki video chhute nahi aur do baar bhi na jaye
//  v8: video EXACT time par Telegram pahunche (04:00 / 12:00 / 17:00 IST) - workflow jaldi start hota hai, video bana ke wahin ruk jaata hai
//  v7: background pura white (orange rays/sparkles/ring + diya hata diye)
//  v6: video = STILL IMAGE (koi animation / timer / fade nahi), sirf music.mp3; neeche ke 3 CTA photo me hi; Telegram text mono (copy ho jaye)
//  v5: hook sticker band, 'सवाल #N' series counter, loop ending (last 0.5s intro frame me fade -> Shorts replay)
//  v4: end card (CTA) ke saath apni banayi sound: whoosh + chime + 2 ting (music ke upar)
//  v3: video me sahi jawab / green NAHI dikhta; end me 'comment me jawab + Subscribe' CTA (7 sec sawal + 3 sec CTA)
//  v2: bina curiosity (classic) + ElevenLabs awaaz (4 keys auto-rotate)
//      + image match na ho to wo sawal skip, agla sawal banta hai
//  Kaam: quiz-maker HTML se 1 video banao -> Telegram bot pe bhejo.
//  GitHub Actions din me 3 baar chalata hai (subah / dophar / shaam).
// =====================================================================
// playwright baad me (lazy) import hota hai, taaki --check-slot bina playwright ke chal sake
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
const DEFAULT_ELEVEN_KEYS = [];   // GitHub Secret ELEVENLABS_KEYS (comma / nayi line se alag)
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
  chn: process.env.QUIZ_CHANNEL || '',        // video ke neeche channel naam (khali = nahi)
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

// ---------- EXACT TIME par bhejna ----------
// Workflow target time se ~75 min pehle start hota hai. Video banne ke baad script yahan ruk ke
// target time (IST) ka intezaar karta hai, phir Telegram pe bhejta hai.
// Slot = din ka ek video time (IST): 04:00 / 12:00 / 17:00.
// Workflow me har slot ke aas-paas 11 cron hain (target se ~77 min pehle se ~113 min baad tak).
// Script cron ke apne time se pehchanta hai ki wo kaun se slot ka hai - alag mapping likhne ki zaroorat nahi.
// Jo bhi pehla run chal gaya wahi target tak ruk ke bhejta hai; baaki runs slot-log.json dekh ke skip ho jaate hain.
const SLOT_MINUTES = { '04:00': 240, '12:00': 720, '17:00': 1020 };      // IST ke minute (din ki shuruaat se)
const SLOT_EARLY_MIN = 120, SLOT_LATE_MIN = 180;                         // cron target se itna pehle / baad tak ka ho sakta hai
const SLOT_LOG = path.resolve(__dirname, 'slot-log.json');
const SLOT_MAX_LATE_MIN = 180;                       // target ke 3 ghante baad ka run bekaar (agla slot paas aa jaata hai)
const nowMs = () => (+process.env.FAKE_NOW_MS || Date.now());
function slotFromCron(cron) {
  const m = /^\s*(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*\s*$/.exec(cron || '');
  if (!m) return null;
  const ist = (+m[2] * 60 + +m[1] + 330) % 1440;                         // cron (UTC) -> IST minute
  for (const [hhmm, t] of Object.entries(SLOT_MINUTES)) {
    let d = ist - t; if (d > 720) d -= 1440; if (d <= -720) d += 1440;
    if (d >= -SLOT_EARLY_MIN && d <= SLOT_LATE_MIN) return hhmm;
  }
  return null;
}
function slotFromEnv() {
  const now = nowMs(), IST_MS = 330 * 60000;
  const forced = (process.env.SEND_SLOT || '').trim();                   // manual / cron-job.org run: SEND_SLOT=04:00
  let hhmm = null, targetMs = null;
  if (/^\d{1,2}:\d{2}$/.test(forced)) {
    hhmm = forced.padStart(5, '0');
    const [h, mi] = hhmm.split(':').map(Number);
    const dayStart = Math.floor((now + IST_MS) / 86400000) * 86400000 - IST_MS;   // aaj 00:00 IST (UTC ms me)
    for (const k of [-1, 0, 1, 2]) {                                              // sabse pehla time jo ab se (3 ghante pehle tak) baaki hai
      const t = dayStart + k * 86400000 + (h * 60 + mi) * 60000;
      if (t >= now - SLOT_MAX_LATE_MIN * 60000) { targetMs = t; break; }
    }
  } else {
    const m = /^\s*(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*\s*$/.exec(process.env.SCHEDULE_CRON || '');
    hhmm = slotFromCron(process.env.SCHEDULE_CRON);
    if (!m || !hhmm) return null;
    const cu = +m[2] * 60 + +m[1];                                         // cron ka UTC minute
    const d = (() => { let x = (cu + 330) % 1440 - SLOT_MINUTES[hhmm]; if (x > 720) x -= 1440; if (x <= -720) x += 1440; return x; })();
    // cron GitHub se late bhi chale to bhi wo apne ASLI time ke slot ka hi maana jaayega (raat 12 ke baad agle din ka nahi)
    let intended = Math.floor(now / 86400000) * 86400000 + cu * 60000;
    if (intended > now) intended -= 86400000;
    targetMs = intended - d * 60000;
  }
  if (targetMs === null) return null;
  const id = new Date(targetMs + IST_MS).toISOString().slice(0, 10) + ' ' + hhmm;
  return { id, ms: targetMs, label: hhmm + ' IST' };
}
function readSlotLog() { try { const j = JSON.parse(fs.readFileSync(SLOT_LOG, 'utf8')); return Array.isArray(j.sent) ? j : { sent: [] }; } catch { return { sent: [] }; } }
function markSlotSent() {
  const sl = slotFromEnv(); if (!sl) return;
  if (sl.ms - nowMs() > 150 * 60000) { log('Slot bahut door hai, nishan nahi laga raha:', sl.id); return; }   // galti se aage ke slot ko "bhej diya" na likh de
  const j = readSlotLog(); if (!j.sent.includes(sl.id)) j.sent.push(sl.id);
  j.sent = j.sent.slice(-40);
  fs.writeFileSync(SLOT_LOG, JSON.stringify(j, null, 1));
  log('Slot nishan lag gaya:', sl.id);
}
// workflow ka pehla step: `node make-quiz-v2.mjs --check-slot` -> skip=true/false (GITHUB_OUTPUT me)
function checkSlotCli() {
  const sl = slotFromEnv(); let skip = false, why = 'manual run / naya slot';
  if (sl) {
    if (readSlotLog().sent.includes(sl.id)) { skip = true; why = 'slot ' + sl.id + ' ka video pehle hi bhej diya gaya'; }
    else if (nowMs() > sl.ms + SLOT_MAX_LATE_MIN * 60000) { skip = true; why = 'slot ' + sl.id + ' bahut late (' + Math.round((nowMs() - sl.ms) / 60000) + ' min), skip'; }
    else why = 'slot ' + sl.id + ' abhi baaki hai';
  }
  console.log('CHECK-SLOT:', skip ? 'SKIP' : 'RUN', '-', why);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'skip=' + skip + '\n');
}
function targetFromEnv() {
  const explicit = (process.env.SEND_AT_IST || '').trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(explicit);
  if (m) {
    const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
    return { ms: Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), +m[1], +m[2]) - 5.5 * 3600 * 1000, label: explicit + ' IST' };
  }
  const sl = slotFromEnv();
  return sl ? { ms: sl.ms, label: sl.label } : null;
}
async function waitForSendTime() {
  if (DRY_RUN) return;
  const tg0 = targetFromEnv();
  if (!tg0) { log('Exact-time target set nahi (manual run) - turant bhej raha hoon'); return; }
  const maxWait = (+process.env.SEND_MAX_WAIT_MIN || 130) * 60000;
  let left = tg0.ms - nowMs();
  if (left <= 0) { log(`Target ${tg0.label} nikal chuka (${Math.round(-left / 60000)} min late) - turant bhej raha hoon`); return; }
  if (left > maxWait) { log(`Target ${tg0.label} bahut door (${Math.round(left / 60000)} min) - ruke bina bhej raha hoon`); return; }
  log(`Video ready. Target ${tg0.label} me ${Math.round(left / 60000)} min baaki - ruk raha hoon...`);
  while ((left = tg0.ms - Date.now()) > 0) await sleep(Math.min(left, 30000));
  log(`Target ${tg0.label} aa gaya - ab bhej raha hoon`);
}
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
      total: Number.isFinite(+j.total) ? +j.total : 0,
      kb: !!(j && j.kb),
      style: /^(classic|bubble|sky|jungle|sunset|magic|night|auto)$/.test(j && j.style) ? j.style : ''
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

// Telegram pe sab text MONO (code block) me jaata hai - tap karte hi copy ho jaata hai
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mono = (t) => '<pre>' + esc(t) + '</pre>';
async function sendHtml(html, plain, markup) {
  if (markup) {
    try {
      return await tg('sendMessage', () => ({ chat_id: CHAT_ID, text: String(html).slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup }), false);
    } catch (e) { log('Copy button nahi laga, bina button ke bhej raha hoon:', e.message); }
  }
  try {
    return await tg('sendMessage', () => ({ chat_id: CHAT_ID, text: String(html).slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }), false);
  } catch (e) {
    log('HTML text nahi gaya, simple text bhej raha hoon:', e.message);
    return tg('sendMessage', () => ({ chat_id: CHAT_ID, text: String(plain).slice(0, 4000), disable_web_page_preview: true }), false);
  }
}
async function sendText(text) { return sendHtml(mono(String(text).slice(0, 3500)), text); }

async function sendVideo(file, caption) {
  const buf = fs.readFileSync(file);
  const cap = String(caption || '').slice(0, 800);
  const go = (html) => tg('sendVideo', () => {
    const f = new FormData();
    f.append('chat_id', CHAT_ID);
    f.append('caption', html ? mono(cap) : cap);
    if (html) f.append('parse_mode', 'HTML');
    f.append('supports_streaming', 'true');
    f.append('width', '1080');
    f.append('height', '1920');
    f.append('video', new Blob([buf], { type: 'video/mp4' }), path.basename(file));
    return f;
  }, true);
  try { return await go(true); }
  catch (e) { log('Mono caption nahi gaya, simple caption ke saath bhej raha hoon:', e.message); return go(false); }
}

// ---------------------------------------------------------------------
//  Colour / style: Telegram pe naam ya number likho -> agla video usi style me
//  1 cream | 2 dark | 3 hara | 4 safed+neela (default) | 5 gehra neela+peela | 6 peela+laal
// ---------------------------------------------------------------------
const DEFAULT_STYLE = 'classic';
const PAL_KEYS = ['classic', 'bubble', 'sky', 'jungle', 'sunset', 'magic', 'night'];
const STYLE_NAMES = { classic: '1. Classic (peela + laal)', bubble: '2. Bubblegum (gulabi)', sky: '3. Sky Blue (aasmani)', jungle: '4. Jungle (hara)', sunset: '5. Sunset (narangi)', magic: '6. Magic (baingani)', night: '7. Night (dark)', auto: 'Auto (har video alag rang)' };
const PCMD = [['night', /night|dark|kala|kaala|black|raat|काला/], ['sky', /sky|aasmani|asmani|neela|neele|nila|blue|आसमानी|नीला/], ['bubble', /bubble|gulabi|pink|गुलाबी/], ['jungle', /jungle|hara|hare|green|हरा/], ['sunset', /sunset|narangi|orange|नारंगी/], ['magic', /magic|baingani|purple|violet|jamuni|बैंगनी|जामुनी/], ['auto', /auto|random|alag/], ['classic', /classic|peela|peele|yellow|laal|\blal\b|red|पीला|लाल/]];
function parseStyleCmd(text) {
  const t = String(text || '').toLowerCase().replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.startsWith('/') || t.length > 40) return null;
  const num = /^(?:rang |style |colou?r |theme )?([1-7])$/.exec(t);
  if (num) return PAL_KEYS[+num[1] - 1];
  for (const [k, re] of PCMD) if (re.test(t)) return k;
  return null;
}
// Telegram chat ke neeche rang ke buttons (reply keyboard) - button dabate hi uska text bot ko message ban kar aata hai
const KEYBOARD = {
  keyboard: [['🎬 Abhi video'], ['🟡 Classic', '🩷 Bubblegum'], ['🩵 Sky Blue', '🟢 Jungle'], ['🟠 Sunset', '🟣 Magic'], ['🌙 Night', '🎲 Auto']],
  resize_keyboard: true, is_persistent: true, input_field_placeholder: 'Video chahiye ya rang chuno'
};
async function sendKeyboard(text) {
  return tg('sendMessage', () => ({ chat_id: CHAT_ID, text: text || '🎨 Agle video ka rang chuno 👇', reply_markup: KEYBOARD }), false);
}
let STYLE_ANNOUNCED = null;
async function resolveStyle(state) {
  let style = state.style || DEFAULT_STYLE;
  try {
    const r = await tg('getUpdates', () => ({ limit: 100, timeout: 0, allowed_updates: ['message'] }), false);
    const list = Array.isArray(r && r.result) ? r.result : [];
    let found = null;
    for (const u of list) {                                   // purane se naye tak: sabse naya valid colour jeetta hai
      const m = u && u.message;
      if (!m || String(m.chat && m.chat.id) !== String(CHAT_ID) || !m.text) continue;
      const k = parseStyleCmd(m.text);
      if (k) found = k;
    }
    if (found && found !== style) {
      style = found;
      if (STYLE_ANNOUNCED !== found) {
        STYLE_ANNOUNCED = found;
        try { await sendKeyboard('🎨 Rang set: ' + STYLE_NAMES[found] + '\nAgla video isi rang me banega.'); } catch {}
      }
    }
  } catch (e) { log('Telegram se colour padh nahi paya (purana style chalega):', e && e.message ? e.message : e); }
  return style;
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
        res.end(fs.readFileSync(HTML_PATH, 'utf8').replace('rem=Q-t,', 'rem=(window.__RT!=null?window.__RT:Q-t),').replace("const ct='सही जवाब कमेंट में लिखो',cp=ph(0.85,0.96);", "const ct='',cp=0;").replace('fr=Math.min(1,Math.max(0,rem/Q))', 'fr=Math.min(1,Math.max(0,rem/(window.__RTT||Q)))'));
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

  // ---- Neeche ke 3 CTA (comment text + Subscribe line + Subscribe button): photo me hi, bilkul still ----
  window.__drawStaticCTA = function(c){
    c.save();
    setPal(); c.fillStyle = PAL.bg; c.fillRect(100, 2235, W - 200, 320);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    const t1 = 'सही जवाब कमेंट में लिखो 👇'; let f1 = 62;
    do { c.font = '700 ' + f1 + 'px Poppins'; f1 -= 2; } while (c.measureText(t1).width > W - 420 && f1 > 30);
    const w1 = c.measureText(t1).width;
    c.fillStyle = '#1e88e5'; bubbleP(c, W / 2 - w1 / 2 - 70, 2298, 34);
    c.fillStyle = PAL.sub; c.fillText(t1, W / 2 + 40, 2300);
    const t2 = 'चैनल को Subscribe करो, वरना सवाल आप तक नहीं पहुँचेगा!'; let f2 = 46;
    do { c.font = '700 ' + f2 + 'px Poppins'; f2 -= 2; } while (c.measureText(t2).width > W - 280 && f2 > 24);
    c.fillStyle = PAL.btn; c.fillText(t2, W / 2, 2385);
    c.fillStyle = PAL.btn; rr(c, W / 2 - 260, 2430, 520, 90, 45); c.fill();
    c.fillStyle = '#fff'; c.font = '700 50px Poppins'; c.fillText('🔔 Subscribe', W / 2, 2478);
    c.restore();
  };

  // ---- STILL IMAGE video: ek hi frame poori video me, koi animation / timer / fade nahi ----
  window.makeMp4 = async function(item, buf, onProg){
    const total = QD + AD, sc = VW / W;
    const rc = document.createElement('canvas'); rc.width = VW; rc.height = VH; const rctx = rc.getContext('2d');
    rctx.setTransform(1,0,0,1,0,0); rctx.clearRect(0,0,VW,VH); rctx.scale(sc,sc);
    const NQ = Math.round(QD * FPS);
    let frame = null;
    const grab = () => { const u = rc.toDataURL('image/jpeg', 0.92); return u.slice(u.indexOf(',') + 1); };
    render(rctx, {...item, ans: false, m: undefined});   // classic still design
    window.__drawStaticCTA(rctx);
    { const wm = ($('chn') || {}).value; if (wm) { rctx.textAlign = 'center'; rctx.textBaseline = 'middle'; rctx.font = '700 54px Poppins'; rctx.fillStyle = PAL.s2t; rctx.fillText(wm.slice(0, 40), W / 2, 2538); } }
    rctx.setTransform(1,0,0,1,0,0);
    frame = grab();
    await window.__qStart(JSON.stringify({ fps: FPS, total, w: VW, h: VH, sr: SR }));
    const N = total * FPS;
    for (let i = 0; i < N; i++) {
      await window.__qFrame(frame);
      if (i % 30 === 0) { onProg(i / N * 0.9); await yieldNow(); }
    }
    await window.__qVideoEnd();
    onProg(0.92);
    // ---- audio (original jaisa) ----
    const oac = new OfflineAudioContext(2, SR * total, SR);
    if (item.voice) { const vs = oac.createBufferSource(); vs.buffer = item.voice; const vg = oac.createGain(); vg.gain.value = 1; vs.connect(vg); vg.connect(oac.destination); vs.start(0.3); }
    if (item.voiceA) { const va = oac.createBufferSource(); va.buffer = item.voiceA; const vag = oac.createGain(); vag.gain.value = 1; va.connect(vag); vag.connect(oac.destination); va.start(QD + 0.35); }
    if (buf) { const sn = oac.createBufferSource(); sn.buffer = buf; sn.loop = true; const g = oac.createGain(), vl = +$('vol').value * (item.voice ? 0.35 : 1); g.gain.setValueAtTime(vl, 0); g.gain.setValueAtTime(vl, total - 0.8); g.gain.linearRampToValueAtTime(0.0001, total); sn.connect(g); g.connect(oac.destination); sn.start(0); }
    if (window.__END_SOUND === true) window.__endSfx(oac, QD);
    if ($('tick').checked) {
      for (let k = item.voice ? Math.max(0, QD - 3) : 0; k < QD; k++) beep(oac, oac.destination, k + 0.05, k >= QD - 3 ? 1000 : 700, .08, .25);
      if (!item.sfx) { beep(oac, oac.destination, QD + 0.05, 1250, .5, .35); beep(oac, oac.destination, QD + 0.2, 1600, .5, .3); }
    }
    if (item.sfx) addSfx(oac, QD);
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
  const style = await resolveStyle(state);
  log('Style:', style, STYLE_NAMES[style]);
  let browser;
  try {
    const { chromium } = await import('playwright');
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

    await page.addScriptTag({ content: `window.__END_SOUND = ${process.env.QUIZ_END_SOUND === '1' ? 'true' : 'false'};` });
    await page.addScriptTag({ content: PAGE_OVERRIDE });

    // settings
    await page.evaluate((c) => {
      const set = (id, v) => {
        const e = document.getElementById(id); if (!e) return;
        if (e.type === 'checkbox') e.checked = !!v; else e.value = v;
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set('pal', c.style); set('chn', c.chn); set('loop', false); set('skp', false); set('tgs', false); set('vlen', c.vlen); set('sfx', c.sfx); set('mo', c.mo); set('fx', c.fx);
      set('tick', c.tick); set('vol', c.vol); set('mc', c.mc);
      set('wimg', false); set('vn', '1');
      // awaaz ON (asli ElevenLabs call Node karta hai)
      const xv = document.getElementById('xv');
      if (xv && ![...xv.options].some((o) => o.value === c.voiceId)) { const o = document.createElement('option'); o.value = c.voiceId; o.textContent = c.voiceId; xv.appendChild(o); }
      if (c.voice) { set('xk', 'managed-by-node'); set('xm', c.model); set('xv', c.voiceId); set('vo', true); }
      else set('vo', false);
    }, { ...CONFIG, style, model: ELEVEN_MODEL, voiceId: ELEVEN_VOICE });

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
    const caption = `Quiz #${qno}`;

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const finalPath = path.join(OUT_DIR, `quiz-${String(qno).padStart(3, '0')}.mp4`);
    fs.copyFileSync(bridge.out, finalPath);

    // exact time tak ruko (sirf scheduled run me)
    await waitForSendTime();

    // Telegram
    log('Telegram pe bhej raha hoon...');
    await sendVideo(finalPath, caption);
    try { markSlotSent(); } catch (e) { log('slot nishan nahi laga:', e.message); }
    if (parts) {
      // title / description / pinned comment: 3 ALAG message, har ek tap karke alag copy hota hai
      const sendPart = async (label, text) => {
        try {
          // Telegram 1-line code block pe 'COPY CODE' nahi dikhata -> copy_text button (limit 256 akshar)
          const markup = (text && text.length <= 256)
            ? { inline_keyboard: [[{ text: '📋 Copy ' + label.toLowerCase(), copy_text: { text } }]] } : null;
          await sendHtml(`<b>#${qno} ${label}</b>\n${mono(text)}`, `#${qno} ${label}\n${text}`, markup);
        }
        catch (e) { log(label + ' message nahi gaya (video chala gaya):', e.message); }
      };
      await sendPart('TITLE', parts.title);
      await sendPart('DESCRIPTION', parts.desc);
      if (voiceUsed.has('edge')) {
        try { await sendText(`ℹ️ Awaaz: backup (Edge TTS). ElevenLabs ka haal: ${JSON.stringify(eleErrs)}`); } catch {}
      }
    }

    // rang ke buttons chat ke neeche (sirf pehli baar; baad me rang badalne par bhi aate rehte hain)
    if (!state.kb) { try { await sendKeyboard(); state.kb = true; } catch (e) { log('buttons nahi gaye:', e.message); } }

    // state save (bhejne ke baad)
    const st = await page.evaluate(() => ({ used: USED, last: LAST }));
    writeState({ used: st.used, last: st.last, total: (state.total || 0) + 1, style, kb: !!state.kb });
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

if (process.argv.includes('--check-slot')) { checkSlotCli(); process.exit(0); }
if (process.argv.includes('--notify-fail')) {      // workflow ka koi bhi step fail ho to Telegram pe seedha khabar
  const msg = process.argv[process.argv.indexOf('--notify-fail') + 1] || 'Quiz bot me error aaya';
  sendText(msg).then(() => process.exit(0)).catch(() => process.exit(0));
} else
main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e && e.message ? e.message : e); process.exit(1); });
