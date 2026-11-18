'use strict';

// Width-aware line building for the terminal UI. A line is a list of segments
// ({ text, paint }); painting happens after clipping so ANSI codes never count
// toward the width.

const plain = (t) => t;

// C0/C1 controls (ESC, OSC, BEL, ...) and bidi overrides. Text comes from GitHub
// (PR titles, check names, commit messages), so it must never reach the
// terminal as escape sequences.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const WHITESPACE_CONTROLS = /[\r\n\t]+/g;
const WIDE_CHAR = /[\p{Emoji_Presentation}ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;
const ZERO_WIDTH_CHAR = /[​-‍︀-️]/u;

function sanitize(text) {
  return String(text ?? '')
    .replace(WHITESPACE_CONTROLS, ' ')
    .replace(UNSAFE_CHARS, '');
}

const seg = (text, paint = plain) => ({ text: sanitize(text), paint });

function charWidth(char) {
  if (ZERO_WIDTH_CHAR.test(char)) return 0;
  return WIDE_CHAR.test(char) ? 2 : 1;
}

function displayWidth(text) {
  return [...text].reduce((sum, char) => sum + charWidth(char), 0);
}

// Cuts text to at most `width` columns, ending in … when anything was cut.
function clip(text, width) {
  if (displayWidth(text) <= width) return text;
  let used = 0;
  let out = '';
  for (const char of text) {
    const w = charWidth(char);
    if (used + w > width - 1) break;
    out += char;
    used += w;
  }
  return `${out}…`;
}

function renderLine(segments, width) {
  let remaining = width;
  let out = '';
  for (const { text, paint } of segments) {
    if (remaining <= 0) break;
    const shown = clip(text, remaining);
    out += paint(shown);
    remaining -= displayWidth(shown);
  }
  return out;
}

// Flows segments ("chips") onto as many indented lines as the width needs.
function wrapChips(chips, width, indent, gap = '  ') {
  return chips.reduce(
    (lines, chip) => {
      const current = lines[lines.length - 1];
      const used = current.reduce((sum, s) => sum + displayWidth(s.text), 0);
      const isEmpty = current.length === 1;
      if (!isEmpty && used + gap.length + displayWidth(chip.text) > width) return [...lines, [seg(indent), chip]];
      return [...lines.slice(0, -1), [...current, ...(isEmpty ? [] : [seg(gap)]), chip]];
    },
    [[seg(indent)]],
  );
}

function wrapText(text, width, paint = plain) {
  return wrapChips(
    sanitize(text)
      .split(' ')
      .map((word) => seg(word, paint)),
    width,
    '',
    ' ',
  );
}

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

function age(isoDate, now = Date.now()) {
  const seconds = Math.max(0, (now - Date.parse(isoDate)) / 1000);
  if (seconds < SECONDS_PER_HOUR) return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m`;
  if (seconds < SECONDS_PER_DAY) return `${Math.floor(seconds / SECONDS_PER_HOUR)}h`;
  return `${Math.floor(seconds / SECONDS_PER_DAY)}d`;
}

module.exports = { plain, sanitize, seg, displayWidth, clip, renderLine, wrapChips, wrapText, age };
