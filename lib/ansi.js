'use strict';

// Minimal ANSI styling. Each helper resets only its own attribute so styles nest.

const ESC = '\x1b[';
const color = (code) => (t) => `${ESC}${code}m${t}${ESC}39m`;

module.exports = {
  ESC,
  green: color(32),
  red: color(31),
  yellow: color(33),
  magenta: color(35),
  cyan: color(36),
  dim: (t) => `${ESC}2m${t}${ESC}22m`,
  bold: (t) => `${ESC}1m${t}${ESC}22m`,
  inverse: (t) => `${ESC}7m${t}${ESC}27m`,
};
