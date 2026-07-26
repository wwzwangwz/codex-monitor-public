const crypto = require('node:crypto');
const http2 = require('node:http2');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function createFcmSender({ serviceAccount, fetchImpl = fetch, now = Date.now }) {
  if (!serviceAccount?.client_email || !serviceAccount?.private_key || !serviceAccount?.project_id) {
    throw new Error('FCM service account is incomplete');
  }
  let cachedToken = null;
  let cachedUntil = 0;

  async function accessToken() {
    const nowSeconds = Math.floor(now() / 1000);
    if (cachedToken && nowSeconds < cachedUntil) return cachedToken;
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = base64url(JSON.stringify({
      iss: serviceAccount.client_email,
      scope: FCM_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }));
    const signingInput = `${header}.${claim}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), serviceAccount.private_key)
      .toString('base64url');
    const response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${signingInput}.${signature}`,
      }),
    });
    if (!response.ok) throw new Error(`FCM OAuth failed (${response.status})`);
    const value = await response.json();
    if (!value.access_token) throw new Error('FCM OAuth response has no access token');
    cachedToken = value.access_token;
    cachedUntil = nowSeconds + Math.max(60, Number(value.expires_in) || 3600) - 60;
    return cachedToken;
  }

  return async (target, event) => {
    if (target.platform !== 'android') throw new Error(`Unsupported push platform: ${target.platform}`);
    const token = await accessToken();
    const data = Object.fromEntries(Object.entries(event).map(([key, value]) => [key, String(value)]));
    const response = await fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(serviceAccount.project_id)}/messages:send`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { token: target.pushToken, data, android: { priority: 'high' } } }),
      },
    );
    if (!response.ok) throw new Error(`FCM send failed (${response.status})`);
  };
}

function defaultApnsRequest(origin, headers, body) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(origin);
    let settled = false;
    const finish = (error, status) => {
      if (settled) return;
      settled = true;
      client.close();
      if (error) reject(error); else resolve(status);
    };
    client.once('error', (error) => finish(error));
    const request = client.request(headers);
    let status = 0;
    request.on('response', (value) => {
      status = Number(value[':status']) || 0;
      request.resume();
    });
    request.once('error', (error) => finish(error));
    request.once('end', () => finish(null, status));
    request.end(body);
  });
}

function createApnsSender({ credentials, requestImpl = defaultApnsRequest, now = Date.now }) {
  if (!credentials?.teamId || !credentials?.keyId || !credentials?.bundleId || !credentials?.privateKey) {
    throw new Error('APNs credentials are incomplete');
  }
  const origin = credentials.environment === 'sandbox'
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com';
  let cachedJwt = null;
  let cachedUntil = 0;

  function providerToken() {
    const nowSeconds = Math.floor(now() / 1000);
    if (cachedJwt && nowSeconds < cachedUntil) return cachedJwt;
    const header = base64url(JSON.stringify({ alg: 'ES256', kid: credentials.keyId }));
    const claim = base64url(JSON.stringify({ iss: credentials.teamId, iat: nowSeconds }));
    const signingInput = `${header}.${claim}`;
    const signature = crypto.sign(null, Buffer.from(signingInput), {
      key: credentials.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    cachedJwt = `${signingInput}.${signature}`;
    cachedUntil = nowSeconds + 50 * 60;
    return cachedJwt;
  }

  return async (target, event) => {
    if (target.platform !== 'ios') throw new Error(`Unsupported push platform: ${target.platform}`);
    const labels = { running: '正在运行', blocked: '发生错误或受阻', completed: '已完成', unknown: '状态未知' };
    const aps = {
      alert: {
        title: `${event.deviceName || '电脑'} · ${labels[event.toState] || '状态变化'}`,
        body: event.sessionTitle || 'Codex 会话',
      },
      'thread-id': event.deviceId || 'codex-monitor',
    };
    if (!event.silent) aps.sound = 'default';
    const body = JSON.stringify({ aps, codex: event });
    const status = await requestImpl(origin, {
      ':method': 'POST',
      ':path': `/3/device/${encodeURIComponent(target.pushToken)}`,
      authorization: `bearer ${providerToken()}`,
      'apns-topic': credentials.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    }, body);
    if (status < 200 || status >= 300) throw new Error(`APNs send failed (${status})`);
  };
}

function pushSenderFromEnvironment(environment = process.env, options = {}) {
  let fcm = null;
  let apns = null;
  if (environment.CODEX_MONITOR_FCM_SERVICE_ACCOUNT) {
    let serviceAccount;
    try { serviceAccount = JSON.parse(environment.CODEX_MONITOR_FCM_SERVICE_ACCOUNT); } catch (error) {
      throw new Error(`CODEX_MONITOR_FCM_SERVICE_ACCOUNT is invalid JSON: ${error.message}`);
    }
    fcm = createFcmSender({ serviceAccount, fetchImpl: options.fetchImpl, now: options.now });
  }
  if (environment.CODEX_MONITOR_APNS_CREDENTIALS) {
    let credentials;
    try { credentials = JSON.parse(environment.CODEX_MONITOR_APNS_CREDENTIALS); } catch (error) {
      throw new Error(`CODEX_MONITOR_APNS_CREDENTIALS is invalid JSON: ${error.message}`);
    }
    apns = createApnsSender({ credentials, requestImpl: options.apnsRequestImpl, now: options.now });
  }
  if (!fcm && !apns) return null;
  return (target, event) => {
    if (target.platform === 'android' && fcm) return fcm(target, event);
    if (target.platform === 'ios' && apns) return apns(target, event);
    throw new Error(`Push provider is not configured for ${target.platform}`);
  };
}

module.exports = { createApnsSender, createFcmSender, pushSenderFromEnvironment };
