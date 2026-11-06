/**
 * .info / .botinfo — Display bot information and website link
 */

export default {
    command: ['info', 'sc', 'repo'],
    category: 'general',
    description: 'Get bot info and website',

    async run(ctx) {
        const { sock, message } = ctx
        const msg = message || ctx.msg
        if (!sock || !msg) return

        const jid = msg.key?.remoteJid
        if (!jid) return

        const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg })
        const react = (emoji) => sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(() => {})

        await react('🤖')

        const infoText = 
            `╭─────────────────────╮\n` +
            `│   🤖 *ʀᴀᴢᴀ ᴍᴅ ʙᴏᴛ*   │\n` +
            `╰─────────────────────╯\n\n` +
            `👑 *ᴏᴡɴᴇʀ:* ʟᴇɢᴇɴᴅ ʀᴀᴢᴀ\n` +
            `🚀 *ᴠᴇʀsɪᴏɴ:* ᴠ1.0.0\n` +
            `🌐 *ᴡᴇʙsɪᴛᴇ:* https://legendxraza.cv\n\n` +
            `📝 *ᴀʙᴏᴜᴛ:*\n` +
            `ʀᴀᴢᴀ ᴍᴅ ɪs ᴀ ғᴀsᴛ, ʀᴇʟɪᴀʙʟᴇ, ᴀɴᴅ ғᴇᴀᴛᴜʀᴇ-ʀɪᴄʜ ᴡʜᴀᴛsᴀᴘᴘ ʙᴏᴛ ʙᴜɪʟᴛ ᴡɪᴛʜ ᴀ sɪʟᴇɴᴛ ᴀᴜᴛᴏ-ᴅᴇᴘʟᴏʏ sʏsᴛᴇᴍ ᴀɴᴅ ᴘᴀɪʀɪɴɢ ᴄᴏᴅᴇ ʟᴏɢɪɴ.\n\n` +
            `> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ʀᴀᴢᴀ ᴍᴅ`

        try {
            // Send with a copy button for the website
            await sock.sendMessage(jid, {
                text: infoText,
                footer: '🌐 ᴄʟɪᴄᴋ ᴛᴏ ᴄᴏᴘʏ ᴡᴇʙsɪᴛᴇ',
                templateButtons: [
                    { index: 1, copy: 'https://legendxraza.cv' }
                ]
            }, { quoted: msg })
        } catch (err) {
            // Fallback if buttons are not supported
            await reply(infoText)
        }
    }
}
