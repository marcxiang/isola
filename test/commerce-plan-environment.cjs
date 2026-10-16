'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CommerceEngine}=require('../src/commerce-engine.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const listing={title:'Environment scoped draft',description:'A complete local fixture description.',categoryPath:['Maison','Accessoires'],condition:'Très bon état',brand:'Sans marque',color:'Noir',parcel:'Moyen'};
const input=(changes={})=>({profileId:'environment-profile',productId:'environment-product',sku:'ENVIRONMENT-SKU',targetCount:1,listingPriceCents:500,minOfferCents:400,enabled:false,listing,...changes});
function fixture(t,windowType='automation'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-plan-environment-')),profile={id:'environment-profile',name:'Environment fixture',status:'closed',windowType},calls=[];
 const adapter={readiness:()=>({salesOnly:true,capabilities:{publish:true,autoOpenProfile:true}}),requireReady:async()=>{calls.push('requireReady');},poll:async()=>{calls.push('poll');return [];},maintenance:async()=>{calls.push('maintenance');},executeJob:async()=>{calls.push('executeJob');}};
 const engine=new CommerceEngine({dir,profiles:()=>[profile],adapter,clientFactory:()=>{calls.push('supplier');throw Error('No supplier request expected');},seal:value=>value,unseal:value=>value});
 engine.db.products=[{id:'environment-product',sku:'ENVIRONMENT-SKU',name:'Environment product',stock:2,priceCents:100,photoSetsAvailable:1}];
 engine.db.settings.backgroundEnabled=true;engine.db.encryptedToken='isolated-fixture-token';engine.db.supplierAccountId='isolated-fixture-supplier';
 engine.bindMarketAccount(profile.id,{verified:true,memberId:'7654321',username:'environment_fixture',profileURL:'https://www.vinted.fr/member/7654321'});
 t.after(async()=>{await engine.close();const absolute=path.resolve(dir);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.ok(path.basename(absolute).startsWith('isola-plan-environment-'));fs.rmSync(absolute,{recursive:true,force:true});});
 return {engine,profile,calls};
}
function unchanged(f,action){
 const before=clone(f.engine.db),disk=fs.readFileSync(f.engine.file,'utf8'),scope=f.engine.runningPlanIds;
 assert.throws(action,{code:'PROFILE_NOT_AUTOMATION'});
 assert.deepEqual(f.engine.db,before);assert.equal(fs.readFileSync(f.engine.file,'utf8'),disk);
 assert.equal(f.engine.running,false);assert.equal(f.engine.runningPlanIds,scope);assert.equal(f.engine.timer,null);assert.equal(f.engine.db.jobs.length,0);assert.deepEqual(f.calls,[]);
}

test('new plans reject explicitly normal and unknown environment types without writing or starting',async t=>{
 for(const value of ['normal','unknown','',null,false])await t.test(JSON.stringify(value),sub=>{
  const f=fixture(sub,value);unchanged(f,()=>f.engine.savePlan(input()));unchanged(f,()=>f.engine.saveAndStartPlan(input({enabled:true})));
 });
});

test('a new plan belongs to its explicit automation environment and stays silent when saved',t=>{
 const f=fixture(t),plan=f.engine.savePlan(input());
 assert.equal(plan.profileId,f.profile.id);assert.equal(plan.enabled,false);assert.equal(f.engine.db.plans.length,1);assert.equal(f.engine.running,false);assert.equal(f.engine.timer,null);assert.equal(f.engine.db.jobs.length,0);assert.deepEqual(f.calls,[]);
 const persisted=JSON.parse(fs.readFileSync(f.engine.file,'utf8'));assert.deepEqual(persisted.plans,[plan]);
});

test('existing normal environment plans retain their identity and independent listing snapshot when edited',t=>{
 const f=fixture(t),plan=f.engine.savePlan(input()),id=plan.id,createdAt=plan.createdAt;f.profile.windowType='normal';
 const edited=f.engine.savePlan({...plan,listingPriceCents:600,minOfferCents:450,listing:{...listing,title:'Updated legacy plan'}});
 assert.deepEqual(edited,plan);assert.equal(f.engine.db.plans[0],plan);assert.equal(edited.id,id);assert.equal(edited.createdAt,createdAt);assert.equal(edited.profileId,f.profile.id);assert.equal(edited.listingPriceCents,600);assert.equal(edited.listing.title,'Updated legacy plan');assert.equal(f.engine.db.plans.length,1);assert.equal(f.engine.running,false);assert.deepEqual(f.calls,[]);
});

test('older pure engine profile callbacks without a windowType remain compatible',t=>{
 const f=fixture(t);delete f.profile.windowType;const plan=f.engine.savePlan(input());
 assert.equal(plan.profileId,f.profile.id);assert.equal(f.engine.db.plans.length,1);assert.equal(f.engine.running,false);assert.deepEqual(f.calls,[]);
});

test('changing an automation environment to normal after form capture rejects save and start atomically',async t=>{
 const f=fixture(t),capturedInput=input({enabled:true}),saved=f.engine.savePlan(input({enabled:false}));
 // Retain an unrelated plan and its event history while testing a newly opened form.
 f.engine.db.products.push({id:'second-environment-product',sku:'ENVIRONMENT-SKU-2',name:'Second product',stock:2,priceCents:100,photoSetsAvailable:1});f.engine.persist();
 capturedInput.productId='second-environment-product';capturedInput.sku='ENVIRONMENT-SKU-2';const original=clone(saved);
 f.profile.windowType='normal';let writes=0,emits=0;const persist=f.engine.persist,emit=f.engine.emit;
 f.engine.persist=function(){writes++;return persist.call(this);};f.engine.emit=function(){emits++;return emit.call(this);};
 unchanged(f,()=>f.engine.saveAndStartPlan(capturedInput));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(writes,0);assert.equal(emits,0);assert.deepEqual(f.engine.db.plans,[original]);assert.equal(saved.enabled,false);assert.equal(f.engine.running,false);assert.deepEqual(f.engine.state().runningPlanIds,[]);assert.deepEqual(f.calls,[]);
 f.engine.persist=persist;f.engine.emit=emit;
});
