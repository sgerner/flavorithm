export type CompanionConfig = {
	pairingId: string;
	pairingKey: string;
	nonce: string;
	origin: string;
	expiresAt: number;
	clientId: string;
	newRegistration: boolean;
	loginHint?: string;
	reconsent: boolean;
};

/** Standalone Node connector: OAuth happens on the browser's computer, never on the VM. */
export function buildCompanionScript(config: CompanionConfig): string {
	return (
		`const config = ${JSON.stringify(config)};\n` +
		String.raw`
import { createServer } from 'node:http';
import { createCipheriv, createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const issuer = 'https://auth.openai.com';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
async function json(fetcher, url, options = {}) {
  const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error('ChatGPT request failed (' + response.status + '). Download a new connector and try again.');
  try { return await response.json(); }
  catch { throw new Error('ChatGPT returned an invalid response. Try authorizing again.'); }
}
async function verifyIdentity(fetcher, token, clientId, nonce) {
  const segments = token.split('.');
  if (segments.length !== 3) throw new Error('ChatGPT returned an invalid identity.');
  let header, claims;
  try { header = JSON.parse(Buffer.from(segments[0], 'base64url')); claims = JSON.parse(Buffer.from(segments[1], 'base64url')); }
  catch { throw new Error('ChatGPT returned an invalid identity.'); }
  const discovery = await json(fetcher, issuer + '/.well-known/openid-configuration');
  const jwks = new URL(discovery.jwks_uri);
  if (discovery.issuer !== issuer || jwks.protocol !== 'https:' || jwks.hostname !== 'auth.openai.com' || jwks.username || jwks.password) throw new Error('Invalid identity metadata.');
  const keys = await json(fetcher, jwks.href);
  const key = keys.keys.find(k => k.kid === header.kid && (!k.alg || k.alg === header.alg));
  if (!key || !['RS256', 'ES256'].includes(header.alg) || (header.alg === 'RS256' && key.kty !== 'RSA') || (header.alg === 'ES256' && (key.kty !== 'EC' || key.crv !== 'P-256'))) throw new Error('Unsupported identity signature.');
  const valid = verify('sha256', Buffer.from(segments[0] + '.' + segments[1]), {
    key: createPublicKey({ key, format: 'jwk' }), dsaEncoding: 'ieee-p1363'
  }, Buffer.from(segments[2], 'base64url'));
  const now = Date.now() / 1000;
  if (!valid || claims.iss !== issuer || !(Array.isArray(claims.aud) ? claims.aud.includes(clientId) : claims.aud === clientId) || claims.nonce !== nonce || typeof claims.sub !== 'string' || !claims.sub || typeof claims.exp !== 'number' || claims.exp <= now || typeof claims.iat !== 'number' || claims.iat > now + 5) throw new Error('ChatGPT identity verification failed.');
}
function launchBrowser(url) {
  const program = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(program, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.log('Open the authorization URL above in your browser.'));
  child.unref();
}
export async function authorize(setup = config, options = {}) {
  process.umask(0o077);
  if (setup.expiresAt <= Date.now()) throw new Error('This connector expired. Download a new connector from Flavorithm.');
  const fetcher = options.fetcher || fetch;
  const openBrowser = options.openBrowser || launchBrowser;
  const settingsDir = options.settingsDir || join(homedir(), '.config', 'flavorithm');
  await mkdir(settingsDir, { recursive: true, mode: 0o700 });
  const hostFile = join(settingsDir, 'host-id');
  let hostId;
  try { hostId = (await readFile(hostFile, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { await writeFile(hostFile, 'urn:uuid:' + randomUUID(), { mode: 0o600, flag: 'wx' }); }
    catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; }
    hostId = (await readFile(hostFile, 'utf8')).trim();
  }
  if (!/^urn:uuid:[a-f0-9-]{36}$/i.test(hostId)) throw new Error('Invalid Flavorithm host ID.');
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  let server;
  let timeout;
  let processing = false;
  let callbackUri;
  const completion = new Promise((resolve, reject) => {
    server = createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Referrer-Policy', 'no-referrer');
      let url;
      try { url = new URL(req.url || '/', callbackUri); } catch { res.writeHead(400).end('Invalid callback.'); return; }
      if (req.method !== 'GET' || req.headers.host !== new URL(callbackUri).host || url.origin !== new URL(callbackUri).origin || url.pathname !== '/auth/callback' || url.searchParams.get('state') !== state || url.searchParams.getAll('state').length !== 1 || (req.url || '').length > 16_384) {
        res.writeHead(400).end('Invalid callback. Return to the ChatGPT authorization tab.'); return;
      }
      if (processing) { res.writeHead(409).end('Authorization is already being completed.'); return; }
      processing = true;
      try {
        if (url.searchParams.has('error')) throw new Error('ChatGPT authorization was declined.');
        const code = url.searchParams.get('code');
        const clientId = url.searchParams.get('client_id') || (!setup.newRegistration ? setup.clientId : '');
        if (!code || !clientId || clientId === 'dynamic_agent_client' || url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('client_id').length > 1 || (!setup.newRegistration && clientId !== setup.clientId)) throw new Error('Invalid ChatGPT registration callback.');
        const token = await json(fetcher, issuer + '/api/accounts/oauth/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code,
            code_verifier: verifier, redirect_uri: callbackUri, resource: 'https://api.openai.com/v1' })
        });
        if (typeof token.access_token !== 'string' || typeof token.id_token !== 'string' || !Number.isFinite(Number(token.expires_in)) || Number(token.expires_in) <= 0) throw new Error('ChatGPT did not return usable credentials.');
        await verifyIdentity(fetcher, token.id_token, clientId, setup.nonce);
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', Buffer.from(setup.pairingKey, 'base64url'), iv);
        cipher.setAAD(Buffer.from('flavorithm:companion:' + setup.origin + ':' + setup.pairingId));
        const data = Buffer.concat([cipher.update(JSON.stringify({ clientId, token, receivedAt: Date.now() })), cipher.final()]);
        const bundle = { version: 1, pairingId: setup.pairingId, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url') };
        const filename = join(options.outputDir || process.cwd(), 'flavorithm-chatgpt-connection-' + setup.pairingId.slice(0, 8) + '.json');
        await writeFile(filename, JSON.stringify(bundle), { flag: 'wx', mode: 0o600 });
        res.end('ChatGPT authorized. Return to Flavorithm and upload the connection file created in your terminal.');
        console.log('Upload this encrypted connection file in Flavorithm:\n' + filename + '\nDelete the connector and connection file after importing.');
        resolve({ filename, bundle });
      } catch (error) { res.writeHead(400).end('Authorization failed. Return to Flavorithm and try again.'); reject(error); }
      finally { clearTimeout(timeout); server.close(); }
    });
    server.once('error', reject);
    timeout = setTimeout(() => { server.close(); reject(new Error('Connector expired. Download a new connector.')); }, Math.min(600_000, setup.expiresAt - Date.now()));
  });
  // Start listening before opening authorization; the redirect must reach this computer.
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    callbackUri = 'http://127.0.0.1:' + server.address().port + '/auth/callback';
    const url = new URL(issuer + '/api/accounts/authorize');
    for (const [key, value] of Object.entries({ client_id: setup.clientId, response_type: 'code',
      redirect_uri: callbackUri, scope: scopes, resource: 'https://api.openai.com/v1', state, nonce: setup.nonce,
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), ext_agent_host_id: hostId })) url.searchParams.set(key, value);
    if (setup.newRegistration) url.searchParams.set('agent_name_hint', 'Flavorithm');
    if (setup.loginHint) url.searchParams.set('login_hint', setup.loginHint);
    if (setup.reconsent) url.searchParams.set('prompt', 'consent');
    console.log('Authorize Flavorithm with ChatGPT:\n' + url.href);
    await openBrowser(url.href);
    return await completion;
  } finally { clearTimeout(timeout); server.close(); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await authorize(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
`
	);
}
