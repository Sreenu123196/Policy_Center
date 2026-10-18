// Availability rules in product files are small text expressions, for example
//   vehicle.ageYears <= 5          ownerType == 'individual'          not (a == 1 or b == 2)
// (document section 7). They are NOT run as code. A tokenizer cuts the text into pieces and a parser builds a small
// tree that only knows comparisons, and / or / not and brackets. Nothing else can ever be expressed or executed,
// so a product file cannot do harm, however it is written.

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionError';
  }
}

type Comparator = '==' | '!=' | '<' | '<=' | '>' | '>=';
type Operand = { kind: 'path'; path: string[] } | { kind: 'literal'; value: number | string | boolean };

export type Expression =
  | { kind: 'compare'; left: Operand; op: Comparator; right: Operand }
  | { kind: 'operand'; operand: Operand }
  | { kind: 'and' | 'or'; left: Expression; right: Expression }
  | { kind: 'not'; operand: Expression };

interface Token {
  type: 'number' | 'text' | 'word' | 'comparator' | 'open' | 'close';
  text: string;
  position: number;
}

const NUMBER = /\d+(?:\.\d+)?/y;
const WORD = /[A-Za-z_][A-Za-z0-9_.]*/y;
const COMPARATORS = ['==', '!=', '<=', '>=', '<', '>'];

// Step 1: cut the text into tokens, remembering where each one starts so errors can point at it.
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text.charAt(i);
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (char === '(' || char === ')') {
      tokens.push({ type: char === '(' ? 'open' : 'close', text: char, position: i });
      i++;
      continue;
    }
    if (char === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) throw new ExpressionError(`Unterminated text starting at position ${i}`);
      tokens.push({ type: 'text', text: text.slice(i + 1, end), position: i });
      i = end + 1;
      continue;
    }
    const comparator = COMPARATORS.find((c) => text.startsWith(c, i));
    if (comparator) {
      tokens.push({ type: 'comparator', text: comparator, position: i });
      i += comparator.length;
      continue;
    }
    NUMBER.lastIndex = i;
    const number = NUMBER.exec(text);
    if (number) {
      tokens.push({ type: 'number', text: number[0], position: i });
      i += number[0].length;
      continue;
    }
    WORD.lastIndex = i;
    const word = WORD.exec(text);
    if (word) {
      tokens.push({ type: 'word', text: word[0], position: i });
      i += word[0].length;
      continue;
    }
    throw new ExpressionError(`Unexpected character "${char}" at position ${i}`);
  }
  return tokens;
}

// Step 2: build the tree. Each function below handles one level of binding, loosest first: or, then and, then not.
export function parseExpression(text: string): Expression {
  const tokens = tokenize(text);
  if (tokens.length === 0) throw new ExpressionError('The expression is empty');

  let next = 0;
  const peek = (): Token | undefined => tokens[next];
  const isWord = (token: Token | undefined, word: string): boolean => token?.type === 'word' && token.text === word;
  const end = 'but reached the end of the expression';

  function parseOr(): Expression {
    let left = parseAnd();
    while (isWord(peek(), 'or')) {
      next++;
      left = { kind: 'or', left, right: parseAnd() };
    }
    return left;
  }

  function parseAnd(): Expression {
    let left = parseNot();
    while (isWord(peek(), 'and')) {
      next++;
      left = { kind: 'and', left, right: parseNot() };
    }
    return left;
  }

  function parseNot(): Expression {
    if (isWord(peek(), 'not')) {
      next++;
      return { kind: 'not', operand: parseNot() };
    }
    return parseAtom();
  }

  function parseAtom(): Expression {
    if (peek()?.type === 'open') {
      next++;
      const inside = parseOr();
      const close = peek();
      if (close?.type !== 'close') throw new ExpressionError(`Missing bracket: expected ")" ${close ? `at position ${close.position}` : end}`);
      next++;
      return inside;
    }
    const left = parseOperand('an expression');
    const op = peek();
    if (op?.type === 'comparator') {
      next++;
      return { kind: 'compare', left, op: op.text as Comparator, right: parseOperand(`a value after "${op.text}"`) };
    }
    return { kind: 'operand', operand: left };
  }

  function parseOperand(what: string): Operand {
    const token = peek();
    if (!token) throw new ExpressionError(`Expected ${what.startsWith('a value') ? what : 'a value'} ${end}`);
    next++;
    if (token.type === 'number') return { kind: 'literal', value: Number(token.text) };
    if (token.type === 'text') return { kind: 'literal', value: token.text };
    if (token.type === 'word') {
      if (token.text === 'true' || token.text === 'false') return { kind: 'literal', value: token.text === 'true' };
      if (['and', 'or', 'not'].includes(token.text)) throw new ExpressionError(`Expected a value but found "${token.text}" at position ${token.position}`);
      const path = token.text.split('.');
      if (path.some((part) => part === '')) throw new ExpressionError(`"${token.text}" at position ${token.position} is not a valid fact name`);
      return { kind: 'path', path };
    }
    throw new ExpressionError(`Expected a value but found "${token.text}" at position ${token.position}`);
  }

  const expression = parseOr();
  const extra = peek();
  if (extra) throw new ExpressionError(`Unexpected "${extra.text}" at position ${extra.position}`);
  return expression;
}

type Facts = Record<string, unknown>;

// Looks a fact up by its dotted path. Only the data we were given is followed (Object.hasOwn), never anything
// built into JavaScript, so a path such as "constructor" simply finds nothing.
function lookup(path: string[], facts: Facts): unknown {
  let current: unknown = facts;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

const valueOf = (operand: Operand, facts: Facts): unknown => (operand.kind === 'literal' ? operand.value : lookup(operand.path, facts));

// Step 3: evaluate the tree against the facts. A comparison with a fact that is missing, or of the wrong kind,
// is false, so an unknown fact never makes a cover available by accident.
export function evaluateExpression(expression: Expression, facts: Facts): boolean {
  switch (expression.kind) {
    case 'and':
      return evaluateExpression(expression.left, facts) && evaluateExpression(expression.right, facts);
    case 'or':
      return evaluateExpression(expression.left, facts) || evaluateExpression(expression.right, facts);
    case 'not':
      return !evaluateExpression(expression.operand, facts);
    case 'operand':
      return valueOf(expression.operand, facts) === true;
    case 'compare': {
      const left = valueOf(expression.left, facts);
      const right = valueOf(expression.right, facts);
      if (left === undefined || right === undefined) return false;
      if (expression.op === '==') return left === right;
      if (expression.op === '!=') return left !== right;
      const comparable = (typeof left === 'number' && typeof right === 'number') || (typeof left === 'string' && typeof right === 'string');
      if (!comparable) return false;
      const a = left as number | string;
      const b = right as number | string;
      if (expression.op === '<') return a < b;
      if (expression.op === '<=') return a <= b;
      if (expression.op === '>') return a > b;
      return a >= b;
    }
  }
}
