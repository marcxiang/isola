import fs from 'node:fs';
import path from 'node:path';
import {Data,NtExecutable,NtExecutableResource,Resource} from 'resedit';

// Package the already installed, checksum-verified Electron distribution. This
// avoids downloading/extracting the same runtime twice on Windows, and includes
// only application sources (there are no production npm dependencies).
export function packageWindows(root,arch,out){
 const runtime=path.join(root,'node_modules/electron/dist');
 const binary=fs.readFileSync(path.join(runtime,'electron.exe'));
 const machine=binary.readUInt16LE(binary.readUInt32LE(0x3c)+4);
 if(machine!==(arch==='arm64'?0xaa64:0x8664))throw Error('Installed Electron architecture differs from requested Windows architecture. Reinstall Electron for the requested architecture.');
 const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version;
 const target=path.resolve(out,`Isola-win32-${arch}`);
 if(fs.existsSync(target))throw Error(`Build directory already exists; choose a new ISOLA_BUILD_OUT: ${target}`);
 fs.mkdirSync(target,{recursive:true});
 fs.cpSync(runtime,target,{recursive:true});
 fs.renameSync(path.join(target,'electron.exe'),path.join(target,'Isola.exe'));
 const app=path.join(target,'resources/app');fs.mkdirSync(app,{recursive:true});
 for(const name of ['src','assets','package.json','LICENSE','README.md','WINDOWS.md','DEVICE_PROFILES.md','HANDOFF.md','CHANGELOG.md'])fs.cpSync(path.join(root,name),path.join(app,name),{recursive:true});
 const defaultApp=path.join(target,'resources/default_app.asar');if(fs.existsSync(defaultApp))fs.unlinkSync(defaultApp);
 const exe=NtExecutable.from(binary),resources=NtExecutableResource.from(exe);
 const groups=Resource.IconGroupEntry.fromEntries(resources.entries);
 if(groups.length!==1)throw Error('Expected one executable icon group');
 const icon=Data.IconFile.from(fs.readFileSync(path.join(root,'assets/icon.ico')));
 Resource.IconGroupEntry.replaceIconsForResource(resources.entries,groups[0].id,groups[0].lang,icon.icons.map(item=>item.data));
 const info=Resource.VersionInfo.fromEntries(resources.entries)[0];
 const numeric=version.match(/^(\d+)\.(\d+)\.(\d+)/).slice(1).map(Number);
 info.setFileVersion(...numeric,Number(version.match(/dev\.(\d+)$/)?.[1]||0));info.setProductVersion(...numeric,0);
 for(const language of info.getAllLanguagesForStringValues())info.setStringValues(language,{CompanyName:'Isola',FileDescription:'Isola browser workspace',InternalName:'Isola',OriginalFilename:'Isola.exe',ProductName:'Isola',ProductVersion:version,FileVersion:version});
 info.outputToResourceEntries(resources.entries);resources.outputResource(exe);
 fs.writeFileSync(path.join(target,'Isola.exe'),Buffer.from(exe.generate()));
 return target;
}
