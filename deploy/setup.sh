#!/usr/bin/env bash
# ICT Bot — Ubuntu/Debian VPS kurulumu (Oracle Always Free, herhangi bir VPS
# veya evdeki Linux makine). Tek seferlik çalıştırılır; bot systemd ile 7/24
# çalışır, çökerse 10 sn'de yeniden başlar, sunucu yeniden açılınca otomatik kalkar.
#
# Kullanım:
#   git clone <repo> ~/Trade_Bot && cd ~/Trade_Bot
#   cp .env.example .env && nano .env   # token/anahtarları doldur
#   bash deploy/setup.sh
set -euo pipefail

APPDIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNUSER="${SUDO_USER:-$USER}"

echo "== ICT Bot kurulumu: $APPDIR (kullanıcı: $RUNUSER) =="

# 1) Node ≥ 20 denetimi (yoksa NodeSource 22.x kurulur)
if command -v node >/dev/null 2>&1 && [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -ge 20 ]; then
  echo "Node $(node --version) mevcut ✓"
else
  echo "Node ≥20 yok — NodeSource 22.x kuruluyor (sudo gerekir)…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"

# 2) .env denetimi
if [ ! -f "$APPDIR/.env" ]; then
  echo "HATA: $APPDIR/.env yok. Önce: cp .env.example .env && nano .env" >&2
  exit 1
fi
# Sunucu varsayılanı güvenli olsun: host tanımsızsa 127.0.0.1 yaz
grep -q '^ICT_DASHBOARD_HOST=' "$APPDIR/.env" || echo 'ICT_DASHBOARD_HOST=127.0.0.1' >> "$APPDIR/.env"
chmod 600 "$APPDIR/.env"

# 3) Testler (kurulum sağlığı — ağ gerektirmez)
echo "== Testler çalıştırılıyor =="
(cd "$APPDIR" && npm test >/dev/null) && echo "testler yeşil ✓"

# 4) systemd servisi
echo "== systemd servisi kuruluyor (sudo gerekir) =="
sed -e "s|__APPDIR__|$APPDIR|g" -e "s|__USER__|$RUNUSER|g" -e "s|__NODE__|$NODE_BIN|g" \
  "$APPDIR/deploy/ictbot.service" | sudo tee /etc/systemd/system/ictbot.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable ictbot
sudo systemctl restart ictbot

sleep 3
sudo systemctl --no-pager --lines=8 status ictbot || true

cat <<EOF

== KURULUM TAMAM ==
Canlı log     : journalctl -u ictbot -f
Durdur/başlat : sudo systemctl stop|start|restart ictbot
Dashboard     : ssh -L 8717:localhost:8717 $RUNUSER@<sunucu-ip>
                sonra tarayıcıda http://localhost:8717
Öğrenme       : cd $APPDIR && node --env-file=.env src/run/train.mjs
EOF
