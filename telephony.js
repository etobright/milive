import { createHmac, timingSafeEqual } from 'node:crypto';

export function equals(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validSignature(url, fields, token, signature) {
  const input = [...fields.keys()].sort().reduce((value, key) => value + key + fields.get(key), url);
  return equals(signature, createHmac('sha1', token).update(input).digest('base64'));
}

export function xml(value) {
  return String(value).replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);
}

export function response(text, action) {
  const say = `<Say language="fr-FR" voice="Polly.Lea">${xml(text)}</Say>`;
  return action
    ? `<Response><Gather input="speech" language="fr-FR" speechTimeout="auto" actionOnEmptyResult="true" action="${xml(action)}">${say}</Gather></Response>`
    : `<Response>${say}<Hangup/></Response>`;
}

export async function dial(config, contact) {
  const webhook = `${config.base}/twilio/${contact.id}`;
  const result = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.account}/Calls.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(config.account + ':' + config.twilioToken).toString('base64') },
    body: new URLSearchParams({
      To: contact.phone,
      From: config.from,
      Url: webhook + '/answer',
      StatusCallback: webhook + '/status',
      StatusCallbackEvent: 'completed',
      Timeout: '25',
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!result.ok) throw new Error(`Twilio HTTP ${result.status}`);
  const { sid } = await result.json();
  if (!/^CA[0-9a-f]{32}$/i.test(sid)) throw new Error('Identifiant d’appel manquant');
  return sid;
}
