import { packager } from '@electron/packager';
import path from 'node:path';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {packageWindows} from './package-windows.mjs';
const root = path.resolve(import.meta.dirname, '..');
// Electron 44 installs its checksum-verified runtime lazily on first require.
// Building directly after npm ci must work before the first application start.
createRequire(import.meta.url)('electron');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.split('=')[1];
const platform = option('platform') || process.env.ISOLA_PLATFORM || process.platform;
const arch = option('arch') || process.env.ISOLA_ARCH || (platform === 'darwin' ? 'arm64' : 'x64');
if (!['darwin', 'win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw Error('Supported platforms: darwin, win32, linux; architectures: x64, arm64');
if(platform==='win32'&&process.platform==='win32'){
 console.log(packageWindows(root,arch,process.env.ISOLA_BUILD_OUT||path.join(root,'dist')));
}else{
const cache = path.resolve(process.env.ELECTRON_CACHE || path.join(root, '../electron-cache'));
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/package.json'))).version;
const zipName = `electron-v${electronVersion}-${platform}-${arch}.zip`;
const zipDir = fs.existsSync(cache) ? [cache, ...fs.readdirSync(cache).map(n => path.join(cache,n))].find(p => fs.existsSync(path.join(p,zipName))) : undefined;
console.log(await packager({
 dir: root, name: 'Isola', platform, arch,
 icon: path.join(root, 'assets', platform === 'win32' ? 'icon.ico' : platform === 'darwin' ? 'icon.icns' : 'icon.png'),
 out: process.env.ISOLA_BUILD_OUT || path.join(root, 'dist'), overwrite: true,
 ignore: [/^[/\\](test|scripts|test-artifacts|dist|out|\.git)([/\\]|$)/],
 appBundleId: 'com.isola.browser', executableName: 'Isola',
 win32metadata: {CompanyName: 'Isola', FileDescription: 'Isola browser workspace', ProductName: 'Isola', InternalName: 'Isola'},
 electronZipDir: zipDir, download: {cacheRoot: cache}
}));
}
