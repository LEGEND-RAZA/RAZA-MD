import {
  getDb,
  saveDb
} from '../database/index.js'

function getSettings() {
  return getDb(
    'pdm.json',
    {
      enabled: false
    }
  )
}

function isEnabled() {
  return getSettings().enabled === true
}

function setEnabled(value) {
  const data =
    getSettings()

  data.enabled =
    value === true

  saveDb(
    'pdm.json',
    data
  )

  return data.enabled
}

function cleanJid(jid) {
  if (!jid) return ''

  return String(jid)
    .trim()
}

function mention(jid) {
  const value =
    cleanJid(jid)

  if (!value) {
    return '@unknown'
  }

  const number =
    value
      .split('@')[0]
      .split(':')[0]
      .replace(/\D/g, '')

  return number
    ? `@${number}`
    : `@unknown`
}

export default {
  command: 'pdm',

  async run({
    sock,
    message,
    args
  }) {
    const jid =
      message?.key?.remoteJid

    if (!jid) return

    const action =
      args?.[0]?.toLowerCase()

    if (
      action === 'on' ||
      action === 'enable'
    ) {
      setEnabled(true)

      return await sock.sendMessage(
        jid,
        {
          text:
            '✅ ᴘᴅᴍ ᴀʟᴇʀᴛ ᴇɴᴀʙʟᴇᴅ'
        },
        {
          quoted: message
        }
      )
    }

    if (
      action === 'off' ||
      action === 'disable'
    ) {
      setEnabled(false)

      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴘᴅᴍ ᴀʟᴇʀᴛ ᴅɪsᴀʙʟᴇᴅ'
        },
        {
          quoted: message
        }
      )
    }

    return await sock.sendMessage(
      jid,
      {
        text:
          `╭─❒ ᴘᴅᴍ ᴀʟᴇʀᴛ ❒\n` +
          `│\n` +
          `│ sᴛᴀᴛᴜs: ${
            isEnabled()
              ? 'ᴏɴ'
              : 'ᴏғғ'
          }\n` +
          `│\n` +
          `│ .pdm on\n` +
          `│ .pdm off\n` +
          `│ .pdm\n` +
          `╰────────────`
      },
      {
        quoted: message
      }
    )
  }
}

/*
 * ==============================
 * PDM GROUP EVENT LISTENER
 * ==============================
 */

export const pdmListener = {
  isGroupEvent: true,

  async run({
    sock,
    update
  }) {
    /*
     * Debug event
     */
    console.log(
      '[PDM EVENT]',
      JSON.stringify(
        update
      )
    )

    /*
     * OFF = do nothing
     */
    if (!isEnabled()) {
      return
    }

    if (!update) {
      return
    }

    const action =
      update.action

    /*
     * Only promote / demote
     */
    if (
      action !== 'promote' &&
      action !== 'demote'
    ) {
      return
    }

    const groupJid =
      update.id

    if (
      !groupJid ||
      !String(
        groupJid
      ).endsWith('@g.us')
    ) {
      return
    }

    const participants =
      Array.isArray(
        update.participants
      )
        ? update.participants
        : []

    if (
      !participants.length
    ) {
      return
    }

    /*
     * Baileys uses "author"
     * for the person who performed
     * the action.
     */
    const actor =
      update.author ||
      update.actor ||
      update.participant ||
      ''

    const actionText =
      action === 'promote'
        ? 'ᴘʀᴏᴍᴏᴛᴇᴅ'
        : 'ᴅᴇᴍᴏᴛᴇᴅ'

    const icon =
      action === 'promote'
        ? '⬆️'
        : '⬇️'

    const targetMentions =
      participants.map(
        (participant) =>
          cleanJid(
            typeof participant === 'string'
              ? participant
              : participant?.jid ||
                participant?.id ||
                participant?.lid ||
                ''
          )
      ).filter(Boolean)

    const actorJid =
      cleanJid(actor)

    const mentions = [
      ...(actorJid
        ? [actorJid]
        : []),
      ...targetMentions
    ]

    const uniqueMentions =
      [
        ...new Set(
          mentions
        )
      ]

    const targets =
      targetMentions
        .map(
          (participant) =>
            `│ 👤 ${mention(
              participant
            )}`
        )
        .join('\n')

    const text =
      `╭─❒ ${icon} ᴘᴅᴍ ᴀʟᴇʀᴛ ❒\n` +
      `│\n` +
      `│ ᴀᴄᴛɪᴏɴ: ${actionText}\n` +
      `│ ʙʏ: ${mention(actorJid)}\n` +
      `│\n` +
      `${targets}\n` +
      `│\n` +
      `╰────────────`

    try {
      await sock.sendMessage(
        groupJid,
        {
          text,
          mentions:
            uniqueMentions
        }
      )

      console.log(
        `[PDM] ${action} alert sent → ${groupJid}`
      )

    } catch (error) {
      console.error(
        '[PDM SEND ERROR]',
        error?.message ||
        error
      )
    }
  }
}