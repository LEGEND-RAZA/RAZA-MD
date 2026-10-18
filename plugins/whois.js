
import { jidNormalizedUser } from '@whiskeysockets/baileys'

function cleanText(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function getNumber(jid) {
  return String(jid || '')
    .split('@')[0]
    .split(':')[0]
    .replace(/\D/g, '')
}

function isLid(jid) {
  return String(jid || '').endsWith('@lid')
}

function getContext(message) {
  let content = message?.message

  for (let i = 0; content && i < 8; i++) {
    const nested =
      content.ephemeralMessage?.message ||
      content.viewOnceMessage?.message ||
      content.viewOnceMessageV2?.message ||
      content.documentWithCaptionMessage?.message

    if (!nested) break
    content = nested
  }

  return (
    content?.extendedTextMessage?.contextInfo ||
    content?.imageMessage?.contextInfo ||
    content?.videoMessage?.contextInfo ||
    content?.documentMessage?.contextInfo ||
    content?.audioMessage?.contextInfo ||
    content?.stickerMessage?.contextInfo ||
    content?.buttonsResponseMessage?.contextInfo ||
    content?.templateButtonReplyMessage?.contextInfo ||
    content?.listResponseMessage?.contextInfo ||
    {}
  )
}

function getMentionedJid(message) {
  return getContext(message)?.mentionedJid?.[0] || ''
}

function getQuotedJid(message) {
  return (
    getContext(message)?.participant ||
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
    const mapping = sock?.signalRepository?.lidMapping

    if (typeof mapping?.getPNForLID === 'function') {
      const pn = await mapping.getPNForLID(jid)
      if (pn) return jidNormalizedUser(pn)
    }
  } catch (error) {
    console.error('[WHOIS LID]', error?.message || error)
  }

  return jid
}

function getCachedName(sock, jid) {
  try {
    const contacts = sock?.contacts
    if (!contacts) return ''

    const normalized = jidNormalizedUser(jid)
    const contact = contacts[jid] || contacts[normalized]

    return cleanText(
      contact?.name ||
      contact?.notify ||
      contact?.verifiedName
    )
  } catch {
    return ''
  }
}

async function getGroupMemberName(sock, chatJid, targetJid) {
  if (!chatJid?.endsWith('@g.us')) return ''

  try {
    const metadata = await sock.groupMetadata(chatJid)
    const normalized = jidNormalizedUser(targetJid)

    const participant = metadata?.participants?.find(p =>
      p?.id === normalized ||
      p?.jid === normalized ||
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

/**
 * Extract About text from common Baileys response shapes.
 */
function extractAbout(result) {
  if (!result) return ''

  if (typeof result === 'string') {
    return cleanText(result)
  }

  if (Array.isArray(result)) {
    for (const item of result) {
      const found = extractAbout(item)
      if (found) return found
    }
    return ''
  }

  if (typeof result !== 'object') return ''

  const candidates = [
    result.status,
    result.about,
    result.text,
    result.description,
    result.bio,
    result.profile?.status,
    result.profile?.about,
    result.data?.status,
    result.data?.about,
    result.data?.text
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return cleanText(candidate)
    }

    if (candidate && typeof candidate === 'object') {
      const nested = extractAbout(candidate)
      if (nested) return nested
    }
  }

  return ''
}

/**
 * Try available JID formats. Stop when a non-empty About is found.
 */
async function fetchAbout(sock, targetJid, originalJid = '') {
  if (typeof sock?.fetchStatus !== 'function') {
    console.warn('[WHOIS ABOUT] sock.fetchStatus is unavailable')
    return ''
  }

  const candidates = [
    targetJid,
    jidNormalizedUser(targetJid),
    originalJid,
    originalJid ? jidNormalizedUser(originalJid) : ''
  ].filter((jid, index, all) => jid && all.indexOf(jid) === index)

  for (const jid of candidates) {
    try {
      const result = await sock.fetchStatus(jid)
      const about = extractAbout(result)

      // Do not log the actual private About text.
      console.log('[WHOIS ABOUT DEBUG]', {
        jid,
        responseType: Array.isArray(result)
          ? 'array'
          : typeof result,
        responseKeys:
          result && typeof result === 'object' && !Array.isArray(result)
            ? Object.keys(result)
            : [],
        found: Boolean(about)
      })

      if (about) return about
    } catch (error) {
      console.error('[WHOIS ABOUT ERROR]', {
        jid,
        message: error?.message || String(error)
      })
    }
  }

  return ''
}

function formatWebsite(website) {
  if (Array.isArray(website)) {
    return website
      .map(item => cleanText(item?.url || item))
      .filter(Boolean)
      .join('\n')
  }

  return cleanText(website)
}

export default {
  command: 'whois',
  category: 'tools',
  description: 'Get available WhatsApp profile information',

  async run({ sock, message, args = [] }) {
    const chatJid = message?.key?.remoteJid
    if (!chatJid) return

    let targetJid = ''
    let originalJid = ''

    // 1. Check mentioned user.
    const mentionedJid = getMentionedJid(message)

    if (mentionedJid) {
      originalJid = mentionedJid
      targetJid = await resolveLid(sock, mentionedJid)
    }

    // 2. Check quoted/replied-to user.
    if (!targetJid) {
      const quotedJid = getQuotedJid(message)

      if (quotedJid) {
        originalJid = quotedJid
        targetJid = await resolveLid(sock, quotedJid)
      }
    }

    // 3. Check a supplied phone number.
    if (!targetJid) {
      const number = args.join('').replace(/\D/g, '')

      if (number.length >= 7) {
        originalJid = `${number}@s.whatsapp.net`
        targetJid = jidNormalizedUser(originalJid)
      }
    }

    if (!targetJid) {
      return sock.sendMessage(
        chatJid,
        {
          text:
            '╭─❒ ᴡʜᴏɪs ❒\n' +
            '│\n' +
            '│ .whois 923xxxxxxxxx\n' +
            '│ .whois @member\n' +
            '│ Reply to a message with .whois\n' +
            '│\n' +
            '╰────────────'
        },
        { quoted: message }
      )
    }

    if (isLid(targetJid)) {
      return sock.sendMessage(
        chatJid,
        {
          text:
            '❌ ᴄᴏᴜʟᴅ ɴᴏᴛ ʀᴇsᴏʟᴠᴇ ᴛʜᴇ ᴜsᴇʀ ᴛᴏ ᴀ ᴘʜᴏɴᴇ ɴᴜᴍʙᴇʀ\n\n' +
            'ᴛʀʏ ᴜsɪɴɢ ᴛʜᴇɪʀ ᴘʜᴏɴᴇ ɴᴜᴍʙᴇʀ'
        },
        { quoted: message }
      )
    }

    let waData = null

    try {
      const result = await sock.onWhatsApp(targetJid)
      waData = Array.isArray(result) ? result[0] : result
    } catch (error) {
      console.error('[WHOIS CHECK]', error?.message || error)
    }

    if (waData?.exists === false) {
      return sock.sendMessage(
        chatJid,
        {
          text:
            '❌ ɴᴜᴍʙᴇʀ ɴᴏᴛ ғᴏᴜɴᴅ ᴏɴ ᴡʜᴀᴛsᴀᴘᴘ\n\n' +
            `📱 +${getNumber(targetJid)}`
        },
        { quoted: message }
      )
    }

    if (waData?.jid) {
      targetJid = jidNormalizedUser(waData.jid)
    }

    // Always derive the displayed number from the final resolved JID.
    const number = getNumber(targetJid)

    let profileName = cleanText(
      waData?.name || waData?.notify
    )

    if (!profileName) {
      profileName = getCachedName(sock, targetJid)
    }

    if (!profileName) {
      profileName = await getGroupMemberName(
        sock,
        chatJid,
        targetJid
      )
    }

    // Retrieve About after resolving the final JID.
    const about = await fetchAbout(
      sock,
      targetJid,
      originalJid
    )

    let picture = null

    try {
      picture = await sock.profilePictureUrl(targetJid, 'image')
    } catch {
      picture = null
    }

    let business = null

    try {
      if (typeof sock.getBusinessProfile === 'function') {
        business = await sock.getBusinessProfile(targetJid)
      }
    } catch (error) {
      console.log('[WHOIS BUSINESS]', error?.message || error)
    }

    const isBusiness = Boolean(business)

    const businessName = cleanText(
      business?.businessName || business?.name
    )

    const description = cleanText(business?.description)

    const categories = Array.isArray(business?.categories)
      ? business.categories
          .map(category => cleanText(category?.name || category))
          .filter(Boolean)
          .join(', ')
      : ''

    const website = formatWebsite(business?.website)

    let info =
      '╭━━━〔 ᴡʜᴏɪs 〕━━━┈⊷\n' +
      '│\n' +
      `│ 📱 ɴᴜᴍʙᴇʀ: +${number || 'ᴜɴᴀᴠᴀɪʟᴀʙʟᴇ'}\n` +
      `│ 🟢 ᴡʜᴀᴛsᴀᴘᴘ: ${waData?.exists === false ? 'ɴᴏ' : 'ʏᴇs'}\n`

    if (profileName) {
      info += `│ 👤 ɴᴀᴍᴇ: ${profileName}\n`
    }

    // Always show the About field, even when unavailable.
    info += `│ 💬 ᴀʙᴏᴜᴛ: ${about || 'ɴᴏᴛ ᴀᴠᴀɪʟᴀʙʟᴇ'}\n`

    info += `│ 🏢 ᴀᴄᴄᴏᴜɴᴛ: ${isBusiness ? 'ʙᴜsɪɴᴇss' : 'ᴘᴇʀsᴏɴᴀʟ'}\n`

    if (isBusiness) {
      if (businessName) {
        info += `│ 🏷️ ʙᴜsɪɴᴇss: ${businessName}\n`
      }

      if (description) {
        info += `│ 📝 ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ${description}\n`
      }

      if (categories) {
        info += `│ 📂 ᴄᴀᴛᴇɢᴏʀʏ: ${categories}\n`
      }

      if (website) {
        info += `│ 🌐 ᴡᴇʙsɪᴛᴇ: ${website}\n`
      }
    }

    info += '│\n╰━━━━━━━━━━━━━━━━━━━┈⊷'

    if (picture) {
      try {
        return await sock.sendMessage(
          chatJid,
          {
            image: { url: picture },
            caption: info
          },
          { quoted: message }
        )
      } catch (error) {
        console.error('[WHOIS DP]', error?.message || error)
      }
    }

    return sock.sendMessage(
      chatJid,
      { text: info },
      { quoted: message }
    )
  }
}
