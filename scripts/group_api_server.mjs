import http from 'node:http';
import { URL } from 'node:url';
import { groupPatientByVersion, listRuleVersions } from '../src/services/versionedGrouper.js';
import { DEFAULT_RULE_VERSION } from '../src/services/generated/versionRegistry.js';
import { convertDiagnosesArray, convertProceduresArray } from '../src/services/CodeConversion.js';
import { preloadGLData } from '../src/services/glDataLoader.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || DEFAULT_MAX_BODY_BYTES);
const RULE_VERSION_IDS = new Set(listRuleVersions().map(({ id }) => id));

if (!Number.isInteger(MAX_BODY_BYTES) || MAX_BODY_BYTES <= 0) {
  throw new Error('MAX_BODY_BYTES must be a positive integer');
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

async function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      reject(new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`));
      return;
    }

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
      body += chunk;
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
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
  if (value.some(code => typeof code !== 'string' || code.trim() === '')) {
    throw new HttpError(400, `${field} must contain only non-empty strings`);
  }
  return value.map(code => code.trim());
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/') {
      return sendJson(res, 200, {
        service: 'drg-grouper HTTP API',
        version: '0.1.0',
        notice: '独立实现；将结果用于编码、付费、审核或结算前，请依据适用版本的正式文件复核规则和数据。',
        endpoints: [
          { method: 'GET', path: '/versions', description: 'List available rule versions' },
          { method: 'POST', path: '/group', description: 'Group one patient record; use ?version=...' }
        ],
        defaultRuleVersion: DEFAULT_RULE_VERSION,
        ruleVersions: listRuleVersions()
      });
    }

    if (req.method === 'GET' && url.pathname === '/versions') {
      return sendJson(res, 200, { versions: listRuleVersions() });
    }

    if (req.method === 'POST' && url.pathname === '/group') {
      const body = await parseJsonBody(req);
      if (!isPlainObject(body)) throw new HttpError(400, 'Request body must be a JSON object');

      const source = String(url.searchParams.get('source') || '').toUpperCase();
      let { diagnoses, procedures, patientInfo } = body;
      const version = String(body.version || url.searchParams.get('version') || DEFAULT_RULE_VERSION);
      if (source && source !== 'GL') throw new HttpError(400, 'source must be GL when provided');
      if (!RULE_VERSION_IDS.has(version)) throw new HttpError(400, `Unknown DRG rule version: ${version}`);
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

      const result = await groupPatientByVersion(diagnoses, procedures, patientInfo || {}, version);
      return sendJson(res, 200, { ...result, version });
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, Number.isInteger(err.statusCode) ? err.statusCode : 500, {
      error: err.message || 'Unexpected error'
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Group API server listening on http://${HOST}:${PORT}`);
  console.log('POST /group to group one patient');
  console.log(`Default DRG version: ${DEFAULT_RULE_VERSION}`);
  console.log('Available DRG versions:');
  for (const { id, label } of listRuleVersions()) {
    console.log(`  ${id} (${label})`);
  }
  console.log(`Sample request: curl -X POST 'http://${HOST}:${PORT}/group?version=chs-drg-3.0' -H "Content-Type: application/json" -d '{"diagnoses":["K80.101","I50.900"],"procedures":["51.2300"],"patientInfo":{"gender":1,"age":45,"multiSite":false}}'`);
});
