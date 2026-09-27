// =====================================================================
// sitetrace-api — AI Content Detector endpoint (Cloudflare Workers)
//
// Migrated from F:\.Projects\api-marketplace\ai-content-detector\index.js
//   - Removed express dependency (Workers-incompatible)
//   - POST kept (text input varies widely; edge cache not useful)
//   - Same 5 statistical heuristics preserved verbatim
//   - Same plan-based filtering (free/pro/ultra/mega)
//
// Endpoint: POST /api/ai-content-detector
// Body: { "text": "..." }
// Auth: shared middleware (functions/_middleware.js)
// =====================================================================

// Common AI filler phrases — direct from the original
const AI_PHRASES = [
  /\bin the realm of\b/i,
  /\bdelve into\b/i,
  /\bit is worth noting\b/i,
  /\bfurthermore\b/i,
  /\bin conclusion\b/i,
  /\bin summary\b/i,
  /\bto summarize\b/i,
  /\bit is important to note\b/i,
  /\bit's worth mentioning\b/i,
  /\bsignificantly\b/i,
  /\bmoreover\b/i,
  /\bhowever, it is\b/i,
  /\bultimately\b/i,
  /\bnotably\b/i,
  /\bin today's (?:world|society|digital age|landscape)\b/i,
  /\bseamlessly\b/i,
  /\blocal(?:ly)? and global(?:ly)?\b/i,
  /\bever-changing\b/i,
  /\blandscape\b/i,
  /\bcutting-edge\b/i,
  /\bstate-of-the-art\b/i,
  /\bleverage\b/i,
  /\bunderscores\b/i,
  /\bfostering\b/i,
  /\bempowering\b/i,
];

const PASSIVE_VOICE_RE = /\b(?:is|are|was|were|be|been|being)\s+\w+ed\b/gi;

const INTERPRETATION_MAP = {
  likely_ai:    'High probability of AI generation (75–100%)',
  possibly_ai:  'Moderate AI signals detected (50–74%)',
  uncertain:    'Mixed signals, could be either (25–49%)',
  likely_human: 'Low AI signals, likely human-written (0–24%)',
};

const DISCLAIMER =
  'Results are probabilistic heuristics, not ground truth. ' +
  'Human-like AI text and formal human writing can produce similar scores.';

// ---------------------------------------------------------------------
// Linguistic signal extractors (verbatim port of the original logic)
// ---------------------------------------------------------------------

function getSentences(text) {
  return (text.match(/[^.!?]+[.!?]+/g) || []).map(s => s.trim()).filter(s => s.length > 10);
}

function getWords(text) {
  return text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
}

// Burstiness: variance in sentence length (human text tends to vary more)
function computeBurstiness(sentences) {
  if (sentences.length < 3) return 0;
  const lengths = sentences.map(s => s.split(/\s+/).length);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((sum, l) => sum + Math.pow(l - mean, 2), 0) / lengths.length;
  return Math.sqrt(variance); // standard deviation
}

// Vocabulary richness: type-token ratio (unique words / total words)
function computeTTR(words) {
  if (words.length === 0) return 0;
  const unique = new Set(words);
  return unique.size / words.length;
}

function avgSentenceLength(sentences) {
  if (sentences.length === 0) return 0;
  return sentences.reduce((s, sent) => s + sent.split(/\s+/).length, 0) / sentences.length;
}

function countAIPhrases(text) {
  return AI_PHRASES.reduce((count, re) => count + (re.test(text) ? 1 : 0), 0);
}

function passiveDensity(text, sentences) {
  const matches = (text.match(PASSIVE_VOICE_RE) || []).length;
  return sentences.length > 0 ? matches / sentences.length : 0;
}

function paragraphUniformity(text) {
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 20);
  if (paragraphs.length < 2) return 0;
  const lengths = paragraphs.map(p => p.length);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((s, l) => s + Math.pow(l - mean, 2), 0) / lengths.length;
  const cv = Math.sqrt(variance) / mean; // coefficient of variation; lower = more uniform
  return Math.max(0, 1 - cv); // high = uniform = AI signal
}

// ---------------------------------------------------------------------
// Score aggregator
// ---------------------------------------------------------------------

function computeAIScore(text) {
  const sentences = getSentences(text);
  const words = getWords(text);

  if (words.length < 20) {
    return { error: 'Text too short for analysis (minimum ~20 words)' };
  }

  const burstiness = computeBurstiness(sentences);  // low = AI signal
  const ttr        = computeTTR(words);             // low = AI signal
  const avgLen     = avgSentenceLength(sentences);  // very uniform = AI signal
  const aiPhrases  = countAIPhrases(text);          // high = AI signal
  const passiveDens = passiveDensity(text, sentences); // high = AI signal
  const paraUniform = paragraphUniformity(text);    // high = AI signal

  // Normalize signals to 0–1 where 1 = strong AI signal
  const signals = {
    low_burstiness:           Math.max(0, 1 - burstiness / 12),
    low_vocabulary_richness:  Math.max(0, 1 - (ttr - 0.3) / 0.5),
    ai_phrase_density:        Math.min(1, aiPhrases / 5),
    passive_voice:            Math.min(1, passiveDens / 0.4),
    paragraph_uniformity:     paraUniform,
  };

  const weights = {
    low_burstiness:           0.25,
    low_vocabulary_richness:  0.20,
    ai_phrase_density:        0.30,
    passive_voice:            0.10,
    paragraph_uniformity:     0.15,
  };

  let score = 0;
  for (const [key, weight] of Object.entries(weights)) {
    score += (signals[key] || 0) * weight;
  }
  score = Math.round(Math.min(1, Math.max(0, score)) * 100);

  const label = score >= 75 ? 'likely_ai'
              : score >= 50 ? 'possibly_ai'
              : score >= 25 ? 'uncertain'
              : 'likely_human';

  return {
    ai_probability: score,
    label,
    word_count: words.length,
    sentence_count: sentences.length,
    signals: {
      burstiness_score:      Math.round(burstiness * 10) / 10,
      vocabulary_richness:   Math.round(ttr * 100) / 100,
      avg_sentence_length:   Math.round(avgLen * 10) / 10,
      ai_phrases_detected:   aiPhrases,
      passive_voice_density: Math.round(passiveDens * 100) / 100,
      paragraph_uniformity:  Math.round(paraUniform * 100) / 100,
    },
  };
}

// ---------------------------------------------------------------------
// Plan-based filter (mirrors original behavior)
// ---------------------------------------------------------------------

function planMaxChars(plan) {
  switch (plan) {
    case 'mega':  return 25000;
    case 'ultra': return 25000;
    case 'pro':   return 5000;
    case 'free':
    default:      return 1000;
  }
}

function filterByPlan(plan, analysis) {
  const result = {
    ai_probability: analysis.ai_probability,
    label: analysis.label,
    word_count: analysis.word_count,
    sentence_count: analysis.sentence_count,
    plan,
  };
  if (plan !== 'free') {
    result.signals = analysis.signals;
  }
  if (plan === 'ultra' || plan === 'mega') {
    result.interpretation = INTERPRETATION_MAP[analysis.label];
    result.disclaimer = DISCLAIMER;
  }
  return result;
}

// ---------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

async function readBody(request) {
  try {
    const ct = (request.headers.get('content-type') || '').toLowerCase();
    const raw = await request.text();
    if (!raw) return {};
    if (ct.includes('application/json')) {
      return JSON.parse(raw);
    }
    // Form-encoded fallback
    const params = new URLSearchParams(raw);
    const obj = {};
    for (const [k, v] of params) obj[k] = v;
    return obj;
  } catch (_) {
    return {};
  }
}

// ---------------------------------------------------------------------
// Main handler — POST (text in body)
// ---------------------------------------------------------------------

export async function onRequestPost(context) {
  const { request, data } = context;
  const plan = data?.user?.plan || 'free';

  const body = await readBody(request);
  const text = body?.text;

  if (!text || typeof text !== 'string') {
    return jsonResponse({
      error: 'invalid_request',
      message: 'text is required (JSON body field "text")',
    }, 400);
  }

  const maxChars = planMaxChars(plan);
  if (text.length > maxChars) {
    return jsonResponse({
      error: 'plan_limit',
      message: `Text exceeds plan limit of ${maxChars} characters`,
      plan,
      current_length: text.length,
    }, 400);
  }

  const analysis = computeAIScore(text);
  if (analysis.error) {
    return jsonResponse({ error: 'analysis_failed', message: analysis.error }, 400);
  }

  const result = filterByPlan(plan, analysis);
  return jsonResponse({ success: true, data: result }, 200);
}

// ---------------------------------------------------------------------
// CORS preflight
// ---------------------------------------------------------------------

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}