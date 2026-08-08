const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

const paths = Object.freeze({
  versionsDir: path.join(root, 'src/data/versions'),
  commonDir: path.join(root, 'src/data/drg-common'),
  sharedJsonDir: path.join(root, 'src/data'),
  defaultVersionConfig: path.join(root, 'src/data/default_version.json'),
  generatedServicesDir: path.join(root, 'src/services/generated'),
});

const outputFiles = Object.freeze({
  versionData: path.join(paths.generatedServicesDir, 'versionData.js'),
  glData: path.join(paths.generatedServicesDir, 'glData.js'),
  versionRegistry: path.join(paths.generatedServicesDir, 'versionRegistry.js'),

  versionsDir: path.join(paths.generatedServicesDir, 'versions'),
  commonDir: path.join(paths.generatedServicesDir, 'common'),
  packagesDir: path.join(paths.generatedServicesDir, 'packages'),
});
const commonFiles = Object.freeze({
  adrgRules: 'adrg_rules.json',
  mdcRules: 'mdc_rules.json',
  ccCodes: 'cc_codes.json',
  mccCodes: 'mcc_codes.json',
  cceCodes: 'cce_codes.json',
  zdInvalid: 'zd_invalid.json',
  ssInvalid: 'ss_invalid.json',
});

const variantFiles = Object.freeze({
  drgSubgroupRules: 'drg_rules.json',
  drgMap: 'drg.json',
});

const clinicalFiles = Object.freeze({
  glDiagNames: 'icd_gl_names_diag.json',
  glProcNames: 'icd_gl_names_proc.json',
});
const insuranceFiles = Object.freeze({
  ybDiagNames: 'icd_yb_names_diag.json',
  ybProcNames: 'icd_yb_names_proc.json',
  icd10GrayJson: 'icd10_gray_codes.json',
  icd9GrayJson: 'icd9_gray_codes.json',
});
const crosswalkFiles = Object.freeze({
  icdGlToYbRaw: 'icd_gl_yb_map.json',
  icd9GlToYbRaw: 'icd9cm3_gl_yb_map.json',
});

const strategyDefaults = Object.freeze({
  invalidPrincipalProcedureAction: 'null-slot',
  allowedInvalidPrincipalProcedures: [],
  allowedGrayPrincipalProcedures: ['99.1000'],
  autoDetectNewTechnique: false,
  mdcyPrincipalDiagnosisOnly: true,
  allowSecondarySectionPrimaryFallback: false,
});

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function getStrategyOverrides(resolvedStrategy) {
  return Object.fromEntries(
    Object.entries(resolvedStrategy).filter(([field, value]) => {
      return (
        !Object.prototype.hasOwnProperty.call(strategyDefaults, field) ||
        !valuesEqual(value, strategyDefaults[field])
      );
    }),
  );
}

const allowedInvalidPrincipalProcedureActions = new Set([
  'null-slot',
  'shift',
  'keep',
]);

const booleanStrategyFields = Object.freeze([
  'autoDetectNewTechnique',
  'mdcyPrincipalDiagnosisOnly',
  'allowSecondarySectionPrimaryFallback',
]);

const arrayStrategyFields = Object.freeze([
  'allowedInvalidPrincipalProcedures',
  'allowedGrayPrincipalProcedures',
]);

function readJson(filePath, description = filePath) {
  let raw;

  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read ${description}: ${filePath}`, {
      cause: error,
    });
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${description}: ${filePath}`, {
      cause: error,
    });
  }
}

function ensureFileExists(filePath, description) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${description}: ${filePath}`);
  }

  const stat = fs.statSync(filePath);

  if (!stat.isFile()) {
    throw new Error(`Expected file for ${description}: ${filePath}`);
  }
}

function ensureDirectoryExists(directoryPath, description) {
  if (!fs.existsSync(directoryPath)) {
    throw new Error(`Missing ${description}: ${directoryPath}`);
  }

  const stat = fs.statSync(directoryPath);

  if (!stat.isDirectory()) {
    throw new Error(`Expected directory for ${description}: ${directoryPath}`);
  }
}

function writeGeneratedFile(filePath, content) {
  const normalizedContent = content.endsWith('\n')
    ? content
    : `${content}\n`;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, normalizedContent, 'utf8');
}

function quote(value) {
  return JSON.stringify(value);
}

function renderJsonImport(variableName, importPath) {
  return `import ${variableName} from ${quote(importPath)} with { type: 'json' };`;
}

function listVersionIds() {
  ensureDirectoryExists(paths.versionsDir, 'versions directory');

  return fs
    .readdirSync(paths.versionsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'));
}

function requireNonEmptyString(config, field, versionId) {
  const value = config[field];

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `${versionId}/config.json requires a non-empty string: ${field}`,
    );
  }

  return value.trim();
}

function validateStrategy(commonPackageId, suppliedStrategy) {
  if (
    suppliedStrategy !== undefined &&
    (
      suppliedStrategy === null ||
      typeof suppliedStrategy !== 'object' ||
      Array.isArray(suppliedStrategy)
    )
  ) {
    throw new Error(
      `drg-common/${commonPackageId}/config.json strategy must be an object`,
    );
  }

  const strategy = {
    ...strategyDefaults,
    ...(suppliedStrategy || {}),
  };

  if (
    !allowedInvalidPrincipalProcedureActions.has(
      strategy.invalidPrincipalProcedureAction,
    )
  ) {
    throw new Error(
      `drg-common/${commonPackageId}/config.json ` +
      'strategy.invalidPrincipalProcedureAction ' +
      'must be null-slot, shift, or keep',
    );
  }

  for (const field of arrayStrategyFields) {
    const value = strategy[field];

    if (
      !Array.isArray(value) ||
      value.some(item => typeof item !== 'string' || item.trim() === '')
    ) {
      throw new Error(
        `drg-common/${commonPackageId}/config.json strategy.${field} ` +
        'must be an array of non-empty strings',
      );
    }

    strategy[field] = [...new Set(value.map(item => item.trim()))];
  }

  for (const field of booleanStrategyFields) {
    if (typeof strategy[field] !== 'boolean') {
      throw new Error(
        `drg-common/${commonPackageId}/config.json ` +
        `strategy.${field} must be boolean`,
      );
    }
  }

  return Object.freeze(strategy);
}

function readCommonConfig(commonPackageId) {
  const configPath = path.join(
    paths.commonDir,
    commonPackageId,
    'config.json',
  );

  ensureFileExists(configPath, `${commonPackageId} common DRG config`);
  const rawConfig = readJson(
    configPath,
    `drg-common/${commonPackageId}/config.json`,
  );

  if (
    rawConfig === null ||
    typeof rawConfig !== 'object' ||
    Array.isArray(rawConfig)
  ) {
    throw new Error(
      `drg-common/${commonPackageId}/config.json must contain a JSON object`,
    );
  }

  const id = requireNonEmptyString(
    rawConfig,
    'id',
    `drg-common/${commonPackageId}`,
  );
  if (id !== commonPackageId) {
    throw new Error(
      `drg-common/${commonPackageId}/config.json id must equal directory name`,
    );
  }

  return Object.freeze({
    ...rawConfig,
    id,
    strategy: Object.freeze(getStrategyOverrides(validateStrategy(
      commonPackageId,
      rawConfig.strategy,
    ))),
  });
}

function readVersionConfig(versionId) {
  const configPath = path.join(
    paths.versionsDir,
    versionId,
    'config.json',
  );

  ensureFileExists(configPath, `${versionId} version config`);

  const rawConfig = readJson(
    configPath,
    `${versionId}/config.json`,
  );

  if (
    rawConfig === null ||
    typeof rawConfig !== 'object' ||
    Array.isArray(rawConfig)
  ) {
    throw new Error(
      `${versionId}/config.json must contain a JSON object`,
    );
  }

  const id = requireNonEmptyString(rawConfig, 'id', versionId);
  const label = requireNonEmptyString(rawConfig, 'label', versionId);
  const packages = rawConfig.packages;
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    throw new Error(`${versionId}/config.json requires packages`);
  }
  for (const field of ['drgCommon', 'clinicalIcd', 'insuranceIcd']) {
    requireNonEmptyString(packages, field, `${versionId}.packages`);
  }

  if (id !== versionId) {
    throw new Error(
      `${versionId}/config.json id must equal directory name`,
    );
  }

  if (Object.prototype.hasOwnProperty.call(rawConfig, 'strategy')) {
    throw new Error(
      `${versionId}/config.json strategy belongs to its ` +
      'packages.drgCommon config',
    );
  }

  const commonConfig = readCommonConfig(packages.drgCommon);

  return Object.freeze({
    ...rawConfig,
    id,
    label,
    packages: Object.freeze({ ...packages }),
    strategy: commonConfig.strategy,
  });
}

function readDefaultVersion(versionIds) {
  ensureFileExists(
    paths.defaultVersionConfig,
    'default version config',
  );

  const config = readJson(
    paths.defaultVersionConfig,
    'default_version.json',
  );

  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config)
  ) {
    throw new Error(
      'default_version.json must contain a JSON object',
    );
  }

  const defaultVersion = config.defaultVersion;

  if (
    typeof defaultVersion !== 'string' ||
    !versionIds.includes(defaultVersion)
  ) {
    throw new Error(
      'default_version.json.defaultVersion must reference ' +
      'an existing version',
    );
  }

  return defaultVersion;
}

function validateCommonFiles(packageId) {
  const generatedDir = path.join(
    paths.commonDir,
    packageId,
    'generated',
  );

  for (const filename of Object.values(commonFiles)) {
    ensureFileExists(
      path.join(generatedDir, filename),
      `common ${packageId} generated file ${filename}`,
    );
  }
}

function validateVariantFiles(versionId) {
  const generatedDir = path.join(
    paths.versionsDir,
    versionId,
    'generated',
  );

  for (const filename of Object.values(variantFiles)) {
    ensureFileExists(
      path.join(generatedDir, filename),
      `${versionId} generated file ${filename}`,
    );
  }
}

function getCommonModuleFilename(packageId) {
  return `${packageId}.js`;
}

function getVersionModuleFilename(versionId) {
  return `${versionId}.js`;
}

function generateCommonModule(packageId) {
  validateCommonFiles(packageId);

  const imports = Object.entries(commonFiles).map(
    ([field, filename]) => renderJsonImport(
      field,
      `../../../data/drg-common/${packageId}/generated/${filename}`,
    ),
  );

  const fields = Object.keys(commonFiles);

  const content = [
    '// Generated by scripts/generate_version_data.cjs. Do not edit.',
    ...imports,
    '',
    `export const commonData = Object.freeze({ ${fields.join(', ')} });`,
  ].join('\n');

  const moduleFilename = getCommonModuleFilename(packageId);

  writeGeneratedFile(
    path.join(outputFiles.commonDir, moduleFilename),
    content,
  );

  return moduleFilename;
}

function generateVersionModule(versionId, config) {
  validateVariantFiles(versionId);

  const imports = Object.entries(variantFiles).map(
    ([field, filename]) => renderJsonImport(
      field,
      `../../../data/versions/${versionId}/generated/${filename}`,
    ),
  );

  const fields = Object.keys(variantFiles);

  const content = [
    '// Generated by scripts/generate_version_data.cjs. Do not edit.',
    ...imports,
    '',
    `export const versionData = Object.freeze({ ${fields.join(', ')} });`,
  ].join('\n');

  const moduleFilename = getVersionModuleFilename(versionId);

  writeGeneratedFile(
    path.join(outputFiles.versionsDir, moduleFilename),
    content,
  );

  return moduleFilename;
}

function generatePackageModule(kind, packageId, files, sourceDir, outputDir) {
  const generatedSegment = 'generated';
  for (const filename of Object.values(files)) {
    ensureFileExists(path.join(paths.sharedJsonDir, sourceDir, packageId, generatedSegment, filename), `${packageId} ${kind} file ${filename}`);
  }
  const dataPrefix = '../../../../data';
  const imports = Object.entries(files).map(([field, filename]) => renderJsonImport(field, `${dataPrefix}/${sourceDir}/${packageId}/${generatedSegment ? `${generatedSegment}/` : ''}${filename}`));
  const content = [
    '// Generated by scripts/generate_version_data.cjs. Do not edit.',
    ...imports,
    '',
    `export const ${kind}Data = Object.freeze({ ${Object.keys(files).join(', ')} });`,
  ].join('\n');
  const filename = `${packageId}.js`;
  writeGeneratedFile(path.join(outputDir, filename), content);
  return filename;
}

function buildVersionDescriptors(configs) {
  const commonModules = new Map();
  const clinicalModules = new Map();
  const insuranceModules = new Map();
  const crosswalkModules = new Map();

  return configs.map(config => {
    let commonModule = commonModules.get(config.packages.drgCommon);

    if (!commonModule) {
      commonModule = generateCommonModule(config.packages.drgCommon);
      commonModules.set(config.packages.drgCommon, commonModule);
    }

    const versionModule = generateVersionModule(config.id, config);
    let clinicalModule = clinicalModules.get(config.packages.clinicalIcd);
    if (!clinicalModule) {
      clinicalModule = generatePackageModule('clinical', config.packages.clinicalIcd, clinicalFiles, 'icd-datasets/clinical', path.join(outputFiles.packagesDir, 'clinical'));
      clinicalModules.set(config.packages.clinicalIcd, clinicalModule);
    }
    let insuranceModule = insuranceModules.get(config.packages.insuranceIcd);
    if (!insuranceModule) {
      insuranceModule = generatePackageModule('insurance', config.packages.insuranceIcd, insuranceFiles, 'icd-datasets/insurance', path.join(outputFiles.packagesDir, 'insurance'));
      insuranceModules.set(config.packages.insuranceIcd, insuranceModule);
    }
    const crosswalkId = `${config.packages.clinicalIcd}__${config.packages.insuranceIcd}`;
    let crosswalkModule = crosswalkModules.get(crosswalkId);
    if (!crosswalkModule) {
      crosswalkModule = generatePackageModule('crosswalk', crosswalkId, crosswalkFiles, 'crosswalks', path.join(outputFiles.packagesDir, 'crosswalks'));
      crosswalkModules.set(crosswalkId, crosswalkModule);
    }

    return Object.freeze({
      config,
      commonModule,
      versionModule,
      clinicalModule,
      insuranceModule,
      crosswalkModule,
    });
  });
}

function renderVersionLoader(descriptor) {
  const { config, commonModule, versionModule, insuranceModule } = descriptor;

  return [
    `  ${quote(config.id)}: async () => {`,
    '    const [{ commonData }, { versionData }, { insuranceData }] = await Promise.all([',
    `      import('./common/${commonModule}'),`,
    `      import('./versions/${versionModule}'),`,
    `      import('./packages/insurance/${insuranceModule}'),`,
    '    ]);',
    '',
    '    return Object.freeze({',
    '      ...commonData,',
    '      ...versionData,',
    '      ...insuranceData,',
    '    });',
    '  },',
  ].join('\n');
}

function generateGLDataFile(descriptors) {
  const clinicalLoaders = new Map();
  const crosswalkLoaders = new Map();
  for (const { config, clinicalModule, crosswalkModule } of descriptors) {
    clinicalLoaders.set(config.packages.clinicalIcd, clinicalModule);
    crosswalkLoaders.set(`${config.packages.clinicalIcd}__${config.packages.insuranceIcd}`, crosswalkModule);
  }
  const renderLoaders = (entries, kind, pathPart) => [...entries.entries()].map(([id, module]) => [
    `  ${quote(id)}: () => import('./packages/${pathPart}/${module}').then(({ ${kind}Data }) => ${kind}Data),`,
  ].join('\n'));
  const clinicalEntries = renderLoaders(clinicalLoaders, 'clinical', 'clinical');
  const crosswalkEntries = renderLoaders(crosswalkLoaders, 'crosswalk', 'crosswalks');
  const content = [
    '// Generated by scripts/generate_version_data.cjs. Do not edit.',
    'const clinicalLoaders = Object.freeze({',
    ...clinicalEntries,
    '});',
    'const crosswalkLoaders = Object.freeze({',
    ...crosswalkEntries,
    '});',
    '',
    'export async function loadGlData(packages) {',
    '  const clinicalId = packages?.clinicalIcd;',
    '  const insuranceId = packages?.insuranceIcd;',
    '  const crosswalkId = `${clinicalId}__${insuranceId}`;',
    '  const clinicalLoader = clinicalLoaders[clinicalId];',
    '  const crosswalkLoader = crosswalkLoaders[crosswalkId];',
    '  if (!clinicalLoader || !crosswalkLoader) {',
    '    throw new Error(`Unknown ICD package combination: ${crosswalkId}`);',
    '  }',
    '  const [clinicalData, crosswalkData] = await Promise.all([clinicalLoader(), crosswalkLoader()]);',
    '  return Object.freeze({ ...clinicalData, ...crosswalkData });',
    '}',
  ].join('\n');
  writeGeneratedFile(outputFiles.glData, content);
}

function generateVersionDataFile(descriptors, defaultVersion) {
  const defaultDescriptor = descriptors.find(
    descriptor => descriptor.config.id === defaultVersion,
  );

  if (!defaultDescriptor) {
    throw new Error(
      `Unable to locate default version descriptor: ${defaultVersion}`,
    );
  }

  const loaderEntries = descriptors.map(renderVersionLoader);

  const content = [
    '// Generated by scripts/generate_version_data.cjs. Do not edit.',
    'const versionLoaders = Object.freeze({',
    ...loaderEntries,
    '});',
    '',
    'const versionDataCache = new Map();',
    '',
    'async function loadAndCacheVersionData(version) {',
    '  const loader = versionLoaders[version];',
    '',
    '  if (!loader) {',
    '    throw new Error(`Unknown DRG rule version: ${version}`);',
    '  }',
    '',
    '  const data = await loader();',
    '  versionDataCache.set(version, data);',
    '  return data;',
    '}',
    '',
    `const defaultVersionData = await loadAndCacheVersionData(${quote(defaultVersion)});`,
    '',
    'export const versionDataById = Object.freeze({',
    `  ${quote(defaultVersion)}: defaultVersionData,`,
    '});',
    '',
    'export async function loadVersionData(version) {',
    '  const cached = versionDataCache.get(version);',
    '  if (cached) return cached;',
    '',
    '  return loadAndCacheVersionData(version);',
    '}',
  ].join('\n');

  writeGeneratedFile(outputFiles.versionData, content);
}

function renderRegistryEntry(config, defaultVersion) {
  const fields = [
    `id: ${quote(config.id)}`,
    `label: ${quote(config.label)}`,
    `packages: ${JSON.stringify(config.packages)}`,
  ];

  if (config.id === defaultVersion) {
    fields.push(`data: versionDataById[${quote(config.id)}]`);
  }

  fields.push(
    `strategy: Object.freeze(${JSON.stringify(config.strategy)})`,
  );

  return [
    `  ${quote(config.id)}: Object.freeze({`,
    ...fields.map(field => `    ${field},`),
    '  }),',
  ].join('\n');
}

function generateVersionRegistryFile(configs, defaultVersion) {
  const registryEntries = configs.map(
    config => renderRegistryEntry(config, defaultVersion),
  );

  const content = [
    '// Generated by scripts/generate_version_data.cjs. Do not edit.',
    "import { versionDataById } from './versionData.js';",
    '',
    `export const DEFAULT_RULE_VERSION = ${quote(defaultVersion)};`,
    '',
    `export const DEFAULT_VERSION_STRATEGY = Object.freeze(${JSON.stringify(strategyDefaults)});`,
    '',
    'export function resolveVersionStrategy(strategy = {}) {',
    '  return Object.freeze({',
    '    ...DEFAULT_VERSION_STRATEGY,',
    '    ...strategy,',
    '  });',
    '}',
    '',
    'export const VERSION_REGISTRY = Object.freeze({',
    ...registryEntries,
    '});',
    '',
    'export function getVersionDefinition(',
    '  version = DEFAULT_RULE_VERSION,',
    ') {',
    '  const definition = VERSION_REGISTRY[version];',
    '',
    '  if (!definition) {',
    '    throw new Error(`Unknown DRG rule version: ${version}`);',
    '  }',
    '',
    '  return Object.freeze({',
    '    ...definition,',
    '    strategy: resolveVersionStrategy(definition.strategy),',
    '  });',
    '}',
    '',
    'export function listVersionDefinitions() {',
    '  return Object.values(VERSION_REGISTRY).map((',
    '    { id, label, packages },',
    '  ) => ({',
    '    id,',
    '    label,',
    '    packages,',
    '  }));',
    '}',
  ].join('\n');

  writeGeneratedFile(outputFiles.versionRegistry, content);
}

function main() {
  const versionIds = listVersionIds();

  if (versionIds.length === 0) {
    throw new Error(
      `No DRG versions found in ${paths.versionsDir}`,
    );
  }
  
  fs.mkdirSync(outputFiles.commonDir, { recursive: true });
  fs.mkdirSync(outputFiles.versionsDir, { recursive: true });
  fs.mkdirSync(path.join(outputFiles.packagesDir, 'clinical'), { recursive: true });
  fs.mkdirSync(path.join(outputFiles.packagesDir, 'insurance'), { recursive: true });
  fs.mkdirSync(path.join(outputFiles.packagesDir, 'crosswalks'), { recursive: true });

  const configs = versionIds.map(readVersionConfig);
  const defaultVersion = readDefaultVersion(versionIds);
  const descriptors = buildVersionDescriptors(configs);

  generateVersionDataFile(descriptors, defaultVersion);
  generateGLDataFile(descriptors);
  generateVersionRegistryFile(configs, defaultVersion);

  const commonPackages = new Set(
    configs.map(config => config.packages.drgCommon),
  );

  console.log('');
  console.log('========================================');
  console.log(' DRG VERSION DATA GENERATED SUCCESSFULLY');
  console.log('========================================');
  console.log(` Versions:        ${configs.length}`);
  console.log(` Common packages: ${commonPackages.size}`);
  console.log(` Default version: ${defaultVersion}`);
  console.log(` Output:          ${paths.generatedServicesDir}`);
  console.log('========================================');
}

try {
  main();
} catch (error) {
  console.error('');
  console.error('========================================');
  console.error(' DRG VERSION DATA GENERATION FAILED');
  console.error('========================================');
  console.error(error.stack || error.message || error);
  console.error('========================================');
  process.exitCode = 1;
}
