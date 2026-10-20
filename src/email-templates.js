#!/usr/bin/env node
'use strict';
/**
 * email-templates.js — Premium per-type email templates for campaign emails
 *
 * 5 distinct visual layouts mapped to 9 campaign types:
 *   1. Product Hero    → product_spotlight, new_arrival
 *   2. Editorial       → educational, brand_story, trend_newsjack
 *   3. Grid / Catalog  → seasonal, restock_crosssell
 *   4. Urgency         → urgency_scarcity   (only with a real deadline; else Product Hero)
 *   5. Social Proof    → social_proof       (only with real reviews; else Product Hero)
 *
 * Each template shares brand constants and common components
 * but has a completely different visual structure.
 */

const cfg = require('./config');
const STORE_NAME = cfg.STORE_NAME;
const STORE_URL  = cfg.STORE_URL;
const RETAIL_URL    = `${STORE_URL}${cfg.RETAIL_PATH}`;
const WHOLESALE_URL = `${STORE_URL}${cfg.WHOLESALE_PATH}`;
const BLOG_URL      = `${STORE_URL}/blogs/${cfg.BLOG_HANDLE}`;
const shopUrlFor    = (segment) => segment === 'retail' ? RETAIL_URL : WHOLESALE_URL;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── Brand constants ──────────────────────────────────────────────────────────
const BRAND_GREEN  = '#3F5F7F';
const BRAND_DARK   = '#222222';
const BRAND_CREAM  = '#f9f7f2';
const ACCENT_GOLD  = '#B08D57';
const ACCENT_RED   = '#B9822E';  // urgency accent — warm amber (no red: red reads as a psychological STOP sign)

// ── Shared: Google Fonts link ────────────────────────────────────────────────
const FONTS_LINK = `<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&display=swap" rel="stylesheet" />`;

// ── Layout variants (A/B/C) ──────────────────────────────────────────────────
// The writer model may output content.layout_variant ("A" | "B" | "C") to vary
// the hero treatment, accent palette, and product-block order WITHIN each
// template. If the field is missing or invalid, a deterministic seed
// (ISO week + segment) picks the variant so the look still rotates weekly.

/** ISO week number (1-53). */
function getISOWeek(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function resolveLayoutVariant(content, segment) {
  const v = String(content?.layout_variant || '').trim().toUpperCase();
  if (v === 'A' || v === 'B' || v === 'C') return v;
  const segSeed = String(segment || '').split('').reduce((s, ch) => s + ch.charCodeAt(0), 0);
  return 'ABC'[(getISOWeek() + segSeed) % 3];
}

// Brand-safe hero palettes per variant — existing brand constants only.
const HERO_PALETTES = {
  A: { bg: BRAND_GREEN, fg: '#ffffff', sub: 'rgba(255,255,255,0.8)',  kicker: 'rgba(255,255,255,0.5)'  },
  B: { bg: BRAND_DARK,  fg: '#ffffff', sub: 'rgba(255,255,255,0.75)', kicker: 'rgba(255,255,255,0.45)' },
  C: { bg: BRAND_CREAM, fg: BRAND_DARK, sub: '#777777',               kicker: '#a9a9a9'                },
};

// ── Shared: star renderer (for a REAL aggregate rating or a real review's own rating) ──
function renderStars(rating, size = 20) {
  const full  = Math.floor(rating);
  const half  = rating % 1 >= 0.3;
  const empty = 5 - full - (half ? 1 : 0);
  const c     = '#00b67a';
  const e     = '#d4d4d4';
  let s = '';
  for (let i = 0; i < full;  i++) s += `<span style="color:${c};font-size:${size}px;">&#9733;</span>`;
  if (half)                         s += `<span style="color:${c};font-size:${size}px;">&#9733;</span>`;
  for (let i = 0; i < empty; i++)   s += `<span style="color:${e};font-size:${size}px;">&#9733;</span>`;
  return s;
}

// ── Shared: Render a generated image block ───────────────────────────────────
/**
 * Renders a generated AI image into email-safe HTML.
 * Handles different placements: hero_banner, section_image, mood_shot, seasonal_graphic
 * @param {Object} img - { placement, url, alt, dimensions }
 * @param {Object} opts - { borderRadius, maxWidth, padding }
 */
function renderGeneratedImage(img, opts = {}) {
  if (!img?.url) return '';
  const maxWidth = opts.maxWidth || 600;
  const padding = opts.padding || '0';
  const radius = opts.borderRadius || '0';

  switch (img.placement) {
    case 'hero_banner':
      // Full-width banner — sits at top of email or above hero section
      return `
        <div style="padding:${padding};">
          <img src="${img.url}" alt="${img.alt || ''}" width="${maxWidth}"
            style="width:100%;height:auto;display:block;border-radius:${radius};" />
        </div>`;

    case 'section_image':
      // Inset image with padding — used between content sections
      return `
        <div style="padding:8px 24px 16px;">
          <img src="${img.url}" alt="${img.alt || ''}" width="${maxWidth - 48}"
            style="width:100%;height:auto;display:block;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,0.08);" />
        </div>`;

    case 'mood_shot':
      // Lifestyle/mood image — padded, rounded, subtle shadow
      return `
        <div style="padding:12px 32px 20px;">
          <img src="${img.url}" alt="${img.alt || ''}" width="${maxWidth - 64}"
            style="width:100%;height:auto;display:block;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.1);" />
        </div>`;

    case 'seasonal_graphic':
      // Seasonal/holiday graphic — full width, no rounding
      return `
        <div>
          <img src="${img.url}" alt="${img.alt || ''}" width="${maxWidth}"
            style="width:100%;height:auto;display:block;" />
        </div>`;

    case 'accent_strip':
      // Thin decorative strip — used as visual separator
      return `
        <div style="padding:0 24px;">
          <img src="${img.url}" alt="" width="${maxWidth - 48}"
            style="width:100%;height:auto;display:block;border-radius:6px;max-height:120px;object-fit:cover;" />
        </div>`;

    default:
      return `
        <div style="padding:8px 24px;">
          <img src="${img.url}" alt="${img.alt || ''}" width="${maxWidth - 48}"
            style="width:100%;height:auto;display:block;border-radius:8px;" />
        </div>`;
  }
}

/**
 * Get images for a specific placement from the generated images array.
 */
function getImagesForPlacement(generatedImages, placement) {
  if (!generatedImages?.length) return [];
  return generatedImages.filter(img => img.placement === placement);
}

// ── Shared: match product from catalog ───────────────────────────────────────
/**
 * Matches Claude's product name to the Shopify catalog using progressive
 * matching: exact → contains → multi-word overlap scoring.
 * The old first-word-only approach caused "Alpine Rose Balm" to match
 * "Alpine Mint Tea" instead of the actual balm product.
 */
function matchProduct(prod, products) {
  if (!prod?.name || !products?.length) return null;
  const name = prod.name.toLowerCase().trim();

  // 1. Exact title match (case-insensitive)
  const exact = products.find(p => p.title.toLowerCase().trim() === name);
  if (exact) return exact;

  // 2. One title fully contains the other
  const contains = products.find(p => {
    const t = p.title.toLowerCase();
    return t.includes(name) || name.includes(t);
  });
  if (contains) return contains;

  // 3. Multi-word overlap scoring — pick the product with the most matching words
  const nameWords = name.split(/[\s\-–—]+/).filter(w => w.length > 2);
  let bestMatch = null;
  let bestScore = 0;

  for (const p of products) {
    const titleWords = p.title.toLowerCase().split(/[\s\-–—]+/).filter(w => w.length > 2);
    let score = 0;
    for (const nw of nameWords) {
      if (titleWords.some(tw => tw.includes(nw) || nw.includes(tw))) score++;
    }
    // Require at least 2 matching words to avoid false positives
    if (score > bestScore && score >= 2) {
      bestScore = score;
      bestMatch = p;
    }
  }

  return bestMatch;
}

// ── Shared: format price for segment ─────────────────────────────────────────
/**
 * For wholesale products with multiple variants (bulk tiers), shows
 * a price range instead of the small-unit price.
 * For retail, just returns the single price.
 */
function formatPrice(matched, segment) {
  if (!matched) return null;
  // International orders use separate reference pricing NOT listed on the website —
  // never render Shopify prices for this segment. Buyers request the price list.
  if (segment === 'international') return null;
  if (segment === 'wholesale' && matched.variants?.length > 1) {
    const prices = matched.variants
      .map(v => parseFloat(v.price))
      .filter(p => !isNaN(p) && p > 0)
      .sort((a, b) => a - b);
    if (prices.length >= 2) {
      return `$${prices[0]} – $${prices[prices.length - 1]}`;
    }
  }
  return matched.price ? `$${matched.price}` : null;
}

// ── Shared: pick a varied product image ──────────────────────────────────────
/**
 * Picks a product image, rotating through the full images array to avoid
 * showing the same photo across every product card / every email.
 * Uses a Set of already-used image URLs to maximize variety.
 *
 * @param {Object} matched - catalog product from matchProduct() (has .image + .images)
 * @param {Set} usedImages - mutable Set of image URLs already used in this email
 * @returns {string|null} image URL
 */
function pickImage(matched, usedImages) {
  if (!matched) return null;
  const imgs = matched.images?.length ? matched.images : (matched.image ? [matched.image] : []);
  if (!imgs.length) return null;

  // Prefer an image not yet used in this email
  const unused = imgs.find(url => !usedImages.has(url));
  const chosen = unused || imgs[0];
  usedImages.add(chosen);
  return chosen;
}

// ── Shared: Logo bar ─────────────────────────────────────────────────────────
function logoBar(segment) {
  const shopUrl = shopUrlFor(segment);
  const shopLabel = segment === 'retail' ? 'Shop' : 'Wholesale';
  const logo = cfg.LOGO_URL
    ? `<img src="${cfg.LOGO_URL}" alt="${esc(STORE_NAME)}" height="36" style="height:36px;width:auto;max-width:150px;display:inline-block;border-radius:8px;" />`
    : `<span style="font-family:'Playfair Display',Georgia,serif;font-size:22px;font-weight:700;color:${BRAND_DARK};">${esc(STORE_NAME)}</span>`;

  return `
    <div style="padding:20px 24px 14px;text-align:center;">
      <a href="${STORE_URL}">
        ${logo}
      </a>
      <div style="margin-top:10px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-family:'Inter',Helvetica,sans-serif;">
        <a href="${shopUrl}" style="color:#aaa;margin:0 10px;text-decoration:none;">${shopLabel}</a>
        <span style="color:#ddd;">&middot;</span>
        <a href="${BLOG_URL}" style="color:#aaa;margin:0 10px;text-decoration:none;">Blog</a>
        <span style="color:#ddd;">&middot;</span>
        <a href="${STORE_URL}/pages/contact" style="color:#aaa;margin:0 10px;text-decoration:none;">Contact</a>
      </div>
    </div>`;
}

// ── Shared: Big standalone CTA button ────────────────────────────────────────
/**
 * Renders content.primary_cta = { text, url, subtext? } as a large, impossible-
 * to-miss button block (owner-requested prominent links, e.g. catalog PDFs).
 * Returns '' when the content has no primary_cta.
 */
function primaryCtaBlock(content) {
  const cta = content?.primary_cta;
  if (!cta || !cta.url || !cta.text) return '';
  return `
    <div style="padding:30px 24px;text-align:center;background:${BRAND_CREAM};">
      <a href="${cta.url}" style="display:inline-block;background:${BRAND_GREEN};color:#ffffff;padding:20px 48px;border-radius:10px;font-weight:800;font-size:18px;letter-spacing:1px;text-transform:uppercase;font-family:'Inter',Helvetica,sans-serif;box-shadow:0 4px 14px rgba(91,117,83,0.35);">${cta.text} &rarr;</a>
      ${cta.subtext ? `<p style="font-size:12px;color:#888;margin:12px 0 0;font-family:'Inter',Helvetica,sans-serif;">${cta.subtext}</p>` : ''}
    </div>`;
}

// ── Shared: Promo coupon block ───────────────────────────────────────────────
function promoBanner(promo) {
  if (!promo) return '';

  if (promo.code) {
    // Parse "10% off ..." or "$30 off ..." (legacy "30$ off ..." also handled).
    // Currency symbol ALWAYS renders BEFORE the number: "$30 OFF", never "30$ OFF".
    const valueMatch = promo.details?.match(/^\$?(\d+(?:\.\d+)?)\s*([%$])?/);
    const valueDisplay = valueMatch
      ? (valueMatch[2] === '%' ? `${valueMatch[1]}% OFF` : `$${valueMatch[1]} OFF`)
      : 'OFF';
    const expiresMatch = promo.details?.match(/ends (.+)$/);
    return `
    <div style="background:#111;padding:28px 20px;text-align:center;">
      <table cellpadding="0" cellspacing="0" border="0" align="center" style="border:2px dashed ${BRAND_GREEN};border-radius:10px;max-width:420px;width:100%;">
        <tr><td style="padding:22px 20px;text-align:center;">
          <p style="font-size:11px;color:#888;margin:0 0 8px;font-family:'Inter',Helvetica,sans-serif;text-transform:uppercase;letter-spacing:3px;">Exclusive Offer</p>
          <p style="font-size:36px;font-weight:800;color:#fff;margin:0 0 4px;font-family:'Inter',Helvetica,sans-serif;line-height:1;">${valueDisplay}</p>
          <p style="font-size:11px;color:#666;margin:0 0 12px;font-family:'Inter',Helvetica,sans-serif;letter-spacing:1px;">USE CODE AT CHECKOUT</p>
          <div style="background:${BRAND_GREEN};display:inline-block;padding:10px 32px;border-radius:6px;">
            <span style="font-size:24px;font-weight:800;color:#fff;letter-spacing:5px;font-family:'Inter',Helvetica,sans-serif;">${promo.code}</span>
          </div>
          ${expiresMatch ? `<p style="font-size:11px;color:#555;margin:12px 0 0;font-family:'Inter',Helvetica,sans-serif;">Expires ${expiresMatch[1]}</p>` : ''}
        </td></tr>
      </table>
    </div>`;
  }

  if (promo.saleId) {
    return `
    <div style="background:#111;padding:16px 20px;text-align:center;">
      <p style="font-size:14px;color:#fff;margin:0;font-family:'Inter',Helvetica,sans-serif;font-weight:600;">
        <span style="color:${ACCENT_GOLD};">SALE LIVE</span> &mdash; ${promo.details || 'Prices already reduced in store'}
      </p>
    </div>`;
  }
  return '';
}

// ── Shared: aggregate rating strip ───────────────────────────────────────────
/**
 * rating = { value, count, source, url } from config/reviews.json or env — an
 * official export/API value the owner supplies. Nothing is scraped, nothing is
 * defaulted: no rating configured → no strip.
 */
function ratingStrip(rating) {
  if (!rating || !(rating.value > 0) || !(rating.count > 0)) return '';
  const inner = `
        <div style="margin-bottom:4px;">${renderStars(rating.value, 18)}</div>
        <p style="font-size:13px;color:${BRAND_DARK};margin:0;font-weight:600;font-family:'Inter',Helvetica,sans-serif;">${rating.value} / 5</p>
        <p style="font-size:11px;color:#999;margin:4px 0 0;font-family:'Inter',Helvetica,sans-serif;">
          Based on <strong style="color:#666;">${rating.count}</strong> reviews${rating.source ? ` on ${esc(rating.source)}` : ''}
        </p>`;
  return `
    <div style="padding:24px 20px;text-align:center;background:${BRAND_CREAM};">
      ${rating.url ? `<a href="${rating.url}" style="text-decoration:none;">${inner}</a>` : inner}
    </div>`;
}

// ── Shared: Footer ───────────────────────────────────────────────────────────
function footer() {
  return `
    <div style="padding:20px 24px;text-align:center;border-top:1px solid #eee;font-size:11px;color:#bbb;font-family:'Inter',Helvetica,sans-serif;">
      <p style="margin:0;">${esc(STORE_NAME)} &middot; <a href="${STORE_URL}" style="color:#bbb;text-decoration:none;">${STORE_URL.replace(/^https?:\/\//, '')}</a></p>
      <p style="margin:6px 0 0;"><a href="{$unsubscribe}" style="color:#bbb;text-decoration:underline;">Unsubscribe</a></p>
    </div>`;
}

// ── Shared: Email shell wrapper ──────────────────────────────────────────────
function wrapEmail(subject, previewText, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no" />
  <title>${subject}</title>
  ${FONTS_LINK}
  <style>
    * { box-sizing: border-box; }
    body, html { margin: 0; padding: 0; width: 100%; }
    body { background: #f2f0eb; font-family: 'Inter', Helvetica, Arial, sans-serif; color: ${BRAND_DARK}; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
    a { text-decoration: none; }
    img { border: 0; outline: none; display: block; }
    @media only screen and (max-width: 620px) {
      .email-wrap { border-radius: 0 !important; }
      .hero-pad { padding: 36px 20px 32px !important; }
      .hero-pad h1 { font-size: 26px !important; }
      .card-pad { margin: 0 12px 14px !important; }
      .grid-cell { display: block !important; width: 100% !important; }
      .grid-cell-pad { padding: 0 12px 14px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f2f0eb;">
<!-- Preview -->
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#f2f0eb;">${previewText || ''}&nbsp;&#8199;&nbsp;&#8199;&nbsp;&#8199;&nbsp;&#8199;&nbsp;&#8199;</div>
<div style="width:100%;background:#f2f0eb;padding:20px 0;">
  <div class="email-wrap" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 30px rgba(0,0,0,0.06);">
${bodyHtml}
  </div>
</div>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE 1: PRODUCT HERO — product_spotlight, new_arrival
// Full-bleed product image hero. Clean. Aspirational. One star product center stage.
// ═══════════════════════════════════════════════════════════════════════════════

function buildProductHeroTemplate(content, segment, products, promo, tp, generatedImages) {
  const shopUrl = shopUrlFor(segment);
  const isNewArrival = (content.campaign_type || '').includes('new_arrival');
  const usedImages = new Set(); // Track used images for variety
  // Layout variant: A = image-led (classic), B = color-block info ABOVE image,
  // C = image-led on cream with secondary products in reverse order.
  const variant = resolveLayoutVariant(content, segment);
  const pal = HERO_PALETTES[variant];

  // First product is the hero
  const heroProd = content.featured_products?.[0];
  const heroMatched = heroProd ? matchProduct(heroProd, products) : null;
  const heroImg = pickImage(heroMatched, usedImages);
  const heroUrl = heroProd?.cta_url || heroMatched?.url || shopUrl;
  // display_price (e.g. "Tier 2 — $150") lets the writer feature a specific
  // variant/tier instead of the catalog's first-variant price.
  const heroPrice = heroProd?.display_price || formatPrice(heroMatched, segment);

  // Remaining products as smaller cards (variant C reverses their order)
  const secondaryList = (content.featured_products || []).slice(1);
  if (variant === 'C') secondaryList.reverse();
  const secondaryProducts = secondaryList.map(prod => {
    const m = matchProduct(prod, products);
    const url = prod.cta_url || m?.url || shopUrl;
    const img = pickImage(m, usedImages);
    const price = prod.display_price || formatPrice(m, segment);
    return `
      <td class="grid-cell" style="width:50%;vertical-align:top;">
        <div class="grid-cell-pad" style="padding:0 8px 16px;">
          <div style="border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);background:#fff;">
            ${img ? `<a href="${url}"><img src="${img}" alt="${prod.name}" width="260" style="width:100%;height:auto;display:block;" /></a>` : ''}
            <div style="padding:14px 16px;text-align:center;">
              <p style="font-family:'Playfair Display',Georgia,serif;font-size:15px;font-weight:700;margin:0 0 4px;color:${BRAND_DARK};">${prod.name}</p>
              <p style="font-size:12px;color:#888;margin:0 0 8px;line-height:1.4;">${prod.tagline || ''}</p>
              ${price ? `<p style="font-size:15px;font-weight:700;color:${BRAND_DARK};margin:0 0 10px;">${price}</p>` : ''}
              <a href="${url}" style="display:inline-block;background:${BRAND_GREEN};color:#fff;padding:8px 22px;border-radius:5px;font-size:12px;font-weight:700;font-family:'Inter',Helvetica,sans-serif;">${prod.cta_text || 'Shop'}</a>
            </div>
          </div>
        </div>
      </td>`;
  }).join('');

  // Dynamic AI-generated images
  const heroBanner  = getImagesForPlacement(generatedImages, 'hero_banner')[0];
  const moodShot    = getImagesForPlacement(generatedImages, 'mood_shot')[0];
  const sectionImg  = getImagesForPlacement(generatedImages, 'section_image')[0];

  // Hero building blocks — assembled in variant-specific order below.
  const heroImgBlock = heroImg ? `
    <!-- HERO: Full-bleed product image -->
    <div style="position:relative;">
      <a href="${heroUrl}">
        <img src="${heroImg}" alt="${heroProd?.name || ''}" width="600" style="width:100%;height:auto;display:block;" />
      </a>
      ${isNewArrival ? `<div style="position:absolute;top:16px;left:16px;background:${BRAND_GREEN};color:#fff;padding:6px 14px;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;font-family:'Inter',Helvetica,sans-serif;">Just Dropped</div>` : ''}
    </div>` : '';

  const infoOnColor = variant !== 'A';
  const infoFg  = infoOnColor ? pal.fg  : BRAND_DARK;
  const infoSub = infoOnColor ? pal.sub : '#777';
  const heroInfoBlock = `
    <!-- Product info (layout variant ${variant}) -->
    <div class="hero-pad" style="padding:28px 32px 24px;text-align:center;${infoOnColor ? `background:${pal.bg};` : ''}">
      <h1 style="font-family:'Playfair Display',Georgia,serif;font-size:28px;color:${infoFg};margin:0 0 6px;line-height:1.2;font-weight:700;">${heroProd?.name || content.hero_headline}</h1>
      <p style="font-size:14px;color:${infoSub};margin:0 0 6px;line-height:1.5;">${heroProd?.tagline || content.hero_subtext}</p>
      ${heroPrice ? `<p style="font-size:22px;font-weight:700;color:${infoFg};margin:8px 0 16px;">${heroPrice}</p>` : '<div style="height:12px;"></div>'}
      <a href="${heroUrl}" style="display:inline-block;background:${BRAND_GREEN};color:#fff;padding:14px 44px;border-radius:6px;font-weight:700;font-size:14px;font-family:'Inter',Helvetica,sans-serif;letter-spacing:0.5px;">${heroProd?.cta_text || 'Shop Now'}</a>
    </div>`;

  const body = `
    ${logoBar(segment)}

    <!-- AI-generated hero banner (if available) -->
    ${renderGeneratedImage(heroBanner)}

    ${variant === 'B' ? heroInfoBlock + heroImgBlock : heroImgBlock + heroInfoBlock}

    ${primaryCtaBlock(content)}

    ${promoBanner(promo)}

    <!-- Hook -->
    ${content.hook_line ? `
    <div style="padding:24px 32px 4px;text-align:center;">
      <p style="font-size:14px;color:#666;margin:0;line-height:1.6;font-family:'Inter',Helvetica,sans-serif;">${content.hook_line}</p>
    </div>` : ''}

    <!-- AI-generated mood/lifestyle shot (if available) -->
    ${renderGeneratedImage(moodShot)}

    <!-- Secondary products (2-up grid) -->
    ${secondaryProducts ? `
    <div style="padding:20px 16px 4px;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>${secondaryProducts}</tr>
      </table>
    </div>` : ''}

    <!-- Blog callout -->
    ${content.blog_callout ? `
    <div style="margin:4px 24px 16px;padding:14px 18px;background:#f8faf7;border-radius:8px;border-left:3px solid ${BRAND_GREEN};">
      <p style="font-size:11px;color:${BRAND_GREEN};margin:0 0 4px;font-weight:700;text-transform:uppercase;letter-spacing:1px;font-family:'Inter',Helvetica,sans-serif;">From the blog</p>
      <p style="font-size:13px;color:#666;margin:0;line-height:1.5;font-family:'Inter',Helvetica,sans-serif;">${content.blog_callout}</p>
    </div>` : ''}

    ${ratingStrip(tp)}

    ${footer()}`;

  return wrapEmail(content.subject, content.preview_text, body);
}


// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE 2: EDITORIAL — educational, brand_story, trend_newsjack
// Magazine-style. Headline-forward. Article sections. Knowledge-first, products woven in.
// ═══════════════════════════════════════════════════════════════════════════════

function buildEditorialTemplate(content, segment, products, promo, tp, generatedImages) {
  const shopUrl = shopUrlFor(segment);
  const usedImages = new Set(); // Track used images for variety
  // Layout variant: hero palette rotates (A=green, B=charcoal, C=cream);
  // variant C also reverses the recommended-products strip.
  const variant = resolveLayoutVariant(content, segment);
  const pal = HERO_PALETTES[variant];

  // Dynamic AI-generated images
  const heroBanner = getImagesForPlacement(generatedImages, 'hero_banner')[0];
  const sectionImg = getImagesForPlacement(generatedImages, 'section_image')[0];
  const accentStrip = getImagesForPlacement(generatedImages, 'accent_strip')[0];

  // Editorial sections — inject section_image after first section if available
  const sections = (content.editorial_sections || []).map((sec, i) => `
    <div style="margin-bottom:20px;">
      <h3 style="font-family:'Playfair Display',Georgia,serif;font-size:18px;color:${BRAND_DARK};margin:0 0 8px;font-weight:600;">${sec.subhead}</h3>
      <p style="font-size:14px;color:#555;margin:0;line-height:1.7;font-family:'Inter',Helvetica,sans-serif;">${sec.body}</p>
    </div>`).join('');

  // Product recs as a horizontal strip (variant C reverses the order)
  const stripList = variant === 'C'
    ? [...(content.featured_products || [])].reverse()
    : (content.featured_products || []);
  const prodStrip = stripList.map(prod => {
    const m = matchProduct(prod, products);
    const url = prod.cta_url || m?.url || shopUrl;
    const img = pickImage(m, usedImages);
    const price = prod.display_price || formatPrice(m, segment);
    return `
      <td class="grid-cell" style="width:${100 / Math.min(stripList.length, 4)}%;vertical-align:top;">
        <div class="grid-cell-pad" style="padding:0 6px;">
          <div style="text-align:center;">
            ${img ? `<a href="${url}"><img src="${img}" alt="${prod.name}" width="180" style="width:100%;height:auto;display:block;border-radius:8px;" /></a>` : ''}
            <p style="font-size:13px;font-weight:700;color:${BRAND_DARK};margin:10px 0 2px;font-family:'Inter',Helvetica,sans-serif;">${prod.name}</p>
            ${price ? `<p style="font-size:13px;color:#666;margin:0 0 8px;">${price}</p>` : ''}
            <a href="${url}" style="font-size:12px;color:${BRAND_GREEN};font-weight:700;font-family:'Inter',Helvetica,sans-serif;">${prod.cta_text || 'Shop'} &rarr;</a>
          </div>
        </div>
      </td>`;
  }).join('');

  const body = `
    ${logoBar(segment)}

    <!-- AI-generated hero banner (if available) -->
    ${renderGeneratedImage(heroBanner)}

    <!-- Editorial hero — palette rotates by layout variant ${variant} -->
    <div class="hero-pad" style="background:${pal.bg};padding:52px 36px 48px;text-align:center;">
      <p style="font-size:11px;color:${pal.kicker};margin:0 0 12px;text-transform:uppercase;letter-spacing:3px;font-family:'Inter',Helvetica,sans-serif;">The ${esc(STORE_NAME)} Edit</p>
      <h1 style="font-family:'Playfair Display',Georgia,serif;font-size:32px;color:${pal.fg};margin:0 0 12px;line-height:1.2;font-weight:700;">${content.hero_headline}</h1>
      <p style="font-size:15px;color:${pal.sub};margin:0;line-height:1.5;font-family:'Inter',Helvetica,sans-serif;">${content.hero_subtext}</p>
    </div>

    <!-- Big standalone CTA button (if the campaign carries one) — placed high -->
    ${primaryCtaBlock(content)}

    ${promoBanner(promo)}

    <!-- Article body -->
    <div style="padding:32px 32px 12px;">
      ${content.hook_line ? `
      <p style="font-size:15px;color:#444;margin:0 0 24px;line-height:1.7;font-family:'Inter',Helvetica,sans-serif;">${content.hook_line}</p>` : ''}
      ${sections}
    </div>

    <!-- AI-generated section image (if available) — between article and blog CTA -->
    ${renderGeneratedImage(sectionImg)}

    <!-- Blog CTA -->
    ${content.blog_callout ? `
    <div style="margin:0 24px 20px;padding:20px 24px;background:${BRAND_CREAM};border-radius:10px;text-align:center;">
      <p style="font-size:14px;color:#666;margin:0 0 12px;line-height:1.5;font-family:'Inter',Helvetica,sans-serif;">${content.blog_callout}</p>
      <a href="${BLOG_URL}" style="display:inline-block;background:${BRAND_GREEN};color:#fff;padding:10px 28px;border-radius:5px;font-size:13px;font-weight:600;font-family:'Inter',Helvetica,sans-serif;">Read More</a>
    </div>` : ''}

    <!-- AI accent strip (if available) -->
    ${renderGeneratedImage(accentStrip)}

    <!-- Divider line -->
    <div style="padding:0 32px;"><div style="height:1px;background:#eee;"></div></div>

    <!-- Recommended products strip -->
    <div style="padding:24px 18px 20px;">
      <p style="font-size:11px;color:#aaa;text-align:center;margin:0 0 16px;text-transform:uppercase;letter-spacing:2px;font-family:'Inter',Helvetica,sans-serif;">Recommended for You</p>
      <table cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>${prodStrip}</tr>
      </table>
    </div>

    ${ratingStrip(tp)}

    ${footer()}`;

  return wrapEmail(content.subject, content.preview_text, body);
}


// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE 3: GRID / CATALOG — seasonal, restock_crosssell
// Multi-product showcase. Gift guide grid. "You might also like" layout.
// ═══════════════════════════════════════════════════════════════════════════════

function buildGridTemplate(content, segment, products, promo, tp, generatedImages) {
  const shopUrl = shopUrlFor(segment);
  const isRestock = (content.campaign_type || '').includes('restock');
  const gridTitle = content.grid_title || (isRestock ? 'Time to Restock?' : 'Our Picks for You');
  const usedImages = new Set(); // Track used images for variety
  // Layout variant: hero palette rotates (A=green, B=charcoal, C=cream);
  // variant C also reverses the product-grid order.
  const variant = resolveLayoutVariant(content, segment);
  const pal = HERO_PALETTES[variant];

  // Dynamic AI-generated images
  const seasonalGraphic = getImagesForPlacement(generatedImages, 'seasonal_graphic')[0];
  const heroBanner      = getImagesForPlacement(generatedImages, 'hero_banner')[0];

  // Build product cards in a 2-column grid (variant C reverses the order)
  const gridList = variant === 'C'
    ? [...(content.featured_products || [])].reverse()
    : (content.featured_products || []);
  const productCells = gridList.map(prod => {
    const m = matchProduct(prod, products);
    const url = prod.cta_url || m?.url || shopUrl;
    const img = pickImage(m, usedImages);
    const price = prod.display_price || formatPrice(m, segment);
    return `
      <td class="grid-cell" style="width:50%;vertical-align:top;">
        <div class="grid-cell-pad" style="padding:0 8px 16px;">
          <div style="border-radius:10px;overflow:hidden;background:#fff;box-shadow:0 1px 10px rgba(0,0,0,0.06);">
            ${img ? `<a href="${url}"><img src="${img}" alt="${prod.name}" width="260" style="width:100%;height:auto;display:block;" /></a>` : ''}
            <div style="padding:14px 14px 16px;text-align:center;">
              <p style="font-family:'Playfair Display',Georgia,serif;font-size:14px;font-weight:700;margin:0 0 4px;color:${BRAND_DARK};line-height:1.3;">${prod.name}</p>
              <p style="font-size:11px;color:#999;margin:0 0 8px;line-height:1.4;font-family:'Inter',Helvetica,sans-serif;">${prod.tagline || ''}</p>
              ${price ? `<p style="font-size:16px;font-weight:700;color:${BRAND_DARK};margin:0 0 10px;font-family:'Inter',Helvetica,sans-serif;">${price}</p>` : ''}
              <a href="${url}" style="display:inline-block;background:${BRAND_GREEN};color:#fff;padding:8px 20px;border-radius:5px;font-size:12px;font-weight:700;font-family:'Inter',Helvetica,sans-serif;">${prod.cta_text || 'Shop'}</a>
            </div>
          </div>
        </div>
      </td>`;
  });

  // Pair cells into rows of 2
  let gridRows = '';
  for (let i = 0; i < productCells.length; i += 2) {
    gridRows += `<tr>${productCells[i]}${productCells[i + 1] || '<td></td>'}</tr>`;
  }

  const body = `
    ${logoBar(segment)}

    <!-- AI-generated seasonal graphic or hero banner (if available) -->
    ${renderGeneratedImage(seasonalGraphic || heroBanner)}

    <!-- Seasonal hero — palette rotates by layout variant ${variant} -->
    <div class="hero-pad" style="background:${pal.bg};padding:44px 32px 40px;text-align:center;">
      <h1 style="font-family:'Playfair Display',Georgia,serif;font-size:30px;color:${pal.fg};margin:0 0 10px;line-height:1.2;font-weight:700;">${content.hero_headline}</h1>
      <p style="font-size:15px;color:${pal.sub};margin:0 0 20px;line-height:1.5;font-family:'Inter',Helvetica,sans-serif;">${content.hero_subtext}</p>
      <a href="${shopUrl}" style="display:inline-block;background:${variant === 'C' ? BRAND_GREEN : '#fff'};color:${variant === 'C' ? '#fff' : (variant === 'B' ? BRAND_DARK : BRAND_GREEN)};padding:12px 36px;border-radius:6px;font-weight:700;font-size:13px;font-family:'Inter',Helvetica,sans-serif;">Browse All</a>
    </div>

    ${primaryCtaBlock(content)}

    ${promoBanner(promo)}

    <!-- Hook -->
    ${content.hook_line ? `
    <div style="padding:24px 32px 4px;text-align:center;">
      <p style="font-size:14px;color:#666;margin:0;line-height:1.6;font-family:'Inter',Helvetica,sans-serif;">${content.hook_line}</p>
    </div>` : ''}

    <!-- Grid title -->
    <div style="padding:24px 24px 8px;text-align:center;">
      <p style="font-size:11px;color:#bbb;margin:0;text-transform:uppercase;letter-spacing:2px;font-family:'Inter',Helvetica,sans-serif;">${gridTitle}</p>
    </div>

    <!-- Product grid -->
    <div style="padding:8px 16px 8px;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%">
        ${gridRows}
      </table>
    </div>

    <!-- Shop all CTA -->
    <div style="padding:8px 24px 24px;text-align:center;">
      <a href="${shopUrl}" style="display:inline-block;border:2px solid ${BRAND_GREEN};color:${BRAND_GREEN};padding:12px 36px;border-radius:6px;font-weight:700;font-size:13px;font-family:'Inter',Helvetica,sans-serif;">View Full Collection</a>
    </div>

    ${content.blog_callout ? `
    <div style="margin:0 24px 16px;padding:14px 18px;background:#f8faf7;border-radius:8px;border-left:3px solid ${BRAND_GREEN};">
      <p style="font-size:11px;color:${BRAND_GREEN};margin:0 0 4px;font-weight:700;text-transform:uppercase;letter-spacing:1px;font-family:'Inter',Helvetica,sans-serif;">From the blog</p>
      <p style="font-size:13px;color:#666;margin:0;line-height:1.5;font-family:'Inter',Helvetica,sans-serif;">${content.blog_callout}</p>
    </div>` : ''}

    ${ratingStrip(tp)}

    ${footer()}`;

  return wrapEmail(content.subject, content.preview_text, body);
}


// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE 4: URGENCY — urgency_scarcity
// High energy. Bold accents. Amber/gold highlights. Only rendered when the
// content carries a REAL deadline (content._deadline, set by code); the
// countdown bar shows only then. Without one, the router uses Product Hero.
// ═══════════════════════════════════════════════════════════════════════════════

function buildUrgencyTemplate(content, segment, products, promo, tp, generatedImages) {
  const shopUrl = shopUrlFor(segment);
  const badge = content.urgency_badge || 'Ends Soon';
  const usedImages = new Set(); // Track used images for variety
  // Layout variant: urgency keeps its dark identity but rotates accent color
  // (A=amber, B=gold) and hero shade; variant C reverses the product cards.
  const variant = resolveLayoutVariant(content, segment);
  const urgAccent = variant === 'B' ? ACCENT_GOLD : ACCENT_RED;
  const urgHeroBg = variant === 'C' ? BRAND_DARK : '#1a1a1a';

  const deadline = content._deadline || null;
  const deadlineLabel = deadline
    ? new Date(`${deadline.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;
  const heroCtaUrl = shopUrl;
  const heroCtaLabel = deadlineLabel ? `Shop Before ${deadlineLabel}` : 'Shop Now';

  // Dynamic AI-generated images — urgency emails are text-heavy by design,
  // but Claude can still choose to include an accent_strip for visual flair
  const accentStrip = getImagesForPlacement(generatedImages, 'accent_strip')[0];

  // Products as stacked full-width cards with urgency styling (variant C reversed)
  const urgList = variant === 'C'
    ? [...(content.featured_products || [])].reverse()
    : (content.featured_products || []);
  const productCards = urgList.map(prod => {
    const m = matchProduct(prod, products);
    const url = prod.cta_url || m?.url || shopUrl;
    const img = pickImage(m, usedImages);
    const price = prod.display_price || formatPrice(m, segment);
    return `
    <div class="card-pad" style="margin:0 24px 18px;border-radius:10px;overflow:hidden;box-shadow:0 2px 14px rgba(0,0,0,0.08);background:#fff;border:1px solid #f0eeea;">
      ${img ? `<a href="${url}"><img src="${img}" alt="${prod.name}" width="552" style="width:100%;height:auto;display:block;" /></a>` : ''}
      <div style="padding:18px 22px;text-align:center;">
        <p style="font-family:'Playfair Display',Georgia,serif;font-size:18px;font-weight:700;margin:0 0 4px;color:${BRAND_DARK};">${prod.name}</p>
        <p style="font-size:13px;color:#888;margin:0 0 8px;line-height:1.4;font-family:'Inter',Helvetica,sans-serif;">${prod.tagline || ''}</p>
        ${price ? `<p style="font-size:20px;font-weight:700;color:${BRAND_DARK};margin:0 0 12px;font-family:'Inter',Helvetica,sans-serif;">${price}</p>` : ''}
        <a href="${url}" style="display:inline-block;background:${urgAccent};color:#fff;padding:12px 36px;border-radius:6px;font-weight:700;font-size:13px;font-family:'Inter',Helvetica,sans-serif;letter-spacing:0.5px;">${prod.cta_text || 'Grab It'}</a>
      </div>
    </div>`;
  }).join('');

  const body = `
    ${logoBar(segment)}

    <!-- Urgency hero — dark with rotating accent (layout variant ${variant}) -->
    <div class="hero-pad" style="background:${urgHeroBg};padding:44px 32px 40px;text-align:center;">
      <div style="display:inline-block;background:${urgAccent};color:#fff;padding:5px 16px;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:16px;font-family:'Inter',Helvetica,sans-serif;">${badge}</div>
      <h1 style="font-family:'Playfair Display',Georgia,serif;font-size:32px;color:#fff;margin:0 0 10px;line-height:1.15;font-weight:700;">${content.hero_headline}</h1>
      <p style="font-size:15px;color:rgba(255,255,255,0.7);margin:0 0 24px;line-height:1.5;font-family:'Inter',Helvetica,sans-serif;">${content.hero_subtext}</p>
      <a href="${heroCtaUrl}" style="display:inline-block;background:${urgAccent};color:#fff;padding:14px 40px;border-radius:6px;font-weight:700;font-size:14px;font-family:'Inter',Helvetica,sans-serif;letter-spacing:0.5px;">${heroCtaLabel}</a>
    </div>


    ${primaryCtaBlock(content)}

    ${promoBanner(promo)}

    <!-- Countdown-style bar — ONLY with a real deadline (accent complements the variant's primary accent) -->
    ${deadline && content.countdown_text ? `
    <div style="background:${variant === 'B' ? ACCENT_RED : ACCENT_GOLD};padding:10px 20px;text-align:center;">
      <p style="font-size:13px;font-weight:700;color:#fff;margin:0;letter-spacing:1px;font-family:'Inter',Helvetica,sans-serif;">${content.countdown_text}</p>
    </div>` : ''}

    <!-- Hook -->
    ${content.hook_line ? `
    <div style="padding:24px 32px 4px;text-align:center;">
      <p style="font-size:14px;color:#666;margin:0;line-height:1.6;font-family:'Inter',Helvetica,sans-serif;">${content.hook_line}</p>
    </div>` : ''}

    <!-- Products -->
    <div style="padding:20px 0 8px;">
      ${productCards}
    </div>

    <!-- AI accent strip (if available) -->
    ${renderGeneratedImage(accentStrip)}

    ${ratingStrip(tp)}

    ${footer()}`;

  return wrapEmail(content.subject, content.preview_text, body);
}


// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE 5: SOCIAL PROOF — social_proof
// Review-led. Renders ONLY real reviews passed in as content.reviews (verbatim
// from config/reviews.json, attached by code). The model never writes quotes.
// Stars shown only for a real aggregate rating or a review's own rating.
// ═══════════════════════════════════════════════════════════════════════════════

function buildSocialProofTemplate(content, segment, products, promo, tp, generatedImages) {
  const shopUrl = shopUrlFor(segment);
  // tp = optional aggregate rating from config (may be null)
  const usedImages = new Set(); // Track used images for variety
  // Layout variant: hero rotates cream (A/C) vs charcoal (B) — green
  // stars stay high-contrast on both; variant C reverses the product strip.
  const variant = resolveLayoutVariant(content, segment);
  const spBg   = variant === 'B' ? BRAND_DARK : BRAND_CREAM;
  const spFg   = variant === 'B' ? '#ffffff' : BRAND_DARK;
  const spSub  = variant === 'B' ? 'rgba(255,255,255,0.75)' : '#777';
  const spMeta = variant === 'B' ? 'rgba(255,255,255,0.5)'  : '#aaa';

  // Dynamic AI-generated images — social proof is review-led,
  // but a mood_shot between reviews and products can add warmth
  const moodShot = getImagesForPlacement(generatedImages, 'mood_shot')[0];

  // Review cards — real reviews only, verbatim, with attribution to their source
  const testimonials = (content.reviews || []).map(r => `
    <div style="background:#fff;border-radius:10px;padding:20px 22px;margin-bottom:12px;box-shadow:0 1px 8px rgba(0,0,0,0.05);border:1px solid #f0eeea;">
      ${r.rating ? `<div style="margin-bottom:8px;">${renderStars(r.rating, 14)}</div>` : ''}
      <p style="font-size:14px;color:#444;margin:0;line-height:1.6;font-style:italic;font-family:'Inter',Helvetica,sans-serif;">&ldquo;${esc(r.quote)}&rdquo;</p>
      <p style="font-size:11px;color:#999;margin:8px 0 0;font-family:'Inter',Helvetica,sans-serif;">&mdash; ${esc(r.author_label)}${r.source ? `, via ${esc(r.source)}` : ''}${r.date ? ` &middot; ${esc(r.date)}` : ''}</p>
    </div>`).join('');

  // Products as compact recommendations (variant C reverses the order)
  const spList = variant === 'C'
    ? [...(content.featured_products || [])].reverse()
    : (content.featured_products || []);
  const prodStrip = spList.map(prod => {
    const m = matchProduct(prod, products);
    const url = prod.cta_url || m?.url || shopUrl;
    const img = pickImage(m, usedImages);
    const price = prod.display_price || formatPrice(m, segment);
    return `
      <td class="grid-cell" style="width:${100 / Math.min(spList.length, 4)}%;vertical-align:top;">
        <div class="grid-cell-pad" style="padding:0 6px;">
          <div style="text-align:center;border-radius:10px;overflow:hidden;background:#fff;box-shadow:0 1px 8px rgba(0,0,0,0.05);">
            ${img ? `<a href="${url}"><img src="${img}" alt="${prod.name}" width="180" style="width:100%;height:auto;display:block;" /></a>` : ''}
            <div style="padding:12px 10px 14px;">
              <p style="font-size:12px;font-weight:700;color:${BRAND_DARK};margin:0 0 2px;font-family:'Inter',Helvetica,sans-serif;">${prod.name}</p>
              ${price ? `<p style="font-size:13px;color:#666;margin:0 0 8px;font-family:'Inter',Helvetica,sans-serif;">${price}</p>` : ''}
              <a href="${url}" style="font-size:11px;color:${BRAND_GREEN};font-weight:700;font-family:'Inter',Helvetica,sans-serif;">${prod.cta_text || 'Shop'} &rarr;</a>
            </div>
          </div>
        </div>
      </td>`;
  }).join('');

  const body = `
    ${logoBar(segment)}

    <!-- Social proof hero (layout variant ${variant}) — stars only for a real configured rating -->
    <div class="hero-pad" style="background:${spBg};padding:44px 32px;text-align:center;border-bottom:1px solid #eee;">
      ${tp ? `<div style="margin-bottom:12px;">${renderStars(tp.value, 28)}</div>` : ''}
      <h1 style="font-family:'Playfair Display',Georgia,serif;font-size:30px;color:${spFg};margin:0 0 8px;line-height:1.2;font-weight:700;">${content.hero_headline}</h1>
      <p style="font-size:15px;color:${spSub};margin:0 0 6px;line-height:1.5;font-family:'Inter',Helvetica,sans-serif;">${content.hero_subtext}</p>
      ${tp ? `<p style="font-size:12px;color:${spMeta};margin:0;font-family:'Inter',Helvetica,sans-serif;">${tp.value}/5 from ${tp.count} reviews${tp.source ? ` on ${esc(tp.source)}` : ''}</p>` : ''}
    </div>

    ${primaryCtaBlock(content)}

    ${promoBanner(promo)}

    <!-- Real customer reviews -->
    ${testimonials ? `
    <div style="padding:24px 24px 8px;background:#fafaf8;">
      <p style="font-size:11px;color:#bbb;text-align:center;margin:0 0 14px;text-transform:uppercase;letter-spacing:2px;font-family:'Inter',Helvetica,sans-serif;">What Customers Say</p>
      ${testimonials}
    </div>` : ''}

    <!-- Hook -->
    ${content.hook_line ? `
    <div style="padding:20px 32px 4px;text-align:center;">
      <p style="font-size:14px;color:#666;margin:0;line-height:1.6;font-family:'Inter',Helvetica,sans-serif;">${content.hook_line}</p>
    </div>` : ''}

    <!-- AI-generated mood/lifestyle shot (if available) -->
    ${renderGeneratedImage(moodShot)}

    <!-- Most-loved products -->
    <div style="padding:20px 18px 16px;">
      <p style="font-size:11px;color:#bbb;text-align:center;margin:0 0 14px;text-transform:uppercase;letter-spacing:2px;font-family:'Inter',Helvetica,sans-serif;">Most Loved</p>
      <table cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>${prodStrip}</tr>
      </table>
    </div>

    <!-- CTA -->
    <div style="padding:8px 24px 24px;text-align:center;">
      <a href="${shopUrl}" style="display:inline-block;background:${BRAND_GREEN};color:#fff;padding:14px 40px;border-radius:6px;font-weight:700;font-size:14px;font-family:'Inter',Helvetica,sans-serif;">Shop Best Sellers</a>
    </div>

    ${ratingStrip(tp)}

    ${footer()}`;

  return wrapEmail(content.subject, content.preview_text, body);
}


// ═══════════════════════════════════════════════════════════════════════════════
// ROUTER — picks the right template based on campaign type
// ═══════════════════════════════════════════════════════════════════════════════

function buildEmailHtml(content, segment, products, promoResult, rating, generatedImages) {
  // rating: optional aggregate { value, count, source, url } from config — null means "omit"
  const ratingData = rating || null;
  const type = content.campaign_type || content._campaignType || 'product_spotlight';
  const imgs = generatedImages || [];

  switch (type) {
    case 'product_spotlight':
    case 'new_arrival':
      return buildProductHeroTemplate(content, segment, products, promoResult, ratingData, imgs);

    case 'educational':
    case 'brand_story':
    case 'trend_newsjack':
      return buildEditorialTemplate(content, segment, products, promoResult, ratingData, imgs);

    case 'seasonal':
    case 'restock_crosssell':
      return buildGridTemplate(content, segment, products, promoResult, ratingData, imgs);

    case 'urgency_scarcity':
      // No real deadline → no urgency layout (and no countdown) at all.
      if (!content._deadline) return buildProductHeroTemplate(content, segment, products, promoResult, ratingData, imgs);
      return buildUrgencyTemplate(content, segment, products, promoResult, ratingData, imgs);

    case 'social_proof':
      // No real reviews → no social-proof layout. Quotes are never generated.
      if (!(content.reviews || []).length) return buildProductHeroTemplate(content, segment, products, promoResult, ratingData, imgs);
      return buildSocialProofTemplate(content, segment, products, promoResult, ratingData, imgs);

    default:
      return buildProductHeroTemplate(content, segment, products, promoResult, ratingData, imgs);
  }
}

function buildPlainText(content, segment) {
  const shopUrl = shopUrlFor(segment);
  const prods = (content.featured_products || [])
    .map(p => `${p.name}\n${p.tagline || ''}\n${p.cta_url || shopUrl}`)
    .join('\n\n');

  return `${content.hero_headline}
${content.hero_subtext}

${content.hook_line || ''}

${prods}

---
${STORE_NAME} | ${STORE_URL}
Unsubscribe: {$unsubscribe}`;
}


module.exports = { buildEmailHtml, buildPlainText, renderStars };
