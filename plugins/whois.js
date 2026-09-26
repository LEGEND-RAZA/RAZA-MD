import {
  jidNormalizedUser
} from '@whiskeysockets/baileys'

function cleanText(value) {
  if (
    value === null ||
    value === undefined
  ) return ''

  return String(value).trim()
}

function getNumber(jid) {
  return String(jid || '')
    .split('@')[0]
    .split(':')[0]
    .replace(/\D/g, '')
}

function isLid(jid) {
  return String(jid || '')
    .endsWith('@lid')
}

function getContext(message) {
  const m =
    message?.message

  if (!m) return {}

  return (
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    m.audioMessage?.contextInfo ||
    m.stickerMessage?.contextInfo ||
    {}
  )
}

function getMentionedJid(message) {
  const context =
    getContext(message)

  return (
    context?.mentionedJid?.[0] ||
    ''
  )
}

function getQuotedJid(message) {
  const context =
    getContext(message)

  return (
    context?.participant ||
    message?.quoted?.participant ||
    message?.quoted?.key?.participant ||
    ''
  )
}

async function resolveLid(sock, jid) {
  if (!jid) return ''

  if (!isLid(jid)) {
    return jidNormalizedUser(jid)
  }

  try {
    const mapping =
      sock?.signalRepository?.lidMapping

    if (
      mapping &&
      typeof mapping.getPNForLID ===
        'function'
    ) {
      const pn =
        await mapping.getPNForLID(jid)

      if (pn) {
        return jidNormalizedUser(pn)
      }
    }
  } catch (error) {
    console.error(
      '[WHOIS LID]',
      error?.message || error
    )
  }

  return jid
}

/*
 * Try to find a cached name.
 */
function getCachedName(sock, jid) {
  try {
    const contacts =
      sock?.contacts

    if (!contacts) return ''

    const contact =
      contacts[jid] ||
      contacts[
        jidNormalizedUser(jid)
      ]

    return cleanText(
      contact?.name ||
      contact?.notify ||
      contact?.verifiedName
    )
  } catch {
    return ''
  }
}

/*
 * Try to find the member in group metadata.
 */
async function getGroupMemberName(
  sock,
  chatJid,
  targetJid
) {
  if (
    !chatJid?.endsWith('@g.us')
  ) {
    return ''
  }

  try {
    const metadata =
      await sock.groupMetadata(
        chatJid
      )

    const target =
      jidNormalizedUser(
        targetJid
      )

    const participant =
      metadata?.participants?.find(
        p =>
          p?.id === target ||
          p?.jid === target ||
          p?.lid === targetJid
      )

    return cleanText(
      participant?.notify ||
      participant?.name ||
      participant?.verifiedName
    )
  } catch {
    return ''
  }
}

export default {
  command: 'whois',

  async run({
    sock,
    message,
    args
  }) {
    const chatJid =
      message?.key?.remoteJid

    if (!chatJid) return

    let targetJid = ''
    let input = ''

    /*
     * =================================
     * 1. MENTION
     * =================================
     *
     * .whois @member
     *
     * IMPORTANT:
     * Check this BEFORE args because
     * the mention text also contains
     * digits.
     */

    const mentionedJid =
      getMentionedJid(message)

    if (mentionedJid) {
      targetJid =
        await resolveLid(
          sock,
          mentionedJid
        )
    }

    /*
     * =================================
     * 2. REPLY
     * =================================
     */

    if (!targetJid) {
      const quotedJid =
        getQuotedJid(message)

      if (quotedJid) {
        targetJid =
          await resolveLid(
            sock,
            quotedJid
          )
      }
    }

    /*
     * =================================
     * 3. DIRECT NUMBER
     * =================================
     */

    if (!targetJid) {
      const number =
        args
          ?.join('')
          ?.replace(/\D/g, '') || ''

      if (number.length >= 7) {
        input = number

        targetJid =
          jidNormalizedUser(
            `${number}@s.whatsapp.net`
          )
      }
    }

    /*
     * Nothing found
     */

    if (!targetJid) {
      return await sock.sendMessage(
        chatJid,
        {
          text:
            `╭─❒ ᴡʜᴏɪs ❒\n` +
            `│\n` +
            `│ .whois 923xxxxxxxxx\n` +
            `│ .whois @member\n` +
            `│ ʀᴇᴘʟʏ + .whois\n` +
            `│\n` +
            `╰────────────`
        },
        {
          quoted: message
        }
      )
    }

    /*
     * LID could not be resolved
     */

    if (isLid(targetJid)) {
      return await sock.sendMessage(
        chatJid,
        {
          text:
            `❌ ᴄᴏᴜʟᴅ ɴᴏᴛ ʀᴇsᴏʟᴠᴇ ᴛʜᴇ ʀᴇᴘʟɪᴇᴅ/ᴍᴇɴᴛɪᴏɴᴇᴅ ᴜsᴇʀ.\n\n` +
            `ᴛʀʏ ᴜsɪɴɢ ᴛʜᴇɪʀ ᴘʜᴏɴᴇ ɴᴜᴍʙᴇʀ.`
        },
        {
          quoted: message
        }
      )
    }

    /*
     * =================================
     * NUMBER
     * =================================
     */

    input =
      getNumber(targetJid)

    /*
     * =================================
     * WHATSAPP CHECK
     * =================================
     */

    let waData = null

    try {
      const result =
        await sock.onWhatsApp(
          targetJid
        )

      waData =
        Array.isArray(result)
          ? result[0]
          : result
    } catch (error) {
      console.error(
        '[WHOIS CHECK]',
        error?.message || error
      )
    }

    if (
      waData &&
      waData.exists === false
    ) {
      return await sock.sendMessage(
        chatJid,
        {
          text:
            `❌ ɴᴜᴍʙᴇʀ ɴᴏᴛ ғᴏᴜɴᴅ ᴏɴ ᴡʜᴀᴛsᴀᴘᴘ.\n\n` +
            `📱 +${input}`
        },
        {
          quoted: message
        }
      )
    }

    if (waData?.jid) {
      targetJid =
        waData.jid
    }

    /*
     * =================================
     * NAME
     * =================================
     */

    let profileName =
      cleanText(
        waData?.name ||
        waData?.notify
      )

    /*
     * Cached contact name
     */

    if (!profileName) {
      profileName =
        getCachedName(
          sock,
          targetJid
        )
    }

    /*
     * Group member name
     */

    if (!profileName) {
      profileName =
        await getGroupMemberName(
          sock,
          chatJid,
          targetJid
        )
    }

    /*
     * =================================
     * ABOUT
     * =================================
     */

    let about = ''

    try {
      if (
        typeof sock.fetchStatus ===
        'function'
      ) {
        const status =
          await sock.fetchStatus(
            targetJid
          )

        about =
          cleanText(
            status?.status ||
            status?.text
          )
      }
    } catch (error) {
      console.log(
        '[WHOIS ABOUT]',
        error?.message || error
      )
    }

    /*
     * =================================
     * PROFILE PICTURE
     * =================================
     */

    let picture = null

    try {
      picture =
        await sock.profilePictureUrl(
          targetJid,
          'image'
        )
    } catch {
      picture = null
    }

    /*
     * =================================
     * BUSINESS PROFILE
     * =================================
     */

    let business = null

    try {
      if (
        typeof sock.getBusinessProfile ===
        'function'
      ) {
        business =
          await sock.getBusinessProfile(
            targetJid
          )
      }
    } catch {
      business = null
    }

    const isBusiness =
      !!business

    const businessName =
      cleanText(
        business?.businessName ||
        business?.name
      )

    const description =
      cleanText(
        business?.description
      )

    const categories =
      Array.isArray(
        business?.categories
      )
        ? business.categories
            .map(
              category =>
                cleanText(
                  category?.name ||
                  category
                )
            )
            .filter(Boolean)
            .join(', ')
        : ''

    const website =
      Array.isArray(
        business?.website
      )
        ? business.website
            .filter(Boolean)
            .join('\n')
        : cleanText(
            business?.website
          )

    /*
     * =================================
     * RESULT
     * =================================
     */

    let info =
      `╭━━━〔 ᴡʜᴏɪs 〕━━━┈⊷\n` +
      `│\n` +
      `│ 📱 ɴᴜᴍʙᴇʀ: +${input}\n` +
      `│ 🟢 ᴡʜᴀᴛsᴀᴘᴘ: ʏᴇs\n`

    if (profileName) {
      info +=
        `│ 👤 ɴᴀᴍᴇ: ${profileName}\n`
    }

    if (about) {
      info +=
        `│ 💬 ᴀʙᴏᴜᴛ: ${about}\n`
    }

    info +=
      `│ 🏢 ᴀᴄᴄᴏᴜɴᴛ: ${
        isBusiness
          ? 'ʙᴜsɪɴᴇss'
          : 'ᴘᴇʀsᴏɴᴀʟ'
      }\n`

    if (isBusiness) {
      if (businessName) {
        info +=
          `│ 🏷️ ʙᴜsɪɴᴇss: ${businessName}\n`
      }

      if (description) {
        info +=
          `│ 📝 ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ${description}\n`
      }

      if (categories) {
        info +=
          `│ 📂 ᴄᴀᴛᴇɢᴏʀʏ: ${categories}\n`
      }

      if (website) {
        info +=
          `│ 🌐 ᴡᴇʙsɪᴛᴇ: ${website}\n`
      }
    }

    info +=
      `│\n` +
      `╰━━━━━━━━━━━━━━━━━━━┈⊷`

    /*
     * =================================
     * SEND
     * =================================
     */

    if (picture) {
      try {
        return await sock.sendMessage(
          chatJid,
          {
            image: {
              url: picture
            },
            caption: info
          },
          {
            quoted: message
          }
        )
      } catch (error) {
        console.error(
          '[WHOIS DP]',
          error?.message || error
        )
      }
    }

    return await sock.sendMessage(
      chatJid,
      {
        text: info
      },
      {
        quoted: message
      }
    )
  }
}