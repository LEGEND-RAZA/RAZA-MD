export default {
command: ['tg'],
category: 'sticker',
description: 'Download Telegram sticker packs without a token',

async run({ sock, message, args }) {
const jid = message?.key?.remoteJid;
if (!jid) return;

const send = async (text) =>
  sock.sendMessage(jid, { text }, { quoted: message });

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

try {
  const input = args?.join(' ').trim() || '';

  if (!input) {
    return send(
      '❌ Please provide a Telegram sticker link.\n\n' +
      'Example:\n.tg https://t.me/addstickers/RealforEverything'
    );
  }

  let packName;

  try {
    const url = new URL(
      input.startsWith('http') ? input : `https://${input}`
    );

    if (!['t.me', 'telegram.me', 'www.t.me'].includes(url.hostname)) {
      throw new Error('Invalid host');
    }

    const match = url.pathname.match(
      /^\/addstickers\/([a-zA-Z0-9_]+)\/?$/
    );

    if (!match) throw new Error('Invalid pack link');

    packName = match[1];
  } catch {
    return send(
      '❌ Invalid Telegram sticker link.\n\n' +
      'Example:\n.tg https://t.me/addstickers/RealforEverything'
    );
  }

  await send('🔎 Fetching Telegram sticker pack...');

  // Public third-party API; no personal Telegram token required.
  const apiUrl =
    `https://stickers.horner.tj/pack/${encodeURIComponent(packName)}`;

  const response = await fetch(apiUrl, {
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(
      `Public sticker service returned HTTP ${response.status}`
    );
  }

  const data = await response.json();

  const stickers = Array.isArray(data)
    ? data
    : data.stickers || data.pack?.stickers || [];

  if (!stickers.length) {
    return send(
      '❌ No stickers found. The pack may be unavailable, ' +
      'or the public service response may have changed.'
    );
  }

  await send(
    `📦 Pack: ${data.title || packName}\n` +
    `🎭 Stickers: ${stickers.length}\n` +
    '⬇️ Downloading...'
  );

  let sent = 0;
  let failed = 0;

  for (const item of stickers) {
    try {
      const stickerUrl =
        typeof item === 'string'
          ? item
          : item.url || item.image || item.src;

      if (!stickerUrl) {
        failed++;
        continue;
      }

      const fileResponse = await fetch(stickerUrl, {
        signal: AbortSignal.timeout(30000)
      });

      if (!fileResponse.ok) {
        throw new Error('Sticker download failed');
      }

      const buffer = Buffer.from(
        await fileResponse.arrayBuffer()
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
      console.error('[TG STICKER]', error?.message || error);
    }

    await sleep(700);
  }

  return send(
    `✅ Download finished\n\n` +
    `📦 Pack: ${packName}\n` +
    `✅ Sent: ${sent}\n` +
    `❌ Failed: ${failed}`
  );
} catch (error) {
  console.error('[TG PLUGIN]', error?.message || error);

  return send(
    '❌ Could not download this sticker pack without a token.\n\n' +
    'The public sticker service may be unavailable. ' +
    'Try again later or use a different supported service.'
  );
}

}
};
