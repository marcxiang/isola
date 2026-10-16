'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
function settingsPath(dir,profileId){
 if(profileId===undefined)return path.join(dir,'ai-settings.json');
 if(typeof profileId!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(profileId))throw Error('AI 环境标识无效');
 return path.join(dir,'ai-profiles',profileId.toLowerCase(),'settings.json');
}
function record(value,defaults){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid record');
 const out={};for(const key of ['baseURL','protocol','model','maxSteps','visionEnabled'])out[key]=value[key]??defaults[key];
 if(typeof out.baseURL!=='string'||out.baseURL.length>4096||!['responses','chat'].includes(out.protocol)||typeof out.model!=='string'||out.model.length>120||!Number.isInteger(out.maxSteps)||out.maxSteps<1||out.maxSteps>50||typeof out.visionEnabled!=='boolean')throw Error('invalid fields');
 out.encryptedKey=value.encryptedKey??'';if(typeof out.encryptedKey!=='string'||out.encryptedKey.length>65536)throw Error('invalid encrypted key');
 return out;
}
function read(file,defaults){const size=fs.statSync(file).size;if(size>128*1024)throw Error('invalid size');return record(JSON.parse(fs.readFileSync(file,'utf8')),defaults);}
function write(file,value,defaults){
 const data=record(value,defaults),dir=path.dirname(file),temp=file+'.tmp-'+randomUUID();let created=false;
 try{
  fs.mkdirSync(dir,{recursive:true,mode:0o700});const fd=fs.openSync(temp,'wx',0o600);created=true;
  try{fs.writeFileSync(fd,JSON.stringify(data,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temp,file);created=false;
  try{const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}catch{}
 }finally{if(created)try{fs.unlinkSync(temp);}catch{}}
 return data;
}
function readSettingsRecord({dir,profileId,defaults}){
 const file=settingsPath(dir,profileId);
 try{
  if(fs.existsSync(file))return read(file,defaults);
  const legacy=settingsPath(dir),initial=profileId!==undefined&&fs.existsSync(legacy)?read(legacy,defaults):record({},defaults);
  // Snapshot legacy settings once per environment. Future edits in any window
  // can only change its own file, including its encrypted key and vision opt-in.
  if(profileId!==undefined)write(file,initial,defaults);
  return initial;
 }catch{throw Error('AI 配置无法读取或迁移，原文件已保留，请检查本机配置');}
}
function writeSettingsRecord({dir,profileId,defaults,value}){
 const file=settingsPath(dir,profileId);try{return write(file,value,defaults);}catch{throw Error('AI 配置未能安全保存，原配置已保留');}
}
function removeSettingsRecord({dir,profileId}){
 if(profileId===undefined)throw Error('删除模型设置必须指定环境');const file=settingsPath(dir,profileId);
 if(fs.existsSync(file))fs.unlinkSync(file);
 try{fs.rmdirSync(path.dirname(file));}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code))throw error;}
}
module.exports={settingsPath,readSettingsRecord,writeSettingsRecord,removeSettingsRecord};
