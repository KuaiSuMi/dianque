#!/bin/bash
set -Eeuo pipefail
revision=${1:?missing Git commit}
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || exit 2
exec 9>/run/lock/dianque-deploy.lock
flock -n 9 || { echo '已有部署正在进行，请等待完成。' >&2; exit 1; }

candidate="/opt/dianque.next-$revision"
current=/opt/dianque
previous=/opt/dianque.previous
test -f "$current/server/index.js"
test -f /etc/dianque.env
test ! -L "$current"
test ! -e "$candidate"
stopped=0
moved=0
cleanup() {
  status=$?
  trap - EXIT
  if (( status != 0 && stopped )); then
    echo '上线检查失败，恢复上一版程序。' >&2
    if (( moved )); then
      systemctl stop dianque
      rm -rf -- "$current"
      mv -T -- "$previous" "$current"
    fi
    systemctl start dianque || true
  fi
  rm -rf -- "$candidate"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

install -d -m 755 "$candidate"
cd "$candidate"
git init --quiet
git fetch --quiet --depth=1 https://github.com/KuaiSuMi/dianque.git "$revision"
git checkout --quiet --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = "$revision"
npm ci --include=dev --no-fund --no-audit
npm test
npm run build
npm prune --omit=dev --no-fund --no-audit
runuser -u dianque -- node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { createApp } from './server/index.js';
const instance = await createApp({ database: ':memory:' });
try {
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${instance.server.address().port}`;
  assert.deepEqual(await (await fetch(origin + '/api/health')).json(), { ok: true });
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root"><\/div>/);
} finally { await instance.close(); }
JS

systemctl start dianque-backup.service
rm -rf -- "$previous"
stopped=1
systemctl stop dianque
mv -T -- "$current" "$previous"
moved=1
mv -T -- "$candidate" "$current"
cd "$current"
systemctl start dianque
test "$(curl -fsS --max-time 5 --retry 5 --retry-connrefused --retry-delay 1 --retry-max-time 15 http://127.0.0.1:3000/api/health)" = '{"ok":true}'
echo "服务器已部署 GitHub 提交 $revision，数据库已备份，上一版程序保存在 /opt/dianque.previous。"
