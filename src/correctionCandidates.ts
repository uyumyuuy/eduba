import candidateData from "./assets/scan-candidate-character-confusions.json";

type CandidateEntry = {
  gt_candidates: Array<{ gt_character: string; count: number }>;
};

type CandidateData = {
  output_to_gt: Record<string, CandidateEntry>;
};

const outputToGt = (candidateData as CandidateData).output_to_gt;

/**
 * Converts the ASCII transliteration notation accepted by the original review
 * application.  Keep replacement order in sync with convert.js: some rules
 * intentionally consume multi-character notation after a broader replacement.
 */
export function convert(text: string): string {
  return text
    .replace(/c/g, "š")
    .replace(/C/g, "Š")
    .replace(/sz/g, "š")
    .replace(/SZ/g, "Š")
    .replace(/s,/g, "ṣ")
    .replace(/S,/g, "Ṣ")
    .replace(/t,/g, "ṭ")
    .replace(/T,/g, "Ṭ")
    .replace(/t_/g, "ṯ")
    .replace(/T_/g, "Ṯ")
    .replace(/k,/g, "ḳ")
    .replace(/K,/g, "Ḳ")
    .replace(/\[\[/g, "⸢")
    .replace(/\]\]/g, "⸣")
    .replace(/j/g, "ŋ")
    .replace(/J/g, "Ŋ")
    .replace(/g~/g, "g̃")
    .replace(/G~/g, "G̃")
    .replace(/g\^/g, "ĝ")
    .replace(/G\^/g, "Ĝ")
    .replace(/h,/g, "ḥ")
    .replace(/h/g, "ḫ")
    .replace(/H/g, "Ḫ")
    .replace(/a\^/g, "â")
    .replace(/i\^/g, "î")
    .replace(/u\^/g, "û")
    .replace(/e\^/g, "ê")
    .replace(/o\^/g, "ô")
    .replace(/A\^/g, "Â")
    .replace(/I\^/g, "Î")
    .replace(/U\^/g, "Û")
    .replace(/E\^/g, "Ê")
    .replace(/O\^/g, "Ô")
    .replace(/a~/g, "ā")
    .replace(/i~/g, "ī")
    .replace(/u~/g, "ū")
    .replace(/e~/g, "ē")
    .replace(/o~/g, "ō")
    .replace(/A~/g, "Ā")
    .replace(/I~/g, "Ī")
    .replace(/U~/g, "Ū")
    .replace(/E~/g, "Ē")
    .replace(/O~/g, "Ō")
    .replace(/'/g, "ʿ")
    .replace(/`/g, "ʾ");
}

function toSubscript(text: string): string {
  return text
    .replace(/0/g, "₀").replace(/1/g, "₁").replace(/2/g, "₂")
    .replace(/3/g, "₃").replace(/4/g, "₄").replace(/5/g, "₅")
    .replace(/6/g, "₆").replace(/7/g, "₇").replace(/8/g, "₈")
    .replace(/9/g, "₉").replace(/x/g, "ₓ");
}

function indexToAccent(word: string): string {
  const match = word.match(/^([^0-9]+)([0-9x]+)$/);
  if (!match) return word;

  const number = Number(match[2]);
  if (number === 2 || number === 3) {
    const accents: Record<string, [string, string, string]> = {
      a: ["a", "á", "à"], i: ["i", "í", "ì"], u: ["u", "ú", "ù"], e: ["e", "é", "è"],
      A: ["A", "Á", "À"], I: ["I", "Í", "Ì"], U: ["U", "Ú", "Ù"], E: ["E", "É", "È"],
    };
    return match[1].replace(/[aiueAIUE]/, character => accents[character][number - 1]);
  }
  return match[1] + toSubscript(match[2]);
}

/** Matches convert_index_to_accent() from the bundled legacy convert.js. */
export function convertIndexToAccent(text: string): string {
  return text.split(/([{}.\- ])/).map(indexToAccent).join("");
}

function graphemes(text: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)]
      .map(segment => segment.segment);
  }
  return Array.from(text);
}

/**
 * Returns correction candidates without depending on UI state or the network.
 * A multi-grapheme selection is only offered its whole-string transliteration.
 */
export function candidatesForSelection(selection: string): string[] {
  const candidates: string[] = [];
  const converted = convertIndexToAccent(convert(selection));

  if (converted !== selection) candidates.push(converted);
  if (graphemes(selection).length !== 1) return candidates;

  const rankedCandidates = (outputToGt[selection]?.gt_candidates ?? [])
    .map((candidate, index) => ({ ...candidate, index }))
    .sort((a, b) => b.count - a.count || a.index - b.index);

  for (const { gt_character } of rankedCandidates) {
    if (gt_character !== selection && !candidates.includes(gt_character)) {
      candidates.push(gt_character);
    }
  }
  return candidates;
}
