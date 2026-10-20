#!/usr/bin/env node
'use strict';
/**
 * campaign-generator.js — Weekly AI-powered email campaigns via MailerLite
 *
 * Two-phase workflow (mirrors contact-sync.js pattern):
 *   1. --generate (Thursday 10 PM ET)  → Pull Shopify data, generate campaigns with Claude,
 *                                    create drafts in MailerLite, email HTML preview to the owner
 *   2. --schedule (Friday 5 PM ET)  → Check for HOLD/REDO reply over IMAP, if no hold → schedule
 *                                    campaigns to send during the FOLLOWING Mon–Sun week (10am ET)
 *   3. --review   (Thursday 7 PM ET)   → Pull open/click stats for sent campaigns into the
 *                                    history file the planner and writer learn from
 *
 * Preview goes to: OWNER_EMAIL
 * Reply "HOLD" to the preview email by Friday 5 PM ET to cancel that week's sends.
 *
 * Design rules (enforced in code, not just in prompts):
 *   - No fabricated social proof: testimonials only come verbatim from config/reviews.json
 *     (exported from your review platform). The model never writes quotes. No reviews → no
 *     social_proof campaign type that week.
 *   - Urgency only from real deadlines: countdown/urgency copy is only allowed when the email
 *     carries a real end date (owner directive deadline or an active Shopify discount's ends_at).
 *
 * Env vars: see .env.example at the repo root.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Anthropic        = require('@anthropic-ai/sdk');
const nodemailer       = require('nodemailer');
const Imap             = require('imap');
const { simpleParser } = require('mailparser');
const fs               = require('fs');
const path             = require('path');

const cfg = require('./config');
const { buildEmailHtml, buildPlainText } = require('./email-templates');
const { generateCampaignImages }        = require('./email-images');
const {
  loadEditorialRules, getHeroCooldown, checkVarietyV2, filterProductsByRules,
  buildRulesPromptBlock, buildConceptPromptBlock,
  fetchEmailMarketingTrends, generateCreativeAngles,
} = require('./creative-engine');

const claude             = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const ML_API_KEY         = process.env.MAILERLITE_API_KEY;
const ML_RETAIL_GROUP    = process.env.MAILERLITE_RETAIL_GROUP_ID;
const ML_WHOLESALE_GROUP = process.env.MAILERLITE_WHOLESALE_GROUP_ID;
let ML_INTERNATIONAL_GROUP = process.env.MAILERLITE_INTERNATIONAL_GROUP_ID;

/** Auto-discover the International group ID from MailerLite if the env var isn't set. */
async function resolveInternationalGroupId() {
  if (ML_INTERNATIONAL_GROUP) return ML_INTERNATIONAL_GROUP;
  try {
    const res = await fetch(`${ML_API}/groups?filter[name]=International`, {
      headers: { Authorization: `Bearer ${ML_API_KEY}`, 'Content-Type': 'application/json' }
    });
    if (!res.ok) throw new Error(`groups lookup failed: ${res.status}`);
    const { data } = await res.json();
    const match = (data || []).find(g => g.name.toLowerCase() === 'international');
    if (match) {
      ML_INTERNATIONAL_GROUP = match.id;
      console.log(`  ✅ International group ID resolved: ${match.id}`);
    }
  } catch (e) {
    console.warn(`  ⚠️  Could not resolve International group ID: ${e.message}`);
  }
  return ML_INTERNATIONAL_GROUP;
}
const SHOPIFY_TOKEN      = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_STORE      = process.env.SHOPIFY_STORE;
const PREVIEW_EMAIL      = cfg.OWNER_EMAIL;
const STORE_NAME         = cfg.STORE_NAME;
const STORE_URL          = cfg.STORE_URL;
const MODEL              = cfg.ANTHROPIC_MODEL;

const ML_API       = 'https://connect.mailerlite.com/api';
const STATE_FILE   = path.join(cfg.STATE_DIR, 'campaign-state.json');
const HISTORY_FILE = path.join(cfg.STATE_DIR, 'campaign-history.json');
if (!fs.existsSync(cfg.STATE_DIR)) fs.mkdirSync(cfg.STATE_DIR, { recursive: true });

// Brand assets
const BRAND_GREEN    = '#3F5F7F';
const BRAND_DARK     = '#222222';

// CLI flags
const GENERATE       = process.argv.includes('--generate');
const SCHEDULE       = process.argv.includes('--schedule');
const REVIEW         = process.argv.includes('--review');
const CLEANUP_SALES  = process.argv.includes('--cleanup-sales');
const REDO           = process.argv.includes('--redo');
const CHECK_FEEDBACK = process.argv.includes('--check-feedback');

// Parse --redo arguments: can be "wholesale", "retail", or "2", "2,4", etc.
let REDO_SEGMENT = '';
let REDO_NUMBERS = [];
if (REDO) {
  const redoArg = (process.argv[process.argv.indexOf('--redo') + 1] || '').toLowerCase();
  if (redoArg === 'wholesale' || redoArg === 'retail' || redoArg === 'international') {
    REDO_SEGMENT = redoArg;
  } else if (/^[\d,]+$/.test(redoArg)) {
    REDO_NUMBERS = redoArg.split(',').map(n => parseInt(n.trim(), 10)).filter(n => n > 0);
  }
}

// Parse --feedback "text"
const FEEDBACK_IDX = process.argv.indexOf('--feedback');
const REDO_FEEDBACK = FEEDBACK_IDX !== -1 ? process.argv[FEEDBACK_IDX + 1] || '' : '';

if (!GENERATE && !SCHEDULE && !REVIEW && !CLEANUP_SALES && !REDO && !CHECK_FEEDBACK) {
  console.log('Usage:');
  console.log('  node campaign-generator.js --generate                        Generate campaigns + email preview');
  console.log('  node campaign-generator.js --schedule                        Check for HOLD, then schedule sends');
  console.log('  node campaign-generator.js --redo 4                          Redo email #4 only');
  console.log('  node campaign-generator.js --redo 2,4                        Redo emails #2 and #4');
  console.log('  node campaign-generator.js --redo 4 --feedback "bulk only"   Redo #4 with specific feedback');
  console.log('  node campaign-generator.js --redo wholesale                  Redo all wholesale emails');
  console.log('  node campaign-generator.js --check-feedback                  Check the inbox for REDO replies, process them');
  console.log('  node campaign-generator.js --review                          Pull campaign stats for AI learning');
  console.log('  node campaign-generator.js --cleanup-sales                   Revert expired sale prices');
  process.exit(0);
}


// ══════════════════════════════════════════════════════════════════════════════
// Campaign Intelligence — dynamic signals that shape each week's campaigns
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Available campaign types — Claude picks dynamically based on context.
 * No round-robin. The AI decides what's optimal each week like a real marketing director.
 */
const CAMPAIGN_TYPES = [
  { type: 'product_spotlight',  goal: 'Direct sales',        template: 'PRODUCT HERO',  desc: 'Full-bleed product image hero. Deep dive on 1-2 products with benefit-focused copy and strong CTA.' },
  { type: 'educational',        goal: 'Authority + trust',   template: 'EDITORIAL',     desc: 'Magazine-style article sections. Lead with a tip/guide/myth-bust, tie products in naturally.' },
  { type: 'social_proof',       goal: 'Trust + conversion',  template: 'SOCIAL PROOF',  desc: 'Real customer reviews (verbatim, supplied by code from config/reviews.json) + aggregate rating if configured. Only offered when approved reviews exist.' },
  { type: 'urgency_scarcity',   goal: 'Immediate action',    template: 'URGENCY',       desc: 'Dark hero + amber accents. Only offered when the segment has a REAL end date this week (owner deadline or live discount expiry); copy must cite that date.' },
  { type: 'brand_story',        goal: 'Retention + loyalty', template: 'EDITORIAL',     desc: 'Behind the scenes, sourcing story, team spotlight, mission/values.' },
  { type: 'trend_newsjack',     goal: 'Relevance + opens',   template: 'EDITORIAL',     desc: 'Tie into trending news, viral topic, or industry development.' },
  { type: 'seasonal',           goal: 'Timely relevance',    template: 'GRID',          desc: '2-column multi-product grid. Holiday tie-in, seasonal wellness angle, gift guide.' },
  { type: 'restock_crosssell',  goal: 'Repeat purchases',    template: 'GRID',          desc: '2-column grid. "Time to restock?" or "Customers who bought X also love Y".' },
  { type: 'new_arrival',        goal: 'Excitement + traffic', template: 'PRODUCT HERO', desc: 'Full-bleed hero. New product launch, fresh batch, just-added items.' },
];

/**
 * Phase 1: Ask Claude to plan the week's campaign strategy.
 * Claude acts as a senior marketing director — decides how many emails per segment,
 * which types/templates to use, cadence, and why.
 * Returns { retail: [{type, rationale, send_day},...], wholesale: [...] }
 */
/**
 * Fetch campaigns already scheduled in the MailerLite outbox so the weekly
 * planner can space new sends around them (e.g. manual/off-cycle sends).
 * Segment is inferred from the pipeline's draft naming ("Retail — ...", etc.).
 */
async function getScheduledCampaigns() {
  try {
    const res = await mlRequest('GET', '/campaigns?filter[status]=ready&limit=50');
    const items = res?.data || [];
    return items.map(cp => {
      const nm = (cp.name || '').toLowerCase();
      const segment = nm.startsWith('international') ? 'international'
                    : nm.startsWith('wholesale') ? 'wholesale'
                    : nm.startsWith('retail') ? 'retail' : 'unknown';
      return {
        name: cp.name,
        segment,
        scheduledFor: cp.scheduled_for || cp.delivery_schedule?.date || null,
      };
    });
  } catch (e) {
    console.warn(`  ⚠️  Could not fetch scheduled campaigns from MailerLite: ${e.message}`);
    return [];
  }
}

async function planCampaignStrategy(salesData, products, holidays, discounts, intelligence, scheduledCampaigns = [], directives = null, deadlines = {}) {
  console.log('🧠 Phase 1: Asking Claude to plan this week\'s campaign strategy...');

  const history = loadHistory();
  const recentRetail = history.campaigns.filter(c => c.segment === 'retail').slice(-8);
  const recentWholesale = history.campaigns.filter(c => c.segment === 'wholesale').slice(-8);
  const recentInternational = history.campaigns.filter(c => c.segment === 'international').slice(-8);

  const perfSummary = buildPerformanceSummary();
  const { blogPosts, newProducts, customerInsights, industryNews, seasonal, unsubTrend, rating, reviews } = intelligence;

  // ── News gate: news-angle emails are RARE — at most 1 per calendar month across
  // ALL segments (owner's rule, 2026-07-21). If any trend_newsjack was generated in
  // the last 30 days, the type is removed from the pool entirely this week.
  const NEWS_COOLDOWN_DAYS = 30;
  const lastNewsjack = [...history.campaigns].reverse().find(c => c.campaignType === 'trend_newsjack' && c.generatedAt);
  const daysSinceNews = lastNewsjack ? (Date.now() - new Date(lastNewsjack.generatedAt).getTime()) / 86400000 : Infinity;
  const newsAllowed = daysSinceNews >= NEWS_COOLDOWN_DAYS;
  const availableTypes = newsAllowed ? CAMPAIGN_TYPES : CAMPAIGN_TYPES.filter(t => t.type !== 'trend_newsjack');
  if (!newsAllowed) console.log(`   🚫 trend_newsjack OFF this week (last news email ${Math.floor(daysSinceNews)} day(s) ago — 30-day cooldown)`);

  // ── Type rotation gate (programmatic, mirrors the news gate): each segment's
  // pool excludes that segment's OWN last-2 campaign types, so no segment runs
  // the same template three weeks straight. Falls back to the full pool if the
  // exclusion would leave fewer than 3 choices.
  const lastTypesFor = (seg) => history.campaigns.filter(c => c.segment === seg).slice(-2).map(c => c.campaignType).filter(Boolean);
  // ── Honesty gates (hard, applied before rotation):
  //   social_proof     → only if enough real, approved reviews exist (never generated)
  //   urgency_scarcity → only if this segment has a REAL deadline this week
  const honestTypesFor = (seg) => availableTypes.filter(t =>
    (t.type !== 'social_proof'     || (reviews || []).length >= MIN_REVIEWS_FOR_SOCIAL_PROOF) &&
    (t.type !== 'urgency_scarcity' || !!deadlines[seg]));
  const poolFor = (seg) => {
    const honest = honestTypesFor(seg);
    const excluded = new Set(lastTypesFor(seg));
    const pool = honest.filter(t => !excluded.has(t.type));
    return pool.length >= 3 ? pool : honest;
  };
  const segmentPools = { retail: poolFor('retail'), wholesale: poolFor('wholesale'), international: poolFor('international') };
  const poolStr = (seg) => segmentPools[seg].map(t => `• ${t.type} → ${t.template} layout | Goal: ${t.goal} | ${t.desc}`).join('\n');

  // ── Novelty: products NOT featured in any campaign in the last 4 weeks.
  // Uses featuredProducts recorded in history; falls back to subject-word
  // mentions for entries that predate the featuredProducts field.
  const catalogForNovelty = products._fullCatalog || products;
  const cutoff28 = Date.now() - 28 * 86400000;
  const recent28 = history.campaigns.filter(c => c.generatedAt && new Date(c.generatedAt).getTime() >= cutoff28);
  const featured28 = new Set();
  for (const c of recent28) for (const f of c.featuredProducts || []) featured28.add(String(f).toLowerCase());
  const subjectBlob28 = recent28.map(c => c.subject || '').join(' ').toLowerCase();
  const mentionedInSubjects = (title) => {
    const ws = String(title).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3);
    if (!ws.length) return false;
    return ws.filter(w => subjectBlob28.includes(w)).length >= Math.min(2, ws.length);
  };
  const notFeaturedRecently = catalogForNovelty
    .filter(p => p.image && p.title)
    .filter(p => {
      const t = p.title.toLowerCase();
      for (const f of featured28) { if (f.includes(t) || t.includes(f)) return false; }
      return !mentionedInSubjects(p.title);
    })
    .slice(0, 10)
    .map(p => p.title);

  const recentRetailStr = recentRetail.length
    ? recentRetail.map(c => `  - [${c.campaignType || '?'}] "${c.subject}" → ${c.openRate?.toFixed(1) || '?'}% open, ${c.clickRate?.toFixed(1) || '?'}% click${c.promoCode ? `, promo: ${c.promoCode}` : ''}`).join('\n')
    : '  (no history yet)';
  const recentWholesaleStr = recentWholesale.length
    ? recentWholesale.map(c => `  - [${c.campaignType || '?'}] "${c.subject}" → ${c.openRate?.toFixed(1) || '?'}% open, ${c.clickRate?.toFixed(1) || '?'}% click${c.promoCode ? `, promo: ${c.promoCode}` : ''}`).join('\n')
    : '  (no history yet)';
  const recentInternationalStr = recentInternational.length
    ? recentInternational.map(c => `  - [${c.campaignType || '?'}] "${c.subject}" → ${c.openRate?.toFixed(1) || '?'}% open, ${c.clickRate?.toFixed(1) || '?'}% click${c.promoCode ? `, promo: ${c.promoCode}` : ''}`).join('\n')
    : '  (no history yet)';

  const directivesBlock = directives ? `
═══ OWNER'S STEER FOR THIS WEEK ═══
The owner left direction for this week. It takes priority for WHAT each segment features — you still decide campaign types, templates, cadence and design. If a segment's steer says "skip", plan ZERO emails for that segment.
${directives.retail ? `- RETAIL: ${directives.retail}\n` : ''}${directives.wholesale ? `- WHOLESALE: ${directives.wholesale}\n` : ''}${directives.international ? `- INTERNATIONAL: ${directives.international}\n` : ''}${directives.notes ? `- NOTES: ${directives.notes}\n` : ''}` : '';

  const deadlineLines = ['retail', 'wholesale', 'international']
    .map(seg => deadlines[seg] ? `  - ${seg.toUpperCase()}: ends ${deadlines[seg].date} (${deadlines[seg].source})` : `  - ${seg.toUpperCase()}: none — no urgency_scarcity, no countdown/"last chance" framing`)
    .join('\n');

  const strategyPrompt = `You are a senior email marketing director for ${STORE_NAME} (${STORE_URL}), a premium botanical / wellness ecommerce brand + B2B wholesale.

Your job: Plan THIS WEEK's email campaign strategy. Decide how many emails to send per segment, which campaign types/templates to use, and the send cadence. Think like you're running a $200/hr consultancy — every decision backed by data and strategic reasoning.

═══ YOUR TEMPLATE POOL (PER SEGMENT — HARD CONSTRAINT) ═══
Each segment's pool below already EXCLUDES that segment's last 2 campaign types (forced rotation). Only pick campaign types from the segment's OWN pool.
RETAIL pool:
${poolStr('retail')}
WHOLESALE pool:
${poolStr('wholesale')}
INTERNATIONAL pool:
${poolStr('international')}
${newsAllowed ? '' : '(trend_newsjack is NOT available this week — a news-angle email already went out within the last 30 days. Do not plan any news-based email.)'}

═══ CURRENT DATA ═══
Sales (90d): ${salesData.orderCount} orders | $${salesData.totalRevenue} revenue | $${salesData.avgOrderValue} AOV
Top sellers: ${salesData.topProducts.slice(0, 6).map(p => `${p.name} ($${p.revenue})`).join(', ')}
${salesData.trendingProducts?.length ? `Trending this week (WoW revenue): ${salesData.trendingProducts.join(', ')}` : ''}
Products available: ${products.length} with images
${discounts.length ? `Active promos: ${discounts.map(d => d.label).join(', ')}` : 'No active promos running'}
${holidays.length ? `Upcoming holidays: ${holidays.join(', ')}` : 'No upcoming holidays'}
Season: ${seasonal.season} — angles: ${seasonal.angles.join(', ')}
${rating ? `Store rating (from ${rating.source}): ${rating.value}/5 (${rating.count} reviews)` : ''}
Approved real customer reviews on file: ${(reviews || []).length}
${newProducts.length ? `New arrivals (14d): ${newProducts.map(p => p.title).join(', ')}` : 'No new products recently'}
${blogPosts.length ? `Recent blog posts: ${blogPosts.map(b => `"${b.title}"`).join(', ')}` : 'No recent blog posts'}
${customerInsights.totalBuyers > 0 ? `Repeat rate: ${customerInsights.repeatRate}% | Top reorders: ${customerInsights.topReorders.join(', ')}` : ''}
${industryNews.length ? `Industry news: ${industryNews.slice(0, 3).map(n => n.title).join('; ')}` : ''}
${unsubTrend || ''}
${perfSummary}

═══ RECENT CAMPAIGNS — RETAIL ═══
${recentRetailStr}

═══ RECENT CAMPAIGNS — WHOLESALE ═══
${recentWholesaleStr}

═══ RECENT CAMPAIGNS — INTERNATIONAL ═══
${recentInternationalStr}

═══ ALREADY SCHEDULED IN THE OUTBOX — HARD CONSTRAINTS ═══
${scheduledCampaigns.length
  ? scheduledCampaigns.map(sc => `  - [${sc.segment}] "${sc.name}" → sends ${sc.scheduledFor || 'date unknown'}`).join('\n')
  : '  (nothing currently scheduled)'}
These campaigns ALREADY EXIST and WILL send — they are not suggestions:
- NEVER plan a new send for a segment within 2 days of that segment's already-scheduled send above.
- Count each one toward that segment's weekly email total. If a segment already has a send queued this week, plan FEWER new emails for it (often zero).
- Do not duplicate the topic/angle of an already-scheduled campaign.
${directivesBlock}
═══ REAL DEADLINES THIS WEEK (urgency is ONLY allowed where a date is listed) ═══
${deadlineLines}

═══ FRESH ANGLES REQUIRED — NOVELTY ═══
Products NOT featured in any campaign in the last 4 weeks:
${notFeaturedRecently.length ? notFeaturedRecently.map(t => `  - ${t}`).join('\n') : '  (everything current has been featured recently — find a genuinely NEW angle instead)'}
${holidays.length ? `Upcoming calendar hooks: ${holidays.join(', ')}` : 'No holiday hooks in the next 35 days — lean on product novelty and seasonal angles.'}
Unless the owner's steer dictates the products, at least ONE email this week must use a hero product from the not-featured list above. Do NOT default to the same top sellers every week.

═══ STRATEGIC RULES ═══
- Decide 1-3 emails per segment per week. NOT always the same number.
  - 1 email: quiet week, nothing compelling, list needs rest
  - 2 emails: standard week with a clear angle + follow-up or complementary send
  - 3 emails: major event (holiday, big launch, Black Friday) — use sparingly to avoid fatigue
- Each email in a sequence should have a DIFFERENT campaign type/template
- Consider email fatigue — if recent campaigns had high unsubscribes, pull back
- Sequence logic matters: e.g. educational → product spotlight makes sense (educate then sell). Urgency → urgency does NOT.
- Wholesale gets FEWER emails than retail typically (1 per week unless something specific warrants 2)
- International gets EXACTLY 1 email per week. This segment is B2B wholesale buyers OUTSIDE the US (Europe & elsewhere): distributors and bulk buyers. US-only holidays (July 4th, Thanksgiving, Memorial Day) mean little to them — use globally relevant angles (new season, new batches, bulk availability, product quality, regional market trends) instead. International campaigns may ONLY advertise the international-eligible product lines shown in their product pool. All quantities metric (kg), framed at export scale. Voice: source-direct (new season's stock, fresh batch, direct from the source).
- NO FEAR-BASED ANGLES (hard rule): never build an email around news, policy changes or deadlines as a reason to buy. No "stock up before it changes" style urgency. This applies to subjects, preview text, and body copy alike.
- NO FABRICATED URGENCY: only plan urgency_scarcity where REAL DEADLINES lists a date for that segment. Never invent scarcity ("only 3 left", "selling fast") or deadlines.
- NO FABRICATED SOCIAL PROOF: social_proof campaigns render ONLY real reviews supplied by code. Never plan around invented customer stories.
- News-angle emails (trend_newsjack) are RARE: at most ONE per calendar month across ALL segments combined, and only for positive consumer-interest news (culture, lifestyle, seasonal trends, product innovation) — never regulatory/legal news. When in doubt, pick a different campaign type.
- VARIETY (HARD RULE): Each week's emails must feel fresh. Do NOT reuse the hero topic, theme, or subject-line angle of ANY campaign in the RECENT CAMPAIGNS lists above unless the owner's steer explicitly asks for it. If last week's retail hero was "X is back in stock", this week needs a genuinely different story — not the same product with a new headline.
- Don't repeat the same campaign type used in the last 2 campaigns for that segment unless there's a compelling reason
- Promo strategy: don't discount every week. If last campaign had a promo, this one probably shouldn't.
- Space sends at least 2 days apart within a segment

═══ OUTPUT (JSON only) ═══
{
  "week_strategy": "2-3 sentence high-level rationale for this week's approach",
  "retail": [
    {
      "campaign_type": "one of the types listed in YOUR TEMPLATE POOL above",
      "send_day": "Tuesday|Wednesday|Thursday|Friday|Saturday",
      "rationale": "1 sentence: why this type, this day",
      "include_promo": true/false,
      "promo_notes": "optional: type of promo to create if include_promo is true"
    }
  ],
  "wholesale": [
    {
      "campaign_type": "one of the 9 types",
      "send_day": "Tuesday|Wednesday|Thursday",
      "rationale": "1 sentence",
      "include_promo": true/false,
      "promo_notes": "optional"
    }
  ],
  "international": [
    {
      "campaign_type": "one of the 9 types",
      "send_day": "Tuesday|Wednesday|Thursday",
      "rationale": "1 sentence",
      "include_promo": true/false,
      "promo_notes": "optional"
    }
  ]
}

Return ONLY valid JSON. Be decisive. Data-driven. No filler.`;

  const msg = await claude.messages.create({
    model:      MODEL,
    max_tokens: 1200,
    messages:   [{ role: 'user', content: strategyPrompt }],
  });

  const raw = msg.content[0].text.trim();
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error(`Claude strategy did not return valid JSON:\n${raw}`);
  const strategy = JSON.parse(json);

  // Enforce the per-segment rotation pools on whatever the model returned —
  // an excluded (or unknown) type is swapped to the first allowed pool type.
  for (const seg of ['retail', 'wholesale', 'international']) {
    const pool = segmentPools[seg] || availableTypes;
    for (const e of strategy[seg] || []) {
      if (e && e.campaign_type && !pool.some(t => t.type === e.campaign_type)) {
        const fallback = (pool[0] || CAMPAIGN_TYPES[0]).type;
        console.warn(`   🔁 ${seg}: planned type "${e.campaign_type}" is excluded by rotation — using "${fallback}" instead`);
        e.campaign_type = fallback;
      }
    }
  }

  console.log(`   📋 Strategy: ${strategy.week_strategy}`);
  console.log(`   📬 Retail: ${strategy.retail.length} email(s) — ${strategy.retail.map(e => e.campaign_type).join(', ')}`);
  console.log(`   📬 Wholesale: ${strategy.wholesale.length} email(s) — ${strategy.wholesale.map(e => e.campaign_type).join(', ')}`);
  if (strategy.international?.length) console.log(`   📬 International: ${strategy.international.length} email(s) — ${strategy.international.map(e => e.campaign_type).join(', ')}`);

  return strategy;
}

/**
 * Fetch recently published blog posts from Shopify for cross-promotion.
 */
async function getRecentBlogPosts() {
  try {
    const blogId = process.env.SHOPIFY_BLOG_ID;
    if (!blogId) return [];
    const since  = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const data   = await shopifyGet(`blogs/${blogId}/articles.json?created_at_min=${since}&limit=5&fields=title,handle,summary_html,published_at`);
    return (data.articles || []).map(a => ({
      title: a.title,
      url:   `${STORE_URL}/blogs/${cfg.BLOG_HANDLE}/${a.handle}`,
      date:  a.published_at?.split('T')[0],
    }));
  } catch { return []; }
}

/**
 * Detect newly added products in Shopify (last 14 days).
 */
async function getNewProducts() {
  try {
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const data  = await shopifyGet(`products.json?created_at_min=${since}&limit=10&fields=title,handle,images,variants`);
    return (data.products || []).map(p => ({
      title: p.title,
      url:   `${STORE_URL}/products/${p.handle}`,
      image: p.images?.[0]?.src || null,
      price: p.variants?.[0]?.price || null,
    }));
  } catch { return []; }
}

/**
 * Calculate repeat purchase / customer behavior signals from Shopify.
 */
async function getCustomerInsights() {
  try {
    const since  = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const data   = await shopifyGet(`orders.json?status=any&financial_status=paid&created_at_min=${since}&limit=250&fields=email,created_at,total_price,line_items`);
    const orders = data.orders || [];

    // Repeat purchase rate
    const buyers = {};
    for (const o of orders) {
      if (!o.email) continue;
      const em = o.email.toLowerCase();
      buyers[em] = (buyers[em] || 0) + 1;
    }
    const totalBuyers  = Object.keys(buyers).length;
    const repeatBuyers = Object.values(buyers).filter(c => c > 1).length;
    const repeatRate   = totalBuyers ? ((repeatBuyers / totalBuyers) * 100).toFixed(1) : 0;

    // Most reordered products (products bought by repeat customers)
    const reorderProducts = {};
    for (const o of orders) {
      if (!o.email || buyers[o.email.toLowerCase()] < 2) continue;
      for (const item of o.line_items || []) {
        reorderProducts[item.title] = (reorderProducts[item.title] || 0) + 1;
      }
    }
    const topReorders = Object.entries(reorderProducts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name} (${count}x)`);

    return { repeatRate, repeatBuyers, totalBuyers, topReorders };
  } catch {
    return { repeatRate: 0, repeatBuyers: 0, totalBuyers: 0, topReorders: [] };
  }
}

/**
 * Fetch trending industry news via Google News RSS (queries from NEWS_QUERIES).
 */
async function getIndustryNews() {
  try {
    // NOTE (owner's rule 2026-07-21): no regulatory/compliance searches. News feeds
    // the planner for RARE positive newsjacks only — never legal/regulatory angles.
    const searches = cfg.NEWS_QUERIES;
    if (!searches.length) return [];
    const query    = searches[Math.floor(Math.random() * searches.length)];
    const res      = await fetch(`https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`);
    if (!res.ok) return [];

    const xml = await res.text();
    // Simple XML parse for title + link
    const items = [];
    const matches = xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<pubDate>([\s\S]*?)<\/pubDate>[\s\S]*?<\/item>/g);
    // Drop regulatory / legal / fear-angle headlines entirely — they must never
    // reach the planner or the content model (owner's rule 2026-07-21).
    const BLOCKED_NEWS = /regulat|compliance|legislat|congress|senate|\bban(s|ned)?\b|\bbill\b|\blaw(s)?\b|legal|illegal|fda|crackdown|deadline|enforc|prohibit|lawsuit|court|hearing|loophole/i;
    for (const m of matches) {
      const title = m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      if (BLOCKED_NEWS.test(title)) continue;
      items.push({
        title,
        url:   m[2].trim(),
        date:  m[3].trim(),
      });
      if (items.length >= 5) break;
    }
    return items;
  } catch { return []; }
}

/** ISO week number (1-53) — used to rotate weekly variety signals. */
function getISOWeek(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

/**
 * Get seasonal wellness angle based on current month.
 */
function getSeasonalContext() {
  const month = new Date().getMonth();  // 0-indexed
  const seasons = {
    // Winter (Dec-Feb): comfort, self-care, gifting
    11: { season: 'winter', angles: ['holiday stress relief', 'winter wellness bundle', 'cozy night in', 'gift ideas'] },
    0:  { season: 'winter', angles: ['New Year reset', 'winter self-care', 'winter skincare', 'resolution wellness'] },
    1:  { season: 'winter', angles: ["Valentine's self-care", 'winter blues relief', 'couples wellness'] },
    // Spring (Mar-May): renewal, energy, outdoors
    2:  { season: 'spring', angles: ['spring reset', 'outdoor activity prep', 'new batch season'] },
    3:  { season: 'spring', angles: ['spring cleaning your wellness', 'Earth Day sustainability', 'garden season'] },
    4:  { season: 'spring', angles: ["Mother's Day gifts", 'outdoor season prep', 'summer body wellness'] },
    // Summer (Jun-Aug): active, outdoor, travel
    5:  { season: 'summer', angles: ["Father's Day gifts", 'summer travel essentials', 'active recovery', 'outdoor lifestyle'] },
    6:  { season: 'summer', angles: ['July 4th celebration', 'summer heat', 'beach day essentials', 'travel-size picks'] },
    7:  { season: 'summer', angles: ['back to school stress', 'end-of-summer deals', 'vacation wind-down'] },
    // Fall (Sep-Nov): comfort, harvest, prep
    8:  { season: 'fall', angles: ['fall comfort season', 'Labor Day deals', 'back to routine wellness'] },
    9:  { season: 'fall', angles: ['harvest season', 'Halloween specials', 'autumn wind-down', 'cozy weather rituals'] },
    10: { season: 'fall', angles: ['Black Friday preview', 'holiday gift guide prep', 'Thanksgiving gratitude', 'winter prep'] },
  };
  const base = seasons[month] || { season: 'unknown', angles: [] };
  // Rotate which angles lead (and drop one) by ISO week, so the planner sees a
  // different subset each week instead of the exact same list all month.
  if (base.angles.length > 2) {
    const rot = getISOWeek() % base.angles.length;
    const rotated = base.angles.slice(rot).concat(base.angles.slice(0, rot));
    return { season: base.season, angles: rotated.slice(0, base.angles.length - 1) };
  }
  return base;
}

/**
 * Analyze unsubscribe trends — if recent campaigns had high unsubscribes, flag it.
 */
function getUnsubscribeTrend() {
  const history = loadHistory();
  const recent  = history.campaigns.filter(c => c.sent > 0).slice(-6);
  if (recent.length < 3) return null;

  const avgUnsub = recent.reduce((s, c) => s + (c.unsubscribes || 0), 0) / recent.length;
  const last     = recent[recent.length - 1];

  if (last.unsubscribes > avgUnsub * 2 && last.unsubscribes > 2) {
    return `⚠️ Last campaign "${last.subject}" (${last.segment}) had ${last.unsubscribes} unsubscribes — ${(avgUnsub).toFixed(1)}x avg. Consider softer approach this week.`;
  }
  return null;
}

/**
 * Reviews source — config/reviews.json (optional). Holds an OPTIONAL aggregate
 * rating and a list of REAL customer reviews, exported verbatim from the store's
 * review platform (official export/API). Nothing here is ever generated or
 * scraped; if the file is missing or empty, rating strips and the social_proof
 * campaign type are simply omitted.
 *
 *   { "aggregate": { "value": 4.8, "count": 120, "source": "Your review platform", "url": "https://..." },
 *     "reviews": [ { "quote": "verbatim text", "author_label": "Verified buyer", "rating": 5,
 *                    "source": "Your review platform", "date": "2026-05-01", "product": "optional" } ] }
 */
const MIN_REVIEWS_FOR_SOCIAL_PROOF = 2;

function loadReviewsSource() {
  const file = path.join(cfg.CONFIG_DIR, 'reviews.json');
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* optional */ }

  // Aggregate rating: config file first, then env (REVIEW_RATING / REVIEW_COUNT). Omitted when absent.
  let rating = null;
  const agg = raw?.aggregate;
  if (agg && Number(agg.value) > 0 && Number(agg.count) > 0) {
    rating = { value: Number(agg.value), count: Number(agg.count), source: agg.source || 'customer reviews', url: agg.url || null };
  } else if (Number(process.env.REVIEW_RATING) > 0 && Number(process.env.REVIEW_COUNT) > 0) {
    rating = {
      value:  Number(process.env.REVIEW_RATING),
      count:  Number(process.env.REVIEW_COUNT),
      source: process.env.REVIEW_SOURCE || 'customer reviews',
      url:    process.env.REVIEW_PROFILE_URL || null,
    };
  }

  // Real reviews only: each needs verbatim text and a named source.
  const reviews = (Array.isArray(raw?.reviews) ? raw.reviews : [])
    .filter(r => r && typeof r.quote === 'string' && r.quote.trim() && r.source)
    .map(r => ({
      quote:        r.quote.trim(),
      author_label: r.author_label || 'Verified customer',
      rating:       Number(r.rating) > 0 ? Number(r.rating) : null,
      source:       r.source,
      date:         r.date || null,
      product:      r.product || null,
    }));

  return { rating, reviews };
}

/** Up to `max` real reviews, preferring ones about this email's featured products. */
function pickReviews(reviews, featuredNames = [], max = 3) {
  const names = featuredNames.map(n => String(n || '').toLowerCase()).filter(Boolean);
  const scored = reviews.map((r, i) => ({
    r, i,
    s: r.product && names.some(n => n.includes(String(r.product).toLowerCase()) || String(r.product).toLowerCase().includes(n)) ? 1 : 0,
  }));
  return scored.sort((a, b) => (b.s - a.s) || (a.i - b.i)).slice(0, max).map(x => x.r);
}

/**
 * Real deadlines per segment for this week. Sources (in order):
 *   1. weekly-directives.json  "deadlines": { "retail": "YYYY-MM-DD", ... }  (owner-set)
 *   2. an active Shopify discount with an ends_at in the future (retail only —
 *      store discount codes apply to the consumer storefront)
 * Returns { retail: {date, source} | null, wholesale: ..., international: ... }.
 */
function resolveDeadlines(directives, discounts) {
  const out = { retail: null, wholesale: null, international: null };
  const today = new Date().toISOString().slice(0, 10);
  const dl = directives?.deadlines || {};
  for (const seg of Object.keys(out)) {
    const d = typeof dl[seg] === 'string' ? dl[seg].slice(0, 10) : null;
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= today) out[seg] = { date: d, source: 'owner directive' };
  }
  if (!out.retail) {
    const live = (discounts || []).filter(x => x.endsAt && x.endsAt.slice(0, 10) >= today)
      .sort((a, b) => a.endsAt.localeCompare(b.endsAt))[0];
    if (live) out.retail = { date: live.endsAt.slice(0, 10), source: `active discount "${live.label}"` };
  }
  return out;
}

async function gatherCampaignIntelligence() {
  console.log('🧠 Gathering campaign intelligence...');

  const [blogPosts, newProducts, customerInsights, industryNews] = await Promise.all([
    getRecentBlogPosts(),
    getNewProducts(),
    getCustomerInsights(),
    getIndustryNews(),
  ]);
  const { rating, reviews } = loadReviewsSource();

  const seasonal     = getSeasonalContext();
  const unsubTrend   = getUnsubscribeTrend();

  console.log(`   📝 Recent blog posts: ${blogPosts.length}`);
  console.log(`   🆕 New products (last 14d): ${newProducts.length}`);
  console.log(`   🔁 Repeat purchase rate: ${customerInsights.repeatRate}%`);
  console.log(`   📰 Industry news items: ${industryNews.length}`);
  console.log(`   🌿 Season: ${seasonal.season}`);
  console.log(rating ? `   ⭐ Rating (${rating.source}): ${rating.value}/5 (${rating.count} reviews)` : '   ⭐ No aggregate rating configured — rating strips omitted');
  console.log(`   💬 Approved real reviews on file: ${reviews.length}${reviews.length < MIN_REVIEWS_FOR_SOCIAL_PROOF ? ' (social_proof disabled)' : ''}`);
  if (unsubTrend) console.log(`   ${unsubTrend}`);

  return { blogPosts, newProducts, customerInsights, industryNews, seasonal, unsubTrend, rating, reviews };
}


// ══════════════════════════════════════════════════════════════════════════════
// Shopify helpers
// ══════════════════════════════════════════════════════════════════════════════

async function shopifyGet(endpoint) {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/${endpoint}`, {
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
  });
  if (!res.ok) throw new Error(`Shopify ${res.status}: ${endpoint}`);
  return res.json();
}

async function getSalesData() {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const data  = await shopifyGet(
    `orders.json?status=any&financial_status=paid&created_at_min=${since}&limit=250&fields=created_at,total_price,line_items`
  );
  const orders = data.orders || [];

  const byDay          = { Sun: 0, Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0 };
  const dayNames       = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const productRevenue = {};
  let totalRevenue     = 0;

  for (const order of orders) {
    const d = new Date(order.created_at);
    byDay[dayNames[d.getDay()]] += parseFloat(order.total_price || 0);
    totalRevenue += parseFloat(order.total_price || 0);
    for (const item of order.line_items || []) {
      productRevenue[item.title] = (productRevenue[item.title] || 0) +
        parseFloat(item.price || 0) * (item.quantity || 1);
    }
  }

  const sortedDays  = Object.entries(byDay).sort((a, b) => a[1] - b[1]);
  const topProducts = Object.entries(productRevenue)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, rev]) => ({ name, revenue: rev.toFixed(2) }));

  // Week-over-week trending products — computed from the SAME 90d order pull
  // (no extra Shopify queries): last 7 days' revenue vs the 7 days before that.
  // Gives the planner a signal that actually changes week to week, instead of
  // the near-static 90-day totals it would otherwise anchor on.
  const nowMs = Date.now();
  const WEEK_MS = 7 * 86400000;
  const revThisWeek = {}, revPrevWeek = {};
  for (const order of orders) {
    const t = new Date(order.created_at).getTime();
    const bucket = t >= nowMs - WEEK_MS ? revThisWeek : (t >= nowMs - 2 * WEEK_MS ? revPrevWeek : null);
    if (!bucket) continue;
    for (const item of order.line_items || []) {
      bucket[item.title] = (bucket[item.title] || 0) + parseFloat(item.price || 0) * (item.quantity || 1);
    }
  }
  const trendingProducts = Object.keys(revThisWeek)
    .map(name => ({ name, thisWk: revThisWeek[name], prevWk: revPrevWeek[name] || 0 }))
    .sort((a, b) => (b.thisWk - b.prevWk) - (a.thisWk - a.prevWk))
    .slice(0, 5)
    .map(x => `${x.name} ($${x.thisWk.toFixed(0)} this week vs $${x.prevWk.toFixed(0)} prior week)`);

  return {
    orderCount:    orders.length,
    totalRevenue:  totalRevenue.toFixed(2),
    slowestDays:   sortedDays.slice(0, 2).map(d => d[0]),
    busiestDays:   sortedDays.slice(-2).map(d => d[0]),
    topProducts,
    trendingProducts,
    avgOrderValue: orders.length ? (totalRevenue / orders.length).toFixed(2) : '0'
  };
}

async function getTopProductsWithImages(topProductNames) {
  const data = await shopifyGet('products.json?status=active&limit=250&fields=id,title,handle,images,variants,tags');
  const all  = data.products || [];

  // Classify products by segment based on title/tags
  const isWholesaleProduct = (p) => {
    const t = (p.title || '').toLowerCase();
    const tags = (p.tags || '').toLowerCase();
    return t.includes('wholesale') || tags.includes('wholesale');
  };

  // Build variant info for a product — wholesale gets all variants with sizes, retail gets first price
  const buildVariants = (p, isWholesale) => {
    const variants = (p.variants || []);
    if (isWholesale && variants.length > 1) {
      // Return all variants so Claude can show bulk sizes/pricing
      return variants.map(v => ({
        id: v.id,
        title: v.title,  // e.g. "Small", "Case", "Bulk"
        price: v.price,
      }));
    }
    return variants.slice(0, 1).map(v => ({ id: v.id, title: v.title, price: v.price }));
  };

  // Build full catalog with ALL images (not just first) for variety
  const fullCatalog = all.map(p => {
    const isWS = isWholesaleProduct(p);
    return {
      id:     p.id,
      title:  p.title,
      handle: p.handle,
      url:    `${STORE_URL}/products/${p.handle}`,
      image:  p.images?.[0]?.src || null,
      images: (p.images || []).map(img => img.src),  // ALL product images
      price:  p.variants?.[0]?.price || null,
      variants: buildVariants(p, isWS),  // Full variant data for wholesale
      variantId: p.variants?.[0]?.id || null,
      isWholesale: isWS,
      tags: (p.tags || ''),
    };
  });

  // Match top sellers — return up to 6 for Claude to pick from
  const results = [];
  for (const name of topProductNames.slice(0, 6)) {
    const match = all.find(p =>
      p.title.toLowerCase().includes(name.toLowerCase().split(' ')[0]) ||
      name.toLowerCase().includes(p.title.toLowerCase().split(' ')[0])
    );
    if (match) {
      const isWS = isWholesaleProduct(match);
      results.push({
        id:     match.id,
        title:  match.title,
        handle: match.handle,
        url:    `${STORE_URL}/products/${match.handle}`,
        image:  match.images?.[0]?.src || null,
        images: (match.images || []).map(img => img.src),  // ALL product images
        price:  match.variants?.[0]?.price || null,
        variants: buildVariants(match, isWS),
        isWholesale: isWS,
      });
    }
  }
  // Stash full catalog on the array for promo engine access
  results._fullCatalog = fullCatalog;
  return results;
}

/**
 * Rank a segment's product pool so products matching the owner's steer/feedback
 * come FIRST, then unused products, then the rest — and only then cap the list.
 * Fixes the long-standing bias where .slice(0, 8) in catalog (creation) order
 * meant newer products (added Mar 2026) were never shown to the AI writer
 * while the oldest catalog items appeared weekly.
 */
function prioritizeProductsBySteer(pool, steerText = '', usedIds = new Set(), max = 8, recentlyFeatured = new Set()) {
  const words = (steerText || '').toLowerCase().match(/[a-z][a-z-]{3,}/g) || [];
  const stop = new Set(['this','that','with','make','look','like','real','life','none','show','must',
    'image','images','product','products','offerings','featured','visibly','stock','back','week',
    'email','emails','from','sheet','sheets','more','easy','read','facts','information','hero',
    'create','used','only','section','secondary','include','lead','theme','their','them','also',
    'week','later','coming','banner','teasing','specifics','dates','just','tease','per','rule',
    'standing','promo','season','harvest','actually','operation']);
  const terms = [...new Set(words.filter(w => !stop.has(w)))];
  const score = (p) => {
    const hay = `${p.title} ${p.handle} ${p.tags || ''}`.toLowerCase();
    return terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
  };
  // Demote products featured in campaigns over the last ~3 weeks (owner steer
  // still outranks this) so the capped window the writer sees rotates weekly
  // instead of being frozen in catalog order.
  const wasRecentlyFeatured = (p) => {
    const t = (p.title || '').toLowerCase();
    if (!t) return 0;
    for (const f of recentlyFeatured) { if (f.includes(t) || t.includes(f)) return 1; }
    return 0;
  };
  return pool
    .map((p, i) => ({ p, i, s: score(p), used: usedIds.has(p.id) ? 1 : 0, rf: wasRecentlyFeatured(p) }))
    .sort((a, b) => (b.s - a.s) || (a.rf - b.rf) || (a.used - b.used) || (a.i - b.i))
    .slice(0, max)
    .map(x => x.p);
}

/**
 * Link checker — every http(s) href in a built email must respond (<400).
 * Skips merge tags, Google Fonts, and any host matching LINK_CHECK_SKIP (e.g. a
 * review-profile host that blocks datacenter IPs). HEAD first, GET fallback.
 */
async function verifyEmailLinks(html) {
  const hrefs = [...new Set((html.match(/href="([^"]+)"/g) || [])
    .map(m => m.slice(6, -1))
    .filter(u => /^https?:\/\//i.test(u))
    .filter(u => !/fonts\.googleapis\.com|\{\$|%7B%24/.test(u))
    .filter(u => !(cfg.LINK_CHECK_SKIP && cfg.LINK_CHECK_SKIP.test(u))))];
  const storeHost = new URL(STORE_URL).host.replace(/^www\./, '');
  const broken = [];
  for (const url of hrefs) {
    try {
      const isStore = new URL(url).host.replace(/^www\./, '') === storeHost;
      // Store links get a full GET so we can verify the PAGE, not just the status
      let res = await fetch(url, { method: isStore ? 'GET' : 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15000) });
      if (!isStore && [403, 405, 501].includes(res.status)) {
        res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15000) });
      }
      if (res.status >= 400) { broken.push(`${url} → HTTP ${res.status}`); continue; }

      if (isStore) {
        // Soft-404 detection: a link that "loads" but redirects to the homepage or
        // renders a not-found page is just as broken as a hard 404.
        const reqPath   = new URL(url).pathname.replace(/\/+$/, '');
        const finalPath = new URL(res.url).pathname.replace(/\/+$/, '');
        if (reqPath !== '' && finalPath === '') {
          broken.push(`${url} → redirects to homepage (page doesn't exist)`); continue;
        }
        const body   = await res.text();
        const titleM = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const title  = titleM ? titleM[1].trim() : '';
        if (/(^|\b)(404|page not found|not found)(\b|$)/i.test(title) || /template-404|class="[^"]*\b404\b/.test(body.slice(0, 8000))) {
          broken.push(`${url} → loads a "page not found" page`); continue;
        }
      }
    } catch (e) {
      broken.push(`${url} → ${e.name === 'TimeoutError' ? 'timeout' : e.message}`);
    }
  }
  return { checked: hrefs.length, broken };
}

async function getActiveDiscounts() {
  try {
    const data = await shopifyGet('price_rules.json?limit=10');
    return (data.price_rules || [])
      .filter(r => !r.ends_at || new Date(r.ends_at) > new Date())
      .map(r => ({
        label:  `${r.title}: ${r.value_type === 'percentage' ? `${Math.abs(parseFloat(r.value))}%` : `$${Math.abs(parseFloat(r.value))}`} off${r.ends_at ? ` (ends ${r.ends_at.slice(0, 10)})` : ''}`,
        endsAt: r.ends_at || null,
      }))
      .slice(0, 3);
  } catch { return []; }
}


// ══════════════════════════════════════════════════════════════════════════════
// Shopify Promo Engine — dynamic discount codes + sale price management
// ══════════════════════════════════════════════════════════════════════════════

async function shopifyPost(endpoint, body) {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/${endpoint}`, {
    method:  'POST',
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Shopify POST ${endpoint}: ${res.status} — ${err.slice(0, 300)}`);
  }
  return res.json();
}

async function shopifyPut(endpoint, body) {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/${endpoint}`, {
    method:  'PUT',
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Shopify PUT ${endpoint}: ${res.status} — ${err.slice(0, 300)}`);
  }
  return res.json();
}

async function shopifyDelete(endpoint) {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/${endpoint}`, {
    method:  'DELETE',
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Shopify DELETE ${endpoint}: ${res.status}`);
  }
}

/**
 * Create a Shopify discount code with a price rule.
 * @param {Object} opts
 * @param {string} opts.code       - Discount code string (e.g. "SUMMER15")
 * @param {string} opts.type       - "percentage" or "fixed_amount"
 * @param {number} opts.value      - Discount value (e.g. -15 for 15% off). Must be negative.
 * @param {string} opts.endsAt     - ISO date string when code expires
 * @param {number} opts.usageLimit - Max total uses (0 = unlimited)
 * @param {string[]} opts.productIds - Specific product IDs, or empty for all products
 * @param {string[]} opts.collectionIds - Specific collection IDs, or empty for all
 * @param {number} opts.minPurchase - Minimum purchase amount (0 = none)
 * @returns {Object} { priceRuleId, discountCodeId, code }
 */
async function createDiscountCode(opts) {
  const {
    code,
    type = 'percentage',
    value = -10,
    endsAt,
    usageLimit = 0,
    productIds = [],
    collectionIds = [],
    minPurchase = 0,
  } = opts;

  // Determine target type
  let targetType = 'line_item';
  let targetSelection = 'all';
  let entitledProductIds = undefined;
  let entitledCollectionIds = undefined;

  if (productIds.length) {
    targetSelection = 'entitled';
    entitledProductIds = productIds;
  } else if (collectionIds.length) {
    targetSelection = 'entitled';
    entitledCollectionIds = collectionIds;
  }

  const startsAt = new Date().toISOString();

  // 1. Create price rule
  const priceRulePayload = {
    price_rule: {
      title:                  code,
      target_type:            targetType,
      target_selection:       targetSelection,
      allocation_method:      'across',
      value_type:             type,
      value:                  String(value),
      customer_selection:     'all',
      starts_at:              startsAt,
      ends_at:                endsAt || null,
      usage_limit:            usageLimit || null,
      once_per_customer:      true,
      prerequisite_subtotal_range: minPurchase > 0
        ? { greater_than_or_equal_to: String(minPurchase) }
        : undefined,
    },
  };

  if (entitledProductIds)    priceRulePayload.price_rule.entitled_product_ids    = entitledProductIds;
  if (entitledCollectionIds) priceRulePayload.price_rule.entitled_collection_ids = entitledCollectionIds;

  const prResult = await shopifyPost('price_rules.json', priceRulePayload);
  const priceRuleId = prResult.price_rule.id;

  // 2. Create discount code for this price rule
  const dcResult = await shopifyPost(`price_rules/${priceRuleId}/discount_codes.json`, {
    discount_code: { code: code.toUpperCase() }
  });

  return {
    priceRuleId,
    discountCodeId: dcResult.discount_code.id,
    code:           dcResult.discount_code.code,
  };
}

/**
 * Set sale prices on specific products or all products.
 * Sets compare_at_price to original price and reduces price by the discount.
 * @param {Object} opts
 * @param {number} opts.discountPercent - e.g. 15 for 15% off
 * @param {string[]} opts.productIds   - specific product IDs, or empty for all
 * @param {string} opts.endsAt         - ISO date for when to revert prices
 * @returns {Object} { productsUpdated, saleId, variants[] }
 */
async function createSalePrices(opts) {
  const { discountPercent, productIds = [], endsAt } = opts;

  // Fetch products to modify
  let products = [];
  if (productIds.length) {
    // Fetch specific products
    for (const id of productIds) {
      try {
        const data = await shopifyGet(`products/${id}.json?fields=id,title,variants`);
        if (data.product) products.push(data.product);
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
  } else {
    // Fetch all active products
    const data = await shopifyGet('products.json?status=active&limit=250&fields=id,title,variants');
    products = data.products || [];
  }

  const saleId   = `sale-${Date.now()}`;
  const variants = [];
  let updated    = 0;

  for (const product of products) {
    for (const variant of product.variants || []) {
      const originalPrice = parseFloat(variant.price);
      if (!originalPrice || originalPrice <= 0) continue;

      // Only set sale if not already on sale
      if (variant.compare_at_price && parseFloat(variant.compare_at_price) > originalPrice) continue;

      const salePrice = (originalPrice * (1 - discountPercent / 100)).toFixed(2);

      try {
        await shopifyPut(`variants/${variant.id}.json`, {
          variant: {
            id:               variant.id,
            compare_at_price: String(originalPrice),
            price:            salePrice,
          }
        });
        variants.push({
          variantId:     variant.id,
          productId:     product.id,
          productTitle:  product.title,
          originalPrice: String(originalPrice),
          salePrice,
        });
        updated++;
      } catch (e) {
        console.warn(`  ⚠️  Could not update variant ${variant.id} (${product.title}): ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // Save sale record for later cleanup
  const saleFile = path.join(cfg.STATE_DIR, 'active-sales.json');
  let activeSales = [];
  try { activeSales = JSON.parse(fs.readFileSync(saleFile, 'utf8')); } catch {}
  activeSales.push({
    saleId,
    createdAt:       new Date().toISOString(),
    endsAt:          endsAt || null,
    discountPercent,
    variants,
  });
  fs.writeFileSync(saleFile, JSON.stringify(activeSales, null, 2));

  return { productsUpdated: updated, saleId, variants };
}

/**
 * Revert sale prices — restore original prices from saved sale records.
 * Called automatically or via --cleanup-sales flag.
 */
async function cleanupExpiredSales() {
  const saleFile = path.join(cfg.STATE_DIR, 'active-sales.json');
  let activeSales = [];
  try { activeSales = JSON.parse(fs.readFileSync(saleFile, 'utf8')); } catch { return 0; }

  const now       = new Date();
  const expired   = activeSales.filter(s => s.endsAt && new Date(s.endsAt) <= now);
  const remaining = activeSales.filter(s => !s.endsAt || new Date(s.endsAt) > now);

  if (!expired.length) return 0;

  let reverted = 0;
  for (const sale of expired) {
    console.log(`🔄 Reverting sale "${sale.saleId}" (${sale.discountPercent}% off, expired ${sale.endsAt})...`);
    for (const v of sale.variants) {
      try {
        await shopifyPut(`variants/${v.variantId}.json`, {
          variant: {
            id:               v.variantId,
            price:            v.originalPrice,
            compare_at_price: null,
          }
        });
        reverted++;
        console.log(`  ✅ ${v.productTitle}: $${v.salePrice} → $${v.originalPrice}`);
      } catch (e) {
        console.warn(`  ⚠️  Could not revert ${v.variantId}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 200));
    }
  }

  fs.writeFileSync(saleFile, JSON.stringify(remaining, null, 2));
  return reverted;
}

/**
 * Execute a promo plan from Claude's campaign output.
 * Creates discount codes and/or sale prices in Shopify as needed.
 * @returns {Object|null} promo details to inject into the email
 */
async function executePromo(promoRequest, products) {
  if (!promoRequest || promoRequest.type === 'none') return null;

  console.log(`\n🏷️  Creating promo in Shopify: ${promoRequest.type}...`);

  // Calculate end date (default: 7 days). Anchored to the TARGET week's Monday,
  // not generation time — under Thursday-night generation a now-anchored 7-day
  // promo would expire mid-send-week, before Fri–Sun sends land.
  const durationDays = promoRequest.duration_days || 7;
  const promoAnchor = getTargetMondayET();
  const endsAt = new Date(promoAnchor.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();

  // Resolve product IDs if specific products are targeted
  let targetProductIds = [];
  if (promoRequest.target_products && promoRequest.target_products !== 'all') {
    // Match product names to IDs from our products list
    const targetNames = Array.isArray(promoRequest.target_products)
      ? promoRequest.target_products
      : [promoRequest.target_products];
    for (const name of targetNames) {
      const match = products.find(p =>
        p.title.toLowerCase().includes(name.toLowerCase()) ||
        name.toLowerCase().includes(p.title.toLowerCase().split(' ')[0])
      );
      if (match?.id) targetProductIds.push(match.id);
    }
  }

  const result = { code: null, saleId: null, details: '' };

  try {
    // Create discount code
    if (promoRequest.type === 'discount_code' || promoRequest.type === 'both') {
      const code = promoRequest.code || generatePromoCode(promoRequest.value, promoRequest.segment);
      const discountResult = await createDiscountCode({
        code,
        type:        promoRequest.value_type || 'percentage',
        value:       -(Math.abs(promoRequest.value || 10)),
        endsAt,
        usageLimit:  promoRequest.usage_limit || 0,
        productIds:  targetProductIds,
        minPurchase: promoRequest.min_purchase || 0,
      });
      result.code = discountResult.code;
      result.priceRuleId = discountResult.priceRuleId;
      console.log(`   ✅ Discount code created: ${discountResult.code} (${Math.abs(promoRequest.value)}% off, expires ${endsAt.split('T')[0]})`);
    }

    // Set sale prices on products
    if (promoRequest.type === 'sale_prices' || promoRequest.type === 'both') {
      const saleResult = await createSalePrices({
        discountPercent: Math.abs(promoRequest.value || 10),
        productIds:      targetProductIds,
        endsAt,
      });
      result.saleId = saleResult.saleId;
      console.log(`   ✅ Sale prices set on ${saleResult.productsUpdated} products (${Math.abs(promoRequest.value)}% off, reverts ${endsAt.split('T')[0]})`);
    }

    // Currency symbol goes BEFORE the number ("$30 off"), percent after ("10% off").
    result.details = `${promoRequest.value_type === 'fixed_amount' ? `$${Math.abs(promoRequest.value)}` : `${Math.abs(promoRequest.value)}%`} off` +
      (result.code ? ` with code ${result.code}` : '') +
      ` — ends ${new Date(endsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  } catch (e) {
    console.error(`   ❌ Promo creation failed: ${e.message}`);
    return null;
  }

  return result;
}

/**
 * Generate a memorable, on-brand promo code.
 */
function generatePromoCode(value, segment) {
  const prefixes = {
    retail:    [cfg.PROMO_PREFIX, 'GREEN', 'CHILL', 'VIBE'],
    wholesale: ['BULK', 'PARTNER', 'WHOLESALE', 'RESELLER', 'B2B'],
  };
  const pool   = prefixes[segment] || prefixes.retail;
  const prefix = pool[Math.floor(Math.random() * pool.length)];
  const val    = Math.abs(value || 10);
  const suffix = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `${prefix}${val}${suffix}`;
}


// ══════════════════════════════════════════════════════════════════════════════
// Upcoming holidays
// ══════════════════════════════════════════════════════════════════════════════

function getUpcomingHolidays() {
  const now  = new Date();
  const soon = new Date(Date.now() + 35 * 24 * 60 * 60 * 1000);
  const yr   = now.getFullYear();
  const holidays = [
    { name: "Mother's Day",      date: new Date(yr, 4, 11)  },
    { name: "Victoria Day",      date: new Date(yr, 4, 19)  },
    { name: "Memorial Day",      date: new Date(yr, 4, 26)  },
    { name: "Father's Day",      date: new Date(yr, 5, 15)  },
    { name: "Canada Day",        date: new Date(yr, 6, 1)   },
    { name: "Independence Day",  date: new Date(yr, 6, 4)   },
    { name: "Labor Day",         date: new Date(yr, 8, 1)   },
    { name: "Thanksgiving (CA)", date: new Date(yr, 9, 13)  },
    { name: "Halloween",         date: new Date(yr, 9, 31)  },
    { name: "Black Friday",      date: new Date(yr, 10, 28) },
    { name: "Cyber Monday",      date: new Date(yr, 11, 1)  },
    { name: "Christmas",         date: new Date(yr, 11, 25) },
    { name: "Valentine's Day",   date: new Date(yr + (now.getMonth() > 1 ? 1 : 0), 1, 14) },
  ];
  return holidays
    .filter(h => h.date >= now && h.date <= soon)
    .map(h => {
      const days = Math.round((h.date - now) / 864e5);
      return `${h.name} (${days} days away)`;
    });
}


// ══════════════════════════════════════════════════════════════════════════════
// Claude campaign writer
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Phase 2: Generate content for a single email based on the strategy plan.
 * Called once per email in the campaign plan.
 */
async function generateCampaign(segment, campaignType, emailPlan, salesData, products, holidays, discounts, intelligence, feedback = '', deadline = null) {
  const isRetail = segment === 'retail';
  const typeInfo = CAMPAIGN_TYPES.find(t => t.type === campaignType) || CAMPAIGN_TYPES[0];

  const productList = products.map(p => {
    // International: names only — reference pricing is NOT the website's, never expose site prices
    if (segment === 'international') {
      return `- ${p.title} | ID: ${p.id} → ${p.url}`;
    }
    // For wholesale products, show all variant sizes/prices so Claude uses bulk pricing
    if (!isRetail && p.variants?.length > 1) {
      const variantStr = p.variants.map(v => `${v.title}: $${v.price}`).join(' / ');
      return `- ${p.title} [${variantStr}] | ID: ${p.id} → ${p.url}`;
    }
    return `- ${p.title} ($${p.price}) | ID: ${p.id} → ${p.url}`;
  }).join('\n');

  const { blogPosts, newProducts, customerInsights, industryNews, seasonal, unsubTrend } = intelligence;

  let blogSection = '';
  if (blogPosts.length) {
    blogSection = `\nRECENT BLOG POSTS (cross-promote if relevant):\n${blogPosts.map(b => `- "${b.title}" → ${b.url}`).join('\n')}`;
  }

  let newProductSection = '';
  if (newProducts.length) {
    newProductSection = `\nNEW ARRIVALS (last 14 days — prioritize these):\n${newProducts.map(p => `- ${p.title}${p.price ? ` ($${p.price})` : ''} → ${p.url}`).join('\n')}`;
  }

  let customerSection = '';
  if (customerInsights.totalBuyers > 0) {
    customerSection = `\nCUSTOMER BEHAVIOR:\n- Repeat rate: ${customerInsights.repeatRate}% | Most reordered: ${customerInsights.topReorders.join(', ') || 'N/A'}`;
  }

  // News headlines only reach the content model for an explicit trend_newsjack —
  // every other campaign type must not be steered by news at all.
  let newsSection = '';
  if (industryNews.length && campaignType === 'trend_newsjack') {
    newsSection = `\nINDUSTRY NEWS:\n${industryNews.slice(0, 3).map(n => `- ${n.title}`).join('\n')}`;
  }

  let prompt = `You are a senior email marketing director creating a campaign for ${STORE_NAME} (${STORE_URL}). Your emails are VISUAL-FIRST — clean, modern, exciting. Every word earns its place. No filler. No walls of text.

BUSINESS: Premium botanical / wellness ecommerce + B2B wholesale.

HARD RULES (owner's standing orders — violating any of these gets the email rejected):
- No fear-based urgency tied to news or policy changes, in the subject, preview text, or body. Sell on quality, value, and enjoyment.
- NO FABRICATED SOCIAL PROOF: never write customer quotes, testimonials, reviews, star ratings, review counts, or "customers say" claims. Real reviews (if any) are inserted by code, not by you.
- NO FABRICATED URGENCY: ${deadline
    ? `this email has ONE real deadline — ${deadline.date} (${deadline.source}). You may reference that exact date. Do not invent any other deadline, stock count, or scarcity claim.`
    : 'this email has NO real deadline. Do not write countdowns, "last chance", "ends soon", "only X left", "selling fast", or any time-pressure language.'}
- LINKS: Only use product/collection/blog URLs EXACTLY as provided in the data below. Never invent, modify, or guess a URL. The wholesale store is ${STORE_URL}${cfg.WHOLESALE_PATH}.
- PRICES/DISCOUNTS: Dollar amounts always put the $ BEFORE the number ("$30 off", "$150"). Percent goes after the number ("10% off"). Never write "30$".

AUDIENCE: ${isRetail
  ? 'Retail consumers — enthusiasts and wellness buyers. Tone: confident, warm, slightly edgy. Think Glossier meets apothecary.'
  : `${segment === 'international'
      ? `INTERNATIONAL Wholesale B2B — distributors and bulk buyers OUTSIDE the US (mostly Europe). Tone: professional, direct, ROI-focused. Avoid US-centric holidays and slang. Never make claims about international shipping timelines or customs.
CRITICAL INTERNATIONAL PRODUCT RULES:
- ONLY advertise products from the PRODUCTS list below — it is pre-filtered by code to the international-eligible lines. Never mention or recommend any other product line.
- METRIC ONLY: all quantities in kilograms (kg). NEVER use pounds, lb, or oz.
- Speak in export-scale volumes. Frame ${STORE_NAME} as a high-volume supplier. Never frame small amounts.
- VOICE: source-direct. "This season's stock", "new batch", "direct from the source, no middlemen". The buyer should feel they are dealing directly with the source, not a reseller.
CRITICAL INTERNATIONAL PRICING RULES:
- NEVER quote, show, or reference website/Shopify prices. International orders use separate REFERENCE PRICING that is not listed on the website.
- Do not include any dollar amounts for products. Instead, direct buyers to request the current international price list / export quote.
- No discount codes for international (codes are tied to website prices, which do not apply).
- CTA language: "Request Price List", "Get Export Quote", "Talk Pricing" — never "Shop Now".`
      : 'Wholesale B2B — independent retailers and specialty shops. Tone: professional, direct, ROI-focused. They care about margins and reliability.'}
CRITICAL WHOLESALE RULES:
- ONLY feature products from the PRODUCTS list below. These are wholesale-specific products — do NOT reference or recommend retail/consumer products.
- Products show BULK variant pricing in brackets like [Tier 1: $X / Tier 2: $Y / Tier 3: $Z]. ALWAYS use these bulk prices in the email, NEVER the small-unit retail price. Show the range like "From $X" or list the bulk tiers.
- Emphasize bulk pricing, margin opportunities, and B2B value props (MOQs, reorder ease, consistent quality).
- Link to the wholesale store (${STORE_URL}${cfg.WHOLESALE_PATH}), never the consumer collection.
- NEVER make shipping promises or coverage claims — this is legally sensitive and factually inaccurate.
- Use B2B CTA language: "See Pricing", "Request Samples", "View Wholesale", "Place Order" — not "Shop Now" or "Buy".`}

═══ STRATEGY (decided by you in planning phase) ═══
Campaign Type: ${campaignType.toUpperCase()} — ${typeInfo.goal}
Template: ${typeInfo.template} layout — ${typeInfo.desc}
Strategic rationale: ${emailPlan.rationale}
Send day: ${emailPlan.send_day}
${emailPlan.include_promo ? `Include promo: YES — ${emailPlan.promo_notes || 'discount code'}` : 'Include promo: NO'}

═══ DATA ═══
Sales (90d): ${salesData.orderCount} orders | $${salesData.totalRevenue} revenue | $${salesData.avgOrderValue} AOV
Top sellers: ${salesData.topProducts.slice(0, 5).map(p => `${p.name} ($${p.revenue})`).join(', ')}
${discounts.length ? `Active promos: ${discounts.map(d => d.label).join(', ')}` : 'No active promos'}
${holidays.length ? `Upcoming: ${holidays.join(', ')}` : ''}
${customerSection}${blogSection}${newProductSection}${newsSection}
SEASON: ${seasonal.season} — angles: ${seasonal.angles.join(', ')}
${unsubTrend || ''}

PRODUCTS (pick 2-4 depending on template):
${productList || salesData.topProducts.slice(0, 6).map(p => `- ${p.name}`).join('\n')}

═══ CRITICAL: COPY RULES ═══
This email will be VISUAL — large product images, color blocks, modern layout.
Your copy must be EXTREMELY CONCISE:
- hero_headline: MAX 5 words. Bold. Punchy. No complete sentences.
- hero_subtext: MAX 10 words. One line.
- hook_line: MAX 15 words. One compelling sentence.
- Product taglines: MAX 8 words each. Benefit punch, not descriptions.
- NEVER write paragraphs. Every field is one SHORT line.
- Think billboard copywriting, not blog writing.
- NEVER make shipping promises or claims about shipping coverage (e.g. "ships to all 50 states", "free shipping nationwide"). This is legally sensitive.
- ONLY use product names that EXACTLY match products in the PRODUCTS list below. Do not invent or rename products.

═══ TEMPLATE REQUIREMENTS ═══
Your campaign type "${campaignType}" uses the ${typeInfo.template} template:
- product_spotlight / new_arrival → PRODUCT HERO: 2-3 featured_products, first = hero image
- educational / brand_story / trend_newsjack → EDITORIAL: MUST include editorial_sections (2-3 sections)
- seasonal / restock_crosssell → GRID: 3-4 featured_products, include grid_title
- urgency_scarcity → URGENCY: include urgency_badge; countdown_text ONLY if a real deadline is given above (cite that date), otherwise null
- social_proof → SOCIAL PROOF: do NOT write quotes — real reviews are inserted by code. Write the headline/hook around the products.
- ALL templates: also output "layout_variant" ("A", "B", or "C") — it varies hero treatment, accent palette, and product order within your template so the same template never looks identical two weeks running.

═══ OUTPUT (JSON only) ═══
{
  "campaign_type": "${campaignType}",
  "layout_variant": "A, B, or C — OPTIONAL visual knob: rotates the hero treatment, accent palette, and product order inside your template (A=classic image-led, B=dark color-block, C=light/alternate order). Pick one that differs from what recent sends likely used.",
  "campaign_rationale": "1-2 sentences: WHY this angle this week",
  "subject": "max 55 chars, punchy, specific, no emojis",
  "preview_text": "max 85 chars, complements subject",
  "hero_headline": "MAX 5 WORDS. Bold statement.",
  "hero_subtext": "MAX 10 words. Supporting line.",
  "hook_line": "MAX 15 words. One sentence that makes them want to scroll.",
  "featured_products": [
    {
      "name": "exact product name from the product list above",
      "tagline": "MAX 8 WORDS. Benefit-focused punch line.",
      "cta_text": "max 3 words (e.g. 'Shop Now', 'Get Yours', 'See Pricing')",
      "cta_url": "exact product URL from the list above"
    }
  ],
  ${campaignType === 'educational' || campaignType === 'brand_story' || campaignType === 'trend_newsjack'
    ? '"editorial_sections": [{"subhead": "4-6 words", "body": "1-2 sentences max"}, {"subhead": "heading", "body": "1-2 sentences"}],'
    : ''}
  ${campaignType === 'urgency_scarcity'
    ? `"urgency_badge": "2-3 words", "countdown_text": ${deadline ? `"one line that cites the real end date ${deadline.date}"` : 'null'},`
    : ''}
  ${campaignType === 'seasonal' || campaignType === 'restock_crosssell'
    ? '"grid_title": "e.g. Father\'s Day Picks",'
    : ''}
  "blog_callout": "one SHORT line or null",
  "promo_request": {
    "type": "${emailPlan.include_promo ? 'discount_code' : 'none'}",
    "value": ${emailPlan.include_promo ? 15 : 0},
    "value_type": "percentage",
    "target_products": "all",
    "duration_days": 7,
    "min_purchase": 0,
    "usage_limit": 0,
    "segment": "${segment}",
    "reasoning": "${emailPlan.include_promo ? emailPlan.promo_notes || 'strategic promo' : 'no promo this send'}"
  },
  "image_requests": [
    {
      "placement": "hero_banner|section_image|mood_shot|seasonal_graphic|accent_strip",
      "prompt": "Detailed visual description for AI image generation. Must be specific, vivid, and match the campaign mood.",
      "dimensions": "600x300 for banners/strips, 600x400 for section images, 600x600 for mood shots",
      "alt": "Descriptive alt text"
    }
  ]
}

═══ IMAGE GENERATION RULES ═══
DEFAULT: Request exactly 1 AI-generated image (hero_banner or mood_shot) for this email — a distinctive scene that gives THIS email its own visual identity so no two sends look alike. Product photos from Shopify remain the product visuals; the generated image sets the mood/theme (season, holiday, campaign angle).
- Skip the image (return []) ONLY if the layout is already visually dense for this send and an extra image would clutter it.
- Vary the scene week to week — check RECENT CAMPAIGNS and never repeat a similar visual concept twice in a row.
- NEVER request accent_strip images — they look like random gradients and hurt the design.
- Max 1 image per email.
- If the email features a specific product, the image must depict that product's TRUE physical form based on its name and description (e.g. a powder is shown as a powder, a pressed product as pressed, loose botanicals as loose). Never depict a different product type than the one featured, and never recycle last week's scene concept.
- Prompts must be hyper-specific: describe a real scene with real objects, colors, lighting, and composition. NOT abstract gradients or textures.
- NEVER request text overlays, logos, buttons, "Shop Now", UI elements, or leaf-icon clip art.
- NEVER make shipping promises or claims about coverage in any email content.

═══ PROMO RULES (if include_promo is true) ═══
- "discount_code" = coupon code at checkout. Best for trackable email exclusives.
- "sale_prices" = crossed-out prices in store. Best for sitewide urgency.
- "both" = code + sale prices. Only for major events.
- Retail: 10-20%. Wholesale: ALWAYS exactly 10% — never more (owner's rule). International: never include a promo code. 5-7 day duration standard. 2-3 for flash sales.

Be creative. Specific to real data. Zero generic filler. Zero paragraph-length fields.`;

  // Editorial rules (persistent owner feedback) + this email's creative concept
  try { prompt += buildRulesPromptBlock(cfg.CONFIG_DIR, cfg.STATE_DIR); } catch {}
  if (emailPlan.creative_concept) prompt += buildConceptPromptBlock(emailPlan.creative_concept);

  // Inject redo feedback if provided
  if (feedback) {
    prompt += `\n\n═══ CRITICAL: REDO FEEDBACK FROM THE BUSINESS OWNER ═══
The previous version of this email was rejected. The business owner provided this specific feedback:
"${feedback}"

You MUST address this feedback in the new version. This takes priority over other creative choices.`;
  }

  // Inject owner's weekly steer (initial generation) if the plan carries one
  if (emailPlan.owner_steer) {
    prompt += `\n\n═══ OWNER'S DIRECTION FOR THIS EMAIL ═══
"${emailPlan.owner_steer}"

Follow this direction — it takes priority over other topic/product choices. You still control structure, tone and design.`;
  }

  const msg = await claude.messages.create({
    model:      MODEL,
    max_tokens: 1800,
    messages:   [{ role: 'user', content: prompt }]
  });

  const raw  = msg.content[0].text.trim();
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error(`Claude did not return valid JSON:\n${raw}`);
  const parsed = JSON.parse(json);
  parsed._campaignType = campaignType;
  parsed._sendDay = emailPlan.send_day;
  // Code-level guardrails — never trust the model on these:
  //  - strip any model-written testimonials / quote fields (real reviews are attached later)
  //  - strip countdown copy when there is no real deadline
  delete parsed.testimonials;
  delete parsed.social_proof_line;
  if (!deadline) delete parsed.countdown_text;
  parsed._deadline = deadline || null;
  return parsed;
}


// Email templates moved to email-templates.js (per-campaign-type layouts)


// ══════════════════════════════════════════════════════════════════════════════
// MailerLite API
// ══════════════════════════════════════════════════════════════════════════════

async function mlRequest(method, endpoint, body) {
  const opts = {
    method,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${ML_API_KEY}`,
      'Accept':        'application/json',
    }
  };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);

  const res = await fetch(`${ML_API}${endpoint}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`MailerLite non-JSON (${res.status}): ${text.slice(0, 300)}`); }
  if (!res.ok) throw new Error(`MailerLite ${method} ${endpoint}: ${res.status} — ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

/**
 * Create a campaign draft in MailerLite. Returns the campaign object with id.
 */
async function createCampaignDraft(name, subject, previewText, html, groupId) {
  const body = {
    name,
    type: 'regular',
    emails: [{
      subject,
      from_name: cfg.FROM_NAME,
      from: cfg.FROM_EMAIL,
      content: html,
    }],
  };
  if (groupId) body.groups = [groupId];

  const result = await mlRequest('POST', '/campaigns', body);
  return result.data;
}

/**
 * Schedule a draft campaign for a specific date/time in Eastern Time.
 * dateStr: "2026-06-10", hour: 10, minute: 0
 */
async function scheduleCampaign(campaignId, dateStr, hour, minute) {
  // Convert Eastern Time to UTC (EDT = UTC-4 in summer, EST = UTC-5 in winter)
  // Use a simple heuristic: March-Nov = EDT (UTC-4), else EST (UTC-5)
  const month = parseInt(dateStr.split('-')[1], 10);
  const utcOffset = (month >= 3 && month <= 11) ? 4 : 5;
  const utcHour   = hour + utcOffset;

  // Handle day rollover
  let adjustedDate = dateStr;
  let adjustedHour = utcHour;
  if (utcHour >= 24) {
    adjustedHour = utcHour - 24;
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    adjustedDate = d.toISOString().slice(0, 10);
  }

  return mlRequest('POST', `/campaigns/${campaignId}/schedule`, {
    delivery: 'scheduled',
    schedule: {
      date:    adjustedDate,
      hours:   String(adjustedHour).padStart(2, '0'),
      minutes: String(minute).padStart(2, '0'),
    }
  });
}


// ══════════════════════════════════════════════════════════════════════════════
// State management (tracks campaign IDs between --generate and --schedule)
// ══════════════════════════════════════════════════════════════════════════════

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(data) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}
function clearState() {
  saveState({});
}

// ── Weekly directives (owner steer) ────────────────────────────────────────────
// Optional file: config/weekly-directives.json
// {
//   "week_of": "2026-07-13",           // Monday of the target week (ET); stale/future files are ignored
//   "retail": "free-text steer",       // omit a segment to leave it fully autonomous
//   "wholesale": "free-text steer",
//   "international": "free-text steer or 'skip'",
//   "notes": "optional general notes for the planner",
//   "deadlines": { "retail": "2026-07-19" }  // optional REAL end dates; the only way to unlock urgency
// }
// Directives steer WHAT each segment features. The planner still chooses
// campaign types, templates, cadence, structure and imagery dynamically.
const DIRECTIVES_FILE = path.join(cfg.CONFIG_DIR, 'weekly-directives.json');

// The week whose Monday is next to arrive, as an ET calendar date (carried in a
// local-midnight Date used only for its Y/M/D parts). Shared by the directives
// validator and all send-date math so both always agree on the target week.
function getTargetMondayET() {
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const target = new Date(nowET.getFullYear(), nowET.getMonth(), nowET.getDate());
  target.setDate(target.getDate() + ((8 - target.getDay()) % 7)); // next Monday (today if Monday)
  return target;
}

function loadWeeklyDirectives() {
  try {
    if (!fs.existsSync(DIRECTIVES_FILE)) return null;
    const d = JSON.parse(fs.readFileSync(DIRECTIVES_FILE, 'utf8'));
    if (!d || typeof d !== 'object' || !d.week_of) return null;
    const weekOf = new Date(`${d.week_of}T00:00:00-04:00`);
    if (isNaN(weekOf.getTime())) {
      console.warn('⚠️  weekly-directives.json: invalid week_of — ignoring file');
      return null;
    }
    // Target week = the week whose Monday is next to arrive (generation runs
    // Thursday night ET for the FOLLOWING Mon–Sun week; a Monday run targets
    // that same day).
    const target = getTargetMondayET();
    const targetMonday = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
    if (d.week_of !== targetMonday) {
      console.warn(`⚠️  weekly-directives.json is for week of ${d.week_of} but generating for week of ${targetMonday} (stale or future) — ignoring`);
      return null;
    }
    return d;
  } catch (e) {
    console.warn(`⚠️  weekly-directives.json unreadable (${e.message}) — continuing without steer`);
    return null;
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// Campaign history (performance learning loop)
// ══════════════════════════════════════════════════════════════════════════════

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return { campaigns: [] }; }
}
function saveHistory(data) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
}

// ── Variety enforcement (code-level anti-repetition) ──────────────────────────
// The prompt-level VARIETY rule proved unenforceable on its own (Aug 3: near-
// identical "<Product> Is Back" subjects two weeks running). These helpers
// give --generate a hard check against each segment's recent history.

/** Lowercased significant words of a string. */
function varietyWords(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
}

/** 0..1 similarity between two subjects using word + bigram overlap. */
function subjectSimilarity(a, b) {
  const wa = varietyWords(a), wb = varietyWords(b);
  if (!wa.length || !wb.length) return 0;
  const grams = (ws) => {
    const s = new Set(ws);
    for (let i = 0; i < ws.length - 1; i++) s.add(`${ws[i]} ${ws[i + 1]}`);
    return s;
  };
  const sa = grams(wa), sb = grams(wb);
  let hits = 0;
  for (const t of sa) if (sb.has(t)) hits++;
  return hits / Math.min(sa.size, sb.size);
}

/** Product titles featured in any campaign generated in the last N days. */
function recentlyFeaturedTitles(history, days = 21) {
  const cutoff = Date.now() - days * 86400000;
  const out = new Set();
  for (const c of history.campaigns || []) {
    if (!c.generatedAt || new Date(c.generatedAt).getTime() < cutoff) continue;
    for (const f of c.featuredProducts || []) out.add(String(f).toLowerCase());
  }
  return out;
}

/**
 * Check a drafted email against the segment's last 8 campaigns.
 * Returns human-readable violations (empty array = passes). A violation whose
 * topic the owner's steer explicitly demands is skipped — the steer wins.
 */
function checkVariety(content, segment, history, ownerSteer = '') {
  const problems = [];
  const recent = (history.campaigns || []).filter(c => c.segment === segment).slice(-8);
  const steer = String(ownerSteer || '').toLowerCase();
  const steerDemands = (txt) => {
    if (!steer) return false;
    const ws = varietyWords(txt);
    return ws.length > 0 && ws.filter(w => steer.includes(w)).length >= Math.min(2, ws.length);
  };

  // Subject/angle repetition vs the segment's last 8 subjects
  for (const c of recent) {
    if (!c.subject) continue;
    if (subjectSimilarity(content.subject, c.subject) >= 0.5 && !steerDemands(content.subject)) {
      problems.push(`subject "${content.subject}" repeats the angle of recent ${segment} send "${c.subject}"`);
      break;
    }
  }

  // Hero product repetition (uses featuredProducts recorded in history)
  const hero = content.featured_products?.[0]?.name;
  if (hero && !steerDemands(hero)) {
    const heroLc = hero.toLowerCase();
    for (const c of recent) {
      const prevHero = (c.featuredProducts || [])[0];
      if (!prevHero) continue;
      const pLc = String(prevHero).toLowerCase();
      if (pLc === heroLc || pLc.includes(heroLc) || heroLc.includes(pLc)) {
        problems.push(`hero product "${hero}" was already the hero of recent ${segment} send "${c.subject}"`);
        break;
      }
    }
  }
  return problems;
}

/**
 * Pull performance stats for a sent campaign from MailerLite.
 * GET /campaigns/{id} returns: sent, opens_count, clicks_count, unsubscribes_count, etc.
 */
async function getCampaignStats(campaignId) {
  try {
    const data = await mlRequest('GET', `/campaigns/${campaignId}`, null);
    const c = data.data;
    return {
      id:           c.id,
      name:         c.name,
      status:       c.status,
      sent:         c.stats?.sent         ?? c.emails?.[0]?.stats?.sent         ?? 0,
      opens:        c.stats?.opens_count  ?? c.emails?.[0]?.stats?.opens_count  ?? 0,
      clicks:       c.stats?.clicks_count ?? c.emails?.[0]?.stats?.clicks_count ?? 0,
      unsubscribes: c.stats?.unsubscribes_count ?? 0,
      openRate:     0,
      clickRate:    0,
    };
  } catch (e) {
    console.warn(`  ⚠️  Could not fetch stats for campaign ${campaignId}: ${e.message}`);
    return null;
  }
}

/**
 * Build a performance summary string to inject into the Claude prompt.
 * Shows last 8 campaigns with open/click rates and what worked vs. didn't.
 */
function buildPerformanceSummary() {
  const history = loadHistory();
  if (!history.campaigns?.length) return '';

  // Last 8 campaigns with stats
  const recent = history.campaigns
    .filter(c => c.sent > 0)
    .slice(-8);

  if (!recent.length) return '';

  // Calculate averages
  const avgOpen  = recent.reduce((s, c) => s + c.openRate,  0) / recent.length;
  const avgClick = recent.reduce((s, c) => s + c.clickRate, 0) / recent.length;

  // Identify best and worst performers
  const byOpen  = [...recent].sort((a, b) => b.openRate - a.openRate);
  const byClick = [...recent].sort((a, b) => b.clickRate - a.clickRate);

  let summary = `\nHISTORICAL PERFORMANCE (last ${recent.length} campaigns):
- Average open rate: ${avgOpen.toFixed(1)}% | Average click rate: ${avgClick.toFixed(1)}%\n`;

  // Best performers
  if (byOpen[0]?.openRate > 0) {
    summary += `\nBEST open rate: "${byOpen[0].subject}" (${byOpen[0].openRate.toFixed(1)}% opens, ${byOpen[0].segment})`;
  }
  if (byClick[0]?.clickRate > 0) {
    summary += `\nBEST click rate: "${byClick[0].subject}" (${byClick[0].clickRate.toFixed(1)}% clicks, ${byClick[0].segment})`;
  }

  // Worst performers (learn from these)
  if (recent.length >= 3 && byOpen[byOpen.length - 1]?.openRate >= 0) {
    const worst = byOpen[byOpen.length - 1];
    summary += `\nLOWEST open rate: "${worst.subject}" (${worst.openRate.toFixed(1)}% opens, ${worst.segment}) — AVOID this style`;
  }

  // Recent subject lines (so it doesn't repeat)
  const recentSubjects = recent.slice(-4).map(c => `  - "${c.subject}" (${c.segment}, ${c.openRate.toFixed(0)}% open)`);
  summary += `\n\nRECENT SUBJECT LINES (don't repeat similar angles):\n${recentSubjects.join('\n')}`;

  // Performance by campaign type
  const typeStats = {};
  for (const c of recent) {
    if (!c.campaignType) continue;
    if (!typeStats[c.campaignType]) typeStats[c.campaignType] = { opens: [], clicks: [], unsubs: [] };
    typeStats[c.campaignType].opens.push(c.openRate);
    typeStats[c.campaignType].clicks.push(c.clickRate);
    typeStats[c.campaignType].unsubs.push(c.unsubscribes || 0);
  }
  if (Object.keys(typeStats).length > 1) {
    summary += '\n\nPERFORMANCE BY CAMPAIGN TYPE:';
    for (const [type, stats] of Object.entries(typeStats)) {
      const avgO = stats.opens.reduce((a, b) => a + b, 0) / stats.opens.length;
      const avgC = stats.clicks.reduce((a, b) => a + b, 0) / stats.clicks.length;
      summary += `\n  ${type}: avg ${avgO.toFixed(1)}% opens, ${avgC.toFixed(1)}% clicks (${stats.opens.length} sends)`;
    }
  }

  // Add learning directives
  summary += `\n\nLEARNING: Study the open and click rates above. Learn from WHAT WORKED structurally (product-led vs story, clear offer, direct product link) — but NEVER reuse a past subject's wording, skeleton, or hero product. Copying a past winner's subject with new numbers or a swapped product name is a FAILURE MODE, not a win. Avoid patterns from the lowest performers. If a campaign type consistently underperforms, try a different approach.`;

  return summary;
}


// ══════════════════════════════════════════════════════════════════════════════
// Preview email to the owner
// ══════════════════════════════════════════════════════════════════════════════

function getTransporter() {
  return nodemailer.createTransport({
    host: cfg.SMTP_HOST, port: cfg.SMTP_PORT, secure: cfg.SMTP_PORT === 465,
    auth: { user: cfg.MAIL_USER, pass: cfg.MAIL_PASSWORD }
  });
}

/**
 * V2 preview email — handles dynamic campaign counts (1-3 per segment).
 * Shows strategy overview + individual email previews.
 */
async function sendPreviewEmail_v2(strategy, allCampaigns) {
  const transporter = getTransporter();
  const now = new Date();
  const DAY_MAP = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };

  // Build schedule table rows (numbered for redo references)
  const tableRows = allCampaigns.map((c, i) => {
    const sendDate = getNextWeekday(now, DAY_MAP[c.sendDay] ?? 3);
    const bgColor = i % 2 === 0 ? '#f9f9f9' : '#fff';
    return `
      <tr style="background:${bgColor}">
        <td style="padding:10px 14px;font-weight:bold;color:${BRAND_GREEN}">#${i + 1}</td>
        <td style="padding:10px 14px;font-weight:bold">${c.segment.charAt(0).toUpperCase() + c.segment.slice(1)}</td>
        <td style="padding:10px 14px;font-size:12px;color:#888">${c.campaignType}</td>
        <td style="padding:10px 14px;font-style:italic">${c.content.subject}${c.linkCheck ? (c.linkCheck.broken.length ? `<br><span style="color:#c0392b;font-size:11px;font-style:normal;font-weight:700">&#9888; ${c.linkCheck.broken.length} BROKEN LINK(S) — WILL NOT BE SCHEDULED until fixed (reply REDO): ${c.linkCheck.broken.join(' · ')}</span>` : `<br><span style="color:#3F5F7F;font-size:11px;font-style:normal">&#128279; ${c.linkCheck.checked} links verified</span>`) : ''}</td>
        <td style="padding:10px 14px">${sendDate} @ 10 AM ET</td>
        <td style="padding:10px 14px">${c.promo?.code || '—'}</td>
      </tr>`;
  }).join('');

  // Build preview sections for each email (numbered for redo references)
  const previewSections = allCampaigns.map((c, i) => `
    <div style="background:${BRAND_GREEN};color:#fff;padding:12px 18px;border-radius:8px 8px 0 0;margin-top:30px">
      <h3 style="margin:0;font-size:16px">
        Email #${i + 1} — ${c.segment.toUpperCase()} — ${c.campaignType} (${c.sendDay})
      </h3>
      <p style="margin:4px 0 0;font-size:12px;opacity:0.8">Reply "REDO ${i + 1}: your feedback" to regenerate this email</p>
    </div>
    <p style="font-size:13px;color:#666;margin:8px 0 8px;padding:0 4px">${c.content.campaign_rationale || ''}</p>
    ${c.varietyBlocked ? `<p style="font-size:12px;color:#fff;background:#c0392b;margin:0 0 8px;padding:8px 10px;border-radius:4px;font-weight:700">&#9940; HELD — still repeats recent sends after 4 rewrites; it will NOT be scheduled: ${(c.varietyWarnings || []).join(' &middot; ')} &mdash; reply REDO ${i + 1} to regenerate (a redo clears the hold).</p>` : ''}
    <div style="border:1px solid #ddd;border-radius:0 0 8px 8px;overflow:hidden;margin-bottom:30px">
      ${c.html}
    </div>
  `).join('');

  await transporter.sendMail({
    from:    cfg.MAIL_USER,
    to:      PREVIEW_EMAIL,
    subject: `[${STORE_NAME}] ${allCampaigns.length} Campaign(s) This Week — Review & Reply HOLD to Cancel`,
    html: `
      <div style="font-family:Helvetica,Arial,sans-serif;max-width:640px;margin:auto;color:#222222;padding:20px">
        <h2 style="color:${BRAND_GREEN};margin-top:0">This week's campaigns are ready</h2>

        <div style="background:#f0f7ee;border-left:4px solid ${BRAND_GREEN};padding:14px 18px;border-radius:0 8px 8px 0;margin:16px 0">
          <p style="margin:0;font-size:14px;color:#3a5a30">
            <strong>Strategy:</strong> ${strategy.week_strategy}
          </p>
        </div>

        <div style="background:#fff8e1;border-left:4px solid #f5a623;padding:14px 18px;border-radius:0 8px 8px 0;margin:16px 0">
          <p style="margin:0;font-size:14px;color:#6d4c00">
            <strong>How to approve / edit:</strong>
          </p>
          <ul style="margin:8px 0 0;padding-left:20px;font-size:13px;color:#6d4c00;line-height:1.7">
            <li><strong>All good?</strong> Do nothing — they auto-schedule Friday 5 PM ET.</li>
            <li><strong>Cancel all:</strong> Reply <code style="background:#fff;padding:2px 6px;border-radius:3px">HOLD</code></li>
            <li><strong>Redo one:</strong> Reply <code style="background:#fff;padding:2px 6px;border-radius:3px">REDO 4: only show wholesale bulk products with tier pricing</code></li>
            <li><strong>Redo multiple:</strong> Reply <code style="background:#fff;padding:2px 6px;border-radius:3px">REDO 2: more urgency tone<br>REDO 4: use different products</code></li>
          </ul>
          <p style="margin:8px 0 0;font-size:12px;color:#9a7a20">
            Use the email numbers (#1, #2, etc.) from below. Your feedback goes directly to the AI writer.
          </p>
        </div>

        <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:13px">
          <tr style="background:${BRAND_GREEN};color:#fff">
            <th style="padding:10px 14px;text-align:left">#</th>
            <th style="padding:10px 14px;text-align:left">Segment</th>
            <th style="padding:10px 14px;text-align:left">Type</th>
            <th style="padding:10px 14px;text-align:left">Subject</th>
            <th style="padding:10px 14px;text-align:left">Send</th>
            <th style="padding:10px 14px;text-align:left">Promo</th>
          </tr>
          ${tableRows}
        </table>

        ${previewSections}

        <hr style="border:none;border-top:1px solid #eee;margin:30px 0">
        <p style="font-size:12px;color:#999;text-align:center">
          Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET<br>
          ${allCampaigns.length} campaigns drafted in MailerLite &bull; Reply "HOLD" to cancel all
        </p>
      </div>
    `
  });
}

// Keep legacy function as alias for backward compat
async function sendPreviewEmail(retailContent, wholesaleContent, retailHtml, wholesaleHtml) {
  const allCampaigns = [
    { segment: 'retail', content: retailContent, html: retailHtml, promo: null, sendDay: 'Wednesday', campaignType: retailContent._campaignType || 'unknown' },
    { segment: 'wholesale', content: wholesaleContent, html: wholesaleHtml, promo: null, sendDay: 'Tuesday', campaignType: wholesaleContent._campaignType || 'unknown' },
  ];
  const strategy = { week_strategy: 'Standard weekly send — 1 retail + 1 wholesale' };
  return sendPreviewEmail_v2(strategy, allCampaigns);
}

// Send dates are anchored to the TARGET Mon–Sun week (the week whose Monday is
// next to arrive), NOT to "next occurrence of that weekday from today". Under
// Thursday-night generation, next-occurrence math would put a Saturday retail
// send 2 days out — BEFORE the target week — instead of 9 days out inside it.
// fromDate is kept for call-site compatibility but intentionally unused.
function targetWeekDateFor(targetDay) {
  const monday = getTargetMondayET();
  const offset = (targetDay - 1 + 7) % 7; // Mon=+0, Tue=+1 … Sat=+5, Sun=+6
  return new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + offset);
}

function getNextWeekday(fromDate, targetDay) {
  // targetDay: 0=Sun, 1=Mon, 2=Tue, 3=Wed, etc — display form
  const d = targetWeekDateFor(targetDay);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function getNextWeekdayDate(fromDate, targetDay) {
  // Returns "YYYY-MM-DD" of targetDay within the target Mon–Sun week
  const d = targetWeekDateFor(targetDay);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}


// ══════════════════════════════════════════════════════════════════════════════
// HOLD check via IMAP
// ══════════════════════════════════════════════════════════════════════════════

async function checkForHoldReply() {
  return new Promise((resolve) => {
    const imap = new Imap({
      user:        cfg.MAIL_USER,
      password:    cfg.MAIL_PASSWORD,
      host:        cfg.IMAP_HOST,
      port:        993,
      tls:         true,
      connTimeout: 15000,
      authTimeout: 10000,
    });

    imap.once('error', () => { resolve(false); });

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err) => {
        if (err) { imap.end(); return resolve(false); }

        // Search for replies in the last 24 hours containing campaign-related subject
        // (sized for the Thu-10pm-generate → Fri-5pm-schedule gap of ~19h)
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        imap.search([
          ['SINCE', since],
          ['OR',
            ['SUBJECT', 'Campaign'],
            ['SUBJECT', 'HOLD']
          ],
          ['FROM', PREVIEW_EMAIL],
        ], (err, uids) => {
          if (err || !uids?.length) { imap.end(); return resolve(false); }

          const fetcher = imap.fetch(uids, { bodies: '' });
          let foundHold = false;

          fetcher.on('message', msg => {
            msg.on('body', stream => {
              simpleParser(stream, (err, mail) => {
                if (err) return;
                const body    = (mail.text    || '').toLowerCase();
                const subject = (mail.subject || '').toLowerCase();
                if (body.includes('hold') || subject.includes('hold')) {
                  foundHold = true;
                }
              });
            });
          });

          fetcher.once('end', () => { imap.end(); resolve(foundHold); });
          fetcher.once('error', () => { imap.end(); resolve(false); });
        });
      });
    });

    imap.connect();
  });
}


// ══════════════════════════════════════════════════════════════════════════════
// --generate mode
// ══════════════════════════════════════════════════════════════════════════════

async function runGenerate() {
  console.log(`📨 ${STORE_NAME} Campaign Generator — GENERATE mode (Dynamic Strategy)`);
  console.log('=================================================================\n');

  if (!ML_API_KEY)     throw new Error('Missing MAILERLITE_API_KEY in .env');
  if (!SHOPIFY_TOKEN)  throw new Error('Missing SHOPIFY_ADMIN_TOKEN in .env');

  // GUARD: a late-firing cron must never clobber a generate/redo that already
  // ran this week (GitHub crons on this repo fire hours late — on Jul 13 the
  // 02:00 UTC cron fired at 05:33 and wiped the owner's reviewed redos).
  // Manual workflow_dispatch runs always proceed.
  if (process.env.GITHUB_EVENT_NAME === 'schedule') {
    const existing = loadState();
    const ageMs = existing.generatedAt ? Date.now() - new Date(existing.generatedAt).getTime() : Infinity;
    if (existing.campaigns?.length && ageMs < 20 * 3600 * 1000) {
      console.log(`⏭  Campaigns already generated ${existing.generatedAt} (<20h ago) — cron generate skipped to protect existing drafts/redos.`);
      return;
    }
  }

  // 0. Clean up any expired sale prices from previous campaigns
  console.log('🧹 Checking for expired sales to revert...');
  const reverted = await cleanupExpiredSales();
  if (reverted) console.log(`   Reverted ${reverted} variant prices`);
  else console.log('   No expired sales to clean up');

  // 1. Pull Shopify data
  console.log('\n📊 Pulling Shopify sales data (90 days)...');
  const salesData = await getSalesData();
  console.log(`   Orders: ${salesData.orderCount} | Revenue: $${salesData.totalRevenue} | AOV: $${salesData.avgOrderValue}`);
  console.log(`   Top: ${salesData.topProducts.slice(0,3).map(p=>p.name).join(', ')}`);

  console.log('\n🛍  Fetching products...');
  const products  = await getTopProductsWithImages(salesData.topProducts.map(p => p.name));
  const discounts = await getActiveDiscounts();
  const holidays  = getUpcomingHolidays();
  console.log(`   Got ${products.length} featured + ${products._fullCatalog?.length || 0} total catalog`);
  if (holidays.length) console.log(`   Upcoming: ${holidays.join(', ')}`);

  // 2. Gather campaign intelligence (includes optional rating + real reviews from config)
  const intelligence = await gatherCampaignIntelligence();

  // 3. Phase 1 — Ask Claude to plan this week's strategy (aware of what's already queued)
  console.log('\n📅 Checking MailerLite outbox for already-scheduled campaigns...');
  const scheduledCampaigns = await getScheduledCampaigns();
  if (scheduledCampaigns.length) {
    scheduledCampaigns.forEach(sc => console.log(`   ⏳ [${sc.segment}] "${sc.name}" → ${sc.scheduledFor || '?'}`));
  } else {
    console.log('   (outbox empty)');
  }
  const directives = loadWeeklyDirectives();
  if (directives) console.log(`\n📝 Weekly directives found (week of ${directives.week_of}) — steering the planner`);
  const deadlines = resolveDeadlines(directives, discounts);
  for (const [seg, d] of Object.entries(deadlines)) {
    console.log(`   ⏱  ${seg}: ${d ? `real deadline ${d.date} (${d.source})` : 'no deadline — urgency disabled'}`);
  }
  const strategy = await planCampaignStrategy(salesData, products, holidays, discounts, intelligence, scheduledCampaigns, directives, deadlines);
  const fullCatalog = products._fullCatalog || products;

  // 4. Phase 2 — Generate content for each email in the plan
  const allCampaigns = []; // { segment, content, html, promo, campaign, sendDay }

  const segmentGroups = [
    { segment: 'retail',    plan: strategy.retail,    groupId: ML_RETAIL_GROUP },
    { segment: 'wholesale', plan: strategy.wholesale, groupId: ML_WHOLESALE_GROUP },
  ];
  if (strategy.international?.length) {
    await resolveInternationalGroupId();
    if (ML_INTERNATIONAL_GROUP) {
      segmentGroups.push({ segment: 'international', plan: strategy.international, groupId: ML_INTERNATIONAL_GROUP });
    } else {
      console.warn('⚠️  MAILERLITE_INTERNATIONAL_GROUP_ID not set — skipping international campaign(s)');
    }
  }

  const usedProductIds = new Set(); // Track products across campaigns for variety
  const varietyHistory = loadHistory();                          // last-8 history for the variety gate
  const recentFeatured = recentlyFeaturedTitles(varietyHistory); // demoted in the writer's product window

  // ── Creative engine (PR #7): persistent editorial rules, cross-segment hero
  // cooldown (auto-fatigue), live email-marketing trend scan, and a concept
  // brainstorm that picks the angle FURTHEST from recent sends per email.
  const editorialRules = loadEditorialRules(cfg.CONFIG_DIR, cfg.STATE_DIR);
  const heroCooldown   = getHeroCooldown(varietyHistory, editorialRules);
  console.log(`\n🎨 Creative engine: ${(editorialRules.banned_hero_products || []).length} banned-product rule(s), ${heroCooldown.size} product(s) in hero cooldown`);
  let emailTrends = [];
  try {
    emailTrends = await fetchEmailMarketingTrends(claude);
    if (emailTrends.length) console.log(`   📈 Email-marketing trend scan: ${emailTrends.length} idea(s)`);
  } catch (e) { console.warn(`   ⚠️  Trend scan failed (continuing without): ${e.message}`); }
  let angleBook = {};
  try {
    angleBook = await generateCreativeAngles(claude, {
      strategy, history: varietyHistory, catalog: fullCatalog, rules: editorialRules,
      cooldown: heroCooldown, trends: emailTrends, seasonal: intelligence.seasonal, directives,
    });
    for (const seg of Object.keys(angleBook)) {
      (angleBook[seg] || []).forEach((cpt, idx) =>
        console.log(`   💡 ${seg} #${idx + 1}: ${cpt.concept_name || '?'} — hero: ${cpt.hero_product || '(writer picks)'}`));
    }
  } catch (e) { console.warn(`   ⚠️  Angle brainstorm failed (continuing without): ${e.message}`); }
  const runHeroes = []; // heroes chosen so far THIS run — same-week cross-segment dedup

  for (const { segment, plan, groupId } of segmentGroups) {
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`📬 ${segment.toUpperCase()} — ${plan.length} email(s) planned`);
    console.log(`${'═'.repeat(50)}`);

    // Filter products by segment — wholesale/international get wholesale products, retail gets retail
    const isWholesale = segment === 'wholesale' || segment === 'international';
    let segmentProducts = fullCatalog.filter(p => isWholesale ? p.isWholesale : !p.isWholesale);
    if (segment === 'international') {
      // International can ONLY advertise international-eligible product lines (owner's rule)
      segmentProducts = segmentProducts.filter(cfg.isExportEligible);
      if (!segmentProducts.length) segmentProducts = fullCatalog.filter(cfg.isExportEligible);
      // Hero lines first (INTERNATIONAL_HERO_PATTERN)
      segmentProducts.sort((a, b) => (cfg.isInternationalHero(b) ? 1 : 0) - (cfg.isInternationalHero(a) ? 1 : 0));
    }
    // Fall back to top sellers if segment filter yields too few products — but NEVER for
    // international, which must stay international-eligible only
    const campaignProducts = segment === 'international'
      ? segmentProducts
      : (segmentProducts.length >= 3 ? segmentProducts : products);

    if (isWholesale && segmentProducts.length >= 3) {
      console.log(`   🏷️  Filtered to ${segmentProducts.length} wholesale products`);
    }

    for (let i = 0; i < plan.length; i++) {
      const emailPlan = plan[i];
      const label = plan.length > 1 ? ` (${i + 1}/${plan.length})` : '';
      console.log(`\n🤖 Writing ${segment} ${emailPlan.campaign_type}${label} with Claude Opus...`);
      console.log(`   Rationale: ${emailPlan.rationale}`);
      console.log(`   Send day: ${emailPlan.send_day} | Promo: ${emailPlan.include_promo ? 'YES' : 'no'}`);

      // Attach the owner's steer BEFORE ranking products, so steer-matching
      // products actually sort first (previously assigned after the ranking).
      if (directives && typeof directives[segment] === 'string' && directives[segment].trim()) {
        emailPlan.owner_steer = directives[segment].trim();
      }
      // Creative concept for THIS email (from the brainstorm phase)
      const concept = (angleBook[segment] || [])[i] || null;
      if (concept) emailPlan.creative_concept = concept;

      // Editorial rules: banned products never reach the writer; cooldown
      // heroes are pushed out of hero position (owner steer still wins).
      const ruleFiltered = filterProductsByRules(
        campaignProducts, editorialRules, heroCooldown, emailPlan.owner_steer || '');

      // Steer/concept-matching products first, then not-recently-featured,
      // then unused-this-week, then catalog order
      const steerText = [emailPlan.owner_steer || '', concept?.hero_product || '', concept?.angle_summary || ''].join(' ').trim();
      const sortedProducts = prioritizeProductsBySteer(
        ruleFiltered, steerText, usedProductIds, 8, recentFeatured);

      const deadline = deadlines[segment] || null;
      let content = await generateCampaign(
        segment, emailPlan.campaign_type, emailPlan,
        salesData, sortedProducts, holidays, discounts, intelligence, '', deadline
      );

      // VARIETY GATE (code-level): emails WITHOUT an explicit owner steer are
      // checked against this segment's last 8 campaigns — a repeated subject/
      // hero is regenerated with the violation fed back to the writer (max 2
      // retries). Steered emails skip the gate entirely (the owner's direction
      // wins). If still repetitive after retries, the run continues and the
      // preview email flags it for the owner instead of failing the run.
      // VARIETY GATE v2 (hard-block): banned products, cross-segment hero
      // cooldown, same-run duplicate heroes, number-collapsed subject skeletons
      // and layout-variant repeats. Owner-steered topics are exempt from the
      // repetition checks (the steer wins) but NEVER from banned-product rules.
      let varietyWarnings = checkVarietyV2(
        content, segment, varietyHistory, editorialRules, heroCooldown, runHeroes, emailPlan.owner_steer || '');
      let writerPool = sortedProducts;
      for (let attempt = 1; attempt <= 4 && varietyWarnings.length; attempt++) {
        console.warn(`   🔁 Variety gate (retry ${attempt}/4): ${varietyWarnings.join('; ')}`);
        const badHero = (content.featured_products?.[0]?.name || '').toLowerCase();
        if (badHero) writerPool = writerPool.filter(p => (p.title || '').toLowerCase() !== badHero);
        if (!writerPool.length) writerPool = sortedProducts;
        content = await generateCampaign(
          segment, emailPlan.campaign_type, emailPlan,
          salesData, writerPool, holidays, discounts, intelligence,
          `VARIETY VIOLATION — your previous draft repeated recent campaigns: ${varietyWarnings.join('; ')}. Write a COMPLETELY different subject (different structure — not the same skeleton with new numbers or product names), a different angle, a different hero product, and a different layout_variant.`,
          deadline
        );
        varietyWarnings = checkVarietyV2(
          content, segment, varietyHistory, editorialRules, heroCooldown, runHeroes, emailPlan.owner_steer || '');
      }
      const varietyBlocked = varietyWarnings.length > 0;
      if (varietyBlocked) {
        console.error('   ⛔ Variety gate: STILL repetitive after 4 retries — this email is HELD (draft created, will NOT be scheduled). Reply REDO to regenerate it.');
      }
      const chosenHero = (content.featured_products?.[0]?.name || '').toLowerCase();
      if (chosenHero) runHeroes.push(chosenHero);

      // Track which products Claude chose so next campaign avoids them
      for (const fp of content.featured_products || []) {
        const match = fullCatalog.find(p => p.title.toLowerCase() === fp.name?.toLowerCase());
        if (match) usedProductIds.add(match.id);
      }
      console.log(`   Subject: "${content.subject}"`);

      // Generate AI images if Claude requested any
      let generatedImages = [];
      if (content.image_requests?.length) {
        const dateSlug = new Date().toISOString().slice(0, 10);
        const campaignSlug = `${dateSlug}-${segment}-${emailPlan.campaign_type}${plan.length > 1 ? `-${i}` : ''}`;
        console.log(`   🎨 Generating ${content.image_requests.length} AI image(s)...`);
        generatedImages = await generateCampaignImages(content.image_requests, campaignSlug);
        console.log(`   🎨 ${generatedImages.length}/${content.image_requests.length} image(s) ready`);
      } else {
        console.log('   🖼️  No images requested (AI determined product photos sufficient)');
      }

      // Execute promo in Shopify if requested
      let promo = null;
      if (content.promo_request && content.promo_request.type !== 'none') {
        // Check if we already created a compatible promo this run
        const existingPromo = allCampaigns.find(c =>
          c.promo?.code && c.content.promo_request?.value === content.promo_request?.value
        );
        if (existingPromo) {
          promo = existingPromo.promo;
          console.log(`   ♻️  Sharing existing promo code: ${promo.code}`);
        } else {
          promo = await executePromo(content.promo_request, fullCatalog);
        }
      }

      // Attach REAL reviews (verbatim from config/reviews.json) — never model-written
      content.reviews = pickReviews(intelligence.reviews, (content.featured_products || []).map(fp => fp.name));

      // Build HTML — pass full catalog so matchProduct can find any product Claude references
      const html = buildEmailHtml(content, segment, fullCatalog, promo, intelligence.rating, generatedImages);

      // Link check — flag dead links in the preview before anything ships
      const linkCheck = await verifyEmailLinks(html);
      if (linkCheck.broken.length) {
        console.warn(`   ⛔ BROKEN LINKS (${linkCheck.broken.length}/${linkCheck.checked}): ${linkCheck.broken.join(' | ')}`);
        console.warn(`   ⛔ This campaign will NOT be scheduled until the links are fixed (reply REDO to regenerate).`);
      } else {
        console.log(`   🔗 Link check: ${linkCheck.checked} links OK (status + proper-page verified)`);
      }

      // Create draft in MailerLite
      const weekLabel = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const draftName = plan.length > 1
        ? `${segment.charAt(0).toUpperCase() + segment.slice(1)} ${i + 1} — ${weekLabel}`
        : `${segment.charAt(0).toUpperCase() + segment.slice(1)} — ${weekLabel}`;

      let campaign = null;
      try {
        campaign = await createCampaignDraft(draftName, content.subject, content.preview_text, html, groupId);
        console.log(`   ✅ MailerLite draft created (ID: ${campaign.id})`);
      } catch (e) {
        console.error(`   ❌ MailerLite draft failed: ${e.message}`);
      }

      allCampaigns.push({
        segment, content, html, promo, campaign, linkCheck, varietyWarnings, varietyBlocked,
        sendDay: emailPlan.send_day,
        campaignType: emailPlan.campaign_type,
      });

      // Brief pause between Claude calls
      if (i < plan.length - 1) await new Promise(r => setTimeout(r, 2000));
    }
  }

  // 5. Save state for --schedule phase
  const now = new Date();
  const DAY_MAP = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };

  const stateData = {
    generatedAt: now.toISOString(),
    previewSubject: `[${STORE_NAME}] ${allCampaigns.length} Campaign(s) This Week`,
    strategy:    strategy.week_strategy,
    campaigns:   allCampaigns.map(c => ({
      id:         c.campaign?.id || null,
      segment:    c.segment,
      subject:    c.content.subject,
      type:       c.campaignType,
      sendDay:    c.sendDay,
      sendDate:   getNextWeekdayDate(now, DAY_MAP[c.sendDay] ?? 3),
      promoCode:  c.promo?.code || null,
      rationale:  c.content.campaign_rationale || '',
      includePromo: !!c.promo,
      brokenLinks: c.linkCheck?.broken || [],
      varietyBlocked: !!c.varietyBlocked,
    })),
  };
  saveState(stateData);

  // Update history
  const history = loadHistory();
  for (const c of allCampaigns) {
    if (c.campaign?.id) {
      history.campaigns.push({
        id: c.campaign.id, segment: c.segment, subject: c.content.subject,
        campaignType: c.campaignType,
        featuredProducts: (c.content.featured_products || []).map(fp => fp.name).filter(Boolean),
        layoutVariant: c.content.layout_variant || null,
        rationale: c.content.campaign_rationale || '',
        promoCode: c.promo?.code || null,
        generatedAt: now.toISOString(),
        sendDate: getNextWeekdayDate(now, DAY_MAP[c.sendDay] ?? 3),
        sent: 0, opens: 0, clicks: 0, unsubscribes: 0, openRate: 0, clickRate: 0,
        reviewed: false,
      });
    }
  }
  saveHistory(history);

  // 6. Email preview to the owner for approval
  console.log('\n📬 Sending preview email to the owner for approval...');
  try {
    await sendPreviewEmail_v2(strategy, allCampaigns);
    console.log('   ✅ Preview sent — reply HOLD by Friday 5 PM ET to cancel all sends.');
  } catch (e) {
    console.warn(`   ⚠️  Preview email failed: ${e.message}`);
  }

  // 7. Save HTML locally as backup
  const backupDir = path.join(cfg.STATE_DIR, 'weekly-campaigns');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const dateSlug = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < allCampaigns.length; i++) {
    const c = allCampaigns[i];
    const fname = `${dateSlug}-${c.segment}-${c.campaignType}${allCampaigns.filter(x => x.segment === c.segment).length > 1 ? `-${i}` : ''}.html`;
    fs.writeFileSync(path.join(backupDir, fname), c.html);
  }
  console.log(`   💾 Backup HTML saved to weekly-campaigns/`);

  const totalEmails = allCampaigns.length;
  const totalDrafts = allCampaigns.filter(c => c.campaign?.id).length;
  console.log(`\n✅ Done — ${totalDrafts}/${totalEmails} campaign drafts created.`);
  console.log(`   Strategy: ${strategy.week_strategy}`);
  console.log('   Preview emailed to the owner — reply HOLD to cancel.');
  console.log('   --schedule will run Friday 5 PM ET to schedule all sends.');
}


// ══════════════════════════════════════════════════════════════════════════════
// --schedule mode
// ══════════════════════════════════════════════════════════════════════════════

async function runSchedule() {
  console.log(`📨 ${STORE_NAME} Campaign Generator — SCHEDULE mode`);
  console.log('==============================================\n');

  const state = loadState();
  if (!state.generatedAt) {
    console.log('⚠️  No pending campaigns found. Run --generate first.');
    return;
  }

  // Support both old format (retailCampaignId/wholesaleCampaignId) and new (campaigns array)
  const campaigns = state.campaigns || [];
  // Backward compat: convert old format to new
  if (!campaigns.length && (state.retailCampaignId || state.wholesaleCampaignId)) {
    if (state.retailCampaignId)    campaigns.push({ id: state.retailCampaignId,    segment: 'retail',    subject: state.retailSubject,    sendDate: state.retailSendDate });
    if (state.wholesaleCampaignId) campaigns.push({ id: state.wholesaleCampaignId, segment: 'wholesale', subject: state.wholesaleSubject, sendDate: state.wholesaleSendDate });
  }

  console.log(`Found ${campaigns.length} campaign(s) generated ${state.generatedAt}`);
  if (state.strategy) console.log(`  Strategy: ${state.strategy}`);
  for (const c of campaigns) {
    console.log(`  ${c.segment}: "${c.subject}" → ${c.sendDate} (ID: ${c.id || 'none'})`);
  }

  // Check for HOLD reply
  console.log('\n🔍 Checking for HOLD reply from the owner...');
  let held = false;
  try {
    held = await checkForHoldReply();
  } catch (e) {
    console.log(`  ⚠️  Could not check the inbox: ${e.message}. Proceeding with scheduling.`);
  }

  if (held) {
    console.log('⏸  HOLD reply detected — cancelling ALL campaigns this week.');
    clearState();
    try {
      const transporter = getTransporter();
      await transporter.sendMail({
        from:    cfg.MAIL_USER,
        to:      PREVIEW_EMAIL,
        subject: `⏸ ${STORE_NAME} Campaigns HELD — ${campaigns.length} email(s) cancelled`,
        html:    `<p style="font-family:sans-serif">Your HOLD was received. All ${campaigns.length} campaign(s) have been cancelled. The drafts remain in MailerLite if you want to send them manually later.</p>`
      });
    } catch {}
    return;
  }

  console.log('✅ No HOLD detected. Scheduling campaigns...\n');

  let scheduled = 0;
  const blockedCampaigns = [];
  for (const c of campaigns) {
    if (!c.id || !c.sendDate) continue;
    // HARD GATE: never schedule an email with broken links (owner's rule 2026-07-21)
    if (c.brokenLinks?.length) {
      console.error(`  ⛔ ${c.segment} "${c.subject}" NOT scheduled — ${c.brokenLinks.length} broken link(s): ${c.brokenLinks.join(' | ')}`);
      blockedCampaigns.push(c);
      continue;
    }
    // HARD GATE v2: never schedule an email the variety gate flagged as repetitive
    if (c.varietyBlocked) {
      console.error(`  ⛔ ${c.segment} "${c.subject}" NOT scheduled — variety hold (repetitive after 4 retries). Reply REDO to regenerate.`);
      blockedCampaigns.push(c);
      continue;
    }
    try {
      const sendHour = c.sendHour ?? 10;
      const sendMinute = c.sendMinute ?? 0;
      await scheduleCampaign(c.id, c.sendDate, sendHour, sendMinute);
      console.log(`  ✅ ${c.segment} [${c.type || '?'}] scheduled: ${c.sendDate} @ ${sendHour}:${String(sendMinute).padStart(2,'0')} ET`);
      scheduled++;
    } catch (e) {
      console.error(`  ❌ ${c.segment} schedule failed: ${e.message}`);
    }
  }

  // Notify the owner
  try {
    const transporter = getTransporter();
    const scheduleRows = campaigns.filter(c => c.id).map(c =>
      `<p><strong>${c.segment.charAt(0).toUpperCase() + c.segment.slice(1)}${c.type ? ` (${c.type})` : ''}:</strong> "${c.subject}" — ${c.sendDate} @ 10 AM ET</p>`
    ).join('');

    const blockedRows = blockedCampaigns.map(c =>
      `<p style="color:#c0392b"><strong>⛔ ${c.segment.charAt(0).toUpperCase() + c.segment.slice(1)} NOT scheduled (${c.brokenLinks?.length ? 'broken links' : 'variety hold — too similar to recent sends'}):</strong> "${c.subject}"${c.brokenLinks?.length ? ` — ${c.brokenLinks.join(' · ')}` : ''}<br><span style="font-size:12px">The draft is in MailerLite but was blocked from sending. Reply REDO to regenerate it.</span></p>`
    ).join('');

    await transporter.sendMail({
      from:    cfg.MAIL_USER,
      to:      PREVIEW_EMAIL,
      subject: `${blockedCampaigns.length ? '⚠️ ' : '✅ '}${scheduled} ${STORE_NAME} Campaign(s) Scheduled${blockedCampaigns.length ? ` — ${blockedCampaigns.length} BLOCKED` : ''}`,
      html: `
        <div style="font-family:sans-serif;max-width:500px">
          <h3 style="color:${BRAND_GREEN}">${scheduled} campaign(s) scheduled</h3>
          ${scheduleRows}
          ${blockedRows}
          <p style="color:#888;font-size:13px">View in <a href="https://dashboard.mailerlite.com/campaigns">MailerLite</a> if you want to make last-minute edits.</p>
        </div>
      `
    });
    console.log('\n📬 Schedule confirmation emailed to the owner');
  } catch (e) {
    console.warn(`  ⚠️  Confirmation email failed: ${e.message}`);
  }

  if (blockedCampaigns.length) {
    // Keep blocked campaigns in state so a REDO + the evening catch-up pass can
    // regenerate them (with working links) and schedule them.
    saveState({ ...state, campaigns: blockedCampaigns });
    console.log(`\n⚠️  ${blockedCampaigns.length} campaign(s) blocked for broken links — kept in state for redo → re-schedule.`);
  } else {
    clearState();
  }
  console.log(`\n✅ Done — ${scheduled} campaign(s) scheduled and will send automatically.`);
}


// ══════════════════════════════════════════════════════════════════════════════
// --review mode — pull campaign performance stats → update history
// ══════════════════════════════════════════════════════════════════════════════

async function runReview() {
  console.log(`📊 ${STORE_NAME} Campaign Generator — REVIEW mode`);
  console.log('=============================================\n');

  const history = loadHistory();
  const unreviewed = history.campaigns.filter(c => !c.reviewed && c.id);

  if (!unreviewed.length) {
    console.log('No unreviewed campaigns found. Nothing to update.');
    return;
  }

  console.log(`Found ${unreviewed.length} campaigns to review...\n`);
  let updated = 0;

  for (const campaign of unreviewed) {
    console.log(`  Checking: "${campaign.subject}" (${campaign.segment}, ID: ${campaign.id})...`);
    const stats = await getCampaignStats(campaign.id);

    if (!stats) continue;

    // Only mark as reviewed if it's been sent (not still draft/queued)
    if (stats.status === 'sent' || stats.sent > 0) {
      campaign.sent         = stats.sent;
      campaign.opens        = stats.opens;
      campaign.clicks       = stats.clicks;
      campaign.unsubscribes = stats.unsubscribes;
      campaign.openRate     = stats.sent > 0 ? (stats.opens  / stats.sent * 100) : 0;
      campaign.clickRate    = stats.sent > 0 ? (stats.clicks / stats.sent * 100) : 0;
      campaign.reviewed     = true;
      campaign.reviewedAt   = new Date().toISOString();
      updated++;

      console.log(`    ✅ Sent: ${stats.sent} | Opens: ${stats.opens} (${campaign.openRate.toFixed(1)}%) | Clicks: ${stats.clicks} (${campaign.clickRate.toFixed(1)}%) | Unsubs: ${stats.unsubscribes}`);
    } else {
      console.log(`    ⏳ Status: ${stats.status} — not sent yet, will check next time`);
    }
  }

  saveHistory(history);

  // Generate performance digest email
  if (updated > 0) {
    const reviewed = history.campaigns.filter(c => c.reviewed && c.sent > 0);
    const last4    = reviewed.slice(-4);

    const avgOpen  = last4.reduce((s, c) => s + c.openRate,  0) / last4.length;
    const avgClick = last4.reduce((s, c) => s + c.clickRate, 0) / last4.length;

    console.log(`\n📈 Performance Summary (last ${last4.length} campaigns):`);
    console.log(`   Avg open rate:  ${avgOpen.toFixed(1)}%`);
    console.log(`   Avg click rate: ${avgClick.toFixed(1)}%`);

    // Email digest to the owner
    try {
      const transporter = getTransporter();
      const rows = last4.map(c => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0">${c.segment}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-style:italic">${c.subject}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:center">${c.sent}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:center;color:${c.openRate > avgOpen ? '#2e7d32' : '#c62828'}">${c.openRate.toFixed(1)}%</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:center;color:${c.clickRate > avgClick ? '#2e7d32' : '#c62828'}">${c.clickRate.toFixed(1)}%</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:center">${c.unsubscribes}</td>
        </tr>
      `).join('');

      await transporter.sendMail({
        from:    cfg.MAIL_USER,
        to:      PREVIEW_EMAIL,
        subject: `📊 ${STORE_NAME} Email Performance — ${avgOpen.toFixed(0)}% opens, ${avgClick.toFixed(0)}% clicks`,
        html: `
          <div style="font-family:Helvetica,Arial,sans-serif;max-width:700px;margin:auto;color:#222222;padding:20px">
            <h2 style="color:${BRAND_GREEN}">Campaign Performance Review</h2>
            <p>The AI is learning from these results to write better campaigns next week.</p>
            <table style="width:100%;border-collapse:collapse;font-size:14px;margin:20px 0">
              <tr style="background:${BRAND_GREEN};color:#fff">
                <th style="padding:10px 12px;text-align:left">Segment</th>
                <th style="padding:10px 12px;text-align:left">Subject</th>
                <th style="padding:10px 12px;text-align:center">Sent</th>
                <th style="padding:10px 12px;text-align:center">Opens</th>
                <th style="padding:10px 12px;text-align:center">Clicks</th>
                <th style="padding:10px 12px;text-align:center">Unsubs</th>
              </tr>
              ${rows}
            </table>
            <p style="font-size:13px;color:#888">
              Avg open rate: <strong>${avgOpen.toFixed(1)}%</strong> | Avg click rate: <strong>${avgClick.toFixed(1)}%</strong><br>
              Green = above average, Red = below average. The AI prioritizes high-performing patterns.
            </p>
          </div>
        `
      });
      console.log('📬 Performance digest emailed to the owner');
    } catch (e) {
      console.warn(`  ⚠️  Digest email failed: ${e.message}`);
    }
  }

  console.log(`\n✅ Review complete — ${updated} campaigns updated.`);
  console.log('   Historical data will be fed into next week\'s AI prompt for smarter campaigns.');
}


// ══════════════════════════════════════════════════════════════════════════════
// --redo mode — regenerate specific emails by number or segment, with feedback
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Regenerate specific campaign(s) identified by number or segment.
 * Supports:
 *   --redo 4                          → redo email #4
 *   --redo 2,4                        → redo emails #2 and #4
 *   --redo 4 --feedback "bulk only"   → redo #4 with feedback for Claude
 *   --redo wholesale                  → redo all wholesale emails
 *
 * feedbackMap: optional { [1-based index]: "feedback text" } for email-reply mode
 */
async function runRedo(feedbackMap = {}) {
  // 1. Load existing state
  const state = loadState();
  if (!state.campaigns?.length) {
    console.error('❌ No existing campaign state found. Run --generate first.');
    process.exit(1);
  }

  // Determine which campaign indices to redo (0-based internally)
  let redoIndices = [];
  if (REDO_NUMBERS.length) {
    redoIndices = REDO_NUMBERS.map(n => n - 1).filter(i => i >= 0 && i < state.campaigns.length);
  } else if (REDO_SEGMENT) {
    redoIndices = state.campaigns.map((c, i) => c.segment === REDO_SEGMENT ? i : -1).filter(i => i >= 0);
  } else if (Object.keys(feedbackMap).length) {
    // Called from --check-feedback with parsed reply
    redoIndices = Object.keys(feedbackMap).map(n => parseInt(n, 10) - 1).filter(i => i >= 0 && i < state.campaigns.length);
  }

  if (!redoIndices.length) {
    console.error('❌ No valid emails to redo. Use --redo 4, --redo 2,4, or --redo wholesale');
    process.exit(1);
  }

  // Merge CLI feedback with feedbackMap
  if (REDO_FEEDBACK) {
    for (const idx of redoIndices) {
      feedbackMap[idx + 1] = feedbackMap[idx + 1] || REDO_FEEDBACK;
    }
  }

  const redoLabels = redoIndices.map(i => `#${i + 1} ${state.campaigns[i].segment} ${state.campaigns[i].type}`);
  console.log(`🔄 ${STORE_NAME} Campaign Generator — REDO ${redoLabels.join(', ')}`);
  console.log('=================================================================\n');

  const keepIndices = state.campaigns.map((_, i) => i).filter(i => !redoIndices.includes(i));
  console.log(`   Keeping: ${keepIndices.length} email(s) — ${keepIndices.map(i => `#${i+1}`).join(', ') || 'none'}`);
  console.log(`   Redoing: ${redoIndices.length} email(s) — ${redoIndices.map(i => `#${i+1}`).join(', ')}`);

  // Show feedback if any
  for (const idx of redoIndices) {
    const fb = feedbackMap[idx + 1];
    if (fb) console.log(`   💬 #${idx + 1} feedback: "${fb}"`);
  }

  // 2. Delete old MailerLite drafts for redo emails
  // SAFETY: NEVER delete a campaign that has already been sent — MailerLite
  // permanently erases sent campaigns AND their open/click reports on delete.
  for (const idx of redoIndices) {
    const old = state.campaigns[idx];
    if (old?.id) {
      try {
        let status = null;
        try {
          const existing = await mlRequest('GET', `/campaigns/${old.id}`);
          status = existing?.data?.status || existing?.status || null;
        } catch {}
        if (status === 'sent') {
          console.log(`   🔒 #${idx + 1} "${old.subject}" was already SENT — leaving it and its stats untouched.`);
          continue;
        }
        if (status === 'ready') {
          // Scheduled campaigns must be cancelled back to draft before deletion —
          // otherwise the delete fails and the OLD version still sends on schedule.
          try {
            await mlRequest('POST', `/campaigns/${old.id}/cancel`);
            console.log(`   ⏸  #${idx + 1} was scheduled — cancelled before delete.`);
          } catch (e) {
            console.warn(`   ⚠️  Could not cancel scheduled campaign ${old.id}: ${e.message}`);
          }
        }
        await mlRequest('DELETE', `/campaigns/${old.id}`);
        console.log(`   🗑️  Deleted old draft #${idx + 1}: "${old.subject}" (${old.id})`);
      } catch (e) {
        console.warn(`   ⚠️  Could not delete draft ${old.id}: ${e.message}`);
      }
    }
  }

  // 3. Pull fresh Shopify data
  console.log('\n📊 Pulling Shopify sales data (90 days)...');
  const salesData = await getSalesData();

  console.log('🛍  Fetching products...');
  const products  = await getTopProductsWithImages(salesData.topProducts.map(p => p.name));
  const discounts = await getActiveDiscounts();
  const holidays  = getUpcomingHolidays();
  const intelligence = await gatherCampaignIntelligence();
  const deadlines = resolveDeadlines(loadWeeklyDirectives(), discounts);
  const fullCatalog = products._fullCatalog || products;

  // 4. Regenerate each redo email
  const now = new Date();
  const DAY_MAP = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
  const newCampaignResults = []; // { idx, campaignData }

  for (const idx of redoIndices) {
    const oldCampaign = state.campaigns[idx];
    const segment = oldCampaign.segment;
    const isWholesale = segment === 'wholesale' || segment === 'international';
    const groupId = segment === 'international'
      ? (ML_INTERNATIONAL_GROUP || await resolveInternationalGroupId())
      : (segment === 'wholesale' ? ML_WHOLESALE_GROUP : ML_RETAIL_GROUP);
    const feedback = feedbackMap[idx + 1] || '';

    // Filter products by segment
    let segmentProducts = fullCatalog.filter(p => isWholesale ? p.isWholesale : !p.isWholesale);
    if (segment === 'international') {
      // International can ONLY advertise international-eligible product lines (owner's rule)
      segmentProducts = segmentProducts.filter(cfg.isExportEligible);
      if (!segmentProducts.length) segmentProducts = fullCatalog.filter(cfg.isExportEligible);
      // Hero lines first (INTERNATIONAL_HERO_PATTERN)
      segmentProducts.sort((a, b) => (cfg.isInternationalHero(b) ? 1 : 0) - (cfg.isInternationalHero(a) ? 1 : 0));
    }
    const campaignProducts = segment === 'international'
      ? segmentProducts
      : (segmentProducts.length >= 3 ? segmentProducts : products);

    // Build a synthetic email plan from the saved state
    const emailPlan = {
      campaign_type: oldCampaign.type,
      rationale: oldCampaign.rationale || `Redo of ${oldCampaign.type} campaign`,
      send_day: oldCampaign.sendDay,
      include_promo: oldCampaign.includePromo || false,
    };
    // Re-attach this week's owner steer so redos keep the week's direction
    const weeklyDirectives = loadWeeklyDirectives();
    if (weeklyDirectives && typeof weeklyDirectives[segment] === 'string' && weeklyDirectives[segment].trim()) {
      emailPlan.owner_steer = weeklyDirectives[segment].trim();
    }

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`🤖 Redoing #${idx + 1}: ${segment} ${emailPlan.campaign_type} (${emailPlan.send_day})`);
    if (feedback) console.log(`   💬 Feedback: "${feedback}"`);

    const redoProducts = prioritizeProductsBySteer(
      campaignProducts, `${emailPlan.owner_steer || ''} ${feedback || ''}`, new Set(), 8);
    const content = await generateCampaign(
      segment, emailPlan.campaign_type, emailPlan,
      salesData, redoProducts, holidays, discounts, intelligence,
      feedback,  // Pass feedback to inject into Claude prompt
      deadlines[segment] || null
    );
    console.log(`   Subject: "${content.subject}"`);

    // Generate AI images if requested
    let generatedImages = [];
    if (content.image_requests?.length) {
      const dateSlug = now.toISOString().slice(0, 10);
      const campaignSlug = `${dateSlug}-redo-${idx + 1}-${segment}-${emailPlan.campaign_type}`;
      generatedImages = await generateCampaignImages(content.image_requests, campaignSlug);
    }

    // Execute promo if requested
    let promo = null;
    if (content.promo_request && content.promo_request.type !== 'none') {
      promo = await executePromo(content.promo_request, fullCatalog);
    }

    // Attach REAL reviews only, then build HTML with the full catalog
    content.reviews = pickReviews(intelligence.reviews, (content.featured_products || []).map(fp => fp.name));
    const html = buildEmailHtml(content, segment, fullCatalog, promo, intelligence.rating, generatedImages);

    // Link check — flag dead links in the preview before anything ships
    const linkCheck = await verifyEmailLinks(html);
    if (linkCheck.broken.length) {
      console.warn(`   ⚠️  BROKEN LINKS (${linkCheck.broken.length}/${linkCheck.checked}): ${linkCheck.broken.join(' | ')}`);
    } else {
      console.log(`   🔗 Link check: ${linkCheck.checked} links OK`);
    }

    // Create new MailerLite draft
    const weekLabel = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const draftName = `${segment.charAt(0).toUpperCase() + segment.slice(1)} — ${weekLabel} (redo #${idx + 1})`;

    let campaign = null;
    try {
      campaign = await createCampaignDraft(draftName, content.subject, content.preview_text, html, groupId);
      console.log(`   ✅ MailerLite draft created (ID: ${campaign.id})`);
    } catch (e) {
      console.error(`   ❌ MailerLite draft failed: ${e.message}`);
    }

    newCampaignResults.push({
      idx,
      data: {
        id:         campaign?.id || null,
        segment,
        subject:    content.subject,
        type:       emailPlan.campaign_type,
        sendDay:    emailPlan.send_day,
        sendDate:   oldCampaign.sendDate || getNextWeekdayDate(now, DAY_MAP[emailPlan.send_day] ?? 3),
        sendHour:   oldCampaign.sendHour,
        sendMinute: oldCampaign.sendMinute,
        promoCode:  promo?.code || null,
        featuredProducts: (content.featured_products || []).map(fp => fp.name).filter(Boolean),
        rationale:  content.campaign_rationale || '',
        includePromo: !!promo,
        brokenLinks: linkCheck?.broken || [],
      },
      forPreview: { segment, content, html, promo, campaign, linkCheck, sendDay: emailPlan.send_day, campaignType: emailPlan.campaign_type },
    });
  }

  // 5. Update state — replace redo campaigns, keep everything else
  const updatedCampaigns = [...state.campaigns];
  for (const { idx, data } of newCampaignResults) {
    updatedCampaigns[idx] = data;
  }
  // feedbackProcessedAt marks this owner reply as handled so later scheduler
  // passes don't re-process it (they should schedule the redone drafts instead).
  saveState({ ...state, redoneAt: now.toISOString(), feedbackProcessedAt: now.toISOString(), campaigns: updatedCampaigns });

  // Update history
  const history = loadHistory();
  for (const { data } of newCampaignResults) {
    if (data.id) {
      history.campaigns.push({
        id: data.id, segment: data.segment, subject: data.subject,
        campaignType: data.type, rationale: data.rationale,
        featuredProducts: data.featuredProducts || [],
        promoCode: data.promoCode, generatedAt: now.toISOString(), sendDate: data.sendDate,
        sent: 0, opens: 0, clicks: 0, unsubscribes: 0, openRate: 0, clickRate: 0, reviewed: false,
      });
    }
  }
  saveHistory(history);

  // 6. Save HTML backup + send preview
  const backupDir = path.join(cfg.STATE_DIR, 'weekly-campaigns');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  for (const { idx, forPreview } of newCampaignResults) {
    const fname = `${now.toISOString().slice(0, 10)}-redo-${idx + 1}-${forPreview.segment}-${forPreview.campaignType}.html`;
    fs.writeFileSync(path.join(backupDir, fname), forPreview.html);
  }

  console.log('\n📬 Sending preview of redone campaign(s) to the owner...');
  try {
    const previewCampaigns = newCampaignResults.map(r => r.forPreview);
    await sendPreviewEmail_v2({ week_strategy: `REDO: ${redoLabels.join(', ')}` }, previewCampaigns);
    console.log('   ✅ Preview sent — check your email.');
  } catch (e) {
    console.warn(`   ⚠️  Preview email failed: ${e.message}`);
  }

  console.log(`\n✅ Done — ${newCampaignResults.length} email(s) regenerated, ${keepIndices.length} kept.`);
  console.log('   Run --schedule when ready to schedule all.');
}


// ══════════════════════════════════════════════════════════════════════════════
// --check-feedback — read inbox replies and auto-redo with feedback
// ══════════════════════════════════════════════════════════════════════════════

async function runCheckFeedback() {
  console.log('📬 Checking the inbox for REDO/HOLD replies...\n');

  const state = loadState();
  if (!state.campaigns?.length) {
    console.log('No pending campaigns. Nothing to check.');
    return false;
  }

  // Connect to the owner's mailbox over IMAP
  const Imap = require('imap');
  const { simpleParser } = require('mailparser');

  const imap = new Imap({
    user:     cfg.MAIL_USER,
    password: cfg.MAIL_PASSWORD,
    host:     cfg.IMAP_HOST,
    port:     993,
    tls:      true,
  });

  const openInbox = () => new Promise((resolve, reject) => {
    imap.openBox('INBOX', false, (err, box) => err ? reject(err) : resolve(box));
  });

  const searchMsgs = (criteria) => new Promise((resolve, reject) => {
    imap.search(criteria, (err, results) => err ? reject(err) : resolve(results));
  });

  const fetchMsg = (uid) => new Promise((resolve, reject) => {
    const f = imap.fetch(uid, { bodies: '', struct: true });
    let buffer = '';
    f.on('message', (msg) => {
      msg.on('body', (stream) => {
        stream.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
      });
    });
    f.once('error', reject);
    // Resolve on the FETCH 'end' (all body streams fully drained). Resolving on the
    // message 'end' raced the body stream and could return an empty/partial body —
    // which made valid REDO replies look empty and let campaigns schedule right past
    // the owner's feedback (bit us on Jul 13 and again on Jul 27).
    f.once('end', () => resolve(buffer));
  });

  try {
    await new Promise((resolve, reject) => {
      imap.once('ready', resolve);
      imap.once('error', reject);
      imap.connect();
    });
    await openInbox();

    // Search for replies from the owner since the preview was generated — or since the
    // last processed reply, so a redo pass never re-processes the same reply on the
    // next scheduler pass (IMAP SINCE is only day-granular).
    const sinceBasis = state.feedbackProcessedAt || state.generatedAt;
    const sinceDate = new Date(sinceBasis);
    sinceDate.setHours(sinceDate.getHours() - 1); // 1hr buffer
    const sinceDateStr = sinceDate.toISOString().slice(0, 10).replace(/-/g, '-');

    // Subject-based IMAP filtering proved unreliable (found 0 replies on
    // Jul 13 despite a valid REDO reply in the inbox) — fetch everything from
    // the owner since the preview and inspect bodies ourselves.
    const uids = await searchMsgs([
      ['FROM', PREVIEW_EMAIL],
      ['SINCE', new Date(sinceDateStr)],
    ]);

    if (!uids.length) {
      console.log('   No replies from the owner since the preview. All emails approved.');
      imap.end();
      return false;
    }

    console.log(`   Found ${uids.length} reply(ies) — scanning newest first...\n`);

    // Only the owner's own words count — strip the quoted original email and any
    // "> " quoted lines. The quoted preview contains literal instruction
    // EXAMPLES ("REDO 4: use different products") that must never be parsed
    // as real instructions.
    const stripQuoted = (txt) => txt
      .split(/^On .{0,160}wrote:\s*$/m)[0]
      .split(/^-{2,}\s*Original Message\s*-{2,}\s*$/mi)[0]
      .split(/\r?\n/)
      .filter(line => !/^\s*>/.test(line))
      .join('\n')
      .trim();

    // Newest → oldest: first reply whose own words contain a REDO/HOLD wins
    let ownText = null;
    let parsed = null;
    for (const uid of uids.slice(-10).reverse()) {
      const rawMsg = await fetchMsg(uid);
      const p = await simpleParser(rawMsg);
      // Skip replies that predate the last processed feedback — IMAP SINCE is
      // day-granular, so without this check the same reply would re-trigger a
      // redo on every scheduler pass and the emails would never get scheduled.
      if (p.date && new Date(p.date) <= new Date(sinceBasis)) continue;
      const own = stripQuoted((p.text || '').trim());
      if (/^HOLD$/im.test(own) || /(^|\s)REDO\s+[\d,]/i.test(own)) {
        parsed = p;
        ownText = own;
        break;
      }
    }

    if (!ownText) {
      console.log('   No REDO or HOLD instructions found in any reply. All emails approved.');
      imap.end();
      return false;
    }

    console.log(`   Reply from: ${parsed.from?.text}`);
    console.log(`   Reply text (own words only): "${ownText.slice(0, 200)}"\n`);

    imap.end();

    // Check for HOLD (cancel all)
    if (/^HOLD$/im.test(ownText)) {
      console.log('🛑 HOLD received — cancelling all campaigns.');
      // Delete all MailerLite drafts
      for (const c of state.campaigns) {
        if (c.id) {
          try {
            await mlRequest('DELETE', `/campaigns/${c.id}`);
            console.log(`   🗑️  Deleted: "${c.subject}" (${c.id})`);
          } catch (e) {
            console.warn(`   ⚠️  Could not delete ${c.id}: ${e.message}`);
          }
        }
      }
      clearState();
      console.log('\n✅ All campaigns cancelled. Run --generate to start fresh.');
      return true;
    }

    // Parse REDO instructions: "REDO 4: feedback text" or "REDO 2,4: feedback"
    const redoPattern = /REDO\s+([\d,]+)\s*[:\-–—]\s*(.+?)(?=REDO\s+\d|$)/gis;
    const feedbackMap = {};
    let match;

    while ((match = redoPattern.exec(ownText)) !== null) {
      const numbers = match[1].split(',').map(n => parseInt(n.trim(), 10)).filter(n => n > 0);
      const feedback = match[2].trim();
      for (const num of numbers) {
        feedbackMap[num] = feedback;
      }
    }

    // Also try simpler pattern: "REDO 4" without colon
    if (!Object.keys(feedbackMap).length) {
      const simplePattern = /REDO\s+([\d,]+)/gi;
      while ((match = simplePattern.exec(ownText)) !== null) {
        const numbers = match[1].split(',').map(n => parseInt(n.trim(), 10)).filter(n => n > 0);
        for (const num of numbers) {
          feedbackMap[num] = feedbackMap[num] || '';
        }
      }
    }

    if (!Object.keys(feedbackMap).length) {
      console.log('   Could not parse any REDO instructions from the reply.');
      console.log('   Expected format: "REDO 4: your feedback here"');
      return false;
    }

    console.log(`   Parsed redo requests:`);
    for (const [num, fb] of Object.entries(feedbackMap)) {
      console.log(`   #${num}: ${fb || '(no specific feedback)'}`);
    }

    // Execute the redo with parsed feedback
    console.log('\n');
    await runRedo(feedbackMap);
    return true;

  } catch (e) {
    console.error(`❌ Inbox check failed: ${e.message}`);
    try { imap.end(); } catch {}
    return false;
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
  if (GENERATE)        return runGenerate();
  if (REDO)            return runRedo();
  if (CHECK_FEEDBACK)  return runCheckFeedback();
  if (SCHEDULE) {
    // Process any REDO/HOLD replies BEFORE scheduling. If drafts changed (or
    // were cancelled), skip this pass so the owner can review the new preview;
    // the Friday-evening catch-up scheduler pass (00:00 UTC Sat) will schedule them.
    let acted = false;
    try { acted = await runCheckFeedback(); }
    catch (e) { console.warn(`⚠️  check-feedback failed: ${e.message} — proceeding to schedule.`); }
    if (acted) {
      console.log('🔁 Reply processed — skipping this scheduling pass; the catch-up pass will schedule the updated drafts.');
      return;
    }
    return runSchedule();
  }
  if (REVIEW)          return runReview();
  if (CLEANUP_SALES) {
    console.log('🧹 Cleaning up expired Shopify sale prices...');
    const reverted = await cleanupExpiredSales();
    console.log(reverted ? `✅ Reverted ${reverted} variant prices to original` : '✅ No expired sales to clean up');
    return;
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
