'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CommerceEngine}=require('../src/commerce-engine.cjs');
const {preparePhotos,readPreparedPhotos,MAX_IMAGE_BYTES,READ_TIMEOUT_MS}=require('../src/commerce-photos.cjs');
const baseURL='https://sku.example.test/api/v1';
const profiles=[{id:'profile-1',name:'First'},{id:'profile-2',name:'Second'}];
const product={id:'product-1',sku:'SKU TEST',name:'Fixture item',stock:5,unit_price_cents:500};
const set={id:'set-1',product_id:product.id,status:'available',image_count:2};
const receipt={claimId:'claim-1',set:{id:set.id,product_id:product.id,images:[{id:'image-1',url:'/api/v1/photos/images/image-1'},{id:'image-2',url:'/api/v1/photos/images/image-2'}]}};
// Structural JPEG fixture. Decoding is deliberately injected; nativeImage is an
// Electron integration responsibility, not claimed to be tested by this stub.
function jpeg(width=10,height=20,tail=0){return Buffer.from([255,216,255,192,0,17,8,height>>8,height&255,width>>8,width&255,3,1,17,0,2,17,1,3,17,1,255,218,0,12,3,1,0,2,17,3,17,0,63,0,tail,255,217]);}
const decode=()=>({width:10,height:20});
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};
async function fixture(t,{client:overrides={},onChange=()=>{}}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-photos-test-')),calls=[];
 const client={me:async()=>({user:{id:'supplier-1'}}),product:async()=>({product}),photoSets:async()=>({sets:[set],total:1}),photoSet:async()=>({set}),claimPhotos:async()=>structuredClone(receipt),download:async()=>jpeg(),...overrides};
 for(const name of Object.keys(client)){const method=client[name];client[name]=async(...args)=>{calls.push({name,args});return method(...args);};}
 const options={dir,profiles:()=>profiles,clientFactory:()=>client,adapter:{readiness:()=>({capabilities:{publish:false}})},seal:s=>s,unseal:s=>s,onChange};
 let engine=new CommerceEngine(options);engine.db.settings.baseURL=baseURL;engine.db.encryptedToken='fixture-token';engine.db.supplierAccountId='supplier-1';engine.db.products=[{...product,priceCents:500}];engine.persist();
 const plan=engine.savePlan({profileId:'profile-1',productId:product.id,targetCount:2,listingPriceCents:500,minOfferCents:200,reuseOwnPhotos:true,enabled:false});
 t.after(async()=>{await engine.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {get engine(){return engine;},plan,client,calls,dir,options,prepare:options=>preparePhotos(engine,plan.id,{validateImage:decode,...options}),restart:async()=>{await engine.close();engine=new CommerceEngine(options);return engine;}};
}
function saved(f){return JSON.parse(fs.readFileSync(f.engine.file,'utf8'));}

test('preparation persists exact request before claiming, saves private JPEGs, and returns only a sanitized public summary',async t=>{
 let f;f=await fixture(t,{client:{claimPhotos:async(payload,options)=>{const row=saved(f).photoPreparations[0];assert.equal(row.state,'claiming');assert.deepEqual(row.payload,{productId:product.id,setId:set.id});assert.deepEqual(payload,row.payload);assert.equal(options.idempotencyKey,row.idempotencyKey);assert.ok(fs.existsSync(path.join(f.dir,'prepared-photos',row.id)));return receipt;}}});
 const result=await f.prepare();assert.equal(result.summary.ready,true);assert.equal(result.manifest.count,2);assert.equal(result.manifest.claimId,'claim-1');assert.equal(f.engine.db.claims.length,1);assert.equal(f.engine.db.jobs.length,0);assert.equal(f.plan.enabled,false);
 for(const file of result.manifest.files){assert.equal(fs.statSync(file.path).mode&0o777,0o600);assert.equal(fs.statSync(path.dirname(file.path)).mode&0o777,0o700);assert.equal(file.width,10);assert.equal(file.height,20);assert.match(file.sha256,/^[a-f0-9]{64}$/);}
 const publicJSON=JSON.stringify([result.summary,f.engine.state().photoPreparations]);for(const secret of ['fixture-token',baseURL,'/photos/images/','prepared-photos','idempotencyKey','payload','receipt','fileName'])assert.equal(publicJSON.includes(secret),false);
 assert.ok(f.calls.filter(c=>c.name==='download').every(c=>c.args[1].maxBytes===MAX_IMAGE_BYTES));assert.deepEqual(readPreparedPhotos(f.engine,f.plan.id),result);
});

test('repeated and concurrent preparation reuses one fixed claim and ordered files through configure serialization',async t=>{
 const f=await fixture(t);const results=await Promise.all([f.prepare(),f.prepare()]);assert.equal(f.calls.filter(c=>c.name==='claimPhotos').length,1);assert.equal(f.calls.filter(c=>c.name==='download').length,2);assert.deepEqual(results[0].manifest,results[1].manifest);assert.equal(f.engine.configPending,0);
});

test('restart after an uncertain claim replays exactly the original key, body and set rather than selecting another',async t=>{
 let attempts=0;const f=await fixture(t,{client:{claimPhotos:async()=>{if(++attempts===1)throw Error('fixture network failure');return receipt;}}});
 await assert.rejects(f.prepare());const first=saved(f).photoPreparations[0];assert.equal(first.state,'uncertain');assert.equal(first.receipt,undefined);await f.restart();
 await assert.rejects(f.prepare({setId:'another-set'}),{code:'PHOTO_CONFLICT'});assert.equal(saved(f).photoPreparations[0].state,'uncertain');
 const result=await f.prepare(),requests=f.calls.filter(c=>c.name==='claimPhotos');assert.equal(result.summary.ready,true);assert.equal(requests.length,2);assert.deepEqual(requests[1].args[0],requests[0].args[0]);assert.equal(requests[1].args[1].idempotencyKey,requests[0].args[1].idempotencyKey);assert.equal(f.calls.filter(c=>c.name==='photoSet').length,1);
});

test('cancellation observed after the receipt is saved cannot lose the permanent claim or issue another claim on restart',async t=>{
 const controller=new AbortController();let enabled=false;const f=await fixture(t,{onChange:state=>{if(enabled&&state.photoPreparations[0]?.state==='receipt_saved')controller.abort();}});enabled=true;
 await assert.rejects(f.prepare({signal:controller.signal}),{code:'STOPPED'});const row=saved(f).photoPreparations[0];assert.deepEqual(row.receipt,receipt);assert.equal(row.state,'needs_review');assert.equal(f.calls.filter(c=>c.name==='download').length,0);
 enabled=false;await f.restart();assert.equal((await f.prepare()).summary.ready,true);assert.equal(f.calls.filter(c=>c.name==='claimPhotos').length,1);
});

test('partial downloads resume after restart using the saved receipt and never re-download an already verified file',async t=>{
 let fail=true;const f=await fixture(t,{client:{download:async url=>{if(url.endsWith('image-2')&&fail)throw Error('fixture interrupted download');return jpeg();}}});
 await assert.rejects(f.prepare());let row=saved(f).photoPreparations[0];assert.equal(row.assets.length,1);assert.equal(row.assets[0].ready,true);assert.equal(row.claimId,'claim-1');fail=false;await f.restart();
 assert.equal((await f.prepare()).manifest.count,2);assert.equal(f.calls.filter(c=>c.name==='claimPhotos').length,1);assert.equal(f.calls.filter(c=>c.name==='download'&&c.args[0].endsWith('image-1')).length,1);
});

test('a file committed before its ready flag recovers without another download, and missing files require the original hash',async t=>{
 const f=await fixture(t);let result=await f.prepare(),record=f.engine.db.photoPreparations[0];record.assets[0].ready=false;record.state='downloading';f.engine.persist();await f.restart();assert.equal(f.engine.db.photoPreparations[0].state,'receipt_saved');
 result=await f.prepare();assert.equal(result.summary.ready,true);assert.equal(f.calls.filter(c=>c.name==='download').length,2);
 fs.unlinkSync(result.manifest.files[0].path);assert.equal(readPreparedPhotos(f.engine,f.plan.id).manifest,null);assert.equal((await f.prepare()).summary.ready,true);assert.equal(f.calls.filter(c=>c.name==='claimPhotos').length,1);assert.equal(f.calls.filter(c=>c.name==='download').length,3);
 fs.unlinkSync(result.manifest.files[0].path);f.client.download=async()=>jpeg(10,20,1);await assert.rejects(f.prepare(),{code:'PHOTO_IMAGE'});assert.equal(fs.existsSync(result.manifest.files[0].path),false);
});

test('same supplier ownership cannot transfer photos between browser environments, including uncertain local reservations',async t=>{
 const f=await fixture(t,{client:{claimPhotos:async()=>{throw Error('unknown claim');}}});await assert.rejects(f.prepare());
 const second=f.engine.savePlan({...f.plan,id:undefined,profileId:'profile-2'});await assert.rejects(preparePhotos(f.engine,second.id,{setId:set.id,validateImage:decode}),{code:'PHOTO_CONFLICT'});await assert.rejects(preparePhotos(f.engine,second.id,{validateImage:decode}),{code:'PHOTO_EMPTY'});assert.equal(f.calls.filter(c=>c.name==='claimPhotos').length,1);
 const own=await fixture(t,{client:{photoSets:async()=>({sets:[{...set,claim:{id:'someone-elses-window'},claimedByMe:true}],total:1})}});await assert.rejects(own.prepare(),{code:'PHOTO_EMPTY'});assert.equal(own.calls.some(c=>c.name==='claimPhotos'),false);
});

test('wrong supplier account, product, SKU or set ownership stops before permanent claiming',async t=>{
 for(const client of [{me:async()=>({user:{id:'supplier-other'}})},{product:async()=>({product:{...product,id:'wrong-product'}})},{product:async()=>({product:{...product,sku:'Wrong SKU'}})},{photoSet:async()=>({set:{...set,product_id:'wrong-product'}})},{photoSet:async()=>({set:{...set,status:'claimed',claim:{id:'existing'}}})}]){
  const f=await fixture(t,{client});await assert.rejects(f.prepare());assert.equal(f.calls.some(c=>c.name==='claimPhotos'),false);assert.equal(f.engine.db.photoPreparations.length,0);
 }
});

test('receipt set/product mismatch, duplicate images and unsafe or preview URLs persist the receipt but never download or claim anew',async t=>{
 const cases=[{...receipt,set:{...receipt.set,id:'wrong-set'}},{...receipt,set:{...receipt.set,product_id:'wrong-product'}},{...receipt,set:{...receipt.set,images:[receipt.set.images[0],receipt.set.images[0]]}},...['https://other.test/api/v1/photos/images/x','/api/v1/photos/images/x?thumbnail=1','/api/v1/photos/%2e%2e/x','https://user:password@sku.example.test/api/v1/photos/images/x','/api/v1/products/x/image'].map(url=>({...receipt,set:{...receipt.set,images:[{url}]}}))];
 for(const response of cases){const f=await fixture(t,{client:{claimPhotos:async()=>response}});await assert.rejects(f.prepare());assert.ok(saved(f).photoPreparations[0].receipt);await f.restart();await assert.rejects(f.prepare());assert.equal(f.calls.filter(c=>c.name==='claimPhotos').length,1);assert.equal(f.calls.filter(c=>c.name==='download').length,0);}
});

test('JPEG structure, size, pixel limits and injected decoder failure cannot produce a trusted manifest',async t=>{
 for(const [bytes,validateImage] of [[Buffer.from('not a JPEG'),decode],[jpeg(1201,20),decode],[jpeg().subarray(0,-2),decode],[Buffer.alloc(MAX_IMAGE_BYTES+1),decode],[jpeg(),()=>({width:1,height:1})],[jpeg(),()=>{throw Error('decoder rejected');}]]){
  const f=await fixture(t,{client:{download:async()=>bytes}});await assert.rejects(f.prepare({validateImage}));assert.equal(readPreparedPhotos(f.engine,f.plan.id).manifest,null);assert.equal(f.engine.db.photoPreparations[0].assets.length,0);assert.equal(f.calls.filter(c=>c.name==='claimPhotos').length,1);
 }
 const missing=await fixture(t);await assert.rejects(preparePhotos(missing.engine,missing.plan.id),{code:'PHOTO_DECODER'});assert.equal(missing.calls.length,0);
});

test('modified files, excessive permissions and symlink cache directories never produce trusted files',async t=>{
 for(const mutate of [(file)=>fs.writeFileSync(file,jpeg(10,20,7)),file=>fs.chmodSync(file,0o644),file=>{fs.unlinkSync(file);fs.symlinkSync('/dev/null',file); }]){const f=await fixture(t),result=await f.prepare();mutate(result.manifest.files[0].path);assert.equal(readPreparedPhotos(f.engine,f.plan.id).manifest,null);await assert.rejects(f.prepare(),{code:'PHOTO_STORAGE'});assert.equal(f.calls.filter(c=>c.name==='claimPhotos').length,1);}
 const f=await fixture(t);fs.symlinkSync(os.tmpdir(),path.join(f.dir,'prepared-photos'));await assert.rejects(f.prepare(),{code:'PHOTO_STORAGE'});assert.equal(f.calls.filter(c=>c.name==='claimPhotos').length,0);
});

test('cancelling a claim retains a returned receipt before releasing configure, while timeout preserves uncertainty and ignores late completion',async t=>{
 for(const mode of ['abort','timeout']){const entered=deferred(),release=deferred(),controller=new AbortController();let requestSignal;const f=await fixture(t,{client:{claimPhotos:async(_body,options)=>{requestSignal=options.signal;entered.resolve();return release.promise;}}});
  if(mode==='timeout')t.mock.timers.enable({apis:['setTimeout']});const pending=f.prepare({signal:controller.signal}),rejected=assert.rejects(pending,e=>e.code===(mode==='timeout'?'PHOTO_TIMEOUT':'STOPPED'));await entered.promise;
  if(mode==='timeout')t.mock.timers.tick(READ_TIMEOUT_MS);else{controller.abort();release.resolve(receipt);}await rejected;assert.equal(requestSignal.aborted,true);assert.equal(f.engine.configPending,0);assert.equal(saved(f).photoPreparations[0].state,mode==='timeout'?'uncertain':'needs_review');release.resolve(receipt);await Promise.resolve();await Promise.resolve();assert.deepEqual(f.engine.db.photoPreparations[0].receipt,mode==='timeout'?undefined:receipt);assert.equal(f.calls.some(c=>c.name==='download'),false);if(mode==='timeout')t.mock.timers.reset();
 }
});

test('configuration is serialized with photo preparation and a storage fault prevents the first claim',async t=>{
 const entered=deferred(),release=deferred();const f=await fixture(t,{client:{download:async()=>{entered.resolve();await release.promise;return jpeg();}}});const preparing=f.prepare();await entered.promise;let configured=false;const configuring=f.engine.configure(async()=>{configured=true;});await Promise.resolve();assert.equal(configured,false);assert.throws(()=>f.engine.setRunning(true),/配置/);release.resolve();await preparing;await configuring;assert.equal(configured,true);
 const broken=await fixture(t),original=broken.engine.persist.bind(broken.engine);broken.engine.persist=()=>{if(broken.engine.db.photoPreparations.length){broken.engine.faulted=true;throw Error('fixture disk error');}return original();};await assert.rejects(broken.prepare());assert.equal(broken.calls.some(c=>c.name==='claimPhotos'),false);
});

test('photo history locks plan identity and supplier changes, while old databases migrate only by adding an empty history',async t=>{
 const f=await fixture(t);await f.prepare();assert.throws(()=>f.engine.savePlan({...f.plan,profileId:'profile-2'}),/不能更换/);await assert.rejects(f.engine.saveSettings({baseURL:'https://another.example.test/api/v1'}),/另一货盘/);
 f.engine.db.products[0].sku='renamed SKU';assert.throws(()=>f.engine.savePlan({...f.plan}),/不能更换 SKU/);f.engine.db.products[0].sku=product.sku;
 f.plan.reuseOwnPhotos=false;f.engine.db.claims[0].listings.push({listingId:'listed'});f.engine.persist();await assert.rejects(f.prepare(),{code:'PHOTO_USED'});
 const old=await fixture(t),data=saved(old);delete data.photoPreparations;fs.writeFileSync(old.engine.file,JSON.stringify(data));const migrated=new CommerceEngine(old.options);assert.deepEqual(migrated.db.photoPreparations,[]);await migrated.close();
});

test('inconsistent local claim ownership or image order invalidates a manifest and cannot trigger another claim',async t=>{
 for(const mutate of [c=>c.setId='another-set',c=>c.profileId='profile-2',c=>c.images.reverse(),c=>c.listings=null]){
  const f=await fixture(t);await f.prepare();mutate(f.engine.db.claims[0]);assert.equal(readPreparedPhotos(f.engine,f.plan.id).manifest,null);await assert.rejects(f.prepare(),{code:'PHOTO_CONFLICT'});assert.equal(f.calls.filter(c=>c.name==='claimPhotos').length,1);
 }
});

test('restart recovers claiming state and rejects corrupted, duplicate or identity-shifted histories without rewriting the source',async t=>{
 const f=await fixture(t);await f.prepare();const good=saved(f);
 for(const change of [d=>d.photoPreparations=null,d=>d.photoPreparations=[null],d=>d.photoPreparations[0].state='invented',d=>d.photoPreparations.push(structuredClone(d.photoPreparations[0])),d=>d.photoPreparations[0].payload.setId='another',d=>d.photoPreparations[0].receipt.set.id='another',d=>d.photoPreparations[0].assets[0].fileName='../outside.jpg',d=>d.photoPreparations[0].assets[0].width=2000,d=>d.plans[0].profileId='profile-2']){
  const data=structuredClone(good);change(data);const bytes=JSON.stringify(data);fs.writeFileSync(f.engine.file,bytes);assert.throws(()=>new CommerceEngine(f.options));assert.equal(fs.readFileSync(f.engine.file,'utf8'),bytes);
 }
 const uncertain=structuredClone(good),row=uncertain.photoPreparations[0];row.state='claiming';delete row.receipt;delete row.receiptHash;delete row.claimId;delete row.images;row.assets=[];uncertain.claims=[];fs.writeFileSync(f.engine.file,JSON.stringify(uncertain));const restarted=new CommerceEngine(f.options);assert.equal(restarted.db.photoPreparations[0].state,'uncertain');await restarted.close();fs.writeFileSync(f.engine.file,JSON.stringify(good));
});
