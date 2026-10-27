import {
  getDb,
  saveDb
} from '../database/index.js'

import {
  prepareWAMessageMedia,
  generateWAMessageFromContent,
  jidNormalizedUser
} from '@whiskeysockets/baileys'

const DB_KEY = 'alinks_settings'
const sentLinks = new Set()

function loadSettings() {
  return getDb(DB_KEY, {
    targetJids: [],
    customMsg: '',
    enabled: false
  })
}

function saveSettings(settings) {
  return saveDb(DB_KEY, settings)
}

const delay = ms =>
  new Promise(resolve => setTimeout(resolve, ms))

/*
 * ==============================
 * LINK PREVIEW BUILDER
 * ==============================
 * Builds the extendedTextMessage preview fields with the group's
 * own DP, name, and description.
 *
 * Uses prepareWAMessageMedia to convert the DP into a small JPEG
 * (the jpegThumbnail field WhatsApp expects for a preview card).
 */
async function buildPreviewThumb(sock, groupJid) {
  if (!groupJid) return null
  try {
    const ppUrl = await sock.profilePictureUrl(groupJid, 'image')
    if (!ppUrl) return null

    const res = await fetch(ppUrl)
    if (!res.ok) return null

    const fullBuf = Buffer.from(await res.arrayBuffer())
    const prepared = await prepareWAMessageMedia(
      { image: fullBuf },
      { upload: sock.waUploadToServer }
    )
    return prepared?.imageMessage?.jpegThumbnail || null
  } catch (e) {
    console.error('[ALINKS] preview thumb failed:', e?.message || e)
    return null
  }
}

/*
 * Send an extendedTextMessage with a preserved preview card.
 * Falls back to plain text if the raw send fails for any reason.
 */
async function sendLinkWithPreview(
  sock,
  targetJid,
  text,
  link,
  groupName,
  thumbBuf
) {
  const userJid = jidNormalizedUser(sock.user.id)

  const ext = {
    text,
    matchedText: link,
    canonicalUrl: link,
    title: groupName,
    description: `Invite to join "${groupName}"`,
    previewType: 'NONE'
  }
  if (thumbBuf) ext.jpegThumbnail = thumbBuf

  try {
    const msg = generateWAMessageFromContent(
      targetJid,
      { extendedTextMessage: ext },
      { userJid }
    )
    await sock.relayMessage(targetJid, msg.message, {
      messageId: msg.key.id
    })
  } catch (e) {
    console.error(
      '[ALINKS] relay with preview failed, falling back:',
      e?.message || e
    )
    await sock.sendMessage(targetJid, { text })
  }
}

export default {
  command: 'alinks',
  category: 'tools',
  description:
    'Automatically collect and forward WhatsApp group links',

  async run({
    sock,
    message,
    args,
    isOwner
  }) {
    const jid = message?.key?.remoteJid
    if (!jid) return

    if (!isOwner) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴏɴʟʏ ᴛʜᴇ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴜsᴇ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ.'
        },
        { quoted: message }
      )
    }

    const settings = loadSettings()
    const commandArgs = Array.isArray(args) ? args : []
    const cmd = commandArgs.shift()?.trim().toLowerCase()
    const value = commandArgs.join(' ').trim()

    if (!cmd || cmd === 'check') {
      return await sock.sendMessage(
        jid,
        {
          text:
`╭───〔 ᴀʟɪɴᴋs 〕
│
│ sᴛᴀᴛᴜs:
│ ${settings.enabled ? 'ᴏɴ' : 'ᴏғғ'}
│
│ ᴛᴀʀɢᴇᴛs:
│ ${
  settings.targetJids.length
    ? settings.targetJids.join('\n│ ')
    : 'ɴᴏ ᴊɪᴅs'
}
│
│ ᴍᴇssᴀɢᴇ:
│ ${settings.customMsg || 'ɴᴏ ᴍᴇssᴀɢᴇ'}
│
╰──────────────`
        },
        { quoted: message }
      )
    }

    if (cmd === 'on') {
      settings.enabled = true
      saveSettings(settings)
      return await sock.sendMessage(
        jid,
        { text: '✅ ᴀʟɪɴᴋs ʜᴀs ʙᴇᴇɴ ᴇɴᴀʙʟᴇᴅ.' },
        { quoted: message }
      )
    }

    if (cmd === 'off') {
      settings.enabled = false
      saveSettings(settings)
      return await sock.sendMessage(
        jid,
        { text: '❌ ᴀʟɪɴᴋs ʜᴀs ʙᴇᴇɴ ᴅɪsᴀʙʟᴇᴅ.' },
        { quoted: message }
      )
    }

    if (cmd === 'add') {
      if (!value.includes('@')) {
        return await sock.sendMessage(
          jid,
          { text: '❌ ɪɴᴠᴀʟɪᴅ ᴊɪᴅ.' },
          { quoted: message }
        )
      }
      if (!settings.targetJids.includes(value)) {
        settings.targetJids.push(value)
        saveSettings(settings)
      }
      return await sock.sendMessage(
        jid,
        { text: '✅ ᴊɪᴅ ᴀᴅᴅᴇᴅ ᴛᴏ ᴀʟɪɴᴋs.' },
        { quoted: message }
      )
    }

    if (cmd === 'del' || cmd === 'remove') {
      settings.targetJids = settings.targetJids.filter(
        target => target !== value
      )
      saveSettings(settings)
      return await sock.sendMessage(
        jid,
        { text: '❌ ᴊɪᴅ ʀᴇᴍᴏᴠᴇᴅ ғʀᴏᴍ ᴀʟɪɴᴋs.' },
        { quoted: message }
      )
    }

    if (cmd === 'msg') {
      settings.customMsg = value
      saveSettings(settings)
      return await sock.sendMessage(
        jid,
        { text: '✅ ᴀʟɪɴᴋs ᴍᴇssᴀɢᴇ ᴜᴘᴅᴀᴛᴇᴅ.' },
        { quoted: message }
      )
    }

    if (cmd === 'clear') {
      settings.targetJids = []
      settings.customMsg = ''
      saveSettings(settings)
      return await sock.sendMessage(
        jid,
        { text: '✅ ᴀʟɪɴᴋs sᴇᴛᴛɪɴɢs ᴄʟᴇᴀʀᴇᴅ.' },
        { quoted: message }
      )
    }

    return await sock.sendMessage(
      jid,
      {
        text:
`╭───〔 ᴀʟɪɴᴋs ʜᴇʟᴘ 〕
│
│ .ᴀʟɪɴᴋs ᴏɴ
│ .ᴀʟɪɴᴋs ᴏғғ
│ .ᴀʟɪɴᴋs ᴄʜᴇᴄᴋ
│
│ .ᴀʟɪɴᴋs ᴀᴅᴅ ᴊɪᴅ
│ .ᴀʟɪɴᴋs ᴅᴇʟ ᴊɪᴅ
│ .ᴀʟɪɴᴋs ʀᴇᴍᴏᴠᴇ ᴊɪᴅ
│
│ .ᴀʟɪɴᴋs ᴍsɢ ᴛᴇxᴛ
│
│ .ᴀʟɪɴᴋs ᴄʟᴇᴀʀ
│
╰──────────────`
      },
      { quoted: message }
    )
  }
}

export const __alinks_listener = {
  on: 'text',
  fromMe: false,

  async run({ sock, message }) {
    try {
      const settings = loadSettings()
      if (!settings.enabled) return
      if (!settings.targetJids || !settings.targetJids.length) return

      const text =
        message?.text ||
        message?.body ||
        message?.message?.conversation ||
        message?.message?.extendedTextMessage?.text ||
        ''

      if (!text) return

      const regex =
        /https?:\/\/chat\.whatsapp\.com\/[0-9A-Za-z]+/gi

      const matches = text.match(regex)
      if (!matches) return

      await delay(1500)

      for (const link of matches) {
        if (sentLinks.has(link)) continue

        const code = link.split('/').pop()
        if (!code) continue

        try {
          const meta = await sock.groupGetInviteInfo(code)
          const groupName = meta?.subject || 'WhatsApp Group'
          const groupId = meta?.id

          // Fetch DP once, reuse across all targets
          const thumbBuf = await buildPreviewThumb(sock, groupId)

          const bodyText = settings.customMsg
            ? `${settings.customMsg}\n${link}`
            : link

          for (const targetJid of settings.targetJids) {
            await sendLinkWithPreview(
              sock,
              targetJid,
              bodyText,
              link,
              groupName,
              thumbBuf
            )
          }

          sentLinks.add(link)
          if (sentLinks.size > 500) sentLinks.clear()
        } catch (error) {
          console.error(
            '[ALINKS] group info failed, sending plain:',
            error?.message || error
          )

          const bodyText = settings.customMsg
            ? `${settings.customMsg}\n${link}`
            : link

          for (const targetJid of settings.targetJids) {
            try {
              await sock.sendMessage(targetJid, { text: bodyText })
            } catch {}
          }

          sentLinks.add(link)
          if (sentLinks.size > 500) sentLinks.clear()
        }
      }
    } catch (error) {
      console.error(
        '[ALINKS]',
        error?.message || error
      )
    }
  }
}
