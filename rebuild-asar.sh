#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "=== Building Vite ==="
npm run build
echo "=== Building Electron TypeScript ==="
npx tsc -p electron/tsconfig.json
echo "=== Packaging Electron (unpacked) ==="
npx electron-builder --dir
echo "=== Creating asar ==="
npx asar pack release/linux-unpacked/resources/app.asar.unpacked release/linux-unpacked/resources/app.asar
echo "=== Done ==="
ls -lh release/linux-unpacked/resources/app.asar
