#!/usr/bin/env bash
set -euo pipefail

REPO="dannydulai/zmx-sessions"
INSTALL_DIR="$HOME/.local/bin"

# Detect OS and arch
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)  os="linux" ;;
  Darwin) os="darwin" ;;
  *) echo "Unsupported OS: $OS"; exit 1 ;;
esac

case "$ARCH" in
  x86_64)  arch="x64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

TARBALL="zmx-sessions-${os}-${arch}.tar.gz"

# Get latest release tag
LATEST=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)

if [ -z "$LATEST" ]; then
  echo "Error: could not determine latest release"
  exit 1
fi

echo "Installing zmx-sessions ${LATEST} (${os}/${arch})..."

mkdir -p "$INSTALL_DIR"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "https://github.com/${REPO}/releases/download/${LATEST}/${TARBALL}" -o "${TMP}/${TARBALL}"
tar xzf "${TMP}/${TARBALL}" -C "$TMP"
mv "${TMP}/zmx-sessions" "${INSTALL_DIR}/zmx-sessions"
chmod +x "${INSTALL_DIR}/zmx-sessions"

echo "Installed zmx-sessions to ${INSTALL_DIR}/zmx-sessions"

# Check if INSTALL_DIR is in PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  echo ""
  echo "WARNING: ${INSTALL_DIR} is not in your PATH."
  echo "Add it by appending this line to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
  echo ""
  echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
  echo ""
fi
