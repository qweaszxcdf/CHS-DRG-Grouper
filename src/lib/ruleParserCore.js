// Lightweight parsing core for ADRG/MDC rule text.
// Keeps parsing + logic-compilation in a single small module so build scripts
// can import it without pulling in UI/runtime helpers.

// Regex/constants used only by the parser
const CODE_PATTERN = /^([^\s：:]+)/;
const INCLUDE_PATTERN = /包含\s*([^\s：:]+(?:、[^\s：:]+)*)\s*的所有/;
const LOGIC_PATTERN = /入组条件\s*\d*[：:]?/g;
const CODE_EXTRACT_PATTERN = /^([^\s：:]+)/gm;

// --- Helper functions used by parseRule ---
function detectSpecialCases(text, rules) {
  if (text.match(/包含.*全部手术或操作/)) rules.anyProcedureRequired = true;
  if (text.includes('无手术或操作')) rules.zeroProceduresRequired = true;
  const includeMatch = text.match(INCLUDE_PATTERN);
  if (includeMatch) rules.referencedADRGs = includeMatch[1].split('、');
}

function parseSimultaneousProcedureGroups(text, rules) {
  const inlineMatch = text.match(/同时包含\s*([A-Z0-9]+(?:\s*和\s*[A-Z0-9]+)+)\s*的手术或操作[:：]?/);
  if (inlineMatch) {
    const codes = inlineMatch[1].match(/[A-Z0-9]+/g) || [];
    rules.referencedADRGs = codes;
    rules.requiredReferencedADRGs = codes;
    return;
  }

  const marker = '同时包含以下手术或操作';
  if (!text.includes(marker)) return;
  const start = text.indexOf(marker);
  let block = text.slice(start + marker.length).replace(/\r\n/g, '\n');
  const rawGroups = block.split(/\n\s*和\s*\n/);
  rules.requiredProcedureGroups = rawGroups.map(
    part => part.match(CODE_EXTRACT_PATTERN) || [],
  );
}

function normalizeSectionHeader(raw) {
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

function formatRegionalRuleSection(section, index = '') {
  return `${section}${index ? ` ${index}` : ''}`;
}

function findRegionalRuleTableReferences(line) {
  const definitions = [
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

function normalizeRegionalRuleLine(rawLine) {
  const line = String(rawLine || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+([：:])\s*/g, '$1');
  if (!line) return line;

  const references = findRegionalRuleTableReferences(line);
  if (references.length > 1) {
    const expression = references.slice(1).reduce((result, reference, index) => {
      const previous = references[index];
      const between = line.slice(previous.end, reference.index);
      const operator = /或/.test(between) ? ' 或 ' : ' + ';
      return `${result}${operator}${reference.section}`;
    }, references[0].section);
    return `入组条件：${expression}`;
  }
  if (references.length === 1) return `${references[0].section}:`;

  const standaloneMappings = [
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

function normalizeRegionalRuleLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(normalizeRegionalRuleLine)
    .filter(Boolean);
}

function inferRegionalSectionMinimumMatches(text) {
  const minimumMatches = {};
  const pattern = /(\d+)\s*个\s*(?:及以上|以上)\s*不重复的?(?:次要|次)?\s*诊断\s*在\s*次\s*(?:要\s*)?诊断\s*表\s*(\d+)?\s*中/g;
  for (const match of String(text || '').matchAll(pattern)) {
    const minimum = Number(match[1]);
    if (!Number.isInteger(minimum) || minimum < 1) continue;
    const section = formatRegionalRuleSection('其他诊断', match[2]);
    minimumMatches[section] = minimum;
  }
  return minimumMatches;
}

function isRegionalRuleCodeLine(line) {
  return /^(?:[A-Z]\d{2}(?:[.\s]|$)|\d{2}\.)/i.test(String(line || '').trim());
}

function addImplicitRegionalRuleSections(lines) {
  const conditionIndex = lines.findIndex(line => /^入组条件[：:]/.test(line));
  if (conditionIndex < 0 || !isRegionalRuleCodeLine(lines[conditionIndex + 1])) return lines;

  const sections = [...lines[conditionIndex].matchAll(/(?:主要手术或操作|其他手术或操作|主要诊断|其他诊断|手术或操作)(?:\s+\d+)?/g)]
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

function postParseCleanup(rules) {
  rules.logic = rules.logic.trim();
  if (Array.isArray(rules.requiredProcedureGroups) && rules.requiredProcedureGroups.length > 0) {
    for (const sec of Object.keys(rules.sections)) {
      if (sec.includes('手术') || sec.includes('操作')) rules.sections[sec] = [];
    }
  }
}

function prepareExplicitSubgroupRuleContent(content) {
  const cleaned = String(content || '').replace(/\+重症监护(?:信息)?/g, '');
  return addImplicitRegionalRuleSections(normalizeRegionalRuleLines(cleaned)).join('\n');
}

/**
 * Parse a human-readable ADRG/MDC rule text block into a structured object.
 * - Extracts sections (diagnoses/procedures), builds a `logic` string,
 *   and pre-compiles the logic to RPN (via compileLogicToRPN).
 * @param {string} text
 * @returns {{ logic: string, sections: Object, _logicRPN?: any, _logicCompileError?: string }}
 */
function isSimultaneousProcedureGroupLine(line) {
  return line.startsWith('同时包含') && line.includes('手术或操作');
}

function isSeparatorLine(line) {
  return line === '和';
}

function isSectionDescriptorLine(line) {
  return /^(?:包含以下)?主要诊断或其他诊断$/.test(line);
}

function descriptorLineToLogic(line) {
  if (/^(?:包含以下)?主要诊断或其他诊断$/.test(line)) return '主要诊断或其他诊断';
  return '';
}

function parseRule(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const rules = { logic: '', sections: {} };
  detectSpecialCases(text, rules);
  parseSimultaneousProcedureGroups(text, rules);
  let currentSection = null;
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
      currentSection = normalizeSectionHeader(line);
      if (!rules.sections[currentSection]) rules.sections[currentSection] = [];
      continue;
    }
    // skip non-code descriptive lines such as "包含全部手术或操作"
    if (!/^[A-Za-z0-9]/.test(line)) continue;
    rules.sections[currentSection].push(line.match(CODE_PATTERN)[1]);
  }
  postParseCleanup(rules);
  const referencedSections = new Set((String(rules.logic || '').match(/(?:主要诊断|其他诊断|主要手术或操作|其他手术或操作|手术或操作)\s+\d+/g) || []));
  for (const sec of referencedSections) {
    if (!rules.sections[sec]) rules.sections[sec] = [];
  }
  try { compileLogicToRPN(rules); } catch { /* compileLogicToRPN records errors on rule */ }
  return rules;
}

// --- Logic compilation / evaluation (public) ---
/**
 * Operator precedence & associativity used by the shunting-yard algorithm.
 */
const OPERATOR_PRECEDENCE = { '!': 3, '&&': 2, '||': 1 };
const RIGHT_ASSOC = new Set(['!']);

/**
 * Tokenize a logic expression string into SECTION tokens, boolean literals
 * and operators. Returns { tokens, error } where `error` is a string on
 * failure.
 */
function tokenizeLogic(expr, sortedSections) {
  const tokens = [];
  let i = 0;
  let error = null;

  while (i < expr.length) {
    if (/\s/.test(expr[i])) { i++; continue; }
    if (expr[i] === '(' || expr[i] === ')') { tokens.push(expr[i]); i++; continue; }

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
    if (expr[i] === '!') { tokens.push('!'); i++; continue; }

    const ch = expr[i];
    if ('或∨|'.includes(ch)) { tokens.push('||'); i++; continue; }
    if ('和且并&'.includes(ch)) { tokens.push('&&'); i++; continue; }

    error = `Unable to tokenize at: ${expr.slice(i, i + 30)}`;
    break;
  }

  return { tokens, error };
}

function buildCompileSectionNames(rule) {
  return Object.keys(rule.sections || {});
}

function shuntingYard(tokens) {
  const outQueue = [];
  const opStack = [];
  let error = null;

  for (const t of tokens) {
    if (typeof t === 'object' && t.type === 'SECTION') {
      outQueue.push(t);
    } else if (t === '&&' || t === '||' || t === '!') {
      while (opStack.length > 0) {
        const top = opStack[opStack.length - 1];
        if (top === '(') break;
        const topPrec = OPERATOR_PRECEDENCE[top] || 0;
        const tPrec = OPERATOR_PRECEDENCE[t] || 0;
        if ((RIGHT_ASSOC.has(t) && tPrec < topPrec) || (!RIGHT_ASSOC.has(t) && tPrec <= topPrec)) {
          outQueue.push(opStack.pop());
          continue;
        }
        break;
      }
      opStack.push(t);
    } else if (t === '(') {
      opStack.push(t);
    } else if (t === ')') {
      while (opStack.length > 0 && opStack[opStack.length - 1] !== '(') {
        outQueue.push(opStack.pop());
      }
      if (opStack.length === 0 || opStack.pop() !== '(') {
        error = 'Mismatched parentheses';
        break;
      }
    }
  }
  if (!error) {
    while (opStack.length > 0) {
      const operator = opStack.pop();
      if (operator === '(' || operator === ')') {
        error = 'Mismatched parentheses';
        break;
      }
      outQueue.push(operator);
    }
  }

  return { rpn: outQueue, error };
}

function validateRPN(rpn) {
  let stackDepth = 0;

  for (const token of rpn) {
    if (typeof token === 'object' && token?.type === 'SECTION') {
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

function compileLogicToRPN(rule) {
  // compile only once per-rule (undefined = not attempted yet)
  if (rule._logicRPN !== undefined) return;

  // basic validation of the rule shape to avoid runtime throws
  if (!rule || typeof rule.logic !== 'string' || !rule.sections || typeof rule.sections !== 'object') {
    rule._logicCompileError = 'Invalid rule: missing `logic` string or `sections` object';
    rule._logicRPN = null;
    return;
  }

  const sectionNames = buildCompileSectionNames(rule);
  const sortedSections = sectionNames.slice().sort((a, b) => b.length - a.length);

  let expr = String(rule.logic || '')
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

// `matchesRule` implementation moved to `src/services/GrouperEngine.js` per request.
// `ruleParserCore` remains focused on parsing and low-level compilation/evaluation (compileLogicToRPN).

export {
  addImplicitRegionalRuleSections,
  inferRegionalSectionMinimumMatches,
  isRegionalRuleCodeLine,
  normalizeRegionalRuleLine,
  normalizeRegionalRuleLines,
  parseRule,
  prepareExplicitSubgroupRuleContent,
};
