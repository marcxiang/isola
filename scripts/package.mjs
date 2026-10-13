import { packager } from '@electron/packager';
import path from 'node:path';
import fs from 'node:fs';
const root = path.resolve(import.meta.dirname, '..');
const cache = path.resolve(root, '../../work/electron-cache');
const zipName = `electron-v${JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/package.json'))).version}-darwin-${process.env.ISOLA_ARCH || 'arm64'}.zip`;
const zipDir = fs.existsSync(cache) ? fs.readdirSync(cache).map(n => path.join(cache,n)).find(p => fs.existsSync(path.join(p,zipName))) : undefined;
console.log(await packager({ dir: root, name: 'Isola', icon: path.join(root, 'assets/icon.icns'), platform: 'darwin', arch: process.env.ISOLA_ARCH || 'arm64', out: process.env.ISOLA_BUILD_OUT || path.resolve(root, '../macOS'), overwrite: true, ignore: [/^\/test/, /^\/scripts/], appBundleId: 'com.isola.browser', electronZipDir: zipDir, download: { cacheRoot: cache } }));
