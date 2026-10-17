'use strict';

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

function mailHost() {
  return required('MAIL_HOST');
}

module.exports = {
  host: required('DEPLOY_SSH_HOST'),
  mailHost,
  publicUrl: String(process.env.DEPLOY_PUBLIC_URL || '').trim(),
  settingsUser: String(process.env.DEPLOY_SETTINGS_USER || 'admin').trim() || 'admin',
};
