
import { getDb, saveDb } from '../database/index.js'

const GROQ_API_KEY = process.env.GROQ_API_KEY
const GROQ_MODEL =
  process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

const SETTINGS_FILE = 'ai-autoreply.json'
const HISTORY_FILE = 'ai-autoreply-history.json'

const DEFAULT_SETTINGS = {
  enabled: true,
  inbox: true,
  groups: true,
  groupMode: 'all',
  allowedGroups: [],
  blockGroups: [],
  style: 'romantic',
  length: 'short',
  cooldown: 5,
  historyPairs: 6,
  systemPrompt: ''
}

const ALLOWED_EMOJIS = [
  '😭', '💋', '🌷', '🫂', '💗', '👀', '🌚', '🥲',
  '🙂', '😕', '🙁', '🫪', '🫩', '🤧', '🫀', '👑',
  '💍', '🦋', '🙈', '🐍', '🦢', '☘️', '🌝', '🌼',
  '🌸', '💐', '🌹', '🔥', '🎲', '🎭', '💸', '🎀',
  '🪄', '🔖'
]

const cooldowns = new Map()

function defaultSettings() {
  return {
    ...DEFAULT_SETTINGS,
    allowedGroups: [],
    blockGroups: []
  }
}

async function loadSettings() {
  try {
    const saved = await getDb(SETTINGS_FILE, {})
    const settings = {
      ...defaultSettings(),
      ...(saved && typeof saved === 'object' ? saved : {})
    }

    settings.allowedGroups = Array.isArray(settings.allowedGroups)
      ? settings.allowedGroups
      : []

    settings.blockGroups = Array.isArray(settings.blockGroups)
      ? settings.blockGroups
      : []

    return settings
  } catch (error) {
    console.error('[AI AUTOREPLY] Settings load failed:', error.message)
    return defaultSettings()
  }
}

async function saveSettings(settings) {
  await saveDb(SETTINGS_FILE, settings)
}

async function loadHistory() {
  try {
    const saved = await getDb(HISTORY_FILE, {})
    return saved && typeof saved === 'object' ? saved : {}
  } catch (error) {
    console.error('[AI AUTOREPLY] History load failed:', error.message)
    return {}
  }
}

async function saveHistory(history) {
  await saveDb(HISTORY_FILE, history)
}

/**
 * Unwrap WhatsApp message containers.
 */
function unwrapMessage(message) {
  let content = message?.message
  let attempts = 0

  while (content && attempts++ < 8) {
    const nested =
      content.ephemeralMessage?.message ||
      content.viewOnceMessage?.message ||
      content.viewOnceMessageV2?.message ||
      content.viewOnceMessageV2Extension?.message ||
      content.documentWithCaptionMessage?.message

    if (!nested) break
    content = nested
  }

  return content || {}
}

/**
 * Read the actual text or caption from an incoming WhatsApp message.
 */
function readMessageText(message, suppliedText) {
  // Prefer the handler's extracted text when it is available.
  if (typeof suppliedText === 'string' && suppliedText.trim()) {
    return suppliedText.trim()
  }

  const content = unwrapMessage(message)

  const candidates = [
    content.conversation,
    content.extendedTextMessage?.text,
    content.imageMessage?.caption,
    content.videoMessage?.caption,
    content.documentMessage?.caption,
    content.buttonsResponseMessage?.selectedDisplayText,
    content.buttonsResponseMessage?.selectedButtonId,
    content.templateButtonReplyMessage?.selectedDisplayText,
    content.listResponseMessage?.title,
    content.listResponseMessage?.description,
    content.listResponseMessage?.singleSelectReply?.selectedRowId,
    content.interactiveResponseMessage?.body?.text
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim()
    }
  }

  // Some interactive replies contain JSON in nativeFlowResponseMessage.
  const nativeParams =
    content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson

  if (typeof nativeParams === 'string') {
    try {
      const parsed = JSON.parse(nativeParams)
      const value =
        parsed?.id ||
        parsed?.text ||
        parsed?.selected_id ||
        parsed?.name

      if (typeof value === 'string' && value.trim()) {
        return value.trim()
      }
    } catch {
      // Ignore malformed interactive response JSON.
    }
  }

  return ''
}

/**
 * Select a suitable emoji based on the meaning and mood of the chat.
 * Random choices are made only from the user's permitted emoji list.
 */
function chooseEmoji(input, reply) {
  const text = `${input} ${reply}`.toLowerCase()

  const has = (pattern) => pattern.test(text)

  let choices

  if (
    has(/\b(udaas|sad|rona|ro raha|ro rahi|pareshan|tension|hurt|sorry|maaf|sorry|takleef|dard|cry|miss you)\b/)
  ) {
    choices = ['🫂', '💗', '🥲', '😭', '🌷']
  } else if (
    has(/\b(kiss|kissy|chumma|chum|lip|hot|sexy|flirt|flirting|seduce)\b/)
  ) {
    choices = ['💋', '🔥', '🙈', '🌚']
  } else if (
    has(/\b(yaad|yaad aa|miss|door|intezar|intezaar|tanha|tanhai|wapis|wapas)\b/)
  ) {
    choices = ['🫂', '💗', '🥲', '🌹', '💋']
  } else if (
    has(/\b(sharma|sharmao|sharmana|shy|blush|blushing|hayee|haye|uff|🙈)\b/)
  ) {
    choices = ['🙈', '🦋', '🌸', '💗']
  } else if (
    has(/\b(mazak|mazaq|tease|teasing|pagal|drama|chupke|secret|naughty)\b/)
  ) {
    choices = ['🌚', '👀', '🙈', '🎭']
  } else if (
    has(/\b(pyar|pyaar|mohabbat|ishq|jaan|meri jaan|love|beloved|dil|heart|beautiful|khubsurat|khoobsurat|cute|sweetheart|baby|babu|shona)\b/)
  ) {
    choices = ['💗', '💋', '🌹', '💍', '🫀', '🌷']
  } else if (
    has(/\b(khush|happy|hansi|muskur|smile|acha laga|accha laga|thank|shukriya|hehe|haha)\b/)
  ) {
    choices = ['🌸', '🌷', '💗', '🌝', '🦋']
  } else if (
    has(/\b(jalan|jealous|possessive|sirf meri|sirf mera|mine|meri ho|mere ho)\b/)
  ) {
    choices = ['👑', '💍', '🌚', '💗']
  } else {
    choices = ['💗', '🌷', '🦋', '🙈', '🌸', '💋', '🌝', '🫂']
  }

  return choices[Math.floor(Math.random() * choices.length)]
}

/**
 * Enforce the requested message format:
 * - _ROMAN URDU MESSAGE"_ EMOJI
 *
 * The body contains uppercase ASCII letters/numbers/spaces only.
 */
function formatReply(rawReply, incomingText) {
  let body = String(rawReply || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*(reply|response|roman urdu)\s*:\s*/i, '')
    .replace(/^\s*[-*"'`]+/, '')
    .replace(/["'`*_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // Remove punctuation, non-ASCII characters, and emojis from the body.
  body = body
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()

  if (!body) return ''

  // Keep the WhatsApp reply short and conversational.
  if (body.length > 350) {
    body = body.slice(0, 350).replace(/\s+\S*$/, '').trim()
  }

  const emoji = chooseEmoji(incomingText, body)

  return `- _${body}"_ ${emoji}`
}

function getSystemPrompt(settings) {
  const lengthInstruction =
    settings.length === 'long'
      ? 'Use two or three short conversational sentences when appropriate'
      : settings.length === 'medium'
        ? 'Usually use one short sentence and add a second only when natural'
        : 'Usually reply with one short natural sentence'

  const styleInstruction = {
    romantic:
      'Be romantic, caring, affectionate, emotionally warm, and sincere',
    flirty:
      'Be playfully flirty, charming, teasing, and romantic without sounding forced',
    sweet:
      'Be sweet, gentle, caring, soft, and affectionate',
    natural:
      'Sound like a real person texting someone they like, with subtle romance and natural emotion'
  }[settings.style] || 'Be natural, romantic, caring, and affectionate'

  return `
You are a natural romantic chat partner texting on WhatsApp.

UNDERSTAND THE MESSAGE FIRST
- Read the latest incoming message carefully and understand its actual meaning.
- Answer what the person really said, asked, or felt.
- Use the recent conversation to understand context, references, questions, emotions, and ongoing topics.
- Do not give an unrelated generic romantic line when the person asks a real question.
- Do not repeat the same opening, phrase, compliment, or reply in every message.
- Keep continuity with the conversation and respond like a human who is paying attention.
- If the person is sad, comfort them. If they are teasing, tease back naturally. If they flirt, flirt back. If they express affection, respond affectionately.
- If they ask something ordinary, answer it naturally while keeping a warm romantic tone where it fits.
- Do not force romance into serious or practical questions.
- Never mention being an AI, a model, or a chatbot.

LANGUAGE AND FORMAT
- Write ONLY in Roman Urdu, meaning Urdu written with English letters.
- Use CAPITAL LETTERS ONLY.
- Do not write Urdu script, Hindi script, or long English sentences.
- Do not use punctuation, markdown, quotation marks, bullets, or emojis in your generated response.
- Return ONLY the message body, not the required outer formatting.
- The application will add the final formatting and select an emoji.
- Never include explanations, labels, alternatives, or multiple draft replies.

PERSONALITY
- ${styleInstruction}.
- ${lengthInstruction}.
- Sound spontaneous, emotionally aware, warm, playful, and human.
- Use everyday Roman Urdu phrases naturally rather than formal or literary Urdu.
- Vary your wording according to the message and recent chat.
- Do not overuse jaan, baby, meri jaan, or the same pet name.
- Do not assume every message is a declaration of love.
- Never invent facts about the person or claim they said something they did not say.
- Keep the reply relevant to the latest message.

${settings.systemPrompt ? `ADDITIONAL OWNER PREFERENCE:\n${settings.systemPrompt}` : ''}
`.trim()
}

async function askGroq(messages) {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is missing from config.env')
  }

  let lastError

  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

    try {
      const response = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages,
          temperature: attempt === 1 ? 0.85 : 0.95,
          max_tokens: 300,
          top_p: 0.9,
          stream: false
        }),
        signal: controller.signal
      })

      const responseText = await response.text()
      let result

      try {
        result = JSON.parse(responseText)
      } catch {
        throw new Error(
          `Groq returned invalid JSON (HTTP ${response.status})`
        )
      }

      if (!response.ok) {
        const apiMessage =
          result?.error?.message || `HTTP ${response.status}`

        const error = new Error(`Groq API error: ${apiMessage}`)
        error.status = response.status
        throw error
      }

      const choice = result?.choices?.[0]
      const content = choice?.message?.content

      const reply = Array.isArray(content)
        ? content
            .map((part) => typeof part === 'string' ? part : part?.text || '')
            .join(' ')
            .trim()
        : typeof content === 'string'
          ? content.trim()
          : ''

      if (reply) return reply

      console.warn('[AI AUTOREPLY] Empty Groq completion', {
        model: GROQ_MODEL,
        attempt,
        finishReason: choice?.finish_reason,
        usage: result?.usage
      })

      lastError = new Error('Groq returned an empty response')
    } catch (error) {
      lastError = error

      console.error(
        `[AI AUTOREPLY] Groq attempt ${attempt}/3 failed:`,
        error.message
      )

      const retryable =
        error.name === 'AbortError' ||
        !error.status ||
        [408, 429, 500, 502, 503, 504].includes(error.status)

      if (!retryable) break
    } finally {
      clearTimeout(timeout)
    }

    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 700))
    }
  }

  throw lastError || new Error('Groq failed to generate a reply')
}

async function sendMessage(sock, jid, message, text) {
  await sock.sendMessage(
    jid,
    { text },
    message ? { quoted: message } : {}
  )
}

function normalizeJid(jid) {
  return typeof jid === 'string' ? jid.trim() : ''
}

function getSenderJid(message, jid, isGroup) {
  if (!isGroup) return jid

  return normalizeJid(
    message?.key?.participant ||
    message?.participant ||
    jid
  )
}

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us')
}

function getChatHistoryKey(jid, senderJid, isGroup) {
  // Keep each group member's conversation context separate.
  return isGroup ? `${jid}:${senderJid}` : jid
}

function hasCommandPrefix(text) {
  const prefix = process.env.PREFIX || '.'
  return Boolean(prefix && text.startsWith(prefix))
}

function chooseHistory(history, key, pairs) {
  const entries = Array.isArray(history[key]) ? history[key] : []
  return entries.slice(-Math.max(1, pairs) * 2)
}

/**
 * Incoming-message listener.
 * The plugin loader requires this to be an OBJECT with a run() method.
 */
export const autoReplyListener = {
  command: '__autoreply_listener',

  async run(data = {}) {
    const {
      sock,
      message,
      text: suppliedText,
      isGroup: handlerSaysGroup,
      isStatus
    } = data

    try {
      if (!sock || !message?.key) return
      if (message.key.fromMe) return

      const jid = normalizeJid(message.key.remoteJid)
      if (!jid || jid === 'status@broadcast') return
      if (isStatus) return

      const isGroup = Boolean(handlerSaysGroup || isGroupJid(jid))
      const settings = await loadSettings()

      if (!settings.enabled) return

      if (isGroup && !settings.groups) return
      if (!isGroup && !settings.inbox) return

      if (settings.blockGroups.includes(jid)) return

      if (
        isGroup &&
        settings.groupMode === 'allow' &&
        !settings.allowedGroups.includes(jid)
      ) {
        return
      }

      if (
        isGroup &&
        settings.groupMode === 'block' &&
        settings.blockGroups.includes(jid)
      ) {
        return
      }

      const incomingText = readMessageText(message, suppliedText)
      if (!incomingText) return

      // Do not auto-reply to bot commands.
      if (hasCommandPrefix(incomingText)) return

      const senderJid = getSenderJid(message, jid, isGroup)
      const historyKey = getChatHistoryKey(jid, senderJid, isGroup)
      const cooldownKey = historyKey
      const now = Date.now()
      const cooldownMs = Math.max(0, Number(settings.cooldown) || 0) * 1000
      const previousReplyAt = cooldowns.get(cooldownKey) || 0

      if (now - previousReplyAt < cooldownMs) return

      // Reserve this cooldown before the API request to avoid parallel replies.
      cooldowns.set(cooldownKey, now)

      const history = await loadHistory()
      const recentMessages = chooseHistory(
        history,
        historyKey,
        Number(settings.historyPairs) || 6
      )

      const latestUserMessage = isGroup
        ? `GROUP MEMBER MESSAGE: ${incomingText}`
        : incomingText

      const messages = [
        {
          role: 'system',
          content: getSystemPrompt(settings)
        },
        ...recentMessages.map((item) => ({
          role: item.role,
          content: item.content
        })),
        {
          role: 'user',
          content: latestUserMessage
        }
      ]

      const rawReply = await askGroq(messages)
      const formattedReply = formatReply(rawReply, incomingText)

      if (!formattedReply) {
        console.warn('[AI AUTOREPLY] Reply was empty after formatting')
        return
      }

      await sendMessage(sock, jid, formattedReply, message)

      // Store the real incoming message and the generated answer.
      const plainReply = formattedReply
        .replace(/^- _/, '')
        .replace(/"_\s*\S+\s*$/, '')
        .trim()

      const updatedHistory = [
        ...recentMessages,
        {
          role: 'user',
          content: latestUserMessage
        },
        {
          role: 'assistant',
          content: plainReply
        }
      ].slice(-Math.max(1, Number(settings.historyPairs) || 6) * 2)

      history[historyKey] = updatedHistory
      await saveHistory(history)
    } catch (error) {
      console.error('[AI AUTOREPLY] Listener failed:', error.message)
    }
  }
}

/**
 * Owner commands:
 * !autoreply on
 * !autoreply off
 * !autoreply status
 * !autoreply inbox on/off
 * !autoreply groups on/off
 * !autoreply mode all/allow/block
 * !autoreply allow
 * !autoreply block
 * !autoreply unallow
 * !autoreply unblock
 * !autoreply style romantic/flirty/sweet/natural
 * !autoreply length short/medium/long
 * !autoreply cooldown 5
 * !autoreply history 6
 * !autoreply prompt your custom preference
 * !autoreply clear
 * !autoreply reset
 */
const autoReplyCommand = {
  command: 'autoreply',
  category: 'ai',
  description: 'Control the AI romantic auto-reply',

  async run({
    sock,
    message,
    args = [],
    text = '',
    isOwner,
    isGroup
  }) {
    const jid = normalizeJid(message?.key?.remoteJid)

    if (!jid) return

    if (!isOwner) {
      await sendMessage(
        sock,
        jid,
        message,
        'ONLY THE BOT OWNER CAN CHANGE AI AUTOREPLY SETTINGS'
      )
      return
    }

    const settings = await loadSettings()
    const sub = String(args[0] || 'status').toLowerCase()
    const value = String(args[1] || '').toLowerCase()
    const groupJid = isGroup ? jid : ''

    const respond = (reply) => sendMessage(sock, jid, message, reply)

    switch (sub) {
      case 'on':
      case 'enable':
      case 'start': {
        settings.enabled = true
        await saveSettings(settings)
        await respond('AI AUTOREPLY IS NOW ON')
        break
      }

      case 'off':
      case 'disable':
      case 'stop': {
        settings.enabled = false
        await saveSettings(settings)
        await respond('AI AUTOREPLY IS NOW OFF')
        break
      }

      case 'status': {
        await respond(
          [
            'AI AUTOREPLY STATUS',
            `ENABLED ${settings.enabled ? 'ON' : 'OFF'}`,
            `INBOX ${settings.inbox ? 'ON' : 'OFF'}`,
            `GROUPS ${settings.groups ? 'ON' : 'OFF'}`,
            `GROUP MODE ${settings.groupMode.toUpperCase()}`,
            `STYLE ${settings.style.toUpperCase()}`,
            `LENGTH ${settings.length.toUpperCase()}`,
            `COOLDOWN ${settings.cooldown} SECONDS`,
            `HISTORY ${settings.historyPairs} PAIRS`,
            `MODEL ${GROQ_MODEL}`
          ].join('\n')
        )
        break
      }

      case 'inbox': {
        if (!['on', 'off'].includes(value)) {
          await respond('USE AUTOREPLY INBOX ON OR AUTOREPLY INBOX OFF')
          break
        }

        settings.inbox = value === 'on'
        await saveSettings(settings)
        await respond(`PRIVATE CHAT AUTOREPLY ${value.toUpperCase()}`)
        break
      }

      case 'groups': {
        if (!['on', 'off'].includes(value)) {
          await respond('USE AUTOREPLY GROUPS ON OR AUTOREPLY GROUPS OFF')
          break
        }

        settings.groups = value === 'on'
        await saveSettings(settings)
        await respond(`GROUP AUTOREPLY ${value.toUpperCase()}`)
        break
      }

      case 'mode': {
        if (!['all', 'allow', 'block'].includes(value)) {
          await respond('GROUP MODE OPTIONS ARE ALL ALLOW OR BLOCK')
          break
        }

        settings.groupMode = value
        await saveSettings(settings)
        await respond(`GROUP MODE SET TO ${value.toUpperCase()}`)
        break
      }

      case 'allow': {
        if (!groupJid) {
          await respond('USE THIS COMMAND INSIDE THE GROUP YOU WANT TO ALLOW')
          break
        }

        settings.allowedGroups = [
          ...new Set([...settings.allowedGroups, groupJid])
        ]
        settings.blockGroups = settings.blockGroups.filter(
          (item) => item !== groupJid
        )

        await saveSettings(settings)
        await respond('THIS GROUP IS NOW ALLOWED')
        break
      }

      case 'block': {
        if (!groupJid) {
          await respond('USE THIS COMMAND INSIDE THE GROUP YOU WANT TO BLOCK')
          break
        }

        settings.blockGroups = [
          ...new Set([...settings.blockGroups, groupJid])
        ]
        settings.allowedGroups = settings.allowedGroups.filter(
          (item) => item !== groupJid
        )

        await saveSettings(settings)
        await respond('THIS GROUP IS NOW BLOCKED')
        break
      }

      case 'unallow': {
        if (!groupJid) {
          await respond('USE THIS COMMAND INSIDE THE GROUP')
          break
        }

        settings.allowedGroups = settings.allowedGroups.filter(
          (item) => item !== groupJid
        )

        await saveSettings(settings)
        await respond('THIS GROUP WAS REMOVED FROM THE ALLOW LIST')
        break
      }

      case 'unblock': {
        if (!groupJid) {
          await respond('USE THIS COMMAND INSIDE THE GROUP')
          break
        }

        settings.blockGroups = settings.blockGroups.filter(
          (item) => item !== groupJid
        )

        await saveSettings(settings)
        await respond('THIS GROUP WAS REMOVED FROM THE BLOCK LIST')
        break
      }

      case 'style': {
        if (!['romantic', 'flirty', 'sweet', 'natural'].includes(value)) {
          await respond('STYLES ARE ROMANTIC FLIRTY SWEET OR NATURAL')
          break
        }

        settings.style = value
        await saveSettings(settings)
        await respond(`ROMANTIC CHAT STYLE SET TO ${value.toUpperCase()}`)
        break
      }

      case 'length': {
        if (!['short', 'medium', 'long'].includes(value)) {
          await respond('REPLY LENGTH OPTIONS ARE SHORT MEDIUM OR LONG')
          break
        }

        settings.length = value
        await saveSettings(settings)
        await respond(`REPLY LENGTH SET TO ${value.toUpperCase()}`)
        break
      }

      case 'cooldown': {
        const seconds = Number(args[1])

        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) {
          await respond('COOLDOWN MUST BE BETWEEN 0 AND 3600 SECONDS')
          break
        }

        settings.cooldown = seconds
        await saveSettings(settings)
        await respond(`COOLDOWN SET TO ${seconds} SECONDS`)
        break
      }

      case 'history': {
        const pairs = Number(args[1])

        if (!Number.isInteger(pairs) || pairs < 1 || pairs > 20) {
          await respond('HISTORY MUST BE BETWEEN 1 AND 20 PAIRS')
          break
        }

        settings.historyPairs = pairs
        await saveSettings(settings)
        await respond(`CONVERSATION HISTORY SET TO ${pairs} PAIRS`)
        break
      }

      case 'prompt': {
        const customPrompt = String(text || args.slice(1).join(' ')).trim()
          .replace(/^prompt\s*/i, '')
          .trim()

        if (!customPrompt) {
          await respond(
            'ADD YOUR PREFERENCE AFTER AUTOREPLY PROMPT OR USE AUTOREPLY PROMPT CLEAR'
          )
          break
        }

        if (customPrompt.toLowerCase() === 'clear') {
          settings.systemPrompt = ''
          await saveSettings(settings)
          await respond('CUSTOM AI PROMPT CLEARED')
          break
        }

        settings.systemPrompt = customPrompt.slice(0, 1500)
        await saveSettings(settings)
        await respond('CUSTOM AI PROMPT UPDATED')
        break
      }

      case 'clear': {
        const history = await loadHistory()

        if (isGroup) {
          for (const key of Object.keys(history)) {
            if (key.startsWith(`${jid}:`)) {
              delete history[key]
            }
          }
        } else {
          delete history[jid]
        }

        await saveHistory(history)
        await respond('RECENT CONVERSATION HISTORY CLEARED')
        break
      }

      case 'reset': {
        const fresh = defaultSettings()
        await saveSettings(fresh)
        await respond('AI AUTOREPLY SETTINGS RESET TO DEFAULTS')
        break
      }

      default: {
        await respond(
          [
            'AI AUTOREPLY COMMANDS',
            '!autoreply on',
            '!autoreply off',
            '!autoreply status',
            '!autoreply inbox on/off',
            '!autoreply groups on/off',
            '!autoreply mode all/allow/block',
            '!autoreply allow',
            '!autoreply block',
            '!autoreply unallow',
            '!autoreply unblock',
            '!autoreply style romantic/flirty/sweet/natural',
            '!autoreply length short/medium/long',
            '!autoreply cooldown 5',
            '!autoreply history 6',
            '!autoreply prompt YOUR PREFERENCE',
            '!autoreply prompt clear',
            '!autoreply clear',
            '!autoreply reset'
          ].join('\n')
        )
      }
    }
  }
}

export default autoReplyCommand
