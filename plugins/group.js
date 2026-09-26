import {
  downloadMediaMessage
} from '@whiskeysockets/baileys'

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DB_DIR = path.join(__dirname, '../database')
const WARN_FILE = path.join(DB_DIR, 'groupwarns.json')
const WARN_LIMIT = 5

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true })
}

function loadWarns() {
  try {
    if (!fs.existsSync(WARN_FILE)) return {}

    return JSON.parse(
      fs.readFileSync(
        WARN_FILE,
        'utf8'
      )
    )
  } catch {
    return {}
  }
}

function saveWarns(data) {
  fs.writeFileSync(
    WARN_FILE,
    JSON.stringify(
      data,
      null,
      2
    )
  )
}

function toSmallCaps(text) {
  const map = {
    a: '\u1D00',
    b: '\u0299',
    c: '\u1D04',
    d: '\u1D05',
    e: '\u1D07',
    f: '\u0493',
    g: '\u0262',
    h: '\u029C',
    i: '\u026A',
    j: '\u1D0A',
    k: '\u1D0B',
    l: '\u029F',
    m: '\u1D0D',
    n: '\u0274',
    o: '\u1D0F',
    p: '\u1D18',
    q: '\u01FA',
    r: '\u0280',
    s: 's',
    t: '\u1D1B',
    u: '\u1D1C',
    v: '\u1D20',
    w: '\u1D21',
    x: 'x',
    y: '\u028F',
    z: '\u1D22'
  }

  return String(text || '')
    .toLowerCase()
    .split('')
    .map(
      c => map[c] || c
    )
    .join('')
}

function getQuotedMessage(message) {
  const msg =
    message.message || {}

  const type =
    Object.keys(msg)[0]

  const context =
    msg[type]?.contextInfo

  return context?.quotedMessage
    ? {
        message:
          context.quotedMessage,

        key: {
          remoteJid:
            message.key.remoteJid,

          fromMe:
            false,

          id:
            context.stanzaId,

          participant:
            context.participant
        }
      }
    : null
}

function extractText(msg) {
  if (!msg) return ''

  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.ephemeralMessage?.message?.conversation ||
    msg.ephemeralMessage?.message?.extendedTextMessage?.text ||
    msg.viewOnceMessage?.message?.conversation ||
    msg.viewOnceMessage?.message?.extendedTextMessage?.text ||
    msg.viewOnceMessage?.message?.imageMessage?.caption ||
    msg.viewOnceMessage?.message?.videoMessage?.caption ||
    ''
  )
}

function getTarget(
  message,
  args = []
) {
  const context =
    message.message?.extendedTextMessage?.contextInfo ||
    message.message?.imageMessage?.contextInfo ||
    message.message?.videoMessage?.contextInfo ||
    {}

  let target =
    context.mentionedJid?.[0] ||
    context.participant

  if (
    !target &&
    args[0]
  ) {
    const number =
      args[0].replace(
        /\D/g,
        ''
      )

    if (number) {
      target =
        `${number}@s.whatsapp.net`
    }
  }

  return target
}

function getInviteCode(text) {
  const match =
    String(text || '').match(
      /chat\.whatsapp\.com\/([0-9A-Za-z]{10,})/i
    )

  return match?.[1] || null
}

function normalizeGroupJid(value) {
  const input =
    String(value || '').trim()

  if (
    /^\d{5,}-\d+@g\.us$/i.test(
      input
    )
  ) {
    return input
  }

  if (
    /^\d{5,}-\d+$/i.test(
      input
    )
  ) {
    return `${input}@g.us`
  }

  return null
}

export default {
  command: [
    'join',
    'left',
    'promote',
    'demote',
    'kick',
    'remove',
    'mute',
    'unmute',
    'invite',
    'grouplink',
    'setgname',
    'setgdesc',
    'gpp',
    'ginfo',
    'approval',
    'approveall',
    'approve',
    'admins',
    'warn',
    'warns',
    'resetwarn'
  ],

  description:
    'Complete group management',

  async run({
    sock,
    message,
    args,
    text,
    command,
    isGroup,
    isOwner
  }) {

    const jid =
      message.key.remoteJid

    /*
     * =========================================================
     * JOIN
     * =========================================================
     */

    if (
      command === 'join'
    ) {
      if (!isOwner) return

      const quoted =
        getQuotedMessage(
          message
        )

      const quotedText =
        extractText(
          quoted?.message
        )

      const link =
        text ||
        args.join(' ') ||
        quotedText

      const inviteCode =
        getInviteCode(
          link
        )

      if (!inviteCode) {
        return await sock.sendMessage(
          jid,
          {
            text:
              `⚠️ ${toSmallCaps(
                'provide a whatsapp group invite link or reply to a group link.'
              )}`
          },
          {
            quoted:
              message
          }
        )
      }

      try {
        const groupJid =
          await sock.groupAcceptInvite(
            inviteCode
          )

        return await sock.sendMessage(
          jid,
          {
            text:
              `✅ ${toSmallCaps(
                'successfully joined the group.'
              )}\n\n${groupJid || ''}`
          },
          {
            quoted:
              message
          }
        )

      } catch (e) {
        console.error(
          '[JOIN ERROR]:',
          e
        )

        return await sock.sendMessage(
          jid,
          {
            text:
              `❌ ${toSmallCaps(
                'failed to join group. link may be invalid, expired, or restricted.'
              )}`
          },
          {
            quoted:
              message
          }
        )
      }
    }

    /*
     * =========================================================
     * GINFO
     * =========================================================
     */

    if (
      command === 'ginfo'
    ) {
      try {
        let targetJid = null
        let metadata = null

        const input =
          text?.trim()

        if (!input) {
          if (!isGroup) {
            return await sock.sendMessage(
              jid,
              {
                text:
                  `⚠️ ${toSmallCaps(
                    'use ginfo inside a group or provide a group jid/link.'
                  )}`
              },
              {
                quoted:
                  message
              }
            )
          }

          targetJid =
            jid

          metadata =
            await sock.groupMetadata(
              targetJid
            )

        } else {
          const directJid =
            normalizeGroupJid(
              input
            )

          if (directJid) {
            targetJid =
              directJid

            metadata =
              await sock.groupMetadata(
                targetJid
              )

          } else {
            const inviteCode =
              getInviteCode(
                input
              )

            if (!inviteCode) {
              return await sock.sendMessage(
                jid,
                {
                  text:
                    `❌ ${toSmallCaps(
                      'invalid group jid or invite link.'
                    )}`
                },
                {
                  quoted:
                    message
                }
              )
            }

            metadata =
              await sock.groupGetInviteInfo(
                inviteCode
              )

            targetJid =
              metadata?.id
          }
        }

        if (!metadata) {
          throw new Error(
            'Group information unavailable'
          )
        }

        const participants =
          metadata.participants ||
          []

        const admins =
          participants.filter(
            p =>
              p.admin === 'admin' ||
              p.admin === 'superadmin'
          )

        const owner =
          metadata.owner ||
          admins.find(
            p =>
              p.admin ===
              'superadmin'
          )?.id ||
          'Unknown'

        const created =
          metadata.creation
            ? new Date(
                metadata.creation *
                  1000
              ).toLocaleString()
            : 'Unknown'

        const type =
          metadata.isCommunity
            ? 'Community'
            : metadata.isCommunityAnnounce
              ? 'Community Announcement'
              : 'Group'

        const info =
          `╭━━━〔 ${toSmallCaps(
            'group info'
          )} 〕━━━┈⊷\n` +
          `│\n` +
          `│ ${toSmallCaps(
            'name'
          )}: ${
            metadata.subject ||
            'Unknown'
          }\n` +
          `│ ${toSmallCaps(
            'jid'
          )}: ${
            targetJid ||
            'Unknown'
          }\n` +
          `│ ${toSmallCaps(
            'type'
          )}: ${type}\n` +
          `│ ${toSmallCaps(
            'members'
          )}: ${
            participants.length
          }\n` +
          `│ ${toSmallCaps(
            'admins'
          )}: ${
            admins.length
          }\n` +
          `│ ${toSmallCaps(
            'owner'
          )}: ${owner}\n` +
          `│ ${toSmallCaps(
            'created'
          )}: ${created}\n` +
          `│ ${toSmallCaps(
            'join approval'
          )}: ${
            metadata.joinApprovalMode
              ? 'On'
              : 'Off'
          }\n` +
          `│ ${toSmallCaps(
            'description'
          )}: ${
            metadata.desc ||
            'None'
          }\n` +
          `│\n` +
          `╰━━━━━━━━━━━━━━━━━━━┈⊷`

        let image

        try {
          if (targetJid) {
            image =
              await sock.profilePictureUrl(
                targetJid,
                'image'
              )
          }
        } catch {}

        if (image) {
          return await sock.sendMessage(
            jid,
            {
              image: {
                url: image
              },
              caption:
                info
            },
            {
              quoted:
                message
            }
          )
        }

        return await sock.sendMessage(
          jid,
          {
            text:
              info
          },
          {
            quoted:
              message
          }
        )

      } catch (e) {
        console.error(
          '[GINFO ERROR]:',
          e
        )

        return await sock.sendMessage(
          jid,
          {
            text:
              `❌ ${toSmallCaps(
                'unable to fetch group information.'
              )}`
          },
          {
            quoted:
              message
          }
        )
      }
    }

    /*
     * =========================================================
     * APPROVAL
     * =========================================================
     */

    if (
      command === 'approval' ||
      command === 'approveall' ||
      command === 'approve'
    ) {
      if (!isGroup) {
        return await sock.sendMessage(
          jid,
          {
            text:
              `❌ ${toSmallCaps(
                'this command can only be used in groups.'
              )}`
          },
          {
            quoted:
              message
          }
        )
      }

      if (!isOwner) {
        const meta =
          await sock.groupMetadata(
            jid
          ).catch(
            () => null
          )

        const sender =
          message.key.participant ||
          message.key.remoteJid

        const senderData =
          meta?.participants?.find(
            p =>
              p.id === sender
          )

        if (
          !senderData ||
          !senderData.admin
        ) {
          return await sock.sendMessage(
            jid,
            {
              text:
                `❌ ${toSmallCaps(
                  'only group admins can approve requests.'
                )}`
            },
            {
              quoted:
                message
            }
          )
        }
      }

      try {
        const requests =
          await sock.groupRequestParticipantsList(
            jid
          )

        if (!requests.length) {
          return await sock.sendMessage(
            jid,
            {
              text:
                `ℹ️ ${toSmallCaps(
                  'no pending join requests.'
                )}`
            },
            {
              quoted:
                message
            }
          )
        }

        let selected =
          requests

        const approveAll =
          command ===
            'approveall' ||
          args[0]?.toLowerCase() ===
            'all' ||
          text?.trim().toLowerCase() ===
            'all'

        if (!approveAll) {
          const amount =
            parseInt(
              args[0] ||
              text,
              10
            )

          if (
            !amount ||
            amount < 1
          ) {
            return await sock.sendMessage(
              jid,
              {
                text:
                  `⚠️ ${toSmallCaps(
                    'use approval followed by a number, for example: approval 20'
                  )}`
              },
              {
                quoted:
                  message
              }
            )
          }

          selected =
            requests.slice(
              0,
              amount
            )
        }

        const participants =
          selected
            .map(
              r =>
                r.jid
            )
            .filter(
              Boolean
            )

        if (
          !participants.length
        ) {
          return await sock.sendMessage(
            jid,
            {
              text:
                `❌ ${toSmallCaps(
                  'no valid pending requests found.'
                )}`
            },
            {
              quoted:
                message
            }
          )
        }

        const result =
          await sock.groupRequestParticipantsUpdate(
            jid,
            participants,
            'approve'
          )

        const approved =
          result.filter(
            r =>
              String(
                r.status
              ) === '200'
          ).length

        return await sock.sendMessage(
          jid,
          {
            text:
              `✅ ${toSmallCaps(
                'approval completed.'
              )}\n\n` +
              `╭─ ${toSmallCaps(
                'requested'
              )}: ${
                participants.length
              }\n` +
              `├─ ${toSmallCaps(
                'approved'
              )}: ${
                approved
              }\n` +
              `╰─ ${toSmallCaps(
                'pending'
              )}: ${
                Math.max(
                  requests.length -
                    approved,
                  0
                )
              }`
          },
          {
            quoted:
              message
          }
        )

      } catch (e) {
        console.error(
          '[APPROVAL ERROR]:',
          e
        )

        return await sock.sendMessage(
          jid,
          {
            text:
              `❌ ${toSmallCaps(
                'failed to process join requests. make sure the bot is an admin and join approval is enabled.'
              )}`
          },
          {
            quoted:
              message
          }
        )
      }
    }

    /*
     * =========================================================
     * GROUP CONTEXT
     * =========================================================
     */

    if (!isGroup) {
      return await sock.sendMessage(
        jid,
        {
          text:
            `❌ ${toSmallCaps(
              'this command can only be used in groups.'
            )}`
        },
        {
          quoted:
            message
        }
      )
    }

    /*
     * =========================================================
     * GROUP METADATA
     * =========================================================
     */

    const groupMetadata =
      await sock.groupMetadata(
        jid
      ).catch(
        () => null
      )

    if (!groupMetadata) {
      return
    }

    const sender =
      message.key.participant ||
      jid

    const senderData =
      groupMetadata.participants.find(
        p =>
          p.id === sender
      )

    const isAdmin =
      !!senderData?.admin

    /*
     * =========================================================
     * INVITE / GROUPLINK
     *
     * Sends ONLY:
     *
     * https://chat.whatsapp.com/XXXXXXXX
     *
     * with link preview enabled.
     * =========================================================
     */

    if (
      command === 'invite' ||
      command === 'grouplink'
    ) {
      if (
        !isAdmin &&
        !isOwner
      ) {
        return await sock.sendMessage(
          jid,
          {
            text:
              `❌ ${toSmallCaps(
                'only group admins can get the group invite.'
              )}`
          },
          {
            quoted:
              message
          }
        )
      }

      try {
        const code =
          await sock.groupInviteCode(
            jid
          )

        if (!code) {
          throw new Error(
            'Invite code not returned'
          )
        }

        const inviteLink =
          `https://chat.whatsapp.com/${code}`

        /*
         * Only the URL is sent.
         *
         * linkPreview: true
         * asks WhatsApp/Baileys to
         * generate the preview.
         */

        return await sock.sendMessage(
          jid,
          {
            text:
              inviteLink,
            linkPreview:
              true
          },
          {
            quoted:
              message
          }
        )

      } catch (error) {
        console.error(
          '[GROUP INVITE ERROR]:',
          error?.message ||
          error
        )

        return await sock.sendMessage(
          jid,
          {
            text:
              `❌ ${toSmallCaps(
                'failed to get the group invite link. make sure the bot is an admin.'
              )}`
          },
          {
            quoted:
              message
          }
        )
      }
    }

    /*
     * =========================================================
     * ADMINS
     * =========================================================
     */

    if (
      command === 'admins'
    ) {
      const admins =
        groupMetadata.participants.filter(
          p =>
            p.admin === 'admin' ||
            p.admin === 'superadmin'
        )

      if (!admins.length) {
        return await sock.sendMessage(
          jid,
          {
            text:
              `ℹ️ ${toSmallCaps(
                'no admins found.'
              )}`
          },
          {
            quoted:
              message
          }
        )
      }

      const mentions =
        admins.map(
          p =>
            p.id
        )

      const list =
        admins
          .map(
            (p, i) =>
              `${i + 1}. @${p.id.split('@')[0]}`
          )
          .join('\n')

      return await sock.sendMessage(
        jid,
        {
          text:
            `╭━━━〔 ${toSmallCaps(
              'group admins'
            )} 〕━━━┈⊷\n` +
            `${list}\n` +
            `╰━━━━━━━━━━━━━━━━━━━┈⊷`,
          mentions
        },
        {
          quoted:
            message
        }
      )
    }

    /*
     * =========================================================
     * WARN / WARNS / RESETWARN
     * =========================================================
     */

    if (
      command === 'warn' ||
      command === 'warns' ||
      command === 'resetwarn'
    ) {
      if (
        !isAdmin &&
        !isOwner
      ) {
        return await sock.sendMessage(
          jid,
          {
            text:
              `❌ ${toSmallCaps(
                'only group admins can manage warnings.'
              )}`
          },
          {
            quoted:
              message
          }
        )
      }

      const target =
        getTarget(
          message,
          args
        )

      if (!target) {
        return await sock.sendMessage(
          jid,
          {
            text:
              `⚠️ ${toSmallCaps(
                'mention a user or reply to their message.'
              )}`
          },
          {
            quoted:
              message
          }
        )
      }

      const targetData =
        groupMetadata.participants.find(
          p =>
            p.id === target
        )

      if (
        targetData?.admin ===
          'admin' ||
        targetData?.admin ===
          'superadmin'
      ) {
        return await sock.sendMessage(
          jid,
          {
            text:
              `❌ ${toSmallCaps(
                'you cannot warn a group admin.'
              )}`
          },
          {
            quoted:
              message
          }
        )
      }

      const warns =
        loadWarns()

      if (!warns[jid]) {
        warns[jid] = {}
      }

      if (
        !warns[jid][target]
      ) {
        warns[jid][target] = 0
      }

      if (
        command === 'warns'
      ) {
        const count =
          warns[jid][target] ||
          0

        return await sock.sendMessage(
          jid,
          {
            text:
              `⚠️ @${target.split('@')[0]}\n\n` +
              `${toSmallCaps(
                'warnings'
              )}: ${count}/${WARN_LIMIT}`,
            mentions: [
              target
            ]
          },
          {
            quoted:
              message
          }
        )
      }

      if (
        command === 'resetwarn'
      ) {
        warns[jid][target] =
          0

        saveWarns(
          warns
        )

        return await sock.sendMessage(
          jid,
          {
            text:
              `✅ ${toSmallCaps(
                'warnings reset.'
              )}\n\n` +
              `@${target.split('@')[0]} → 0/${WARN_LIMIT}`,
            mentions: [
              target
            ]
          },
          {
            quoted:
              message
          }
        )
      }

      warns[jid][target]++

      const count =
        warns[jid][target]

      if (
        count >= WARN_LIMIT
      ) {
        delete warns[jid][target]

        saveWarns(
          warns
        )

        try {
          await sock.groupParticipantsUpdate(
            jid,
            [target],
            'remove'
          )

          return await sock.sendMessage(
            jid,
            {
              text:
                `🚫 @${target.split('@')[0]}\n\n` +
                `${toSmallCaps(
                  'warning limit reached. user removed from group.'
                )}\n\n` +
                `${toSmallCaps(
                  `limit: ${WARN_LIMIT} warnings`
                )}`,
              mentions: [
                target
              ]
            },
            {
              quoted:
                message
            }
          )

        } catch (e) {
          console.error(
            '[WARN REMOVE ERROR]:',
            e
          )

          return await sock.sendMessage(
            jid,
            {
              text:
                `⚠️ @${target.split('@')[0]}\n\n` +
                `${toSmallCaps(
                  'warning limit reached, but i could not remove the user. make sure the bot is an admin.'
                )}`,
              mentions: [
                target
              ]
            },
            {
              quoted:
                message
            }
          )
        }
      }

      saveWarns(
        warns
      )

      return await sock.sendMessage(
        jid,
        {
          text:
            `⚠️ @${target.split('@')[0]}\n\n` +
            `${toSmallCaps(
              'warning added.'
            )}\n\n` +
            `${toSmallCaps(
              `warnings: ${count}/${WARN_LIMIT}`
            )}`,
          mentions: [
            target
          ]
        },
        {
          quoted:
            message
        }
      )
    }

    /*
     * =========================================================
     * ADMIN CHECK
     * =========================================================
     */

    if (
      !isAdmin &&
      !isOwner
    ) {
      return await sock.sendMessage(
        jid,
        {
          text:
            `❌ ${toSmallCaps(
              'only group admins can use this command.'
            )}`
        },
        {
          quoted:
            message
        }
      )
    }

    /*
     * =========================================================
     * LEAVE
     * =========================================================
     */

    if (
      command === 'left'
    ) {
      await sock.sendMessage(
        jid,
        {
          text:
            `👋 ${toSmallCaps(
              'leaving group...'
            )}`
        }
      )

      await sock.groupLeave(
        jid
      ).catch(
        () => {}
      )

      return
    }

    /*
     * =========================================================
     * MUTE / UNMUTE
     * =========================================================
     */

    if (
      command === 'mute' ||
      command === 'unmute'
    ) {
      const setting =
        command === 'mute'
          ? 'announcement'
          : 'not_announcement'

      try {
        await sock.groupSettingUpdate(
          jid,
          setting
        )

        const statusText =
          command === 'mute'
            ? `🔒 ${toSmallCaps(
                'group muted. only admins can send messages.'
              )}`
            : `🔓 ${toSmallCaps(
                'group unmuted. all members can send messages.'
              )}`

        return await sock.sendMessage(
          jid,
          {
            text:
              statusText
          },
          {
            quoted:
              message
          }
        )

      } catch {
        return await sock.sendMessage(
          jid,
          {
            text:
              `❌ ${toSmallCaps(
                'failed to update group settings. ensure bot is admin.'
              )}`
          },
          {
            quoted:
              message
          }
        )
      }
    }

    /*
     * =========================================================
     * PROMOTE / DEMOTE / KICK / REMOVE
     * =========================================================
     */

    if (
      [
        'promote',
        'demote',
        'kick',
        'remove'
      ].includes(
        command
      )
    ) {
      const target =
        getTarget(
          message,
          args
        )

      if (!target) {
        return await sock.sendMessage(
          jid,
          {
            text:
              `⚠️ ${toSmallCaps(
                'please mention a user or reply to their message.'
              )}`
          },
          {
            quoted:
              message
          }
        )
      }

      let action =
        command === 'promote'
          ? 'promote'
          : command === 'demote'
            ? 'demote'
            : 'remove'

      try {
        await sock.groupParticipantsUpdate(
          jid,
          [target],
          action
        )

        const actionText =
          action === 'promote'
            ? 'promoted to admin'
            : action === 'demote'
              ? 'demoted from admin'
              : 'removed from group'

        return await sock.sendMessage(
          jid,
          {
            text:
              `✅ ${toSmallCaps(
                `user successfully ${actionText}.`
              )}`
          },
          {
            quoted:
              message
          }
        )

      } catch {
        return await sock.sendMessage(
          jid,
          {
            text:
              `❌ ${toSmallCaps(
                'action failed. ensure bot is an admin.'
              )}`
          },
          {
            quoted:
              message
          }
        )
      }
    }

    /*
     * =========================================================
     * SET GROUP NAME
     * =========================================================
     */

    if (
      command === 'setgname'
    ) {
      if (!text) {
        return await sock.sendMessage(
          jid,
          {
            text:
              `⚠️ ${toSmallCaps(
                'please provide a new group name.'
              )}`
          },
          {
            quoted:
              message
          }
        )
      }

      try {
        await sock.groupUpdateSubject(
          jid,
          text
        )

        return await sock.sendMessage(
          jid,
          {
            text:
              `✅ ${toSmallCaps(
                'group name successfully updated.'
              )}`
          },
          {
            quoted:
              message
          }
        )

      } catch {
        return await sock.sendMessage(
          jid,
          {
            text:
              `❌ ${toSmallCaps(
                'failed to update group name.'
              )}`
          },
          {
            quoted:
              message
          }
        )
      }
    }

    /*
     * =========================================================
     * SET GROUP DESCRIPTION
     * =========================================================
     */

    if (
      command === 'setgdesc'
    ) {
      if (!text) {
        return await sock.sendMessage(
          jid,
          {
            text:
              `⚠️ ${toSmallCaps(
                'please provide a new group description.'
              )}`
          },
          {
            quoted:
              message
          }
        )
      }

      try {
        await sock.groupUpdateDescription(
          jid,
          text
        )

        return await sock.sendMessage(
          jid,
          {
            text:
              `✅ ${toSmallCaps(
                'group description successfully updated.'
              )}`
          },
          {
            quoted:
              message
          }
        )

      } catch {
        return await sock.sendMessage(
          jid,
          {
            text:
              `❌ ${toSmallCaps(
                'failed to update group description.'
              )}`
          },
          {
            quoted:
              message
          }
        )
      }
    }

    /*
     * =========================================================
     * GROUP PROFILE PICTURE
     * =========================================================
     */

    if (
      command === 'gpp'
    ) {
      const quoted =
        getQuotedMessage(
          message
        )

      let targetMediaMessage =
        null

      if (
        quoted?.message?.imageMessage ||
        quoted?.message?.ephemeralMessage?.message?.imageMessage ||
        quoted?.message?.viewOnceMessage?.message?.imageMessage
      ) {
        targetMediaMessage =
          quoted
      }

      if (
        !targetMediaMessage &&
        message.message?.imageMessage
      ) {
        targetMediaMessage =
          message
      }

      if (!targetMediaMessage) {
        return await sock.sendMessage(
          jid,
          {
            text:
              `⚠️ ${toSmallCaps(
                'reply to an image with gpp to change the group picture.'
              )}`
          },
          {
            quoted:
              message
          }
        )
      }

      try {
        const buffer =
          await downloadMediaMessage(
            targetMediaMessage,
            'buffer',
            {}
          )

        await sock.updateProfilePicture(
          jid,
          buffer
        )

        return await sock.sendMessage(
          jid,
          {
            text:
              `✅ ${toSmallCaps(
                'group profile picture successfully updated.'
              )}`
          },
          {
            quoted:
              message
          }
        )

      } catch (e) {
        console.error(
          '[GROUP PP ERROR]:',
          e
        )

        return await sock.sendMessage(
          jid,
          {
            text:
              `❌ ${toSmallCaps(
                'failed to update group picture. make sure bot is an admin.'
              )}`
          },
          {
            quoted:
              message
          }
        )
      }
    }
  }
}