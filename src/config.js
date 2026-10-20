'use strict';
/**
 * config.js — every store-specific value in one place, read from env.
 * Nothing here is a secret; secrets (API keys, mailbox password) are read
 * directly where they are used and documented in .env.example.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');

function regexFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try { return new RegExp(raw, 'i'); } catch { return fallback; }
}

const STORE_URL = (process.env.STORE_URL || 'https://example.com').replace(/\/+$/, '');

// Which products may be marketed to the international segment, and which of
// those lead the email. Matched against "title handle tags". Defaults are
// placeholders — set them to your own product-line tags.
const EXPORT_ELIGIBLE = regexFromEnv('EXPORT_ELIGIBLE_PATTERN', /\bexport\b/i);
const INTL_HERO       = regexFromEnv('INTERNATIONAL_HERO_PATTERN', /\bbulk\b/i);
const haystack = (p) => `${p.title || ''} ${p.handle || ''} ${p.tags || ''}`;

module.exports = {
  STORE_NAME:      process.env.STORE_NAME || 'Acme Store',
  STORE_URL,
  WHOLESALE_PATH:  process.env.WHOLESALE_PATH || '/collections/wholesale',
  RETAIL_PATH:     process.env.RETAIL_PATH || '/collections/all',
  BLOG_HANDLE:     process.env.SHOPIFY_BLOG_HANDLE || 'news',
  LOGO_URL:        process.env.LOGO_URL || '',
  PROMO_PREFIX:    (process.env.PROMO_PREFIX || 'ACME').toUpperCase().replace(/[^A-Z0-9]/g, ''),

  FROM_NAME:       process.env.FROM_NAME || process.env.STORE_NAME || 'Acme Store',
  FROM_EMAIL:      process.env.FROM_EMAIL || 'marketing@example.com',
  OWNER_EMAIL:     process.env.OWNER_EMAIL || 'owner@example.com',

  // Mailbox used to SEND the preview and READ the owner's HOLD/REDO replies.
  MAIL_USER:       process.env.MAIL_USER,
  MAIL_PASSWORD:   process.env.MAIL_APP_PASSWORD,
  SMTP_HOST:       process.env.SMTP_HOST || 'smtp.example.com',
  SMTP_PORT:       Number(process.env.SMTP_PORT || 587),
  IMAP_HOST:       process.env.IMAP_HOST || 'imap.example.com',

  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || 'claude-opus-4-6',
  IMAGE_MODEL:     process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',

  NEWS_QUERIES:    (process.env.NEWS_QUERIES || '').split(',').map(s => s.trim().replace(/\s+/g, '+')).filter(Boolean),
  LINK_CHECK_SKIP: regexFromEnv('LINK_CHECK_SKIP', null),

  CONFIG_DIR:      process.env.CONFIG_DIR || path.join(ROOT, 'config'),
  STATE_DIR:       process.env.STATE_DIR  || path.join(ROOT, 'state'),

  isExportEligible:    (p) => EXPORT_ELIGIBLE.test(haystack(p)),
  isInternationalHero: (p) => INTL_HERO.test(haystack(p)),
};
