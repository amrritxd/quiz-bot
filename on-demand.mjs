// =====================================================================
//  on-demand.mjs  -  "🎬 Abhi video" button
//  Telegram chat ke neeche ka button dabao -> kuch minute me ek extra video aa jaata hai.
//  Ye script har ~5 min (quiz-on-demand.yml) chalti hai, Telegram me button ka message dhoondhti hai,
//  mil jaaye to request-log.json me "handle ho gaya" likhti hai aur workflow ko batati hai ki video banao.
//  Video wahi purana make-quiz-v2.mjs banata hai (turant bhejo mode me, slot-log ko chhue bina).
// =====================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(dir, 'request-log.json');
const KB_VER = 1;                      // keyboard badalo to ye number badhao -> naya keyboard ek baar phir jaayega

// Token / chat id: pehle GitHub Secrets (env), warna make-quiz-v2.mjs ke DEFAULT wale
function fromMain(name) {
  try {
    const m = new RegExp(name + "\\s*=\\s*'([^']+)'").exec(fs.readFileSync(path.join(dir, 'make-quiz-v2.mjs'), 'utf8'));
    return m ? m[1] : '';
  } catch { return ''; }
}
const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim() || fromMain('DEFAULT_BOT_TOKEN');
const CHAT = (process.env.TELEGRAM_CHAT_ID || '').trim() || fromMain('DEFAULT_CHAT_ID');
const API = (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, '');

// make-quiz-v2.mjs wale KEYBOARD jaisa hi + sabse upar video button
const KEYBOARD = {
  keyboard: [['🎬 Abhi video'], ['🟡 Classic', '🩷 Bubblegum'], ['🩵 Sky Blue', '🟢 Jungle'], ['🟠 Sunset', '🟣 Magic'], ['🌙 Night', '🎲 Auto']],
  resize_keyboard: true, is_persistent: true, input_field_placeholder: 'Video chahiye ya rang chuno'
};

async function tg(method, body) {
  const res = await fetch(`${API}/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(`Telegram ${method}: ${j.description || 'HTTP ' + res.status}`);
  return j;
}

function wantsVideo(text) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t || t.length > 40) return false;
  return /^\/video\b/.test(t) || /abhi video|video abhi/.test(t);
}
function readLog() {
  try { const j = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')); return { handled: +j.handled || 0, kbv: +j.kbv || 0 }; }
  catch { return { handled: 0, kbv: 0 }; }
}
function out(k, v) { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); }

async function main() {
  if (!TOKEN || !CHAT) throw new Error('Bot token / chat id missing');
  const log = readLog();
  let changed = false, request = false;

  const r = await tg('getUpdates', { limit: 100, timeout: 0, allowed_updates: ['message'] });
  let newest = 0;
  for (const u of (r.result || [])) {
    const m = u && u.message;
    if (!m || String(m.chat && m.chat.id) !== String(CHAT) || !wantsVideo(m.text)) continue;
    if (u.update_id > log.handled && u.update_id > newest) newest = u.update_id;
  }
  if (newest) {                         // ek se zyada baar dabaya to bhi sirf ek video
    log.handled = newest; changed = true; request = true;
    await tg('sendMessage', { chat_id: CHAT, text: '⏳ Video ban rahi hai - kuch minute me aa jayegi.' });
  }
  if (log.kbv < KB_VER) {               // naya button chat me dikhao (sirf ek baar)
    await tg('sendMessage', { chat_id: CHAT, text: '🎬 Naya button: "Abhi video" dabao, ek video turant banegi.', reply_markup: KEYBOARD });
    log.kbv = KB_VER; changed = true;
  }
  if (changed) fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 1));
  console.log(`on-demand: request=${request} changed=${changed} handled=${log.handled}`);
  out('request', request); out('changed', changed);
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
