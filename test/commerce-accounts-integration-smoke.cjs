'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {LOGIN_URL}=require('../src/vinted-login.cjs');
const html=`<!doctype html><meta charset="utf-8"><style>body{font:16px Arial;padding:24px}input,button{display:block;padding:12px;margin:12px}header{height:90px}img{width:32px;height:32px}</style>
<form method="post"><h2 id="auth_modal_title">Se connecter</h2><input id="username" name="username" placeholder="Identifiant ou adresse email" autocomplete="username"><input id="password" name="password" type="password" autocomplete="current-password"><button type="submit">Continuer</button><a href="/member/login/reset_password">Mot de passe oublié ?</a></form>
<script>window.fixture={submits:0,trusted:[],matched:false};document.querySelector('form').onsubmit=event=>{event.preventDefault();fixture.submits++;fixture.trusted.push(event.isTrusted);fixture.matched=document.querySelector('#username').value==='fixture_seller'&&document.querySelector('#password').value==='fixture-account-secret';if(fixture.matched){document.body.innerHTML='<header><div><button id="avatar" type="button"><img alt="fixture_seller" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22%20width=%2232%22%20height=%2232%22%3E%3Crect width=%2232%22%20height=%2232%22%20fill=%22gray%22/%3E%3C/svg%3E"></button><div id="menu" hidden><a href="/member/87654321">Mon profil</a><a href="/settings">Paramètres</a><a href="/orders">Mes commandes</a><button>Se déconnecter</button></div></div></header>';document.querySelector('#avatar').onclick=()=>document.querySelector('#menu').hidden=false;}};</script>`;

module.exports=async function accountsIntegration(api,check){
 const {BrowserWindow}=require('electron');assert.ok(process.env.ISOLA_TEST_DATA);
 let p,s,w,wrong;const c=api.getCommerce();
 try{
  p=api.saveProfile({name:'QA account center integration',url:'https://www.vinted.fr/',fingerprintMode:'native'});s=api.sesFor(p);s.protocol.handle('https',()=>new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}}));
  await api.openCommerce();const desk=api.getCommerceView().webContents;const js=code=>desk.executeJavaScript(code);
  let account;
  await check('account center IPC saves only encrypted credentials and emits a redacted account DTO',async()=>{
   const out=await js(`window.commerce.saveAccount({label:'Fixture account',login:'fixture_seller',profileId:${JSON.stringify(p.id)},password:'fixture-account-secret'})`);account=out.account;
   assert.equal(account.hasPassword,true);assert.equal(Object.hasOwn(account,'password'),false);assert.equal(Object.hasOwn(account,'encryptedPassword'),false);
   const raw=fs.readFileSync(c.accounts.file,'utf8');assert.doesNotMatch(raw,/fixture-account-secret|fixture_seller|Fixture account/);assert.doesNotMatch(JSON.stringify(await js('window.commerce.state()')),/fixture-account-secret/);
   return {encrypted:true,passwordReturned:false,fixtureOnly:true};
  });
  await check('untrusted renderer cannot invoke account credential operations',async()=>{
   wrong=new BrowserWindow({show:false,webPreferences:{preload:path.resolve(__dirname,'../src/commerce-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});await wrong.loadURL('about:blank');
   const denied=await wrong.webContents.executeJavaScript(`window.commerce.loginAccount(${JSON.stringify(account.id)}).then(()=>false,()=>true)`);assert.equal(denied,true);assert.equal(api.windows.has(p.id),false);wrong.destroy();wrong=null;
  });
  await check('saved account opens its bound environment and completes one native fixture login through main IPC',async()=>{
   const out=await js(`window.commerce.loginAccount(${JSON.stringify(account.id)})`);w=api.windows.get(p.id);assert.ok(w);const tab=w.tabs.find(t=>t.id===w.activeTab),actual=await tab.view.webContents.executeJavaScript('fixture');
   assert.equal(actual.submits,1,JSON.stringify(out));assert.deepEqual(actual.trusted,[true]);assert.equal(actual.matched,true);assert.equal(out.result.verified,true,JSON.stringify(out));assert.equal(out.account.identity.memberId,'87654321');assert.equal(c.db.marketAccounts.find(a=>a.profileId===p.id).memberId,'87654321');assert.doesNotMatch(JSON.stringify(out),/fixture-account-secret/);
   assert.equal(w.tabs[0].view.webContents.getURL(),'https://www.vinted.fr/');assert.equal(await w.tabs[0].view.webContents.executeJavaScript('fixture.submits'),0);assert.equal(tab.view.webContents.getURL(),LOGIN_URL);
   return {boundEnvironment:true,singleTrustedSubmit:true,identityReceipt:true,anonymousHomepagePreserved:true,liveVinted:false};
  });
  await check('existing verified session is reused without a second credential submit and profile data cannot be cleared',async()=>{
   const out=await js(`window.commerce.loginAccount(${JSON.stringify(account.id)})`);assert.equal(out.result.verified,true);assert.equal(await w.tabs.find(t=>t.id===w.activeTab).view.webContents.executeJavaScript('fixture.submits'),1);
   w.close();for(let i=0;i<100&&api.windows.has(p.id);i++)await new Promise(r=>setTimeout(r,20));await assert.rejects(api.clearProfile(p.id),/绑定了账号/);
  });
 }finally{if(w&&!w.isDestroyed())w.close();wrong?.destroy();await new Promise(r=>setTimeout(r,200));s?.protocol.unhandle('https');}
};
