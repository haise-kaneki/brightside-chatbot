// Website backend with AI chat + lead capture — LOCAL TIER
//
// Serves the client's static site files (whatever HTML/CSS/JS live in this
// same folder) and adds:
//   POST /api/chat          — the chat widget's endpoint. The ONLY place the
//                             Gemini API key is used. Handles lead capture
//                             via Gemini function calling.
//   GET  /api/widget-config — public, non-secret info (business name/phone)
//                             so chat-widget.js doesn't need per-client edits.
//   GET  /api/leads         — password-protected, returns stored leads as JSON.
//   /admin/*                — password-protected page to view leads.
//
// LOCAL TIER scope: single notification email, no location field (assumes a
// single-location business), no confirm-before-submit step, one admin login,
// basic leads table with no search/filter/export. See the Business and
// Enterprise tier folders for those features.
//
// Business facts live in business-config.js, not in this file.
// Leads are appended to data/leads.jsonl (gitignored — contains customer PII).

import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { fileURLToPath } from 'url';
import business from './business-config.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const LEADS_FILE = path.join(__dirname, 'data', 'leads.jsonl');

// Override with GEMINI_MODEL in .env if Google renames/retires this one.
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const SYSTEM_PROMPT = `You are the website chat assistant for ${business.name}, ${business.tagline} in ${business.city}, serving ${business.serviceArea}.${business.isFictionalDemo ? ' This is a fictional demo company.' : ''}

Facts you can rely on:
- Phone: ${business.phone}. Email: ${business.email}. Address: ${business.address}.
- Hours: ${business.hours.join(', ')}.
- Services: ${business.services.join(', ')}.
- Maintenance plan: ${business.maintenancePlan.monthlyPrice} — ${business.maintenancePlan.perks.join(', ')}. Single visit: ${business.maintenancePlan.singleVisitPrice}.
${business.extraNotes.map((note) => `- ${note}`).join('\n')}
${business.licenseNumber ? `- Licensed, ${business.licenseNumber}. ` : '- '}In business since ${business.inBusinessSince}.

Guidelines:
- If the visitor asks something with no reasonable connection to ${business.name} or its services — general trivia, unrelated topics, requests to write code/essays/etc — reply with exactly this text and nothing else: Unable to process that request
- Reply in plain text only — no markdown, no asterisks for bold/italic, no headers, no bullet characters like * or -.
- When answering with structured facts (hours, a list of services, pricing), put each item on its own line as "Label: value" instead of one long sentence.
- Be concise, friendly, and helpful — a few sentences (or a short set of lines for structured facts) per answer, not an essay.
- If someone describes a genuine safety hazard — ${business.emergencyExamples.join(', ')} — tell them to call ${business.phone} right away instead of continuing the chat.
- For a routine problem that isn't a safety hazard, don't just redirect to the phone — briefly acknowledge it, then move into lead capture below.
- Don't invent prices, warranty terms, or availability beyond what's listed above.
- You cannot book appointments or access a live calendar, but you CAN take down details and log a request for the office to follow up.

Lead capture:
- Whenever a visitor describes a routine issue or says they want service, a quote, or otherwise wants to be contacted (not just asking general questions), collect: full name, a phone number or email address (at least one), and a brief description of the issue.
- If they haven't described the problem, ask directly, e.g. "What's going on?" rather than a generic "describe your issue." Don't re-ask if they already said it.
- Once you have the details, call capture_lead. Do not call it more than once per visitor, and don't call it if they're just asking general questions.`;

const CAPTURE_LEAD_TOOL = {
  functionDeclarations: [
    {
      name: 'capture_lead',
      description:
        "Submit a service request lead once the visitor's full name, issue description, and at least one of phone number or email address have been collected.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "Visitor's full name." },
          phone: { type: 'string', description: "Visitor's phone number, as given. Omit if not provided." },
          email: { type: 'string', description: "Visitor's email address. Omit if not provided." },
          issue: { type: 'string', description: 'Brief description of the service needed.' },
        },
        required: ['name', 'issue'],
      },
    },
  ],
};

function stripMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/`{1,3}(.*?)`{1,3}/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[*-]\s+/gm, '• ');
}

// --- Lead storage ---------------------------------------------------

async function saveLead(lead) {
  await fs.promises.mkdir(path.dirname(LEADS_FILE), { recursive: true });
  await fs.promises.appendFile(LEADS_FILE, JSON.stringify(lead) + '\n', 'utf8');
}

async function readLeads() {
  try {
    const raw = await fs.promises.readFile(LEADS_FILE, 'utf8');
    return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line)).reverse();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// --- Lead email notification (single recipient, Local tier) ------------

// Public base URL of the deployed site, used for the admin link inside
// notification emails. Set PUBLIC_URL in .env once the site is live.
const ADMIN_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '') + '/admin/leads.html';

// One-line status printed at startup so a missing or placeholder email
// config is obvious immediately instead of failing silently on the first lead.
function emailStatusLine() {
  const missing = ['SMTP_USER', 'SMTP_PASS', 'LEAD_NOTIFICATION_EMAIL'].filter((k) => !process.env[k]);
  if (missing.length) {
    return `Lead emails: OFF (missing ${missing.join(', ')} in .env). Leads still save to data/leads.jsonl and show in the admin page.`;
  }
  const joined = [process.env.SMTP_USER, process.env.SMTP_PASS, process.env.LEAD_NOTIFICATION_EMAIL].join(' ');
  if (/youraddress|your-|changeme|change-this|example\.com/i.test(joined)) {
    return 'Lead emails: WARNING - .env still contains placeholder text. Replace it with real values.';
  }
  return `Lead emails: ON, sending to ${process.env.LEAD_NOTIFICATION_EMAIL}. Run "npm run test-email" to verify.`;
}

function emailIsConfigured() {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS && process.env.LEAD_NOTIFICATION_EMAIL);
}

function createMailTransporter() {
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendLeadNotificationEmail(lead) {
  if (!emailIsConfigured()) return;

  const transporter = createMailTransporter();
  const subject = `New lead: ${lead.name} — ${lead.issue.slice(0, 60)}`;
  const body =
    `New service request from the website chat assistant.\n\n` +
    `Name: ${lead.name}\n` +
    `Phone: ${lead.phone || 'Not provided'}\n` +
    `Email: ${lead.email || 'Not provided'}\n` +
    `Issue: ${lead.issue}\n` +
    `Received: ${new Date(lead.createdAt).toLocaleString()}\n\n` +
    `View all leads: ${ADMIN_URL}`;

  const mailOptions = {
    from: `"${business.name} Website" <${process.env.SMTP_USER}>`,
    to: process.env.LEAD_NOTIFICATION_EMAIL,
    subject,
    text: body,
  };
  if (lead.email) mailOptions.replyTo = lead.email;

  await transporter.sendMail(mailOptions);
}

function validateLeadArgs(args) {
  const name = String(args?.name || '').trim().slice(0, 200);
  const phoneRaw = String(args?.phone || '').trim().slice(0, 50);
  const emailRaw = String(args?.email || '').trim().slice(0, 200);
  const issue = String(args?.issue || '').trim().slice(0, 1000);

  const phoneOk = phoneRaw && /^[\d\s\-().+]{7,}$/.test(phoneRaw);
  const emailOk = emailRaw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw);

  const badFields = [];
  if (!name) badFields.push('name');
  if (!issue) badFields.push('issue description');
  if (!phoneOk && !emailOk) badFields.push('phone number or email');

  return { name, phone: phoneOk ? phoneRaw : '', email: emailOk ? emailRaw : '', issue, badFields };
}

// Small in-memory rate limit on lead submissions specifically.
const leadSubmissionLog = new Map();
const LEAD_LIMIT = 5;
const LEAD_WINDOW_MS = 60 * 60 * 1000;

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (leadSubmissionLog.get(ip) || []).filter((t) => now - t < LEAD_WINDOW_MS);
  timestamps.push(now);
  leadSubmissionLog.set(ip, timestamps);
  return timestamps.length > LEAD_LIMIT;
}

// --- Admin auth (single login, Local tier) ------------------------------

function requireAdminAuth(req, res, next) {
  const configuredPassword = process.env.ADMIN_PASSWORD;
  if (!configuredPassword) {
    return res.status(500).send('Admin panel is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD in .env.');
  }
  const configuredUser = process.env.ADMIN_USERNAME || 'admin';

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    if (user === configuredUser && pass === configuredPassword) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Admin"');
  return res.status(401).send('Authentication required.');
}

// --- CORS (for split-hosting setups like Shopify/Wix/etc, where the
// widget lives on a different domain than this backend) ----------------
//
// Only applies to the routes the public widget actually calls
// (/api/chat and /api/widget-config) — /api/leads and /admin stay
// same-origin only, on top of their existing Basic Auth.
// Set ALLOWED_ORIGINS in .env to a comma-separated list of the exact
// origins allowed to call this API cross-origin, e.g.:
//   ALLOWED_ORIGINS=https://clientstore.myshopify.com,https://www.clientdomain.com
// Leave it unset for an all-in-one install (same origin, no CORS needed —
// this is the default and requires no config).

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function applyCors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// --- App ------------------------------------------------------------

app.use('/api/chat', applyCors);
app.use('/api/widget-config', applyCors);
app.use(express.json({ limit: '100kb' }));
app.use('/admin', requireAdminAuth);
app.use('/api/leads', requireAdminAuth);
// Never serve server-side files or customer data as static content. The
// static handler below serves the whole project folder (so the client's
// HTML/CSS/JS just work), which would otherwise expose leads.jsonl (PII),
// server.js and business-config.js to anyone who knows the URL.
const BLOCKED_STATIC = /^\/(data|node_modules|\.git)(\/|$)|^\/(server\.js|business-config\.js|test-email\.js|package(-lock)?\.json)$|\.env/i;
app.use((req, res, next) => {
  let p;
  try { p = decodeURIComponent(req.path); } catch { return res.sendStatus(400); }
  if (BLOCKED_STATIC.test(p)) return res.sendStatus(404);
  next();
});
app.use(express.static(__dirname));

app.get('/api/widget-config', (req, res) => {
  res.json({ name: business.name, phone: business.phone });
});

app.get('/api/leads', async (req, res) => {
  try {
    const leads = await readLeads();
    res.json({ leads });
  } catch (err) {
    console.error('Failed to read leads:', err);
    res.status(500).json({ error: 'Could not load leads.' });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY is not set.');
      return res.status(500).json({ error: 'Chat is not configured on the server.' });
    }

    const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const messages = incoming
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0)
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));

    if (messages.length === 0) {
      return res.status(400).json({ error: 'No valid message provided.' });
    }
    if (messages[messages.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'Last message must be from the user.' });
    }

    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: contents,
        tools: [CAPTURE_LEAD_TOOL],
        generationConfig: { maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });

    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      console.error('Gemini API error:', geminiRes.status, data);
      return res.status(502).json({ error: 'The chat service is temporarily unavailable.' });
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const functionCallPart = parts.find((p) => p.functionCall && p.functionCall.name === 'capture_lead');

    if (functionCallPart) {
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      if (isRateLimited(ip)) {
        return res.json({
          reply: `We've received several requests from this connection recently, so I can't log another one right now. Please call us directly at ${business.phone}.`,
        });
      }

      const { name, phone, email, issue, badFields } = validateLeadArgs(functionCallPart.functionCall.args);
      if (badFields.length > 0) {
        return res.json({
          reply: `I want to make sure this reaches us correctly — could you double-check your ${badFields.join(' and ')}?`,
        });
      }

      const leadRecord = { id: crypto.randomUUID(), name, phone, email, issue, createdAt: new Date().toISOString() };

      try {
        await saveLead(leadRecord);
      } catch (err) {
        console.error('Failed to save lead:', err);
        return res.json({
          reply: `I've got your details, but hit a snag saving them on our end. Please call us at ${business.phone} so we don't lose your request.`,
        });
      }

      try {
        await sendLeadNotificationEmail(leadRecord);
      } catch (err) {
        console.error('Failed to send lead notification email:', err);
      }

      const firstName = name.split(' ')[0];
      const contactPhrase = phone ? `call or text you at ${phone}` : `email you at ${email}`;
      return res.json({
        reply: `Thanks, ${firstName}! I've logged your request and someone will ${contactPhrase} soon. If it's urgent, call us directly at ${business.phone}.`,
      });
    }

    const rawReply = parts.map((p) => p.text || '').join('').trim() || "Sorry, I couldn't come up with a response to that.";
    res.json({ reply: stripMarkdown(rawReply) });
  } catch (err) {
    console.error('Unexpected /api/chat error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`${business.name} site running at http://localhost:${PORT}`);
  console.log(emailStatusLine());
});
