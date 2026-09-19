import type { AdrgRule, RpnToken } from '../types/rules.js';

export interface ParsedRule extends Pick<AdrgRule,
  'referencedADRGs' | 'requiredReferencedADRGs' | 'anyProcedureRequired' | 'zeroProceduresRequired' | '_logicCompileError'
> {
  logic: string;
  sections: Record<string, string[] | undefined>;
  sectionAliases?: Record<string, string>;
  requiredProcedureGroups?: string[][];
  sectionMinimumOccurrences?: Record<string, number>;
  _logicRPN?: RpnToken[] | null;
}

// Lightweight parsing core for ADRG/MDC rule text.
// Keeps parsing + logic-compilation in a single small module so build scripts
// can import it without pulling in UI/runtime helpers.

// Regex/constants used only by the parser
const CODE_PATTERN = /^([^\s：:]+)/;
const INCLUDE_PATTERN = /包含\s*([^\s：:]+(?:、[^\s：:]+)*)\s*的所有/;
const LOGIC_PATTERN = /入组条件\s*\d*[：:]?/g;
const CODE_EXTRACT_PATTERN = /^([^\s：:]+)/gm;

// --- Helper functions used by parseRule ---
function detectSpecialCases(text: string, rules: ParsedRule) {
  if (text.match(/包含(?:全部|所有)手术或操作/) || text.match(/包含除[^\n。]*之外的所有手术或操作/)) {
    rules.anyProcedureRequired = true;
  }
  if (text.includes('无手术或操作')) rules.zeroProceduresRequired = true;
  const includeMatch = text.match(INCLUDE_PATTERN);
  if (includeMatch) rules.referencedADRGs = includeMatch[1]!.split('、');
}

function parseSimultaneousProcedureGroups(text: string, rules: ParsedRule) {
  const inlineMatch = text.match(/同时包含\s*([A-Z0-9]+(?:\s*和\s*[A-Z0-9]+)+)\s*的手术或操作[:：]?/);
  if (inlineMatch) {
    const codes = inlineMatch[1]!.match(/[A-Z0-9]+/g) || [];
    rules.referencedADRGs = codes;
    rules.requiredReferencedADRGs = codes;
    return;
  }

  const marker = '同时包含以下手术或操作';
  if (!text.includes(marker)) return;
  const start = text.indexOf(marker);
  const block = text.slice(start + marker.length).replace(/\r\n/g, '\n');
  const rawGroups = block.split(/\n\s*和\s*\n/);
  rules.requiredProcedureGroups = rawGroups.map(
    part => part.match(CODE_EXTRACT_PATTERN) || [],
  );
}

function normalizeSectionHeader(raw: string) {
  let header = raw.slice(0, -1).trim();
  header = header.replace(/^\d+(?:\.\d+)?\s+/, '');
  header = header.replace(/(\D)(\d+)$/, '$1 $2');
  header = header.replace(/\s+/g, ' ').trim();
  if (header.includes('主要诊断')) header = header.replace(/^.*?(主要诊断(?:\s+\d+)?)$/, '$1');
  else if (header.includes('其他诊断')) header = header.replace(/^.*?(其他诊断(?:\s+\d+)?)$/, '$1');
  else if (header.includes('主要手术或操作')) header = header.replace(/^.*?(主要手术或操作(?:\s+\d+)?)$/, '$1');
  else if (header.includes('其他手术或操作')) header = header.replace(/^.*?(其他手术或操作(?:\s+\d+)?)$/, '$1');
  else if (header.includes('手术或操作')) header = header.replace(/^.*?(手术或操作(?:\s+\d+)?)$/, '$1');
  if (header.includes('包含以下主要诊断或其他诊断')) header = '诊断';
  return header;
}

function parseMinimumOccurrenceSectionHeader(line: string) {
  const header = line
    .replace(/[：:]$/u, '')
    .replace(/\s+/gu, '')
    .trim();
  const match = header.match(
    /^(?:包含以下)?((?:主要|其他)?(?:诊断|手术或操作))且(?:全部)?(诊断|手术或操作)中(?:至少)?有?([0-9零〇一二两三四五六七八九十百]+)个(?:及以上|以上)$/u,
  );
  if (!match) return null;

  const requiredSection = match[1]!;
  const countedSection = match[2]!;
  const requiredCategory = requiredSection.replace(/^(?:主要|其他)/u, '');
  const rawMinimum = match[3]!;
  let minimum;
  if (/^\d+$/.test(rawMinimum)) {
    minimum = Number(rawMinimum);
  } else {
    const digits = new Map([
      ['零', 0], ['〇', 0], ['一', 1], ['二', 2], ['两', 2], ['三', 3],
      ['四', 4], ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9],
    ]);
    const units = new Map([['十', 10], ['百', 100]]);
    let total = 0;
    let current = 0;
    let valid = true;
    for (const char of rawMinimum) {
      if (digits.has(char)) {
        current = digits.get(char)!;
        continue;
      }
      const unit = units.get(char);
      if (!unit) {
        valid = false;
        break;
      }
      total += (current || 1) * unit;
      current = 0;
    }
    const result = total + current;
    minimum = valid && result > 0 ? result : null;
  }
  if (requiredCategory !== countedSection || minimum === null) return null;
  return { requiredSection, countedSection, minimum };
}

function formatRegionalRuleSection(section: string, index = '') {
  return `${section}${index ? ` ${index}` : ''}`;
}

const PRIMARY_PROCEDURE_QUALIFIER_PATTERN = /至\s*少\s*有\s*一个\s*是\s*主要\s*手术\s*(?:或\s*)?操作/u;
const EVERY_CONDITION_PRIMARY_PROCEDURE_QUALIFIER_PATTERN = /每种条件中?\s*至\s*少\s*有\s*一个\s*是\s*主要\s*手术\s*(?:或\s*)?操作/u;
const PROCEDURE_SECTION_REFERENCE_PATTERN = /((?:主要|其他|全部)?\s*手术\s*(?:或\s*)?操作)\s*(\d+)/gu;

function extractProcedureSectionReferences(text: string) {
  const references: string[] = [];
  for (const match of text.matchAll(PROCEDURE_SECTION_REFERENCE_PATTERN)) {
    const prefix = match[1]!.replace(/\s+/gu, '');
    const index = match[2]!;
    const section = prefix.startsWith('主要')
      ? '主要手术或操作'
      : prefix.startsWith('其他')
        ? '其他手术或操作'
        : '手术或操作';
    const reference = `${section} ${index}`;
    if (!references.includes(reference)) references.push(reference);
  }
  return references;
}

function appendPrincipalProcedureRequirement(line: string, references: string[]) {
  const principalReferences = references.map(reference => reference.startsWith('主要')
    ? reference
    : `主要${reference}`);
  if (principalReferences.length === 0) return line;
  const expression = principalReferences.join(' 或 ');
  const normalizedLine = line.trim();
  const leadingOrMatch = normalizedLine.match(/^或\s*/u);
  const leadingOr = leadingOrMatch ? leadingOrMatch[0] : '';
  const conditionLine = leadingOr ? normalizedLine.slice(leadingOr.length).trimStart() : normalizedLine;
  const firstProcedureIndex = conditionLine.search(/(?:(?:主要|其他|全部)\s*)?手术\s*(?:或\s*)?操作\s*\d+/u);
  if (firstProcedureIndex >= 0 && /诊断/u.test(conditionLine.slice(0, firstProcedureIndex))) {
    const diagnosisPart = conditionLine.slice(0, firstProcedureIndex)
      .replace(/[+＋]\s*$/u, '')
      .trimEnd();
    const procedurePart = conditionLine.slice(firstProcedureIndex).trimStart();
    const result = `${diagnosisPart} + (${expression}) + ${procedurePart}`;
    return `${leadingOr}${result}`;
  }
  return `${leadingOr}(${expression}) + ${conditionLine}`;
}

function expandPrimaryProcedureQualifier(normalizedLine: string) {
  const qualifierReferences: string[] = [];
  const qualifierState: { hasQualifier: boolean; appliesToEveryCondition: boolean } = {
    hasQualifier: false,
    appliesToEveryCondition: false,
  };
  const withoutQualifiers = normalizedLine.replace(/[（(]([^（）()]*)[）)]/gu, (whole, content) => {
    const qualifierText = content.replace(/\s+/gu, ' ').trim();
    if (!PRIMARY_PROCEDURE_QUALIFIER_PATTERN.test(qualifierText)) return whole;
    qualifierState.hasQualifier = true;
    if (EVERY_CONDITION_PRIMARY_PROCEDURE_QUALIFIER_PATTERN.test(qualifierText)) {
      qualifierState.appliesToEveryCondition = true;
    }
    qualifierReferences.push(...extractProcedureSectionReferences(qualifierText));
    return '';
  }).replace(/\s+/gu, ' ').trim();

  if (!qualifierState.hasQualifier) return { line: normalizedLine, hasQualifier: false, appliesToEveryCondition: false };

  const conditionReferences = extractProcedureSectionReferences(withoutQualifiers);
  const references = [...new Set(qualifierReferences.length > 0 ? qualifierReferences : conditionReferences)];
  return {
    line: qualifierState.appliesToEveryCondition
      ? withoutQualifiers
      : appendPrincipalProcedureRequirement(withoutQualifiers, references),
    hasQualifier: qualifierState.hasQualifier,
    appliesToEveryCondition: qualifierState.appliesToEveryCondition,
  };
}

function expandPrimaryProcedureQualifiers(lines: string[]) {
  // Lines have already passed through normalizeRegionalRuleLine once.
  const appliesToEveryCondition = lines.some(line => (
    EVERY_CONDITION_PRIMARY_PROCEDURE_QUALIFIER_PATTERN.test(line)
  ));

  return lines.map(line => {
    if (!line.includes('入组条件')) return line;
    const expanded = expandPrimaryProcedureQualifier(line);
    if (!appliesToEveryCondition || (expanded.hasQualifier && !expanded.appliesToEveryCondition)) {
      return expanded.line;
    }
    return appendPrincipalProcedureRequirement(
      expanded.line,
      extractProcedureSectionReferences(expanded.line),
    );
  });
}

function normalizeQualifiedRuleReferences(line: string) {
  return line
    // PDF text extraction can split the two characters in “手术” across a
    // line, which otherwise changes the section label before tokenization.
    .replace(/手\s+术/gu, '手术')
    // “手术操作” and “手术或操作” are the same section label in the
    // source tables; use the canonical spelling used by the rule model.
    .replace(/手术\s*操作/gu, '手术或操作')
    // In the new table, position is written in parentheses after a generic
    // section label, e.g. “诊断 1（主要）”. The section header itself is
    // generic, so retain that base label and discard only the annotation.
    .replace(/(?:(主要|其他|全部)\s*)?(手术\s*(?:或\s*)?操作|诊断)\s*(\d+)\s*[（(]\s*(主要|其他|全部)\s*[）)]/gu, (_match, prefix, section, index, qualifier) => {
      const position = qualifier === '主要' || qualifier === '其他'
        ? qualifier
        : (prefix === '主要' || prefix === '其他' ? prefix : '');
      const normalizedSection = section.replace(/\s+/gu, ' ').trim();
      return `${position}${normalizedSection} ${index}`;
    })
    .replace(/全部\s*(?=手术\s*或\s*操作)/gu, '')
    .replace(/((?:主要|其他)\s*)?(手术\s*(?:或\s*)?操作|诊断)\s*(\d+)/gu, (_match, position = '', section, index) => {
      const normalizedPosition = position.replace(/\s+/gu, '').trim();
      const normalizedSection = section.replace(/\s+/gu, ' ').trim();
      return `${normalizedPosition}${normalizedSection} ${index}`;
    })
    .replace(/\s+/gu, ' ')
    .trim();
}

// Keep PDF-layout whitespace out of condition expressions.  PDF text layers
// may emit spaces before/after operators, around qualifiers, or between a
// section name and its position number.  These spaces are presentation only;
// canonicalizing them here keeps extracted source and generated `logic`
// stable across equivalent PDFs without changing the referenced sections.
function normalizeRuleConditionWhitespace(rawLine: string) {
  const line = rawLine.trim();
  if (!/^(?:\+|＋|&&?|\|\||(?:或)?入组条件)/u.test(line)) return line;

  let normalized = line.replace(/\s+/gu, ' ');
  normalized = normalized
    .replace(/^((?:或)?入组条件(?:\s*\d+)?[：:])\s*/u, '$1')
    // Keep one space on both sides of infix `+`; a leading `+` is the
    // continuation marker used by the source table, so it only gets a
    // trailing space after trimming the line boundary.
    .replace(/\s*([+＋])\s*/gu, ' + ')
    .replace(/^\s+\+/u, '+')
    .replace(/\s+([（(])/gu, '$1')
    .replace(/([（(])\s+/gu, '$1')
    .replace(/\s+([）)])/gu, '$1');

  return normalized.replace(
    /((?:(?:主要|其他|全部)\s*)?(?:诊断|手术\s*(?:或\s*)?操作|手术操作))\s*(\d+)/gu,
    (_match, section, index) => `${section.replace(/\s+/gu, ' ').trim()} ${index}`,
  );
}

function mergeRuleConditionContinuationLines(text: string) {
  const merged: string[] = [];
  const mergedInput = text.replace(
    /((?:诊断|手术\s*(?:或\s*)?操作)中(?:至少)?有?[0-9零〇一二两三四五六七八九十百]+)\s*\n\s*(个(?:及以上|以上)[：:])/gu,
    '$1$2',
  );
  for (const rawLine of mergedInput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const previous = merged.at(-1) ?? '';
    const isNewCondition = /^(?:或\s*)?入组条件\s*\d*/u.test(line);
    const isSectionHeader = /^(?:主要|其他|全部)?\s*(?:诊断|手术\s*(?:或\s*)?操作)\s*\d*\s*[：:]/u.test(line);
    const isCodeLine = isRegionalRuleCodeLine(line);
    const continuesCondition = /^(?:或\s*)?入组条件\s*\d*/u.test(previous)
      && !isNewCondition
      && !isSectionHeader
      && !isCodeLine;
    if (continuesCondition) merged[merged.length - 1] = `${previous} ${line}`;
    else merged.push(line);
  }
  return merged;
}

function findRegionalRuleTableReferences(line: string) {
  const definitions: { pattern: RegExp; section: (match: RegExpMatchArray) => string }[] = [
    {
      pattern: /主要\s*诊断\s*在\s*主\s*诊断\s*表\s*(\d+)?\s*中/g,
      section: match => formatRegionalRuleSection('主要诊断', match[1]),
    },
    {
      pattern: /(?:次要|次|其他)?\s*诊断\s*在\s*次\s*(?:要\s*)?诊断\s*表\s*(\d+)?\s*中/g,
      section: match => formatRegionalRuleSection('其他诊断', match[1]),
    },
    {
      pattern: /主要\s*手术(?:\s*或\s*操作)?\s*在\s*主\s*手术\s*表\s*(\d+)?\s*中/g,
      section: match => formatRegionalRuleSection('主要手术或操作', match[1]),
    },
    {
      pattern: /(?:次要|次|其他)?\s*手术(?:\s*或\s*操作)?\s*在\s*次\s*(?:要\s*)?手术\s*表\s*(\d+)?\s*中/g,
      section: match => formatRegionalRuleSection('其他手术或操作', match[1]),
    },
    {
      pattern: /(?:全部|全)\s*手术(?:\s*或\s*操作)?\s*在\s*全\s*(?:部\s*)?手术\s*表\s*(\d+)?\s*中/g,
      section: match => formatRegionalRuleSection('手术或操作', match[1]),
    },
  ];
  return definitions
    .flatMap(definition => [...line.matchAll(definition.pattern)].map(match => ({
      index: match.index,
      end: match.index + match[0].length,
      section: definition.section(match),
    })))
    .sort((left, right) => left.index - right.index);
}

function normalizeRegionalRuleLine(rawLine: string) {
  let line = rawLine
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+([：:])\s*/g, '$1');
  if (!line) return line;

  line = normalizeRuleConditionWhitespace(line);
  if (line.includes('入组条件')) {
    line = normalizeQualifiedRuleReferences(line);
    line = normalizeRuleConditionWhitespace(line);
  }

  const references = findRegionalRuleTableReferences(line);
  if (references.length > 1) {
    const expression = references.slice(1).reduce((result, reference, index) => {
      const previous = references[index]!;
      const between = line.slice(previous.end, reference.index);
      const operator = /或/.test(between) ? ' 或 ' : ' + ';
      return `${result}${operator}${reference.section}`;
    }, references[0]!.section);
    return normalizeRuleConditionWhitespace(`入组条件：${expression}`);
  }
  if (references.length === 1) return `${references[0]!.section}:`;

  const standaloneMappings: [RegExp, (match: RegExpMatchArray) => string][] = [
    [/^主(?:要)?\s*诊断\s*表\s*(\d+)?[：:]$/, match => `${formatRegionalRuleSection('主要诊断', match[1])}:`],
    [/^次\s*(?:要\s*)?诊断\s*表\s*(\d+)?[：:]$/, match => `${formatRegionalRuleSection('其他诊断', match[1])}:`],
    [/^主(?:要)?\s*手术\s*表\s*(\d+)?[：:]$/, match => `${formatRegionalRuleSection('主要手术或操作', match[1])}:`],
    [/^次\s*(?:要\s*)?手术\s*表\s*(\d+)?[：:]$/, match => `${formatRegionalRuleSection('其他手术或操作', match[1])}:`],
    [/^(?:全|全部)\s*手术\s*表\s*(\d+)?[：:]$/, match => `${formatRegionalRuleSection('手术或操作', match[1])}:`],
    [/^主\s*(?:要\s*)?诊断\s*(\d+)?[：:]$/, match => `${formatRegionalRuleSection('主要诊断', match[1])}:`],
    [/^次\s*(?:要\s*)?诊断\s*(\d+)?[：:]$/, match => `${formatRegionalRuleSection('其他诊断', match[1])}:`],
    [/^主\s*(?:要\s*)?手术(?:\s*或\s*操作)?\s*(\d+)?[：:]$/, match => `${formatRegionalRuleSection('主要手术或操作', match[1])}:`],
    [/^次\s*(?:要\s*)?手术(?:\s*或\s*操作)?\s*(\d+)?[：:]$/, match => `${formatRegionalRuleSection('其他手术或操作', match[1])}:`],
    [/^(?:全|全部)\s*手术\s*(\d+)?[：:]$/, match => `${formatRegionalRuleSection('手术或操作', match[1])}:`],
  ];
  for (const [pattern, replacement] of standaloneMappings) {
    const match = line.match(pattern);
    if (match) return replacement(match);
  }
  return line;
}

function normalizeRegionalRuleLines(text: string) {
  const normalizedLines = mergeRuleConditionContinuationLines(text)
    .map(normalizeRegionalRuleLine)
    .filter(Boolean);
  return expandPrimaryProcedureQualifiers(normalizedLines);
}

function inferRegionalSectionMinimumMatches(text: string) {
  const minimumMatches: Record<string, number> = {};
  const pattern = /(\d+)\s*个\s*(?:及以上|以上)\s*不重复的?(?:次要|次)?\s*诊断\s*在\s*次\s*(?:要\s*)?诊断\s*表\s*(\d+)?\s*中/g;
  for (const match of text.matchAll(pattern)) {
    const minimum = Number(match[1]!);
    if (!Number.isInteger(minimum) || minimum < 1) continue;
    const section = formatRegionalRuleSection('其他诊断', match[2]);
    minimumMatches[section] = minimum;
  }
  return minimumMatches;
}

function isRegionalRuleCodeLine(line: string | undefined) {
  return /^(?:[A-Z]\d{2}(?:[.\s]|$)|\d{2}\.)/i.test(line?.trim() ?? '');
}

function addImplicitRegionalRuleSections(lines: string[]) {
  const conditionIndex = lines.findIndex(line => /^入组条件[：:]/.test(line));
  if (conditionIndex < 0 || !isRegionalRuleCodeLine(lines[conditionIndex + 1])) return lines;

  const sections = [...lines[conditionIndex]!.matchAll(/(?:主要手术或操作|其他手术或操作|主要诊断|其他诊断|手术或操作)(?:\s+\d+)?/g)]
    .map(match => match[0])
    .filter((section, index, all) => all.indexOf(section) === index);
  if (sections.length === 0) return lines;

  const codeStart = conditionIndex + 1;
  let codeEnd = codeStart;
  while (codeEnd < lines.length && isRegionalRuleCodeLine(lines[codeEnd])) codeEnd += 1;
  const codeLines = lines.slice(codeStart, codeEnd);

  return [
    ...lines.slice(0, conditionIndex + 1),
    ...sections.flatMap(section => [`${section}:`, ...codeLines]),
    ...lines.slice(codeEnd),
  ];
}

function postParseCleanup(rules: ParsedRule) {
  rules.logic = rules.logic.trim();
  if (rules.requiredProcedureGroups?.length) {
    for (const sec of Object.keys(rules.sections)) {
      if (sec.includes('手术') || sec.includes('操作')) rules.sections[sec] = [];
    }
  }
}

function addReferencedSectionAliases(rules: ParsedRule) {
  const referencedSections = new Set(
    (rules.logic.match(/(?:主要诊断|其他诊断|主要手术或操作|其他手术或操作|手术或操作)\s+\d+/g) || []),
  );
  for (const sectionName of referencedSections) {
    if (rules.sections[sectionName]) continue;

    // The 3.0 table uses generic source sections such as “诊断 1”, while
    // the condition line qualifies each reference as principal/other. Keep
    // the same codes under a position-specific alias so the runtime matcher
    // can enforce that qualification without changing the source grouping.
    const genericName = sectionName.replace(/^(?:主要|其他)(?=(?:诊断|手术或操作)(?:\s|$))/u, '');
    if (rules.sections[genericName]) {
      rules.sectionAliases = rules.sectionAliases ?? {};
      rules.sectionAliases[sectionName] = genericName;
    } else {
      rules.sections[sectionName] = [];
    }
  }
}

function prepareExplicitSubgroupRuleContent(content: string) {
  const cleaned = content.replace(/\+重症监护(?:信息)?/g, '');
  return addImplicitRegionalRuleSections(normalizeRegionalRuleLines(cleaned)).join('\n');
}

/**
 * Parse a human-readable ADRG/MDC rule text block into a structured object.
 * - Extracts sections (diagnoses/procedures), builds a `logic` string,
 *   and pre-compiles the logic to RPN (via compileLogicToRPN).
 * @param {string} text
 * @returns Parsed sections and compiled logic, or the recorded compile error.
 */
function isSimultaneousProcedureGroupLine(line: string) {
  return line.startsWith('同时包含') && line.includes('手术或操作');
}

function isSeparatorLine(line: string) {
  return line === '和';
}

function isSectionDescriptorLine(line: string) {
  return /^(?:包含以下)?主要诊断或其他诊断$/.test(line);
}

function descriptorLineToLogic(line: string) {
  if (/^(?:包含以下)?主要诊断或其他诊断$/.test(line)) return '主要诊断或其他诊断';
  return '';
}

function parseRule(text: string, { alreadyNormalized = false } = {}) {
  const normalizedText = alreadyNormalized
    ? text
    : normalizeRegionalRuleLines(text).join('\n');
  const lines = normalizedText.split('\n').map(l => l.trim()).filter(Boolean);
  const rules: ParsedRule = { logic: '', sections: {} };
  detectSpecialCases(normalizedText, rules);
  parseSimultaneousProcedureGroups(normalizedText, rules);
  let currentSections: string[] = [];
  let skippingProcedureGroupBlock = false;
  for (const line of lines) {
    if (isSimultaneousProcedureGroupLine(line)) {
      skippingProcedureGroupBlock = true;
      continue;
    }
    if (skippingProcedureGroupBlock) {
      if (line.endsWith('：') || line.endsWith(':') || line.includes('入组条件')) {
        skippingProcedureGroupBlock = false;
      } else {
        continue;
      }
    }
    if (isSeparatorLine(line)) continue;
    if (isSectionDescriptorLine(line)) {
      const descriptorLogic = descriptorLineToLogic(line);
      if (descriptorLogic) rules.logic += (rules.logic ? ' ' : '') + descriptorLogic;
      continue;
    }
    if (line.includes('入组条件')) {
      let cleaned = line.replace(LOGIC_PATTERN, '');
      cleaned = cleaned.replace(/^或(?=\S)/, ' 或 ');
      rules.logic += (rules.logic ? ' ' : '') + cleaned;
      continue;
    }
    if (line.endsWith('：') || line.endsWith(':')) {
      const minimumOccurrenceHeader = parseMinimumOccurrenceSectionHeader(line);
      if (minimumOccurrenceHeader) {
        const { requiredSection, countedSection, minimum } = minimumOccurrenceHeader;
        currentSections = [...new Set([requiredSection, countedSection])];
        for (const section of currentSections) {
          if (!rules.sections[section]) rules.sections[section] = [];
        }
        const expression = `${requiredSection} + ${countedSection}`;
        rules.logic += (rules.logic ? ' + ' : '') + expression;
        rules.sectionMinimumOccurrences = {
          ...(rules.sectionMinimumOccurrences ?? {}),
          [countedSection]: minimum,
        };
      } else {
        const currentSection = normalizeSectionHeader(line);
        currentSections = [currentSection];
        if (!rules.sections[currentSection]) rules.sections[currentSection] = [];
      }
      continue;
    }
    // skip non-code descriptive lines such as "包含全部手术或操作"
    if (!/^[A-Za-z0-9]/.test(line)) continue;
    const codeMatch = line.match(CODE_PATTERN);
    if (!codeMatch || currentSections.length === 0) continue;
    for (const section of currentSections) rules.sections[section]!.push(codeMatch[1]!);
  }
  postParseCleanup(rules);
  addReferencedSectionAliases(rules);
  try { compileLogicToRPN(rules); } catch { /* compileLogicToRPN records errors on rule */ }
  return rules;
}

// --- Logic compilation / evaluation (public) ---
/**
 * Operator precedence & associativity used by the shunting-yard algorithm.
 */
const OPERATOR_PRECEDENCE: Record<string, number> = { '!': 3, '&&': 2, '||': 1 };
const RIGHT_ASSOC = new Set(['!']);

/**
 * Tokenize a logic expression string into SECTION tokens, boolean literals
 * and operators. Returns { tokens, error } where `error` is a string on
 * failure.
 */
function tokenizeLogic(expr: string, sortedSections: string[]) {
  const tokens: RpnToken[] = [];
  let i = 0;
  let error = null;

  while (i < expr.length) {
    const ch = expr.charAt(i);
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(' || ch === ')') { tokens.push(ch); i++; continue; }

    let matched = false;
    for (const sec of sortedSections) {
      const sectionPattern = sec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const sectionWithIndex = new RegExp(`^${sectionPattern}(?:\\s*\\d+)?`);
      const slice = expr.slice(i);
      const sectionMatch = slice.match(sectionWithIndex);
      if (sectionMatch) {
        tokens.push({ type: 'SECTION', name: sec });
        i += sectionMatch[0].length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // operators (including common CJK/english alternates)
    if (expr.startsWith('&&', i)) { tokens.push('&&'); i += 2; continue; }
    if (expr.startsWith('||', i)) { tokens.push('||'); i += 2; continue; }
    if (ch === '!') { tokens.push('!'); i++; continue; }

    if ('或∨|'.includes(ch)) { tokens.push('||'); i++; continue; }
    if ('和且并&'.includes(ch)) { tokens.push('&&'); i++; continue; }

    error = `Unable to tokenize at: ${expr.slice(i, i + 30)}`;
    break;
  }

  return { tokens, error };
}

function buildCompileSectionNames(rule: ParsedRule) {
  return [...new Set([
    ...Object.keys(rule.sections),
    ...Object.keys(rule.sectionAliases ?? {}),
  ])];
}

function shuntingYard(tokens: RpnToken[]) {
  const outQueue: RpnToken[] = [];
  const opStack: string[] = [];
  let error = null;

  for (const t of tokens) {
    if (typeof t === 'object') {
      outQueue.push(t);
    } else if (t === '&&' || t === '||' || t === '!') {
      while (opStack.length > 0) {
        const top = opStack[opStack.length - 1]!;
        if (top === '(') break;
        const topPrec = OPERATOR_PRECEDENCE[top] || 0;
        const tPrec = OPERATOR_PRECEDENCE[t] || 0;
        if ((RIGHT_ASSOC.has(t) && tPrec < topPrec) || (!RIGHT_ASSOC.has(t) && tPrec <= topPrec)) {
          outQueue.push(opStack.pop()!);
          continue;
        }
        break;
      }
      opStack.push(t);
    } else if (t === '(') {
      opStack.push(t);
    } else if (t === ')') {
      while (opStack.length > 0 && opStack[opStack.length - 1]! !== '(') {
        outQueue.push(opStack.pop()!);
      }
      if (opStack.length === 0 || opStack.pop()! !== '(') {
        error = 'Mismatched parentheses';
        break;
      }
    }
  }
  if (!error) {
    while (opStack.length > 0) {
      const operator = opStack.pop()!;
      if (operator === '(' || operator === ')') {
        error = 'Mismatched parentheses';
        break;
      }
      outQueue.push(operator);
    }
  }

  return { rpn: outQueue, error };
}

function validateRPN(rpn: RpnToken[]) {
  let stackDepth = 0;

  for (const token of rpn) {
    if (typeof token === 'object') {
      stackDepth += 1;
      continue;
    }
    if (token === '!') {
      if (stackDepth < 1) return 'Logic operator ! is missing an operand';
      continue;
    }
    if (token === '&&' || token === '||') {
      if (stackDepth < 2) return `Logic operator ${token} is missing an operand`;
      stackDepth -= 1;
      continue;
    }
    return `Unsupported RPN token: ${String(token)}`;
  }

  return stackDepth === 1
    ? null
    : `Logic expression must resolve to one value, got stack depth ${stackDepth}`;
}

function compileLogicToRPN(rule: ParsedRule) {
  // compile only once per-rule (undefined = not attempted yet)
  if (rule._logicRPN !== undefined) return;

  const sectionNames = buildCompileSectionNames(rule);
  const sortedSections = sectionNames.slice().sort((a, b) => b.length - a.length);

  const expr = rule.logic
    .replace(/\+/g, ' && ')
    .replace(/\s或\s/g, ' || ')
    .replace(/[＋]/g, '+')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')');

  const { tokens, error: tokenError } = tokenizeLogic(expr, sortedSections);
  if (tokenError) {
    rule._logicCompileError = tokenError;
    rule._logicRPN = null;
    return;
  }

  const { rpn, error: parseError } = shuntingYard(tokens);
  if (parseError) {
    rule._logicCompileError = parseError;
    rule._logicRPN = null;
    return;
  }

  if (tokens.length > 0) {
    const validationError = validateRPN(rpn);
    if (validationError) {
      rule._logicCompileError = validationError;
      rule._logicRPN = null;
      return;
    }
  }

  // success — store RPN and clear previous compile errors (if any)
  rule._logicRPN = rpn;
  rule._logicCompileError = null;
}

// `matchesRule` implementation moved to `src/services/GrouperEngine.ts` per request.
// `ruleParserCore` remains focused on parsing and low-level compilation/evaluation (compileLogicToRPN).

export {
  addImplicitRegionalRuleSections,
  inferRegionalSectionMinimumMatches,
  isRegionalRuleCodeLine,
  normalizeRegionalRuleLine,
  normalizeRegionalRuleLines,
  normalizeRuleConditionWhitespace,
  parseRule,
  prepareExplicitSubgroupRuleContent,
};
