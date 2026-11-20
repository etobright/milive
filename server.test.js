import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from './server.js';

test('intégration CRM, webhooks téléphoniques, suivi durable et retrait du numéro', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssp-'));
  const config = { dbPath: join(directory, 'calls.sqlite'), base: 'https://example.test', account: 'AC' + '1'.repeat(32),
    twilioToken: 'test-signing-key', from: '+33199000000', crmToken: 'test-crm', dashboardPassword: 'test-dashboard' };
  const sid = 'CA' + '1'.repeat(32);
  let attempts = 0;
  let app;
  let origin;
  async function start() {
    app = createApp(config, async () => { attempts++; return sid; });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    origin = `http://127.0.0.1:${app.address().port}`;
  }
  const dashboardHeaders = { Authorization: 'Basic ' + Buffer.from('ssp:' + config.dashboardPassword).toString('base64') };
  const lead = (externalId, phone) => fetch(origin + '/api/leads', {
    method: 'POST', headers: { Authorization: 'Bearer ' + config.crmToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ externalId, phone, callbackAuthorized: true }),
  });
  const callback = (path, fields = {}, signed = true) => {
    const form = new URLSearchParams({ CallSid: sid, ...fields });
    const payload = [...form.keys()].sort().reduce((input, key) => input + key + form.get(key), config.base + path);
    const signature = createHmac('sha1', config.twilioToken).update(payload).digest('base64');
    return fetch(origin + path, { method: 'POST', headers: { 'X-Twilio-Signature': signed ? signature : 'invalid' }, body: form });
  };
  try {
    await start();
    assert.equal((await fetch(origin + '/api/calls')).status, 401);
    const phone = '+33199000001';
    const created = await lead('DOS-8', phone);
    assert.equal(created.status, 202);
    const { id } = await created.json();
    assert.equal((await lead('DOS-8', phone)).status, 200);
    assert.equal(attempts, 1);
    const path = '/twilio/' + id;
    assert.equal((await callback(path + '/answer', {}, false)).status, 403);
    assert.match(await (await callback(path + '/answer')).text(), /<Gather/);
    await callback(path + '/reply?step=1', { SpeechResult: 'Oui, je suis disponible.' });
    await callback(path + '/reply?step=2', { SpeechResult: 'Un devis prévoyance.' });
    assert.match(await (await callback(path + '/reply?step=3', { SpeechResult: 'Demain matin.' })).text(), /<Hangup\/>/);
    assert.equal((await callback(path + '/status', { CallStatus: 'completed' })).status, 204);
    await new Promise(resolve => app.close(resolve));
    await start();
    const { calls } = await (await fetch(origin + '/api/calls', { headers: dashboardHeaders })).json();
    assert.deepEqual(calls[0].report, { need: 'Un devis prévoyance.', callback: 'Demain matin.' });
    assert.equal(calls[0].pending, true);
    const lookup = await fetch(origin + '/api/leads?externalId=DOS-8', { headers: { Authorization: 'Bearer ' + config.crmToken } });
    assert.deepEqual(await lookup.json(), calls[0]);
    assert.equal((await fetch(origin + '/api/calls/' + id + '/close', {
      method: 'POST', headers: { ...dashboardHeaders, 'X-SSP-Action': 'close' },
    })).status, 200);
    await callback(path + '/status', { CallStatus: 'completed' });
    const refreshed = await (await fetch(origin + '/api/calls', { headers: dashboardHeaders })).json();
    assert.equal(refreshed.calls[0].pending, false);
    const second = await (await lead('DOS-9', phone)).json();
    await callback('/twilio/' + second.id + '/answer');
    await callback('/twilio/' + second.id + '/reply?step=1', { SpeechResult: 'Ne me rappelez pas.' });
    assert.equal((await lead('DOS-10', phone)).status, 409);
    assert.equal(attempts, 2);
  } finally {
    await new Promise(resolve => app.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
