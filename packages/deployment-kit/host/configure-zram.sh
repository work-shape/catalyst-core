#!/usr/bin/env bash
set -euo pipefail

zram_size="${ZRAM_SIZE:-2G}"
swappiness="${ZRAM_SWAPPINESS:-20}"

if [[ "$(id -u)" != "0" ]]; then
  echo "configure-zram: run as root (for example with sudo)" >&2
  exit 1
fi
if [[ ! "$zram_size" =~ ^([1-9][0-9]*)([MG])$ ]]; then
  echo "configure-zram: ZRAM_SIZE must be an integer followed by M or G" >&2
  exit 1
fi
size_value="${BASH_REMATCH[1]}"
size_unit="${BASH_REMATCH[2]}"
if [[ "$size_unit" == "G" ]]; then
  zram_size_mib=$((size_value * 1024))
else
  zram_size_mib="$size_value"
fi
if [[ ! "$swappiness" =~ ^[0-9]+$ ]] || (( swappiness > 200 )); then
  echo "configure-zram: ZRAM_SWAPPINESS must be an integer from 0 to 200" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  linux-image-generic \
  "linux-modules-extra-$(uname -r)" \
  systemd-zram-generator

install -d -m 0755 /etc/systemd
config_file="$(mktemp)"
sysctl_file="$(mktemp)"
trap 'rm -f "$config_file" "$sysctl_file"' EXIT

# zram-generator evaluates zram-size in MiB, not as a byte-size string.
printf '%s\n' \
  '[zram0]' \
  "zram-size = min(ram / 2, $zram_size_mib)" \
  'swap-priority = 100' > "$config_file"
install -o root -g root -m 0644 "$config_file" /etc/systemd/zram-generator.conf

printf '%s\n' \
  "vm.swappiness=$swappiness" \
  'vm.page-cluster=0' > "$sysctl_file"
install -o root -g root -m 0644 "$sysctl_file" /etc/sysctl.d/98-vivd-catalyst-zram.conf

modprobe zram
systemctl daemon-reload
systemctl reset-failed systemd-zram-setup@zram0.service
systemctl start systemd-zram-setup@zram0.service
sysctl -p /etc/sysctl.d/98-vivd-catalyst-zram.conf

echo
echo "configure-zram: active swap devices"
swapon --show --bytes
zramctl
