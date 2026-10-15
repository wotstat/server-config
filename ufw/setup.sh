#!/bin/sh
set -eu

# Основной сервер wotstat, состояние на 2026-10-15.
# Разрешаем SSH до изменения политик и включения firewall.
ufw allow OpenSSH
ufw allow 9000/tcp
ufw allow 8123/tcp
ufw allow 'Nginx Full'
ufw allow in proto tcp from 172.31.0.0/16 to 172.17.0.1 port 8124 comment 'og-meta to nginx'

ufw default deny incoming
ufw default allow outgoing
ufw default deny routed
ufw logging low
ufw app default skip

ufw enable
ufw status verbose
