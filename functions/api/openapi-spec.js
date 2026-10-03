// =====================================================================
// sitetrace-api — OpenAPI 3.1 spec
//
// GET /api/openapi.json
//
// Returns the OpenAPI 3.1 specification for the sitetrace API. Used by
// /docs as a download link, and as the input to SDK generators (openapi-
// generator, openapi-typescript, etc.) for client libraries.
//
// Public read; matches the /docs page philosophy — "if you can read the docs
// page, you should be able to discover every endpoint".
// =====================================================================

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

// Reusable parameter shapes.
const urlParam = {
  name: 'url', in: 'query', required: true,
  description: 'URL to inspect. Must be http(s).',
  schema: { type: 'string', format: 'uri' },
};

const domainParam = {
  name: 'domain', in: 'query', required: true,
  description: 'Domain name (no scheme, no port).',
  schema: { type: 'string' },
};

const ipParam = {
  name: 'ip', in: 'query',
  description: 'IPv4 or IPv6 address. If omitted, returns the caller’s IP.',
  schema: { type: 'string' },
};

// Endpoint definitions kept terse — full prose lives in /docs.
const endpoints = {
  '/api/shot': {
    get: {
      summary: 'Screenshot a URL',
      description: 'Renders any URL with headless Chrome and returns a PNG or JPEG. Free tier has no auth; quota is per-IP.',
      parameters: [
        urlParam,
        { name: 'device', in: 'query', description: 'desktop | mobile | tablet', schema: { type: 'string', enum: ['desktop','mobile','tablet'], default: 'desktop' } },
        { name: 'width', in: 'query', schema: { type: 'integer', default: 1280 } },
        { name: 'height', in: 'query', schema: { type: 'integer', default: 720 } },
        { name: 'full', in: 'query', description: 'Full page vs viewport', schema: { type: 'boolean', default: false } },
        { name: 'wait', in: 'query', description: 'ms to wait before capture', schema: { type: 'integer', default: 0 } },
        { name: 'dark', in: 'query', schema: { type: 'boolean', default: false } },
        { name: 'format', in: 'query', schema: { type: 'string', enum: ['png','jpeg'], default: 'png' } },
      ],
      responses: {
        200: { description: 'PNG or JPEG image', content: { 'image/png': {}, 'image/jpeg': {} } },
        400: { description: 'Bad URL', $ref: '#/components/responses/Error' },
        429: { description: 'Quota exceeded', $ref: '#/components/responses/Error' },
      },
    },
  },
  '/api/ip': {
    get: {
      summary: 'IP reputation + geolocation',
      description: '7 DNSBLs + ip-api.com geo + risk score. Default IP is the caller’s.',
      parameters: [ipParam],
      responses: {
        200: { description: 'JSON reputation report', content: { 'application/json': { schema: { type: 'object' } } } },
        429: { $ref: '#/components/responses/Error' },
      },
    },
  },
  '/api/email': {
    get: {
      summary: 'Email deliverability score',
      description: 'SPF + DKIM (20 selectors) + DMARC + MX + BIMI, 0–100 score.',
      parameters: [domainParam],
      responses: {
        200: { description: 'JSON deliverability report', content: { 'application/json': { schema: { type: 'object' } } } },
        429: { $ref: '#/components/responses/Error' },
      },
    },
  },
  '/api/headers': {
    get: {
      summary: 'HTTP security header score',
      description: '8 security headers, 0–100 score, A–F grade.',
      parameters: [urlParam],
      responses: {
        200: { description: 'JSON header score', content: { 'application/json': { schema: { type: 'object' } } } },
        429: { $ref: '#/components/responses/Error' },
      },
    },
  },
  '/api/preview': {
    get: {
      summary: 'URL preview / Open Graph',
      description: 'OG + Twitter Card + favicon + theme color from any URL.',
      parameters: [urlParam],
      responses: {
        200: { description: 'JSON OG object', content: { 'application/json': { schema: { type: 'object' } } } },
        429: { $ref: '#/components/responses/Error' },
      },
    },
  },
  '/api/certs': {
    get: {
      summary: 'SSL certificate transparency',
      description: 'Every cert ever issued for the domain. 24h cache.',
      parameters: [
        domainParam,
        { name: 'exclude', in: 'query', description: 'Comma-separated subdomains to exclude', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 200 } },
      ],
      responses: {
        200: { description: 'JSON cert list', content: { 'application/json': { schema: { type: 'object' } } } },
        429: { $ref: '#/components/responses/Error' },
      },
    },
  },
  '/api/account': {
    get: {
      summary: 'Get account info (key, plan, today’s usage)',
      description: 'Auth required. Returns current user record + per-endpoint usage breakdown + aggregate total.',
      parameters: [
        { name: 'key', in: 'query', description: 'API key (or use Authorization header)', schema: { type: 'string' } },
      ],
      responses: {
        200: { description: 'User + quota', content: { 'application/json': { schema: { type: 'object' } } } },
        401: { $ref: '#/components/responses/Error' },
      },
    },
  },
  '/api/signup': {
    post: {
      summary: 'Sign up for a free API key (1,000 calls/day)',
      description: 'Email-only signup. Returns existing key if email is known. No password.',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } } } },
      },
      responses: {
        200: { description: 'New or existing API key', content: { 'application/json': { schema: { type: 'object' } } } },
        400: { $ref: '#/components/responses/Error' },
      },
    },
  },
  '/api/webhook-stats': {
    get: {
      summary: 'Webhook delivery stats (operational)',
      description: 'Per-day, per-status counters from the RATELIMIT KV namespace. Public.',
      responses: {
        200: { description: 'JSON by_day + last_24h', content: { 'application/json': { schema: { type: 'object' } } } },
      },
    },
  },
};

export async function onRequestGet() {
  return json({
    openapi: '3.1.0',
    info: {
      title: 'sitetrace API',
      version: '1.0.0',
      description: 'Six utility APIs for developers: screenshots, IP reputation, email deliverability, HTTP header scoring, URL preview, SSL certificate lookup. Free tier is 100 calls/day without signup; 1,000/day with a free key; higher tiers via Paddle Billing.',
      contact: { url: 'https://sitetrace.it.com' },
      license: { name: 'Proprietary' },
    },
    servers: [
      { url: 'https://api.sitetrace.it.com', description: 'Production' },
    ],
    tags: [
      { name: 'tools', description: 'The 6 utility endpoints' },
      { name: 'account', description: 'Self-service account / usage' },
      { name: 'webhooks', description: 'Operational metadata' },
    ],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'stk_<40 alphanumerics>' },
      },
      responses: {
        Error: {
          description: 'Error response',
          content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } } } },
        },
      },
    },
    security: [{ bearer: [] }],
    paths: endpoints,
  });
}