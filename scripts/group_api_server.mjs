import http from 'node:http';
import cluster from 'node:cluster';
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { getAssetKeys, getRawAsset, isSea } from 'node:sea';
import { StringDecoder } from 'node:string_decoder';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_CODES_PER_FIELD = 512;
const DEFAULT_MAX_IN_FLIGHT_GROUPS = 256;
const MAX_CODE_LENGTH = 64;
const REQUEST_TIMEOUT_MS = 15_000;
const HEADERS_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = readPositiveInteger('MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES);
const MAX_CODES_PER_FIELD = readPositiveInteger('MAX_CODES_PER_FIELD', DEFAULT_MAX_CODES_PER_FIELD);
const MAX_IN_FLIGHT_GROUPS = readPositiveInteger('MAX_IN_FLIGHT_GROUPS', DEFAULT_MAX_IN_FLIGHT_GROUPS);
const WEB_CONCURRENCY = readPositiveInteger('WEB_CONCURRENCY', 1);
const EMBEDDED_STATIC_PREFIX = 'static:';
const ALLOWED_SOURCES = new Set(['YB', 'GL']);
const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});
let groupPatientByVersion;
let preloadRuleVersion;
let convertDiagnosesArray;
let convertProceduresArray;
let preloadGLData;
let DEFAULT_RULE_VERSION;
let RULE_VERSIONS;
let RULE_VERSION_IDS;
let staticFiles;
let server;
let inFlightGroups = 0;
let shuttingDown = false;

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function createStaticFileIndex(directory) {
  const files = new Map();
  let root = null;
  let embedded = false;

  if (isSea()) {
    for (const key of getAssetKeys()) {
      if (!key.startsWith(EMBEDDED_STATIC_PREFIX)) continue;
      const urlPath = key.slice(EMBEDDED_STATIC_PREFIX.length);
      if (!urlPath.startsWith('/')) continue;
      const body = Buffer.from(getRawAsset(key));
      const digest = createHash('sha256').update(body).digest('base64url').slice(0, 16);
      files.set(urlPath, {
        filePath: null,
        body,
        size: body.length,
        modified: null,
        etag: `\"${digest}\"`,
        contentType: MIME_TYPES[path.posix.extname(urlPath).toLowerCase()] || 'application/octet-stream',
      });
    }
    if (files.size > 0) {
      root = 'embedded SEA assets';
      embedded = true;
    }
  }

  if (files.size === 0 && directory) {
    root = path.resolve(directory);
    if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`STATIC_DIR is not a directory: ${root}`);
    }

    function indexDirectory(currentDirectory) {
      for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
        const filePath = path.join(currentDirectory, entry.name);
        if (entry.isDirectory()) {
          indexDirectory(filePath);
        } else if (entry.isFile()) {
          const stats = statSync(filePath);
          const relativePath = path.relative(root, filePath).split(path.sep).join('/');
          files.set(`/${relativePath}`, {
            filePath,
            body: null,
            size: stats.size,
            modified: stats.mtime.toUTCString(),
            etag: `W/\"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}\"`,
            contentType: MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
          });
        }
      }
    }
    indexDirectory(root);
  }

  if (files.size === 0) return { root: null, count: 0, embedded: false, serve: () => false };

  const indexFile = files.get('/index.html');
  function serve(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'Invalid URL path');
    }
    if (decodedPath.includes('\0')) throw new HttpError(400, 'Invalid URL path');

    const requestedPath = decodedPath === '/' ? '/index.html' : decodedPath;
    const acceptsHtml = String(req.headers.accept || '').includes('text/html');
    const file = files.get(requestedPath)
      || (acceptsHtml && !path.posix.extname(requestedPath) ? indexFile : null);
    if (!file) return false;

    const cacheControl = requestedPath.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    const headers = {
      'Cache-Control': cacheControl,
      'ETag': file.etag,
      'X-Content-Type-Options': 'nosniff',
    };
    if (file.modified) headers['Last-Modified'] = file.modified;
    if (req.headers['if-none-match'] === file.etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }

    res.writeHead(200, {
      ...headers,
      'Content-Type': file.contentType,
      'Content-Length': file.size,
    });
    if (req.method === 'HEAD') {
      res.end();
    } else if (file.body) {
      res.end(file.body);
    } else {
      const stream = createReadStream(file.filePath);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    }
    return true;
  }

  return { root, count: files.size, embedded, serve };
}

function sendJson(res, statusCode, payload) {
  if (res.destroyed || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length
  });
  res.end(body);
}

async function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      req.resume();
      reject(new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`));
      return;
    }

    const decoder = new StringDecoder('utf8');
    let body = '';
    let receivedBytes = 0;
    let settled = false;
    req.on('data', chunk => {
      if (settled) return;
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_BODY_BYTES) {
        settled = true;
        reject(new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      body += decoder.write(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      body += decoder.end();
      if (!body) return resolve(null);
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCodeArray(value, field) {
  if (!Array.isArray(value)) throw new HttpError(400, `${field} must be an array`);
  if (value.length > MAX_CODES_PER_FIELD) {
    throw new HttpError(413, `${field} must contain at most ${MAX_CODES_PER_FIELD} codes`);
  }
  return value.map(code => {
    if (typeof code !== 'string') {
      throw new HttpError(400, `${field} must contain only non-empty strings`);
    }
    const normalized = code.trim();
    if (!normalized) throw new HttpError(400, `${field} must contain only non-empty strings`);
    if (normalized.length > MAX_CODE_LENGTH) {
      throw new HttpError(400, `${field} codes must not exceed ${MAX_CODE_LENGTH} characters`);
    }
    return normalized;
  });
}

function getRequestSource(url) {
  const source = String(url.searchParams.get('source') || 'YB').toUpperCase();
  if (!ALLOWED_SOURCES.has(source)) {
    throw new HttpError(400, 'source must be YB or GL');
  }
  return source;
}

function getRequestVersion(body, url) {
  const version = String(body.version || url.searchParams.get('version') || DEFAULT_RULE_VERSION);
  if (!RULE_VERSION_IDS.has(version)) throw new HttpError(400, `Unknown DRG rule version: ${version}`);
  return version;
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/' && staticFiles.serve(req, res, url.pathname)) return;

    if (req.method === 'GET' && url.pathname === '/') {
      return sendJson(res, 200, {
        service: 'drg-grouper HTTP API',
        version: '0.0.0',
        endpoints: [
          { method: 'GET', path: '/versions', description: 'List available rule versions' },
          { method: 'POST', path: '/group', description: 'Group one patient record; use ?version=...' }
        ],
        defaultRuleVersion: DEFAULT_RULE_VERSION,
        ruleVersions: RULE_VERSIONS
      });
    }

    if (req.method === 'GET' && url.pathname === '/versions') {
      return sendJson(res, 200, {
        defaultRuleVersion: DEFAULT_RULE_VERSION,
        versions: RULE_VERSIONS,
      });
    }

    if (req.method === 'POST' && url.pathname === '/group') {
      if (shuttingDown || inFlightGroups >= MAX_IN_FLIGHT_GROUPS) {
        req.resume();
        res.setHeader('Retry-After', '1');
        return sendJson(res, 503, { error: shuttingDown ? 'Server is shutting down' : 'Server is busy' });
      }
      inFlightGroups += 1;
      try {
        const body = await parseJsonBody(req);
        if (!isPlainObject(body)) throw new HttpError(400, 'Request body must be a JSON object');

        const source = getRequestSource(url);
        let { diagnoses, procedures, patientInfo } = body;
        const version = getRequestVersion(body, url);
        diagnoses = normalizeCodeArray(diagnoses, 'diagnoses');
        procedures = normalizeCodeArray(procedures, 'procedures');
        if (patientInfo !== undefined && !isPlainObject(patientInfo)) {
          throw new HttpError(400, 'patientInfo must be a JSON object');
        }

        if (source === 'GL') {
          await preloadGLData(version);
          diagnoses = convertDiagnosesArray(diagnoses, version);
          procedures = convertProceduresArray(procedures, version);
        }

        const groupingResult = groupPatientByVersion(diagnoses, procedures, patientInfo || {}, version);
        const result = groupingResult instanceof Promise ? await groupingResult : groupingResult;
        return sendJson(res, 200, {
          ...result,
          version,
          diagnosesConverted: diagnoses,
          proceduresConverted: procedures,
          conversionApplied: source === 'GL',
        });
      } finally {
        inFlightGroups -= 1;
      }
    }

    if (staticFiles.serve(req, res, url.pathname)) return;

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, Number.isInteger(err.statusCode) ? err.statusCode : 500, {
      error: err.message || 'Unexpected error'
    });
  }
}

async function startWorkerServer() {
  const [versionedGrouper, versionRegistry, codeConversion, glDataLoader] = await Promise.all([
    import('../src/services/versionedGrouper.ts'),
    import('../src/services/generated/versionRegistry.ts'),
    import('../src/services/CodeConversion.js'),
    import('../src/services/glDataLoader.js'),
  ]);
  ({ groupPatientByVersion, preloadRuleVersion } = versionedGrouper);
  ({ DEFAULT_RULE_VERSION } = versionRegistry);
  ({ convertDiagnosesArray, convertProceduresArray } = codeConversion);
  ({ preloadGLData } = glDataLoader);
  RULE_VERSIONS = versionedGrouper.listRuleVersions();
  RULE_VERSION_IDS = new Set(RULE_VERSIONS.map(({ id }) => id));
  staticFiles = createStaticFileIndex(process.env.STATIC_DIR);

  server = http.createServer(handleRequest);
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.maxHeadersCount = 64;

  await preloadRuleVersion(DEFAULT_RULE_VERSION);

  server.listen(PORT, HOST, () => {
    const workerLabel = cluster.isWorker ? `worker ${cluster.worker.id} (pid ${process.pid})` : `pid ${process.pid}`;
    console.log(`Group API ${workerLabel} listening on http://${HOST}:${PORT}`);
    if (!cluster.isWorker || cluster.worker.id === 1) {
      if (staticFiles.root) {
        const source = staticFiles.embedded ? 'from the executable' : `from ${staticFiles.root}`;
        console.log(`Serving ${staticFiles.count} indexed C/S files ${source}`);
      }
      console.log('POST /group to group one patient');
      console.log(`Default DRG version: ${DEFAULT_RULE_VERSION}`);
      console.log('Available DRG versions:');
      for (const { id, label } of RULE_VERSIONS) {
        console.log(`  ${id} (${label})`);
      }
      console.log(`Sample request: curl -X POST 'http://localhost:${PORT}/group?version=${DEFAULT_RULE_VERSION}' -H "Content-Type: application/json" -d '{"diagnoses":["K80.101","I50.900"],"procedures":["51.2300"],"patientInfo":{"gender":1,"age":45,"ageInDays":null,"birthWeight":null,"admissionWeight":null,"dischargeStatus":"1","newTechnique":null}}'`);
    }
  });

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

function startPrimary() {
  let stopping = false;
  console.log(`Group API primary pid ${process.pid} starting ${WEB_CONCURRENCY} workers on port ${PORT}`);
  for (let index = 0; index < WEB_CONCURRENCY; index += 1) cluster.fork();

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Group API worker ${worker.id} exited (${signal || code})`);
    if (!stopping) cluster.fork();
  });

  function stopPrimary(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, stopping ${WEB_CONCURRENCY} Group API workers`);
    for (const worker of Object.values(cluster.workers)) worker?.process.kill('SIGTERM');
  }

  process.once('SIGTERM', () => stopPrimary('SIGTERM'));
  process.once('SIGINT', () => stopPrimary('SIGINT'));
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, stopping the Group API server`);
  const forceCloseTimer = setTimeout(() => {
    console.error('Graceful shutdown timed out; closing remaining connections');
    server.closeAllConnections();
    process.exitCode = 1;
  }, SHUTDOWN_TIMEOUT_MS);
  forceCloseTimer.unref();
  server.close(error => {
    clearTimeout(forceCloseTimer);
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
    if (cluster.isWorker && process.connected) process.disconnect();
  });
  server.closeIdleConnections();
}

if (cluster.isPrimary && WEB_CONCURRENCY > 1) startPrimary();
else await startWorkerServer();
