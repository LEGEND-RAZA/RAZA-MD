import { downloadContentFromMessage } from '@whiskeysockets/baileys'

const DOWNLOAD_TIMEOUT_MS = 45_000
const DEFAULT_PACK_NAME = 'ʀᴀᴢᴀ ᴍᴅ'
const DEFAULT_PACK_AUTHOR = 'ʟᴇɢᴇɴᴅ ʀᴀᴢᴀ'

function unwrapMessage(message) {
    let current = message
    for (let i = 0; i < 6 && current; i += 1) {
        const wrapped = current.viewOnceMessage?.message
            || current.viewOnceMessageV2?.message
            || current.viewOnceMessageV2Extension?.message
            || current.ephemeralMessage?.message
        if (!wrapped) break
        current = wrapped
    }
    return current || message
}

function getQuotedSticker(msg) {
    const message = msg?.message || {}
    const context = message.extendedTextMessage?.contextInfo
        || message.imageMessage?.contextInfo
        || message.videoMessage?.contextInfo
        || message.stickerMessage?.contextInfo
        || message.ephemeralMessage?.message?.extendedTextMessage?.contextInfo
        || null
    const quoted = unwrapMessage(context?.quotedMessage || null)
    return quoted?.stickerMessage
}

async function downloadSticker(stickerMessage) {
    const timer = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    const stream = await downloadContentFromMessage(stickerMessage, 'sticker', { signal: timer })
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    const buffer = Buffer.concat(chunks)
    if (!buffer.length) throw new Error('downloaded sticker is empty')
    return buffer
}

export default {
    command: ['take', 'takesticker'],
    category: 'general',
    description: 'Take a replied sticker and rebrand it with a custom pack name',

    async run(ctx) {
        const { sock, message } = ctx
        const msg = message || ctx.msg
        if (!sock || !msg) return

        const jid = msg.key?.remoteJid
        if (!jid) return

        const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg })
        const react = (emoji) => sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(() => {})
        const prefix = ctx.prefix || '.'

        // Get the custom pack name from the command (e.g. .take My Pack)
        const customName = String(ctx.text || '').trim()
        const finalPackName = customName || DEFAULT_PACK_NAME
        const finalAuthor = DEFAULT_PACK_AUTHOR

        const sticker = getQuotedSticker(msg)
        
        if (!sticker) {
            return reply(
                `🎨 *ᴛᴀᴋᴇ sᴛɪᴄᴋᴇʀ*\n\n` +
                `ʀᴇᴘʟʏ ᴛᴏ ᴀ sᴛɪᴄᴋᴇʀ ᴡɪᴛʜ:\n` +
                `• *${prefix}${ctx.command}* (ᴜsᴇs ᴅᴇꜰᴀᴜʟᴛ ɴᴀᴍᴇ)\n` +
                `• *${prefix}${ctx.command} <ᴄᴜsᴛᴏᴍ ɴᴀᴍᴇ>*\n\n` +
                `_ᴇxᴀᴍᴘʟᴇ:_ *${prefix}${ctx.command} ᴍʏ ᴀᴡᴇsᴏᴍᴇ ᴘᴀᴄᴋ*`
            )
        }

        try {
            await react('⏳')
            
            // Download the original sticker
            const buffer = await downloadSticker(sticker)
            
            // Send it back with the new metadata
            await sock.sendMessage(jid, {
                sticker: buffer,
                packname: finalPackName,
                author: finalAuthor
            }, { quoted: msg })
            
            await react('✅')
            
        } catch (error) {
            await react('❌')
            return reply(`❌ ꜰᴀɪʟᴇᴅ ᴛᴏ ᴛᴀᴋᴇ sᴛɪᴄᴋᴇʀ: ${error.message || 'ɪɴᴠᴀʟɪᴅ sᴛɪᴄᴋᴇʀ ᴅᴀᴛᴀ'}`)
        }
    }
}
