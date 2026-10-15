#!/bin/sh
set -eu
umask 077
directory=/var/backups/dianque
mkdir -p "$directory"
target="$directory/$(date -u +%Y%m%dT%H%M%S).sqlite"
sqlite3 /var/lib/dianque/dianque.sqlite ".timeout 5000" ".backup '$target'"
test "$(sqlite3 "$target" 'PRAGMA quick_check;')" = ok
# 只清理已生成超过 14 天的本应用备份。
find "$directory" -maxdepth 1 -type f -name '*.sqlite' -mtime +14 -delete
