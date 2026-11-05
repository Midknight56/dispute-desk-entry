import { pathToFileURL } from 'node:url';
import { DESK } from './desk_url.mjs';

function responseBody(body) {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function header(headers, name) {
  if (headers instanceof Headers) return headers.get(name) ?? '';
  const key = Object.keys(headers ?? {}).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : '';
}

function statusIs(status, expected) {
  return status === expected ? 'ok' : `status was ${status}, expected ${expected}`;
}

function isHtml(headers) {
  return header(headers, 'content-type').toLowerCase().includes('text/html');
}

export function checkHealth(status, headers, body) {
  const statusResult = statusIs(status, 200);
  if (statusResult !== 'ok') return statusResult;
  const parsed = responseBody(body);
  return parsed?.ok === true && parsed?.app === 'dispute-desk' ? 'ok' : 'body was not the expected health JSON';
}

export function checkHome(status, headers, body) {
  const statusResult = statusIs(status, 200);
  if (statusResult !== 'ok') return statusResult;
  if (!isHtml(headers)) return 'content type was not HTML';
  const requirements = [
    ['content-security-policy', "default-src 'self'"],
    ['x-content-type-options', 'nosniff'],
    ['x-frame-options', 'DENY'],
    ['referrer-policy', ''],
  ];
  for (const [name, expected] of requirements) {
    const actual = header(headers, name);
    if (!actual || (expected && !actual.includes(expected))) return `missing or invalid ${name}`;
  }
  return 'ok';
}

export function checkStudio(status, headers, body) {
  const statusResult = statusIs(status, 200);
  if (statusResult !== 'ok') return statusResult;
  return isHtml(headers) ? 'ok' : 'content type was not HTML';
}

export function checkDisputes(status, headers, body) {
  const statusResult = statusIs(status, 200);
  if (statusResult !== 'ok') return statusResult;
  const parsed = responseBody(body);
  return Array.isArray(parsed) ? 'ok' : 'body was not a JSON array';
}

export function checkUsage(status, headers, body) {
  const statusResult = statusIs(status, 200);
  if (statusResult !== 'ok') return statusResult;
  const parsed = responseBody(body);
  const fields = ['runs', 'appNeurons', 'appCap', 'accountNeurons', 'accountCap'];
  if (!parsed || typeof parsed.day !== 'string' || fields.some((field) => typeof parsed[field] !== 'number'))
    return 'body was missing numeric usage fields';
  return parsed.appNeurons <= parsed.appCap ? 'ok' : 'app neurons exceeded app cap';
}

export function checkPool(status, headers, body) {
  const statusResult = statusIs(status, 200);
  if (statusResult !== 'ok') return statusResult;
  const parsed = responseBody(body);
  if (!Array.isArray(parsed)) return 'body was not a JSON list';
  for (const item of parsed) {
    if (!item || typeof item.kind !== 'string' || typeof item.total !== 'number' || typeof item.free !== 'number')
      return 'pool item was missing kind, total, or free';
    if (item.free > item.total) return 'free cases exceeded total cases';
  }
  return 'ok';
}

export function checkForgedWebhook(status, headers, body) {
  return status === 400 ? 'ok' : `status was ${status}, expected 400`;
}

export function checkApproveWithoutKey(status, headers, body) {
  return status === 403 || status === 404 ? 'ok' : `status was ${status}, expected 403 or 404`;
}

export function checkMissingDispute(status, headers, body) {
  return statusIs(status, 404);
}

function connectionFailure(error) {
  let current = error;
  while (current) {
    if (
      [
        'ECONNREFUSED',
        'ECONNRESET',
        'ETIMEDOUT',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'ENOTFOUND',
        'UND_ERR_CONNECT_TIMEOUT',
      ].includes(current.code)
    )
      return true;
    current = current.cause;
  }
  return false;
}

let sessionCookie = '';
async function request(path, options = {}) {
  const headers = new Headers(options.headers);
  if (sessionCookie) headers.set('cookie', sessionCookie);
  headers.set('user-agent', 'DisputeDeskTools/1.0');
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${DESK}${path}`, { ...options, headers });
      const cookie = response.headers.get('set-cookie');
      if (cookie) sessionCookie = cookie.split(';')[0];
      return { status: response.status, headers: response.headers, body: await response.text() };
    } catch (error) {
      if (attempt >= 3 || !connectionFailure(error)) throw error;
    }
  }
}

const checks = [
  ['health', '/health', {}, checkHealth],
  ['home', '/', {}, checkHome],
  ['studio', '/studio', {}, checkStudio],
  ['disputes', '/api/disputes', {}, checkDisputes],
  ['usage', '/api/usage', {}, checkUsage],
  ['judge pool', '/api/judge/pool', {}, checkPool],
  [
    'forged webhook',
    '/webhooks/paypal',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://example.invalid/cert.pem',
        'paypal-transmission-id': 'made-up-transmission',
        'paypal-transmission-sig': 'made-up-signature',
        'paypal-transmission-time': '2026-01-01T00:00:00Z',
      },
      body: JSON.stringify({ id: 'MADE-UP-EVENT', event_type: 'CUSTOMER.DISPUTE.CREATED', resource: {} }),
    },
    checkForgedWebhook,
  ],
  [
    'approve without key',
    '/api/disputes/PP-R-NOPE-1/approve',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    checkApproveWithoutKey,
  ],
  ['missing dispute', '/api/disputes/PP-R-NOPE-1', {}, checkMissingDispute],
];

export async function runSmoke() {
  sessionCookie = '';
  let failed = false;
  for (const [name, path, options, check] of checks) {
    let result;
    try {
      const response = await request(path, options);
      result = check(response.status, response.headers, response.body);
    } catch (error) {
      result = `request failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    console.log(`${result === 'ok' ? 'ok' : 'FAIL'} ${name}${result === 'ok' ? '' : `: ${result}`}`);
    if (result !== 'ok') failed = true;
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runSmoke();
