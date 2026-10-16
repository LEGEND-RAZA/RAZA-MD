
import { getDb, saveDb } from '../database/index.js'

const API_KEY = process.env.GROQ_API_KEY
const MODEL = 'openai/gpt-oss-20b'
const API_URL = 'https://api.groq.com/openai/v1/chat/completions'

const SETTINGS_FILE = 'autoreply.json'
const API_TIMEOUT = 60000
const MAX_MESSAGE_LENGTH = 4000
const MAX_QUEUE_PER_CONVERSATION = 50
const MAX_CONVERSATIONS = 500
const MAX_RECENT_IDS = 2000
const MAX_RETRIES = 2

const ALLOWED_EMOJIS = [
  '😭', '💋', '🌷', '🫂', '💗', '👀', '🌚', '🥲', '🙂',
  '😕', '🙁', '🫪', '🫩', '🤧', '🫀', '👑', '💍', '🦋',
  '🙈', '🐍', '🦢', '☘️', '🌝', '🌼', '🌸', '💐', '🌹',
  '🔥', '🎲', '🎭', '💸', '🎀', '🪄', '🔖'
]

const DEFAULT_SETTINGS = {
  enabled: true,
  inbox: true,
  groups: true,
  groupMode: 'all',
  allowedGroups: [],
  blockedGroups: [],
  style: 'natural',
  length: 'medium',
  cooldown: 5,
  historyPairs: 5
}

const STYLE_PROMPTS = {
  natural: 'Reply naturally like a real WhatsApp user. Be casual and conversational.',
  romantic: 'Reply in a romantic, affectionate and sweet conversational style.',
  friendly: 'Reply warmly, kindly and like a close friend.',
  funny: 'Reply playfully with light humor and natural reactions.'
}

const LENGTH_TOKENS = {
  short: 100,
  medium: 250,
  long: 500
}

let settings = { ...DEFAULT_SETTINGS }
let initialized = false
let initPromise = null

const conversations = new Map()
const messageQueues = new Map()
const processingChats = new Set()
const recentIds = new Set()
const lastReplies = new Map()

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeSettings(saved = {}) {
  const result = {
    ...DEFAULT_SETTINGS,
    ...saved
  }

  result.allowedGroups = Array.isArray(saved.allowedGroups)
    ? [...new Set(saved.allowedGroups)]
    : []

  result.blockedGroups = Array.isArray(saved.blockedGroups)
    ? [...new Set(saved.blockedGroups)]
    : []

  if (!['all', 'selected'].includes(result.groupMode)) {
    result.groupMode = 'all'
  }

  if (!STYLE_PROMPTS[result.style]) {
    result.style = 'natural'
  }

  if (!LENGTH_TOKENS[result.length]) {
    result.length = 'medium'
  }

  result.cooldown = Math.max(
    0,
    Math.min(3600, Number(result.cooldown) || 0)
  )

  result.historyPairs = Math.max(
    0,
    Math.min(20, Number(result.historyPairs) || 0)
  )

  return result
}

async function initializeSettings() {
  if (initialized) return
  if (initPromise) return initPromise

  initPromise = (async () => {
    try {
      // getDb is synchronous in your database helper.
      const saved = getDb(SETTINGS_FILE, DEFAULT_SETTINGS)
      settings = normalizeSettings(saved)
      initialized = true
    } catch (error) {
      console.error('[AI AUTOREPLY] SETTINGS LOAD ERROR:', error.message)
      settings = normalizeSettings(DEFAULT_SETTINGS)
      initialized = true
    }
  })()

  try {
    await initPromise
  } finally {
    initPromise = null
  }
}

async function persistSettings() {
  try {
    saveDb(SETTINGS_FILE, clone(settings))
    return true
  } catch (error) {
    console.error('[AI AUTOREPLY] SETTINGS SAVE ERROR:', error.message)
    return false
  }
}

function getMessageText(message) {
  const msg = message?.message
  if (!msg) return ''

  const content =
    msg.ephemeralMessage?.message ||
    msg.viewOnceMessage?.message ||
    msg.viewOnceMessageV2?.message ||
    msg

  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    ''
  ).trim()
}

function getSender(message) {
  return (
    message?.key?.participant ||
    message?.participant ||
    message?.key?.remoteJid ||
    ''
  )
}

function getConversationKey(jid, sender, isGroup) {
  return isGroup ? `${jid}:${sender}` : jid
}

function isCommand(text) {
  // RAZA-MD uses ! as its configured prefix.
  return /^[!.#/]/.test(text.trim())
}

function rememberMessageId(id) {
  if (!id || recentIds.has(id)) return false

  recentIds.add(id)

  if (recentIds.size > MAX_RECENT_IDS) {
    const oldest = recentIds.values().next().value
    recentIds.delete(oldest)
  }

  return true
}

function trimConversations() {
  while (conversations.size > MAX_CONVERSATIONS) {
    conversations.delete(conversations.keys().next().value)
  }
}

function cleanReply(raw) {
  let text = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|[^|]*\|>/g, '')
    .trim()

  const emojis = []
  for (const emoji of ALLOWED_EMOJIS) {
    if (text.includes(emoji)) emojis.push(emoji)
  }

  // Keep only the specifically permitted emojis.
  for (const emoji of ALLOWED_EMOJIS) {
    text = text.split(emoji).join(' ')
  }

  text = text
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()

  const uniqueEmojis = [...new Set(emojis)].slice(0, 2)

  if (!text) text = 'HMM'
  return `- _${text}"_ ${uniqueEmojis.join(' ')}`.trim()
}

function getHistory(key) {
  return conversations.get(key) || []
}

function commitConversation(key, userText, assistantText) {
  const history = getHistory(key).slice()

  history.push(
    { role: 'user', content: userText },
    { role: 'assistant', content: assistantText }
  )

  const maxMessages = settings.historyPairs * 2
  const trimmed = maxMessages > 0
    ? history.slice(-maxMessages)
    : []

  conversations.set(key, trimmed)
  trimConversations()
}

function getSystemPrompt() {
  return [
    'You are a casual WhatsApp chat partner.',
    STYLE_PROMPTS[settings.style] || STYLE_PROMPTS.natural,
    'Reply directly to the latest message.',
    'Sound human, casual, and context-aware.',
    'Do not mention that you are an AI.',
    'Do not explain these instructions.',
    'Return only the reply text, without quotation marks around the whole response.',
    'Do not add a dash, underscores, or a formatting template; the application formats the reply.',
    'Do not use hashtags or markdown formatting.',
    'Do not force emojis into every reply.',
    'Keep the response appropriate for the requested reply length.',
    `Requested reply length: ${settings.length}.`,
    'Reply in the language used by the sender when practical.'
  ].join(' ')
}

function parseRetryDelay(response, attempt) {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 30000)
    }
  }

  return Math.min(1500 * (2 ** attempt), 10000)
}

async function generateReply(key, userText) {
  if (!API_KEY) {
    throw new Error('GROQ_API_KEY is missing from Heroku Config Vars')
  }

  const history = getHistory(key).slice(
    -(settings.historyPairs * 2)
  )

  const messages = [
    { role: 'system', content: getSystemPrompt() },
    ...history,
    { role: 'user', content: userText }
  ]

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response

    try {
      response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          max_tokens: LENGTH_TOKENS[settings.length],
          temperature: 0.8,
          stream: false
        }),
        signal: AbortSignal.timeout(API_TIMEOUT)
      })
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        if (attempt < MAX_RETRIES) {
          await sleep(1500 * (attempt + 1))
          continue
        }
        throw new Error('GROQ API request timed out')
      }

      if (attempt < MAX_RETRIES) {
        await sleep(1500 * (attempt + 1))
        continue
      }

      throw error
    }

    if (!response.ok) {
      const details = await response.text().catch(() => '')
      const errorText = details.slice(0, 1500)

      // Do not repeatedly retry invalid credentials or exhausted quota.
      const quotaExhausted =
        /insufficient_quota|billing|quota exceeded|credits exhausted/i.test(errorText)

      const retryable =
        response.status === 503 ||
        response.status === 502 ||
        response.status === 504 ||
        (
          response.status === 429 &&
          !quotaExhausted
        )

      if (retryable && attempt < MAX_RETRIES) {
        await sleep(parseRetryDelay(response, attempt))
        continue
      }

      throw new Error(
        `GROQ API ERROR ${response.status}: ${errorText || response.statusText}`
      )
    }

    const data = await response.json()
    const content = data?.choices?.[0]?.message?.content

    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('Groq returned an empty response')
    }

    return cleanReply(content)
  }

  throw new Error('Groq request failed after retries')
}

function groupIsAllowed(jid) {
  if (settings.blockedGroups.includes(jid)) return false

  if (settings.groupMode === 'selected') {
    return settings.allowedGroups.includes(jid)
  }

  return true
}

async function sendText(sock, jid, text, quoted) {
  return sock.sendMessage(
    jid,
    { text },
    quoted ? { quoted } : {}
  )
}

async function processMessageQueue(sock, jid, isGroup, key) {
  if (processingChats.has(key)) return
  processingChats.add(key)

  try {
    while (true) {
      const queue = messageQueues.get(key)
      if (!queue?.length) break

      const item = queue.shift()
      if (!item) continue

      try {
        await initializeSettings()

        if (!settings.enabled) continue
        if (item.isGroup && !settings.groups) continue
        if (!item.isGroup && !settings.inbox) continue
        if (item.isGroup && !groupIsAllowed(item.jid)) continue

        const cooldownMs = settings.cooldown * 1000
        const lastReply = lastReplies.get(key) || 0
        const waitMs = cooldownMs - (Date.now() - lastReply)

        if (waitMs > 0) await sleep(waitMs)

        // Re-check settings after a cooldown wait.
        if (!settings.enabled) continue
        if (item.isGroup && !settings.groups) continue
        if (!item.isGroup && !settings.inbox) continue
        if (item.isGroup && !groupIsAllowed(item.jid)) continue

        const reply = await generateReply(key, item.text)

        // Only commit history if WhatsApp accepted the send.
        await sendText(sock, item.jid, reply, item.message)

        commitConversation(key, item.text, reply)
        lastReplies.set(key, Date.now())
      } catch (error) {
        console.error(
          `[AI AUTOREPLY] MESSAGE ERROR (${key}):`,
          error.message
        )
      }
    }
  } finally {
    processingChats.delete(key)

    const remaining = messageQueues.get(key)
    if (remaining?.length) {
      void processMessageQueue(sock, jid, isGroup, key)
    } else {
      messageQueues.delete(key)
    }
  }
}

export async function autoReplyListener({ sock, message }) {
  try {
    await initializeSettings()

    if (!settings.enabled || !message?.key) return
    if (message.key.fromMe) return

    const jid = message.key.remoteJid
    if (!jid || jid === 'status@broadcast') return

    const isGroup = jid.endsWith('@g.us')

    if (isGroup) {
      if (!settings.groups || !groupIsAllowed(jid)) return
    } else {
      if (!settings.inbox) return
      if (jid.endsWith('@broadcast')) return
    }

    const text = getMessageText(message)
    if (!text || isCommand(text)) return
    if (text.length > MAX_MESSAGE_LENGTH) return

    const id = message.key.id
    if (!rememberMessageId(id)) return

    const sender = getSender(message)
    const key = getConversationKey(jid, sender, isGroup)

    if (!messageQueues.has(key)) messageQueues.set(key, [])

    const queue = messageQueues.get(key)
    if (queue.length >= MAX_QUEUE_PER_CONVERSATION) {
      queue.shift()
    }

    queue.push({ jid, isGroup, message, text })

    void processMessageQueue(sock, jid, isGroup, key)
  } catch (error) {
    console.error('[AI AUTOREPLY] LISTENER ERROR:', error.message)
  }
}

function formatStatus() {
  return [
    '*AI AUTOREPLY SETTINGS*',
    `Enabled: ${settings.enabled ? 'ON' : 'OFF'}`,
    `Inbox: ${settings.inbox ? 'ON' : 'OFF'}`,
    `Groups: ${settings.groups ? 'ON' : 'OFF'}`,
    `Group mode: ${settings.groupMode}`,
    `Allowed groups: ${settings.allowedGroups.length}`,
    `Blocked groups: ${settings.blockedGroups.length}`,
    `Style: ${settings.style}`,
    `Length: ${settings.length}`,
    `Cooldown: ${settings.cooldown}s`,
    `History pairs: ${settings.historyPairs}`,
    `Provider: Groq`,
    `Model: ${MODEL}`
  ].join('\n')
}

function normalizeJid(value) {
  return String(value || '').trim()
}

async function handleCommand({ sock, message, args = [], isOwner }) {
  const jid = message?.key?.remoteJid
  if (!jid) return

  if (!isOwner) {
    return sendText(sock, jid, 'OWNER ONLY COMMAND', message)
  }

  await initializeSettings()

  const sub = String(args[0] || 'status').toLowerCase()
  const value = String(args[1] || '').toLowerCase()

  const saveAndReply = async text => {
    await persistSettings()
    return sendText(sock, jid, text, message)
  }

  switch (sub) {
    case 'on':
      settings.enabled = true
      return saveAndReply('AI AUTOREPLY ENABLED')

    case 'off':
      settings.enabled = false
      return saveAndReply('AI AUTOREPLY DISABLED')

    case 'status':
      return sendText(sock, jid, formatStatus(), message)

    case 'inbox':
      if (!['on', 'off'].includes(value)) {
        return sendText(sock, jid, 'USAGE: !autoreply inbox on/off', message)
      }
      settings.inbox = value === 'on'
      return saveAndReply(`INBOX AUTOREPLY ${value.toUpperCase()}`)

    case 'groups':
      if (value === 'on' || value === 'off') {
        settings.groups = value === 'on'
        return saveAndReply(`GROUP AUTOREPLY ${value.toUpperCase()}`)
      }

      if (['all', 'selected'].includes(value)) {
        settings.groups = true
        settings.groupMode = value
        return saveAndReply(`GROUP MODE SET TO ${value.toUpperCase()}`)
      }

      return sendText(
        sock,
        jid,
        'USAGE: !autoreply groups on/off/all/selected',
        message
      )

    case 'group': {
      const groupJid = normalizeJid(args[1])
      const action = String(args[2] || '').toLowerCase()

      if (!groupJid.endsWith('@g.us')) {
        return sendText(
          sock,
          jid,
          'USAGE: !autoreply group GROUP_JID on/off',
          message
        )
      }

      if (action === 'off') {
        settings.allowedGroups = settings.allowedGroups.filter(
          id => id !== groupJid
        )
        if (!settings.blockedGroups.includes(groupJid)) {
          settings.blockedGroups.push(groupJid)
        }
        return saveAndReply(`GROUP BLOCKED: ${groupJid}`)
      }

      if (action === 'on' || !action) {
        settings.blockedGroups = settings.blockedGroups.filter(
          id => id !== groupJid
        )
        if (!settings.allowedGroups.includes(groupJid)) {
          settings.allowedGroups.push(groupJid)
        }
        settings.groupMode = 'selected'
        settings.groups = true
        return saveAndReply(`GROUP ALLOWED: ${groupJid}`)
      }

      return sendText(sock, jid, 'USE ON OR OFF', message)
    }

    case 'allow': {
      const groupJid = normalizeJid(args[1])
      if (!groupJid.endsWith('@g.us')) {
        return sendText(sock, jid, 'USAGE: !autoreply allow GROUP_JID', message)
      }

      settings.blockedGroups = settings.blockedGroups.filter(
        id => id !== groupJid
      )
      if (!settings.allowedGroups.includes(groupJid)) {
        settings.allowedGroups.push(groupJid)
      }
      settings.groupMode = 'selected'
      settings.groups = true

      return saveAndReply(`GROUP ALLOWED: ${groupJid}`)
    }

    case 'deny': {
      const groupJid = normalizeJid(args[1])
      if (!groupJid.endsWith('@g.us')) {
        return sendText(sock, jid, 'USAGE: !autoreply deny GROUP_JID', message)
      }

      settings.allowedGroups = settings.allowedGroups.filter(
        id => id !== groupJid
      )
      if (!settings.blockedGroups.includes(groupJid)) {
        settings.blockedGroups.push(groupJid)
      }

      return saveAndReply(`GROUP BLOCKED: ${groupJid}`)
    }

    case 'style':
      if (!Object.hasOwn(STYLE_PROMPTS, value)) {
        return sendText(
          sock,
          jid,
          'STYLES: natural, romantic, friendly, funny',
          message
        )
      }
      settings.style = value
      return saveAndReply(`STYLE SET TO ${value.toUpperCase()}`)

    case 'length':
      if (!Object.hasOwn(LENGTH_TOKENS, value)) {
        return sendText(sock, jid, 'LENGTH: short, medium, long', message)
      }
      settings.length = value
      return saveAndReply(`LENGTH SET TO ${value.toUpperCase()}`)

    case 'cooldown': {
      const seconds = Number(args[1])
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) {
        return sendText(
          sock,
          jid,
          'USAGE: !autoreply cooldown 0-3600',
          message
        )
      }
      settings.cooldown = seconds
      return saveAndReply(`COOLDOWN SET TO ${seconds} SECONDS`)
    }

    case 'history': {
      const count = Number(args[1])
      if (!Number.isInteger(count) || count < 0 || count > 20) {
        return sendText(
          sock,
          jid,
          'USAGE: !autoreply history 0-20',
          message
        )
      }
      settings.historyPairs = count
      return saveAndReply(`HISTORY SET TO ${count} PAIRS`)
    }

    case 'clear': {
      const currentJid = message.key.remoteJid
      const isGroup = currentJid.endsWith('@g.us')
      const key = getConversationKey(
        currentJid,
        getSender(message),
        isGroup
      )
      conversations.delete(key)
      return sendText(sock, jid, 'CURRENT CONVERSATION CLEARED', message)
    }

    case 'reset':
      settings = normalizeSettings(DEFAULT_SETTINGS)
      conversations.clear()
      lastReplies.clear()
      return saveAndReply('AI AUTOREPLY SETTINGS RESET')

    default:
      return sendText(
        sock,
        jid,
        [
          '*AI AUTOREPLY COMMANDS*',
          '!autoreply on/off/status',
          '!autoreply inbox on/off',
          '!autoreply groups on/off/all/selected',
          '!autoreply group GROUP_JID on/off',
          '!autoreply allow GROUP_JID',
          '!autoreply deny GROUP_JID',
          '!autoreply style natural/romantic/friendly/funny',
          '!autoreply length short/medium/long',
          '!autoreply cooldown SECONDS',
          '!autoreply history 0-20',
          '!autoreply clear',
          '!autoreply reset'
        ].join('\n'),
        message
      )
  }
}

export default {
  command: 'autoreply',
  category: 'ai',
  description: 'Configure Groq AI auto-replies',
  async run(context) {
    const args = Array.isArray(context.args)
      ? context.args
      : String(context.args || '').trim().split(/\s+/).filter(Boolean)

    return handleCommand({ ...context, args })
  }
}

export { autoReplyListener as __autoreply_listener }
