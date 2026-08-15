const fs = require('fs');
const path = require('path');
const {
  COMMON_STRATEGY_DEFAULTS: strategyDefaults,
  VERSION_STRATEGY_DEFAULTS: versionStrategyDefaults,
  createDrgConfigResolver,
} = require('./lib/drg_config.cjs');

const root = path.resolve(__dirname, '..');
const configResolver = createDrgConfigResolver(root);

const paths = Object.freeze({
  versionsDir: path.join(root, 'src/data/versions'),
  commonDir: path.join(root, 'src/data/drg-common'),
  sharedJsonDir: path.join(root, 'src/data'),
  generatedServicesDir: path.join(root, 'src/services/generated'),
});

const outputFiles = Object.freeze({
  versionData: path.join(paths.generatedServicesDir, 'versionData.ts'),
  glData: path.join(paths.generatedServicesDir, 'glData.ts'),
  versionRegistry: path.join(paths.generatedServicesDir, 'versionRegistry.ts'),

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

function getVersionStrategyOverrides(resolvedStrategy) {
  return Object.fromEntries(
    Object.entries(resolvedStrategy).filter(([field, value]) => (
      !Object.prototype.hasOwnProperty.call(versionStrategyDefaults, field)
      || !valuesEqual(value, versionStrategyDefaults[field])
    )),
  );
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

function writeGeneratedFile(filePath, content) {
  const normalizedContent = content.endsWith('\n')
    ? content
    : `${content}\n`;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, normalizedContent, 'utf8');

  // The generated service layer is intentionally TypeScript-only. Remove the
  // exact legacy JavaScript sibling after its replacement has been written so
  // stale runtime modules cannot be picked up by an old import path.
  if (filePath.endsWith('.ts')) {
    const legacyPath = filePath.slice(0, -3) + '.js';
    if (fs.existsSync(legacyPath)) {
      fs.unlinkSync(legacyPath);
    }
  }
}

function quote(value) {
  return JSON.stringify(value);
}

function renderJsonImport(variableName, importPath) {
  return `import ${variableName} from ${quote(importPath)} with { type: 'json' };`;
}

function readCommonConfig(commonPackageId) {
  const resolvedConfig = configResolver.resolveCommonConfig(commonPackageId);

  return Object.freeze({
    ...resolvedConfig.commonConfig,
    strategy: Object.freeze(getStrategyOverrides(
      resolvedConfig.commonStrategy,
    )),
  });
}

function readVersionConfig(versionId) {
  const resolvedConfig = configResolver.resolveVersionConfig(versionId);
  const rawConfig = resolvedConfig.versionConfig;

  // Resolve build-time ICD inputs through the referenced common package, while
  // keeping the generated version registry free of duplicated package fields.
  readCommonConfig(resolvedConfig.drgCommon);
  const resolvedPackages = Object.freeze({
    clinicalIcd: resolvedConfig.clinicalIcd,
    insuranceIcd: resolvedConfig.insuranceIcd,
  });
  const versionStrategy = getVersionStrategyOverrides(
    resolvedConfig.versionStrategy,
  );
  const versionConfig = Object.fromEntries(
    Object.entries(rawConfig).filter(([field]) => field !== 'strategy'),
  );

  return Object.freeze({
    ...versionConfig,
    id: resolvedConfig.id,
    label: resolvedConfig.label,
    drgCommon: resolvedConfig.drgCommon,
    resolvedPackages,
    versionStrategy: Object.freeze(versionStrategy),
  });
}

function readDefaultVersion(versionIds) {
  return configResolver.readDefaultVersion(versionIds);
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
  return `${packageId}.ts`;
}

function getVersionModuleFilename(versionId) {
  return `${versionId}.ts`;
}

function generateCommonModule(packageId) {
  validateCommonFiles(packageId);

  const imports = Object.entries(commonFiles).map(
    ([field, filename]) => renderJsonImport(
      field,
      `../../../data/drg-common/${packageId}/generated/${filename}`,
    ),
  );

  const content = [
    '// Generated by scripts/generate_version_data.cjs. Do not edit.',
    ...imports,
    '',
    `export const commonData = Object.freeze({ ${Object.keys(commonFiles).join(', ')} });`,
  ].join('\n');

  const moduleFilename = getCommonModuleFilename(packageId);

  const modulePath = path.join(outputFiles.commonDir, moduleFilename);
  writeGeneratedFile(modulePath, content);

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

  const content = [
    '// Generated by scripts/generate_version_data.cjs. Do not edit.',
    ...imports,
    '',
    `export const versionData = Object.freeze({ ${Object.keys(variantFiles).join(', ')} });`,
  ].join('\n');

  const moduleFilename = getVersionModuleFilename(versionId);

  const modulePath = path.join(outputFiles.versionsDir, moduleFilename);
  writeGeneratedFile(modulePath, content);

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
  const filename = `${packageId}.ts`;
  const modulePath = path.join(outputDir, filename);
  writeGeneratedFile(modulePath, content);
  return filename;
}

function buildVersionDescriptors(configs) {
  const commonModules = new Map();
  const clinicalModules = new Map();
  const insuranceModules = new Map();
  const crosswalkModules = new Map();

  return configs.map(config => {
    const packages = config.resolvedPackages;
    let commonModule = commonModules.get(config.drgCommon);

    if (!commonModule) {
      commonModule = generateCommonModule(config.drgCommon);
      commonModules.set(config.drgCommon, commonModule);
    }

    const versionModule = generateVersionModule(config.id, config);
    let clinicalModule = clinicalModules.get(packages.clinicalIcd);
    if (!clinicalModule) {
      clinicalModule = generatePackageModule('clinical', packages.clinicalIcd, clinicalFiles, 'icd-datasets/clinical', path.join(outputFiles.packagesDir, 'clinical'));
      clinicalModules.set(packages.clinicalIcd, clinicalModule);
    }
    let insuranceModule = insuranceModules.get(packages.insuranceIcd);
    if (!insuranceModule) {
      insuranceModule = generatePackageModule('insurance', packages.insuranceIcd, insuranceFiles, 'icd-datasets/insurance', path.join(outputFiles.packagesDir, 'insurance'));
      insuranceModules.set(packages.insuranceIcd, insuranceModule);
    }
    const crosswalkId = `${packages.clinicalIcd}__${packages.insuranceIcd}`;
    let crosswalkModule = crosswalkModules.get(crosswalkId);
    if (!crosswalkModule) {
      crosswalkModule = generatePackageModule('crosswalk', crosswalkId, crosswalkFiles, 'crosswalks', path.join(outputFiles.packagesDir, 'crosswalks'));
      crosswalkModules.set(crosswalkId, crosswalkModule);
    }

    return Object.freeze({
      config,
      packages,
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
  for (const { packages, clinicalModule, crosswalkModule } of descriptors) {
    clinicalLoaders.set(packages.clinicalIcd, clinicalModule);
    crosswalkLoaders.set(`${packages.clinicalIcd}__${packages.insuranceIcd}`, crosswalkModule);
  }
  const renderLoaders = (entries, kind, pathPart) => [...entries.entries()].map(([id, module]) => [
    `  ${quote(id)}: () => import('./packages/${pathPart}/${module}').then(({ ${kind}Data }) => ${kind}Data),`,
  ].join('\n'));
  const clinicalEntries = renderLoaders(clinicalLoaders, 'clinical', 'clinical');
  const crosswalkEntries = renderLoaders(crosswalkLoaders, 'crosswalk', 'crosswalks');
  const content = [
    '// Generated by scripts/generate_version_data.cjs. Do not edit.',
    'type GlDataLoader = () => Promise<Record<string, unknown>>;',
    '',
    'const clinicalLoaders: Readonly<Record<string, GlDataLoader>> = Object.freeze({',
    ...clinicalEntries,
    '});',
    'const crosswalkLoaders: Readonly<Record<string, GlDataLoader>> = Object.freeze({',
    ...crosswalkEntries,
    '});',
    '',
    'export async function loadGlData(packages?: { clinicalIcd?: string; insuranceIcd?: string } | null): Promise<Record<string, unknown>> {',
    '  const clinicalId = packages?.clinicalIcd;',
    '  const insuranceId = packages?.insuranceIcd;',
    '  const crosswalkId = `${clinicalId}__${insuranceId}`;',
    "  const clinicalLoader = clinicalLoaders[clinicalId ?? ''];",
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
    "import type { RuleData } from '../../types/rules.js';",
    "import { normalizeRuleData } from '../ruleData.ts';",
    '',
    'type VersionLoader = () => Promise<Record<string, unknown>>;',
    '',
    'const versionLoaders: Readonly<Record<string, VersionLoader>> = Object.freeze({',
    ...loaderEntries,
    '});',
    '',
    'const versionDataCache = new Map<string, RuleData>();',
    '',
    'async function loadAndCacheVersionData(version: string): Promise<RuleData> {',
    '  const loader = versionLoaders[version];',
    '',
    '  if (!loader) {',
    '    throw new Error(`Unknown DRG rule version: ${version}`);',
    '  }',
    '',
    '  const data = normalizeRuleData(await loader());',
    '  versionDataCache.set(version, data);',
    '  return data;',
    '}',
    '',
    `const defaultVersionData: RuleData = await loadAndCacheVersionData(${quote(defaultVersion)});`,
    '',
    'export const versionDataById: Readonly<Record<string, RuleData>> = Object.freeze({',
    `  ${quote(defaultVersion)}: defaultVersionData,`,
    '});',
    '',
    'export async function loadVersionData(version: string): Promise<RuleData> {',
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
    `drgCommon: ${quote(config.drgCommon)}`,
  ];

  if (config.id === defaultVersion) {
    fields.push(`data: versionDataById[${quote(config.id)}]`);
  }

  if (Object.keys(config.versionStrategy).length > 0) {
    fields.push(
      `versionStrategy: Object.freeze(${JSON.stringify(config.versionStrategy)})`,
    );
  }

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
  const commonRegistryEntries = [
    ...new Set(configs.map(config => config.drgCommon)),
  ].sort((left, right) => left.localeCompare(right, 'en')).map(packageId => {
    const commonConfig = readCommonConfig(packageId);
    return [
      `  ${quote(packageId)}: Object.freeze({`,
      `    packages: Object.freeze(${JSON.stringify(commonConfig.packages)}),`,
      `    strategy: Object.freeze(${JSON.stringify(commonConfig.strategy)}),`,
      '  }),',
    ].join('\n');
  });

  const content = [
    '// Generated by scripts/generate_version_data.cjs. Do not edit.',
    "import { versionDataById } from './versionData.ts';",
    "import type { CommonStrategy, VersionDefinition, VersionId, VersionPackages, VersionStrategy, VersionSummary } from '../../types/grouper.js';",
    "import type { RuleData } from '../../types/rules.js';",
    '',
    'type RawCommonDefinition = {',
    '  packages: VersionPackages;',
    '  strategy: Partial<CommonStrategy>;',
    '};',
    '',
    'type RawVersionDefinition = {',
    '  id: VersionId;',
    '  label: string;',
    '  drgCommon: string;',
    '  data?: RuleData;',
    '  versionStrategy?: Partial<VersionStrategy>;',
    '};',
    '',
    `export const DEFAULT_RULE_VERSION: VersionId = ${quote(defaultVersion)};`,
    '',
    `export const DEFAULT_COMMON_STRATEGY: CommonStrategy = Object.freeze(${JSON.stringify(strategyDefaults)});`,
    `export const DEFAULT_VERSION_STRATEGY: VersionStrategy = Object.freeze(${JSON.stringify(versionStrategyDefaults)});`,
    '',
    'export function resolveCommonStrategy(strategy: Partial<CommonStrategy> = {}): CommonStrategy {',
    '  return Object.freeze({',
    '    ...DEFAULT_COMMON_STRATEGY,',
    '    ...strategy,',
    '  });',
    '}',
    '',
    'export function resolveVersionStrategy(strategy: Partial<VersionStrategy> = {}): VersionStrategy {',
    '  return Object.freeze({',
    '    ...DEFAULT_VERSION_STRATEGY,',
    '    ...strategy,',
    '  });',
    '}',
    '',
    'export const DRG_COMMON_REGISTRY: Readonly<Record<string, RawCommonDefinition>> = Object.freeze({',
    ...commonRegistryEntries,
    '});',
    '',
    'export const VERSION_REGISTRY: Readonly<Record<VersionId, RawVersionDefinition>> = Object.freeze({',
    ...registryEntries,
    '});',
    '',
    'export function getVersionDefinition(',
    '  version: VersionId = DEFAULT_RULE_VERSION,',
    '): VersionDefinition {',
    '  const definition = VERSION_REGISTRY[version];',
    '',
    '  if (!definition) {',
    '    throw new Error(`Unknown DRG rule version: ${version}`);',
    '  }',
    '',
    '  const commonDefinition = DRG_COMMON_REGISTRY[definition.drgCommon];',
    '  if (!commonDefinition) {',
    '    throw new Error(',
    '      `Unknown common DRG package: ${definition.drgCommon}`,',
    '    );',
    '  }',
    '',
    '  return Object.freeze({',
    '    ...definition,',
    '    packages: Object.freeze({',
    '      ...commonDefinition.packages,',
    '    }),',
    '    commonStrategy: resolveCommonStrategy(',
    '      commonDefinition.strategy,',
    '    ),',
    '    versionStrategy: resolveVersionStrategy(definition.versionStrategy),',
    '  });',
    '}',
    '',
    'export function listVersionDefinitions(): VersionSummary[] {',
    '  return Object.keys(VERSION_REGISTRY).map(version => {',
    '    const { id, label, drgCommon, packages } = getVersionDefinition(version);',
    '    return { id, label, drgCommon, packages };',
    '  });',
    '}',
  ].join('\n');

  writeGeneratedFile(outputFiles.versionRegistry, content);
}

function main() {
  const versionIds = configResolver.listVersionIds();

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
    configs.map(config => config.drgCommon),
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
