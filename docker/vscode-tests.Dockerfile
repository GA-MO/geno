# Runs the `vscode` vitest project under Xvfb, so the VS Code windows the tests open never reach the host's screen.
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth dbus dbus-x11 \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgtk-3-0 libgbm1 libasound2 libxkbfile1 \
      libsecret-1-0 libxss1 libxshmfence1 libxcomposite1 libxdamage1 libxrandr2 libnotify4 \
      fonts-noto-core fonts-noto-color-emoji fonts-dejavu-core \
      git ripgrep bubblewrap socat rsync procps \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@11.3.0

COPY --chmod=755 vscode-tests-entry.sh /usr/local/bin/vscode-tests-entry
RUN mkdir -p /work/.vscode-test /pnpm-store && chown -R node:node /work /pnpm-store

# sandbox-runtime wants a non-root caller, for which bubblewrap needs no capabilities.
USER node
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/vscode-tests-entry"]
