/**
 * A minimal static file server for the fixture site.
 *
 * Written on node's own http module so the test suite has no dependencies at
 * all: the point of these tests is to prove the crawler, and a test harness that
 * needs its own install is one more thing that can be broken on a contributor's
 * machine.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/** Content types for the handful of extensions the fixture site uses. */
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * Resolves a URL path to a file inside the site root.
 *
 * Extensionless URLs fall back to `<path>.html` and `<path>/index.html`, which is
 * what a static host does and what the fixture's links assume.
 *
 * @param {string} root Absolute site root.
 * @param {string} urlPath Request path.
 * @returns {string|null} Absolute file path, or null when nothing matches.
 */
function resolveFile(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const target = path.resolve(root, `.${path.posix.normalize(decoded)}`);
  // Refuse anything that escapes the root, even in a test helper: a traversal
  // bug here would silently serve the repository itself.
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;

  const candidates = [target, `${target}.html`, path.join(target, 'index.html')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Starts the fixture server on an ephemeral port.
 *
 * @param {string} root Absolute path to the site directory.
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>} Running server.
 */
export async function startStaticServer(root) {
  const absoluteRoot = path.resolve(root);
  const server = http.createServer((request, response) => {
    const file = resolveFile(absoluteRoot, request.url ?? '/');
    if (!file) {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><body><main id="app"><h1>Not found</h1><p>No such page.</p></main></body></html>');
      return;
    }
    response.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
