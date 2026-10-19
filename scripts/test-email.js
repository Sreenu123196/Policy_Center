'use strict';
// Checks the Gmail settings the server uses, and says exactly what Gmail answers. Sends nothing unless you give an address.
//   node scripts/test-email.js                  -> signs in to Gmail only
//   node scripts/test-email.js someone@x.com    -> also sends one short test email to that address
// Needs GMAIL_USER and GMAIL_APP_PASSWORD in this window's environment, the same as the server.
require('../src/loadEnv').loadEnv();
const nodemailer = require('nodemailer');

const user = process.env.GMAIL_USER;
const pass = String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, ''); // Google shows the password in groups of four
if (!user || !pass) {
  console.error(`Not set: ${!user ? 'GMAIL_USER ' : ''}${!pass ? 'GMAIL_APP_PASSWORD' : ''}\nSet them in this same PowerShell window first.`);
  process.exit(1);
}
console.log(`Gmail user: ${user}, app password: ${pass.length} characters (should be 16)`);
const transporter = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 587, secure: false, auth: { user, pass } });
(async () => {
  try {
    await transporter.verify();
    console.log('Gmail accepted the sign-in.');
    if (process.argv[2]) {
      const info = await transporter.sendMail({ from: user, to: process.argv[2], subject: 'PolicyCenter test email', text: 'This is a test from the PolicyCenter Simulator.' });
      console.log(`Sent to ${process.argv[2]} (${info.messageId})`);
    }
  } catch (err) {
    console.error(`Gmail refused: ${err.message}`);
    if (/535|Username and Password|BadCredentials/i.test(err.message)) console.error('The address or the app password is wrong, or 2-Step Verification is off for this account (app passwords need it).');
    process.exit(1);
  }
})();
