'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {productCoverSource,createProductDisplayService}=require('../src/commerce-product-display.cjs');
const {SKUDeskClient}=require('../src/sku-desk.cjs');
const BASE='https://supplier.example.test/api/v1',API_COVER=BASE+'/products/box/cover',PUBLIC_COVER='https://images.example.test/box.png?size=small';
// Structural raster headers only: these tests exercise byte/type/size guards.
// Main's native normalizer owns full image decoding and thumbnail conversion.
function png(width=30,height=20){const bytes=Buffer.alloc(45);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);bytes.write('IEND',37);return bytes;}
function jpeg(){return Buffer.from([255,216,255,192,0,17,8,0,20,0,30,3,1,17,0,2,17,1,3,17,1,255,218,0,12,3,1,0,2,17,3,17,0,63,0,255,217]);}
function webp(){const bytes=Buffer.alloc(30);bytes.write('RIFF');bytes.writeUInt32LE(22,4);bytes.write('WEBP',8);bytes.write('VP8X',12);bytes.writeUInt32LE(10,16);bytes.writeUIntLE(29,24,3);bytes.writeUIntLE(19,27,3);return bytes;}
function lossyWebp(){const bytes=Buffer.alloc(30);bytes.write('RIFF');bytes.writeUInt32LE(22,4);bytes.write('WEBP',8);bytes.write('VP8 ',12);bytes.writeUInt32LE(10,16);Buffer.from([0x9d,1,0x2a]).copy(bytes,23);bytes.writeUInt16LE(30,26);bytes.writeUInt16LE(20,28);return bytes;}
function losslessWebp(){const bytes=Buffer.alloc(26);bytes.write('RIFF');bytes.writeUInt32LE(18,4);bytes.write('WEBP',8);bytes.write('VP8L',12);bytes.writeUInt32LE(5,16);bytes[20]=0x2f;bytes.writeUInt32LE((19<<14)|29,21);return bytes;}
const dataURL=(bytes,type='image/png')=>'data:'+type+';base64,'+bytes.toString('base64'),clone=value=>JSON.parse(JSON.stringify(value));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(options={}){
 const calls=[],normalized=[],engine={db:{settings:{baseURL:BASE},supplierAccountId:'supplier-account',products:[{id:'box',sku:'BOX',revision:1,displayImageUrl:API_COVER}],localProducts:[{id:'local-box',source:'local'}],photoSets:[{id:'used-set',productId:'box',claimStatus:'used',claimedByMe:false,images:[{url:BASE+'/photos/images/used'}]}],claims:[{id:'original-claim'}],jobs:[],plans:[],photoPreparations:[]},client(){calls.push({type:'client'});return {download:async(url,input)=>{calls.push({type:'download',url,input});return options.download?options.download(url,input):png();},claimPhotos(){throw Error('Display must never claim a photo set');},photoSet(){throw Error('Display must not read a photo set');},me(){throw Error('Display must not request account state');}};},persist(){throw Error('Display must not persist');},emit(){throw Error('Display must not emit state');}};
 const service=createProductDisplayService({normalizeImage:async(bytes,input)=>{normalized.push({bytes,input});return options.normalize?options.normalize(bytes,input):{dataURL:dataURL(png()),width:30,height:20};},fetchImpl:async(url,input)=>{calls.push({type:'fetch',url,input});return options.fetch?options.fetch(url,input):new Response(png(),{headers:{'content-type':'image/png'}});},...(options.timeoutMs?{timeoutMs:options.timeoutMs}:{}),...(options.now?{now:options.now}:{})});
 return {engine,service,calls,normalized,preview:(id='box')=>service.preview(engine,id)};
}
const unavailable=error=>error.code==='PRODUCT_DISPLAY_UNAVAILABLE'&&!/https?:|fixture-secret|provider-token/.test(error.message);
const decodeFailed=error=>error.code==='PRODUCT_DISPLAY_DECODE_FAILED'&&error.message==='商品展示图解码失败，请重试展示图。';

test('cover extraction accepts the documented display aliases and only the first product image, without using photo sets',()=>{
 for(const field of ['displayImageUrl','thumbnailUrl','thumbnail_url','coverImageUrl','cover_image_url','coverUrl','cover_url','imageUrl','image_url'])assert.equal(productCoverSource({[field]:PUBLIC_COVER}),PUBLIC_COVER,field);
 for(const field of ['image','cover','thumbnail'])for(const value of [PUBLIC_COVER,{url:PUBLIC_COVER},{src:PUBLIC_COVER},{thumbnail_url:PUBLIC_COVER}])assert.equal(productCoverSource({[field]:value}),PUBLIC_COVER,field);
 assert.equal(productCoverSource({images:[{url:PUBLIC_COVER},{url:API_COVER}]}),PUBLIC_COVER);assert.equal(productCoverSource({images:[{src:'/api/v1/products/box/cover'}]}),'/api/v1/products/box/cover');assert.equal(productCoverSource({images:[{url:'data:fake'},{url:PUBLIC_COVER}]}),null);
 assert.equal(productCoverSource({photoSets:[{images:[{url:PUBLIC_COVER}]}],photos:[{url:PUBLIC_COVER}]}),null);for(const value of [null,undefined,[],PUBLIC_COVER,{}])assert.equal(productCoverSource(value),null);
});

test('unsafe image schemes, credentials, controls and ambiguous path encodings are excluded before any request',()=>{
 const rejected=['javascript:alert(1)','file:///C:/private/image.png','data:image/png;base64,AAAA','http://images.example.test/a.png','images/a.png','//images.example.test/a.png','https://user:provider-token@images.example.test/a.png','https://images.example.test\\a.png','https://images.example.test/a\n.png','https://images.example.test/a%00.png','https://images.example.test/a%0A.png','https://images.example.test/../private.png','/api/v1/./image.png','/api/v1/%2e%2e/image.png','/api/v1/a%2fb.png','/api/v1/a%5cb.png','/api/v1/%252e%252e/image.png','https://images.example.test/a.png#other','/image.png#other',' https://images.example.test/a.png'];
 for(const source of rejected)assert.equal(productCoverSource({displayImageUrl:source}),null,source);assert.equal(productCoverSource({thumbnail_url:'/covers/white%20box.png?width=640'}),'/covers/white%20box.png?width=640');
});

test('same-provider API covers use only the bounded authenticated download and preserve used-photo ownership and every record',async()=>{
 const f=fixture(),before=clone(f.engine.db),out=await f.preview();assert.deepEqual(out,{productId:'box',dataURL:dataURL(png()),width:30,height:20});assert.deepEqual(f.engine.db,before);assert.deepEqual(f.calls.map(row=>row.type),['client','download']);assert.equal(f.calls[1].url,API_COVER);assert.equal(f.calls[1].input.maxBytes,2*1024*1024);assert.ok(f.calls[1].input.signal instanceof AbortSignal);assert.equal(f.normalized[0].input.maxDimension,640);assert.equal(f.normalized[0].input.signal,f.calls[1].input.signal);assert.equal(f.normalized[0].input.signal.aborted,false);assert.deepEqual(f.normalized[0].bytes,png());assert.deepEqual(Object.keys(out).sort(),['dataURL','height','productId','width']);assert.doesNotMatch(JSON.stringify(out),/supplier-account|used-set|original-claim|https:/);
});

test('the cached supplier product image route passes through the real SKU client as bounded binary image data',async()=>{
 const f=fixture(),requests=[],base='http://127.0.0.1:18181/api/v1';f.engine.db.settings.baseURL=base;f.engine.db.products=[{id:'123',sku:'PRODUCT-123',revision:1,displayImageUrl:'/api/v1/products/123/image'}];f.engine.client=()=>new SKUDeskClient({baseURL:base,token:'fixture-display-only-token',fetchImpl:async(url,input)=>{requests.push({url,input});return new Response(png(),{headers:{'content-type':'image/png','content-length':String(png().length)}});}});
 const before=clone(f.engine.db),result=await f.preview('123');assert.equal(result.productId,'123');assert.equal(result.dataURL,dataURL(png()));assert.equal(requests.length,1);assert.equal(requests[0].url,base+'/products/123/image');assert.equal(requests[0].input.method,'GET');assert.equal(requests[0].input.headers.Authorization,'Bearer fixture-display-only-token');assert.equal(requests[0].input.redirect,'error');assert.deepEqual(f.engine.db,before);assert.deepEqual(f.calls,[]);assert.equal(f.normalized.length,1);
});

test('only explicit image routes may use provider authentication, and product image routes must match the current product',async t=>{
 for(const path of ['/products/box/cover','/products/box/image','/products/box/thumbnail','/products/box/images/original-1','/photos/images/provided-image','/photos/thumbnails/provided-thumbnail'])await t.test(path,async()=>{const f=fixture();f.engine.db.products[0].displayImageUrl='/api/v1'+path;await f.preview();assert.deepEqual(f.calls.map(row=>row.type),['client','download']);assert.equal(f.calls[1].url,BASE+path);});
});

test('private non-image API routes and another product cover are rejected before creating an authenticated client or public fetch',async t=>{
 const paths=['/orders/private-order/label','/me','/wms/orders/private-order/label','/photos/claims/private-claim/download','/products/other-product/cover','/products/other-product/images/secret','/products/box/cover/extra','/products/box/images/','/photos/images/provided-image/preview','/photos/thumbnails/','/products/box',''];
 for(const path of paths)for(const absolute of [false,true])await t.test((absolute?'absolute ':'relative ')+(path||'API root'),async()=>{const f=fixture();f.engine.db.products[0].displayImageUrl=(absolute?BASE:'/api/v1')+path;await assert.rejects(f.preview(),unavailable);assert.deepEqual(f.calls,[]);assert.deepEqual(f.normalized,[]);});
});

test('root-relative API covers resolve within the provider while all other HTTPS images use credential-free GET',async t=>{
 for(const [source,kind] of [['/api/v1/products/box/cover','download'],[PUBLIC_COVER,'fetch'],['/public/box.png','fetch'],['https://supplier.example.test/public/box.png','fetch']])await t.test(source,async()=>{
  const f=fixture();f.engine.db.products[0].displayImageUrl=source;await f.preview();const call=f.calls.find(row=>row.type===kind);assert.ok(call);if(kind==='fetch'){assert.equal(f.calls.some(row=>row.type==='client'),false);assert.deepEqual(call.input.headers,{});assert.equal(call.input.method,'GET');assert.equal(call.input.credentials,'omit');assert.equal(call.input.referrerPolicy,'no-referrer');assert.equal(call.input.redirect,'error');assert.ok(call.input.signal instanceof AbortSignal);assert.equal(call.url,new URL(source,BASE).href);}
 });
});

test('absent or invalid supplier covers and local products return placeholders without inspecting, claiming or downloading any photo set',async()=>{
 const f=fixture();delete f.engine.db.products[0].displayImageUrl;assert.deepEqual(await f.preview(),{productId:'box',dataURL:null});f.engine.db.products[0].displayImageUrl='javascript:secret';assert.deepEqual(await f.preview(),{productId:'box',dataURL:null});assert.deepEqual(await f.preview('local-box'),{productId:'local-box',dataURL:null});assert.deepEqual(f.calls,[]);assert.deepEqual(f.normalized,[]);await assert.rejects(f.preview('missing'),unavailable);f.engine.db.products.push(clone(f.engine.db.products[0]));await assert.rejects(f.preview(),unavailable);assert.deepEqual(f.calls,[]);
});

test('inflight deduplication and the cache share one read, and returned preview objects cannot mutate the cached value',async()=>{
 let release;const f=fixture({download:()=>new Promise(resolve=>release=resolve)}),first=f.preview(),second=f.preview();await tick();assert.equal(f.calls.filter(row=>row.type==='download').length,1);release(png());const [a,b]=await Promise.all([first,second]);assert.deepEqual(a,b);assert.equal(f.normalized.length,1);a.width=999;a.dataURL='changed';assert.deepEqual(await f.preview(),b);assert.equal(f.calls.filter(row=>row.type==='download').length,1);
});

test('cache identity includes provider, account, product revision, SKU and exact display source and expires after five minutes',async()=>{
 let stamp=1000;const f=fixture({now:()=>stamp});await f.preview();for(const change of [()=>{f.engine.db.products[0].revision++;},()=>{f.engine.db.products[0].sku='OTHER-SKU';},()=>{f.engine.db.products[0].displayImageUrl=API_COVER+'?revision=2';},()=>{f.engine.db.supplierAccountId='other-account';},()=>{f.engine.db.settings.baseURL='https://other-provider.example.test/api/v1';f.engine.db.products[0].displayImageUrl='/api/v1/products/box/cover';}]){const before=f.calls.filter(row=>row.type==='download').length;change();await f.preview();assert.equal(f.calls.filter(row=>row.type==='download').length,before+1);}
 const count=f.calls.filter(row=>row.type==='download').length;await f.preview();assert.equal(f.calls.filter(row=>row.type==='download').length,count);stamp+=5*60*1000;await f.preview();assert.equal(f.calls.filter(row=>row.type==='download').length,count+1);
});

test('the memory LRU retains at most sixty product previews and touches recently read entries',async()=>{
 const f=fixture();f.engine.db.products=Array.from({length:61},(_,i)=>({id:'p'+i,sku:'SKU'+i,revision:1,displayImageUrl:'/api/v1/products/p'+i+'/cover'}));for(let i=0;i<60;i++)await f.preview('p'+i);await f.preview('p0');await f.preview('p60');assert.equal(f.calls.filter(row=>row.type==='download').length,61);await f.preview('p0');assert.equal(f.calls.filter(row=>row.type==='download').length,61);await f.preview('p1');assert.equal(f.calls.filter(row=>row.type==='download').length,62);
});

test('at most three distinct cover downloads run concurrently while queued products remain independently keyed',async()=>{
 const releases=[];let active=0,maximum=0;const f=fixture({download:()=>{active++;maximum=Math.max(maximum,active);return new Promise(resolve=>releases.push(()=>{active--;resolve(png());}));}});f.engine.db.products=Array.from({length:7},(_,i)=>({id:'p'+i,revision:1,displayImageUrl:'/api/v1/products/p'+i+'/cover'}));const pending=f.engine.db.products.map(row=>f.preview(row.id));await tick();assert.equal(releases.length,3);assert.equal(active,3);while(releases.length){releases.shift()();await tick();}const results=await Promise.all(pending);assert.equal(results.length,7);assert.equal(f.calls.filter(row=>row.type==='download').length,7);assert.equal(maximum,3);assert.equal(active,0);
});

test('provider, account and product changes during a download discard late bytes before normalization or caching',async t=>{
 const changes=[['provider',f=>{f.engine.db.settings.baseURL='https://other.example.test/api/v1';}],['account',f=>{f.engine.db.supplierAccountId='other-account';}],['source',f=>{f.engine.db.products[0].displayImageUrl=API_COVER+'?other=1';}],['revision',f=>{f.engine.db.products[0].revision++;}],['SKU',f=>{f.engine.db.products[0].sku='changed';}],['removed product',f=>{f.engine.db.products=[];}],['ambiguous product',f=>{f.engine.db.products.push(clone(f.engine.db.products[0]));}],['closing',f=>{f.engine.closing=true;}]];
 for(const [name,change] of changes)await t.test(name,async()=>{let release;const f=fixture({download:()=>new Promise(resolve=>release=resolve)}),pending=f.preview();await tick();change(f);release(png());await assert.rejects(pending,{code:'PRODUCT_DISPLAY_CHANGED'});assert.equal(f.normalized.length,0);});
});

test('a source changed while a queued request waits is rejected without fetching that old source',async()=>{
 const releases=[];const f=fixture({download:()=>new Promise(resolve=>releases.push(resolve))});f.engine.db.products=Array.from({length:4},(_,i)=>({id:'p'+i,revision:1,displayImageUrl:'/api/v1/products/p'+i+'/cover'}));const pending=f.engine.db.products.map(row=>f.preview(row.id)),all=Promise.allSettled(pending);await tick();f.engine.db.products[3].displayImageUrl='/api/v1/products/p3/changed';releases.shift()(png());await tick();for(const release of releases)release(png());const results=await all;assert.equal(results[3].status,'rejected');assert.equal(results[3].reason.code,'PRODUCT_DISPLAY_CHANGED');assert.equal(f.calls.filter(row=>row.type==='download').length,3);
});

test('source changes during native normalization discard the result and cannot seed the old cache entry',async()=>{
 let change=true,f;f=fixture({normalize:()=>{if(change)f.engine.db.supplierAccountId='changed-account';return {dataURL:dataURL(png()),width:30,height:20};}});await assert.rejects(f.preview(),{code:'PRODUCT_DISPLAY_CHANGED'});assert.equal(f.normalized.length,1);change=false;f.engine.db.supplierAccountId='supplier-account';await f.preview();assert.equal(f.calls.filter(row=>row.type==='download').length,2);
});

test('a timed-out request aborts its signal and ignores late bytes without normalization',async()=>{
 let release,signal;const f=fixture({timeoutMs:15,download:(_url,input)=>{signal=input.signal;return new Promise(resolve=>release=resolve);}});await assert.rejects(f.preview(),{code:'PRODUCT_DISPLAY_TIMEOUT'});assert.equal(signal.aborted,true);release(png());await tick();assert.equal(f.normalized.length,0);
});

test('a stalled public response body is cancelled at the same deadline and never reaches normalization',async()=>{
 let cancelled=0;const f=fixture({timeoutMs:15,fetch:()=>new Response(new ReadableStream({start(controller){controller.enqueue(png());},cancel(){cancelled++;}}),{headers:{'content-type':'image/png'}})});f.engine.db.products[0].displayImageUrl=PUBLIC_COVER;await assert.rejects(f.preview(),{code:'PRODUCT_DISPLAY_TIMEOUT'});await tick();assert.equal(cancelled,1);assert.equal(f.normalized.length,0);
});

test('WebP VP8, VP8L and VP8X headers pass unchanged to an asynchronous decoder and only its validated JPEG thumbnail is returned',async t=>{
 for(const [name,bytes] of [['VP8',lossyWebp()],['VP8L',losslessWebp()],['VP8X',webp()]])await t.test(name,async()=>{let decoded=false;const f=fixture({download:()=>bytes,normalize:async(input,options)=>{assert.deepEqual(input,bytes);assert.equal(options.maxDimension,640);assert.ok(options.signal instanceof AbortSignal);assert.equal(options.signal.aborted,false);await tick();decoded=true;return {dataURL:dataURL(jpeg(),'image/jpeg'),width:30,height:20};}}),before=clone(f.engine.db),result=await f.preview();assert.equal(decoded,true);assert.deepEqual(result,{productId:'box',dataURL:dataURL(jpeg(),'image/jpeg'),width:30,height:20});assert.deepEqual(f.engine.db,before);assert.equal(f.normalized.length,1);});
});

test('decoder failure is a fixed retryable display error, exposes no native details and never poisons the preview cache',async()=>{
 let reject=true;const f=fixture({download:()=>webp(),normalize:async()=>{await tick();if(reject)throw Error('nativeImage is empty: https://private.invalid/?fixture-secret=provider-token');return {dataURL:dataURL(jpeg(),'image/jpeg'),width:30,height:20};}}),before=clone(f.engine.db);await assert.rejects(f.preview(),decodeFailed);assert.deepEqual(f.engine.db,before);reject=false;const result=await f.preview();assert.equal(result.dataURL,dataURL(jpeg(),'image/jpeg'));assert.equal(f.calls.filter(row=>row.type==='download').length,2);assert.equal(f.normalized.length,2);
});

test('an asynchronous decoder deadline and a changed source retain their own failure codes instead of becoming decoder failures',async t=>{
 await t.test('deadline',async()=>{let release,decoderSignal,aborts=0;const f=fixture({timeoutMs:15,download:()=>webp(),normalize:(_bytes,{signal})=>{decoderSignal=signal;return new Promise((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>{aborts++;reject(Error('decoder cancelled'));},{once:true});});}});await assert.rejects(f.preview(),{code:'PRODUCT_DISPLAY_TIMEOUT'});assert.equal(decoderSignal,f.calls.find(call=>call.type==='download').input.signal);assert.equal(decoderSignal.aborted,true);assert.equal(aborts,1);release({dataURL:dataURL(jpeg(),'image/jpeg'),width:30,height:20});await tick();assert.equal(aborts,1);});
 await t.test('source changed before decoder rejection',async()=>{let f;f=fixture({download:()=>webp(),normalize:async()=>{await tick();f.engine.db.supplierAccountId='other-account';throw Error('private native error');}});await assert.rejects(f.preview(),{code:'PRODUCT_DISPLAY_CHANGED'});});
});

test('public responses reject redirects, HTTP errors, non-image types, announced overflows and streamed overflows',async t=>{
 const options=[['redirect',()=>({ok:true,redirected:true,headers:new Headers({'content-type':'image/png'}),body:null})],['unexpected URL',()=>({ok:true,redirected:false,url:'https://other.example.test/private',headers:new Headers({'content-type':'image/png'}),body:null})],['HTTP error',()=>new Response('provider-token',{status:403})],['HTML',()=>new Response('<html>fixture-secret</html>',{headers:{'content-type':'text/html'}})],['announced overflow',()=>new Response(png(),{headers:{'content-type':'image/png','content-length':String(2*1024*1024+1)}})],['stream overflow',()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(1024*1024));controller.enqueue(new Uint8Array(1024*1024));controller.enqueue(new Uint8Array(1));controller.close();}}),{headers:{'content-type':'image/png'}})]];
 for(const [name,response] of options)await t.test(name,async()=>{const f=fixture({fetch:response});f.engine.db.products[0].displayImageUrl=PUBLIC_COVER;await assert.rejects(f.preview(),unavailable);assert.equal(f.normalized.length,0);});
});

test('empty, excessive, unsupported and dimension-bomb bytes never reach the native normalizer',async t=>{
 const values=[Buffer.alloc(0),Buffer.alloc(2*1024*1024+1),Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),Buffer.from('GIF89a'),png(8193,1),png(8000,8000),png(0,20),png().subarray(0,24)];for(const [index,bytes] of values.entries())await t.test(String(index),async()=>{const f=fixture({download:()=>bytes});await assert.rejects(f.preview(),unavailable);assert.equal(f.normalized.length,0);});
});

test('JPEG, PNG and WebP input headers are accepted for the main normalizer but no larger output or active content is returned',async t=>{
 for(const [type,bytes] of [['image/jpeg',jpeg()],['image/png',png()],['image/webp',webp()]])await t.test(type,async()=>{const f=fixture({download:()=>bytes,normalize:()=>({dataURL:dataURL(bytes,type),width:30,height:20})});const result=await f.preview();assert.equal(result.dataURL,dataURL(bytes,type));assert.equal(f.normalized.length,1);});
 const invalid=[{dataURL:'data:image/svg+xml;base64,PHN2Zy8+',width:30,height:20},{dataURL:dataURL(png(641,20)),width:641,height:20},{dataURL:dataURL(png()),width:29,height:20},{dataURL:dataURL(png(),'image/jpeg'),width:30,height:20},{dataURL:'data:image/png;base64,AAAA===',width:30,height:20}];for(const [index,value] of invalid.entries())await t.test('invalid normalized '+index,async()=>{const f=fixture({normalize:()=>value});await assert.rejects(f.preview(),decodeFailed);});
});

test('transport and decoder errors never expose a source URL, token, response body or native error details',async t=>{
 for(const phase of ['download','fetch','normalize'])await t.test(phase,async()=>{const secret=Error('https://user:provider-token@private.example.test/image?fixture-secret=1'),f=fixture({[phase]:()=>{throw secret;}});if(phase==='fetch')f.engine.db.products[0].displayImageUrl=PUBLIC_COVER;await assert.rejects(f.preview(),error=>(phase==='normalize'?decodeFailed(error):unavailable(error))&&error!==secret);});
});
