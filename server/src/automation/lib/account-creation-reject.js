'use strict';

const REGISTER_ACCOUNT_CREATION_REJECTED = 'REGISTER_ACCOUNT_CREATION_REJECTED';
const PASSWORD_SUBMISSION_STAGE = 'password_submission';
const ACCOUNT_CREATION_REJECTED_NORMALIZED = 'failed to create account please try again';

function normalizeBusinessMessage(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function isExactAccountCreationRejectedMessage(value) {
  return normalizeBusinessMessage(value) === ACCOUNT_CREATION_REJECTED_NORMALIZED;
}

function isAccountCreationRejectedMessage(value) {
  const normalized = normalizeBusinessMessage(value);
  return Boolean(normalized)
    && (normalized === ACCOUNT_CREATION_REJECTED_NORMALIZED
      || normalized.includes(ACCOUNT_CREATION_REJECTED_NORMALIZED));
}

function isAccountCreationRejectedFailure(error) {
  if (String(error?.code || '') === REGISTER_ACCOUNT_CREATION_REJECTED) {
    const stage = String(error?.stage || '');
    return !stage || stage === PASSWORD_SUBMISSION_STAGE;
  }
  return isAccountCreationRejectedMessage(error?.inline_error)
    || isAccountCreationRejectedMessage(error?.upstreamMessage)
    || isAccountCreationRejectedMessage(error?.message);
}

module.exports = {
  REGISTER_ACCOUNT_CREATION_REJECTED,
  PASSWORD_SUBMISSION_STAGE,
  ACCOUNT_CREATION_REJECTED_NORMALIZED,
  normalizeBusinessMessage,
  isExactAccountCreationRejectedMessage,
  isAccountCreationRejectedMessage,
  isAccountCreationRejectedFailure,
};
