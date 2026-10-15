'use strict';

const {createHash}=require('node:crypto');
const {VintedAccount,memberURL}=require('./vinted-account.cjs');
const {buildPublicationProof,FORM_URL}=require('./vinted-publication.cjs');
const {isEnvironmentSessionAccount,assertEnvironmentSessionAuthority}=require('./commerce-session-authority.cjs');

const traversals=new WeakMap();
const FIELD_SPECS=Object.freeze([
 {key:'title',label:'Titre',tag:'input',labels:['Titre','Dis aux acheteurs ce que tu vends']},
 {key:'description',label:'Description',tag:'textarea',labels:['Description','Ajoute des informations utiles']},
 {key:'categoryPath',label:'Catégorie',tag:'input',labels:['Catégorie','Sélectionne une catégorie']},
 {key:'priceCents',label:'Prix',tag:'input',labels:['Prix','0,00 €']},
 {key:'condition',label:'État',tag:'input',labels:['État','Sélectionne un état']},
 {key:'brand',label:'Marque',tag:'input',labels:['Marque','Sélectionne une marque']},
 {key:'color',label:'Couleur',tag:'input',labels:['Couleur','Sélectionne 2 couleurs maximum']},
 {key:'size',label:'Taille',tag:'input',labels:['Taille','Sélectionne une taille']}
]);
const clone=value=>JSON.parse(JSON.stringify(value));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const norm=value=>String(value||'').replace(/\s+/g,' ').trim();
function problem(code,message){const error=Error(message);error.code=code;return error;}
function ensure(ok,code,message){if(!ok)throw problem(code,message);}
function cents(value){const clean=norm(value).replace(/ ?€$/,'');return /^\d+(?:[,.]\d{1,2})?$/.test(clean)?Math.round(Number(clean.replace(',','.'))*100):null;}

// Adapter hook: call only after every unique category control was actually
// clicked and the final native input was read back in this same document.
// Matching a prefilled leaf does not create a traversal receipt.
function rememberCategoryTraversal(ownership,{tab,documentKey,path,selectedValue,steps}){
 ensure(ownership&&ownership.tab===tab&&ownership.documentKey===documentKey&&typeof documentKey==='string','PUBLICATION_CATEGORY_UNVERIFIED','分类选择不属于当前商品页面');
 ensure(Array.isArray(path)&&path.length>0&&path.length<=10&&path.every(label=>typeof label==='string'&&label.trim()===label&&label.length>0&&label.length<=180),'PUBLICATION_CATEGORY_UNVERIFIED','分类路径回执无效');
 ensure(selectedValue===path.at(-1)&&ownership.fields?.categoryPath===selectedValue,'PUBLICATION_CATEGORY_UNVERIFIED','分类末级回读与选择路径不一致');
 ensure(Array.isArray(steps)&&steps.length===path.length&&steps.every((step,index)=>step?.unique===true&&step.documentKey===documentKey&&step.label===path[index]&&/^e\d+-\d+$/.test(step.elementId||'')&&step.role===(index===path.length-1?'radio':'button')),'PUBLICATION_CATEGORY_UNVERIFIED','缺少逐级分类实际操作回执');
 traversals.set(ownership,Object.freeze({tab,documentKey,path:Object.freeze([...path]),selectedValue,steps:Object.freeze(steps.map(step=>Object.freeze({...step})))}));
}

// Read-only. The exact field labels and three parcel phrases were observed on
// the French form. No React stores, page-world application data or arbitrary
// hidden values are used to fill gaps in the visible/native form evidence.
function probePublicationForm(specs){
 const d=globalThis.__isolaDOM,clean=value=>String(value||'').replace(/\s+/g,' ').trim();
 const outside=e=>!!d.closest(e,'header,nav,[role=navigation],[role=tablist]');
 const controls=[...document.querySelectorAll('input,textarea,select,[contenteditable=true],[role=combobox],[role=checkbox],[role=switch],[role=radio]')].filter(e=>!outside(e));
 const invalid=e=>e.getAttribute('aria-invalid')&&e.getAttribute('aria-invalid')!=='false'||e.willValidate&&e.validity?.valid===false;
 const required=e=>e.required===true||e.getAttribute('aria-required')==='true';
 const protectedField=e=>['password','file','hidden'].includes(e.type)||/password|cc-|one-time-code/.test(e.autocomplete||'');
 const found=specs.map(spec=>({spec,nodes:controls.filter(e=>e.tagName.toLowerCase()===spec.tag&&d.visible(e)&&!protectedField(e)&&(spec.labels.includes(clean(d.label(e)))||spec.labels.includes(clean(e.getAttribute('placeholder')))))}));
 const anchors=found.filter(entry=>entry.spec.key!=='size').flatMap(entry=>entry.nodes);
 const failure=reason=>({url:location.href,documentKey:String(performance.timeOrigin),error:reason});
 if(found.some(entry=>entry.spec.key!=='size'&&entry.nodes.length!==1)||found.some(entry=>entry.nodes.length>1))return failure('刊登字段缺失或出现多个同名控件');
 const forms=[...new Set(anchors.map(e=>e.form||d.closest(e,'form')).filter(Boolean))];
 let scope=forms.length===1&&anchors.every(e=>e.form===forms[0]||forms[0].contains(e))?forms[0]:null;
 if(!scope)scope=d.parents(anchors[0]).find(parent=>!['BODY','HTML','HEADER','NAV'].includes(parent.tagName)&&anchors.every(e=>parent.contains(e))&&parent.querySelectorAll('input[type=file][data-testid="add-photos-input"]').length===1);
 if(!scope)return failure('无法确定同时包含刊登字段及照片的唯一商品表单');
 const inside=e=>scope.contains(e)||e.form===scope,known=new Set(anchors),fields=[];
 for(const {spec,nodes} of found){if(!nodes.length)continue;const e=nodes[0];if(!inside(e))return failure('商品字段不属于同一表单');known.add(e);fields.push({field:spec.key,label:spec.label,value:String(e.value||''),disabled:d.disabled(e),invalid:!!invalid(e),required:required(e)});}
 const radios=controls.filter(e=>inside(e)&&(e.type==='radio'||e.getAttribute('role')==='radio'));
 const phrases={Petit:'Petit Convient pour un article qui tient dans une grande enveloppe.',Moyen:'Moyen Convient pour un article qui tient dans une boîte à chaussures.',Grand:'Grand Convient pour un article qui tient dans un carton de déménagement.'};
 const parcel=[];
 for(const radio of radios){
  const texts=[d.label(radio),...Array.from(radio.labels||[]).map(label=>d.safeText(label,600))];let visible=d.visible(radio);
  for(const parent of d.parents(radio)){if(parent===scope||!inside(parent))break;if(radios.filter(peer=>parent===peer||parent.contains(peer)).length===1){texts.push(d.safeText(parent,700));visible=visible||d.visible(parent);}}
  const names=Object.keys(phrases).filter(name=>clean(texts.join(' ')).includes(phrases[name]));
  if(names.length!==1||!visible)continue;
  known.add(radio);parcel.push({name:names[0],checked:radio.tagName==='INPUT'?radio.checked===true:radio.getAttribute('aria-checked')==='true',disabled:d.disabled(radio),invalid:!!invalid(radio)});
 }
 const unknownFields=[],invalidFields=fields.filter(field=>field.invalid).map(field=>field.label);
 for(const e of controls.filter(inside)){
  if(known.has(e)||e.type==='hidden'||['submit','button','reset'].includes(e.type))continue;
  if(e.type==='file'&&e.getAttribute('data-testid')==='add-photos-input')continue;
  const label=clean(d.label(e)).slice(0,180)||e.tagName.toLowerCase(),isRequired=required(e),isInvalid=!!invalid(e);
  // Unknown optional EMPTY controls (e.g. Matériau recommandé) are permitted.
  // Never read sensitive values; their existence itself requires review.
  const sensitive=protectedField(e),role=e.getAttribute('role');let populated;
  if(sensitive)populated=true;
  else if(e.type==='checkbox'||e.type==='radio')populated=e.checked===true;
  else if(['checkbox','switch','radio'].includes(role))populated=e.getAttribute('aria-checked')!=='false';
  else if(e.isContentEditable)populated=!!String(e.textContent||'').trim();
  else if(['INPUT','TEXTAREA','SELECT'].includes(e.tagName))populated=!!String(e.value||'').trim();
  else populated=e.getAttribute('aria-valuetext')===null||!!String(e.getAttribute('aria-valuetext')).trim();
  if(isInvalid)invalidFields.push(label);
  if(populated||isRequired||isInvalid)unknownFields.push({label,required:isRequired,invalid:isInvalid,populated:!!populated});
 }
 const buttons=[...scope.querySelectorAll('button,[role=button]')].filter(e=>!outside(e)&&d.visible(e)&&clean(d.label(e))==='Ajouter');
 const publication={count:buttons.length,label:'Ajouter',enabled:buttons.length===1&&!d.disabled(buttons[0]),observed:buttons.length===1,documentKey:String(performance.timeOrigin)};
 const alerts=[...scope.querySelectorAll('[role=alert],[aria-live],[role=status]')].filter(d.visible).map(e=>clean(d.safeText(e,250))).filter(Boolean);
 const dialogs=[...document.querySelectorAll('[aria-modal=true],dialog[open]')].filter(d.visible).length;
 return {url:location.href,documentKey:String(performance.timeOrigin),fields,parcel,unknownFields,invalidFields,publication,alerts,dialogs};
}

class VintedPublicationEvidence{
 constructor(adapter,{accountReader,timeoutMs=15000,now=Date.now}={}){
  ensure(adapter?.current&&adapter?.read&&adapter?.control&&adapter?.photos,'PUBLICATION_UNAVAILABLE','缺少刊登页面读取能力');
  this.adapter=adapter;this.account=accountReader||new VintedAccount(adapter);this.timeoutMs=Math.max(20,Math.min(15000,timeoutMs));this.now=now;
 }
 async wait(work,context){
  if(context.signal.aborted)throw problem('STOPPED','刊登核对已停止');let cancel;
  const abort=new Promise((_,reject)=>{cancel=()=>reject(problem('STOPPED','刊登核对已停止'));context.signal.addEventListener('abort',cancel,{once:true});});
  try{return await Promise.race([Promise.resolve().then(()=>{if(context.signal.aborted)throw problem('STOPPED','刊登核对已停止');return work();}),abort]);}
  finally{context.signal.removeEventListener('abort',cancel);}
 }
 async readPass(input,context){
  const {plan,claim,manifest}=input,profileId=plan.profileId,guard=()=>this.adapter.current(profileId,context);
  const sessionAccount=isEnvironmentSessionAccount(input.expectedAccount,profileId);
  if(sessionAccount)assertEnvironmentSessionAuthority(input.expectedAccount,profileId);
  const account=sessionAccount?null:await this.wait(()=>this.account.state(profileId,context),context);guard();
  if(!sessionAccount)ensure(account.account,'PUBLICATION_ACCOUNT_UNVERIFIED','请先核对当前账号菜单；关闭菜单后也必须有同一页面的有效核验记录，不能仅凭普通个人主页链接判断账号');
  await this.wait(()=>this.adapter.read(profileId,context),context);guard();
  const form=await this.wait(()=>this.adapter.control.isolated(context.tab,'('+probePublicationForm.toString()+')('+JSON.stringify(FIELD_SPECS)+')'),context);guard();
  ensure(form&&form.url===FORM_URL&&typeof form.documentKey==='string','PUBLICATION_PAGE_CHANGED','刊登表单页面已改变');
  ensure(!form.error,'PUBLICATION_FORM_UNVERIFIED',form.error||'刊登表单无法核对');
  if(!sessionAccount)ensure(account.documentKey===form.documentKey,'PUBLICATION_PAGE_CHANGED','账号与商品表单不属于同一次页面');
  const photoState=await this.wait(()=>this.adapter.photos.read(profileId,context),context);guard();
  ensure(photoState.documentKey===form.documentKey,'PUBLICATION_PAGE_CHANGED','照片与商品字段不属于同一次页面');
  const record=this.adapter.photos.claims.get(profileId+'\0'+context.tab.id+'\0'+form.documentKey);
  const manifestKey=hash({claimId:manifest.claimId,files:manifest.files.map(file=>file.sha256),count:manifest.count});
  ensure(record&&record.phase==='verified'&&record.claimId===claim.id&&record.documentKey===form.documentKey&&record.manifestKey===manifestKey,'PUBLICATION_PHOTO_UNVERIFIED','当前页面没有属于本计划和照片清单的可信上传记录');
  const receipt=this.adapter.photos.receipt(photoState,manifest.count);
  ensure(receipt&&receipt.signature===record.signature&&receipt.count===manifest.count,'PUBLICATION_PHOTO_UNVERIFIED','页面照片回执已改变或仍未完成');
  const ownership=this.adapter.drafts.get(profileId),traversal=ownership&&traversals.get(ownership);
  ensure(ownership?.tab===context.tab&&ownership.documentKey===form.documentKey&&traversal?.tab===context.tab&&traversal.documentKey===form.documentKey&&equal(traversal.path,plan.listing.categoryPath),'PUBLICATION_CATEGORY_UNVERIFIED','当前页面缺少本应用实际逐级选择的完整分类路径回执；匹配的分类末级名称不足以授权发布');
  const category=form.fields.find(field=>field.field==='categoryPath');
  ensure(category?.value===traversal.selectedValue&&ownership.fields?.categoryPath===category.value,'PUBLICATION_CATEGORY_UNVERIFIED','分类选择回执与当前输入值不一致');
  const fields=form.fields.filter(field=>field.field!=='size'||plan.listing.size||field.value||field.required||field.invalid).map(field=>({...field,value:field.field==='categoryPath'?[...traversal.path]:field.field==='priceCents'?cents(field.value):field.value}));
  const parcel=form.parcel.filter(option=>option.checked);
  const parcelComplete=['Petit','Moyen','Grand'].every(name=>form.parcel.filter(option=>option.name===name).length===1)&&form.parcel.length===3&&parcel.length===1&&!parcel[0].disabled&&!parcel[0].invalid;
  fields.push({field:'parcel',label:'包裹规格',value:parcelComplete?parcel[0].name:null,disabled:!parcelComplete,invalid:!parcelComplete});
  if(!sessionAccount){const finalAccount=await this.wait(()=>this.account.state(profileId,context),context);guard();ensure(finalAccount.documentKey===form.documentKey&&equal(finalAccount.account,account.account),'PUBLICATION_EVIDENCE_CHANGED','读取商品字段期间当前账号发生变化，请重新核对');}
  else {assertEnvironmentSessionAuthority(input.expectedAccount,profileId);guard();}
  return {profileId,tabId:context.tab.id,url:FORM_URL,documentKey:form.documentKey,challenge:photoState.challenge,
   account:sessionAccount?{kind:'environment-session',profileId}:{profileId,verified:true,...account.account},fields,unknownFields:form.unknownFields,invalidFields:form.invalidFields,alerts:form.alerts,dialogs:form.dialogs,
   publication:form.publication,photos:{profileId,claimId:claim.id,productId:claim.productId,setId:claim.setId,count:manifest.count,documentKey:form.documentKey,signature:receipt.signature,verified:true,busy:false,errorCount:0}};
 }
 async collect(input,{signal}={},report={checks:[]}){
  const check=(name,ok,detail)=>{report.checks.push({name,ok:!!ok,detail});return !!ok;};
  ensure(input?.plan&&input.product&&input.claim&&input.expectedAccount&&input.manifest,'PUBLICATION_INPUT_INVALID','请从保存的计划、当前货盘商品、绑定账号和照片清单进行核对');
  const {plan,claim,manifest}=input;report.planId=plan.id;report.profileId=plan.profileId;
  const matches=manifest.claimId===claim.id&&manifest.productId===plan.productId&&claim.productId===plan.productId&&manifest.profileId===plan.profileId&&claim.profileId===plan.profileId&&manifest.setId===claim.setId&&Array.isArray(manifest.files)&&manifest.files.length===manifest.count&&Array.isArray(claim.images)&&claim.images.length===manifest.count&&manifest.files.every(file=>/^[a-f0-9]{64}$/.test(file.sha256||''));
  ensure(check('保存的照片清单',matches,matches?'照片认领、商品、环境和文件摘要一致':'照片清单与计划或认领记录不一致'),'PUBLICATION_INPUT_INVALID','保存的照片清单无法与计划核对');
  const controller=new AbortController(),cancel=()=>controller.abort(),context={signal:controller.signal,controller,form:true};let w,contents,timer,timedOut=false;
  if(signal?.aborted)throw problem('STOPPED','刊登核对已停止');signal?.addEventListener('abort',cancel,{once:true});
  const navigated=(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame!==false)controller.abort();};
  try{
   const selected=this.adapter.current(plan.profileId,context);w=selected.w;context.tab=selected.tab;contents=selected.tab.view.webContents;w.vintedDraftController=controller;
   contents.on?.('did-start-navigation',navigated);contents.on?.('destroyed',cancel);contents.on?.('render-process-gone',cancel);
   timer=setTimeout(()=>{timedOut=true;controller.abort();},this.timeoutMs);const observedAt=new Date(this.now()).toISOString();
   const first=await this.readPass(input,context),second=await this.readPass(input,context);this.adapter.current(plan.profileId,context);
   ensure(check('连续两次页面核对',equal(first,second),equal(first,second)?'账号、商品字段、照片和发布控件保持一致':'两次读取之间页面内容发生变化'),'PUBLICATION_EVIDENCE_CHANGED','连续两次刊登证据不一致，请重新读取');
   const sessionAccount=isEnvironmentSessionAccount(input.expectedAccount,plan.profileId),expectedIdentity=sessionAccount?null:memberURL(input.expectedAccount.profileURL),identity=sessionAccount?isEnvironmentSessionAccount(second.account,plan.profileId):second.account.memberId===input.expectedAccount.memberId&&second.account.memberId===expectedIdentity.memberId&&second.account.profileURL===expectedIdentity.profileURL;
   check(sessionAccount?'当前自动化环境':'当前登录账号',identity,sessionAccount?'沿用当前独立环境的登录会话；未要求用户名或账号绑定':identity?'当前菜单账号与该环境绑定一致':'当前登录账号与该环境绑定不一致');
   let fieldsOK=true;
   for(const field of second.fields){const expected=field.field==='priceCents'?plan.listingPriceCents:plan.listing[field.field];const matches=equal(field.value,expected)&&!field.disabled&&!field.invalid;check(field.label,matches,matches?'页面值与保存计划一致':'页面值缺失、不可用或与保存计划不一致');fieldsOK=fieldsOK&&matches;}
   const extra=second.unknownFields.length===0&&second.invalidFields.length===0&&second.alerts.length===0&&second.dialogs===0;
   check('其余字段和错误提示',extra,extra?'未知可选字段为空，未显示字段错误或弹窗':'需核对：'+[...second.unknownFields.map(field=>field.label),...second.invalidFields,...second.alerts,...(second.dialogs?['页面弹窗']:[])].join('；').slice(0,600));
   check('网页照片',true,'已确认同一 document、原上传记录与当前照片回执');
   const publish=second.publication.count===1&&second.publication.enabled&&second.publication.observed;
   check('发布按钮',publish,publish?'唯一 Ajouter 按钮可用':'Ajouter 按钮缺失、重复或不可用');
   const challenge=second.challenge===false;check('页面可操作状态',challenge,challenge?'未检测到阻断验证':'页面显示验证或无法确认验证状态');
   ensure(identity&&fieldsOK&&extra&&publish&&challenge,'PUBLICATION_EVIDENCE_BLOCKED','发布前核对存在未通过项；没有点击发布');
   const evidence={profileId:second.profileId,tabId:second.tabId,url:second.url,documentKey:second.documentKey,observedAt,challenge:second.challenge,account:second.account,
    form:{documentKey:second.documentKey,complete:true,fields:second.fields.map(field=>({field:field.field,value:field.value,verified:true})),unknownFields:[],invalidFields:[]},photos:second.photos,publication:second.publication};
   const proof=buildPublicationProof({...input,evidence},{now:this.now()});report.account=clone(second.account);report.fieldCount=second.fields.length;report.photoCount=second.photos.count;report.checkedAt=new Date(this.now()).toISOString();
   return {proof,evidence,summary:{...report,readyForPublication:true,publicationEnabled:false,blockers:[],message:'当前页面证据已核对；没有保存草稿或发布商品。'}};
  }catch(error){if(timedOut)throw problem('PUBLICATION_EVIDENCE_TIMEOUT','刊登页面读取超时，未保存草稿或发布');throw error;}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);contents?.removeListener?.('did-start-navigation',navigated);contents?.removeListener?.('destroyed',cancel);contents?.removeListener?.('render-process-gone',cancel);if(w?.vintedDraftController===controller)w.vintedDraftController=null;}
 }
 async prepare(input,options){return (await this.collect(input,options)).proof;}
 async inspect(input,options){
  const report={checks:[]};
  try{return (await this.collect(input,options,report)).summary;}
  catch(error){if(!report.checks.some(check=>!check.ok))report.checks.push({name:'页面证据',ok:false,detail:String(error.message||'读取失败').slice(0,700)});return {...report,checkedAt:new Date(this.now()).toISOString(),readyForPublication:false,publicationEnabled:false,blockers:report.checks.filter(check=>!check.ok).map(check=>check.detail),code:error.code||'PUBLICATION_EVIDENCE_FAILED',message:'发布前核对未通过；没有保存草稿或发布商品。'};}
 }
}

module.exports={VintedPublicationEvidence,rememberCategoryTraversal,probePublicationForm,FIELD_SPECS};
