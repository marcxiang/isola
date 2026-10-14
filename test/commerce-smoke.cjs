'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

module.exports = async function commerceSmoke(api, check) {
  const {BrowserWindow} = require('electron');
  assert.ok(process.env.ISOLA_TEST_DATA, 'Commerce smoke tests require an isolated ISOLA_TEST_DATA directory');
  assert.equal(path.resolve(path.dirname(api.dataFile())), path.resolve(process.env.ISOLA_TEST_DATA));
  const token = 'skud_isola_commerce_fixture_original';
  const replacement = 'skud_isola_commerce_fixture_same_account';
  const otherAccount = 'skud_isola_commerce_fixture_other_account';
  const requests = [], consoleErrors = [];
  const products = [
    {id:'commerce-product-1',sku:'QA-FR-001',name:'QA 法国衬衫',description:'Description exacte du fournisseur QA',stock_quantity:12,unit_price_cents:790,available_photo_sets:2,revision:3},
    {id:'commerce-product-2',sku:'QA-FR-002',name:'QA 法国围巾',stock_quantity:8,unit_price_cents:890,available_photo_sets:1,revision:2}
  ];
  const sets = [
    {id:'commerce-set-1',product_id:'commerce-product-1',name:'QA 未领取图片',status:'available',image_count:3},
    {id:'commerce-set-2',product_id:'commerce-product-1',name:'QA 自己领取的图片',status:'claimed',claimed_by_me:true,image_count:4,claim:{id:'fixture-existing-claim'}},
    {id:'commerce-set-3',product_id:'commerce-product-2',name:'QA 其他人领取的图片',status:'claimed',claimed_by_me:false,image_count:2,claim:{id:'fixture-other-claim'}}
  ];
  const server = http.createServer((req,res) => {
    const url = new URL(req.url,'http://127.0.0.1');
    const authorization = req.headers.authorization || '';
    requests.push({method:req.method,path:url.pathname,query:Object.fromEntries(url.searchParams),authorization});
    res.setHeader('Content-Type','application/json');
    if (req.method !== 'GET') { res.writeHead(405); res.end(JSON.stringify({error:'Fixture never permits supplier writes'})); return; }
    if (![token,replacement,otherAccount].some(value => authorization === `Bearer ${value}`)) { res.writeHead(401); res.end(JSON.stringify({error:'Fixture token required'})); return; }
    if (url.pathname === '/api/v1/me') { res.end(JSON.stringify({user:{id:authorization===`Bearer ${otherAccount}`?'fixture-account-other':'fixture-account-original',username:'QA SKU Desk'},scopes:['products:read','photos:read','orders:write']})); return; }
    if (url.pathname === '/api/v1/products') { res.end(JSON.stringify({products,total:products.length,page:1,pageSize:100})); return; }
    if (url.pathname === '/api/v1/products/commerce-product-1') { res.end(JSON.stringify({product:products[0]})); return; }
    if (url.pathname === '/api/v1/photos/sets') { const rows=url.searchParams.has('productId')?sets.filter(s=>s.product_id===url.searchParams.get('productId')):sets;res.end(JSON.stringify({sets:rows,total:rows.length,page:1,pageSize:100})); return; }
    res.writeHead(404);res.end(JSON.stringify({error:'Unknown fixture path'}));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}/api/v1`;
  let window, wrongWindow, profile, engine, originalDB, originalConnection, plan;
  const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
  const waitFor = async (predicate,message) => {
    const deadline = Date.now()+8000;
    while(Date.now()<deadline) { if(await predicate()) return; await sleep(30); }
    throw Error('Timed out: '+message);
  };
  const frames = async () => window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const invoke = (method,...args) => window.webContents.executeJavaScript(`window.commerce[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  try {
    engine = api.getCommerce();
    assert.equal(engine.running,false,'Commerce smoke requires an idle engine');
    assert.equal(engine.db.plans.length,0,'Commerce smoke requires an empty test commerce store');
    assert.equal(engine.db.jobs.length,0,'Commerce smoke requires an empty test commerce queue');
    originalDB = JSON.parse(JSON.stringify(engine.db)); originalConnection = {...engine.connection};
    profile = api.saveProfile({name:'QA 运营法国环境',url:'https://www.vinted.fr',fingerprintMode:'native',width:1200,height:760});

    await check('commerce window loads isolated renderer and truthful readiness without console errors',async()=>{
      const loading = api.openCommerce();window=api.getCommerceWindow();
      window.webContents.on('console-message',(event,level,message)=>{
        const details=event.details || event;
        const severity=typeof level==='number'?level:(typeof level==='object'?level.level:details.level);
        const text=typeof message==='string'?message:(typeof level==='object'?level.message:details.message);
        if(severity===3||severity==='error')consoleErrors.push(String(text || 'Renderer console error'));
      });
      window.webContents.on('render-process-gone',(_,details)=>consoleErrors.push('Renderer exited: '+details.reason));
      await loading;await frames();
      const rendered=await window.webContents.executeJavaScript(`({title:document.title,node:typeof require,bridge:typeof window.commerce.state,ready:document.querySelector('#readiness-title').textContent,hidden:document.querySelector('#load-error').hidden})`);
      assert.equal(rendered.node,'undefined');assert.equal(rendered.bridge,'function');assert.match(rendered.title,/运营工作台/);assert.match(rendered.ready,/联调准备/);assert.equal(rendered.hidden,true);
      const state=await invoke('state');assert.equal(state.readiness.vinted,'unverified');assert.equal(state.settings.backgroundEnabled,false);assert.equal(state.running,false);assert.deepEqual(consoleErrors,[]);
      return {isolatedRenderer:true,readiness:state.readiness.vinted};
    });

    await check('commerce settings form encrypts local API token and never returns it through UI state',async()=>{
      await window.webContents.executeJavaScript(`(()=>{document.querySelector('[data-page="settings"]').click();const form=document.querySelector('#settings-form');form.elements.baseURL.value=${JSON.stringify(baseURL)};form.elements.token.value=${JSON.stringify(token)};form.elements.maxConcurrent.value='2';form.elements.perOrderLimit.value='0.00';form.elements.dailyLimit.value='0.00';form.elements.backgroundEnabled.checked=false;form.elements.fulfillmentMethod.value='wms';form.dispatchEvent(new Event('input',{bubbles:true}));form.requestSubmit();return true;})()`);
      await waitFor(()=>engine.state().settings.hasToken,'encrypted API settings to save');
      await waitFor(()=>window.webContents.executeJavaScript(`document.querySelector('#settings-form').elements.token.value===''`),'token form to clear after save');await frames();
      const publicState=await invoke('state'), disk=fs.readFileSync(engine.file,'utf8');
      assert.equal(publicState.settings.hasToken,true);assert.equal(publicState.settings.baseURL,baseURL);assert.equal(publicState.settings.perOrderLimitCents,0);assert.equal(publicState.settings.dailyLimitCents,0);
      assert.equal(JSON.stringify(publicState).includes(token),false);assert.equal(disk.includes(token),false);assert.ok(JSON.parse(disk).encryptedToken);
      const text=await window.webContents.executeJavaScript('document.body.innerText');assert.equal(text.includes(token),false);assert.match(text,/普通账号/);
      return {encryptedOnDisk:true,tokenRedacted:true,purchaseLimits:0};
    });

    await check('commerce connects and syncs catalog through actual localhost SKU Desk transport',async()=>{
      await window.webContents.executeJavaScript(`document.querySelector('#connect').click()`);
      await waitFor(()=>engine.connection.status==='connected','SKU account connection');
      // Connection state is emitted before the renderer's request finally
      // releases its controls. Wait for the actual sync action to be usable.
      await waitFor(()=>window.webContents.executeJavaScript(`!document.querySelector('#sync').disabled`),'sync control after connection');
      await window.webContents.executeJavaScript(`document.querySelector('[data-page="inventory"]').click();document.querySelector('#sync').click()`);
      await waitFor(()=>engine.db.products.length===2&&engine.db.photoSets.length===3,'catalog and photo sets sync');await frames();
      const state=await invoke('state');assert.equal(state.connection.account,'QA SKU Desk');assert.equal(state.products[0].priceCents,790);assert.equal(state.products[0].stock,12);assert.equal(state.photoSets[1].claimedByMe,true);
      const table=await window.webContents.executeJavaScript(`({products:document.querySelectorAll('#products tr').length,sets:document.querySelectorAll('.photo-set').length,photos:document.querySelector('#photo-sets').innerText})`);
      assert.equal(table.products,2);assert.equal(table.sets,3);assert.match(table.photos,/可领取/);assert.match(table.photos,/已被你领取/);assert.match(table.photos,/已被他人使用/);
      for(const route of ['/api/v1/me','/api/v1/products','/api/v1/photos/sets'])assert.ok(requests.some(request=>request.path===route&&request.method==='GET'));
      for(const request of requests.filter(request=>request.path!=='/api/v1/me')){assert.equal(request.query.page,'1');assert.equal(request.query.pageSize,'100');}
      return {products:table.products,photoSets:table.sets,readOnlyRequests:requests.length};
    });

    await check('commerce plan form rejects fractional cents and requires explicit sale prices',async()=>{
      const blank=await window.webContents.executeJavaScript(`(()=>{document.querySelector('[data-page="plans"]').click();document.querySelector('#new-plan').click();const form=document.querySelector('#plan-form');form.elements.profileId.value=${JSON.stringify(profile.id)};form.elements.productId.value='commerce-product-1';form.elements.productId.dispatchEvent(new Event('change',{bubbles:true}));return {price:form.elements.listingPrice.value,min:form.elements.minOffer.value,enabled:form.elements.enabled.checked,help:document.querySelector('#plan-product-info').textContent};})()`);
      assert.equal(blank.price,'');assert.equal(blank.min,'');assert.equal(blank.enabled,false);assert.match(blank.help,/采购价/);
      await window.webContents.executeJavaScript(`(()=>{const form=document.querySelector('#plan-form');form.elements.targetCount.value='3';form.elements.listingPrice.value='24.905';form.elements.minOffer.value='19.50';form.requestSubmit();return true;})()`);
      await waitFor(()=>window.webContents.executeJavaScript(`!document.querySelector('#plan-error').hidden`),'fractional-cent validation');
      assert.equal(engine.db.plans.length,0);assert.match(await window.webContents.executeJavaScript(`document.querySelector('#plan-error').textContent`),/两位小数/);
    });

    await check('commerce saves cumulative sales plan with EUR cents and renders isolated environment rules',async()=>{
      await window.webContents.executeJavaScript(`(()=>{const form=document.querySelector('#plan-form');form.elements.listingPrice.value='24,90';form.elements.minOffer.value='19.50';form.elements.autoReply.checked=true;form.elements.autoAcceptOffers.checked=true;form.elements.reuseOwnPhotos.checked=true;form.elements.replyPolicy.value='仅根据已确认商品信息回答';form.elements.listingTitle.value='Chemise QA';form.elements.listingDescription.value='Description précise du test';form.elements.listingCategoryPath.value='Femmes / Vêtements';form.elements.listingCondition.value='Très bon état';form.requestSubmit();return true;})()`);
      await waitFor(()=>engine.db.plans.length===1,'sales plan save');await waitFor(()=>window.webContents.executeJavaScript(`!document.querySelector('#plan-dialog').open`),'plan editor close');await frames();
      plan=engine.db.plans[0];assert.equal(plan.profileId,profile.id);assert.equal(plan.productId,'commerce-product-1');assert.equal(plan.targetCount,3);assert.equal(plan.listingPriceCents,2490);assert.equal(plan.minOfferCents,1950);assert.equal(plan.currency,'EUR');assert.equal(plan.enabled,false);assert.equal(plan.reuseOwnPhotos,true);assert.equal(plan.activeListingId,null);assert.equal(plan.listing.title,'Chemise QA');assert.deepEqual(plan.listing.categoryPath,['Femmes','Vêtements']);assert.equal(plan.listing.condition,'Très bon état');
      const text=await window.webContents.executeJavaScript(`document.querySelector('#plans').innerText`);assert.match(text,/QA 法国衬衫/);assert.match(text,/QA 运营法国环境/);assert.match(text,/累计成交/);assert.match(text,/一个在售商品/);
      return {targetSales:plan.targetCount,listingPriceCents:plan.listingPriceCents,minOfferCents:plan.minOfferCents,enabled:false};
    });

    await check('commerce preflight UI reads product details without writes and names the missing browser step',async()=>{
      const before=requests.length;
      await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('#plans button')).find(b=>b.textContent==='核对资料').click()`);
      await waitFor(()=>window.webContents.executeJavaScript(`document.querySelector('#preflight-dialog').open&&document.querySelector('#preflight-detail').innerText.includes('请先打开对应浏览器环境')`),'preflight result to identify closed environment');
      const report=await window.webContents.executeJavaScript(`({text:document.querySelector('#preflight-detail').innerText,fillDisabled:document.querySelector('#preflight-fill').disabled})`);
      assert.match(report.text,/Chemise QA/);assert.match(report.text,/Description exacte du fournisseur QA/);assert.match(report.text,/没有|未验证|尚未验证/);assert.equal(report.fillDisabled,true);
      assert.ok(requests.slice(before).some(r=>r.path==='/api/v1/products/commerce-product-1'));assert.ok(requests.slice(before).some(r=>r.query.productId===plan.productId));assert.ok(requests.slice(before).every(r=>r.method==='GET'));
      await window.webContents.executeJavaScript(`document.querySelector('#preflight-dialog').close()`);
      return {supplierReadOnly:true,missingBrowserReported:true,fieldFillDisabled:true};
    });

    await check('commerce-linked profiles reject manager clear and delete without losing cookies or plans',async()=>{
      const session=api.sesFor(profile), cookie={url:'https://www.vinted.fr',name:'isola_commerce_fixture_session',value:'fixture-only-session',path:'/'};
      await session.cookies.set(cookie);
      const manager=api.getManager().webContents;
      for(const method of ['clear','delete']){
        await assert.rejects(manager.executeJavaScript(`window.isola[${JSON.stringify(method)}](${JSON.stringify(profile.id)})`),/运营|计划|任务|关联/);
        assert.ok(api.list().some(item=>item.id===profile.id));
        assert.ok(engine.db.plans.some(item=>item.id===plan.id&&item.profileId===profile.id));
        const saved=await session.cookies.get({url:cookie.url,name:cookie.name});
        assert.equal(saved.length,1);assert.equal(saved[0].value,cookie.value);
      }
      return {clearBlocked:true,deleteBlocked:true,profilePreserved:true,planPreserved:true,cookiePreserved:true};
    });

    await check('commerce rejects cross-account key replacement and source changes while retaining plans',async()=>{
      const settings={...engine.db.settings,token:otherAccount};
      await assert.rejects(invoke('saveSettings',settings),/账号|密钥/);
      assert.equal(engine.unseal(engine.db.encryptedToken),token);assert.equal(engine.db.plans[0].id,plan.id);
      await assert.rejects(invoke('saveSettings',{...engine.db.settings,baseURL:`http://localhost:${server.address().port}/api/v1`,token:''}),/货盘|历史|计划/);
      assert.equal(engine.db.settings.baseURL,baseURL);assert.equal(engine.db.plans[0].id,plan.id);assert.equal(engine.db.products.length,2);
      await invoke('saveSettings',{...engine.db.settings,token:replacement});assert.equal(engine.unseal(engine.db.encryptedToken),replacement);assert.equal(engine.db.plans[0].id,plan.id);
      await invoke('connect');assert.equal(engine.connection.status,'connected');
      return {wrongAccountRejected:true,sourceChangeRejected:true,sameAccountRotationPreservedPlan:true};
    });

    await check('unverified production Vinted adapter pauses queue with zero supplier or marketplace writes',async()=>{
      await invoke('setPlanEnabled',plan.id,true);
      const before=requests.length;
      await window.webContents.executeJavaScript(`document.querySelector('#run-once').click()`);
      await waitFor(()=>engine.db.jobs.some(job=>job.planId===plan.id&&job.state==='needs_review'),'unverified live adapter review state');await frames();
      const job=engine.db.jobs.find(job=>job.planId===plan.id);assert.equal(job.state,'needs_review');assert.match(job.error,/未联调|未验证/);assert.equal(job.mutationPending,false);assert.equal(engine.db.claims.length,0);assert.equal(engine.db.sales.length,0);assert.equal(engine.db.reservations.length,0);assert.equal(engine.db.plans[0].activeListingId,null);
      assert.equal(requests.length,before);assert.equal(requests.filter(request=>request.method!=='GET').length,0);
      await window.webContents.executeJavaScript(`document.querySelector('[data-page="jobs"]').click();document.querySelector('#jobs button').click()`);await frames();
      const receipt=await window.webContents.executeJavaScript(`({text:document.querySelector('#job-detail').innerText,reconcileHidden:document.querySelector('#reconcile-form').hidden})`);
      assert.match(receipt.text,/需要核对/);assert.match(receipt.text,/未联调|未验证/);assert.equal(receipt.reconcileHidden,true);
      await window.webContents.executeJavaScript(`document.querySelector('#job-dialog').close()`);
      await invoke('runOnce');assert.equal(engine.db.jobs.length,1);assert.equal(requests.length,before);
      return {jobState:job.state,writeRequests:0,duplicateJobs:0};
    });

    await check('commerce IPC denies identical preload bridges from an unauthorized renderer',async()=>{
      wrongWindow=new BrowserWindow({show:false,width:400,height:300,webPreferences:{preload:path.resolve(__dirname,'../src/commerce-preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
      await wrongWindow.loadURL('about:blank');
      assert.equal(await wrongWindow.webContents.executeJavaScript('typeof window.commerce.state'),'function');
      for(const method of ['state','runOnce','preflight','prepareDraft','openListing','openActiveListing','inspectAccount','inspectPublication','submitPublication','inspectPhotos','preparePhotos','photoPreview','uploadPhotos'])await assert.rejects(wrongWindow.webContents.executeJavaScript(`window.commerce.${method}()`),/无权访问运营工作台/);
      await assert.rejects(wrongWindow.webContents.executeJavaScript(`window.commerce.saveSettings({baseURL:'http://127.0.0.1:9',clearToken:true})`),/无权访问运营工作台/);
      assert.equal(engine.db.settings.baseURL,baseURL);assert.equal(engine.unseal(engine.db.encryptedToken),replacement);assert.equal(engine.db.jobs.length,1);
      wrongWindow.destroy();wrongWindow=null;
      return {blockedRead:true,blockedRun:true,blockedSettings:true};
    });

    await check('manual publication IPC accepts only a stored plan ID and cannot use renderer-supplied proofs',async()=>{
      const before=requests.length;
      await assert.rejects(invoke('submitPublication',{planId:plan.id,verified:true,manifest:{path:'/private/fixture.jpg'}}),/编号无效/);
      await assert.rejects(invoke('submitPublication',plan.id),/先核对.*账号/);
      assert.equal(engine.db.publications.submissions.length,0);assert.equal(engine.db.plans[0].activeListingId,null);assert.equal(requests.length,before);
      return {untrustedProofRejected:true,noMutation:true};
    });

    await check('commerce UI completes local preparation without renderer errors or exposed credentials',async()=>{
      await frames();assert.deepEqual(consoleErrors,[]);
      const serialized=JSON.stringify(await invoke('state'));
      for(const secret of [token,replacement,otherAccount])assert.equal(serialized.includes(secret),false);
      assert.equal(engine.running,false);assert.equal(engine.db.settings.backgroundEnabled,false);assert.equal(requests.every(request=>request.method==='GET'),true);
      return {rendererErrors:0,externalWriteRequests:0,backgroundRunning:false};
    });
  } finally {
    if(wrongWindow&&!wrongWindow.isDestroyed())wrongWindow.destroy();
    if(engine){if(engine.running)engine.setRunning(false);if(originalDB){engine.db=originalDB;engine.connection=originalConnection;engine.persist();engine.emit();}}
    if(window&&!window.isDestroyed())window.close();
    if(profile)await api.deleteProfile(profile.id);
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
};
