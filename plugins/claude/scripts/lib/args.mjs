export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const repeatableOptions = new Set(config.repeatableOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  const setValue = (key, value) => {
    if (repeatableOptions.has(key)) {
      options[key] = [...(options[key] ?? []), value];
    } else {
      options[key] = value;
    }
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (passthrough || !token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      passthrough = true;
      continue;
    }

    const isLong = token.startsWith("--");
    const body = token.slice(isLong ? 2 : 1);
    const [rawKey, inlineValue] = isLong ? body.split(/=(.*)/s, 2) : [body, undefined];
    const key = aliasMap[rawKey] ?? rawKey;

    if (booleanOptions.has(key)) {
      options[key] = inlineValue === undefined ? true : inlineValue !== "false";
      continue;
    }
    if (valueOptions.has(key) || repeatableOptions.has(key)) {
      const nextValue = inlineValue ?? argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for ${isLong ? "--" : "-"}${rawKey}`);
      }
      setValue(key, nextValue);
      if (inlineValue === undefined) index += 1;
      continue;
    }
    positionals.push(token);
  }

  return { options, positionals };
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;
  let hasToken = false;
  const chars = [...String(raw ?? "")];

  for (let index = 0; index < chars.length; index += 1) {
    const character = chars[index];
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    // A backslash escapes only quotes, backslashes, and whitespace, so Windows
    // paths such as C:\Program Files\node.exe pass through untouched.
    if (character === "\\" && quote !== "'" && /["'\\\s]/.test(chars[index + 1] ?? "")) {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      hasToken = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (current || hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += character;
    hasToken = true;
  }
  if (escaping) current += "\\";
  if (current || hasToken) tokens.push(current);
  return tokens;
}

export function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) return [];
    return splitRawArgumentString(raw);
  }
  return argv;
}
