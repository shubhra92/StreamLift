#!/bin/zsh
# Sets CARGO_HOME to a local folder inside this project.
# Packages download to .cargo-home/ instead of ~/.cargo/
# Delete .cargo-home/ anytime to free disk — other projects unaffected.

export CARGO_HOME="$(pwd)/.cargo-home"
echo "CARGO_HOME set to: $CARGO_HOME"
echo "Run your cargo commands now in this shell session."
echo "  cargo build"
echo "  cargo run"
echo "  cargo clean"
