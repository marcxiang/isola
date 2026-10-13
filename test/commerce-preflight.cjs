'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CommerceEngine,normalizeProduct}=require('../src/commerce-engine.cjs');
const {SKUDeskClient}=require('../src/sku-desk.cjs');
const {preflight,prepareDraft,collect,READ_TIMEOUT_MS,FIELD_TIMEOUT_MS}=require('../src/commerce-preflight.cjs');

const rawProduct={id:'supplier-test-id',sku:'test',name:'TEST ACCESSOIRE',description:'Accessoire de test, dimensions indiquées dans les photos.',stock:5,unit_price_cents:500,revision:1};
const page={url:'https://www.vinted.fr/items/new',title:'Vends tes articles',fields:[{label:'Titre',value:''}],accountLabel:'Fixture seller'};
const claim=(id,overrides={})=>({id,setId:'set-'+id,profileId:'profile-one',productId:rawProduct.id,listings:[],images:[{url:'/api/v1/photos/images/'+id}],...overrides});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

async function fixture(t,{product=rawProduct,sets=()=>({sets:[],total:0}),adapter={},listing={}}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-preflight-test-')),requests=[],prepared=[];
  const client=new SKUDeskClient({baseURL:'https://sku.example.test/api/v1',token:'FAKE-FIXTURE-TOKEN',fetchImpl:async(url,options)=>{
    const parsed=new URL(url);requests.push({method:options.method,path:parsed.pathname,query:Object.fromEntries(parsed.searchParams),signal:options.signal});
    assert.equal(options.method,'GET','Preflight must never claim photos, place orders or mark listings');
    let data;if(parsed.pathname==='/api/v1/products/supplier-test-id')data=typeof product==='function'?await product(options):{product};
    else if(parsed.pathname==='/api/v1/photos/sets')data=await sets(parsed.searchParams,options);
    else throw Error('Unexpected fixture request: '+parsed.pathname);
    return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
  }});
  const platform={readiness:()=>({vinted:'fixture_only'}),inspect:async()=>({...page}),prepareFields:async(profileId,value,{signal})=>{prepared.push({profileId,listing:value,signal});return {filled:['title','description','price'],missing:[],unresolved:[],draftComplete:false,published:false,saved:false};},...adapter};
  const engine=new CommerceEngine({dir,profiles:()=>[{id:'profile-one',name:'Fixture account'}],clientFactory:()=>client,adapter:platform,seal:s=>s,unseal:s=>s});
  t.after(async()=>{await engine.close();fs.rmSync(dir,{recursive:true,force:true});});
  await engine.saveSettings({baseURL:'https://sku.example.test/api/v1',token:'FAKE-FIXTURE-TOKEN',maxConcurrent:1});
  engine.db.products=[normalizeProduct({...rawProduct,name:'Old cached title',stock:99})];engine.db.photoSets=[{id:'other-product-set',productId:'other-product'}];
  const plan=engine.savePlan({profileId:'profile-one',productId:rawProduct.id,listingPriceCents:500,minOfferCents:200,targetCount:2,listing,enabled:false});
  return {engine,plan,requests,prepared,platform};
}

test('preflight preserves exact supplier identifiers and uses authenticated read-only client requests',async t=>{
  const f=await fixture(t),report=await preflight(f.engine,f.plan.id);
  assert.equal(report.product.id,'supplier-test-id');assert.equal(report.product.sku,'test');assert.equal(report.product.stock,5);assert.equal(report.product.priceCents,500);assert.equal(report.product.revision,1);
  assert.deepEqual(f.requests.map(r=>r.method),['GET','GET']);assert.equal(f.requests[0].path,'/api/v1/products/supplier-test-id');assert.deepEqual(f.requests[1].query,{productId:'supplier-test-id',page:'1',pageSize:'100'});assert.ok(f.requests.every(r=>r.signal instanceof AbortSignal));
  assert.equal(f.engine.db.claims.length,0);assert.equal(f.engine.db.jobs.length,0);assert.equal(f.engine.db.sales.length,0);assert.equal(f.prepared.length,0);assert.equal(f.engine.db.products[0].name,rawProduct.name);
});

test('mismatched product IDs or SKUs fail closed before photo reads, page inspection or cache writes',async t=>{
  for(const change of [{id:'another-product'},{sku:'TEST'}]){
    let inspections=0;const f=await fixture(t,{product:{...rawProduct,...change},adapter:{inspect:async()=>{inspections++;return page;}}}),before=fs.readFileSync(f.engine.file,'utf8');
    await assert.rejects(preflight(f.engine,f.plan.id),/编号或 SKU/);assert.equal(f.requests.length,1);assert.equal(inspections,0);assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);assert.equal(f.engine.db.products[0].name,'Old cached title');
  }
});

test('photo pagination counts available sets and only this browser profile owns reusable claims',async t=>{
  const f=await fixture(t,{sets:params=>Number(params.get('page'))===1?{sets:Array.from({length:100},(_,i)=>({id:'set-'+i,productId:rawProduct.id,status:'available',...(i===0?{claim:{id:'claim-other'},claimedByMe:true}:{})})),total:101}:{sets:[{id:'set-last',product_id:rawProduct.id,status:'claimed',claim:{id:'claim-last'},claimedByMe:true}],total:101}});
  f.engine.db.claims=[claim('own'),claim('different-browser',{profileId:'profile-two'}),claim('different-product',{productId:'other-product'})];
  const report=await preflight(f.engine,f.plan.id);assert.deepEqual(report.photos,{availableCount:99,ownCount:1,totalCount:101});assert.deepEqual(f.requests.slice(1).map(r=>r.query.page),['1','2']);
  assert.equal(f.engine.db.photoSets.length,102);assert.equal(f.engine.db.photoSets[0].id,'other-product-set');assert.equal(f.engine.db.photoSets.find(s=>s.id==='set-0').claimStatus,'claimed');assert.equal(f.engine.db.claims.length,3);
});

test('a foreign product photo or malformed later page cannot partially replace cached data',async t=>{
  for(const later of [{sets:[{id:'foreign-set',productId:'different-product',status:'available'}],total:101},{sets:null}]){
    const f=await fixture(t,{sets:params=>Number(params.get('page'))===1?{sets:Array.from({length:100},(_,i)=>({id:'set-'+i,productId:rawProduct.id,status:'available'})),total:101}:later}),before=fs.readFileSync(f.engine.file,'utf8');
    await assert.rejects(preflight(f.engine,f.plan.id),/图片套组/);assert.equal(f.requests.length,3);assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);assert.deepEqual(f.engine.db.photoSets,[{id:'other-product-set',productId:'other-product'}]);assert.equal(f.engine.db.products[0].name,'Old cached title');
  }
});

test('field readiness is separate from publishing and does not require or acquire photos',async t=>{
  const f=await fixture(t),report=await preflight(f.engine,f.plan.id);
  assert.equal(report.readyForFields,true);assert.equal(report.photos.totalCount,0);assert.equal(report.checks.find(c=>c.name==='图片套组').ok,false);assert.equal(report.checks.find(c=>c.name==='Vinted 分类').ok,false);assert.equal(report.checks.find(c=>c.name==='真实发布能力').ok,false);assert.ok(report.missing.some(text=>text.includes('发布回执')));
  const result=await prepareDraft(f.engine,f.plan.id);assert.equal(f.prepared.length,1);assert.equal(result.published,false);assert.equal(result.saved,false);assert.equal(result.draftComplete,false);assert.equal(f.engine.db.claims.length,0);assert.equal(f.engine.db.jobs.length,0);assert.ok(f.requests.every(r=>r.method==='GET'));
});

test('missing product description blocks form preparation rather than inventing details',async t=>{
  const f=await fixture(t,{product:{...rawProduct,description:'   '}}),result=await prepareDraft(f.engine,f.plan.id);
  assert.equal(result.preflight.readyForFields,false);assert.equal(result.preflight.listing.description,'');assert.ok(result.missing.some(text=>text.includes('描述')));assert.deepEqual(result.filled,[]);assert.equal(result.published,false);assert.equal(result.saved,false);assert.equal(f.prepared.length,0);
});

test('explicit listing values and sale price reach the adapter exactly, without substituting supplier cost or claims',async t=>{
  const listing={title:'Titre confirmé',description:'Description confirmée.\nDimensions : 10 cm.',categoryPath:['Maison','Décoration'],condition:'Très bon état',brand:'Sans marque',size:'Unique',color:'Noir',parcel:'Petit'};
  const f=await fixture(t,{product:{...rawProduct,unit_price_cents:125},listing});const result=await prepareDraft(f.engine,f.plan.id);
  assert.equal(f.prepared.length,1);assert.equal(f.prepared[0].profileId,f.plan.profileId);assert.deepEqual(f.prepared[0].listing,{...listing,priceCents:500});assert.ok(f.prepared[0].signal instanceof AbortSignal);assert.equal(result.preflight.product.priceCents,125);assert.equal(f.engine.db.claims.length,0);
});

test('a non-listing page or inspection error blocks field preparation',async t=>{
  for(const inspect of [async()=>({...page,url:'https://www.vinted.fr/inbox'}),async()=>({...page,url:'https://www.vinted.fr.example.test/items/new'}),async()=>{throw Error('Fixture window closed');}]){
    const f=await fixture(t,{adapter:{inspect}}),result=await prepareDraft(f.engine,f.plan.id);assert.equal(result.preflight.readyForFields,false);assert.equal(f.prepared.length,0);assert.equal(result.published,false);assert.equal(result.preflight.checks.find(c=>c.name==='法国站刊登页').ok,false);
  }
});

test('an abort after a slow product read prevents photo requests, inspection and stale cache commits',async t=>{
  const entered=deferred(),release=deferred();let requestSignal,inspections=0;
  const f=await fixture(t,{product:async options=>{requestSignal=options.signal;entered.resolve();await release.promise;return {product:{...rawProduct,name:'Late title'}};},adapter:{inspect:async()=>{inspections++;return page;}}});
  const before=fs.readFileSync(f.engine.file,'utf8'),pending=preflight(f.engine,f.plan.id);await entered.promise;f.engine.configController.abort();release.resolve();await assert.rejects(pending,e=>e.code==='STOPPED');
  assert.equal(requestSignal.aborted,true);assert.equal(f.requests.length,1);assert.equal(inspections,0);assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);assert.equal(f.engine.db.products[0].name,'Old cached title');
});

test('a failed final guard discards collected product, photo and page data without committing',async t=>{
  const f=await fixture(t,{sets:()=>({sets:[{id:'new-set',productId:rawProduct.id,status:'available'}],total:1})}),before=fs.readFileSync(f.engine.file,'utf8'),controller=new AbortController();let checks=0;
  await assert.rejects(collect(f.engine,f.plan.id,controller.signal,()=>{checks++;if(checks===5)throw Error('Fixture guard rejected stale page');}),/guard rejected/);
  assert.equal(checks,5);assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);assert.equal(f.engine.db.products[0].name,'Old cached title');assert.deepEqual(f.engine.db.photoSets,[{id:'other-product-set',productId:'other-product'}]);assert.equal(f.prepared.length,0);
});

test('abort after page field preparation cannot commit a success event or publish a listing',async t=>{
  const entered=deferred(),release=deferred();let signal;const f=await fixture(t,{adapter:{prepareFields:async(profileId,listing,options)=>{signal=options.signal;entered.resolve();await release.promise;return {filled:['title'],missing:[],unresolved:[],published:false,saved:false,draftComplete:false};}}});
  const pending=prepareDraft(f.engine,f.plan.id);await entered.promise;const before=fs.readFileSync(f.engine.file,'utf8'),events=f.engine.db.events.length;f.engine.configController.abort();release.resolve();await assert.rejects(pending,e=>e.code==='STOPPED');
  assert.equal(signal.aborted,true);assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);assert.equal(f.engine.db.events.length,events);assert.equal(f.engine.db.claims.length,0);assert.equal(f.engine.db.jobs.length,0);
});

test('only complete reusable same-profile claims contribute to the available-photo check',async t=>{
  const f=await fixture(t);f.engine.db.claims=[claim('valid'),claim('valid'),claim('used',{listings:[{listingId:'already-listed'}]}),claim('empty',{images:[]}),claim('foreign-url',{images:[{url:'https://another.example/photo.jpg'}]}),claim('missing-set',{setId:''}),claim('malformed-history',{listings:null}),claim('encoded-traversal',{images:[{url:'/api/v1/photos/%2e%2e/secret'}]})];
  let report=await preflight(f.engine,f.plan.id);assert.equal(report.photos.ownCount,2);f.plan.reuseOwnPhotos=false;report=await preflight(f.engine,f.plan.id);assert.equal(report.photos.ownCount,1);
  f.engine.db.claims=f.engine.db.claims.filter(c=>c.id!=='valid');report=await preflight(f.engine,f.plan.id);assert.equal(report.photos.ownCount,0);assert.equal(report.checks.find(c=>c.name==='图片套组').ok,false);assert.equal(report.readyForFields,true);
});

test('malformed page URLs become an actionable preflight check instead of crashing collection',async t=>{
  for(const inspected of [{...page,url:'not a URL'},{...page,url:null},null]){
    const f=await fixture(t,{adapter:{inspect:async()=>inspected}}),report=await preflight(f.engine,f.plan.id);
    assert.equal(report.readyForFields,false);assert.equal(report.page,null);assert.match(report.checks.find(c=>c.name==='法国站刊登页').detail,/页面地址/);assert.equal(f.engine.state().configBusy,false);assert.equal(f.prepared.length,0);
  }
});

test('a product read that ignores cancellation times out and cannot commit a late result',async t=>{
  const entered=deferred(),release=deferred();let requestSignal;const f=await fixture(t,{product:async options=>{requestSignal=options.signal;entered.resolve();await release.promise;return {product:{...rawProduct,name:'Too late'}};}}),before=fs.readFileSync(f.engine.file,'utf8');
  t.mock.timers.enable({apis:['setTimeout']});const pending=preflight(f.engine,f.plan.id),rejected=assert.rejects(pending,e=>e.code==='READ_TIMEOUT');await entered.promise;t.mock.timers.tick(READ_TIMEOUT_MS);await rejected;
  assert.equal(requestSignal.aborted,true);assert.equal(f.engine.state().configBusy,false);assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);release.resolve();await Promise.resolve();await Promise.resolve();assert.equal(f.engine.db.products[0].name,'Old cached title');t.mock.timers.reset();
});

test('a hanging page inspection times out into a failed page check and releases the configuration lock',async t=>{
  const entered=deferred(),release=deferred();let pageSignal;const f=await fixture(t,{adapter:{inspect:async(profileId,{signal})=>{pageSignal=signal;entered.resolve();await release.promise;return page;}}});
  t.mock.timers.enable({apis:['setTimeout']});const pending=preflight(f.engine,f.plan.id);await entered.promise;t.mock.timers.tick(READ_TIMEOUT_MS);const report=await pending;
  assert.equal(pageSignal.aborted,true);assert.equal(report.readyForFields,false);assert.equal(report.page,null);assert.match(report.checks.find(c=>c.name==='法国站刊登页').detail,/超时/);assert.equal(f.engine.state().configBusy,false);release.resolve();await Promise.resolve();t.mock.timers.reset();
});

test('a hanging field adapter is cancelled without a success event or a complete-draft claim',async t=>{
  const entered=deferred(),release=deferred();let fieldSignal;const f=await fixture(t,{adapter:{prepareFields:async(profileId,listing,{signal})=>{fieldSignal=signal;entered.resolve();await release.promise;return {filled:['title'],published:false,saved:false,draftComplete:true};}}});
  t.mock.timers.enable({apis:['setTimeout']});const pending=prepareDraft(f.engine,f.plan.id),rejected=assert.rejects(pending,e=>e.code==='FIELD_TIMEOUT');await entered.promise;const before=fs.readFileSync(f.engine.file,'utf8');t.mock.timers.tick(FIELD_TIMEOUT_MS);await rejected;
  assert.equal(fieldSignal.aborted,true);assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);assert.equal(f.engine.state().configBusy,false);release.resolve();await Promise.resolve();await Promise.resolve();assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);t.mock.timers.reset();
});

test('field-only results never claim a full draft and reject unexpected publication receipts',async t=>{
  const f=await fixture(t,{adapter:{prepareFields:async()=>({filled:['title'],draftComplete:true,published:false,saved:false})}});const result=await prepareDraft(f.engine,f.plan.id);assert.equal(result.draftComplete,false);assert.equal(result.published,false);assert.equal(result.saved,false);
  f.platform.prepareFields=async()=>({filled:['title'],published:true,saved:true});const before=f.engine.db.events.length;await assert.rejects(prepareDraft(f.engine,f.plan.id),/字段填写结果格式/);assert.equal(f.engine.db.events.length,before);
});

test('a bare product object remains supported while malformed product envelopes fail closed',async t=>{
  const f=await fixture(t,{product:async()=>({...rawProduct})});const report=await preflight(f.engine,f.plan.id);assert.equal(report.product.id,rawProduct.id);assert.equal(report.product.sku,'test');
  for(const response of [{product:null},{product:[]},{product:'wrong-shape'}]){
    const malformed=await fixture(t,{product:async()=>response}),before=fs.readFileSync(malformed.engine.file,'utf8');await assert.rejects(preflight(malformed.engine,malformed.plan.id),/商品详情返回格式/);assert.equal(malformed.requests.length,1);assert.equal(fs.readFileSync(malformed.engine.file,'utf8'),before);
  }
});

test('a hanging later photo page times out without replacing any earlier catalog or photo cache',async t=>{
  const entered=deferred(),release=deferred();let requestSignal;const f=await fixture(t,{sets:async(params,options)=>{
    if(params.get('page')==='1')return {sets:Array.from({length:100},(_,i)=>({id:'set-'+i,productId:rawProduct.id,status:'available'})),total:101};
    requestSignal=options.signal;entered.resolve();await release.promise;return {sets:[{id:'late',productId:rawProduct.id,status:'available'}],total:101};
  }}),before=fs.readFileSync(f.engine.file,'utf8');
  t.mock.timers.enable({apis:['setTimeout']});const pending=preflight(f.engine,f.plan.id),rejected=assert.rejects(pending,e=>e.code==='READ_TIMEOUT');await entered.promise;t.mock.timers.tick(READ_TIMEOUT_MS);await rejected;
  assert.equal(requestSignal.aborted,true);assert.equal(f.engine.state().configBusy,false);assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);assert.equal(f.engine.db.photoSets.length,1);release.resolve();await Promise.resolve();await Promise.resolve();assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);t.mock.timers.reset();
});
