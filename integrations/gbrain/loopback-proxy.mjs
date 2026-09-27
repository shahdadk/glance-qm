// Private sandbox adapter: official OAuth discovery advertises loopback URLs.
// No credentials or database access here. Proxy stays on sandbox loopback.
import http from 'node:http';
const upstream = new URL(process.env.GBRAIN_HOST_URL || 'http://host.lima.internal:3131');
const server = http.createServer((request, response) => {
  const outgoing = http.request(new URL(request.url, upstream), {
    method: request.method, headers: { ...request.headers, host: upstream.host },
  }, incoming => {
    response.writeHead(incoming.statusCode, incoming.headers);
    incoming.pipe(response);
  });
  outgoing.on('error', () => { response.writeHead(502); response.end('GBrain host unavailable'); });
  request.pipe(outgoing);
});
server.on('error', error => {
  if (error.code === 'EADDRINUSE') process.exit(0);
  console.error('GBrain loopback proxy failed'); process.exit(1);
});
server.listen(3131, '127.0.0.1');
