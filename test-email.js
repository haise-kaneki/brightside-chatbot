// Sends a real test email using the same settings as the live server, so you
// can confirm lead notifications reach the owner BEFORE the first real lead.
// Usage: npm run test-email
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

dotenv.config();

const missing = ['SMTP_USER', 'SMTP_PASS', 'LEAD_NOTIFICATION_EMAIL'].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(', ')}`);
  process.exit(1);
}

const recipients = [process.env.LEAD_NOTIFICATION_EMAIL];

const transporter = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

try {
  await transporter.verify();
  console.log('Connected to the mail server and logged in OK.');
  for (const to of recipients) {
    await transporter.sendMail({
      from: `"${'your website'} Website" <${process.env.SMTP_USER}>`,
      to,
      subject: 'Test: lead notifications are working',
      text: 'If you can read this, new-lead emails from the website chat will reach this inbox. (Check spam if it is not in the inbox.)',
    });
    console.log(`Test email sent to ${to}`);
  }
} catch (err) {
  console.error('Email test FAILED:', err.message);
  if (err.responseCode === 535 || err.code === 'EAUTH') {
    console.error('-> Login rejected. Use an APP PASSWORD (Gmail/iCloud), not the normal password, with no spaces, and make sure .env has real values, not the placeholder text.');
  } else if (err.code === 'ESOCKET' || err.code === 'ECONNECTION' || err.code === 'ETIMEDOUT') {
    console.error('-> Could not reach the mail server. Check SMTP_HOST / SMTP_PORT (see references/hosting-guide.md).');
  }
  process.exit(1);
}
