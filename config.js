const fs = require('fs');
const path = require('path');

let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

for (const key of [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_ADMIN_USER_ID',
  'TELEGRAM_BOT_USERNAME',
  'PAYMENT_CARD_NUMBER',
  'PAYMENT_BANK_NAME'
]) {
  if (process.env[key]) config[key] = process.env[key];
}

if (!config.TELEGRAM_ADMIN_USER_ID && config.TELEGRAM_CHAT_ID) {
  config.TELEGRAM_ADMIN_USER_ID = config.TELEGRAM_CHAT_ID;
}

module.exports = config;
