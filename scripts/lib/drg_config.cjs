const fs = require('fs');
const path = require('path');

const COMMON_STRATEGY_DEFAULTS = Object.freeze({
  invalidPrincipalProcedureAction: 'null-slot',
  allowedInvalidPrincipalProcedures: Object.freeze([]),
  allowedGrayPrincipalProcedures: Object.freeze(['99.1000']),
  mdcyPrincipalDiagnosisOnly: true,
  allowSecondarySectionPrimaryFallback: false,
});

const VERSION_STRATEGY_DEFAULTS = Object.freeze({
  daySurgeryAsNoCC: false,
});

const allowedInvalidPrincipalProcedureActions = new Set([
  'null-slot',
  'shift',
  'keep',
]);

const booleanCommonStrategyFields = Object.freeze([
  'mdcyPrincipalDiagnosisOnly',
  'allowSecondarySectionPrimaryFallback',
]);

const arrayCommonStrategyFields = Object.freeze([
  'allowedInvalidPrincipalProcedures',
  'allowedGrayPrincipalProcedures',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireDirectory(directoryPath, description) {
  if (!fs.existsSync(directoryPath)) {
    throw new Error(`Missing ${description}: ${directoryPath}`);
  }
  if (!fs.statSync(directoryPath).isDirectory()) {
    throw new Error(`Expected directory for ${description}: ${directoryPath}`);
  }
}

function readJsonObject(filePath, description) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read ${description}: ${filePath}`, {
      cause: error,
    });
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${description}: ${filePath}`, {
      cause: error,
    });
  }
  if (!isPlainObject(config)) {
    throw new Error(`${description} must contain a JSON object: ${filePath}`);
  }
  return config;
}

function requireNonEmptyString(config, field, description) {
  const value = config[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${description} requires a non-empty string: ${field}`);
  }
  return value.trim();
}

function freezeOptionalObject(config, field, description) {
  const value = config[field];
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(`${description} ${field} must be an object`);
  }
  return Object.freeze({ ...value });
}

function resolveCommonStrategy(commonPackageId, suppliedStrategy) {
  const strategy = {
    ...COMMON_STRATEGY_DEFAULTS,
    ...(suppliedStrategy || {}),
  };
  if (!allowedInvalidPrincipalProcedureActions.has(
    strategy.invalidPrincipalProcedureAction,
  )) {
    throw new Error(
      `drg-common/${commonPackageId}/config.json ` +
      'strategy.invalidPrincipalProcedureAction must be null-slot, shift, or keep',
    );
  }

  for (const field of arrayCommonStrategyFields) {
    const value = strategy[field];
    if (
      !Array.isArray(value)
      || value.some(item => typeof item !== 'string' || item.trim() === '')
    ) {
      throw new Error(
        `drg-common/${commonPackageId}/config.json strategy.${field} ` +
        'must be an array of non-empty strings',
      );
    }
    strategy[field] = Object.freeze([
      ...new Set(value.map(item => item.trim())),
    ]);
  }

  for (const field of booleanCommonStrategyFields) {
    if (typeof strategy[field] !== 'boolean') {
      throw new Error(
        `drg-common/${commonPackageId}/config.json ` +
        `strategy.${field} must be boolean`,
      );
    }
  }
  return Object.freeze(strategy);
}

function resolveVersionStrategy(versionId, suppliedStrategy) {
  const supplied = suppliedStrategy || {};
  const unknownFields = Object.keys(supplied).filter(
    field => !Object.prototype.hasOwnProperty.call(
      VERSION_STRATEGY_DEFAULTS,
      field,
    ),
  );
  if (unknownFields.length > 0) {
    throw new Error(
      `${versionId}/config.json strategy contains unsupported fields: ` +
      unknownFields.join(', '),
    );
  }

  const strategy = {
    ...VERSION_STRATEGY_DEFAULTS,
    ...supplied,
  };
  if (typeof strategy.daySurgeryAsNoCC !== 'boolean') {
    throw new Error(
      `${versionId}/config.json strategy.daySurgeryAsNoCC must be boolean`,
    );
  }
  return Object.freeze(strategy);
}

function createDrgConfigResolver(projectRoot) {
  const resolvedRoot = path.resolve(projectRoot);
  const dataDir = path.join(resolvedRoot, 'src/data');
  const versionsDir = path.join(dataDir, 'versions');
  const commonDir = path.join(dataDir, 'drg-common');
  const defaultVersionPath = path.join(dataDir, 'default_version.json');
  const versionCache = new Map();
  const commonCache = new Map();

  function listVersionIds() {
    requireDirectory(versionsDir, 'DRG versions directory');
    return fs.readdirSync(versionsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right, 'en'));
  }

  function readCommonConfig(commonPackageId) {
    if (typeof commonPackageId !== 'string' || commonPackageId.trim() === '') {
      throw new Error('Common DRG package ID must be a non-empty string');
    }

    const id = commonPackageId.trim();
    if (commonCache.has(id)) return commonCache.get(id);
    const description = `drg-common/${id}/config.json`;
    const configPath = path.join(commonDir, id, 'config.json');
    const rawConfig = readJsonObject(configPath, description);
    const configuredId = requireNonEmptyString(rawConfig, 'id', description);
    if (configuredId !== id) {
      throw new Error(`${description} id must equal directory name`);
    }

    if (!isPlainObject(rawConfig.packages)) {
      throw new Error(`${description} requires packages`);
    }
    const clinicalIcd = requireNonEmptyString(
      rawConfig.packages,
      'clinicalIcd',
      `${description} packages`,
    );
    const insuranceIcd = requireNonEmptyString(
      rawConfig.packages,
      'insuranceIcd',
      `${description} packages`,
    );
    const strategy = freezeOptionalObject(rawConfig, 'strategy', description);
    resolveCommonStrategy(id, strategy);
    const config = Object.freeze({
      ...rawConfig,
      id,
      packages: Object.freeze({
        ...rawConfig.packages,
        clinicalIcd,
        insuranceIcd,
      }),
      ...(strategy ? { strategy } : {}),
    });
    commonCache.set(id, config);
    return config;
  }

  function readVersionConfig(versionId) {
    if (typeof versionId !== 'string' || versionId.trim() === '') {
      throw new Error('DRG version ID must be a non-empty string');
    }

    const id = versionId.trim();
    if (versionCache.has(id)) return versionCache.get(id);
    const description = `${id}/config.json`;
    const configPath = path.join(versionsDir, id, 'config.json');
    const rawConfig = readJsonObject(configPath, description);
    const configuredId = requireNonEmptyString(rawConfig, 'id', description);
    const label = requireNonEmptyString(rawConfig, 'label', description);
    const drgCommon = requireNonEmptyString(rawConfig, 'drgCommon', description);
    if (configuredId !== id) {
      throw new Error(`${description} id must equal directory name`);
    }
    if (Object.prototype.hasOwnProperty.call(rawConfig, 'packages')) {
      throw new Error(
        `${description} packages is no longer supported; declare drgCommon ` +
        'at the top level',
      );
    }

    const strategy = freezeOptionalObject(rawConfig, 'strategy', description);
    resolveVersionStrategy(id, strategy);
    const config = Object.freeze({
      ...rawConfig,
      id,
      label,
      drgCommon,
      ...(strategy ? { strategy } : {}),
    });
    versionCache.set(id, config);
    return config;
  }

  function resolveCommonConfig(commonPackageId) {
    const commonConfig = readCommonConfig(commonPackageId);
    return Object.freeze({
      id: commonConfig.id,
      clinicalIcd: commonConfig.packages.clinicalIcd,
      insuranceIcd: commonConfig.packages.insuranceIcd,
      commonStrategy: resolveCommonStrategy(
        commonConfig.id,
        commonConfig.strategy,
      ),
      commonConfig,
    });
  }

  function resolveVersionConfig(versionId) {
    const versionConfig = readVersionConfig(versionId);
    const resolvedCommon = resolveCommonConfig(versionConfig.drgCommon);
    return Object.freeze({
      id: versionConfig.id,
      label: versionConfig.label,
      drgCommon: versionConfig.drgCommon,
      clinicalIcd: resolvedCommon.clinicalIcd,
      insuranceIcd: resolvedCommon.insuranceIcd,
      commonStrategy: resolvedCommon.commonStrategy,
      versionStrategy: resolveVersionStrategy(
        versionConfig.id,
        versionConfig.strategy,
      ),
      versionConfig,
      commonConfig: resolvedCommon.commonConfig,
    });
  }

  function listVersionConfigs() {
    return listVersionIds().map(readVersionConfig);
  }

  function listResolvedVersionConfigs() {
    return listVersionIds().map(resolveVersionConfig);
  }

  function readDefaultVersion(versionIds = listVersionIds()) {
    const config = readJsonObject(defaultVersionPath, 'default_version.json');
    const defaultVersion = requireNonEmptyString(
      config,
      'defaultVersion',
      'default_version.json',
    );
    if (!versionIds.includes(defaultVersion)) {
      throw new Error(
        `default_version.json references unknown version: ${defaultVersion}`,
      );
    }
    return defaultVersion;
  }

  return Object.freeze({
    paths: Object.freeze({
      projectRoot: resolvedRoot,
      dataDir,
      versionsDir,
      commonDir,
      defaultVersionPath,
    }),
    listVersionIds,
    readCommonConfig,
    resolveCommonConfig,
    readVersionConfig,
    resolveVersionConfig,
    listVersionConfigs,
    listResolvedVersionConfigs,
    readDefaultVersion,
  });
}

module.exports = {
  COMMON_STRATEGY_DEFAULTS,
  VERSION_STRATEGY_DEFAULTS,
  createDrgConfigResolver,
};
