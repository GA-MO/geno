// Forwards Claude Code's API calls to api.anthropic.com and keeps two request bodies: the first and the latest, which
// holds the whole conversation. Headers and responses are not kept, so no credential is written.
// usage: node proxy.mjs <port> <outDir>   then   ANTHROPIC_BASE_URL=http://127.0.0.1:<port> claude -p ...
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const [port, outDir] = [Number(process.argv[2]), process.argv[3]];
let n = 0;
http
  .createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'POST' && req.url.startsWith('/v1/messages') && !req.url.includes('count_tokens') && body.length > 0) {
        n += 1;
        if (n === 1 && !fs.existsSync(`${outDir}/first.json`)) fs.writeFileSync(`${outDir}/first.json`, body);
        fs.writeFileSync(`${outDir}/last.json`, body);
      }
      const up = https.request({ host: 'api.anthropic.com', path: req.url, method: req.method, headers: { ...req.headers, host: 'api.anthropic.com' } }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on('error', (e) => {
        res.writeHead(502);
        res.end(String(e));
      });
      up.end(body);
    });
  })
  .listen(port, '127.0.0.1');
