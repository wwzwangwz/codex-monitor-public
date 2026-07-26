const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApnsSender, createFcmSender, pushSenderFromEnvironment } = require('../src/push');

function response(status, value) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

test('FCM sender obtains one OAuth token and sends high-priority lamp data', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls = [];
  const sender = createFcmSender({
    serviceAccount: {
      client_email: 'relay@example.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      project_id: 'codex-monitor-test',
    },
    now: () => 1_000_000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1
        ? response(200, { access_token: 'oauth-token', expires_in: 3600 })
        : response(200, { name: 'message-1' });
    },
  });
  await sender(
    { platform: 'android', pushToken: 'device-push-token' },
    {
      type: 'lamp_changed', deviceId: 'd1', sessionId: 's1',
      fromState: 'running', toState: 'completed', silent: false,
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.match(String(calls[0].options.body), /grant_type=/);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer oauth-token');
  const message = JSON.parse(calls[1].options.body).message;
  assert.equal(message.token, 'device-push-token');
  assert.equal(message.android.priority, 'high');
  assert.equal(message.data.toState, 'completed');
  assert.equal(message.data.silent, 'false');

  await sender(
    { platform: 'android', pushToken: 'second-token' },
    { type: 'lamp_changed', toState: 'blocked' },
  );
  assert.equal(calls.filter((call) => call.url === 'https://oauth2.googleapis.com/token').length, 1);
});

test('push provider remains disabled without credentials and rejects incomplete credentials', () => {
  assert.equal(pushSenderFromEnvironment({}), null);
  assert.throws(
    () => pushSenderFromEnvironment({ CODEX_MONITOR_FCM_SERVICE_ACCOUNT: '{}' }),
    /incomplete/,
  );
});

test('APNs sender signs an ES256 provider token and preserves silent Jarvis alerts', async () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const calls = [];
  const sender = createApnsSender({
    credentials: {
      teamId: 'TEAM123456', keyId: 'KEY1234567', bundleId: 'com.codexmonitor.ios',
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), environment: 'sandbox',
    },
    now: () => 1_000_000,
    requestImpl: async (origin, headers, body) => {
      calls.push({ origin, headers, body: JSON.parse(body) });
      return 200;
    },
  });
  await sender(
    { platform: 'ios', pushToken: 'apns-device-token' },
    {
      type: 'lamp_changed', deviceId: 'd1', deviceName: 'Primary Mac',
      sessionId: 's1', sessionTitle: '贾维斯会话', fromState: 'running', toState: 'completed', silent: true,
    },
  );
  assert.equal(calls[0].origin, 'https://api.sandbox.push.apple.com');
  assert.equal(calls[0].headers['apns-topic'], 'com.codexmonitor.ios');
  assert.equal(calls[0].headers['apns-push-type'], 'alert');
  assert.equal(calls[0].headers.authorization.split(' ')[1].split('.').length, 3);
  assert.equal(calls[0].body.aps.alert.title, 'Primary Mac · 已完成');
  assert.equal(calls[0].body.aps.sound, undefined);
  assert.equal(calls[0].body.codex.sessionId, 's1');
});

test('environment sender routes Android and iPhone to their configured providers', async () => {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  const fcmCalls = [];
  const apnsCalls = [];
  const sender = pushSenderFromEnvironment({
    CODEX_MONITOR_FCM_SERVICE_ACCOUNT: JSON.stringify({
      client_email: 'relay@example.com', private_key: rsa.export({ type: 'pkcs8', format: 'pem' }), project_id: 'p1',
    }),
    CODEX_MONITOR_APNS_CREDENTIALS: JSON.stringify({
      teamId: 'TEAM', keyId: 'KEY', bundleId: 'com.codexmonitor.ios',
      privateKey: ec.export({ type: 'pkcs8', format: 'pem' }), environment: 'production',
    }),
  }, {
    now: () => 1_000_000,
    fetchImpl: async (url) => {
      fcmCalls.push(url);
      return fcmCalls.length === 1 ? response(200, { access_token: 'token', expires_in: 3600 }) : response(200, {});
    },
    apnsRequestImpl: async (origin) => { apnsCalls.push(origin); return 200; },
  });
  await sender({ platform: 'android', pushToken: 'android-token' }, { type: 'lamp_changed' });
  await sender({ platform: 'ios', pushToken: 'ios-token' }, { type: 'lamp_changed' });
  assert.equal(fcmCalls.length, 2);
  assert.deepEqual(apnsCalls, ['https://api.push.apple.com']);
});
