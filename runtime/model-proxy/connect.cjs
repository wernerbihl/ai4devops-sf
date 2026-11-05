'use strict';
// CONNECT-only model egress. No credentials, Docker socket, DNS fallback, or HTTP path inspection.
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns/promises');
const fs = require('node:fs');

// Reviewed exact endpoints: https://docs.github.com/en/copilot/reference/copilot-allowlist-reference
// https://docs.github.com/en/copilot/how-tos/troubleshoot-copilot/troubleshoot-network-errors
const CURATED = new Set(['api.github.com:443', 'api.githubcopilot.com:443', 'copilot-proxy.githubusercontent.com:443']);
const v4deny = new net.BlockList();
for (const [address, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',16],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.0.0',16],['203.0.0.0',16],['224.0.0.0',3]]) v4deny.addSubnet(address,bits,'ipv4');
const v6global = new net.BlockList(); v6global.addSubnet('2000::',3,'ipv6');
const v6deny = new net.BlockList(); for (const [address,bits] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) v6deny.addSubnet(address,bits,'ipv6');
function publicIPv4(address) { return net.isIPv4(address) && !v4deny.check(address,'ipv4'); }
function publicAddress(answer) {
  if (answer.family === 4) return publicIPv4(answer.address);
  return answer.family === 6 && net.isIPv6(answer.address) && v6global.check(answer.address,'ipv6') && !v6deny.check(answer.address,'ipv6');
}
function validateAuthority(authority, allowed) {
  if (typeof authority !== 'string' || !CURATED.has(authority) || !allowed.includes(authority)) throw Error('Authority denied');
  return authority.slice(0,-4);
}
function validatePolicy(p) {
  const fields = ['schemaVersion','kind','listenPort','nativeRuntimeId','internalNetworkId','listenAddress','nativeAddress','allowedAuthorities'];
  if (!p || typeof p !== 'object' || Object.keys(p).length !== fields.length || fields.some(k => !Object.hasOwn(p,k)) || p.schemaVersion !== 2 || p.kind !== 'copilot-model-connect' || p.listenPort !== 3128 || !/^[a-f0-9]{12,64}$/.test(p.nativeRuntimeId) || !/^[a-f0-9]{12,64}$/.test(p.internalNetworkId) || !net.isIPv4(p.listenAddress) || !net.isIPv4(p.nativeAddress) || p.listenAddress === p.nativeAddress || !Array.isArray(p.allowedAuthorities) || !p.allowedAuthorities.length || new Set(p.allowedAuthorities).size !== p.allowedAuthorities.length || p.allowedAuthorities.some(a => !CURATED.has(a))) throw Error('Invalid proxy policy');
  return p;
}
async function resolvePinned(host, lookup = dns.lookup) {
  const answers = await lookup(host, {all:true,verbatim:true});
  if (!Array.isArray(answers) || !answers.length || answers.length > 64 || answers.some(a => !publicAddress(a))) throw Error('Unsafe DNS response');
  const selected = answers.find(a => a.family === 4);
  if (!selected) throw Error('Public IPv4 destination unavailable');
  return selected.address;
}
function normalizePeer(address) {
  if (typeof address !== 'string') return '';
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return net.isIPv4(ipv4) ? ipv4 : '';
}
function serve(policy) {
  validatePolicy(policy);
  const server = http.createServer((_req,res) => { res.writeHead(405,{'connection':'close'}); res.end(); });
  server.headersTimeout = 5000; server.requestTimeout = 10000; server.maxHeadersCount = 32;
  server.on('connect', async (req, client, head) => {
    client.on('error', () => {});
    if (normalizePeer(client.remoteAddress) !== policy.nativeAddress || normalizePeer(client.localAddress) !== policy.listenAddress || head.length > 16384) return client.destroy();
    client.pause();
    try {
      const host = validateAuthority(req.url, policy.allowedAuthorities);
      const address = await Promise.race([resolvePinned(host), new Promise((_, reject) => setTimeout(() => reject(Error('DNS timeout')), 5000).unref())]);
      if (client.destroyed) return;
      const upstream = net.connect({host:address,port:443,family:4});
      upstream.setTimeout(15000, () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.once('connect', () => {
        upstream.setTimeout(0);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client); client.resume();
      });
    } catch { client.destroy(); }
  });
  server.on('clientError', (_err,socket) => socket.destroy());
  server.listen(policy.listenPort, policy.listenAddress);
  return server;
}
module.exports = { CURATED, publicIPv4, validateAuthority, validatePolicy, resolvePinned, normalizePeer, serve, startFromFile };
async function startFromFile(path) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const policy = JSON.parse(fs.readFileSync(path, 'utf8'));
      if (policy.schemaVersion === 2) {
        const server = serve(validatePolicy(policy));
        await new Promise((resolve, reject) => { server.once('listening',resolve); server.once('error',reject); });
        return server;
      }
      if (JSON.stringify(policy) !== '{}') throw Error('Unexpected policy');
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Policy not provisioned');
}
if (require.main === module) {
  if (process.argv.length !== 3) { process.stderr.write('Invalid model proxy policy or startup failure.\n'); process.exitCode = 1; }
  else startFromFile(process.argv[2]).catch(() => { process.stderr.write('Invalid model proxy policy or startup failure.\n'); process.exitCode = 1; });
}
