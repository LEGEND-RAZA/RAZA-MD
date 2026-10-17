
import { getDb, saveDb } from '../database/index.js';

const PREFIX = () => process.env.PREFIX || '.';
const GROQ_API_KEY = () => process.env.GROQ_API_KEY || '';
const GROQ_MODEL = () =>
  process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

const GROQ_URL =
  'https://api.groq.com/openai/v1/chat/completions';

const SETTINGS_FILE = 'ai-autoreply.json';
const HISTORY_FILE = 'ai-autoreply-history.json';

const ALLOWED_EMOJIS = [
  '😭', '💋', '🌷', '🫂', '💗', '👀', '🌚', '🥲', '🙂',
  '😕', '🙁', '🫪', '🫩', '🤧', '🫀', '👑', '💍', '🦋',
  '🙈', '🐍', '🦢', '☘️', '🌝', '🌼', '🌸', '💐', '🌹',
  '🔥', '🎲', '🎭', '💸', '🎀', '🪄', '🔖'
];

const DEFAULT_SETTINGS = {
  enabled: true,
  inbox: true,
  groups: true,
  groupMode: 'all',
  allowedGroups: [],
  blockedGroups: [],
  style: 'romantic',
  length: 'short',
  cooldown: 5,
  historyPairs: 5,
  systemPrompt: ''
};

const settings = getDb(SETTINGS_FILE, DEFAULT_SETTINGS);
const history = getDb(HISTORY_FILE, {});

Object.assign(settings, {
  ...DEFAULT_SETTINGS,
  ...settings
});

if (!Array.isArray(settings.allowedGroups)) {
  settings.allowedGroups = [];
}

if (!Array.isArray(settings.blockedGroups)) {
  settings.blockedGroups = [];
}

const lastReply = new Map();
const pendingReplies = new Set();

function log(...args) {
  console.log('[AI AUTOREPLY]', ...args);
}

function saveSettings() {
  saveDb(SETTINGS_FILE, settings);
}

function saveHistory() {
  saveDb(HISTORY_FILE, history);
}

function getChatJid(message) {
  return message?.key?.remoteJid || '';
}

function getSenderJid(message) {
  return (
    message?.key?.participant ||
    message?.participant ||
    message?.key?.remoteJid ||
    ''
  );
}

function getBotJid(sock) {
  return (sock?.user?.id || '').split(':')[0].split('@')[0];
}

function isGroupJid(jid = '') {
  return jid.endsWith('@g.us');
}

function cleanText(text = '') {
  return String(text)
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, 4000);
}

function getStyleInstruction() {
  const styles = {
    natural: 'BE NATURAL BUT ALWAYS ROMANTIC AND FLIRTY',
    friendly: 'BE SWEET FRIENDLY ROMANTIC AND PLAYFUL',
    romantic: 'BE VERY ROMANTIC FLIRTY LOVING AND CUTE',
    funny: 'BE ROMANTIC FLIRTY AND PLAYFULLY FUNNY'
  };

  return styles[settings.style] || styles.romantic;
}

function getSystemPrompt() {
  return [
    'YOU ARE A ROMANTIC WHATSAPP CHAT PARTNER',
    'FOLLOW ALL OUTPUT RULES STRICTLY',
    'REPLY ONLY IN ROMAN URDU',
    'ROMAN URDU MEANS URDU WRITTEN USING ENGLISH LETTERS',
    'NEVER WRITE URDU SCRIPT',
    'NEVER REPLY IN ENGLISH',
    'WRITE EVERY WORD IN CAPITAL LETTERS',
    'BE ROMANTIC FLIRTY LOVING CUTE AND PLAYFUL',
    'KEEP REPLIES SHORT AND NATURAL',
    'RESPOND DIRECTLY TO THE LATEST MESSAGE',
    'DO NOT USE FULL STOPS COMMAS QUESTION MARKS EXCLAMATION MARKS OR PUNCTUATION',
    'DO NOT USE DECORATIVE SYMBOLS',
    'DO NOT INCLUDE EMOJIS IN THE MESSAGE BODY',
    'THE PLUGIN WILL ADD ONE ALLOWED EMOJI AT THE END',
    'DO NOT ADD LABELS OR EXPLANATIONS',
    'DO NOT OUTPUT THE REQUIRED MESSAGE FORMAT YOURSELF',
    'OUTPUT ONLY THE MESSAGE TEXT',
    settings.systemPrompt || '',
    getStyleInstruction(),
    settings.length === 'long'
      ? 'USE A FEW SHORT SENTENCES'
      : settings.length === 'medium'
        ? 'USE ONE OR TWO SHORT SENTENCES'
        : 'USE ONE SHORT SWEET SENTENCE',
    'ONLY USE ROMAN URDU AND CAPITAL LETTERS'
  ].filter(Boolean).join('\n');
}

function getHistoryKey(chatJid, senderJid) {
  return `${chatJid}:${senderJid}`;
}

function trimHistory(items) {
  const pairs = Math.max(
    0,
    Math.min(20, Number(settings.historyPairs) || 0)
  );

  if (pairs === 0) return [];

  return items.slice(-(pairs * 2));
}

function sanitizeReply(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .trim()
    .slice(0, 3000);
}

function formatReply(text) {
  const original = sanitizeReply(text).toUpperCase();

  if (!original) return '';

  // Select one emoji from the allowed list, if the model returned one.
  const emoji =
    [...ALLOWED_EMOJIS]
      .reverse()
      .find(item => original.includes(item)) || '💋';

  // Remove emojis and all punctuation or symbols from the message body.
  const message = original
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!message) return '';

  // Required format: - _MESSAGE"_ EMOJI
  return `- _${message}"_ ${emoji}`;
}

async function askGroq(chatJid, senderJid, incomingText) {
  const apiKey = GROQ_API_KEY();

  if (!apiKey) {
    throw new Error(
      'GROQ_API_KEY is missing from Heroku Config Vars or config.env'
    );
  }

  const key = getHistoryKey(chatJid, senderJid);
  const previous = Array.isArray(history[key])
    ? history[key]
    : [];

  const messages = [
    {
      role: 'system',
      content: getSystemPrompt()
    },
    ...trimHistory(previous),
    {
      role: 'user',
      content: incomingText
    }
  ];

  let lastError;

  // Increase the completion budget if an attempt returns no usable text.
  const tokenBudgets = [1024, 2048, 3072];

  for (let attempt = 0; attempt < tokenBudgets.length; attempt++) {
    let timeout;

    try {
      const controller = new AbortController();

      timeout = setTimeout(() => controller.abort(), 45000);

      const response = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: GROQ_MODEL(),
          messages,
          temperature: 0.8,
          max_completion_tokens: tokenBudgets[attempt],
          reasoning_effort: 'low'
        }),
        signal: controller.signal
      });

      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        const error = new Error(
          body?.error?.message ||
          body?.message ||
          `Groq returned HTTP ${response.status}`
        );

        error.status = response.status;
        throw error;
      }

      const choice = body?.choices?.[0];
      const answer = choice?.message?.content;

      if (typeof answer !== 'string' || !answer.trim()) {
        log('Empty completion details:', JSON.stringify({
          model: body?.model,
          finish_reason: choice?.finish_reason,
          usage: body?.usage,
          message: choice?.message
            ? {
                role: choice.message.role,
                refusal: choice.message.refusal,
                reasoningPresent: Boolean(choice.message.reasoning)
              }
            : null
        }));

        const error = new Error(
          `Groq returned no reply text (finish_reason: ${choice?.finish_reason || 'unknown'})`
        );

        error.emptyCompletion = true;
        error.finishReason = choice?.finish_reason;
        throw error;
      }

      const reply = formatReply(answer);

      if (!reply) {
        const error = new Error(
          'Groq returned text but formatting removed all message content'
        );

        error.emptyCompletion = true;
        throw error;
      }

      // Store plain message text in history, not WhatsApp formatting.
      const savedReply = reply
        .replace(/^- _/, '')
        .replace(/"_\s*[\s\S]*$/, '')
        .trim();

      history[key] = [
        ...trimHistory(previous),
        {
          role: 'user',
          content: incomingText
        },
        {
          role: 'assistant',
          content: savedReply
        }
      ].slice(-40);

      saveHistory();

      return reply;
    } catch (error) {
      lastError = error;

      const status = error?.status;
      const retryableStatus = [
        429, 500, 502, 503, 504
      ].includes(status);

      const retryable =
        error?.emptyCompletion ||
        (!status && error?.name !== 'AbortError') ||
        retryableStatus ||
        error?.name === 'AbortError';

      log(
        `Groq attempt ${attempt + 1}/${tokenBudgets.length} failed`,
        status ? `HTTP ${status}` : '',
        error?.message || error
      );

      if (!retryable || attempt === tokenBudgets.length - 1) {
        break;
      }

      await new Promise(resolve =>
        setTimeout(resolve, (attempt + 1) * 1000)
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error('Groq request failed');
}

function groupAllowed(jid) {
  if (!settings.groups) return false;
  if (settings.blockedGroups.includes(jid)) return false;

  if (settings.groupMode === 'allowlist') {
    return settings.allowedGroups.includes(jid);
  }

  return true;
}

function shouldReply({ sock, message, text, isGroup, isStatus }) {
  if (!settings.enabled) return false;
  if (!sock || !message || !text) return false;
  if (message.key?.fromMe) return false;
  if (isStatus) return false;

  const chatJid = getChatJid(message);

  if (!chatJid || chatJid === 'status@broadcast') return false;
  if (chatJid.endsWith('@broadcast')) return false;

  const senderJid = getSenderJid(message);
  const botJid = getBotJid(sock);
  const senderNumber = senderJid.split('@')[0].split(':')[0];

  if (botJid && senderNumber === botJid) return false;

  const incomingText = cleanText(text);

  if (!incomingText) return false;

  // Ignore commands so the AI does not reply to bot commands.
  if (incomingText.startsWith(PREFIX())) return false;

  if (isGroup || isGroupJid(chatJid)) {
    if (!groupAllowed(chatJid)) return false;
  } else if (!settings.inbox) {
    return false;
  }

  return true;
}

async function handleAutoReply(data) {
  const { sock, message, text, isGroup } = data;

  if (!shouldReply(data)) return;

  const chatJid = getChatJid(message);
  const senderJid = getSenderJid(message);
  const incomingText = cleanText(text);
  const key = `${chatJid}:${senderJid}`;

  if (pendingReplies.has(key)) return;

  const cooldownMs =
    Math.max(0, Number(settings.cooldown) || 0) * 1000;

  const last = lastReply.get(key) || 0;

  if (cooldownMs && Date.now() - last < cooldownMs) {
    return;
  }

  pendingReplies.add(key);

  try {
    log(
      `Generating reply for ${chatJid} (${isGroup ? 'group' : 'inbox'})`
    );

    const reply = await askGroq(
      chatJid,
      senderJid,
      incomingText
    );

    if (!reply) {
      log('Reply skipped because the formatted message is empty');
      return;
    }

    await sock.sendMessage(
      chatJid,
      { text: reply },
      { quoted: message }
    );

    lastReply.set(key, Date.now());

    log(`Reply sent to ${chatJid}`);
  } catch (error) {
    log(
      'Reply failed:',
      error?.stack || error?.message || error
    );
  } finally {
    pendingReplies.delete(key);
  }
}

function parseOnOff(value) {
  if (['on', 'yes', 'true', 'enable', 'enabled'].includes(value)) {
    return true;
  }

  if (['off', 'no', 'false', 'disable', 'disabled'].includes(value)) {
    return false;
  }

  return null;
}

function normalizeGroupInput(value, message) {
  const raw = String(value || '').trim();

  if (!raw || raw === 'here' || raw === 'this') {
    const current = getChatJid(message);
    return isGroupJid(current) ? current : '';
  }

  if (raw.endsWith('@g.us')) return raw;

  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@g.us` : '';
}

function helpText(prefix) {
  return [
    '*AI AUTOREPLY COMMANDS*',
    '',
    `${prefix}autoreply on`,
    `${prefix}autoreply off`,
    `${prefix}autoreply status`,
    `${prefix}autoreply inbox on/off`,
    `${prefix}autoreply groups on/off`,
    `${prefix}autoreply group on/off`,
    `${prefix}autoreply allow <group-jid>`,
    `${prefix}autoreply deny <group-jid>`,
    `${prefix}autoreply groupmode all/allowlist`,
    `${prefix}autoreply style natural/friendly/romantic/funny`,
    `${prefix}autoreply length short/medium/long`,
    `${prefix}autoreply cooldown <seconds>`,
    `${prefix}autoreply history <pairs>`,
    `${prefix}autoreply prompt <text>`,
    `${prefix}autoreply clear`,
    `${prefix}autoreply reset`
  ].join('\n');
}

const autoReplyCommand = {
  command: 'autoreply',
  category: 'owner',
  description: 'Configure romantic Roman Urdu AI auto-replies',

  async run({ sock, message, args = [], isOwner, isGroup }) {
    const chatJid = getChatJid(message);

    if (!isOwner) {
      await sock.sendMessage(
        chatJid,
        {
          text: 'ONLY THE BOT OWNER CAN CHANGE THESE SETTINGS'
        },
        { quoted: message }
      );
      return;
    }

    const action = String(args[0] || 'help').toLowerCase();
    const value = String(args[1] || '').toLowerCase();
    const prefix = PREFIX();

    if (action === 'help') {
      await sock.sendMessage(
        chatJid,
        { text: helpText(prefix) },
        { quoted: message }
      );
      return;
    }

    if (action === 'on' || action === 'off') {
      settings.enabled = action === 'on';
      saveSettings();

      await sock.sendMessage(
        chatJid,
        {
          text: `AI AUTOREPLY ${settings.enabled ? 'ENABLED' : 'DISABLED'}`
        },
        { quoted: message }
      );
      return;
    }

    if (action === 'status') {
      await sock.sendMessage(
        chatJid,
        {
          text: [
            '*AI AUTOREPLY STATUS*',
            `ENABLED ${settings.enabled ? 'ON' : 'OFF'}`,
            `INBOX ${settings.inbox ? 'ON' : 'OFF'}`,
            `GROUPS ${settings.groups ? 'ON' : 'OFF'}`,
            `GROUP MODE ${settings.groupMode}`,
            `STYLE ${settings.style}`,
            `LENGTH ${settings.length}`,
            `COOLDOWN ${settings.cooldown} SECONDS`,
            `HISTORY ${settings.historyPairs} PAIRS`,
            `MODEL ${GROQ_MODEL()}`,
            `API KEY ${GROQ_API_KEY() ? 'CONFIGURED' : 'MISSING'}`,
            `CURRENT CHAT ${isGroup ? 'GROUP' : 'PRIVATE'}`
          ].join('\n')
        },
        { quoted: message }
      );
      return;
    }

    if (action === 'inbox' || action === 'groups') {
      const parsed = parseOnOff(value);

      if (parsed === null) {
        await sock.sendMessage(
          chatJid,
          { text: `USE ${prefix}autoreply ${action} on/off` },
          { quoted: message }
        );
        return;
      }

      settings[action] = parsed;
      saveSettings();

      await sock.sendMessage(
        chatJid,
        {
          text: `${action.toUpperCase()} ${parsed ? 'ON' : 'OFF'}`
        },
        { quoted: message }
      );
      return;
    }

    if (action === 'group') {
      const groupAction = String(args[1] || '').toLowerCase();
      const groupJid =
        normalizeGroupInput(args[2], message) ||
        (isGroupJid(chatJid) ? chatJid : '');

      const parsed = parseOnOff(groupAction);

      if (!groupJid || parsed === null) {
        await sock.sendMessage(
          chatJid,
          {
            text: `USE THIS COMMAND INSIDE A GROUP ${prefix}autoreply group on/off`
          },
          { quoted: message }
        );
        return;
      }

      if (parsed) {
        settings.blockedGroups =
          settings.blockedGroups.filter(id => id !== groupJid);

        if (
          settings.groupMode === 'allowlist' &&
          !settings.allowedGroups.includes(groupJid)
        ) {
          settings.allowedGroups.push(groupJid);
        }
      } else if (!settings.blockedGroups.includes(groupJid)) {
        settings.blockedGroups.push(groupJid);
      }

      saveSettings();

      await sock.sendMessage(
        chatJid,
        {
          text: `AUTOREPLY ${parsed ? 'ENABLED' : 'DISABLED'} FOR ${groupJid}`
        },
        { quoted: message }
      );
      return;
    }

    if (action === 'allow' || action === 'deny') {
      const groupJid = normalizeGroupInput(args[1], message);

      if (!groupJid) {
        await sock.sendMessage(
          chatJid,
          { text: `USE ${prefix}autoreply ${action} <group-jid>` },
          { quoted: message }
        );
        return;
      }

      if (action === 'allow') {
        settings.blockedGroups =
          settings.blockedGroups.filter(id => id !== groupJid);

        if (!settings.allowedGroups.includes(groupJid)) {
          settings.allowedGroups.push(groupJid);
        }
      } else {
        settings.allowedGroups =
          settings.allowedGroups.filter(id => id !== groupJid);

        if (!settings.blockedGroups.includes(groupJid)) {
          settings.blockedGroups.push(groupJid);
        }
      }

      saveSettings();

      await sock.sendMessage(
        chatJid,
        {
          text: `GROUP ${action === 'allow' ? 'ALLOWED' : 'BLOCKED'}`
        },
        { quoted: message }
      );
      return;
    }

    if (action === 'groupmode') {
      if (!['all', 'allowlist'].includes(value)) {
        await sock.sendMessage(
          chatJid,
          { text: `USE ${prefix}autoreply groupmode all/allowlist` },
          { quoted: message }
        );
        return;
      }

      settings.groupMode = value;
      saveSettings();

      await sock.sendMessage(
        chatJid,
        { text: `GROUP MODE ${value.toUpperCase()}` },
        { quoted: message }
      );
      return;
    }

    if (action === 'style') {
      if (!['natural', 'friendly', 'romantic', 'funny'].includes(value)) {
        await sock.sendMessage(
          chatJid,
          {
            text: `USE ${prefix}autoreply style natural/friendly/romantic/funny`
          },
          { quoted: message }
        );
        return;
      }

      settings.style = value;
      saveSettings();

      await sock.sendMessage(
        chatJid,
        { text: `STYLE SET TO ${value.toUpperCase()}` },
        { quoted: message }
      );
      return;
    }

    if (action === 'length') {
      if (!['short', 'medium', 'long'].includes(value)) {
        await sock.sendMessage(
          chatJid,
          {
            text: `USE ${prefix}autoreply length short/medium/long`
          },
          { quoted: message }
        );
        return;
      }

      settings.length = value;
      saveSettings();

      await sock.sendMessage(
        chatJid,
        { text: `LENGTH SET TO ${value.toUpperCase()}` },
        { quoted: message }
      );
      return;
    }

    if (action === 'cooldown') {
      const seconds = Number(args[1]);

      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) {
        await sock.sendMessage(
          chatJid,
          { text: `USE ${prefix}autoreply cooldown <0-3600>` },
          { quoted: message }
        );
        return;
      }

      settings.cooldown = seconds;
      saveSettings();

      await sock.sendMessage(
        chatJid,
        { text: `COOLDOWN SET TO ${seconds} SECONDS` },
        { quoted: message }
      );
      return;
    }

    if (action === 'history') {
      const pairs = Number(args[1]);

      if (!Number.isInteger(pairs) || pairs < 0 || pairs > 20) {
        await sock.sendMessage(
          chatJid,
          { text: `USE ${prefix}autoreply history <0-20>` },
          { quoted: message }
        );
        return;
      }

      settings.historyPairs = pairs;
      saveSettings();

      await sock.sendMessage(
        chatJid,
        { text: `HISTORY SET TO ${pairs} PAIRS` },
        { quoted: message }
      );
      return;
    }

    if (action === 'prompt') {
      settings.systemPrompt = args.slice(1).join(' ').slice(0, 1000);
      saveSettings();

      await sock.sendMessage(
        chatJid,
        {
          text: settings.systemPrompt
            ? 'CUSTOM PROMPT SAVED'
            : 'CUSTOM PROMPT CLEARED'
        },
        { quoted: message }
      );
      return;
    }

    if (action === 'clear') {
      const senderJid = getSenderJid(message);

      delete history[getHistoryKey(chatJid, senderJid)];
      saveHistory();

      await sock.sendMessage(
        chatJid,
        { text: 'CONVERSATION HISTORY CLEARED' },
        { quoted: message }
      );
      return;
    }

    if (action === 'reset') {
      Object.assign(settings, structuredClone(DEFAULT_SETTINGS));
      saveSettings();

      await sock.sendMessage(
        chatJid,
        { text: 'SETTINGS RESET TO DEFAULTS' },
        { quoted: message }
      );
      return;
    }

    await sock.sendMessage(
      chatJid,
      { text: helpText(prefix) },
      { quoted: message }
    );
  }
};

// Listener MUST be an object because the plugin loader ignores function exports.
export const autoReplyListener = {
  command: '__autoreply_listener',

  async run(data) {
    try {
      await handleAutoReply(data);
    } catch (error) {
      log(
        'Listener error:',
        error?.stack || error?.message || error
      );
    }
  }
};

export default autoReplyCommand;
