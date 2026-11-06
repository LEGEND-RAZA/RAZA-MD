/**
 * .setcmd — Bind a bot command to a sticker or emoji.
 * Reply to a sticker/emoji with .setcmd <command>
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// Path to store the bindings
const DB_DIR = path.join(process.cwd(), 'database')
const DB_FILE = path.join(DB_DIR, 'sticker_cmds.json')

// Helper to load/save database
function loadDb() {
    try {
        if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })
        if (!fs.existsSync(DB_FILE)) return { stickers: {}, emojis: {} }
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
    } catch {
        return { stickers: {}, emojis: {} }
    }
}

function saveDb(db) {
    try {
        if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2))
    } catch (e) {
        console.error('[SetCmd] Failed to save DB:', e.message)
    }
}

// Helper to get sticker hash
function getStickerHash(stickerMsg) {
    if (!stickerMsg) return null
    if (stickerMsg.fileSha256) {
        return Buffer.from(stickerMsg.fileSha256).toString('hex')
    }
    // Fallback if fileSha256 isn't present
    const url = stickerMsg.url || ''
    return crypto.createHash('sha256').update(url).digest('hex')
}

// Helper to check if a string is strictly emojis
function isEmojiOnly(text) {
    if (!text) return false
    const clean = text.replace(/\s/g, '')
    // Regex for common emojis
    const emojiRegex = /^(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])+$/
    return emojiOnlyRegex.test(clean)
}

export default {
    command: ['setcmd', 'stickercmd', 'bindcmd'],
    category: 'owner',
    description: 'Bind a bot command to a sticker or emoji',

    async run(ctx) {
        const { sock, message } = ctx
        const msg = message || ctx.msg
        if (!sock || !msg) return

        const jid = msg.key?.remoteJid
        if (!jid) return

        const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg })
        const react = (emoji) => sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(() => {})
        const prefix = ctx.prefix || '.'

        const commandName = String(ctx.text || '').trim().split(/\s+/)[0].toLowerCase()

        if (!commandName) {
            return reply(
                `📌 *sᴇᴛ sᴛɪᴄᴋᴇʀ/ᴇᴍᴏᴊɪ ᴄᴏᴍᴍᴀɴᴅ*\n\n` +
                `ʀᴇᴘʟʏ ᴛᴏ ᴀ sᴛɪᴄᴋᴇʀ ᴏʀ ᴇᴍᴏᴊɪ, ᴛʜᴇɴ ᴛʏᴘᴇ:\n` +
                `*${prefix}${ctx.command} <ᴄᴏᴍᴍᴀɴᴅ>*\n\n` +
                `_ᴇxᴀᴍᴘʟᴇ:_ *${prefix}${ctx.command} ᴘɪɴɢ*`
            )
        }

        // Ensure they are replying to a message
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo
        if (!contextInfo || !contextInfo.quotedMessage) {
            return reply(`❌ ᴘʟᴇᴀsᴇ *ʀᴇᴘʟʏ ᴛᴏ ᴀ sᴛɪᴄᴋᴇʀ ᴏʀ ᴇᴍᴏᴊɪ* ᴡɪᴛʜ ${prefix}${ctx.command} <ᴄᴏᴍᴍᴀɴᴅ>`)
        }

        let stickerHash = null
        let emojiKey = null

        // 1. Check inline quoted sticker
        const quotedSticker = contextInfo.quotedMessage?.stickerMessage
        if (quotedSticker) {
            stickerHash = getStickerHash(quotedSticker)
        } else {
            // 2. Check if quoted text is an emoji
            const quotedText = contextInfo.quotedMessage?.conversation || 
                               contextInfo.quotedMessage?.extendedTextMessage?.text || ''
            
            if (isEmojiOnly(quotedText)) {
                emojiKey = quotedText.trim()
            }
        }

        if (!stickerHash && !emojiKey) {
            return reply(`❌ ʀᴇᴘʟʏ ᴛᴏ ᴀ sᴛɪᴄᴋᴇʀ ᴏʀ ᴇᴍᴏᴊɪ.`)
        }

        // Save to DB
        const db = loadDb()
        let isUpdate = false

        if (stickerHash) {
            isUpdate = !!db.stickers[stickerHash]
            db.stickers[stickerHash] = commandName
            saveDb(db)
            await react(isUpdate ? '✏️' : '✅')
            return reply(
                `${isUpdate ? '✏️ *ᴜᴘᴅᴀᴛᴇᴅ!*' : '✅ *sᴇᴛ!'*}\n\n` +
                `sᴛɪᴄᴋᴇʀ ɴᴏᴡ ᴛʀɪɢɢᴇʀs: *.${commandName}*`
            )
        } 
        
        if (emojiKey) {
            isUpdate = !!db.emojis[emojiKey]
            db.emojis[emojiKey] = commandName
            saveDb(db)
            await react(isUpdate ? '✏️' : '✅')
            return reply(
                `${isUpdate ? '✏️ *ᴜᴘᴅᴀᴛᴇᴅ!*' : '✅ *sᴇᴛ!'*}\n\n` +
                `ᴇᴍᴏᴊɪ (${emojiKey}) ɴᴏᴡ ᴛʀɪɢɢᴇʀs: *.${commandName}*`
            )
        }
    }
}
