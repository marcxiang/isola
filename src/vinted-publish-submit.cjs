'use strict';

const {createHash}=require('node:crypto');
const {performance:clock}=require('node:perf_hooks');
const {PublicationJournal,buildPublicationProof,FORM_URL}=require('./vinted-publication.cjs');
const {VintedPublicationEvidence,FIELD_SPECS,probePublicationForm}=require('./vinted-publication-evidence.cjs');
const {projectPublicationReconciliation}=require('./commerce-publication-reconcile.cjs');
const {probeAccountDOM,memberURL}=require('./vinted-account.cjs');
const {getDisplayState,assertDisplayVersion,mapPoint}=require('./display-transform.cjs');
const journals=new WeakMap();
const clone=value=>JSON.parse(JSON.stringify(value));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function error(code,message,ambiguous=false){return Object.assign(Error(message),{code,ambiguous});}
function ensure(ok,code,message){if(!ok)throw error(code,message);}

// Keep the journal instance shared across every window using the same engine.
// Constructor recovery is copied into the next durable snapshot, never used to
// replay an old prepared/dispatching command.
function publicationJournal(engine){
 let owned=journals.get(engine);
 if(owned){ensure(equal(engine.db.publications,owned.snapshot),'PUBLICATION_STORAGE_CHANGED','刊登记录已被另一操作改变，已停止提交');return owned.journal;}
 owned={journal:null,snapshot:null};
 const journal=new PublicationJournal({state:engine.db.publications,persist:async state=>{
  const before=engine.db,staged=state.submissions.some(row=>row.state==='published')?projectPublicationReconciliation(before,state).db:{...before,publications:state};
  engine.db=staged;
  try{await engine.persist();}catch(error){engine.db=before;engine.faulted=true;throw error;}
  owned.snapshot=clone(state);engine.emit?.();
 },dispatchEnabled:true});
 engine.db.publications=journal.state();owned.journal=journal;owned.snapshot=clone(engine.db.publications);journals.set(engine,owned);return journal;
}

// Run only in the adapter isolated world, against the most recent snapshot map.
// The publication button must belong to the same observed native form as every
// known field and the single upload widget. Header lookalikes never qualify.
function resolvePublishTarget(specs,expectedDocument){
 const d=globalThis.__isolaDOM,clean=value=>String(value||'').replace(/\s+/g,' ').trim();
 if(location.href!=='https://www.vinted.fr/items/new'||String(performance.timeOrigin)!==expectedDocument)return {error:'page-changed'};
 const outside=e=>!!d.closest(e,'header,nav,[role=navigation],[role=tablist]');
 const controls=[...document.querySelectorAll('input,textarea')].filter(e=>!outside(e)&&d.visible(e)&&!['password','file','hidden'].includes(e.type)&&!/password|cc-|one-time-code/.test(e.autocomplete||''));
 const anchors=[];
 for(const spec of specs.filter(spec=>spec.key!=='size')){
  const found=controls.filter(e=>e.tagName.toLowerCase()===spec.tag&&(spec.labels.includes(clean(d.label(e)))||spec.labels.includes(clean(e.getAttribute('placeholder')))));
  if(found.length!==1)return {error:'ambiguous-fields'};anchors.push(found[0]);
 }
 const forms=[...new Set(anchors.map(e=>e.form||d.closest(e,'form')).filter(Boolean))];
 let scope=forms.length===1&&anchors.every(e=>e.form===forms[0]||forms[0].contains(e))?forms[0]:null;
 if(!scope)scope=d.parents(anchors[0]).find(parent=>!['BODY','HTML','HEADER','NAV'].includes(parent.tagName)&&anchors.every(e=>parent.contains(e))&&parent.querySelectorAll('input[type=file][data-testid="add-photos-input"]').length===1);
 if(!scope||scope.querySelectorAll('input[type=file][data-testid="add-photos-input"]').length!==1)return {error:'ambiguous-form'};
 const buttons=[...scope.querySelectorAll('button,[role=button]')].filter(e=>!outside(e)&&d.visible(e)&&clean(d.label(e))==='Ajouter');
 if(buttons.length!==1||buttons[0].tagName!=='BUTTON'||d.disabled(buttons[0]))return {error:'ambiguous-button'};
 const button=buttons[0];if(d.closest(button,'a[href]'))return {error:'unexpected-link'};
 const action=button.getAttribute('formaction')||button.form?.getAttribute('action');
 if(action){try{const url=new URL(action,location.href);if(url.origin!=='https://www.vinted.fr'||url.username||url.password)return {error:'unexpected-form-action'};}catch{return {error:'invalid-form-action'};}}
 const ids=[...(globalThis.__isolaElements||new Map())].filter(([,node])=>node===button).map(([id])=>id);
 if(ids.length!==1)return {error:'missing-snapshot-target'};
 const hit=d.probe(button);
 return {elementId:ids[0],documentKey:expectedDocument,label:'Ajouter',tag:'BUTTON',disabled:false,href:'',point:hit.point,rect:d.rect(button),...(hit.point||{})};
}

// This function and its three passed probes are synchronous. In one isolated
// evaluation the renderer cannot run page tasks between the account, fields,
// photo nodes and hit-point reads. Raw sources return only to this main-process
// caller for synchronous hashing; never persist them or send them to the UI.
function probeFinalPublicationDOM(specs,expectedDocument,probeForm,probeAccount,resolveTarget){
 const d=globalThis.__isolaDOM,map=globalThis.__isolaElements,clean=value=>String(value||'').replace(/\s+/g,' ').trim();
 const failure=reason=>({error:reason});
 if(location.href!=='https://www.vinted.fr/items/new'||String(performance.timeOrigin)!==expectedDocument||!d||!map)return failure('page-changed');
 const entries=[...map],menuLabels=['Mon profil','Paramètres','Mes commandes','Se déconnecter'];
 const buttonIds=entries.filter(([,node])=>node?.tagName==='BUTTON'&&!d.disabled(node)).map(([id])=>id);
 const menuIds=entries.filter(([,node])=>['A','BUTTON'].includes(node?.tagName)&&menuLabels.includes(clean(d.label(node)))).map(([id,node])=>({id,label:clean(d.label(node))}));
 const account=probeAccount(buttonIds,menuIds),form=probeForm(specs);
 const outside=e=>!!d.closest(e,'header,nav,[role=navigation],[role=tablist]');
 const inputs=[...document.querySelectorAll('input[type=file]')].filter(e=>!outside(e));
 if(inputs.length!==1||inputs[0].getAttribute('data-testid')!=='add-photos-input')return failure('photo-input-changed');
 const input=inputs[0],accepted=String(input.accept||'').toLowerCase().split(',').map(value=>value.trim());
 if(!accepted.some(value=>['image/*','image/jpeg','.jpg','.jpeg'].includes(value)))return failure('photo-input-invalid');
 const scopes=[...document.querySelectorAll('div[data-testid="media-upload"]')];
 if(scopes.length!==1||!scopes[0].contains(input)||!d.visible(scopes[0]))return failure('photo-scope-changed');
 const scope=scopes[0];
 if(scope.querySelectorAll('input[type=file]').length!==1||[...scope.querySelectorAll('input:not([type=file]):not([type=hidden]),textarea,select')].some(e=>!['button','submit'].includes(e.type)))return failure('photo-scope-invalid');
 const images=[...scope.querySelectorAll('img')].filter(d.visible).map(e=>({alt:clean(e.getAttribute('alt')),source:e.currentSrc||e.src||'',loaded:e.complete&&e.naturalWidth>0}));
 const controls=[...scope.querySelectorAll('button,[role=button]')].filter(d.visible).map(e=>clean(d.label(e)));
 const statuses=[...scope.querySelectorAll('[role=alert],[role=status],[aria-live],[aria-busy=true],progress,[role=progressbar]')].filter(d.visible);
 const busy=scope.getAttribute('aria-busy')==='true'||statuses.some(e=>e.getAttribute('aria-busy')==='true'||e.tagName==='PROGRESS'||e.getAttribute('role')==='progressbar'||clean(d.safeText(e,500)));
 const challenge=[...document.querySelectorAll('iframe')].some(e=>d.visible(e)&&/captcha|challenges\.cloudflare|challenge-platform/i.test((e.getAttribute('src')||'')+' '+(e.getAttribute('title')||'')))||[...document.querySelectorAll('[role=dialog],[aria-modal=true],dialog[open]')].some(e=>d.visible(e)&&/captcha|vérifi.{0,30}humain|vérification de sécurité|pas un robot/i.test(d.safeText(e,500)));
 return {documentKey:expectedDocument,url:location.href,account,form,photos:{images,controls,busy},challenge,target:resolveTarget(specs,expectedDocument)};
}

function verifyFinalPublication(state,proof,input,adapter,tab,targetId){
 const fail=(ok,message)=>ensure(ok,'PUBLICATION_EVIDENCE_CHANGED',message||'原生点击前商品、账号或照片发生变化，未发布');
 fail(state&&!state.error&&state.documentKey===proof.facts.documentKey&&state.url===FORM_URL&&state.challenge===false);
 const account=state.account;fail(account?.documentKey===proof.facts.documentKey&&account.buttons?.length===1&&account.menus?.length===1&&account.menus[0].valid,'原生点击前当前账号菜单无法唯一核对，未发布');
 let identity;try{identity=memberURL(account.menus[0].href);}catch{fail(false,'原生点击前当前账号地址发生变化，未发布');}
 fail(identity.memberId===proof.facts.account.memberId&&identity.profileURL===proof.facts.account.profileURL,'原生点击前当前登录账号发生变化，未发布');
 const form=state.form;
 fail(form?.url===FORM_URL&&form.documentKey===proof.facts.documentKey&&!form.error&&form.publication?.count===1&&form.publication.enabled&&form.unknownFields?.length===0&&form.invalidFields?.length===0&&form.alerts?.length===0&&form.dialogs===0);
 fail(Array.isArray(form.fields));
 const fields=form.fields.filter(field=>!(field.field==='size'&&proof.facts.fields.size===undefined&&field.value===''&&!field.required&&!field.invalid&&!field.disabled));
 const expectedKeys=Object.keys(proof.facts.fields).filter(key=>key!=='parcel').sort();
 fail(equal(fields.map(field=>field.field).sort(),expectedKeys));
 for(const field of fields){const expected=proof.facts.fields[field.field],value=field.field==='priceCents'?renderedCents(field.value):field.value;fail(!field.disabled&&!field.invalid&&equal(value,field.field==='categoryPath'?expected.at(-1):expected));}
 fail(form.parcel?.length===3&&['Petit','Moyen','Grand'].every(name=>form.parcel.filter(option=>option.name===name).length===1));
 const selected=form.parcel.filter(option=>option.checked);fail(selected.length===1&&!selected[0].disabled&&!selected[0].invalid&&selected[0].name===proof.facts.fields.parcel);
 const photos=state.photos,count=proof.facts.photos.count;
 fail(photos?.busy===false&&Array.isArray(photos.images)&&photos.images.length===count&&Array.isArray(photos.controls));
 const keys=new Map();
 for(const image of photos.images){
  const caption=/^Photo ([1-9]\d*) sur ([1-9]\d*) mise en ligne Pour réorganiser les photos, appuie sur la barre d['’]espace$/.exec(image.alt||'');
  fail(caption&&Number(caption[2])===count&&Number(caption[1])<=count&&image.loaded===true&&typeof image.source==='string'&&image.source.length>0&&image.source.length<=65536&&/^https?:/.test(image.source));
  const index=Number(caption[1]);fail(!keys.has(index));keys.set(index,createHash('sha256').update(image.source).digest('hex'));
 }
 const fingerprints=[...keys].sort((a,b)=>a[0]-b[0]).map(([,fingerprint])=>fingerprint);
 fail(new Set(fingerprints).size===count&&photos.controls.filter(label=>label==='Supprimer la photo sélectionnée').length===1&&photos.controls.some(label=>/^Modifier la photo [1-9]\d*$/.test(label)&&Number(label.match(/\d+$/)[0])<=count));
 const signature=createHash('sha256').update(JSON.stringify(fingerprints)).digest('hex');
 const record=adapter.photos?.claims?.get(input.plan.profileId+'\0'+tab.id+'\0'+proof.facts.documentKey);
 const manifestKey=createHash('sha256').update(JSON.stringify({claimId:input.manifest.claimId,files:input.manifest.files.map(file=>file.sha256),count:input.manifest.count})).digest('hex');
 fail(signature===proof.facts.photos.signature&&record?.phase==='verified'&&record.claimId===input.claim.id&&record.documentKey===proof.facts.documentKey&&record.manifestKey===manifestKey&&record.signature===signature,'原生点击前网页照片与原上传记录不一致，未发布');
 const point=state.target;
 ensure(!point?.error&&point?.documentKey===proof.facts.documentKey&&point?.elementId===targetId&&point?.tag==='BUTTON'&&point.label==='Ajouter'&&!point.disabled&&!point.href&&point.point&&Number.isFinite(point.x)&&Number.isFinite(point.y),'PUBLICATION_BUTTON_CHANGED','发布控件在点击前发生变化或被遮挡');
 return point;
}

function passEvidence(pass,observedAt){
 ensure(pass&&Array.isArray(pass.fields)&&pass.fields.every(field=>!field.disabled&&!field.invalid),'PUBLICATION_EVIDENCE_BLOCKED','商品字段缺失或不可用，未点击发布');
 ensure(['unknownFields','invalidFields','alerts'].every(key=>Array.isArray(pass[key])&&pass[key].length===0)&&pass.dialogs===0,'PUBLICATION_EVIDENCE_BLOCKED','商品页出现未知内容、错误或弹窗，未点击发布');
 return {profileId:pass.profileId,tabId:pass.tabId,url:pass.url,documentKey:pass.documentKey,observedAt,challenge:pass.challenge,account:pass.account,
  form:{documentKey:pass.documentKey,complete:true,fields:pass.fields.map(field=>({field:field.field,value:field.value,verified:true})),unknownFields:[],invalidFields:[]},photos:pass.photos,publication:pass.publication};
}
function planBinding(plan){return {id:plan.id,profileId:plan.profileId,productId:plan.productId,sku:plan.sku,enabled:plan.enabled,activeListingId:plan.activeListingId||null,completedCount:plan.completedCount,targetCount:plan.targetCount,currency:plan.currency,listingPriceCents:plan.listingPriceCents,listing:plan.listing};}
function candidateURL(value){
 let url;try{url=new URL(value);}catch{return null;}
 const match=/^\/items\/([1-9]\d{0,29})(?:-[^/]+)?\/?$/.exec(url.pathname);
 if(url.origin!=='https://www.vinted.fr'||url.username||url.password||!match)return null;
 return {listingId:match[1],url:'https://www.vinted.fr/items/'+match[1]};
}
function renderedCents(value){const clean=String(value||'').replace(/\s*€$/,'').trim();return /^\d+(?:[,.]\d{1,2})?$/.test(clean)?Math.round(Number(clean.replace(',','.'))*100):null;}

class VintedPublishSubmit{
 constructor({enabled=false,evidenceFactory=adapter=>new VintedPublicationEvidence(adapter),visualDelayMs=180,timeoutMs=60000,dispatchTimeoutMs=30000,navigationWaitMs=15000,now=Date.now}={}){
  this.enabled=enabled===true;this.evidenceFactory=evidenceFactory;this.visualDelayMs=Math.max(0,Math.min(1000,visualDelayMs));this.timeoutMs=Math.max(20,Math.min(60000,timeoutMs));this.dispatchTimeoutMs=Math.max(20,Math.min(30000,dispatchTimeoutMs));this.navigationWaitMs=Math.max(0,Math.min(30000,navigationWaitMs));this.now=now;
 }
 async wait(work,context){
  context.guard();let onAbort;
  const aborted=new Promise((_,reject)=>{onAbort=()=>reject(error('STOPPED','刊登提交已停止'));context.signal.addEventListener('abort',onAbort,{once:true});});
  try{const result=await Promise.race([Promise.resolve().then(()=>{context.guard();return work();}),aborted]);context.guard();return result;}
  finally{context.signal.removeEventListener('abort',onAbort);}
 }
 async proof(input,reader,context){
  const observedAt=new Date(this.now()).toISOString();
  const first=await this.wait(()=>reader.readPass(input,context),context),second=await this.wait(()=>reader.readPass(input,context),context);
  ensure(equal(first,second),'PUBLICATION_EVIDENCE_CHANGED','两次核对之间商品或账号发生变化，未点击发布');
  return buildPublicationProof({...input,evidence:passEvidence(second,observedAt)},{now:this.now()});
 }
 async target(adapter,profileId,proof,context,{scroll=false}={}){
  await this.wait(()=>adapter.read(profileId,context),context);
  const found=await this.wait(()=>adapter.control.isolated(context.tab,'('+resolvePublishTarget.toString()+')('+JSON.stringify(FIELD_SPECS)+','+JSON.stringify(proof.facts.documentKey)+')'),context);
  ensure(found&&!found.error&&/^e\d+-\d+$/.test(found.elementId||''),'PUBLICATION_BUTTON_CHANGED','未找到当前表单唯一的原生 Ajouter 按钮，未点击发布');
  const target=await this.wait(()=>adapter.control.target(context.tab,found.elementId,context.signal,{scroll}),context);
  ensure(target?.tag==='BUTTON'&&target.label==='Ajouter'&&!target.disabled&&!target.href&&Number.isFinite(target.x)&&Number.isFinite(target.y),'PUBLICATION_BUTTON_CHANGED','发布按钮的类型、标签或位置发生变化，未点击发布');
  return {elementId:found.elementId,...target};
 }
 async feedback(context,stage,target){
  // A visual feedback promise is bounded by the submission controller; once it
  // times out, no later fulfillment can resume the click path.
  if(context.tab.controlFeedback)await this.wait(()=>context.tab.controlFeedback({stage,action:'click',label:'Ajouter · 发布商品',elementId:target?.elementId||null,rect:target?.rect,point:target?{x:target.x,y:target.y}:undefined}),context);
 }
 async submit({engine,planId,input,signal,guard=()=>{}}){
  ensure(this.enabled,'PUBLICATION_NOT_ENABLED','真实发布步骤尚未启用');
  ensure(engine?.adapter&&engine.db&&typeof engine.persist==='function'&&typeof engine.plan==='function'&&input?.plan?.id===planId,'PUBLICATION_INPUT_INVALID','发布必须使用主进程保存的销售计划及页面证据');
  const saved=clone(input),profileId=saved.plan.profileId,adapter=engine.adapter,reader=this.evidenceFactory(adapter),journal=publicationJournal(engine);
  ensure(saved.manifest?.claimId===saved.claim?.id&&saved.manifest?.profileId===profileId&&saved.manifest?.productId===saved.plan.productId&&saved.manifest?.setId===saved.claim?.setId&&Array.isArray(saved.manifest.files)&&saved.manifest.files.length===saved.manifest.count&&saved.manifest.files.every(file=>/^[a-f0-9]{64}$/.test(file.sha256||'')),'PUBLICATION_INPUT_INVALID','照片清单无法与原计划和认领记录核对');
  const controller=new AbortController(),cancel=()=>controller.abort(),context={controller,signal:controller.signal,form:true};let w,contents,timer,dispatchTimer,dispatchDeadline=null,record,clickIssued=false,timedOut=false,postClick=false;
  const captures=new Set();let navigationResolve,latestNavigation=null,navigationClosed=false,captureError=null;
  const navigation=new Promise(resolve=>{navigationResolve=resolve;});
  const checkEngine=()=>{
   if(dispatchDeadline!==null&&clock.now()>=dispatchDeadline){timedOut=true;controller.abort();}
   guard();ensure(!engine.faulted&&!engine.closing,'PUBLICATION_STOPPED','运营存储或窗口已停止');ensure(!controller.signal.aborted,'STOPPED','刊登提交已停止');
   ensure(equal(planBinding(engine.plan(planId)),planBinding(saved.plan)),'PUBLICATION_PLAN_CHANGED','销售计划已改变，未继续提交');
   const accounts=engine.db.marketAccounts?.filter(account=>account.profileId===profileId)||[];
   ensure(accounts.length===1&&accounts[0].memberId===saved.expectedAccount.memberId&&accounts[0].profileURL===saved.expectedAccount.profileURL,'PUBLICATION_ACCOUNT_CHANGED','环境绑定账号已改变，未继续提交');
  };
  context.guard=()=>{checkEngine();if(postClick){ensure(w&&!w.isDestroyed()&&w.tabs.find(tab=>tab.id===w.activeTab)===context.tab&&!contents.isDestroyed(),'PUBLICATION_PAGE_CHANGED','原发布窗口已改变');ensure(!w.aiAgent?.state?.running,'PAGE_BUSY','当前窗口已有其他控制任务');}else{adapter.current(profileId,context);if(contents){assertDisplayVersion(contents,context.displayVersion);ensure(context.tab.isInputVisible?.()!==false,'INPUT_SURFACE_UNAVAILABLE','请先显示原发布窗口并切换到当前标签页');}}};
  const capture=(kind,url,mainFrame=true)=>{
   if(mainFrame===false)return;if(!clickIssued){controller.abort();return;}if(navigationClosed)return;
   const identity=candidateURL(url);if(!identity){if(url!==FORM_URL){navigationClosed=true;navigationResolve(null);}return;}
   const item={kind:'observed_submission_navigation',submissionId:record.id,formDocumentKey:record.proof.facts.documentKey,profileId,tabId:context.tab.id,...identity,observedAt:new Date(this.now()).toISOString(),event:kind,committed:kind!=='did-start-navigation'};
   const task=journal._atomic(state=>{const original=state.submissions.find(entry=>entry.id===record.id);ensure(original?.attemptCount===1,'PUBLICATION_STORAGE_CHANGED','导航缺少原提交记录');original.navigation=original.navigation||[];if(original.navigation.length>=10)throw error('PUBLICATION_NAVIGATION_LIMIT','发布后页面跳转过多，需要人工核对',true);original.navigation.push(item);return null;});
   captures.add(task);task.then(()=>{latestNavigation=item;if(item.committed){navigationClosed=true;navigationResolve(item);}},caught=>{captureError=caught;controller.abort();navigationResolve(null);}).finally(()=>captures.delete(task));
  };
  const started=(_event,url,_inPlace,mainFrame)=>capture('did-start-navigation',url,mainFrame),committed=(_event,url)=>capture('did-navigate',url,true),inPage=(_event,url,mainFrame)=>capture('did-navigate-in-page',url,mainFrame);
  try{
   if(signal?.aborted)throw error('STOPPED','刊登提交已停止');signal?.addEventListener('abort',cancel,{once:true});
   checkEngine();const selected=adapter.current(profileId,context);w=selected.w;context.tab=selected.tab;contents=selected.tab.view.webContents;context.displayVersion=getDisplayState(contents).version;context.guard();w.vintedDraftController=controller;
   timer=setTimeout(()=>{timedOut=true;controller.abort();},this.timeoutMs);
   contents.on?.('did-start-navigation',started);contents.on?.('did-navigate',committed);contents.on?.('did-navigate-in-page',inPage);contents.on?.('destroyed',cancel);contents.on?.('render-process-gone',cancel);
   const initialProof=await this.proof(saved,reader,context);record=await journal.prepare(initialProof);context.guard();
   let target=await this.target(adapter,profileId,initialProof,context,{scroll:true});await this.feedback(context,'preparing',target);
   if(this.visualDelayMs)await this.wait(()=>new Promise(resolve=>setTimeout(resolve,this.visualDelayMs)),context);
   const freshProof=await this.proof(saved,reader,context);ensure(freshProof.fingerprint===initialProof.fingerprint,'PUBLICATION_EVIDENCE_CHANGED','视觉提示期间商品、账号或照片发生变化，未点击发布');
   await this.feedback(context,'acting',target);context.guard();
   // Revoke the click capability immediately at the dispatch deadline, even if
   // the journal is still awaiting the durable uncertain-state write. A Promise
   // timeout alone cannot stop its abandoned callback from resuming later.
   dispatchDeadline=clock.now()+this.dispatchTimeoutMs;
   dispatchTimer=setTimeout(()=>{timedOut=true;controller.abort();},this.dispatchTimeoutMs);
   try{await journal.dispatchOnce(record.id,freshProof,async intent=>{
    // Durability and even an overlay callback can take time. Read every fact
    // once more after those awaits, then reacquire the native button by the
    // latest semantic snapshot. Never reuse a target from before the delay.
    context.guard();const finalProof=await this.proof(saved,reader,context);ensure(finalProof.fingerprint===intent.fingerprint,'PUBLICATION_EVIDENCE_CHANGED','提交前最后核对发生变化，未点击发布');
    target=await this.target(adapter,profileId,finalProof,context,{scroll:false});context.guard();
    context.guard();contents.focus();context.guard();
    const finalState=await this.wait(()=>adapter.control.isolated(context.tab,'('+probeFinalPublicationDOM.toString()+')('+JSON.stringify(FIELD_SPECS)+','+JSON.stringify(finalProof.facts.documentKey)+','+probePublicationForm.toString()+','+probeAccountDOM.toString()+','+resolvePublishTarget.toString()+')'),context);
    // No awaits, snapshot refreshes, target lookups, focus or visual callbacks
    // after this single final read: verify synchronously and dispatch input.
    const point=verifyFinalPublication(finalState,finalProof,saved,adapter,context.tab,target.elementId);context.guard();
    const displayPoint=mapPoint(contents,point,context.displayVersion),x=Math.round(displayPoint.x),y=Math.round(displayPoint.y);contents.sendInputEvent({type:'mouseMove',x,y});context.guard();
    clickIssued=true;postClick=true;
    try{contents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});}
    finally{if(!contents.isDestroyed())contents.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});}
   },{signal:context.signal,timeoutMs:this.dispatchTimeoutMs});}
   finally{clearTimeout(dispatchTimer);dispatchDeadline=null;}
   await this.feedback(context,'performed',target);
   if(this.navigationWaitMs&&!navigationClosed)await this.wait(()=>new Promise(resolve=>{const timeout=setTimeout(()=>resolve(null),this.navigationWaitMs);navigation.then(value=>{clearTimeout(timeout);resolve(value);});}),context);
   await Promise.all([...captures]);if(captureError)throw captureError;
   const current=journal.get(record.id);return {submissionId:current.id,state:current.state,clickIssued,published:false,saved:false,canRetry:false,navigationCandidate:latestNavigation,message:'已发送一次发布点击；需核对实际刊登页面，当前未认定发布成功。'};
  }catch(reason){
   const caught=reason instanceof Error?reason:error('PUBLICATION_SUBMIT_FAILED','刊登步骤失败，请核对原记录');
   controller.abort();
   if(record){let original;try{original=journal.get(record.id);}catch{}if(original?.state==='prepared'&&original.attemptCount===0&&!journal.faulted)await journal.cancelPrepared(record.id);caught.submissionId=record.id;caught.clickMayHaveStarted=clickIssued||original?.attemptCount===1;if(caught.clickMayHaveStarted)caught.ambiguous=true;}
   if(timedOut){const timeout=error('PUBLICATION_SUBMIT_TIMEOUT','刊登提交核对超时；请检查原记录，不要重复点击',caught.ambiguous);timeout.submissionId=caught.submissionId;timeout.clickMayHaveStarted=caught.clickMayHaveStarted;throw timeout;}
   throw caught;
  }finally{
   controller.abort();clearTimeout(timer);clearTimeout(dispatchTimer);signal?.removeEventListener('abort',cancel);navigationClosed=true;navigationResolve(null);
   contents?.removeListener?.('did-start-navigation',started);contents?.removeListener?.('did-navigate',committed);contents?.removeListener?.('did-navigate-in-page',inPage);contents?.removeListener?.('destroyed',cancel);contents?.removeListener?.('render-process-gone',cancel);
   await Promise.allSettled([...captures]);if(w?.vintedDraftController===controller)w.vintedDraftController=null;
   if(context.tab?.controlFeedback){try{await Promise.race([Promise.resolve(context.tab.controlFeedback({stage:'clear',action:'click',label:'Ajouter · 发布商品'})),new Promise(resolve=>setTimeout(resolve,300))]);}catch{}}
  }
 }
}

module.exports={VintedPublishSubmit,publicationJournal,resolvePublishTarget,probeFinalPublicationDOM};
