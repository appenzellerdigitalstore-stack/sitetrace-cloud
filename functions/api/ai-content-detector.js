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
// Language detection (lightweight heuristic)
// ---------------------------------------------------------------------

const EN_STOPWORDS = new Set(['the','a','an','is','are','was','were','and','or','but','if','then','this','that','these','those','have','has','had','do','does','did','will','would','should','could','of','in','on','at','to','for','with','from','by','as','be','been','being','i','you','he','she','it','we','they','me','him','her','us','them','my','your','his','its','our','their']);

const ES_STOPWORDS = new Set(['el','la','los','las','un','una','unos','unas','y','o','u','pero','si','de','del','en','a','por','para','con','sin','sobre','entre','es','son','fue','fueron','ha','han','que','se','me','te','mi','tu','su','nuestro']);

function detectLanguage(text) {
  const words = text.toLowerCase().replace(/[^a-záéíóúñ\s]/gi, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return { code: 'unknown', confidence: 0, note: 'no text' };

  // Script detection (rough)
  let cyrillic = 0, han = 0, arabic = 0, latin = 0, devanagari = 0;
  for (const ch of text) {
    if (/[\u0400-\u04FF]/.test(ch)) cyrillic++;
    else if (/[\u4E00-\u9FFF]/.test(ch)) han++;
    else if (/[\u0600-\u06FF]/.test(ch)) arabic++;
    else if (/[\u0900-\u097F]/.test(ch)) devanagari++;
    else if (/[A-Za-z\u00C0-\u024F]/.test(ch)) latin++;
  }
  const total = cyrillic + han + arabic + latin + devanagari;
  if (total === 0) return { code: 'unknown', confidence: 0, note: 'no characters' };
  if (han / total > 0.5) return { code: 'zh', name: 'Chinese (Simplified/Traditional)', confidence: 0.95, script: 'han' };
  if (cyrillic / total > 0.5) return { code: 'ru', name: 'Russian', confidence: 0.7, script: 'cyrillic', note: 'heuristic only — Cyrillic-script variants not disambiguated' };
  if (arabic / total > 0.5) return { code: 'ar', name: 'Arabic', confidence: 0.9, script: 'arabic' };
  if (devanagari / total > 0.5) return { code: 'hi', name: 'Hindi', confidence: 0.85, script: 'devanagari' };

  // Latin: English vs Spanish by stopword count
  let en = 0, es = 0;
  for (const w of words) {
    if (EN_STOPWORDS.has(w)) en++;
    if (ES_STOPWORDS.has(w)) es++;
  }
  const enRatio = en / words.length;
  const esRatio = es / words.length;
  if (enRatio > esRatio && enRatio > 0.05) return { code: 'en', name: 'English', confidence: Math.min(0.95, enRatio * 5), script: 'latin' };
  if (esRatio > enRatio && esRatio > 0.05) return { code: 'es', name: 'Spanish', confidence: Math.min(0.95, esRatio * 5), script: 'latin' };
  return { code: 'latin_unspecified', name: 'Latin (unspecified)', confidence: 0.3, script: 'latin', note: 'could be English, Spanish, French, German, Italian, etc. — heuristic only' };
}

// Heuristic check: AI detector signals are calibrated for English. Other
// languages produce low signal-to-noise, so we say so explicitly.
function detectorSupportsLanguage(languageCode) {
  return ['en', 'en-unknown', 'unknown'].includes(languageCode) || languageCode.startsWith('en');
}

function languageCaveat(languageCode) {
  if (languageCode === 'en') return null;
  if (languageCode && languageCode.startsWith('en')) return null;
  return `Detection signals are calibrated for English. Results for ${languageCode} have lower accuracy — treat as a rough guide only.`;
}

// ---------------------------------------------------------------------
// Per-paragraph scoring
// ---------------------------------------------------------------------

function analyzeParagraphs(text, full) {
  // Split on double-newline (paragraph boundary), fall back to single newline
  const rawParagraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length >= 60);
  if (rawParagraphs.length === 0) {
    return { paragraphs: [], summary: 'no_paragraphs_detected' };
  }
  let totalScored = 0, totalProb = 0, flagged = 0, clean = 0;
  const out = rawParagraphs.slice(0, 50).map((para, idx) => {
    const stats = computeAIScore(para);
    if (stats.error) {
      return { index: idx, length: para.length, error: stats.error };
    }
    totalScored++;
    totalProb += stats.ai_probability;
    const label = stats.label;
    if (['likely_ai', 'possibly_ai'].includes(label)) flagged++;
    else clean++;
    return {
      index: idx,
      length: para.length,
      ai_probability: stats.ai_probability,
      label,
      signals: stats.signals,
      preview: para.slice(0, 120).replace(/\s+/g, ' ').trim() + (para.length > 120 ? '…' : ''),
    };
  });
  if (totalScored === 0) return { paragraphs: out, summary: 'no_scored_paragraphs' };
  const mixed = out.filter((p) => p.label === 'uncertain').length;
  return {
    paragraphs: out,
    summary: {
      total_paragraphs: out.length,
      scored: totalScored,
      flagged_paragraphs: flagged,
      clean_paragraphs: clean,
      uncertain: mixed,
      mean_ai_probability: Math.round(totalProb / totalScored),
    },
  };
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

function filterByPlan(plan, analysis, language, paragraphs) {
  const result = {
    ai_probability: analysis.ai_probability,
    label: analysis.label,
    word_count: analysis.word_count,
    sentence_count: analysis.sentence_count,
    language: { code: language.code, name: language.name, confidence: language.confidence },
    plan,
  };
  if (language.note) result.language.note = language.note;
  const caveat = languageCaveat(language.code);
  if (caveat) result.language.calibration_caveat = caveat;
  if (plan !== 'free') {
    result.signals = analysis.signals;
    if (paragraphs && paragraphs.paragraphs && paragraphs.paragraphs.length > 0) {
      result.paragraph_summary = paragraphs.summary;
    }
  }
  if (plan === 'ultra' || plan === 'mega') {
    result.interpretation = INTERPRETATION_MAP[analysis.label];
    result.disclaimer = DISCLAIMER;
    if (paragraphs && paragraphs.paragraphs && paragraphs.paragraphs.length > 0) {
      result.paragraphs = paragraphs.paragraphs;
    }
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

  // Language detection (cheap — no external API call)
  const language = detectLanguage(text);
  // Per-paragraph scoring (more expensive — done only for paid tiers)
  const paragraphs = (plan !== 'free') ? analyzeParagraphs(text, analysis) : { paragraphs: [], summary: 'free_tier_skipped' };

  const result = filterByPlan(plan, analysis, language, paragraphs);
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

// Dual-export: expose helpers for Node.js test runner
if (typeof module !== 'undefined') {
  module.exports = {
    getSentences,
    getWords,
    computeBurstiness,
    computeTTR,
    countAIPhrases,
    passiveDensity,
    paragraphUniformity,
    analyzeParagraphs,
    computeAIScore,
    planMaxChars,
    filterByPlan,
    detectLanguage,
    detectorSupportsLanguage,
    languageCaveat,
    AI_PHRASES,
    EN_STOPWORDS,
    ES_STOPWORDS,
  };
}