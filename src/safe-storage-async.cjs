'use strict';

// Keep the original ciphertext until an explicit settings save succeeds. A
// provider's rotation hint is not permission to rewrite stored credentials.
function unavailable(){const error=Error('系统密钥服务暂不可用，原密钥已保留；请稍后重试');error.code='SECRET_STORAGE_UNAVAILABLE';return error;}
function createAsyncCipher(storage,{platform=process.platform}={}){
 const supported=()=>typeof storage?.isAsyncEncryptionAvailable==='function'&&typeof storage?.decryptStringAsync==='function'&&typeof storage?.encryptStringAsync==='function';
 const ready=async()=>{
  if(!supported()||platform==='linux'&&['basic_text','unknown'].includes(storage.getSelectedStorageBackend?.()||'unknown'))throw unavailable();
  if(await storage.isAsyncEncryptionAvailable()!==true)throw unavailable();
 };
 return {
  async unsealAsync(value){
   try{
    if(typeof value!=='string'||!value||value.length>100000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw unavailable();
    const encrypted=Buffer.from(value,'base64');if(!encrypted.length||encrypted.toString('base64')!==value)throw unavailable();
    await ready();
    const decrypted=await storage.decryptStringAsync(encrypted);
    if(!decrypted||typeof decrypted!=='object'||typeof decrypted.result!=='string'||!decrypted.result||typeof decrypted.shouldReEncrypt!=='boolean')throw unavailable();
    return decrypted.result;
   }catch{throw unavailable();}
  },
  async sealAsync(value){
   try{
    if(typeof value!=='string'||!value)throw unavailable();
    await ready();
    const encrypted=await storage.encryptStringAsync(value);
    if(!Buffer.isBuffer(encrypted)||encrypted.length<4||encrypted.equals(Buffer.from(value)))throw unavailable();
    return encrypted.toString('base64');
   }catch{throw unavailable();}
  }
 };
}
module.exports={createAsyncCipher};
