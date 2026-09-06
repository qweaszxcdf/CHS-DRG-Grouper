const fs = require('fs');
const path = require('path');

function toBuffer(content, encoding = 'utf8') {
  return Buffer.isBuffer(content)
    ? content
    : Buffer.from(content, encoding);
}

function readExistingSync(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function writeFileIfChanged(filePath, content, encoding = 'utf8') {
  const next = toBuffer(content, encoding);
  const current = readExistingSync(filePath);
  if (current !== null && Buffer.compare(current, next) === 0) {
    return false;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next);
  return true;
}

module.exports = {
  writeFileIfChanged,
};
