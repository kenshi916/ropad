#!/usr/bin/env bash
# Run only on the approved fresh Ubuntu application server, after key SSH works.
# Installs infrastructure; does not start Ropad, transfer secrets or change DNS.
set -euo pipefail
test "$(id -u)" -eq 0
. /etc/os-release
test "$ID" = ubuntu && test "$VERSION_ID" = 24.04
export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=180 update
apt-get -o DPkg::Lock::Timeout=180 install -y ca-certificates curl git ufw
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get -o DPkg::Lock::Timeout=180 update
apt-get -o DPkg::Lock::Timeout=180 install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# Small-host installation headroom; preserve any existing swap and fstab rows.
if ! swapon --show=NAME --noheadings | grep -q .; then
  install -d -m 0700 /var/swap
  if [ ! -e /var/swap/ropad.swap ]; then
    (umask 077; fallocate -l 1G /var/swap/ropad.swap)
    mkswap /var/swap/ropad.swap
  fi
  test -f /var/swap/ropad.swap && test ! -L /var/swap/ropad.swap
  test "$(blkid -p -s TYPE -o value /var/swap/ropad.swap)" = swap
  swapon /var/swap/ropad.swap
  if ! grep -q '^/var/swap/ropad.swap ' /etc/fstab; then
    printf '\n/var/swap/ropad.swap none swap sw 0 0\n' >> /etc/fstab
  fi
fi

# Keep existing authorized_keys intact. Key login must be tested before this.
test -s /root/.ssh/authorized_keys
cat > /etc/ssh/sshd_config.d/00-ropad-key-only.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t
systemctl reload ssh
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw default deny incoming
ufw default allow outgoing
ufw --force enable
# Docker-published ports bypass UFW: compose must publish only Caddy 80/443.
docker --version
docker compose version
free -m
ufw status
