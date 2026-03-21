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

function loadDmInbox() {
  try { dmInbox = JSON.parse(fs.readFileSync(DM_INBOX_FILE, 'utf8')); } catch (_) {}
}
function saveDmInbox() {
  try { fs.writeFileSync(DM_INBOX_FILE, JSON.stringify(dmInbox, null, 2)); } catch (_) {}
}
loadDmInbox();

// --- MazalTover: auto congratulations sender ---
const MAZALTOVER_LOG_FILE = path.join(__dirname, '..', 'data', 'mazaltover-log.json');
let mazaltoverLog = [];
function loadMazaltoverLog() {
  try { mazaltoverLog = JSON.parse(fs.readFileSync(MAZALTOVER_LOG_FILE, 'utf8')); } catch (_) { mazaltoverLog = []; }
}
function saveMazaltoverLog() {
  try { fs.writeFileSync(MAZALTOVER_LOG_FILE, JSON.stringify(mazaltoverLog.slice(0, 200), null, 2)); } catch (_) {}
}
loadMazaltoverLog();

// groupId → { senders: Set<string>, windowStart: number, lastSent: number }
const mazaltoverTracker = new Map();
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
  return msg.pushName || jid.split('@')[0];
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
  if (arr.length > MAX_TEXT_PER_GROUP) arr.splice(0, arr.length - MAX_TEXT_PER_GROUP);
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
    browser: ['ParentTool', 'Chrome', '1.0'],
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messaging-history.set', ({ messages }) => {
    for (const msg of (messages || [])) {
      updateCursor(msg);  // track oldest for all message types
      storeMediaMsg(msg); // store images and videos
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
      phoneInfo = { number: me.id.split(':')[0], name: me.name || 'Unknown' };
      console.log(`[bot] Connected as ${phoneInfo.name} (+${phoneInfo.number})`);
      await refreshGroupsAndChats();
    }

    if (connection === 'close') {
      isConnected = false;
      phoneInfo = null;
      const code = lastDisconnect?.error?.output?.statusCode;
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
      if (!jid?.endsWith('@s.whatsapp.net')) continue;
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
              const windowMs = 30 * 60 * 1000;
              if (!mazaltoverTracker.has(groupJid)) {
                mazaltoverTracker.set(groupJid, { senders: new Set(), windowStart: now, lastSent: 0 });
              }
              const tracker = mazaltoverTracker.get(groupJid);
              if (now - tracker.windowStart > windowMs) {
                tracker.senders.clear();
                tracker.windowStart = now;
              }
              tracker.senders.add(sender);
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
  res.json({ connected: isConnected, phone: phoneInfo });
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
    // No messages known for this group yet — request from beginning
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
    const group = allGroups.find(g => g.id === jid);
    const chat = allChats.find(c => c.id === jid);
    const name = group?.name || chat?.name || jid.split('@')[0];
    const isGroup = jid.endsWith('@g.us');
    contacts.push({ jid, name, sent, received, today, peakHour, isGroup });
  }
  contacts.sort((a, b) => b.sent - a.sent);
  res.json({ contacts: contacts.slice(0, 12), days });
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

  // Top writers
  const writerCounts = {};
  for (const m of msgs) writerCounts[m.sender] = (writerCounts[m.sender] || 0) + 1;
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
  const uniqueSenders = new Set(msgs.map(m => m.sender)).size;
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
  const pending = {};
  for (const [jid, t] of mazaltoverTracker) {
    if (t.senders.size > 0) pending[jid] = t.senders.size;
  }
  res.json({ log: mazaltoverLog, pending });
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

app.listen(BOT_PORT, () => {
  console.log(`[bot] API listening on http://localhost:${BOT_PORT}`);
});

// --- Start ---
console.log('[bot] Starting Parent Tool bot (Baileys)...');
connect().catch(err => console.error('[bot] Fatal:', err));
