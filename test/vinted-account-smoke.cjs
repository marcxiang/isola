const assert=require('node:assert/strict');
const {VintedAdapter}=require('../src/vinted-adapter.cjs');
const {VintedAccount}=require('../src/vinted-account.cjs');
const FORM='https://www.vinted.fr/items/new';
const html=`<!doctype html><meta charset="utf-8"><title>Local account menu fixture</title>
<style>body{font:16px Arial}header{height:80px}#account{display:inline-block;position:relative;margin:10px}button{padding:8px}img{width:32px;height:32px}#menu{position:absolute;top:50px;width:230px;background:white;border:1px solid #888;padding:10px;z-index:3}#menu a,#menu button{display:block;margin:6px}main{margin:40px}input,textarea{display:block;width:380px}</style>
<header><div id="account"><button id="avatar" type="button"><img alt="fixture_seller" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' fill='gray'/%3E%3C/svg%3E"></button>
<div id="menu" hidden><a href="/member/123456">Mon profil</a><a href="/settings">Paramètres</a><a href="/orders">Mes commandes</a><button type="button">Se déconnecter</button></div></div></header>
<main><form><label for="title">Titre</label><input id="title" value="Existing fixture title"><label for="description">Description</label><textarea id="description">Existing fixture details</textarea><button type="submit">Ajouter</button></form></main>
<script>window.fixture={avatarClicks:0,trusted:[],menuActions:0,submits:0};document.querySelector('#avatar').onclick=e=>{fixture.avatarClicks++;fixture.trusted.push(e.isTrusted);document.querySelector('#menu').hidden=false;};document.querySelector('#menu').onclick=e=>{e.preventDefault();fixture.menuActions++;};document.querySelector('form').onsubmit=e=>{e.preventDefault();fixture.submits++;};</script>`;

module.exports=async function accountSmoke(api,check){
  let profile,w,session;
  try{
    profile=api.saveProfile({name:'QA local account menu',url:FORM,fingerprintMode:'native',width:1180,height:900});session=api.sesFor(profile);
    session.protocol.handle('https',request=>new URL(request.url).pathname==='/items/new'?new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}}):new Response('Not found',{status:404}));
    await api.launch(profile.id);w=api.windows.get(profile.id);const tab=w.tabs[0],contents=tab.view.webContents,adapter=new VintedAdapter({windows:api.windows}),account=new VintedAccount(adapter);
    await check('account menu uses one trusted avatar click and preserves every listing field',async()=>{
      const out=await account.inspectAccount(profile.id);const actual=await contents.executeJavaScript('({...fixture,title:document.querySelector("#title").value,description:document.querySelector("#description").value})');
      assert.equal(out.memberId,'123456');assert.equal(out.username,'fixture_seller');assert.equal(out.profileURL,'https://www.vinted.fr/member/123456');assert.equal(out.menuOpened,true);assert.equal(out.menuClosed,false);assert.equal(actual.avatarClicks,1);assert.deepEqual(actual.trusted,[true]);assert.equal(actual.menuActions,0);assert.equal(actual.submits,0);assert.equal(actual.title,'Existing fixture title');assert.equal(actual.description,'Existing fixture details');assert.equal(adapter.readiness().capabilities.publish,false);
      return {memberId:'fixture-only',trustedClicks:1,menuActions:0,fieldsPreserved:true,source:'local fixture of observed French account-menu structure'};
    });
    await check('account read reuses the expanded menu with no additional click or navigation',async()=>{const out=await account.inspectAccount(profile.id);assert.equal(out.menuOpened,false);assert.equal(await contents.executeJavaScript('fixture.avatarClicks'),1);assert.equal(contents.getURL(),FORM);});
    await check('account read refuses ambiguous header avatar buttons before clicking',async()=>{await contents.loadURL(FORM);await contents.executeJavaScript('document.querySelector("#account").append(document.querySelector("#avatar").cloneNode(true))');await assert.rejects(account.inspectAccount(profile.id),{code:'ACCOUNT_UNVERIFIED'});assert.equal(await contents.executeJavaScript('fixture.avatarClicks'),0);});
    await check('account read cannot adopt an unrelated profile menu placed in the page body',async()=>{await contents.loadURL(FORM);await contents.executeJavaScript('const menu=document.querySelector("#menu");document.body.append(menu);menu.hidden=false;');await assert.rejects(account.inspectAccount(profile.id),{code:'ACCOUNT_UNVERIFIED'});assert.equal(await contents.executeJavaScript('fixture.avatarClicks'),0);});
    await check('account cancellation during visual feedback prevents the avatar click',async()=>{await contents.loadURL(FORM);const old=tab.controlFeedback;tab.controlFeedback=async()=>w.vintedDraftController.abort();try{await assert.rejects(account.inspectAccount(profile.id));assert.equal(await contents.executeJavaScript('fixture.avatarClicks'),0);assert.equal(w.vintedDraftController,null);}finally{tab.controlFeedback=old;}});
  }finally{if(w&&!w.isDestroyed())w.close();await new Promise(resolve=>setTimeout(resolve,200));if(session)session.protocol.unhandle('https');if(profile)await api.deleteProfile(profile.id);}
};
