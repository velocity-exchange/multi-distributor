#
# Drift DFX IOU Claims Program Dev Container
#
FROM --platform=linux/amd64 ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
ARG SOLANA_CLI="4.3.0"
ARG ANCHOR_CLI="0.31.2"
ARG RUST_VERSION="1.89.0"
# anchor idl build needs nightly; keep in sync with IDL_NIGHTLY in CI.
ARG IDL_NIGHTLY="nightly-2026-07-25"
ARG NODE_VERSION="20.18.1"
ENV HOME="/root"
ENV PATH="/usr/local/cargo/bin:${PATH}"
ENV PATH="/root/.local/share/solana/install/active_release/bin:${PATH}"

RUN mkdir -p /workdir /tmp \
    && apt-get update -qq \
    && apt-get upgrade -qq \
    && apt-get install -y --no-install-recommends \
    build-essential git curl wget jq pkg-config python3-pip xz-utils ca-certificates \
    libssl-dev libudev-dev bash software-properties-common \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain "${RUST_VERSION}" \
    && . "$HOME/.cargo/env" \
    && rustup component add rustfmt clippy rust-analyzer \
    && rustup toolchain install "${IDL_NIGHTLY}" --profile minimal

ENV PATH="/root/.cargo/bin:${PATH}"
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && corepack enable \
    && npm install -g ts-mocha typescript mocha \
    && node -v && npm -v && yarn -v

RUN sh -c "$(curl -sSfL https://release.anza.xyz/v${SOLANA_CLI}/install)"

RUN curl -sSfL "https://github.com/solana-foundation/anchor/releases/download/v${ANCHOR_CLI}/anchor-${ANCHOR_CLI}-x86_64-unknown-linux-gnu" \
    -o /usr/local/bin/anchor \
    && chmod +x /usr/local/bin/anchor \
    && anchor --version

RUN solana-keygen new --no-bip39-passphrase --force \
    && solana config set --url localhost

RUN apt-get update && apt-get install -y zsh curl git \
    && sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended \
    && chsh -s /usr/bin/zsh root

WORKDIR /workdir
