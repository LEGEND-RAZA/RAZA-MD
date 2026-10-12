export default {
command: ['tg'],
category: 'sticker',
description: 'Download Telegram sticker packs',

async run({ sock, message, args }) {
const jid = message?.key?.remoteJid;
if (!jid) return;

const send = async (text) =>
  sock.sendMessage(
    jid,
    { text },
    { quoted: message }
  );

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

try {
  const input = args?.join(' ').trim() || '';

  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!input) {
    return send(
      '❌ Provide a Telegram sticker-pack link.\n\n' +
      'Example:\n.tg https://t.me/addstickers/PackName'
    );
  }

  if (!token) {
    return send(
      '❌ TELEGRAM_BOT_TOKEN is missing from config.env.'
    );
  }

  let packName;

  try {
    const url = new URL(
      input.startsWith('http') ? input : `https://${input}`
    );

    if (
      !['t.me', 'telegram.me', 'www.t.me', 'www.telegram.me']
        .includes(url.hostname)
    ) {
      throw new Error('Invalid Telegram link');
    }

    const match = url.pathname.match(/^\/addstickers\/([a-zA-Z0-9_]+)\/?$/);

    if (!match) {
      throw new Error('Invalid sticker-pack link');
    }

    packName = match[1];
  } catch {
    return send(
      '❌ Invalid sticker-pack link.\n\n' +
      'Example:\n.tg https://t.me/addstickers/PackName'
    );
  }

  const api = `https://api.telegram.org/bot${token}`;

  const apiCall = async (method, params = {}) => {
    const response = await fetch(
      `${api}/${method}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(30000)
      }
    );

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(
        data.description || `Telegram API error: ${method}`
      );
    }

    return data.result;
  };

  const pack = await apiCall('getStickerSet', {
    name: packName
  });

  const stickers = pack.stickers || [];

  if (!stickers.length) {
    return send('❌ This sticker pack is empty.');
  }

  await send(
    `📦 *${pack.title}*\n` +
    `🎭 Stickers: ${stickers.length}\n\n` +
    '⬇️ Starting download...'
  );

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of stickers) {
    try {
      // Telegram TGS animations and WEBM video stickers
      // need conversion before they can be sent as WhatsApp stickers.
      if (item.is_animated || item.is_video) {
        skipped++;
        continue;
      }

      const file = await apiCall('getFile', {
        file_id: item.file_id
      });

      if (!file.file_path) {
        throw new Error('Telegram did not return a file path');
      }

      if (!file.file_path.toLowerCase().endsWith('.webp')) {
        skipped++;
        continue;
      }

      const downloadUrl =
        `https://api.telegram.org/file/bot${token}/${file.file_path}`;

      const response = await fetch(downloadUrl, {
        signal: AbortSignal.timeout(30000)
      });

      if (!response.ok) {
        throw new Error('Sticker download failed');
      }

      const buffer = Buffer.from(
        await response.arrayBuffer()
      );

      if (!buffer.length || buffer.length > 1024 * 1024) {
        throw new Error('Sticker file is empty or too large');
      }

      await sock.sendMessage(
        jid,
        { sticker: buffer },
        { quoted: message }
      );

      sent++;
    } catch (error) {
      failed++;
      console.error(
        '[TG STICKER]',
        error?.message || error
      );
    }

    await sleep(700);
  }

  return send(
    `✅ *Telegram Sticker Pack Finished*\n\n` +
    `📦 Pack: ${pack.title}\n` +
    `✅ Sent: ${sent}\n` +
    `⏭️ Skipped: ${skipped}\n` +
    `❌ Failed: ${failed}`
  );
} catch (error) {
  console.error('[TG PLUGIN]', error);

  return send(
    '❌ Failed to download the sticker pack.\n\n' +
    'Check the Telegram link, bot token, and network connection.'
  );
}

}
};
