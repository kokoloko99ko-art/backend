// Gmail-based email sender (SMTP via Gmail App Password)
// Config: add to backend/config.json (or env vars):
//   GMAIL_USER: "yourgmail@gmail.com"
//   GMAIL_APP_PASSWORD: "16-char app password"
//   APP_URL: "https://your-site.com" (optional, for links in emails)
const nodemailer = require('nodemailer');
const config = require('./config');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const user = process.env.GMAIL_USER || config.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD || config.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    console.warn('[mailer] GMAIL_USER / GMAIL_APP_PASSWORD konfiqurasiya edilməyib — e-poçt göndərilməyəcək.');
    return null;
  }
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });
  return transporter;
}

function isMailConfigured() {
  const user = process.env.GMAIL_USER || config.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD || config.GMAIL_APP_PASSWORD;
  return Boolean(user && pass);
}

function sendMail(to, subject, html) {
  const t = getTransporter();
  if (!t) return Promise.resolve(false);
  const from = process.env.GMAIL_USER || config.GMAIL_USER;
  return t.sendMail({ from: '"Lightroom" <' + from + '>', to, subject, html })
    .then(() => true)
    .catch((e) => {
      console.error('[mailer] Göndərilmədi:', e.message);
      return false;
    });
}

function sendResetCodeEmail(to, code) {
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#f5f8f6;border-radius:16px;">
    <div style="background:#102b22;color:#f4fbf6;padding:22px 28px;border-radius:14px 14px 0 0;">
      <h2 style="margin:0;font-size:20px;">Lightroom — Şifrə bərpası</h2>
    </div>
    <div style="background:#ffffff;padding:28px;border-radius:0 0 14px 14px;border:1px solid #e2ece6;border-top:none;">
      <p style="color:#3e4e46;font-size:15px;line-height:1.6;">Salam,</p>
      <p style="color:#3e4e46;font-size:15px;line-height:1.6;">Hesabınızın şifrəsini sıfırlamaq üçün tək istifadəlik kodunuz aşağıdadır:</p>
      <div style="text-align:center;margin:26px 0;">
        <span style="display:inline-block;font-size:34px;letter-spacing:10px;font-weight:800;color:#0f766e;background:#e6f5eb;border:1px solid #d7ecdf;padding:14px 28px;border-radius:12px;">${code}</span>
      </div>
      <p style="color:#6b7a72;font-size:13px;line-height:1.6;">Bu kod <b>15 dəqiqə</b> ərzində etibarlıdır və yalnız bir dəfə istifadə oluna bilər.</p>
      <p style="color:#6b7a72;font-size:13px;line-height:1.6;">Əgər bu sorğunu siz göndərməmisinizsə, bu e-poçtu nəzərə almayın — şifrəniz dəyişməyəcək.</p>
      <p style="color:#9aa8a0;font-size:12px;margin-top:24px;">© Lightroom — Bütün hüquqlar qorunur.</p>
    </div>
  </div>`;
  return sendMail(to, 'Lightroom — Şifrə bərpası kodu: ' + code, html);
}

module.exports = { sendMail, sendResetCodeEmail, isMailConfigured };
