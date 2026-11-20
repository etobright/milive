import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { advance, summarize } from './agent.js';
import { dial, equals, response, validSignature } from './telephony.js';

const e164 = /^\+[1-9]\d{7,14}$/;
const statuses = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);
const staticFiles = { '/': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };
const opening = 'Bonjour, je suis l’assistant vocal automatisé de Solidarité Sérénité Prévoyance. Je vous contacte au sujet de votre demande de rappel. Cette conversation sera transcrite pour le suivi. Avez-vous un instant et acceptez-vous de continuer ?';
const newCall = () => ({ stage: 'consent', followUp: true, messages: [{ role: 'agent', text: opening }] });
const json = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));

async function readBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16384) throw Object.assign(new Error('Requête trop volumineuse'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

export function createApp(config, placeCall = dial) {
  if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(config.dbPath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY, external_id TEXT UNIQUE NOT NULL, phone TEXT NOT NULL, name TEXT NOT NULL,
      created TEXT NOT NULL, state TEXT NOT NULL, sid TEXT, conversation TEXT, pending INTEGER NOT NULL,
      turn INTEGER NOT NULL DEFAULT 0, last_xml TEXT
    );
    CREATE TABLE IF NOT EXISTS suppressed (phone TEXT PRIMARY KEY);
    UPDATE calls SET state = 'dispatch-unknown', pending = 1 WHERE state = 'dispatching';`);
  const get = db.prepare('SELECT * FROM calls WHERE id = ?');
  const byExternal = db.prepare('SELECT * FROM calls WHERE external_id = ?');
  const agentReady = Boolean(config.base && config.account && config.twilioToken && config.from);
  const dashboardAuth = 'Basic ' + Buffer.from('ssp:' + config.dashboardPassword).toString('base64');
  function project(row) {
    const conversation = row.conversation && JSON.parse(row.conversation);
    return { id: row.id, externalId: row.external_id, name: row.name, phone: row.phone, created: row.created,
      state: row.state, pending: Boolean(row.pending), report: conversation ? summarize(conversation) : null };
  }

  async function ingest(req, res) {
    if (!config.crmToken || !equals(req.headers.authorization, 'Bearer ' + config.crmToken)) return json(res, 401, { error: 'Accès refusé' });
    const data = JSON.parse(await readBody(req));
    if (!data || typeof data.externalId !== 'string' || !data.externalId.trim() || data.externalId.length > 120 ||
        typeof data.phone !== 'string' || !e164.test(data.phone) || data.callbackAuthorized !== true ||
        (data.name !== undefined && (typeof data.name !== 'string' || data.name.length > 100))) {
      return json(res, 400, { error: 'Référence, numéro international et autorisation de rappel requis.' });
    }
    const existing = byExternal.get(data.externalId);
    if (existing) {
      if (existing.phone !== data.phone) return json(res, 409, { error: 'Cette référence est déjà associée à un autre numéro.' });
      return json(res, 200, project(existing));
    }
    if (db.prepare('SELECT 1 FROM suppressed WHERE phone = ?').get(data.phone)) return json(res, 409, { error: 'Ce numéro est exclu des rappels.' });
    if (!agentReady) return json(res, 503, { error: 'Téléphonie non configurée.' });
    const id = randomUUID();
    db.prepare("INSERT INTO calls (id, external_id, phone, name, created, state, pending) VALUES (?, ?, ?, ?, ?, 'dispatching', 0)")
      .run(id, data.externalId, data.phone, data.name?.trim() || 'Contact', new Date().toISOString());
    try {
      const sid = await placeCall(config, { id, phone: data.phone });
      db.prepare("UPDATE calls SET sid = COALESCE(sid, ?), state = CASE WHEN state = 'dispatching' THEN 'queued' ELSE state END WHERE id = ?").run(sid, id);
      return json(res, 202, project(get.get(id)));
    } catch (error) {
      console.error('Demande téléphonique non confirmée', id, error.message);
      db.prepare("UPDATE calls SET state = 'dispatch-unknown', pending = 1 WHERE id = ? AND state = 'dispatching'").run(id);
      return json(res, 502, project(get.get(id)));
    }
  }

  function webhook(req, res, url, match, form) {
    if (!agentReady || !validSignature(config.base + req.url, form, config.twilioToken, req.headers['x-twilio-signature'])) return json(res, 403, { error: 'Signature invalide' });
    const [, id, action] = match;
    const row = get.get(id);
    const sid = form.get('CallSid');
    if (!row || !/^CA[0-9a-f]{32}$/i.test(sid || '') || (row.sid && row.sid !== sid)) return json(res, 404, { error: 'Appel introuvable' });
    if (action === 'status') {
      const state = form.get('CallStatus');
      if (statuses.has(state)) db.prepare(`UPDATE calls SET sid = ?, state = ?,
        pending = CASE WHEN state IN ('dispatching','dispatch-unknown','queued','active') THEN 1 ELSE pending END
        WHERE id = ? AND state NOT IN ('completed','busy','failed','no-answer','canceled','opt-out')`).run(sid, state, id);
      return res.writeHead(204).end();
    }
    const sendXml = body => res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' }).end(body);
    const gather = (text, step) => response(text, `${config.base}/twilio/${id}/reply?step=${step}`);
    if (action === 'answer' && ['dispatching', 'dispatch-unknown', 'queued'].includes(row.state)) {
      db.prepare("UPDATE calls SET sid = ?, state = 'active', conversation = ?, pending = 0 WHERE id = ?").run(sid, JSON.stringify(newCall()), id);
      return sendXml(gather(opening, 1));
    }
    if (action === 'answer' && row.state === 'active' && row.turn === 0) return sendXml(gather(opening, 1));
    const step = Number(url.searchParams.get('step'));
    if (action === 'reply' && step === row.turn && row.last_xml) return sendXml(row.last_xml);
    if (action !== 'reply' || row.state !== 'active' || step !== row.turn + 1) return sendXml(response('Merci, au revoir.'));
    const call = JSON.parse(row.conversation);
    const speech = (form.get('SpeechResult') || '').trim().slice(0, 350);
    const next = speech ? advance(call, speech) : call;
    const finished = next.stage === 'end' || !speech || step >= 5;
    const text = !speech || step >= 5 ? 'Un conseiller pourra examiner votre demande. Merci et au revoir.' : next.messages.at(-1).text;
    const body = finished ? response(text) : gather(text, step + 1);
    db.exec('BEGIN');
    try {
      if (!next.followUp) db.prepare('INSERT OR IGNORE INTO suppressed VALUES (?)').run(row.phone);
      const state = next.followUp ? (finished ? 'reported' : 'active') : 'opt-out';
      db.prepare('UPDATE calls SET conversation = ?, state = ?, pending = ?, turn = ?, last_xml = ? WHERE id = ?')
        .run(JSON.stringify(next), state, Number(finished && next.followUp), step, body, id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return sendXml(body);
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const method = req.method;
      if (path === '/health' && method === 'GET') return json(res, 200, { telephonyConfigured: agentReady });
      if (path === '/api/leads' && method === 'POST') return await ingest(req, res);
      if (path === '/api/leads' && method === 'GET') {
        if (!config.crmToken || !equals(req.headers.authorization, 'Bearer ' + config.crmToken)) return json(res, 401, { error: 'Accès refusé' });
        const row = byExternal.get(url.searchParams.get('externalId'));
        return row ? json(res, 200, project(row)) : json(res, 404, { error: 'Dossier introuvable' });
      }
      const match = /^\/twilio\/([a-f0-9-]{36})\/(answer|reply|status)$/.exec(path);
      if (match && method === 'POST') return webhook(req, res, url, match, new URLSearchParams(await readBody(req)));
      if (!equals(req.headers.authorization, dashboardAuth)) {
        return res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="SSP"' }).end();
      }
      if (path === '/api/calls' && method === 'GET') {
        return json(res, 200, { telephonyConfigured: agentReady, calls: db.prepare('SELECT * FROM calls ORDER BY created DESC LIMIT 100').all().map(project) });
      }
      const close = /^\/api\/calls\/([a-f0-9-]{36})\/close$/.exec(path);
      if (close && method === 'POST' && req.headers['x-ssp-action'] === 'close') {
        const result = db.prepare('UPDATE calls SET pending = 0 WHERE id = ? AND pending = 1').run(close[1]);
        return json(res, result.changes ? 200 : 404, { updated: Boolean(result.changes) });
      }
      const asset = Object.hasOwn(staticFiles, path) && staticFiles[path];
      if (!asset || method !== 'GET') return json(res, 404, { error: 'Introuvable' });
      const body = await readFile(new URL(asset[0], import.meta.url));
      return res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8' }).end(body);
    } catch (error) {
      if (error instanceof SyntaxError) return json(res, 400, { error: 'JSON invalide' });
      if (error.status) return json(res, error.status, { error: error.message });
      console.error('Erreur du serveur', error.code || error.name);
      return json(res, 500, { error: 'Erreur du serveur' });
    }
  });
  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  if (!env.DASHBOARD_PASSWORD || !env.CRM_TOKEN || env.DASHBOARD_PASSWORD.length < 20 || env.CRM_TOKEN.length < 32) {
    throw new Error('Définissez DASHBOARD_PASSWORD (20 caractères minimum) et CRM_TOKEN (32 caractères minimum).');
  }
  const base = (env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL)?.replace(/\/$/, '');
  if (base && !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(base)) throw new Error('PUBLIC_BASE_URL doit être une origine HTTPS.');
  if (env.TWILIO_ACCOUNT_SID && !/^AC[0-9a-f]{32}$/i.test(env.TWILIO_ACCOUNT_SID)) throw new Error('TWILIO_ACCOUNT_SID invalide.');
  if (env.TWILIO_FROM && !e164.test(env.TWILIO_FROM)) throw new Error('TWILIO_FROM doit être au format international.');
  createApp({ dashboardPassword: env.DASHBOARD_PASSWORD, crmToken: env.CRM_TOKEN, base,
    account: env.TWILIO_ACCOUNT_SID, twilioToken: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM,
    dbPath: env.DB_PATH || './data/calls.sqlite' }).listen(Number(env.PORT || 3000), '0.0.0.0');
}
