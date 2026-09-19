const fs = require('fs');
const path = require('path');

// Dated ICD package DAT files are deltas. A leading "-" marks a code that
// should be removed from the inherited package; all other lines are additions
// or replacements. Both "- CODE" and "-CODE" are accepted; canonical delta
// files use the more readable "- CODE" form.
function parseIcdPackageDatLine(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) return null;

  const removed = trimmed.startsWith('-');
  const payload = removed ? trimmed.slice(1).trimStart() : trimmed;
  if (!payload) return null;

  const firstSpace = payload.search(/\s/);
  const code = firstSpace < 0 ? payload : payload.slice(0, firstSpace);
  const value = firstSpace < 0 ? '' : payload.slice(firstSpace).trim();
  if (!code) return null;

  return Object.freeze({ code, value, removed });
}

function forEachPackageDatEntry(packageRoot, packageId, filename, callback) {
  const chain = resolvePackageChain(packageRoot, packageId);

  for (const [index, packageInfo] of chain.entries()) {
    const sourcePath = path.join(packageInfo.dir, 'raw', filename);
    if (!fs.existsSync(sourcePath)) {
      if (index === 0) {
        throw new Error(`Missing required ICD package source: ${sourcePath}`);
      }
      continue;
    }

    let lines;
    try {
      lines = fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/);
    } catch (error) {
      throw new Error(`Unable to read required ICD package source ${sourcePath}: ${error.message}`, { cause: error });
    }
    for (const line of lines) {
      const entry = parseIcdPackageDatLine(line);
      if (entry) callback(entry, packageInfo);
    }
  }
}

// A dated package such as yb-2.0-2027.01 is a delta over the closest earlier
// package in the same series.
function inferBasePackageId(packageRoot, packageId) {
  const match = packageId.match(/^(.+)-(\d{4})(?:\.(\d{2}))?$/);
  const baseId = match?.[1];
  const targetRelease = match
    ? [Number(match[2]), match[3] ? Number(match[3]) : 0]
    : null;
  if (!baseId || !targetRelease) return null;

  const datedPrefix = `${baseId}-`;
  let previousRelease = null;
  for (const entry of fs.readdirSync(packageRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(datedPrefix)) continue;
    const releaseMatch = entry.name.slice(datedPrefix.length).match(/^(\d{4})(?:\.(\d{2}))?$/);
    if (!releaseMatch) continue;
    const release = [
      Number(releaseMatch[1]),
      releaseMatch[2] ? Number(releaseMatch[2]) : 0,
    ];
    if (
      (release[0] < targetRelease[0]
        || (release[0] === targetRelease[0] && release[1] < targetRelease[1]))
      && (previousRelease === null
        || release[0] > previousRelease[0]
        || (release[0] === previousRelease[0] && release[1] > previousRelease[1]))
    ) {
      previousRelease = release;
    }
  }

  if (previousRelease !== null) {
    const month = previousRelease[1] === 0 ? '' : `.${String(previousRelease[1]).padStart(2, '0')}`;
    return `${baseId}-${previousRelease[0]}${month}`;
  }
  return fs.existsSync(path.join(packageRoot, baseId)) ? baseId : null;
}

function resolvePackageChain(packageRoot, packageId) {
  const chain = [];
  const seen = new Set();
  let currentId = packageId;

  while (currentId) {
    if (seen.has(currentId)) {
      throw new Error(`Circular ICD package inheritance: ${[...seen, currentId].join(' -> ')}`);
    }
    seen.add(currentId);

    const packageDir = path.join(packageRoot, currentId);
    if (!fs.existsSync(packageDir)) {
      throw new Error(`Missing ICD package directory: ${packageDir}`);
    }
    const baseId = inferBasePackageId(packageRoot, currentId);
    const packageInfo = Object.freeze({ id: currentId, base: baseId, dir: packageDir });
    chain.unshift(packageInfo);
    currentId = baseId;
  }

  return chain;
}

function getParentPackageId(packageRoot, packageId, chain = resolvePackageChain(packageRoot, packageId)) {
  return chain.length > 1 ? chain[chain.length - 2].id : null;
}

module.exports = {
  forEachPackageDatEntry,
  getParentPackageId,
  parseIcdPackageDatLine,
  resolvePackageChain,
};
