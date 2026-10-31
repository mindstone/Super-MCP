const MAX_LEVENSHTEIN_DISTANCE = 3;
const MAX_SUGGESTION_NAME_LENGTH = 128;
const MAX_SUGGESTION_CANDIDATES = 128;

function canonicalize(name: string): string {
  return name.replace(/[-_]/g, "").toLowerCase();
}

function tokenize(name: string): Set<string> {
  return new Set(name
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase().split(/[-_]+/).filter(Boolean));
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const row = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    let previous = i - 1;
    row[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + substitutionCost,
      );
      previous = current;
    }
  }

  return row[b.length];
}

export function findBestMatch(unknownField: string, validFields: string[]): string | null {
  if (!unknownField || unknownField.length > MAX_SUGGESTION_NAME_LENGTH || validFields.length === 0) {
    return null;
  }

  const unknownTokens = tokenize(unknownField);
  let bestMatch: string | null = null;
  let bestRank = Infinity;
  let tied = false;

  // Canonical aliases share a match; sorting makes their representative stable.
  for (const field of validFields.slice(0, MAX_SUGGESTION_CANDIDATES).filter(name => name.length <= MAX_SUGGESTION_NAME_LENGTH).sort()) {
    const fieldTokens = tokenize(field);
    const distance = levenshtein(unknownField.toLowerCase(), field.toLowerCase());
    const shorterLength = Math.min(unknownField.length, field.length);
    let rank: number;
    if (canonicalize(unknownField) === canonicalize(field)) {
      rank = 0;
    } else if (distance === 1 && shorterLength >= 4) {
      rank = 1;
    } else if (unknownTokens.size > 0 && fieldTokens.size > 0 &&
      ([...unknownTokens].every((token) => fieldTokens.has(token)) ||
        [...fieldTokens].every((token) => unknownTokens.has(token)))) {
      rank = unknownTokens.size === fieldTokens.size ? 2 : 3;
    } else if ([...unknownTokens].some((token) => token !== "id" && token !== "ids" && fieldTokens.has(token))) {
      rank = 4;
    } else {
      if (distance > MAX_LEVENSHTEIN_DISTANCE || distance * 2 >= shorterLength) continue;
      rank = 5 + distance;
    }
    if (rank < bestRank) {
      bestRank = rank;
      bestMatch = field;
      tied = false;
    } else if (rank === bestRank && bestMatch !== null) {
      tied ||= canonicalize(field) !== canonicalize(bestMatch);
    }
  }

  return tied ? null : bestMatch;
}
