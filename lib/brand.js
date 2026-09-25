'use strict';
/**
 * The product name, and everything derived from it. To rename: change NAME
 * here, then `package.json` (name + bin key) and the filename `bin/<name>.js`
 * — those three cannot read this file. `test/test.js` checks they agree.
 */
const NAME = 'agstats';
module.exports = {
  NAME,
  TAGLINE: 'what your coding agents did, from their own transcripts',
  ENV_LANG: `${NAME.toUpperCase()}_LANG`,
};
