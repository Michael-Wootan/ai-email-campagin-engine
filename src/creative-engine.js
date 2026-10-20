'use strict';
/**
 * creative-engine.js — anti-redundancy engine for the weekly campaign generator.
 *
 * Added 2026-08-15 (PR #7) after the owner's "every week it creates basically
 * the same email" feedback. Five root causes this module addresses:
 *   1. Persistent editorial rules (editorial-rules.json) — owner feedback like
 *      "stop recycling Product X" becomes a code-enforced rule, not a
 *      note that evaporates between weeks.
 *   2. Cross-segment hero cooldown — any product used as a HERO in ANY segment
 *      in the last N days (default 28) can't be a hero again (auto-fatigue).
 *   3. Live email-marketing trend scan — what's actually working in ecommerce
 *      email right now (via Claude web search), fed to every email, not just
 *      the ~never-used trend_newsjack type.
 *   4. Creative-angle brainstorm — 3 concepts per planned email, keep the one
 *      FURTHEST from recent sends; the chosen concept (incl. hero product) is
 *      passed to the writer, closing the planner→writer novelty gap.
 *   5. Variety gate v2 — number-collapsed subject-skeleton matching ("120
 *      reviews. 4.8 stars." == "135 reviews. 4.7 stars."), cross-segment and
 *      same-run hero dedup, banned lists, layout-variant rotation. Hard-block:
 *      still-repetitive emails are HELD from scheduling (like broken links).
 */

const fs   = require('fs');
const path = require('path');
const cfg  = require('./config');

const RULES_FILE   = 'editorial-rules.json';
const HISTORY_FILE = 'campaign-history.json';

const DEFAULT_RULES = {
  banned_hero_products:     [],   // [{match, reason, added}]
  banned_subject_skeletons: [],   // [{pattern, example, reason}]
  hero_cooldown_days:       28,   // auto-fatigue window, ALL segments
};

function loadEditorialRules(configDir) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(configDir, RULES_FILE), 'utf8'));
    return { ...DEFAULT_RULES, ...r };
  } catch { return { ...DEFAULT_RULES }; }
}

function loadHistoryFrom(stateDir) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, HISTORY_FILE), 'utf8')); }
  catch { return { campaigns: [] }; }
}

// ── Text helpers ─────────────────────────────────────────────────────────────

function words(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
}

/** Collapse digits so "120 reviews. 4.8 stars." matches "135 reviews. 4.7 stars." */
function skeletonOf(s) {
  return String(s || '').toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[^a-z#\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 0..1 word+bigram overlap on number-collapsed subjects. */
function skeletonSimilarity(a, b) {
  const wa = skeletonOf(a).split(' ').filter(Boolean);
  const wb = skeletonOf(b).split(' ').filter(Boolean);
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

/** Does the owner's steer explicitly demand this text's topic? (steer wins) */
function steerDemands(steer, txt) {
  const s = String(steer || '').toLowerCase();
  if (!s) return false;
  const ws = words(txt);
  return ws.length > 0 && ws.filter(w => s.includes(w)).length >= Math.min(2, ws.length);
}

// ── Rules: banned products + hero cooldown ───────────────────────────────────

function isBannedProduct(title, rules) {
  const t = String(title || '').toLowerCase();
  if (!t) return null;
  return (rules.banned_hero_products || []).find(b => t.includes(String(b.match || b).toLowerCase())) || null;
}

/** Lowercased titles used as HERO (featuredProducts[0]) in ANY segment within the cooldown window. */
function getHeroCooldown(history, rules) {
  const days   = rules.hero_cooldown_days || 28;
  const cutoff = Date.now() - days * 86400000;
  const out = new Set();
  for (const c of history.campaigns || []) {
    if (!c.generatedAt || new Date(c.generatedAt).getTime() < cutoff) continue;
    const hero = (c.featuredProducts || [])[0];
    if (hero) out.add(String(hero).toLowerCase());
  }
  return out;
}

function inCooldown(title, cooldown) {
  const t = String(title || '').toLowerCase();
  if (!t) return false;
  for (const c of cooldown) { if (c === t || c.includes(t) || t.includes(c)) return true; }
  return false;
}

/**
 * Product pool for the writer: banned products removed entirely (unless the
 * owner's steer explicitly demands them); cooldown products pushed to the back
 * so they can't end up as the hero but remain available as secondary items.
 */
function filterProductsByRules(pool, rules, cooldown, ownerSteer = '') {
  const kept   = pool.filter(p => !isBannedProduct(p.title, rules) || steerDemands(ownerSteer, p.title));
  const fresh  = kept.filter(p => !inCooldown(p.title, cooldown));
  const cooled = kept.filter(p => inCooldown(p.title, cooldown));
  return fresh.length >= 2 ? [...fresh, ...cooled] : kept;
}

// ── Variety gate v2 ──────────────────────────────────────────────────────────

/**
 * Check a drafted email. Returns human-readable violations (empty = passes).
 * runHeroes = lowercased heroes already chosen by OTHER emails in this run
 * (same-week cross-segment dedup — the gap that let one product land in retail
 * AND wholesale the same week).
 */
function checkVarietyV2(content, segment, history, rules, cooldown, runHeroes = [], ownerSteer = '') {
  const problems = [];
  const subject  = content.subject || '';
  const hero     = content.featured_products?.[0]?.name || '';

  // 1. Banned products anywhere in the email (owner's explicit steer can override)
  for (const fp of content.featured_products || []) {
    const b = isBannedProduct(fp.name, rules);
    if (b && !steerDemands(ownerSteer, fp.name)) {
      problems.push(`product "${fp.name}" is on the owner's banned list${b.reason ? ` (${b.reason})` : ''} — pick a different product`);
    }
  }

  // 2. Hero cooldown — cross-segment auto-fatigue
  if (hero && !steerDemands(ownerSteer, hero) && inCooldown(hero, cooldown)) {
    problems.push(`hero "${hero}" was already a hero in the last ${rules.hero_cooldown_days || 28} days (any segment) — pick a hero that hasn't been featured recently`);
  }

  // 3. Same-run duplicate hero (this week's other emails, all segments)
  const heroLc = hero.toLowerCase();
  if (heroLc && runHeroes.some(h => h === heroLc || h.includes(heroLc) || heroLc.includes(h))) {
    problems.push(`hero "${hero}" is already the hero of another email THIS week — two emails must never share a hero`);
  }

  // 4. Banned subject skeletons (regex, from editorial-rules.json)
  for (const sk of rules.banned_subject_skeletons || []) {
    try {
      if (new RegExp(sk.pattern || sk, 'i').test(subject)) {
        problems.push(`subject "${subject}" matches a banned pattern${sk.reason ? ` (${sk.reason})` : ''} — use a completely different subject structure`);
        break;
      }
    } catch { /* bad regex in rules file — skip */ }
  }

  // 5. Skeleton similarity vs the last 12 subjects across ALL segments —
  // numbers collapsed, so swapping "135"→"120" or one product name for another
  // no longer sneaks the same formula through.
  if (!steerDemands(ownerSteer, subject)) {
    for (const c of (history.campaigns || []).slice(-12)) {
      if (c.subject && skeletonSimilarity(subject, c.subject) >= 0.5) {
        problems.push(`subject "${subject}" repeats the structure of recent send "${c.subject}" (${c.segment}) — different words in the same skeleton is still repetition`);
        break;
      }
    }
  }

  // 6. Layout variant — never the same variant as this segment's previous send
  const lastVariant = [...(history.campaigns || [])].reverse()
    .find(c => c.segment === segment && c.layoutVariant)?.layoutVariant;
  if (lastVariant && content.layout_variant &&
      String(content.layout_variant).toUpperCase() === String(lastVariant).toUpperCase()) {
    problems.push(`layout_variant "${content.layout_variant}" repeats this segment's last send — pick a different variant (A/B/C)`);
  }

  return problems;
}

// ── Prompt blocks (appended to the writer prompt) ────────────────────────────

/** Persistent rules block for the writer prompt. Loads rules + history itself. */
function buildRulesPromptBlock(configDir, stateDir) {
  const rules    = loadEditorialRules(configDir);
  const cooldown = getHeroCooldown(loadHistoryFrom(stateDir), rules);
  const banned = (rules.banned_hero_products || [])
    .map(b => `- ${b.match || b}${b.reason ? ` (${b.reason})` : ''}`).join('\n');
  const skels = (rules.banned_subject_skeletons || [])
    .map(s => `- ${s.example || s.pattern || s}${s.reason ? ` — ${s.reason}` : ''}`).join('\n');
  const cooled = [...cooldown].slice(0, 12).map(t => `- ${t}`).join('\n');
  if (!banned && !skels && !cooled) return '';
  return `\n\n═══ EDITORIAL RULES (owner's persistent standing feedback — HARD constraints) ═══\n` +
    (banned ? `BANNED PRODUCTS — never feature these in any email:\n${banned}\n` : '') +
    (skels  ? `BANNED SUBJECT PATTERNS — never write a subject shaped like:\n${skels}\n` : '') +
    (cooled ? `HERO COOLDOWN — recently used as hero (any segment); must NOT be this email's hero:\n${cooled}\n` : '') +
    `Violating any of these forces a regeneration; a repeat offender gets HELD from sending entirely.`;
}

/** Creative-concept block for the writer prompt. */
function buildConceptPromptBlock(c) {
  if (!c) return '';
  return `\n\n═══ THIS EMAIL'S CREATIVE CONCEPT (chosen in the brainstorm phase — follow it) ═══\n` +
    `Concept: ${c.concept_name || 'untitled'} — ${c.angle_summary || ''}\n` +
    (c.hero_product      ? `Hero product: ${c.hero_product} — make THIS the hero (it is in your product list).\n` : '') +
    (c.trend_hook        ? `Email-marketing trend to implement: ${c.trend_hook}\n` : '') +
    (c.subject_direction ? `Subject direction: ${c.subject_direction} (write a fresh subject in this spirit — don't copy it verbatim)\n` : '') +
    (c.visual_concept    ? `Visual concept for the AI image: ${c.visual_concept}\n` : '') +
    (c.layout_variant    ? `Use layout_variant: ${c.layout_variant}\n` : '');
}

// ── Live email-marketing trend scan ──────────────────────────────────────────

/**
 * What's working in ecommerce EMAIL MARKETING right now — viral campaign ideas,
 * formats, concepts — via Claude's server-side web search tool. Returns
 * [{idea, why}]; the caller treats any failure as "no trends this week".
 */
async function fetchEmailMarketingTrends(claude) {
  const msg = await claude.messages.create({
    model:      cfg.ANTHROPIC_MODEL,
    max_tokens: 1500,
    tools:      [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
    messages: [{
      role: 'user',
      content: `Search the web for what is working in ECOMMERCE EMAIL MARKETING right now (${new Date().toISOString().slice(0, 7)}): viral campaign concepts, fresh formats, subject-line styles, storytelling devices, and creative ideas DTC brands are getting attention with. Focus on ideas implementable in a single static HTML email (MailerLite — no live JS or embedded video).

Then return ONLY a JSON array of 5-8 items:
[{"idea": "one-line implementable idea for a single email", "why": "why it works / where it's trending"}]

Rules: nothing fear-based; nothing requiring app integrations; no fake countdowns, fake scarcity, or invented testimonials; each idea must be distinct in KIND (not 8 variations of one idea). Return ONLY the JSON array, no prose.`,
    }],
  });
  const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const arr  = text.match(/\[[\s\S]*\]/)?.[0];
  const parsed = arr ? JSON.parse(arr) : [];
  return Array.isArray(parsed) ? parsed.filter(t => t && t.idea).slice(0, 8) : [];
}

// ── Creative-angle brainstorm ────────────────────────────────────────────────

/**
 * For every planned email, brainstorm 3 genuinely different concepts and keep
 * the one FURTHEST from recent sends. Returns { retail: [concept,...],
 * wholesale: [...], international: [...] } aligned with the plan's email order.
 * The chosen hero_product comes from the segment's ALLOWED pool (banned and
 * cooldown heroes excluded), which is how the novelty requirement finally
 * reaches the model that actually picks products.
 */
async function generateCreativeAngles(claude, opts) {
  const { strategy, history, catalog, rules, cooldown, trends, seasonal, directives } = opts;

  const recent = (history.campaigns || []).slice(-12).map(c =>
    `- [${c.segment}/${c.campaignType || '?'}] "${c.subject}" | hero: ${(c.featuredProducts || [])[0] || '?'} | variant: ${c.layoutVariant || '?'}`
  ).join('\n') || '(no history)';

  const allowedTitles = (segTest) => catalog
    .filter(segTest)
    .filter(p => p.title && !isBannedProduct(p.title, rules))
    .map(p => ({ t: p.title, cooled: inCooldown(p.title, cooldown) }))
    .sort((a, b) => a.cooled - b.cooled)
    .slice(0, 25)
    .map(x => `- ${x.t}${x.cooled ? ' (COOLDOWN — not as hero)' : ''}`)
    .join('\n');

  const pools = {
    retail:        allowedTitles(p => !p.isWholesale),
    wholesale:     allowedTitles(p => p.isWholesale),
    international: allowedTitles(p => p.isWholesale && cfg.isExportEligible(p)) || allowedTitles(cfg.isExportEligible),
  };

  const planLines = [];
  for (const seg of ['retail', 'wholesale', 'international']) {
    (strategy[seg] || []).forEach((e, i) => {
      planLines.push(`- ${seg} email #${i + 1}: type=${e.campaign_type}, day=${e.send_day}${directives?.[seg] ? ` | OWNER STEER: ${directives[seg]}` : ''}`);
    });
  }

  const trendLines = (trends || []).map(t => `- ${t.idea} (${t.why || ''})`).join('\n') || '(no trend data this week)';

  const msg = await claude.messages.create({
    model:      cfg.ANTHROPIC_MODEL,
    max_tokens: 2200,
    messages: [{
      role: 'user',
      content: `You are the creative director for ${cfg.STORE_NAME} (premium botanical / wellness ecommerce + B2B wholesale). Your ONLY job in this step: make sure this week's emails feel NOTHING like recent sends. The pipeline has been criticized for producing "basically the same email every week" — you are the fix.

═══ THE LAST 12 SENDS (do NOT resemble these — not the subjects, not the heroes, not the framing) ═══
${recent}

═══ THIS WEEK'S PLANNED EMAILS (from the strategy phase) ═══
${planLines.join('\n')}

═══ WHAT'S TRENDING IN ECOMMERCE EMAIL MARKETING RIGHT NOW ═══
${trendLines}

═══ ALLOWED PRODUCTS PER SEGMENT (hero must come from here; "COOLDOWN" items may appear as secondary products but NOT as the hero) ═══
RETAIL:
${pools.retail || '(none)'}
WHOLESALE:
${pools.wholesale || '(none)'}
INTERNATIONAL (international-eligible lines only):
${pools.international || '(none)'}

═══ SEASON ═══
${seasonal?.season || '?'} — ${(seasonal?.angles || []).join(', ')}

═══ PROCESS (do this internally) ═══
For EACH planned email: brainstorm 3 genuinely different concepts — different lens (ritual, origin story, craft/process, pairing, myth-bust, seasonal mood, trend format), different hero product, different visual world. Then keep ONLY the one furthest from the last 12 sends. If an owner steer exists for a segment, all concepts must serve that steer.
Hard rules: no two emails this week may share a hero product or a subject structure; heroes must not be COOLDOWN items; nothing fear-based; no invented customer stories or quotes; no invented deadlines or scarcity; retail heroes should still be sellable with a direct product link (product-led beats story for revenue).

═══ OUTPUT (JSON only — arrays aligned with the planned email order above) ═══
{
  "retail": [{"concept_name": "2-4 words", "angle_summary": "1-2 sentences: the fresh angle", "hero_product": "exact title from the allowed list (not COOLDOWN)", "trend_hook": "which trend idea this implements, or null", "subject_direction": "a subject-line direction (structure/tone), not a final subject", "visual_concept": "1 sentence: a scene unlike recent emails", "layout_variant": "A, B or C — differ from that segment's last variant shown above"}],
  "wholesale": [...same shape...],
  "international": [...same shape...]
}
Return ONLY valid JSON.`,
    }],
  });

  const raw  = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error('angle brainstorm did not return JSON');
  const parsed = JSON.parse(json);
  const out = {};
  for (const seg of ['retail', 'wholesale', 'international']) {
    out[seg] = Array.isArray(parsed[seg]) ? parsed[seg] : [];
  }
  return out;
}

module.exports = {
  loadEditorialRules,
  getHeroCooldown,
  inCooldown,
  isBannedProduct,
  filterProductsByRules,
  checkVarietyV2,
  buildRulesPromptBlock,
  buildConceptPromptBlock,
  fetchEmailMarketingTrends,
  generateCreativeAngles,
  skeletonSimilarity,
};
