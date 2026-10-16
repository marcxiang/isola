'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {CommerceEngine}=require('../src/commerce-engine.cjs');
const {VintedAdapter}=require('../src/vinted-adapter.cjs');
const {buildPublicationProof,PublicationJournal,FORM_URL}=require('../src/vinted-publication.cjs');
const {createAssociationService}=require('../src/commerce-association-service.cjs');
const PHOTO='https://fixture.test/photo.png',TITLE='Local test accessory',LISTING_URL='https://www.vinted.fr/items/98765-fixture';
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6n0AAAAASUVORK5CYII=','base64'),hash=value=>createHash('sha256').update(value).digest('hex');
const html=`<!doctype html><meta charset="utf-8"><style>body{font:16px Arial}header{height:100px}main{margin:25px}button,a{padding:10px;display:inline-block}img{width:60px;height:60px}#account{position:absolute;right:10px;top:10px;background:white}</style>
<header><div id="account"><button id="avatar" type="button" aria-expanded="true" aria-controls="menu"><img alt="fixture" src="https://fixture.test/avatar.png"></button><div id="menu" aria-labelledby="avatar"><a href="/member/123">Mon profil</a><button type="button">Paramètres</button><button type="button">Mes commandes</button><button type="button">Se déconnecter</button></div></div></header>
<main><section><h1>${TITLE}</h1><p id="price">5,00 €</p><p>5,95 €, frais Vinted inclus</p><button type="button" aria-label="${TITLE}"><img alt="${TITLE}" src="${PHOTO}"></button><a href="/member/123">fixture</a><button type="button">Modifier l'annonce</button><button type="button">Masquer</button><button type="button">Supprimer</button><a href="/member/items/close">Indiquer comme vendu</a><a href="/member/items/reservation">Marquer comme réservé</a></section></main><script>
window.fixtureClicks={accountMenu:[],marketplace:[]};document.querySelector('#avatar').onclick=()=>{const avatar=document.querySelector('#avatar'),open=avatar.getAttribute('aria-expanded')!=='true';avatar.setAttribute('aria-expanded',String(open));document.querySelector('#menu').style.display=open?'block':'none';};
document.addEventListener('click',event=>{const avatar=event.target.closest('#avatar');(avatar?fixtureClicks.accountMenu:fixtureClicks.marketplace).push({id:avatar?'avatar':event.target.id, trusted:event.isTrusted});});</script>`;
module.exports=async function(api,check){
 let profile,w,session;
 try{
  profile=api.saveProfile({name:'QA original listing association',url:LISTING_URL,fingerprintMode:'native',width:1280,height:900});session=api.sesFor(profile);
  session.protocol.handle('https',request=>new URL(request.url).host==='fixture.test'?new Response(image,{headers:{'content-type':'image/png'}}):new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}}));
  await api.launch(profile.id);w=api.windows.get(profile.id);const contents=w.tabs[0].view.webContents,profileId=profile.id,documentKey='original-form';
  w.show();w.focus();contents.focus();
  const menuOnlyClicks=async()=>{const clicks=await contents.executeJavaScript('({...fixtureClicks})');assert.deepEqual(clicks.marketplace,[]);assert.ok(clicks.accountMenu.length>0);assert.ok(clicks.accountMenu.every(click=>click.id==='avatar'&&click.trusted===true));return clicks.accountMenu.length;};
  const at=new Date().toISOString(),listing={title:TITLE,description:'Fixture only.',categoryPath:['Maison','Accessoires'],condition:'Neuf sans étiquette',brand:'Sans marque',color:'Noir',parcel:'Moyen'};
  const plan={id:'fixture-plan',profileId,productId:'fixture-product',sku:'FIXTURE',enabled:true,completedCount:0,targetCount:1,activeListingId:null,status:'ready',currency:'EUR',listingPriceCents:500,listing};
  const account={profileId,memberId:'123',profileURL:'https://www.vinted.fr/member/123',username:'fixture',platform:'vinted-fr',verifiedAt:at},claim={id:'claim-1',setId:'set-1',profileId,productId:plan.productId,images:[{id:'image-1'}],listings:[]};
  const proof=buildPublicationProof({plan,product:{id:plan.productId,sku:plan.sku,stock:1},claim,expectedAccount:account,evidence:{profileId,tabId:'original-tab',documentKey,url:FORM_URL,observedAt:at,challenge:false,account:{...account,verified:true},form:{documentKey,complete:true,invalidFields:[],unknownFields:[],fields:Object.entries({...listing,priceCents:500}).map(([field,value])=>({field,value,verified:true}))},photos:{documentKey,profileId,productId:plan.productId,claimId:claim.id,setId:claim.setId,count:1,signature:hash(JSON.stringify([hash(PHOTO)])),verified:true,busy:false,errorCount:0},publication:{documentKey,count:1,observed:true,label:'Ajouter',enabled:true}}});
  const journal=new PublicationJournal({persist:()=>{},dispatchEnabled:true}),record=await journal.prepare(proof);await journal.dispatchOnce(record.id,proof,async()=>{});
  const dir=fs.mkdtempSync(path.join(process.env.ISOLA_TEST_DATA,'association-')),adapter=new VintedAdapter({windows:api.windows}),engine=new CommerceEngine({dir,profiles:api.list,adapter,seal:x=>x,unseal:x=>x});
  Object.assign(engine.db,{plans:[plan],claims:[claim],marketAccounts:[account],publications:journal.state()});engine.persist();const service=createAssociationService();
  await check('real listing DOM and account reader issue an operator review without marketplace clicks',async()=>{
   const report=await service.inspect(engine,plan.id);assert.equal(report.readyForAssociation,true,JSON.stringify(report));assert.equal(report.listingId,'98765');assert.equal(report.photoSignatureMatched,true);assert.equal(await menuOnlyClicks(),1,'The initially expanded account menu closes once through native input');
   await contents.executeJavaScript('document.querySelector("#price").textContent="6,00 €"');await assert.rejects(service.associate(engine,plan.id,report.reviewToken));assert.equal(engine.db.publications.submissions[0].state,'uncertain');assert.equal(engine.db.plans[0].activeListingId,null);assert.equal(w.vintedDraftController,null);
  });
  await check('fresh detail re-read commits the original submission and photo history once with honest provenance',async()=>{
   await contents.executeJavaScript('document.querySelector("#price").textContent="5,00 €"');const report=await service.inspect(engine,plan.id);assert.equal(report.readyForAssociation,true,JSON.stringify(report));const result=await service.associate(engine,plan.id,report.reviewToken);assert.equal(result.associated,true);
   const db=JSON.parse(fs.readFileSync(engine.file));assert.equal(db.publications.submissions[0].attemptCount,1);assert.equal(db.publications.submissions[0].receipt.origin.kind,'operator_reviewed_listing');assert.equal(db.plans[0].activeListingId,'98765');assert.equal(db.claims[0].listings.length,1);assert.equal(db.publicationSupplierSync[0].attemptCount,0);const accountMenuClicks=await menuOnlyClicks();await assert.rejects(service.associate(engine,plan.id,report.reviewToken));assert.equal(await menuOnlyClicks(),accountMenuClicks,'A consumed association token must not reopen the account menu');
   assert.equal(w.vintedDraftController,null);return {localFixture:true,accountMenuClicks,marketplaceClicks:0,durableAssociation:true};
  });
 }finally{if(w&&!w.isDestroyed())w.destroy();if(session)session.protocol.unhandle('https');if(profile)await api.deleteProfile(profile.id);}
};
