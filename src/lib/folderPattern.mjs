// Parses wing `folderPattern` strings into a matcher, builds section titles
// from `sectionTitle` templates, and compares sections per `sectionSort`.
//
// Tokens look like {name} or {date:FORMAT}. Literal text between/around
// tokens (like " at " or " - ") must appear in folder names exactly.

const DATE_FORMATS = {
  "YYYY-MM-DD": { regex: "\\d{4}-\\d{2}-\\d{2}", precision: "day" },
  "YYYY-MM": { regex: "\\d{4}-\\d{2}", precision: "month" },
  "YYYY": { regex: "\\d{4}", precision: "year" },
};

const TOKEN_RE = /\{([a-zA-Z_]+)(?::([^}]+))?\}/g;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split a pattern into alternating literal/token parts.
 * Returns { parts, tokens, errors } where parts is an ordered list of
 * { type: 'literal', text } | { type: 'token', name, isDate, dateFormat }.
 */
export function parsePattern(pattern) {
  const errors = [];
  const parts = [];
  const tokens = [];
  let lastIndex = 0;
  let match;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(pattern)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "literal", text: pattern.slice(lastIndex, match.index) });
    }
    const [, name, format] = match;
    const isDate = name === "date";
    if (isDate) {
      if (!format || !DATE_FORMATS[format]) {
        errors.push(
          `token "{${name}${format ? ":" + format : ""}}" — date tokens must specify a format of YYYY-MM-DD, YYYY-MM, or YYYY`
        );
      }
    } else if (format) {
      errors.push(`token "{${name}:${format}}" — only the "date" token may specify a :FORMAT`);
    }
    const token = { name, isDate, dateFormat: isDate ? format : undefined };
    parts.push({ type: "token", ...token });
    tokens.push(token);
    lastIndex = TOKEN_RE.lastIndex;
  }
  if (lastIndex < pattern.length) {
    parts.push({ type: "literal", text: pattern.slice(lastIndex) });
  }

  if (tokens.length === 0) {
    errors.push("pattern contains no {tokens} at all");
  }

  // duplicate token names
  const seen = new Set();
  for (const t of tokens) {
    if (seen.has(t.name)) errors.push(`token "{${t.name}}" is used more than once`);
    seen.add(t.name);
  }

  // adjacent tokens need a literal separator, unless one of them is the date
  // token (digits are unambiguous against free text)
  for (let i = 0; i < parts.length - 1; i++) {
    const a = parts[i];
    const b = parts[i + 1];
    if (a.type === "token" && b.type === "token" && !a.isDate && !b.isDate) {
      errors.push(
        `tokens "{${a.name}}" and "{${b.name}}" are adjacent with no literal separator between them`
      );
    }
  }

  return { parts, tokens, errors };
}

/** Build a matcher from a validated pattern's parts. */
export function compilePattern(parts) {
  let re = "^";
  for (const part of parts) {
    if (part.type === "literal") {
      re += escapeRegex(part.text);
    } else if (part.isDate) {
      re += `(?<${part.name}>${DATE_FORMATS[part.dateFormat].regex})`;
    } else {
      re += `(?<${part.name}>.+?)`;
    }
  }
  re += "$";
  return new RegExp(re);
}

function parseDateValue(raw, format) {
  const precision = DATE_FORMATS[format].precision;
  const [y, m, d] = raw.split("-").map((n) => parseInt(n, 10));
  const year = y;
  const month = precision === "year" ? 1 : m;
  const day = precision === "day" ? d : 1;
  return {
    precision,
    year,
    month,
    day,
    sortValue: Date.UTC(year, (month || 1) - 1, day || 1),
  };
}

/**
 * Match a folder name against a compiled pattern.
 * Returns null if it doesn't match, otherwise { values: {name: raw},
 * dates: {name: {precision,year,month,day,sortValue}} }.
 */
export function matchFolderName(pattern, folderName) {
  const { parts, errors } = parsePattern(pattern);
  if (errors.length) return null;
  const regex = compilePattern(parts);
  const m = regex.exec(folderName);
  if (!m || !m.groups) return null;
  const values = {};
  const dates = {};
  for (const part of parts) {
    if (part.type !== "token") continue;
    const raw = m.groups[part.name];
    values[part.name] = raw;
    if (part.isDate) dates[part.name] = parseDateValue(raw, part.dateFormat);
  }
  return { values, dates };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function formatDate(dateVal, format) {
  const { year, month, day } = dateVal;
  switch (format) {
    case "MMMM D, YYYY":
      return `${MONTH_NAMES[(month || 1) - 1]} ${day}, ${year}`;
    case "MMMM YYYY":
      return `${MONTH_NAMES[(month || 1) - 1]} ${year}`;
    case "YYYY":
      return `${year}`;
    default:
      return `${MONTH_NAMES[(month || 1) - 1]} ${day}, ${year}`;
  }
}

const TITLE_TOKEN_RE = /\{([a-zA-Z_]+)(?::([^}]+))?\}/g;

/** Build a display title from a sectionTitle template + matched values. */
export function buildSectionTitle(template, matched) {
  return template.replace(TITLE_TOKEN_RE, (_, name, format) => {
    if (name === "date" && matched.dates.date) {
      return formatDate(matched.dates.date, format || "MMMM D, YYYY");
    }
    return matched.values[name] ?? `{${name}}`;
  });
}

/** Human-readable "Sectioned by X and Y" derived from a folderPattern's tokens. */
export function describeSectioning(tokens) {
  const names = tokens.map((t) => (t.name === "date" ? "Date" : t.name[0].toUpperCase() + t.name.slice(1)));
  if (names.length === 0) return "Sectioned";
  if (names.length === 1) return `Sectioned by ${names[0]}`;
  return `Sectioned by ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Extract the token names referenced by a template string (sectionTitle or sectionSort). */
export function referencedTokens(template) {
  const names = new Set();
  let m;
  const re = /\{([a-zA-Z_]+)(?::[^}]+)?\}/g;
  while ((m = re.exec(template)) !== null) names.add(m[1]);
  return names;
}

/** Parse a sectionSort string like "{date} desc" into { token, direction }. */
export function parseSectionSort(sortStr) {
  const m = /^\{([a-zA-Z_]+)\}\s+(asc|desc)$/.exec((sortStr || "").trim());
  if (!m) return null;
  return { token: m[1], direction: m[2] };
}

/**
 * Compare two sections for sectionSort ordering.
 * Each section is { matched: {values, dates} | null, title: string }.
 * Unparsed folders (matched === null) sort last; ties fall back to
 * alphabetical by title.
 */
export function compareSections(a, b, sortSpec) {
  const aParsed = a.matched !== null;
  const bParsed = b.matched !== null;
  if (aParsed !== bParsed) return aParsed ? -1 : 1;

  if (aParsed && bParsed && sortSpec) {
    const { token, direction } = sortSpec;
    const dir = direction === "asc" ? 1 : -1;
    const aDate = a.matched.dates[token];
    const bDate = b.matched.dates[token];
    if (aDate && bDate) {
      if (aDate.sortValue !== bDate.sortValue) return (aDate.sortValue - bDate.sortValue) * dir;
    } else {
      const aVal = a.matched.values[token] ?? "";
      const bVal = b.matched.values[token] ?? "";
      const cmp = aVal.localeCompare(bVal, undefined, { sensitivity: "base" });
      if (cmp !== 0) return cmp * dir;
    }
  }

  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
}
