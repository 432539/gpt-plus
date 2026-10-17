const db = require('./src/db');
const registerJob = require('./src/utils/registerJob');
const user = db.prepare("SELECT id, username, role FROM users WHERE username='honey' OR role='admin' ORDER BY username='honey' DESC LIMIT 1").get();
const before = registerJob.status(user.id);
console.log(JSON.stringify({
  user: user.username,
  running: before.running,
  run_id: before.run_id,
  message: String(before.message || '').slice(0, 160),
}));
if (before.running) {
  const result = registerJob.stop(user.id);
  console.log(JSON.stringify({ stopped: true, result }));
} else {
  console.log(JSON.stringify({ stopped: false }));
}
const after = registerJob.status(user.id);
console.log(JSON.stringify({
  running: after.running,
  finished: after.finished,
  message: String(after.message || '').slice(0, 160),
}));
