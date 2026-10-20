#!/usr/bin/env node
'use strict';
/**
 * render-samples.js — offline smoke test. Renders every campaign type with
 * synthetic content (no API calls) into state/samples/*.html and asserts the
 * two honesty rules:
 *   1. social_proof without real reviews falls back to a non-review layout,
 *      and model-supplied "testimonials" are never rendered.
 *   2. urgency_scarcity without a real deadline renders no countdown.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const cfg = require('../src/config');
const { buildEmailHtml } = require('../src/email-templates');

const catalog = [
  { id: 1, title: 'Product A', url: `${cfg.STORE_URL}/products/product-a`, images: [], price: '24.00', variants: [] },
  { id: 2, title: 'Product B', url: `${cfg.STORE_URL}/products/product-b`, images: [], price: '32.00', variants: [] },
  { id: 3, title: 'Product C', url: `${cfg.STORE_URL}/products/product-c`, images: [], price: '18.00', variants: [] },
];
const base = (type) => ({
  campaign_type: type, subject: `Sample ${type}`, preview_text: 'Preview text',
  hero_headline: 'Fresh This Week', hero_subtext: 'A short supporting line.',
  hook_line: 'One sentence that earns the scroll.', layout_variant: 'A',
  featured_products: catalog.map(p => ({ name: p.title, tagline: 'Short benefit line', cta_text: 'Shop', cta_url: p.url })),
  editorial_sections: [{ subhead: 'Why it works', body: 'One or two sentences.' }],
  grid_title: 'Our Picks', urgency_badge: 'Ends Soon',
});

const outDir = path.join(cfg.STATE_DIR, 'samples');
fs.mkdirSync(outDir, { recursive: true });
const write = (name, html) => fs.writeFileSync(path.join(outDir, `${name}.html`), html);

// Every template renders
for (const t of ['product_spotlight', 'educational', 'seasonal', 'brand_story', 'restock_crosssell', 'new_arrival']) {
  write(t, buildEmailHtml(base(t), 'retail', catalog, null, null, []));
}

// 1. Social proof: injected fake quotes are ignored; no reviews → fallback layout
const fake = { ...base('social_proof'), testimonials: ['INVENTED QUOTE'] };
const noReviews = buildEmailHtml(fake, 'retail', catalog, null, null, []);
assert(!noReviews.includes('INVENTED QUOTE'), 'model-written testimonial leaked into HTML');
assert(!noReviews.includes('Real customer reviews'), 'social-proof layout rendered without real reviews');
const real = { ...fake, reviews: [{ quote: 'Verbatim review text.', author_label: 'Verified buyer', rating: 5, source: 'Review platform', date: '2026-05-01' }] };
const withReviews = buildEmailHtml(real, 'retail', catalog, null, { value: 4.8, count: 120, source: 'Review platform', url: null }, []);
assert(withReviews.includes('Verbatim review text.') && !withReviews.includes('INVENTED QUOTE'));
write('social_proof', withReviews);

// 2. Urgency: no deadline → no countdown; real deadline → countdown cites it
const urg = { ...base('urgency_scarcity'), countdown_text: 'FAKE COUNTDOWN' };
const noDeadline = buildEmailHtml(urg, 'retail', catalog, null, null, []);
assert(!noDeadline.includes('FAKE COUNTDOWN'), 'countdown rendered without a real deadline');
const withDeadline = buildEmailHtml({ ...urg, countdown_text: 'Offer ends Oct 24', _deadline: { date: '2026-10-24', source: 'owner directive' } }, 'retail', catalog, null, null, []);
assert(withDeadline.includes('Offer ends Oct 24') && withDeadline.includes('Shop Before'));
write('urgency_scarcity', withDeadline);

// No rating configured → no rating strip
assert(!noDeadline.includes('reviews on'), 'rating strip rendered with no configured rating');

console.log(`OK — honesty checks passed; samples written to ${outDir}`);
