// Safe arithmetic/logic expression evaluator — no JavaScript `eval`.
//
// This is the engine behind the app's "generic expression" mode, giving Monday
// formula-like power but writing the result into a real (automation-usable)
// column. Column values are injected as variables written `{columnId}` (or
// `{relationColId->sourceColId}` for a value pulled through a connection).
//
// Supports: numbers, + - * / %, unary minus, parentheses, comparisons
// (< <= > >= == !=, yielding 1/0), and the functions
// min, max, round(x[,decimals]), floor, ceil, abs, if(cond, a, b).
//
// Hand-written recursive-descent parser so the only thing that can ever run is
// this small, known set of operations — never arbitrary user code.

const FUNCS = new Set(['min', 'max', 'round', 'floor', 'ceil', 'abs', 'if']);

export function evaluate(expression, vars = {}) {
  const parser = new Parser(tokenize(expression), vars);
  const value = parser.parseExpression();
  parser.expectEnd();
  return value;
}

// Pull the distinct {…} variable references out of an expression so the caller
// knows which columns to resolve before evaluating.
export function extractRefs(expression) {
  const refs = [];
  const re = /\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(expression)) !== null) refs.push(m[1].trim());
  return [...new Set(refs)];
}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const isDigit = (c) => c >= '0' && c <= '9';
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '{') {
      const end = src.indexOf('}', i);
      if (end === -1) throw new Error('unterminated { in expression');
      tokens.push({ type: 'var', value: src.slice(i + 1, end).trim() });
      i = end + 1; continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let j = i + 1;
      while (j < src.length && (isDigit(src[j]) || src[j] === '.')) j++;
      tokens.push({ type: 'num', value: Number(src.slice(i, j)) });
      i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ type: 'ident', value: src.slice(i, j) });
      i = j; continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '==', '!='].includes(two)) { tokens.push({ type: 'op', value: two }); i += 2; continue; }
    if ('+-*/%<>'.includes(c)) { tokens.push({ type: 'op', value: c }); i++; continue; }
    if (c === '(') { tokens.push({ type: 'lparen' }); i++; continue; }
    if (c === ')') { tokens.push({ type: 'rparen' }); i++; continue; }
    if (c === ',') { tokens.push({ type: 'comma' }); i++; continue; }
    throw new Error(`unexpected character "${c}" in expression`);
  }
  tokens.push({ type: 'end' });
  return tokens;
}

class Parser {
  constructor(tokens, vars) { this.t = tokens; this.i = 0; this.vars = vars; }
  peek() { return this.t[this.i]; }
  next() { return this.t[this.i++]; }
  expectEnd() { if (this.peek().type !== 'end') throw new Error('unexpected trailing tokens in expression'); }

  parseExpression() { return this.parseComparison(); }

  parseComparison() {
    const left = this.parseAdditive();
    const op = this.peek();
    if (op.type === 'op' && ['<', '<=', '>', '>=', '==', '!='].includes(op.value)) {
      this.next();
      const right = this.parseAdditive();
      switch (op.value) {
        case '<': return left < right ? 1 : 0;
        case '<=': return left <= right ? 1 : 0;
        case '>': return left > right ? 1 : 0;
        case '>=': return left >= right ? 1 : 0;
        case '==': return left === right ? 1 : 0;
        case '!=': return left !== right ? 1 : 0;
      }
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.peek().type === 'op' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.next().value;
      const right = this.parseMultiplicative();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    while (this.peek().type === 'op' && ['*', '/', '%'].includes(this.peek().value)) {
      const op = this.next().value;
      const right = this.parseUnary();
      left = op === '*' ? left * right : op === '/' ? left / right : left % right;
    }
    return left;
  }

  parseUnary() {
    const tok = this.peek();
    if (tok.type === 'op' && tok.value === '-') { this.next(); return -this.parseUnary(); }
    if (tok.type === 'op' && tok.value === '+') { this.next(); return this.parseUnary(); }
    return this.parsePrimary();
  }

  parsePrimary() {
    const tok = this.peek();
    if (tok.type === 'num') { this.next(); return tok.value; }
    if (tok.type === 'var') {
      this.next();
      if (!(tok.value in this.vars)) throw new Error(`unknown variable {${tok.value}}`);
      const v = coerceNumber(this.vars[tok.value]);
      if (!Number.isFinite(v)) throw new Error(`variable {${tok.value}} is not numeric (got "${this.vars[tok.value]}")`);
      return v;
    }
    if (tok.type === 'lparen') {
      this.next();
      const v = this.parseExpression();
      if (this.next().type !== 'rparen') throw new Error('missing )');
      return v;
    }
    if (tok.type === 'ident') {
      this.next();
      const name = tok.value.toLowerCase();
      if (!FUNCS.has(name)) throw new Error(`unknown function "${tok.value}"`);
      if (this.next().type !== 'lparen') throw new Error(`expected ( after ${name}`);
      const args = [];
      if (this.peek().type !== 'rparen') {
        args.push(this.parseExpression());
        while (this.peek().type === 'comma') { this.next(); args.push(this.parseExpression()); }
      }
      if (this.next().type !== 'rparen') throw new Error(`missing ) for ${name}`);
      return applyFunc(name, args);
    }
    throw new Error('unexpected token in expression');
  }
}

// Lenient numeric coercion for injected column values: a real number passes
// through; a formatted string like "1,000.00" / "₪1,234" / "12.5%" is stripped
// to its number; anything non-numeric becomes NaN (caller turns that into a
// clear error).
function coerceNumber(raw) {
  if (typeof raw === 'number') return raw;
  if (raw == null) return NaN;
  const cleaned = String(raw).replace(/[^\d.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return NaN;
  return Number(cleaned);
}

function applyFunc(name, args) {
  switch (name) {
    case 'min': return Math.min(...args);
    case 'max': return Math.max(...args);
    case 'abs': return Math.abs(args[0]);
    case 'floor': return Math.floor(args[0]);
    case 'ceil': return Math.ceil(args[0]);
    case 'round': {
      const d = args.length > 1 ? args[1] : 0;
      const f = 10 ** d;
      return Math.round(args[0] * f) / f;
    }
    case 'if': return args[0] !== 0 ? args[1] : args[2];
    default: throw new Error(`unhandled function ${name}`);
  }
}
