const { sendResetCodeEmail, isMailConfigured } = require('./mailer');
(async () => {
  console.log('Mail konfiqurasiya edilib:', isMailConfigured());
  const sent = await sendResetCodeEmail('lokoknolen@gmail.com', '123456');
  console.log('Göndərildi:', sent);
  process.exit(0);
})();
