'use strict';

/** Enable the standalone MK GCash port. Corresponds to user-requested MK_GCASH=1 switch. */
function mkGcashEnabled() {
  return /^(1|true|yes)$/i.test(String(process.env.MK_GCASH || ''));
}

module.exports = { mkGcashEnabled };
