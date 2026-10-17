// mail.com 家族后缀目录(对齐参考项目 services/mailcom.py)
// 管理页可逐个启用/禁用;拉子号只从「启用」列表取。默认只开 DEFAULT_PULL_SUFFIXES。

const DEFAULT_PULL_SUFFIXES = [
  'brew-meister.com',
  'pacific-ocean.com',
  'deliveryman.com',
  'dr.com',
  'computer4u.com',
  'homemail.com',
  'salesperson.net',
  'clubmember.org',
  'usa.com',
  'toke.com',
];

const DEFAULT_DOMAINS = [
  '2trom.com', 'accountant.com', 'acdcfan.com', 'adexec.com', 'africamail.com',
  'alumni.com', 'angelic.com', 'archaeologist.com', 'arcticmail.com', 'artlover.com',
  'asia.com', 'atheist.com', 'australiamail.com', 'bartender.net', 'berlin.com',
  'bikerider.com', 'birdlover.com', 'boardermail.com', 'brazilmail.com', 'brew-master.com',
  'bsdmail.com', 'californiamail.com', 'catlover.com', 'cheerful.com', 'chef.net',
  'chemist.com', 'chinamail.com', 'collector.org', 'columnist.com', 'comic.com',
  'consultant.com', 'contractor.net', 'counsellor.com', 'cutey.com', 'cyber-wizard.com',
  'cyberdude.com', 'cybergal.com', 'dallasmail.com', 'dbzmail.com', 'diplomats.com',
  'disciples.com', 'discofan.com', 'doglover.com', 'doramail.com', 'dr.com',
  'dublin.com', 'dutchmail.com', 'elvisfan.com', 'email.com', 'engineer.com',
  'englandmail.com', 'europe.com', 'europemail.com', 'execs.com', 'financier.com',
  'fireman.net', 'galaxyhit.com', 'gardener.com', 'geologist.com', 'germanymail.com',
  'graduate.org', 'graphic-designer.com', 'greenmail.net', 'hackermail.com', 'hairdresser.net',
  'hilarious.com', 'hiphopfan.com', 'iname.com', 'innocent.com', 'irelandmail.com',
  'israelmail.com', 'italymail.com', 'keromail.com', 'kissfans.com', 'kittymail.com',
  'koreamail.com', 'legislator.com', 'linuxmail.org', 'lobbyist.com', 'lovecat.com',
  'madonnafan.com', 'mail.com', 'marchmail.com', 'metalfan.com', 'mexicomail.com',
  'minister.com', 'moscowmail.com', 'munich.com', 'musician.org', 'muslim.com',
  'myself.com', 'ninfan.com', 'nonpartisan.com', 'nycmail.com', 'optician.com',
  'orthodontist.net', 'pediatrician.com', 'petlover.com', 'photographer.net', 'physicist.net',
  'polandmail.com', 'politician.com', 'post.com', 'priest.com', 'programmer.net',
  'protestant.com', 'publicist.com', 'ravemail.com', 'realtyagent.com', 'reborn.com',
  'reggaefan.com', 'registerednurses.com', 'reincarnate.com', 'religious.com', 'repairman.com',
  'safrica.com', 'saintly.com', 'sanfranmail.com', 'scotlandmail.com', 'secretary.net',
  'socialworker.net', 'sociologist.com', 'songwriter.net', 'spainmail.com', 'swedenmail.com',
  'swissmail.com', 'teachers.org', 'techie.com', 'technologist.com', 'theplate.com',
  'therapist.net', 'toke.com', 'toothfairy.com', 'torontomail.com', 'tvstar.com',
  'usa.com', 'uymail.com', 'webname.com',
];

const LISTED_MAILCOM_SUFFIXES = [
  '2trom.com', 'acdcfan.com', 'accountant.com', 'activist.com', 'adexec.com',
  'africamail.com', 'aircraftmail.com', 'allergist.com', 'alumni.com', 'alumnidirector.com',
  'angelic.com', 'appraiser.com', 'appraiser.net', 'archaeologist.com', 'arcticmail.com',
  'artlover.com', 'asia-mail.com', 'asia.com', 'atheist.com', 'auctioneer.com',
  'auctioneer.net', 'australiamail.com', 'bartender.net', 'bellair.com', 'bellair.net',
  'berlin.com', 'bikerider.com', 'birdlover.com', 'blader.com', 'boardermail.com',
  'brazilmail.com', 'brew-master.com', 'brew-meister.com', 'bsdmail.com', 'californiamail.com',
  'cash4u.com', 'catlover.com', 'cheerful.com', 'chef.net', 'chemist.com',
  'chinamail.com', 'clubmember.org', 'collector.org', 'columnist.com', 'comic.com',
  'computer4u.com', 'consultant.com', 'contractor.net', 'coolsite.net', 'counsellor.com',
  'cutey.com', 'cyber-wizard.com', 'cyberdude.com', 'cybergal.com', 'cyberservices.com',
  'dallasmail.com', 'dbzmail.com', 'deliveryman.com', 'disciples.com', 'discofan.com',
  'disposable.com', 'doglover.com', 'doramail.com', 'dr.com', 'dublin.com',
  'dutchmail.com', 'elvisfan.com', 'email.com', 'englandmail.com', 'europe.com',
  'europemail.com', 'execs.com', 'fastservice.com', 'financier.com', 'fireman.com',
  'fireman.net', 'galaxyhit.com', 'gardener.com', 'geologist.com', 'germanymail.com',
  'graduate.org', 'graphic-designer.com', 'greenmail.net', 'groupmail.com', 'hackermail.com',
  'hairdresser.net', 'hilarious.com', 'hiphopfan.com', 'homemail.com', 'hot-shot.com',
  'housemail.com', 'humanoid.net', 'iname.com', 'innocent.com', 'inorbit.com',
  'instruction.com', 'instructor.net', 'insurer.com', 'irelandmail.com', 'israelmail.com',
  'italymail.com', 'job4u.com', 'journalist.com', 'keromail.com', 'kissfans.com',
  'kittymail.com', 'koreamail.com', 'legislator.com', 'linuxmail.org', 'lobbyist.com',
  'lovecat.com', 'madonnafan.com', 'mail-me.com', 'mail.com', 'marchmail.com',
  'metalfan.com', 'mexicomail.com', 'minister.com', 'moscowmail.com', 'munich.com',
  'musician.org', 'muslim.com', 'myself.com', 'net-shopping.com', 'ninfan.com',
  'nonpartisan.com', 'null.net', 'nycmail.com', 'optician.com', 'orthodontist.net',
  'pacific-ocean.com', 'pacificwest.com', 'pediatrician.com', 'petlover.com', 'photographer.com',
  'photographer.net', 'physicist.com', 'physicist.net', 'planetmail.com', 'planetmail.net',
  'polandmail.com', 'politician.com', 'post.com', 'presidency.com', 'priest.com',
  'programmer.com', 'programmer.net', 'protestant.com', 'publicist.com', 'qualityservice.com',
  'radiologist.com', 'radiologist.net', 'ravemail.com', 'realtyagent.com', 'reborn.com',
  'reggaefan.com', 'registerednurses.com', 'reincarnate.com', 'religious.com', 'repairman.com',
  'representative.com', 'rescueteam.com', 'rocketship.com', 'safrica.com', 'saintly.com',
  'salesperson.com', 'salesperson.net', 'samerica.com', 'sanfranmail.com', 'scotlandmail.com',
  'secretary.com', 'secretary.net', 'snakebite.com', 'socialworker.com', 'socialworker.net',
  'sociologist.com', 'solution4u.com', 'songwriter.com', 'songwriter.net', 'spainmail.com',
  'surgical.net', 'swedenmail.com', 'swissmail.com', 'teachers.org', 'tech-center.com',
  'techie.com', 'technologist.com', 'theplate.com', 'therapist.net', 'toke.com',
  'toothfairy.com', 'torontomail.com', 'tvstar.com', 'umpire.com', 'usa.com',
  'uymail.com', 'webname.com', 'worker.com', 'workmail.com', 'writeme.com',
];

const DEFAULT_PULL_SET = new Set(DEFAULT_PULL_SUFFIXES);
const extraDomains = new Set();

function normalizeSuffix(raw) {
  let domain = String(raw || '').trim().toLowerCase().replace(/^@/, '');
  if (domain === 'rew-meister.com') domain = 'brew-meister.com';
  return domain;
}

function normalizeSuffixList(raw) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    const domain = normalizeSuffix(item);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push(domain);
  }
  return out;
}

function hydrateDomains(domains) {
  for (const item of domains || []) {
    const domain = normalizeSuffix(item);
    if (domain) extraDomains.add(domain);
  }
  return catalogMailcomDomains();
}

function catalogMailcomDomains() {
  const seen = new Set();
  const known = [];
  for (const group of [extraDomains, DEFAULT_PULL_SUFFIXES, DEFAULT_DOMAINS, LISTED_MAILCOM_SUFFIXES]) {
    for (const raw of group) {
      const domain = normalizeSuffix(raw);
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);
      known.push(domain);
    }
  }
  known.sort();
  return known;
}

function looksMailcomAddress(address) {
  const text = String(address || '').trim();
  const domain = text.includes('@') ? text.split('@').pop().toLowerCase() : '';
  if (!domain) return false;
  if (domain.endsWith('.mail.com') || domain === 'gmx.com' || domain === 'gmx.net') return true;
  return catalogMailcomDomains().includes(domain);
}

function unavailableEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const count = Math.max(0, Number(raw.count) || 0);
  if (!count && !raw.reason && !raw.last_error) return null;
  return {
    count,
    reason: String(raw.reason || ''),
    last_status: Number(raw.last_status) || 0,
    last_error: String(raw.last_error || '').slice(0, 240),
    last_seen_at: String(raw.last_seen_at || ''),
  };
}

function suffixCatalog(settingsMailcom = {}) {
  const known = catalogMailcomDomains();
  const enabledRaw = settingsMailcom.enabled_suffixes;
  const enabledSet = new Set(
    Array.isArray(enabledRaw) ? normalizeSuffixList(enabledRaw) : DEFAULT_PULL_SUFFIXES
  );
  const disabledSet = new Set(normalizeSuffixList(settingsMailcom.disabled_suffixes));
  const unavailableMap =
    settingsMailcom.unavailable_suffixes && typeof settingsMailcom.unavailable_suffixes === 'object'
      ? settingsMailcom.unavailable_suffixes
      : {};
  const items = known.map((suffix) => {
    const blocked = unavailableEntry(unavailableMap[suffix]);
    return {
      suffix,
      enabled: disabledSet.has(suffix) ? false : enabledSet.has(suffix),
      unavailable: Boolean(blocked),
      unavailable_count: blocked ? blocked.count : 0,
      unavailable_reason: blocked ? blocked.reason : '',
      last_error: blocked ? blocked.last_error : '',
    };
  });
  const enabled = items.filter((it) => it.enabled).map((it) => it.suffix);
  const disabled = items.filter((it) => !it.enabled).map((it) => it.suffix);
  const unavailable_enabled_count = items.filter((it) => it.enabled && it.unavailable).length;
  return {
    items,
    enabled,
    disabled,
    enabled_count: enabled.length,
    unavailable_enabled_count,
    total: items.length,
  };
}

function enabledSuffixes(settingsMailcom = {}) {
  return suffixCatalog(settingsMailcom).enabled;
}

function suffixFromExisting(item) {
  const text = String(item || '').trim().toLowerCase().replace(/^@/, '');
  if (!text) return '';
  return text.includes('@') ? text.split('@').pop().toLowerCase() : text;
}

// 只从启用列表 ∩ 该账号 listDomains 里挑；没有 live 目录时回退到启用列表。
function selectPullSuffixes({ enabled = [], live = [], existing = [] } = {}) {
  const enabledList = normalizeSuffixList(enabled);
  const liveList = normalizeSuffixList(live);
  const existingSet = new Set(
    (Array.isArray(existing) ? existing : []).map(suffixFromExisting).filter(Boolean)
  );
  const liveSet = new Set(liveList);
  const usedLiveCatalog = liveList.length > 0;
  const allowed = usedLiveCatalog ? enabledList.filter((domain) => liveSet.has(domain)) : enabledList;
  const blocked = usedLiveCatalog ? enabledList.filter((domain) => !liveSet.has(domain)) : [];
  const livePool = allowed.filter((domain) => !existingSet.has(domain));
  const usedAllowed = allowed.filter((domain) => existingSet.has(domain));
  const fallback = blocked.filter((domain) => !existingSet.has(domain));
  const usedBlocked = blocked.filter((domain) => existingSet.has(domain));
  const pool = [...livePool, ...usedAllowed, ...fallback, ...usedBlocked];
  return { allowed, blocked, pool, fallback, usedLiveCatalog, existing: [...existingSet] };
}

function classifyAliasAddStatus(status) {
  const code = Number(status) || 0;
  if (code === 200 || code === 201) return 'ok';
  if (code === 409) return 'full';
  if (code === 400) return 'skip_suffix';
  return 'skip_suffix';
}

module.exports = {
  DEFAULT_PULL_SUFFIXES,
  DEFAULT_PULL_SET,
  LISTED_MAILCOM_SUFFIXES,
  catalogMailcomDomains,
  hydrateDomains,
  looksMailcomAddress,
  normalizeSuffixList,
  suffixCatalog,
  enabledSuffixes,
  selectPullSuffixes,
  classifyAliasAddStatus,
};
