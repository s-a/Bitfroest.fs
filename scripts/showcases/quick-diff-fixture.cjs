const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function prepareQuickDiff(demo) {
  const root = path.join(demo, 'quick-diff-list'), marker = path.join(root, '.git', 'showcase-quick-diff');
  if (fs.existsSync(root)) {
    if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== 'quick-diff-v3\n') throw new Error('Unexpected Quick Diff demonstration directory.');
    return root;
  }
  fs.mkdirSync(path.join(root, 'src'), { recursive: true }); fs.mkdirSync(path.join(root, 'docs'));
  const git = (...args) => execFileSync('git', ['-c', `core.hooksPath=${path.join(root, '.git/no-hooks')}`, ...args], { cwd: root, windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, '.git/empty-global-config') }, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '--initial-branch=main');
  const original = "-- Demo order report\nSELECT\n    order_id,\n    customer_name,\n    order_date,\n    total_amount\nFROM orders\nWHERE status = 'pending'\nORDER BY order_date;\n\n-- Region directory\nSELECT\n    region_code,\n    region_name,\n    country_code,\n    country_name,\n    currency_code,\n    time_zone,\n    office_name,\n    office_city,\n    office_postcode,\n    contact_name,\n    contact_phone,\n    contact_email,\n    reporting_group,\n    reporting_order,\n    enabled\nFROM regions\nWHERE enabled = 1\nORDER BY reporting_order, region_name;\n\n-- Monthly summary\nSELECT\n    region,\n    COUNT(*) AS order_count,\n    SUM(total_amount) AS revenue\nFROM orders\nGROUP BY region\nORDER BY revenue DESC;\n";
  fs.writeFileSync(path.join(root, '.gitignore'), '.cache/\n');
  fs.writeFileSync(path.join(root, 'src/Orders.sql'), original);
  fs.writeFileSync(path.join(root, 'src/Legacy.sql'), 'SELECT * FROM archived_orders;\n');
  fs.writeFileSync(path.join(root, 'docs/Release.md'), '# Demo release\n\nInitial report.\n');
  fs.writeFileSync(path.join(root, 'Overview.md'), '# Demo overview\n');
  git('add', '.'); git('-c', 'user.name=Demo', '-c', 'user.email=demo@example.invalid', 'commit', '-qm', 'Initial report');
  fs.writeFileSync(marker, 'quick-diff-v3\n');
  fs.writeFileSync(path.join(root, 'src/Orders.sql'), original.replace('    total_amount\n', '    total_amount,\n    currency_code\n').replace("WHERE status = 'pending'", "WHERE status IN ('paid', 'shipped')\n  AND total_amount >= 100").replace('GROUP BY region', "WHERE order_date >= '2026-01-01'\nGROUP BY region"));
  fs.unlinkSync(path.join(root, 'src/Legacy.sql'));
  fs.writeFileSync(path.join(root, 'src/New.sql'), 'SELECT customer_name FROM customers;\n');
  fs.writeFileSync(path.join(root, 'docs/Release.md'), '# Demo release\n\nThe report now includes completed orders.\n');
  fs.writeFileSync(path.join(root, 'Overview.md'), '# Demo overview\n\nUpdated report summary.\n');
  for (const [file, time] of [['src/Orders.sql', '12:00'], ['Overview.md', '11:55'], ['docs/Release.md', '11:50'], ['src/New.sql', '11:45']]) { const stamp = new Date(`2026-11-04T${time}:00Z`); fs.utimesSync(path.join(root, file), stamp, stamp); }
  fs.mkdirSync(path.join(root, '.cache')); fs.writeFileSync(path.join(root, '.cache/build.log'), 'Demo build completed.\n');
  return root;
}
module.exports = { prepareQuickDiff };
