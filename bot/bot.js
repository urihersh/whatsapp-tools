require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const QRCode = require('qrcode');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
const pino = require('pino');

const BOT_PORT = parseInt(process.env.BOT_PORT || '3001');
const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://localhost:8000';
const SESSION_DIR = path.join(__dirname, '..', 'data', 'whatsapp-session');

fs.mkdirSync(SESSION_DIR, { recursive: true });

// --- State ---
let currentQR = null;
let isConnected = false;
let manuallyDisconnected = false;
let phoneInfo = null;
let allGroups = [];
let allChats = [];
let sock = null;

// --- Settings cache (avoids a DB round-trip on every incoming message) ---
let _cachedSettings = null;
let _settingsCacheTs = 0;
const SETTINGS_TTL_MS = 30_000;

async function getSettings() {
  const now = Date.now();
  if (_cachedSettings && now - _settingsCacheTs < SETTINGS_TTL_MS) {
    return _cachedSettings;
  }
  const res = await axios.get(`${PYTHON_API_URL}/api/settings`, { timeout: 5000 });
  _cachedSettings = res.data;
  _settingsCacheTs = now;
  return _cachedSettings;
}

// --- Media history stores: groupId -> Map<msgId, msg> ---
const imageHistory = new Map();
const videoHistory = new Map();
const MAX_PER_GROUP = 3000;
const MAX_VIDEOS_PER_GROUP = 500;

// --- Text history: groupId -> Array<{id, timestamp, sender, text}> ---
const textHistory = new Map();
const MAX_TEXT_PER_GROUP = 1000;

// --- Stat log: all messages (not just text) for accurate counts ---
// groupId -> Array<{ts, fromMe}> — in-memory, today + recent
const statLog = new Map();

// --- DM Inbox: unanswered direct messages ---
// jid -> { jid, name, text, timestamp, status: 'pending'|'snoozed'|'ignored', snoozeUntil }
const DM_INBOX_FILE = path.join(__dirname, '..', 'data', 'dm-inbox.json');
let dmInbox = {};
// Live unread counts from Baileys chat events — jid -> unreadCount
const dmUnreadCounts = new Map();
// Known contact display names — jid -> name (persisted so names survive restarts)
const contactNames = new Map();
const CONTACT_NAMES_FILE = path.join(__dirname, '..', 'data', 'contact-names.json');
let _saveContactNamesTimer = null;
function saveContactNames() {
  clearTimeout(_saveContactNamesTimer);
  _saveContactNamesTimer = setTimeout(() => {
    const obj = {};
    for (const [jid, name] of contactNames) obj[jid] = name;
    try { fs.writeFileSync(CONTACT_NAMES_FILE, JSON.stringify(obj)); } catch (_) {}
  }, 5000);
}
// DM text history for agent context: jid → [{ts, fromMe, text, sender}]
const dmTextHistory = new Map();
const MAX_DM_TEXT = 60;
// Conversation agents: jid → {jid, name, prompt, active, approval_mode, log: [{ts, role, text, sender?}]}
const agentConfigs = new Map();
// Prevent overlapping responses per JID
const agentBusy = new Set();
// Pending approval: jid → {text, ts, id}
const pendingApprovals = new Map();

// Simulate realistic typing delay based on message length
function humanDelay(text) {
  const base = Math.min(7000, Math.max(1200, text.length * 28));
  const jitter = (Math.random() - 0.5) * 1200;
  return Math.round(base + jitter);
}

function loadDmInbox() {
  try { dmInbox = JSON.parse(fs.readFileSync(DM_INBOX_FILE, 'utf8')); } catch (_) {}
}
function saveDmInbox() {
  try { fs.writeFileSync(DM_INBOX_FILE, JSON.stringify(dmInbox, null, 2)); } catch (_) {}
}
loadDmInbox();
// Load persisted contact names first, then overlay from dmInbox (dmInbox may be more recent)
try {
  const saved = JSON.parse(fs.readFileSync(CONTACT_NAMES_FILE, 'utf8'));
  for (const [jid, name] of Object.entries(saved)) contactNames.set(jid, name);
} catch (_) {}
// Seed/override from dmInbox — these entries are always fresh
for (const [jid, entry] of Object.entries(dmInbox)) {
  if (entry.name) contactNames.set(jid, entry.name);
}

// --- MazalTover: auto congratulations sender ---
const MAZALTOVER_LOG_FILE = path.join(__dirname, '..', 'data', 'mazaltover-log.json');
const MAZALTOVER_DETECTIONS_FILE = path.join(__dirname, '..', 'data', 'mazaltover-detections.json');
const MAZALTOVER_TRACKER_FILE = path.join(__dirname, '..', 'data', 'mazaltover-tracker.json');
let mazaltoverLog = [];
let mazaltoverDetections = []; // every individual hit ever caught
function loadMazaltoverLog() {
  try { mazaltoverLog = JSON.parse(fs.readFileSync(MAZALTOVER_LOG_FILE, 'utf8')); } catch (_) { mazaltoverLog = []; }
  try { mazaltoverDetections = JSON.parse(fs.readFileSync(MAZALTOVER_DETECTIONS_FILE, 'utf8')); } catch (_) { mazaltoverDetections = []; }
}
function saveMazaltoverLog() {
  try { fs.writeFileSync(MAZALTOVER_LOG_FILE, JSON.stringify(mazaltoverLog.slice(0, 200), null, 2)); } catch (_) {}
}
function saveMazaltoverDetections() {
  try { fs.writeFileSync(MAZALTOVER_DETECTIONS_FILE, JSON.stringify(mazaltoverDetections.slice(0, 1000), null, 2)); } catch (_) {}
}
loadMazaltoverLog();

// groupId → { senders: Set<string>, windowStart: number, lastSent: number, hits: [] }
const mazaltoverTracker = new Map();
function saveTrackerState() {
  try {
    const obj = {};
    for (const [jid, t] of mazaltoverTracker) {
      obj[jid] = { senders: [...t.senders], windowStart: t.windowStart, lastSent: t.lastSent, hits: t.hits || [] };
    }
    fs.writeFileSync(MAZALTOVER_TRACKER_FILE, JSON.stringify(obj, null, 2));
  } catch (_) {}
}
function loadTrackerState() {
  try {
    const obj = JSON.parse(fs.readFileSync(MAZALTOVER_TRACKER_FILE, 'utf8'));
    for (const [jid, t] of Object.entries(obj)) {
      mazaltoverTracker.set(jid, {
        senders: new Set(Array.isArray(t.senders) ? t.senders : []),
        windowStart: t.windowStart || Date.now(),
        lastSent: t.lastSent || 0,
        hits: Array.isArray(t.hits) ? t.hits : [],
      });
    }
  } catch (_) {}
}
loadTrackerState();
const MAZALTOV_RE = /מזל[\s]*טוב|mazel[\s]*tov|mazal[\s]*tov|congrat|ברכות/i;
const DM_SKIP_TYPES = new Set([
  'protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage',
  'messageContextInfo', 'pollUpdateMessage', 'pollCreationMessage',
  'callLogMessage', 'peerDataOperationRequestMessage',
]);
const MAZALTOV_EMOJI_RE = /🎊|🎉|🥳/;
function isMazaltovMsg(text) {
  return !!text && (MAZALTOV_RE.test(text) || MAZALTOV_EMOJI_RE.test(text));
}

function formatAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
const TEXT_LOG_DIR = path.join(__dirname, '..', 'data', 'text-history');
fs.mkdirSync(TEXT_LOG_DIR, { recursive: true });

function textLogPath(jid) {
  return path.join(TEXT_LOG_DIR, jid.replace(/[^a-zA-Z0-9_-]/g, '_') + '.jsonl');
}

function loadTextHistory() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // keep 7 days
  for (const file of fs.readdirSync(TEXT_LOG_DIR)) {
    if (!file.endsWith('.jsonl')) continue;
    // groupId is read from the stored entry itself, not derived from filename
    try {
      const lines = fs.readFileSync(path.join(TEXT_LOG_DIR, file), 'utf8').trim().split('\n').filter(Boolean);
      const msgs = lines.map(l => JSON.parse(l)).filter(m => m.timestamp >= cutoff);
      if (msgs.length) {
        // use the groupId stored in the entry itself
        const gid = msgs[0].groupId;
        textHistory.set(gid, msgs.slice(-MAX_TEXT_PER_GROUP));
      }
    } catch (_) {}
  }
}
loadTextHistory();

// Seed statLog from persisted textHistory so today's counts survive bot restarts
for (const [jid, messages] of textHistory) {
  if (!statLog.has(jid)) statLog.set(jid, []);
  const entries = statLog.get(jid);
  for (const msg of messages) {
    entries.push({ ts: msg.timestamp, fromMe: msg.sender === 'Me' });
  }
}

// Clear inbox entries where statLog shows a reply was sent after the last received message
// (runs after statLog is seeded — catches replies made while bot was offline)
function cleanInboxFromStatLog() {
  let changed = false;
  for (const [jid, entry] of Object.entries(dmInbox)) {
    const entries = statLog.get(jid) || [];
    const repliedAfter = entries.some(e => e.fromMe && e.ts > entry.timestamp);
    if (repliedAfter) { delete dmInbox[jid]; changed = true; }
  }
  if (changed) saveDmInbox();
}
cleanInboxFromStatLog();

// Oldest message cursor per group (used for fetchMessageHistory requests)
const groupCursors = new Map(); // groupId -> { key, timestampMs }
// Last known message timestamp per chat (from chats.upsert, used as fallback cursor)
const chatLastTs = new Map(); // jid -> timestampMs

function isImageMsg(msg) {
  const msgType = Object.keys(msg.message || {})[0];
  return msgType === 'imageMessage' ||
    (msgType === 'documentMessage' && (msg.message?.documentMessage?.mimetype || '').startsWith('image/'));
}

function isVideoMsg(msg) {
  const msgType = Object.keys(msg.message || {})[0];
  return msgType === 'videoMessage' ||
    (msgType === 'documentMessage' && (msg.message?.documentMessage?.mimetype || '').startsWith('video/'));
}

function getSender(msg) {
  const jid = msg.key.participant || msg.key.remoteJid || '';
  const [localPart, domain] = jid.split('@');
  if (domain === 'lid') return msg.pushName || contactNames.get(jid) || 'Unknown';
  return msg.pushName || contactNames.get(jid) || localPart;
}

function updateCursor(msg) {
  const jid = msg.key?.remoteJid;
  if (!jid?.endsWith('@g.us')) return;
  const ts = ((msg.messageTimestamp || 0) * 1000);
  const cur = groupCursors.get(jid);
  if (!cur || ts < cur.timestampMs) {
    groupCursors.set(jid, { key: msg.key, timestampMs: ts });
  }
}

function storeMediaMsg(msg) {
  const jid = msg.key?.remoteJid;
  if (!jid?.endsWith('@g.us')) return;
  updateCursor(msg);
  if (isImageMsg(msg)) {
    if (!imageHistory.has(jid)) imageHistory.set(jid, new Map());
    const byJid = imageHistory.get(jid);
    byJid.set(msg.key.id, msg);
    if (byJid.size > MAX_PER_GROUP) byJid.delete(byJid.keys().next().value);
  } else if (isVideoMsg(msg)) {
    if (!videoHistory.has(jid)) videoHistory.set(jid, new Map());
    const byJid = videoHistory.get(jid);
    byJid.set(msg.key.id, msg);
    if (byJid.size > MAX_VIDEOS_PER_GROUP) byJid.delete(byJid.keys().next().value);
  }
}

function storeStatEntry(msg) {
  const jid = msg.key?.remoteJid;
  if (!jid) return;
  // Capture pushName for DM contacts whenever we see it
  if (msg.pushName && jid.endsWith('@s.whatsapp.net') && contactNames.get(jid) !== msg.pushName) {
    contactNames.set(jid, msg.pushName);
    saveContactNames();
  }
  if (!statLog.has(jid)) statLog.set(jid, []);
  statLog.get(jid).push({
    ts: (msg.messageTimestamp || 0) * 1000,
    fromMe: !!msg.key.fromMe,
  });
}

function storeTextMsg(msg) {
  const jid = msg.key?.remoteJid;
  if (!jid?.endsWith('@g.us')) return;
  const msgType = Object.keys(msg.message || {})[0];
  let text = '';
  if (msgType === 'conversation') {
    text = msg.message.conversation;
  } else if (msgType === 'extendedTextMessage') {
    text = msg.message.extendedTextMessage?.text || '';
  }
  if (!text) return;
  if (!textHistory.has(jid)) textHistory.set(jid, []);
  const arr = textHistory.get(jid);
  const entry = {
    groupId: jid,
    id: msg.key.id,
    timestamp: (msg.messageTimestamp || 0) * 1000,
    sender: msg.key.fromMe ? 'Me' : getSender(msg),
    text,
  };
  arr.push(entry);
  if (arr.length > MAX_TEXT_PER_GROUP) textHistory.set(jid, arr.slice(-MAX_TEXT_PER_GROUP));
  try { fs.appendFileSync(textLogPath(jid), JSON.stringify(entry) + '\n'); } catch (_) {}
}

// --- WhatsApp connection ---
async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['WA Assistant', 'Chrome', '1.0'],
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messaging-history.set', ({ messages }) => {
    for (const msg of (messages || [])) {
      updateCursor(msg);  // track oldest for all message types
      storeMediaMsg(msg); // store images and videos
      storeTextMsg(msg);  // populate textHistory + statLog so groups show up in analytics
    }
    if (messages?.length) console.log(`[bot] History sync: processed ${messages.length} messages`);
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      isConnected = false;
      console.log('[bot] QR code ready — open the Settings page to scan.');
    }

    if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      const me = sock.user;
      const number = me.id.split(':')[0];
      phoneInfo = { number, name: me.name || `+${number}` };
      console.log(`[bot] Connected as ${phoneInfo.name} (+${phoneInfo.number})`);
      // Mark presence as unavailable so WhatsApp doesn't suppress phone notifications
      await sock.sendPresenceUpdate('unavailable');
      await refreshGroupsAndChats();
    }

    if (connection === 'close') {
      isConnected = false;
      phoneInfo = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (manuallyDisconnected) {
        console.log('[bot] Disconnected manually — not reconnecting.');
        return;
      }
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`[bot] Disconnected (code ${code}). Reconnect: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(connect, 5000);
      } else {
        // Logged out — clear session so QR is shown again
        fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        fs.mkdirSync(SESSION_DIR, { recursive: true });
        setTimeout(connect, 3000);
      }
    }
  });

  // Track unread counts and clear inbox when a DM chat is read
  function syncChatCounts(chats) {
    let changed = false;
    for (const chat of chats) {
      const jid = chat.id;
      if (!jid) continue;
      // Track last message timestamp for all chats (used as fallback history cursor)
      if (chat.lastMsgTimestamp) {
        const ts = Number(chat.lastMsgTimestamp) * 1000;
        if (!chatLastTs.has(jid) || ts > chatLastTs.get(jid)) chatLastTs.set(jid, ts);
      }
      if (!jid.endsWith('@s.whatsapp.net')) continue;
      if (typeof chat.unreadCount === 'number') {
        dmUnreadCounts.set(jid, chat.unreadCount);
        if (dmInbox[jid] && chat.unreadCount <= 0) {
          delete dmInbox[jid];
          changed = true;
        }
      }
    }
    if (changed) saveDmInbox();
  }
  sock.ev.on('chats.update', syncChatCounts);
  sock.ev.on('chats.upsert', syncChatCounts);

  // Seed contactNames from WhatsApp's own contact store so display names are
  // available for contacts who haven't sent a message since the bot started.
  sock.ev.on('contacts.set', ({ contacts }) => {
    let changed = false;
    for (const c of (contacts || [])) {
      const name = c.notify || c.name;
      if (c.id && name && contactNames.get(c.id) !== name) {
        contactNames.set(c.id, name);
        changed = true;
      }
    }
    if (changed) saveContactNames();
  });
  sock.ev.on('contacts.upsert', contacts => {
    let changed = false;
    for (const c of (contacts || [])) {
      const name = c.notify || c.name;
      if (c.id && name && contactNames.get(c.id) !== name) {
        contactNames.set(c.id, name);
        changed = true;
      }
    }
    if (changed) saveContactNames();
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify' = new live message; 'append' = historical sync from device
    const isHistory = type === 'append';

    for (const msg of messages) {
      updateCursor(msg);
      storeStatEntry(msg);
      storeTextMsg(msg);
      // Track unanswered DMs — only real person-to-person chats
      const dmJid = msg.key?.remoteJid;
      const isDM = dmJid && dmJid.endsWith('@s.whatsapp.net');
      const dmPhone = isDM ? dmJid.split('@')[0] : '';
      // Valid phone: 7–15 digits, not our own number
      const isValidDM = isDM && dmPhone.length >= 7 && dmPhone.length <= 15
        && dmPhone !== (phoneInfo?.number || '');
      if (isValidDM && msg.key.fromMe && dmInbox[dmJid]) {
        // Sent a reply → clear from inbox (applies to live events and history replay)
        delete dmInbox[dmJid]; saveDmInbox();
      }
      if (isValidDM && msg.pushName) contactNames.set(dmJid, msg.pushName);

      // Track DM text history (for agent context)
      if (isValidDM && msg.message) {
        const msgType = Object.keys(msg.message)[0];
        let dmText = null;
        if (msgType === 'conversation') dmText = msg.message.conversation;
        else if (msgType === 'extendedTextMessage') dmText = msg.message.extendedTextMessage?.text;
        if (dmText) {
          if (!dmTextHistory.has(dmJid)) dmTextHistory.set(dmJid, []);
          const hist = dmTextHistory.get(dmJid);
          hist.push({ ts: (msg.messageTimestamp || 0) * 1000 || Date.now(), fromMe: !!msg.key.fromMe, text: dmText, sender: msg.key.fromMe ? 'Me' : (msg.pushName || dmJid.split('@')[0]) });
          if (hist.length > MAX_DM_TEXT) dmTextHistory.set(dmJid, hist.slice(-MAX_DM_TEXT));
        }
      }

      if (!isHistory && isValidDM && !msg.key.fromMe) {
        const msgType = Object.keys(msg.message || {})[0];
        if (msg.message && msgType && !DM_SKIP_TYPES.has(msgType)) {
          // Received real DM → track as unanswered
          let text = '[message]';
          if (msgType === 'conversation') text = msg.message.conversation;
          else if (msgType === 'extendedTextMessage') text = msg.message.extendedTextMessage?.text || '[message]';
          else if (msgType === 'imageMessage') text = '[photo]';
          else if (msgType === 'videoMessage') text = '[video]';
          else if (msgType === 'audioMessage') text = '[voice message]';
          else if (msgType === 'documentMessage') text = '[file]';
          else if (msgType === 'stickerMessage') text = '[sticker]';
          dmInbox[dmJid] = {
            jid: dmJid,
            name: msg.pushName || dmPhone,
            text: text.slice(0, 120),
            timestamp: (msg.messageTimestamp || 0) * 1000,
            status: dmInbox[dmJid]?.status === 'ignored' ? 'ignored' : 'pending',
            snoozeUntil: dmInbox[dmJid]?.snoozeUntil || null,
          };
          saveDmInbox();
        }
      }

      // ── MazalTover: if I sent מזל טוב myself, apply cooldown so bot stands down ──
      if (!isHistory && msg.key.fromMe && msg.key.remoteJid?.endsWith('@g.us')) {
        const groupJid = msg.key.remoteJid;
        try {
          const settings = await getSettings();
          const mazaltovGroups = JSON.parse(settings.mazaltov_groups || '[]');
          const config = mazaltovGroups.find(g => g.id === groupJid);
          if (config) {
            const msgType = Object.keys(msg.message || {})[0];
            let text = '';
            if (msgType === 'conversation') text = msg.message.conversation || '';
            else if (msgType === 'extendedTextMessage') text = msg.message.extendedTextMessage?.text || '';
            if (isMazaltovMsg(text)) {
              if (!mazaltoverTracker.has(groupJid)) {
                mazaltoverTracker.set(groupJid, { senders: new Set(), windowStart: Date.now(), lastSent: 0, hits: [] });
              }
              const tracker = mazaltoverTracker.get(groupJid);
              const cooldownMs = (parseInt(config.cooldown_hours) || 24) * 3600000;
              tracker.lastSent = Date.now();
              tracker.senders.clear();
              tracker.hits = [];
              saveTrackerState();
              console.log(`[mazaltover] You sent mazal tov in ${config.name || groupJid} — cooldown applied`);
            }
          }
        } catch (e) {
          console.error('[mazaltover] Error (fromMe check):', e.message);
        }
      }

      // ── MazalTover: auto-congrats for group messages ──
      if (!isHistory && !msg.key.fromMe && msg.key.remoteJid?.endsWith('@g.us')) {
        const groupJid = msg.key.remoteJid;
        try {
          const settings = await getSettings();
          const mazaltovGroups = JSON.parse(settings.mazaltov_groups || '[]');
          const config = mazaltovGroups.find(g => g.id === groupJid);
          if (config) {
            const msgType = Object.keys(msg.message || {})[0];
            let text = '';
            if (msgType === 'conversation') text = msg.message.conversation || '';
            else if (msgType === 'extendedTextMessage') text = msg.message.extendedTextMessage?.text || '';
            if (isMazaltovMsg(text)) {
              const sender = msg.key.participant || groupJid;
              const now = Date.now();
              const windowMs = (parseInt(config.window_minutes) || 30) * 60 * 1000;
              if (!mazaltoverTracker.has(groupJid)) {
                mazaltoverTracker.set(groupJid, { senders: new Set(), windowStart: now, lastSent: 0 });
              }
              const tracker = mazaltoverTracker.get(groupJid);
              if (now - tracker.windowStart > windowMs) {
                tracker.senders.clear();
                tracker.hits = [];
                tracker.windowStart = now;
                saveTrackerState();
              }
              tracker.senders.add(sender);
              if (!tracker.hits) tracker.hits = [];
              const senderName = getSender(msg);
              tracker.hits.push({ sender: senderName, text, ts: now });
              // Persist every individual detection to the detections log
              mazaltoverDetections.unshift({ groupId: groupJid, groupName: config.name || groupJid, sender: senderName, text, ts: now });
              saveMazaltoverDetections();
              saveTrackerState();
              // Skip if today is user's birthday (avoid congratulating yourself)
              const birthday = settings.my_birthday || '';
              const today = new Date();
              const todayMD = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
              const isBirthday = birthday && birthday === todayMD;
              const threshold = parseInt(config.threshold) || 3;
              const cooldownMs = (parseInt(config.cooldown_hours) || 24) * 3600000;
              if (!isBirthday && tracker.senders.size >= threshold && (now - tracker.lastSent) > cooldownMs) {
                tracker.lastSent = now;
                tracker.senders.clear();
                tracker.hits = [];
                saveTrackerState();
                const message = config.message || 'מזל טוב! 🎉';
                await sock.sendMessage(groupJid, { text: message });
                mazaltoverLog.unshift({ groupId: groupJid, groupName: config.name || groupJid, message, sentAt: now });
                saveMazaltoverLog();
                console.log(`[mazaltover] Sent to ${config.name || groupJid}`);
              }
            }
          }
        } catch (e) {
          console.error('[mazaltover] Error:', e.message);
        }
      }

      // ── Conversation agent ──
      if (!isHistory && !msg.key.fromMe) {
        const agentJid = msg.key.remoteJid;
        const agent = agentConfigs.get(agentJid);
        if (agent?.active && !agentBusy.has(agentJid) && isConnected) {
          agentBusy.add(agentJid);
          // Extract text of the triggering message
          const msgType = Object.keys(msg.message || {})[0];
          let triggerText = '[message]';
          if (msgType === 'conversation') triggerText = msg.message.conversation;
          else if (msgType === 'extendedTextMessage') triggerText = msg.message.extendedTextMessage?.text || '[message]';
          else if (msgType === 'imageMessage') triggerText = '[photo]';
          else if (msgType === 'videoMessage') triggerText = '[video]';
          else if (msgType === 'audioMessage') triggerText = '[voice message]';
          else if (msgType === 'stickerMessage') triggerText = '[sticker]';
          const senderName = msg.pushName || contactNames.get(agentJid) || agentJid.split('@')[0];
          agent.log.push({ ts: Date.now(), role: 'incoming', text: triggerText, sender: senderName });
          if (agent.log.length > 200) agent.log = agent.log.slice(-200);

          // Build history context
          let history = [];
          if (agentJid.endsWith('@g.us')) {
            history = (textHistory.get(agentJid) || []).slice(-30).map(m => ({ ts: m.timestamp, fromMe: false, text: m.text, sender: m.sender }));
          } else {
            history = (dmTextHistory.get(agentJid) || []).slice(-30);
          }

          // Fire-and-forget agent reply
          (async () => {
            try {
              const res = await axios.post(`${PYTHON_API_URL}/api/agent/reply`, {
                prompt: agent.prompt,
                history,
                contact_name: agent.name,
              }, { timeout: 45000 });
              const reply = res.data?.reply;
              if (!reply) { agentBusy.delete(agentJid); return; }

              if (agent.approval_mode) {
                // Hold for user approval — keep agentBusy set until resolved
                const id = Date.now().toString();
                pendingApprovals.set(agentJid, { id, text: reply, ts: Date.now() });
                agent.log.push({ ts: Date.now(), role: 'pending', text: reply, id });
                if (agent.log.length > 200) agent.log = agent.log.slice(-200);
                // agentBusy stays set until approve/reject clears it
              } else {
                if (isConnected) {
                  await new Promise(r => setTimeout(r, humanDelay(reply)));
                  await sock.sendMessage(agentJid, { text: reply });
                  agent.log.push({ ts: Date.now(), role: 'outgoing', text: reply });
                  if (agent.log.length > 200) agent.log = agent.log.slice(-200);
                  if (agentJid.endsWith('@s.whatsapp.net')) {
                    if (!dmTextHistory.has(agentJid)) dmTextHistory.set(agentJid, []);
                    dmTextHistory.get(agentJid).push({ ts: Date.now(), fromMe: true, text: reply, sender: 'Me' });
                  }
                }
                agentBusy.delete(agentJid);
              }
            } catch (e) {
              console.error('[agent] Reply failed:', e.message);
              agent.log.push({ ts: Date.now(), role: 'error', text: `Failed to generate reply: ${e.message}` });
              agentBusy.delete(agentJid);
            }
          })();
        }
      }

      if (isHistory) continue; // don't re-process old media/actions for history
      if (!msg.key.fromMe) {
        storeMediaMsg(msg);
      }

      // ── Enroll-from-DM: image in a direct chat with caption "enroll <name>" ──
      if (isImageMsg(msg)) {
        const remoteJid = msg.key.remoteJid || '';
        const isDM = !remoteJid.endsWith('@g.us');
        const msgType = Object.keys(msg.message || {})[0];
        const caption = (
          msg.message?.imageMessage?.caption ||
          msg.message?.documentMessage?.caption || ''
        ).trim();
        if (isDM && /^enroll\s+\S/i.test(caption)) {
          const kidName = caption.replace(/^enroll\s+/i, '').trim();
          console.log(`[bot] Enroll-from-DM: "${kidName}" from ${remoteJid}`);
          try {
            let buffer;
            try {
              buffer = await downloadMediaMessage(msg, 'buffer', {});
            } catch (e) {
              await sock.sendMessage(remoteJid, { text: `❌ Could not download photo: ${e.message}` });
              continue;
            }
            // Find or create kid
            const kidsRes = await axios.get(`${PYTHON_API_URL}/api/enrollment/kids`, { timeout: 5000 });
            let kid = (kidsRes.data.kids || []).find(k => k.name.toLowerCase() === kidName.toLowerCase());
            if (!kid) {
              const createRes = await axios.post(`${PYTHON_API_URL}/api/enrollment/kids`,
                { name: kidName }, { timeout: 5000 });
              kid = createRes.data;
            }
            // Upload photo
            const form = new FormData();
            form.append('file', buffer, { filename: 'enroll.jpg', contentType: 'image/jpeg' });
            const uploadRes = await axios.post(
              `${PYTHON_API_URL}/api/enrollment/kids/${kid.id}/upload`,
              form, { headers: form.getHeaders(), timeout: 30000 }
            );
            const { photo_id } = uploadRes.data;
            // Confirm enrollment
            const confirmRes = await axios.post(
              `${PYTHON_API_URL}/api/enrollment/kids/${kid.id}/confirm/${photo_id}`,
              {}, { timeout: 10000 }
            );
            const count = confirmRes.data.enrolled_count || 1;
            await sock.sendMessage(remoteJid, {
              text: `✅ Photo enrolled for ${kid.name}! They now have ${count} enrolled photo${count !== 1 ? 's' : ''}.`
            });
          } catch (e) {
            const reason = e.response?.data?.detail || e.message;
            await sock.sendMessage(remoteJid, { text: `❌ Enrollment failed: ${reason}. Try a clearer photo with a visible face.` });
          }
          continue;
        }
      }

      if (msg.key.fromMe) continue;

      const isImage = isImageMsg(msg);
      const isVideo = isVideoMsg(msg);
      if (!isImage && !isVideo) continue;

      const groupId = msg.key.remoteJid;
      if (!groupId?.endsWith('@g.us')) continue;

      let settings;
      try {
        settings = await getSettings();
      } catch (e) {
        console.error('[bot] Could not fetch settings:', e.message);
        continue;
      }

      let watchGroups = [];
      try { watchGroups = JSON.parse(settings.watch_groups || '[]'); } catch (_) {}
      const groupConfig = watchGroups.find(g => g.id === groupId);
      if (!groupConfig) continue;

      const forwardToId = settings.forward_to_id;
      if (!forwardToId) continue;

      const groupName = groupConfig.name || groupId;
      const mediaType = isVideo ? 'Video' : 'Image';
      console.log(`[bot] ${mediaType} received from "${groupName}", downloading...`);

      let buffer;
      try {
        buffer = await downloadMediaMessage(msg, 'buffer', {});
      } catch (e) {
        console.error('[bot] Failed to download media:', e.message);
        continue;
      }

      const senderName = getSender(msg);

      try {
        const form = new FormData();
        if (isVideo) {
          form.append('file', buffer, { filename: 'video.mp4', contentType: 'video/mp4' });
        } else {
          form.append('file', buffer, { filename: 'photo.jpg', contentType: 'image/jpeg' });
        }

        const endpoint = isVideo ? 'analyze-video' : 'analyze';
        const timeout = isVideo ? 90000 : 30000;
        const res = await axios.post(
          `${PYTHON_API_URL}/api/${endpoint}?group_id=${encodeURIComponent(groupId)}&group_name=${encodeURIComponent(groupName)}&sender=${encodeURIComponent(senderName)}`,
          form,
          { headers: { ...form.getHeaders() }, timeout }
        );

        const result = res.data;
        const matchedKids = (result.matches || []).filter(m => m.matched);
        const extra = isVideo ? ` frames_sampled=${result.frames_sampled}` : '';
        console.log(`[bot] matched=${result.matched}, faces=${result.faces_detected}${extra}, kids=${matchedKids.map(m => m.kid_name || m.kid_id).join(', ') || 'none'}`);

        if (result.matched) {
          const names = matchedKids.map(m => m.kid_name || 'your kid').join(' & ');
          const bestConf = Math.max(...matchedKids.map(m => m.confidence));
          const verb = matchedKids.length > 1 ? 'are' : 'is';
          const medium = isVideo ? 'video' : 'photo';
          // Forward original message (preserves group name, sender, and media)
          await sock.sendMessage(forwardToId, { forward: msg });
          // Follow-up text with match details
          await sock.sendMessage(forwardToId, {
            text: `${names} ${verb} in this ${medium}! (${(bestConf * 100).toFixed(0)}% confidence) — from "${groupName}"`,
          });
          console.log(`[bot] Forwarded to ${forwardToId}`);
        }
      } catch (e) {
        console.error('[bot] Analysis/forward failed:', e.message);
      }
    }
    // After history sync batches, clear any inbox entries the user already replied to
    if (isHistory) cleanInboxFromStatLog();
  });
}

async function refreshGroupsAndChats() {
  try {
    const chats = await sock.groupFetchAllParticipating();
    allGroups = Object.values(chats).map(g => ({ id: g.id, name: g.subject }));

    // Also get DM chats from store isn't available without a store,
    // so expose groups as both monitor options and forward options
    // plus build DM list from known contacts
    allChats = allGroups.map(g => ({ ...g, isGroup: true }));
    console.log(`[bot] Loaded ${allGroups.length} groups`);
  } catch (e) {
    console.error('[bot] Failed to load chats:', e.message);
  }
}

// --- Express API ---
const app = express();
app.use(express.json({ limit: '20mb' }));

app.get('/status', (req, res) => {
  const sessionExists = fs.readdirSync(SESSION_DIR).some(f => f.endsWith('.json'));
  res.json({ connected: isConnected, phone: phoneInfo, sessionExists });
});

app.get('/qr', async (req, res) => {
  if (!currentQR) return res.json({ qr: null });
  try {
    const dataUrl = await QRCode.toDataURL(currentQR);
    res.json({ qr: dataUrl });
  } catch (e) {
    res.json({ qr: null, error: e.message });
  }
});

app.post('/send-text', express.json(), async (req, res) => {
  if (!isConnected) return res.status(503).json({ error: 'Not connected' });
  const { to, text } = req.body;
  if (!text || !to) return res.status(400).json({ error: 'Missing to or text' });
  try {
    await sock.sendMessage(to, { text });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/history-text', (req, res) => {
  const { groupId, since = '0' } = req.query;
  if (!groupId) return res.status(400).json({ error: 'groupId required' });
  const sinceTs = parseInt(since);
  const arr = textHistory.get(groupId) || [];
  const filtered = sinceTs > 0 ? arr.filter(m => m.timestamp >= sinceTs) : arr;
  res.json({ messages: filtered });
});

app.post('/send', express.json({ limit: '20mb' }), async (req, res) => {
  if (!isConnected) return res.status(503).json({ error: 'Not connected' });
  const { to, caption, image_b64 } = req.body;
  if (!image_b64 || !to) return res.status(400).json({ error: 'Missing to or image_b64' });
  try {
    const buffer = Buffer.from(image_b64, 'base64');
    await sock.sendMessage(to, { image: buffer, caption: caption || '' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/send-video', express.json({ limit: '200mb' }), async (req, res) => {
  if (!isConnected) return res.status(503).json({ error: 'Not connected' });
  const { to, caption, video_b64 } = req.body;
  if (!video_b64 || !to) return res.status(400).json({ error: 'Missing to or video_b64' });
  try {
    const buffer = Buffer.from(video_b64, 'base64');
    await sock.sendMessage(to, { video: buffer, caption: caption || '' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/message-stats', (req, res) => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTs = todayStart.getTime();
  const weekTs = Date.now() - 7 * 24 * 60 * 60 * 1000;

  let todayReceived = 0, todaySent = 0;
  const groupMap = {};
  const hourly = new Array(24).fill(0);
  const last24Ts = Date.now() - 24 * 60 * 60 * 1000;

  for (const [groupId, entries] of statLog) {
    const group = allGroups.find(g => g.id === groupId);
    let todayCount = 0, weekCount = 0;
    for (const e of entries) {
      if (e.ts >= todayTs) {
        if (e.fromMe) todaySent++; else todayReceived++;
        todayCount++;
      }
      if (e.ts >= last24Ts) {
        // slot 0 = oldest hour, slot 23 = most recent hour
        const slotIndex = 23 - Math.floor((Date.now() - e.ts) / (60 * 60 * 1000));
        if (slotIndex >= 0 && slotIndex < 24) hourly[slotIndex]++;
      }
      if (e.ts >= weekTs) weekCount++;
    }
    if (weekCount > 0 && groupId.endsWith('@g.us')) {
      groupMap[groupId] = { id: groupId, name: group?.name || groupId, today: todayCount, week: weekCount };
    }
  }

  let todayMedia = 0;
  for (const [, msgs] of imageHistory) {
    for (const [, msg] of msgs) {
      if ((msg.messageTimestamp || 0) * 1000 >= todayTs) todayMedia++;
    }
  }
  for (const [, msgs] of videoHistory) {
    for (const [, msg] of msgs) {
      if ((msg.messageTimestamp || 0) * 1000 >= todayTs) todayMedia++;
    }
  }

  const groups = Object.values(groupMap).sort((a, b) => b.today - a.today || b.week - a.week).slice(0, 15);
  res.json({
    today: { received: todayReceived, sent: todaySent, media: todayMedia },
    groups,
    hourly,
    total_groups: allGroups.length,
    active_today: groups.filter(g => g.today > 0).length,
  });
});

app.get('/groups', async (req, res) => {
  if (isConnected && (allGroups.length === 0 || req.query.refresh)) await refreshGroupsAndChats();
  res.json({ groups: allGroups });
});

app.get('/chats', async (req, res) => {
  if (isConnected && (allChats.length === 0 || req.query.refresh)) await refreshGroupsAndChats();
  res.json({ chats: allChats });
});

app.post('/fetch-history', express.json(), async (req, res) => {
  if (!isConnected) return res.status(503).json({ error: 'Not connected' });
  const { groupId } = req.body;
  if (!groupId) return res.status(400).json({ error: 'groupId required' });

  const cursor = groupCursors.get(groupId);
  if (!cursor) {
    return res.status(404).json({ error: 'No messages seen for this group yet. Make sure the bot is connected and the group is monitored.' });
  }

  try {
    await sock.fetchMessageHistory(200, cursor.key, cursor.timestampMs);
    console.log(`[bot] Requested history for ${groupId} before ${new Date(cursor.timestampMs).toISOString()}`);
    res.json({ ok: true, oldest_known: new Date(cursor.timestampMs).toISOString() });
  } catch (e) {
    console.error('[bot] fetchMessageHistory error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Bulk history fetch: request history for all groups, using real cursors where
// available and synthetic ones (from chats.upsert lastMsgTimestamp) where not.
app.post('/fetch-history-all', express.json(), async (req, res) => {
  if (!isConnected) return res.status(503).json({ error: 'Not connected' });
  let sent = 0, skipped = 0;
  const results = [];
  for (const g of allGroups) {
    const jid = g.id;
    const cursor = groupCursors.get(jid);
    const lastTs = chatLastTs.get(jid);
    if (!cursor && !lastTs) { skipped++; continue; }
    try {
      if (cursor) {
        await sock.fetchMessageHistory(200, cursor.key, cursor.timestampMs);
      } else {
        // Synthetic cursor: use group JID + lastMsgTimestamp to request recent history
        const syntheticKey = { remoteJid: jid, fromMe: false, id: 'HISTORY_SYNC_REQUEST' };
        await sock.fetchMessageHistory(200, syntheticKey, lastTs);
      }
      results.push({ jid, name: g.name, type: cursor ? 'real' : 'synthetic' });
      sent++;
      // Small delay to avoid flooding WhatsApp
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.error(`[bot] History fetch failed for ${g.name}: ${e.message}`);
      skipped++;
    }
  }
  console.log(`[bot] Bulk history fetch: ${sent} requested, ${skipped} skipped`);
  res.json({ ok: true, sent, skipped, results });
});

app.get('/history-images', (req, res) => {
  const { groupId, since = '0' } = req.query;
  if (!groupId) return res.status(400).json({ error: 'groupId required' });
  const sinceTs = parseInt(since); // 0 = all history
  const byJid = imageHistory.get(groupId);
  if (!byJid) return res.json({ images: [], note: 'No history yet — messages are stored as they arrive after bot starts' });
  const images = [];
  for (const [id, msg] of byJid) {
    const ts = (msg.messageTimestamp || 0) * 1000;
    if (sinceTs > 0 && ts < sinceTs) continue;
    images.push({
      id,
      timestamp: ts,
      sender: getSender(msg),
    });
  }
  images.sort((a, b) => a.timestamp - b.timestamp);
  res.json({ images });
});

app.get('/download-image/:msgId', async (req, res) => {
  const { groupId } = req.query;
  const { msgId } = req.params;
  if (!groupId) return res.status(400).json({ error: 'groupId required' });
  const byJid = imageHistory.get(groupId);
  const msg = byJid?.get(msgId);
  if (!msg) return res.status(404).json({ error: 'Message not found in history' });
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    res.json({ image_b64: buffer.toString('base64') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/history-videos', (req, res) => {
  const { groupId, since = '0' } = req.query;
  if (!groupId) return res.status(400).json({ error: 'groupId required' });
  const sinceTs = parseInt(since);
  const byJid = videoHistory.get(groupId);
  if (!byJid) return res.json({ videos: [] });
  const videos = [];
  for (const [id, msg] of byJid) {
    const ts = (msg.messageTimestamp || 0) * 1000;
    if (sinceTs > 0 && ts < sinceTs) continue;
    videos.push({ id, timestamp: ts, sender: getSender(msg) });
  }
  videos.sort((a, b) => a.timestamp - b.timestamp);
  res.json({ videos });
});

app.get('/download-video/:msgId', async (req, res) => {
  const { groupId } = req.query;
  const { msgId } = req.params;
  if (!groupId) return res.status(400).json({ error: 'groupId required' });
  const byJid = videoHistory.get(groupId);
  const msg = byJid?.get(msgId);
  if (!msg) return res.status(404).json({ error: 'Message not found in history' });
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    res.json({ video_b64: buffer.toString('base64') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DM Inbox endpoints ──────────────────────────────────────────────────────

app.get('/dm-inbox', (req, res) => {
  const now = Date.now();
  const items = Object.values(dmInbox).filter(item => {
    if (item.status === 'ignored') return false;
    if (item.status === 'snoozed' && item.snoozeUntil && now < item.snoozeUntil) return false;
    if (item.status === 'snoozed' && (!item.snoozeUntil || now >= item.snoozeUntil)) {
      item.status = 'pending'; // snooze expired
    }
    // Hide if Baileys reports this chat as read
    const unread = dmUnreadCounts.get(item.jid);
    if (typeof unread === 'number' && unread <= 0) return false;
    return true;
  });
  items.sort((a, b) => a.timestamp - b.timestamp); // oldest first = most urgent
  res.json({ items, total: items.length });
});

app.post('/dm-inbox/ignore', express.json(), (req, res) => {
  const { jid } = req.body;
  if (dmInbox[jid]) { dmInbox[jid].status = 'ignored'; saveDmInbox(); }
  res.json({ ok: true });
});

app.post('/dm-inbox/snooze', express.json(), (req, res) => {
  const { jid, hours = 2 } = req.body;
  if (dmInbox[jid]) {
    dmInbox[jid].status = 'snoozed';
    dmInbox[jid].snoozeUntil = Date.now() + hours * 60 * 60 * 1000;
    saveDmInbox();
  }
  res.json({ ok: true });
});

app.post('/dm-inbox/remind', express.json(), async (req, res) => {
  const { jid } = req.body;
  if (!isConnected) return res.status(503).json({ error: 'Not connected' });
  const item = jid ? dmInbox[jid] : null;
  const myJid = phoneInfo?.number + '@s.whatsapp.net';
  if (!myJid) return res.status(503).json({ error: 'Not connected' });
  try {
    if (item) {
      await sock.sendMessage(myJid, {
        text: `📬 Reminder: unanswered message from *${item.name}* (${formatAgo(item.timestamp)})\n\n"${item.text}"`
      });
    } else {
      // Remind about all pending
      const pending = Object.values(dmInbox).filter(i => i.status === 'pending');
      if (!pending.length) return res.json({ ok: true, sent: 0 });
      const lines = pending.map(i => `• *${i.name}* — ${formatAgo(i.timestamp)}: "${i.text}"`).join('\n');
      await sock.sendMessage(myJid, { text: `📬 You have ${pending.length} unanswered DM${pending.length !== 1 ? 's' : ''}:\n\n${lines}` });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/// Top conversations: ranked by sent messages, with today counts
app.get('/activity-heatmap', (req, res) => {
  const days = parseInt(req.query.days || '30');
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const contacts = [];
  for (const [jid, entries] of statLog) {
    if (jid.endsWith('@lid')) continue; // anonymized privacy JIDs — unresolvable
    const hourBucket = new Array(24).fill(0);
    let sent = 0, received = 0, today = 0;
    for (const { ts, fromMe } of entries) {
      if (ts >= todayStart.getTime()) today++;
      if (ts < since) continue;
      if (fromMe) { sent++; hourBucket[new Date(ts).getHours()]++; }
      else received++;
    }
    if (sent + received === 0) continue;
    const peakHour = hourBucket.indexOf(Math.max(...hourBucket));
    const isGroup = jid.endsWith('@g.us');
    const group = isGroup ? allGroups.find(g => g.id === jid) : null;
    if (isGroup && !group) continue; // left or unknown group — skip
    const dmHistoryName = (dmTextHistory.get(jid) || []).findLast(m => !m.fromMe)?.sender;
    const name = group?.name || contactNames.get(jid) || dmInbox[jid]?.name || dmHistoryName || jid.split('@')[0];
    contacts.push({ jid, name, sent, received, today, peakHour, isGroup });
  }
  contacts.sort((a, b) => b.sent - a.sent);
  res.json({ contacts: contacts.slice(0, 12), days });
});

// Cross-group overview: totals, activity tiers, stale groups, top groups
app.get('/groups-overview', (req, res) => {
  const now = Date.now();
  const ms30d = 30 * 24 * 60 * 60 * 1000;
  const ms7d  =  7 * 24 * 60 * 60 * 1000;
  const ms1d  =      24 * 60 * 60 * 1000;

  const groupStats = allGroups.map(g => {
    const entries = statLog.get(g.id) || [];
    const msgs30d = entries.filter(e => e.ts >= now - ms30d).length;
    const msgs7d  = entries.filter(e => e.ts >= now - ms7d).length;
    const msgs1d  = entries.filter(e => e.ts >= now - ms1d).length;
    const lastTs  = entries.length ? Math.max(...entries.map(e => e.ts)) : 0;
    return { id: g.id, name: g.name, msgs30d, msgs7d, msgs1d, lastTs, hasHistory: entries.length > 0 };
  });

  const topGroups   = [...groupStats].filter(g => g.msgs30d > 0).sort((a, b) => b.msgs30d - a.msgs30d).slice(0, 10);
  const staleGroups = [...groupStats].filter(g => g.hasHistory && g.msgs30d === 0).sort((a, b) => b.lastTs - a.lastTs).slice(0, 10);

  res.json({
    total:       allGroups.length,
    activeToday: groupStats.filter(g => g.msgs1d  > 0).length,
    active7d:    groupStats.filter(g => g.msgs7d  > 0).length,
    staleCount:  groupStats.filter(g => g.hasHistory && g.msgs30d === 0).length,
    topGroups,
    staleGroups,
  });
});

// Single-group analysis: top writers, hourly/dow activity, emoji, trend
app.get('/group-analysis', (req, res) => {
  const { groupId, days = '30' } = req.query;
  if (!groupId) return res.status(400).json({ error: 'groupId required' });

  const daysInt = parseInt(days);
  const now = Date.now();
  const since = now - daysInt * 24 * 60 * 60 * 1000;
  const prevSince = since - daysInt * 24 * 60 * 60 * 1000;

  const allMsgs = textHistory.get(groupId) || [];
  const msgs = allMsgs.filter(m => m.timestamp >= since);
  const allEntries = statLog.get(groupId) || [];
  const entries = allEntries.filter(e => e.ts >= since);

  // Top writers (normalize LID-format senders — all-digit strings > 13 chars — to 'Unknown')
  const normalizeSender = s => (/^\d{14,}$/.test(s) ? 'Unknown' : s);
  const writerCounts = {};
  for (const m of msgs) {
    const sender = normalizeSender(m.sender);
    writerCounts[sender] = (writerCounts[sender] || 0) + 1;
  }
  const topWriters = Object.entries(writerCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([sender, count]) => ({ sender, count }));

  // Hourly buckets (all message types via statLog)
  const hourBuckets = new Array(24).fill(0);
  for (const e of entries) hourBuckets[new Date(e.ts).getHours()]++;

  // Day-of-week buckets
  const dowBuckets = new Array(7).fill(0);
  for (const e of entries) dowBuckets[new Date(e.ts).getDay()]++;

  // Stat counts
  const uniqueSenders = new Set(msgs.map(m => normalizeSender(m.sender))).size;
  let mediaCount = 0;
  for (const store of [imageHistory.get(groupId), videoHistory.get(groupId)]) {
    if (store) for (const [, msg] of store)
      if ((msg.messageTimestamp || 0) * 1000 >= since) mediaCount++;
  }
  const totalMessages = entries.length;
  const prevTotal = allEntries.filter(e => e.ts >= prevSince && e.ts < since).length;
  const trendPct = prevTotal === 0 ? null : Math.round((totalMessages - prevTotal) / prevTotal * 100);

  // Top emoji
  const EMOJI_RE = /\p{Emoji_Presentation}/gu;
  const emojiCounts = {};
  for (const m of msgs) {
    if (!m.text) continue;
    for (const e of (m.text.match(EMOJI_RE) || [])) emojiCounts[e] = (emojiCounts[e] || 0) + 1;
  }
  const topEmoji = Object.entries(emojiCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([emoji, count]) => ({ emoji, count }));

  const group = allGroups.find(g => g.id === groupId);
  res.json({
    groupId, groupName: group?.name || groupId, days: daysInt,
    totalMessages, uniqueSenders, mediaCount, trendPct,
    topWriters, hourBuckets, dowBuckets, topEmoji,
    textMessageCount: msgs.length,
  });
});

// MazalTover log + pending counts
app.get('/mazaltover-log', (req, res) => {
  const trackers = {};
  for (const [jid, t] of mazaltoverTracker) {
    trackers[jid] = {
      count: t.senders.size,
      windowStart: t.windowStart,
      lastSent: t.lastSent,
      hits: t.hits || [],
    };
  }
  res.json({ log: mazaltoverLog, detections: mazaltoverDetections, trackers });
});

// Send a reply directly to a JID (used by Inbox suggest-reply feature)
app.post('/inbox/send-reply', express.json(), async (req, res) => {
  if (!isConnected) return res.status(503).json({ error: 'Not connected' });
  const { jid, text } = req.body;
  if (!jid || !text) return res.status(400).json({ error: 'Missing jid or text' });
  try {
    await sock.sendMessage(jid, { text });
    if (dmInbox[jid]) { delete dmInbox[jid]; saveDmInbox(); }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DM overview ──────────────────────────────────────────────────────────────
app.get('/dm-overview', (req, res) => {
  const now = Date.now();
  const ms30d = 30 * 24 * 60 * 60 * 1000;
  const ms7d  =  7 * 24 * 60 * 60 * 1000;
  const ms1d  =      24 * 60 * 60 * 1000;

  // Build name lookup: contactNames + dmInbox + dmTextHistory
  const nameFor = jid => {
    if (contactNames.has(jid)) return contactNames.get(jid);
    if (dmInbox[jid]?.name) return dmInbox[jid].name;
    const hist = dmTextHistory.get(jid) || [];
    return hist.findLast(m => !m.fromMe && m.sender)?.sender || jid.split('@')[0];
  };

  // Collect all known DM JIDs: union of statLog, contactNames, dmInbox, dmTextHistory
  const allDmJids = new Set();
  for (const jid of contactNames.keys()) if (jid.endsWith('@s.whatsapp.net')) allDmJids.add(jid);
  for (const jid of Object.keys(dmInbox)) if (jid.endsWith('@s.whatsapp.net')) allDmJids.add(jid);
  for (const jid of dmTextHistory.keys()) if (jid.endsWith('@s.whatsapp.net')) allDmJids.add(jid);
  for (const jid of statLog.keys()) if (jid.endsWith('@s.whatsapp.net')) allDmJids.add(jid);

  const dmStats = [];
  for (const jid of allDmJids) {
    const entries = statLog.get(jid) || [];
    const hist    = dmTextHistory.get(jid) || [];
    const msgs30d = entries.filter(e => e.ts >= now - ms30d).length;
    const msgs7d  = entries.filter(e => e.ts >= now - ms7d).length;
    const msgs1d  = entries.filter(e => e.ts >= now - ms1d).length;
    const lastStatTs = entries.length ? Math.max(...entries.map(e => e.ts)) : 0;
    const lastHistTs = hist.length ? Math.max(...hist.map(m => m.ts)) : 0;
    const lastTs  = Math.max(lastStatTs, lastHistTs, (dmInbox[jid]?.timestamp || 0) * 1000);
    const lastMsg = [...entries].reverse().find(Boolean);
    const waitingForReply = lastMsg?.fromMe && msgs30d > 0;
    dmStats.push({ jid, name: nameFor(jid), msgs30d, msgs7d, msgs1d, lastTs, hasHistory: lastTs > 0, waitingForReply });
  }

  const pending = Object.values(dmInbox).filter(e => e.status === 'pending').length;
  const mostActive  = [...dmStats].filter(g => g.msgs30d > 0).sort((a, b) => b.msgs30d - a.msgs30d).slice(0, 10);
  const stale       = [...dmStats].filter(g => g.hasHistory && g.msgs30d === 0).sort((a, b) => b.lastTs - a.lastTs).slice(0, 10);
  const noReply     = [...dmStats].filter(g => g.waitingForReply).sort((a, b) => a.lastTs - b.lastTs).slice(0, 6);

  res.json({
    total:       dmStats.length,
    pending,
    activeToday: dmStats.filter(g => g.msgs1d > 0).length,
    active7d:    dmStats.filter(g => g.msgs7d > 0).length,
    mostActive, stale, noReply,
  });
});

// ── Known DM contacts ────────────────────────────────────────────────────────
app.get('/contacts', (req, res) => {
  const seen = new Map(); // jid -> name

  // Seed from contactNames (pushName from incoming messages)
  for (const [jid, name] of contactNames) {
    if (jid.endsWith('@s.whatsapp.net')) seen.set(jid, name);
  }

  // Fill gaps from dmTextHistory (sender field on received messages)
  for (const [jid, msgs] of dmTextHistory) {
    if (!jid.endsWith('@s.whatsapp.net') || seen.has(jid)) continue;
    const name = msgs.findLast(m => !m.fromMe && m.sender)?.sender;
    if (name) seen.set(jid, name);
  }

  // Fill gaps from dmInbox (has name captured at receipt time)
  for (const [jid, entry] of Object.entries(dmInbox)) {
    if (!jid.endsWith('@s.whatsapp.net') || seen.has(jid)) continue;
    if (entry.name) seen.set(jid, entry.name);
  }

  const contacts = [...seen.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ contacts });
});

app.post('/contacts/save', express.json(), (req, res) => {
  const { jid, name } = req.body;
  if (!jid || !name) return res.status(400).json({ error: 'jid and name required' });
  contactNames.set(jid, name);
  saveContactNames();
  res.json({ ok: true });
});

// ── Conversation agent endpoints ─────────────────────────────────────────────
app.post('/agent/start', (req, res) => {
  const { jid, name, prompt, approval_mode } = req.body;
  if (!jid || !prompt) return res.status(400).json({ error: 'jid and prompt required' });
  const existing = agentConfigs.get(jid);
  agentConfigs.set(jid, {
    jid,
    name: name || jid.split('@')[0],
    prompt,
    active: true,
    approval_mode: !!approval_mode,
    log: existing?.log || [],
  });
  console.log(`[agent] Started for ${name || jid}${approval_mode ? ' (approval mode)' : ''}`);
  res.json({ ok: true });
});

app.get('/agent/pending', (req, res) => {
  const jid = req.query.jid;
  const pending = pendingApprovals.get(jid) || null;
  res.json({ pending });
});

app.post('/agent/approve', express.json(), async (req, res) => {
  const { jid, text } = req.body;
  if (!jid) return res.status(400).json({ error: 'jid required' });
  const pending = pendingApprovals.get(jid);
  if (!pending) return res.status(404).json({ error: 'No pending message' });
  const finalText = (text || pending.text).trim();
  pendingApprovals.delete(jid);
  try {
    if (!isConnected) throw new Error('Not connected');
    await new Promise(r => setTimeout(r, humanDelay(finalText)));
    await sock.sendMessage(jid, { text: finalText });
    const agent = agentConfigs.get(jid);
    if (agent) {
      // Replace pending entry with outgoing
      const idx = agent.log.findIndex(e => e.role === 'pending' && e.id === pending.id);
      if (idx !== -1) agent.log[idx] = { ts: Date.now(), role: 'outgoing', text: finalText };
      else agent.log.push({ ts: Date.now(), role: 'outgoing', text: finalText });
    }
    if (jid.endsWith('@s.whatsapp.net')) {
      if (!dmTextHistory.has(jid)) dmTextHistory.set(jid, []);
      dmTextHistory.get(jid).push({ ts: Date.now(), fromMe: true, text: finalText, sender: 'Me' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    agentBusy.delete(jid);
  }
});

app.post('/agent/reject', express.json(), (req, res) => {
  const { jid } = req.body;
  if (!jid) return res.status(400).json({ error: 'jid required' });
  pendingApprovals.delete(jid);
  const agent = agentConfigs.get(jid);
  if (agent) {
    const idx = agent.log.findIndex(e => e.role === 'pending');
    if (idx !== -1) agent.log[idx] = { ...agent.log[idx], role: 'rejected' };
  }
  agentBusy.delete(jid);
  res.json({ ok: true });
});

app.post('/agent/stop', express.json(), (req, res) => {
  const { jid } = req.body;
  const agent = agentConfigs.get(jid);
  if (agent) { agent.active = false; console.log(`[agent] Stopped for ${agent.name}`); }
  res.json({ ok: true });
});

app.post('/agent/clear-log', express.json(), (req, res) => {
  const { jid } = req.body;
  const agent = agentConfigs.get(jid);
  if (agent) agent.log = [];
  res.json({ ok: true });
});

app.get('/agent/list', (req, res) => {
  const agents = [...agentConfigs.values()].map(({ log, ...a }) => ({ ...a, logCount: log.length }));
  res.json({ agents });
});

app.get('/agent/log', (req, res) => {
  const jid = req.query.jid;
  const since = parseInt(req.query.since || '0');
  const agent = agentConfigs.get(jid);
  const log = (agent?.log || []).filter(e => e.ts > since);
  res.json({ log, active: agent?.active || false, busy: agentBusy.has(jid) });
});

app.post('/agent/initiate', express.json(), async (req, res) => {
  if (!isConnected) return res.status(503).json({ error: 'Not connected' });
  const { jid, opener } = req.body;
  if (!jid || !opener) return res.status(400).json({ error: 'jid and opener required' });
  const agent = agentConfigs.get(jid);
  try {
    await new Promise(r => setTimeout(r, humanDelay(opener)));
    await sock.sendMessage(jid, { text: opener });
    // Log it
    if (agent) {
      agent.log.push({ ts: Date.now(), role: 'outgoing', text: opener });
    }
    // Track in DM history so agent has context
    if (jid.endsWith('@s.whatsapp.net')) {
      if (!dmTextHistory.has(jid)) dmTextHistory.set(jid, []);
      const hist = dmTextHistory.get(jid);
      hist.push({ ts: Date.now(), fromMe: true, text: opener, sender: 'Me' });
      if (hist.length > MAX_DM_TEXT) hist.splice(0, hist.length - MAX_DM_TEXT);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Manual connect / disconnect ───────────────────────────────────────────────
app.post('/wa-disconnect', async (req, res) => {
  if (!isConnected) return res.json({ ok: true, message: 'Already disconnected' });
  try {
    manuallyDisconnected = true;
    await sock.end();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/wa-logout', async (req, res) => {
  try {
    manuallyDisconnected = true;
    if (isConnected) await sock.logout();
    else {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/wa-connect', async (req, res) => {
  if (isConnected) return res.json({ ok: true, message: 'Already connected' });
  try {
    manuallyDisconnected = false;
    connect().catch(err => console.error('[bot] Reconnect error:', err));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Schedule checker (runs every minute) ─────────────────────────────────────
setInterval(async () => {
  try {
    const settings = await getSettings();
    if (!settings.schedule_enabled) return;
    const from = settings.schedule_from; // "HH:MM"
    const to = settings.schedule_to;     // "HH:MM"
    if (!from || !to) return;
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const [fh, fm] = from.split(':').map(Number);
    const [th, tm] = to.split(':').map(Number);
    const start = fh * 60 + fm;
    const end = th * 60 + tm;
    const inWindow = start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end);
    if (inWindow && !isConnected && !manuallyDisconnected) {
      console.log('[schedule] Within active hours — connecting');
      manuallyDisconnected = false;
      connect().catch(err => console.error('[schedule] Connect error:', err));
    } else if (!inWindow && isConnected) {
      console.log('[schedule] Outside active hours — disconnecting');
      manuallyDisconnected = true;
      await sock.end();
    }
  } catch (_) {}
}, 60000);

app.listen(BOT_PORT, () => {
  console.log(`[bot] API listening on http://localhost:${BOT_PORT}`);
});

// --- Start ---
console.log('[bot] Starting Parent Tool bot (Baileys)...');
connect().catch(err => console.error('[bot] Fatal:', err));
