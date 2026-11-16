// Telegram notification helper
const https = require('https');
const crypto = require('crypto');
const config = require('./config');

function sendTelegramMessage(html, toChatId) {
  const token = process.env.TELEGRAM_BOT_TOKEN || config.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || config.TELEGRAM_CHAT_ID;
  const target = toChatId || chatId;
  if (!token || token.startsWith('BURAYA') || !target || String(target).startsWith('BURAYA')) {
    console.warn('[telegram] Token/chat ID konfiqurasiya edilməyib — mesaj göndərilmədi.');
    return Promise.resolve(false);
  }
  const payload = JSON.stringify({
    chat_id: target,
    text: html,
    parse_mode: 'HTML'
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 10000
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(true);
        else {
          console.error('[telegram] Göndərilmədi:', res.statusCode, body.slice(0, 200));
          resolve(false);
        }
      });
    });
    req.on('error', (e) => { console.error('[telegram] Xəta:', e.message); resolve(false); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(payload);
    req.end();
  });
}

function sendTelegramPhoto(photo, filename, mimeType, caption, toChatId, replyMarkup) {
  const token = process.env.TELEGRAM_BOT_TOKEN || config.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || config.TELEGRAM_CHAT_ID;
  const target = toChatId || chatId;
  if (!token || token.startsWith('BURAYA') || !target || String(target).startsWith('BURAYA')) {
    console.warn('[telegram] Token/chat ID konfiqurasiya edilməyib — şəkil göndərilmədi.');
    return Promise.resolve(false);
  }

  const boundary = '----NexoraReceipt' + crypto.randomBytes(12).toString('hex');
  const fields = [
    ['chat_id', String(target)],
    ['caption', caption || 'Ödəniş qəbzi']
  ];
  if (replyMarkup) fields.push(['reply_markup', JSON.stringify(replyMarkup)]);
  const parts = fields.map(([name, value]) => Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  ));
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  ));
  parts.push(photo, Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendPhoto`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      },
      timeout: 15000
    }, (res) => {
      let response = '';
      res.on('data', (chunk) => response += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(response);
          if (res.statusCode === 200 && result.ok === true) resolve(true);
          else {
            console.error('[telegram] Şəkil göndərilmədi:', res.statusCode, response.slice(0, 200));
            resolve(false);
          }
        } catch (e) {
          console.error('[telegram] Şəkil cavabı oxunmadı:', res.statusCode, response.slice(0, 200));
          resolve(false);
        }
      });
    });
    req.on('error', (error) => { console.error('[telegram] Şəkil göndərilmədi:', error.message); resolve(false); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

function answerTelegramCallback(callbackQueryId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN || config.TELEGRAM_BOT_TOKEN;
  if (!token || !callbackQueryId) return Promise.resolve(false);
  const payload = JSON.stringify({ callback_query_id: callbackQueryId, text: text || '' });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/answerCallbackQuery`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 10000
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(true);
        else {
          console.error('[telegram] Düymə cavablandırılmadı:', res.statusCode, body.slice(0, 200));
          resolve(false);
        }
      });
    });
    req.on('error', (error) => {
      console.error('[telegram] Düymə cavabı xətası:', error.message);
      resolve(false);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(payload);
    req.end();
  });
}

// ============================================================
// Bot polling: listens for user codes so they can connect
// their own Telegram account from the dashboard.
// ============================================================
let lastUpdateId = 0;
const CARD_DETAILS_PROMPT = 'Zəhmət olmasa yeni kart nömrəsini və bankın adını göndərin (Məsələn: 4169 7388 0000 1111, Kapital Bank)';

function parseCardDetails(text) {
  const separator = text.indexOf(',');
  if (separator < 0) return null;

  const cardNumber = text.slice(0, separator).trim().replace(/[ -]/g, '');
  const bankName = text.slice(separator + 1).trim();
  if (!/^\d{13,19}$/.test(cardNumber) || !bankName || bankName.length > 100 || /[\r\n]/.test(bankName)) {
    return null;
  }
  return { cardNumber, bankName };
}

async function getUpdates(signal) {
  const token = process.env.TELEGRAM_BOT_TOKEN || config.TELEGRAM_BOT_TOKEN;
  if (!token || (signal && signal.aborted)) return null;
  return new Promise((resolve) => {
    let settled = false;
    let requestTimedOut = false;
    const finish = function (updates) {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', abort);
      resolve(updates);
    };
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=25`,
      method: 'GET',
      timeout: 30000
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(body);
          if (d.ok && Array.isArray(d.result)) {
            d.result.forEach((u) => { lastUpdateId = Math.max(lastUpdateId, u.update_id); });
            finish(d.result);
          } else {
            console.error('[telegram] Update polling rejected:', d.description || res.statusCode);
            finish(null);
          }
        } catch (error) {
          console.error('[telegram] Update response could not be parsed:', error.message);
          finish(null);
        }
      });
    });
    const abort = function () { req.destroy(); };
    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        finish([]);
        req.destroy();
        return;
      }
    }
    req.on('error', (error) => {
      if (!requestTimedOut && !(signal && signal.aborted)) {
        console.error('[telegram] Update polling failed:', error.message);
      }
      finish(null);
    });
    req.on('timeout', () => {
      requestTimedOut = true;
      if (!(signal && signal.aborted)) console.error('[telegram] Update polling timed out.');
      req.destroy();
    });
    req.end();
  });
}

function waitForPollingDelay(delay, signal) {
  return new Promise((resolve) => {
    let timer;
    const finish = function () {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, delay);
    if (signal) {
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    }
  });
}

async function pollForCodes(onCode, onPaymentCommand, onCardUpdate, signal) {
  const token = process.env.TELEGRAM_BOT_TOKEN || config.TELEGRAM_BOT_TOKEN;
  if (!token || token.startsWith('BURAYA')) return;
  let pendingCardUpdate = null;
  let retryDelay = 500;
  while (!signal || !signal.aborted) {
    try {
      const updates = await getUpdates(signal);
      if (signal && signal.aborted) break;
      if (updates === null) {
        await waitForPollingDelay(retryDelay, signal);
        retryDelay = Math.min(retryDelay * 2, 30000);
        continue;
      }
      retryDelay = 500;
      for (const u of updates) {
        const callback = u.callback_query;
        if (callback) {
          const chatId = String(callback.message && callback.message.chat && callback.message.chat.id || '');
          const senderId = String(callback.from && callback.from.id || '');
          const adminUserId = String(config.TELEGRAM_ADMIN_USER_ID || '');
          const command = /^payment:(approve|reject):(PAY-[A-F0-9]{10})$/i.exec(callback.data || '');
          if (!chatId || !adminUserId || senderId !== adminUserId ||
              chatId !== String(config.TELEGRAM_CHAT_ID || '')) {
            await answerTelegramCallback(callback.id, 'Bu əməliyyata icazəniz yoxdur.');
            if (chatId) sendTelegramMessage('Bu əmri yerinə yetirmək icazəniz yoxdur.', chatId);
            continue;
          }
          if (!command || !onPaymentCommand) {
            await answerTelegramCallback(callback.id, 'Düymə əmri tanınmadı.');
            continue;
          }
          onPaymentCommand(command[1].toLowerCase(), command[2].toUpperCase(), chatId, senderId);
          await answerTelegramCallback(callback.id, 'Sorğu emal olunur.');
          continue;
        }
        const msg = u.message;
        if (!msg || !msg.text) continue;
        const chatId = String(msg.chat.id);
        const senderId = String(msg.from && msg.from.id || '');
        const text = msg.text.trim();
        const adminUserId = String(config.TELEGRAM_ADMIN_USER_ID || '');
        if (!adminUserId || senderId !== adminUserId) {
          if (text === '/start' || /^\/kart(?:@\w+)?$/i.test(text) || /^\/(approve|reject)(?:@\w+)?\s+PAY-[A-F0-9]{10}$/i.test(text) || /^NX\d{6}$/.test(text)) {
            sendTelegramMessage('Bu bot yalnızca səlahiyyətli istifadəçi üçün aktivdir.', chatId);
          }
          continue;
        }
        // Handle /start
        if (text === '/start') {
          sendTelegramMessage(
            '👋 <b>Nexora bildiriş botu aktivdir.</b>\n\n' +
            'Qeydiyyat, çıxarış və ödəniş bildirişləri bu çata göndəriləcək.\n' +
            'Hesab bağlamaq üçün 6 rəqəmli kod göndərməyə ehtiyac yoxdur.',
            chatId
          );
          continue;
        }
        if (/^\/kart(?:@\w+)?$/i.test(text)) {
          pendingCardUpdate = { chatId, senderId };
          sendTelegramMessage(CARD_DETAILS_PROMPT, chatId);
          continue;
        }
        if (pendingCardUpdate && pendingCardUpdate.chatId === chatId && pendingCardUpdate.senderId === senderId) {
          const details = parseCardDetails(text);
          if (!details) {
            sendTelegramMessage(CARD_DETAILS_PROMPT, chatId);
            continue;
          }
          if (typeof onCardUpdate !== 'function') {
            sendTelegramMessage('Kart məlumatları yadda saxlanılmadı. Yenidən cəhd edin.', chatId);
            continue;
          }
          try {
            onCardUpdate(details.cardNumber, details.bankName);
            pendingCardUpdate = null;
            await sendTelegramMessage('Kart məlumatları saytda uğurla yeniləndi!', chatId);
          } catch (error) {
            console.error('[telegram] Kart məlumatları yenilənmədi:', error.message);
            await sendTelegramMessage('Kart məlumatları yadda saxlanılmadı. Yenidən cəhd edin.', chatId);
          }
          continue;
        }
        const paymentCommand = /^\/(approve|reject)(?:@\w+)?\s+(PAY-[A-F0-9]{10})$/i.exec(text);
        if (paymentCommand && onPaymentCommand) {
          onPaymentCommand(
            paymentCommand[1].toLowerCase(),
            paymentCommand[2].toUpperCase(),
            chatId,
            String(msg.from && msg.from.id || '')
          );
          continue;
        }
        // Handle NX codes
        if (/^NX\d{6}$/.test(text)) {
          const code = text;
          onCode(code, chatId);
        } else {
          sendTelegramMessage('❓ Anlaşılmadı. Zəhmət olmasa dashboard-dan aldığınız kodu göndərin (format: NX123456).', chatId);
        }
      }
    } catch (e) {
      if (!signal || !signal.aborted) console.error('[telegram] Polling callback failed:', e.message);
    }
    if (!signal || !signal.aborted) await waitForPollingDelay(500, signal);
  }
}

module.exports = { sendTelegramMessage, sendTelegramPhoto, pollForCodes, parseCardDetails };
