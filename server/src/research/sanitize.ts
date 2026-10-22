// Shared cleaning for untrusted parent-supplied text.

// Whitespace controls become a space so words do not run together.
const WHITESPACE_CONTROLS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
// Other C0/C1 controls, soft hyphen, combining grapheme joiner, Mongolian vowel
// separator, zero-width / bidi / invisible formatting characters, variation
// selectors and Unicode tag characters are removed.
const STRIPPED_CHARS = new RegExp(
  "[\\u0000-\\u0008\\u000e-\\u001f\\u007f-\\u009f\\u00ad\\u034f\\u180e" +
    "\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff" +
    "\\ufe00-\\ufe0f]|[\\u{e0000}-\\u{e007f}\\u{e0100}-\\u{e01ef}]",
  "gu",
);
// Characters a delimiter could be built from, ASCII or look-alike.
const BRACKET_CHARS = /[`<>\u00ab\u00bb\u2039\u203a\u226a\u226b]/g;
const DELIMITER_TOKEN = /PARENT_NOTES/gi;

export interface CleanOptions {
  /** Also remove backticks, angle-bracket look-alikes and the delimiter token. */
  neutralizeDelimiters?: boolean;
}

export function cleanUntrustedText(raw: string, maxLength: number, options: CleanOptions = {}): string {
  let text = raw
    .normalize("NFKC")
    .replace(WHITESPACE_CONTROLS, " ")
    .replace(STRIPPED_CHARS, "");
  if (options.neutralizeDelimiters) {
    text = text.replace(BRACKET_CHARS, "");
    // Removal can splice a new token together, so repeat until stable.
    for (let prev = ""; prev !== text; ) {
      prev = text;
      text = text.replace(DELIMITER_TOKEN, "");
    }
  }
  text = text.replace(/ {2,}/g, " ").trim();
  // Cap by code point so a surrogate pair is never split.
  return Array.from(text).slice(0, maxLength).join("").trim();
}
