#!/usr/bin/env node
'use strict';
/**
 * email-images.js — Dynamic AI image generation for email campaigns
 *
 * Uses Nano Banana (Gemini Flash Image) to generate campaign-specific imagery,
 * uploads to Shopify CDN, returns hosted URLs for email embedding.
 *
 * Usage:
 *   const { generateCampaignImages } = require('./email-images');
 *   const images = await generateCampaignImages(content.image_requests, campaignSlug);
 *   // images = [{ placement: 'hero_banner', url: 'https://cdn.shopify.com/...', alt: '...' }, ...]
 */

const fs   = require('fs');
const path = require('path');
const cfg  = require('./config');

const GEMINI_KEY    = process.env.GEMINI_API_KEY;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const IMAGES_TMP    = path.join(cfg.STATE_DIR, 'campaign-images');

// Brand style — baked into every image prompt. Shared hard rules stay
// identical across moods; the palette/lighting mood rotates by ISO week +
// campaign slug so hero imagery stops converging on one look every week.
const BRAND_RULES = `Professional commercial photography style, 4K, sharp focus. Show each product's true physical texture accurately and appealingly. CRITICAL: No text of any kind — no words, no buttons, no "Shop Now", no labels, no watermarks, no logos, no slogans, no UI elements. No leaf-icon clip art. Pure visual imagery only, zero text. Think: Aesop meets apothecary.`;

const BRAND_STYLE_MOODS = [
  `Premium botanical brand aesthetic. Color palette: earthy greens, warm cream, dark charcoal. Clean, modern, organic feel. ${BRAND_RULES}`,
  `Premium botanical brand aesthetic. Golden-hour mood: sun-washed warm light, sage green and amber tones, airy and natural, soft shadows. ${BRAND_RULES}`,
  `Premium botanical brand aesthetic. Moody editorial mood: low-key dramatic side lighting, deep forest green and charcoal tones, rich contrast, intimate close-up feel. ${BRAND_RULES}`,
];

// Back-compat export/default — mood 0 is the original brand style.
const BRAND_STYLE = BRAND_STYLE_MOODS[0];

/** ISO week number (1-53). */
function getISOWeek(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

/** Pick a brand-style mood deterministically from ISO week + campaign slug (slug carries the segment). */
function pickBrandStyle(seedStr = '') {
  let h = getISOWeek();
  for (const ch of String(seedStr)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BRAND_STYLE_MOODS[h % BRAND_STYLE_MOODS.length];
}

// ── Nano Banana Image Generation ─────────────────────────────────────────────
async function generateImageNanoBanana(prompt, slug) {
  if (!GEMINI_KEY) {
    console.warn('  ⚠️  No GEMINI_API_KEY — skipping image generation');
    return null;
  }

  // Check cache first
  const cached = ['.jpg', '.png'].map(e => path.join(IMAGES_TMP, `${slug}${e}`)).find(fs.existsSync);
  if (cached) {
    console.log(`  📁  Using cached image → ${path.basename(cached)}`);
    return cached;
  }

  // Key goes in a header rather than the query string so it never lands in logs.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.IMAGE_MODEL}:generateContent`;
  console.log(`  🍌  Nano Banana → ${slug}...`);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`  ❌  Gemini ${res.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data  = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const img   = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));

    if (!img) {
      console.error(`  ❌  No image in Gemini response (may have been filtered)`);
      return null;
    }

    const ext  = img.inlineData.mimeType.includes('png') ? 'png' : 'jpg';
    if (!fs.existsSync(IMAGES_TMP)) fs.mkdirSync(IMAGES_TMP, { recursive: true });
    const file = path.join(IMAGES_TMP, `${slug}.${ext}`);
    fs.writeFileSync(file, Buffer.from(img.inlineData.data, 'base64'));
    console.log(`  ✅  Generated → ${path.basename(file)}`);
    return file;
  } catch (e) {
    console.error(`  ❌  Nano Banana error: ${e.message}`);
    return null;
  }
}

// ── Shopify CDN Upload (staged upload) ───────────────────────────────────────
async function uploadToShopifyCDN(filePath, altText) {
  if (!SHOPIFY_TOKEN || !SHOPIFY_STORE) {
    console.warn('  ⚠️  No Shopify credentials — cannot upload to CDN');
    return null;
  }

  const filename = path.basename(filePath);
  const mimeType = filename.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const fileSize = fs.statSync(filePath).size;

  const gql = async (query, variables) => {
    const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const json = await r.json();
    if (!r.ok || json.errors || !json.data) {
      throw new Error(JSON.stringify(json.errors || json).slice(0, 200));
    }
    return json.data;
  };

  try {
    // Stage the upload
    const stage = await gql(
      `mutation stagedUploadsCreate($input:[StagedUploadInput!]!){
        stagedUploadsCreate(input:$input){
          stagedTargets{url resourceUrl parameters{name value}}
          userErrors{field message}
        }
      }`,
      { input: [{ filename, mimeType, fileSize: String(fileSize), resource: 'IMAGE', httpMethod: 'POST' }] }
    );

    const target = stage.stagedUploadsCreate.stagedTargets[0];
    if (!target) throw new Error('No staged upload target returned');

    // Upload the file
    const form = new FormData();
    target.parameters.forEach(p => form.append(p.name, p.value));
    form.append('file', new Blob([fs.readFileSync(filePath)], { type: mimeType }), filename);
    const up = await fetch(target.url, { method: 'POST', body: form });
    if (!up.ok) throw new Error(`S3 upload failed: ${up.status}`);

    // The staged resourceUrl is a TEMPORARY upload-bucket URL that expires and 403s
    // in email clients. Register the file in Shopify Files to get the permanent
    // cdn.shopify.com URL, then poll until Shopify finishes processing it.
    const create = await gql(
      `mutation fileCreate($files:[FileCreateInput!]!){
        fileCreate(files:$files){
          files{ id fileStatus }
          userErrors{ field message }
        }
      }`,
      { files: [{ originalSource: target.resourceUrl, contentType: 'IMAGE', alt: altText || filename }] }
    );
    const fileId = create.fileCreate?.files?.[0]?.id;
    if (!fileId) {
      throw new Error('fileCreate failed: ' + JSON.stringify(create.fileCreate?.userErrors || create).slice(0, 200));
    }

    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const q = await gql(
        `query($id:ID!){ node(id:$id){ ... on MediaImage { fileStatus image { url } } } }`,
        { id: fileId }
      );
      const nodeData = q.node;
      if (nodeData?.image?.url) {
        console.log(`  ☁️   Uploaded to Shopify CDN: ${nodeData.image.url.slice(0, 60)}...`);
        return nodeData.image.url;
      }
      if (nodeData?.fileStatus === 'FAILED') throw new Error('Shopify file processing FAILED');
    }
    throw new Error('Timed out waiting for permanent Shopify CDN URL');
  } catch (e) {
    console.error(`  ❌  CDN upload failed: ${e.message}`);
    return null;
  }
}

// ── Main: Generate campaign images from Claude's image_requests ──────────────
/**
 * Takes Claude's image_requests array and generates + uploads each image.
 *
 * @param {Array} imageRequests - from Claude's content output:
 *   [{ placement: 'hero_banner', prompt: '...', dimensions: '600x300', alt: '...' }]
 * @param {string} campaignSlug - unique identifier for caching (e.g. 'retail-seasonal-2026-06-11')
 * @returns {Array} - [{ placement: 'hero_banner', url: 'https://cdn.shopify.com/...', alt: '...' }]
 */
async function generateCampaignImages(imageRequests, campaignSlug) {
  if (!imageRequests?.length) return [];

  console.log(`\n🎨 Generating ${imageRequests.length} campaign image(s)...`);
  const results = [];

  for (let i = 0; i < imageRequests.length; i++) {
    const req = imageRequests[i];
    const slug = `${campaignSlug}-${req.placement || `img${i}`}`;

    // Enhance the prompt with brand style + dimensions
    const dims = req.dimensions || '600x400';
    const [w, h] = dims.split('x').map(Number);
    const aspectHint = w > h ? 'landscape orientation, wider than tall' : 'square composition';

    const fullPrompt = `${req.prompt}

Style requirements: ${pickBrandStyle(campaignSlug)}
Composition: ${aspectHint}, suitable for email at ${dims}px. Clean edges, no bleed.
Purpose: Email campaign imagery for premium botanical brand ${cfg.STORE_NAME}.`;

    // Generate
    const localFile = await generateImageNanoBanana(fullPrompt, slug);
    if (!localFile) {
      console.log(`  ⏭️  Skipping ${req.placement} — generation failed (email will send without it)`);
      continue;
    }

    // Upload to Shopify CDN
    const cdnUrl = await uploadToShopifyCDN(localFile, req.alt || `${cfg.STORE_NAME} ${req.placement}`);
    if (!cdnUrl) {
      console.log(`  ⏭️  Skipping ${req.placement} — CDN upload failed`);
      continue;
    }

    results.push({
      placement: req.placement,
      url:       cdnUrl,
      alt:       req.alt || `${cfg.STORE_NAME} campaign image`,
      dimensions: dims,
    });

    // Brief pause between generations
    if (i < imageRequests.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  console.log(`  🎨  ${results.length}/${imageRequests.length} image(s) ready`);
  return results;
}

module.exports = { generateCampaignImages, generateImageNanoBanana, uploadToShopifyCDN, BRAND_STYLE };
