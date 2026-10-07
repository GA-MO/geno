// A stand-in for `next dev`: listens on $PORT, logs each request, and logs a server error and serves a page whose
// script logs a console error when its root is loaded.
import { createServer } from 'node:http';

const port = Number(process.env.PORT);
console.log('> fake-dev');
createServer((req, res) => {
  console.log(`GET ${req.url}`);
  if (req.url !== '/') return void res.writeHead(404).end();
  console.error('Error: failed to load posts from the fake CMS');
  res
    .writeHead(200, { 'content-type': 'text/html' })
    .end(
      `<!doctype html><title>Fake app</title><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font:bold 96px sans-serif;background:#f4f1ea;color:#1d3557"><h1>Fake app on ${port}</h1><script>console.error('Hydration failed: the fake page logs this on purpose')</script></body>`,
    );
}).listen(port, '127.0.0.1', () => console.log(`ready on http://localhost:${port}`));
