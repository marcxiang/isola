const {randomUUID}=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {problem}=require('./commerce-engine.cjs');

const LABELS=['Matériau (recommandé)','Matériau(recommandé)'];
const normalize=value=>String(value||'').replace(/\s+/g,' ').trim();
const isInvalid=value=>value!==false&&value!=='false'&&value!==null&&value!==undefined;
const isMaterial=element=>element?.tag==='input'&&(LABELS.includes(normalize(element.label))||normalize(element.placeholder)==='Sélectionne un matériau');
const FORM_FIELDS={title:['Titre','Dis aux acheteurs ce que tu vends'],description:['Description','Ajoute des informations utiles'],categoryPath:['Catégorie','Sélectionne une catégorie'],priceCents:['Prix','0,00 €'],condition:['État','Sélectionne un état'],brand:['Marque','Sélectionne une marque'],size:['Taille','Sélectionne une taille'],color:['Couleur','Sélectionne une couleur','Sélectionne 2 couleurs maximum']};
const fieldKey=element=>Object.keys(FORM_FIELDS).find(key=>FORM_FIELDS[key].includes(normalize(element?.label))||FORM_FIELDS[key].includes(normalize(element?.placeholder)));
const MATERIAL_REASONS=new Set(['picker_scope','picker_choices','picker_groups','picker_done','original_fields','material_input','material_input_disabled','material_input_changed','watched_disconnected','watched_value','original_choice_disconnected','original_choice_checked']);
const fail=(message,reason)=>{const error=problem('OPTIONAL_MATERIAL_UNVERIFIED',message||'可选材质无法安全清空，已停止后续操作');if(MATERIAL_REASONS.has(reason))error.materialReason=reason;return error;};
// Return only fixed diagnostic codes. Keep the same original-node, attribute,
// value and selection checks in every phase; never return page data or labels.
function originalFieldsReason(guard,d,allowedValues){
  const input=guard.input,checked=node=>node.checked===true||node.getAttribute?.('aria-checked')==='true';
  if(!input?.isConnected||input.tagName!=='INPUT'||!input.readOnly||input.required||input.getAttribute('aria-required')==='true'||input.getAttribute('aria-invalid')!==null&&input.getAttribute('aria-invalid')!=='false')return 'material_input';
  if(d.disabled(input))return 'material_input_disabled';
  if(guard.watched.some(item=>!item.node?.isConnected))return 'watched_disconnected';
  if(guard.watched.some(item=>String(item.node.value||'')!==item.value))return 'watched_value';
  if(guard.originalChoices.some(item=>!item.node?.isConnected))return 'original_choice_disconnected';
  if(guard.originalChoices.some(item=>checked(item.node)!==item.checked))return 'original_choice_checked';
  if(!allowedValues.includes(String(input.value||'')))return 'material_input_changed';
  return null;
}
const euroCents=value=>{
  if(typeof value!=='string'||/[\x00-\x1f\x7f]/.test(value))return null;
  const match=/^(\d{1,7})(?:[,.](\d{1,2}))?(?: ?€)?$/.exec(value.replace(/[\u00a0\u202f]/g,' ').trim());
  if(!match)return null;
  const cents=Number(match[1])*100+Number((match[2]||'').padEnd(2,'0'));
  return Number.isSafeInteger(cents)&&cents>0&&cents<=100000000?cents:null;
};
const sameOwnedValue=(key,value,owned)=>key==='priceCents'?euroCents(value)!==null&&euroCents(value)===euroCents(owned):value===owned;
const FIELD_NAMES={title:'标题',description:'描述',categoryPath:'分类',priceCents:'价格',condition:'成色',brand:'品牌',size:'尺码',color:'颜色'};
function changedField(key){const error=problem('EXISTING_DRAFT','商品'+(FIELD_NAMES[key]||'未识别字段')+'与本次准备记录不一致，未清空可选材质');error.materialReason=Object.hasOwn(FIELD_NAMES,key)?key:'unknown';return error;}

// This is a narrow, reversible operation authorized by the seller. It never
// grants ownership of an existing form and never writes an input or React state.
async function clearOptionalMaterial(adapter,profileId,{signal,settleEmptyMs=0}={}) {
  if(!Number.isSafeInteger(settleEmptyMs)||settleEmptyMs<0||settleEmptyMs>5000)throw fail('可选材质等待设置无效，未修改页面');
  const controller=new AbortController(),cancel=()=>controller.abort(),token=randomUUID();
  if(signal?.aborted)throw problem('STOPPED','页面准备已停止');
  signal?.addEventListener('abort',cancel,{once:true});
  let w,tab,contents,installed=false;
  const onChanged=(_event,_url,_isInPlace,isMainFrame)=>{if(isMainFrame!==false)controller.abort();};
  const onDestroyed=()=>controller.abort();
  const context={signal:controller.signal,controller,form:true};
  try {
    ({w,tab}=adapter.current(profileId,{signal}));
    if(w.vintedDraftController)throw problem('PAGE_BUSY','该窗口正在准备商品，请等待完成');
    const ownership=adapter.drafts.get(profileId);
    if(!ownership||ownership.tab!==tab)throw problem('EXISTING_DRAFT','可选材质只能在本次已准备的商品页中清空');
    w.vintedDraftController=controller;context.tab=tab;contents=tab.view.webContents;
    contents.on?.('did-start-navigation',onChanged);contents.on?.('render-process-gone',onDestroyed);contents.on?.('destroyed',onDestroyed);
    const current=()=>adapter.current(profileId,context),options=adapter.options(controller.signal,current);
    const checkParcel=async()=>{if(Object.hasOwn(ownership.fields,'parcel')){
      const parcel=await adapter.parcelOptions(profileId,context);current();
      if(parcel.documentKey!==ownership.documentKey)throw problem('PAGE_CHANGED','商品页已重新加载，可选材质清理已停止');
      const selected=parcel.options?.filter(option=>option.checked===true||option.checked==='true');
      if(parcel.error||selected?.length!==1||selected[0].name!==ownership.fields.parcel)throw problem('EXISTING_DRAFT','包裹规格已改变，未清空可选材质');
    }};
    await checkParcel();
    let page,state,material,materialValue;
    const readOwned=async()=>{
      current();page=await adapter.read(profileId,context);current();state=await adapter.values(tab,page);current();
      if(state.documentKey!==ownership.documentKey)throw problem('PAGE_CHANGED','商品页已重新加载，可选材质清理已停止');
      const materials=page.elements.filter(isMaterial);
      if(materials.length>1)throw fail('页面出现多个可选材质控件，未猜测清理目标');
      for(const entry of state.values){
        const descriptor=page.elements.find(element=>element.id===entry.id),key=fieldKey(descriptor);
        if(isMaterial(descriptor))continue;
        if(entry.value!==''&&(!key||!sameOwnedValue(key,entry.value,ownership.fields[key]))||key&&Object.hasOwn(ownership.fields,key)&&!sameOwnedValue(key,entry.value,ownership.fields[key]))throw changedField(key);
      }
      for(const key of Object.keys(ownership.fields).filter(key=>key!=='parcel'))if(!state.values.some(entry=>fieldKey(page.elements.find(element=>element.id===entry.id))===key&&sameOwnedValue(key,entry.value,ownership.fields[key])))throw changedField(key);
      material=materials[0];materialValue=material?state.values.find(entry=>entry.id===material.id)?.value:undefined;
      if(material&&(material.disabled||material.sensitive||material.required===true||material.required==='true'||isInvalid(material.invalid)||material.readOnly!==true||typeof materialValue!=='string'))throw fail('材质控件不是已核对的可选选择器，未修改');
    };
    await readOwned();
    if(!material)return {verified:true,cleared:false,unchanged:true,published:false,saved:false};
    if(materialValue===''&&settleEmptyMs){
      const until=performance.now()+settleEmptyMs;
      const pause=ms=>new Promise((resolve,reject)=>{
        let timer;const finish=(callback,value)=>{clearTimeout(timer);controller.signal.removeEventListener('abort',onAbort);callback(value);},onAbort=()=>finish(reject,problem('STOPPED','页面准备已停止'));
        if(controller.signal.aborted)return onAbort();
        controller.signal.addEventListener('abort',onAbort,{once:true});timer=setTimeout(()=>finish(resolve),ms);
      });
      do{
        await pause(Math.min(100,Math.max(0,until-performance.now())));current();await readOwned();
        if(!material)throw fail('等待建议期间材质控件已改变，未修改页面');
      }while(materialValue===''&&performance.now()<until);
      // A photo suggestion can arrive after the photo receipt. Recheck the
      // original parcel and all values before returning or installing guards.
      await checkParcel();await readOwned();
      if(!material)throw fail('等待建议期间材质控件已改变，未修改页面');
    }
    if(materialValue==='')return {verified:true,cleared:false,unchanged:true,published:false,saved:false};
    const watched=state.values.filter(entry=>entry.id!==material.id);
    const created=await adapter.control.isolated(tab,`(() => {
      const d=globalThis.__isolaDOM,get=id=>globalThis.__isolaElements?.get(id),input=get(${JSON.stringify(material.id)}),watched=${JSON.stringify(watched)}.map(item=>({...item,node:get(item.id)}));
      const reason=(${originalFieldsReason.toString()})({input,watched,originalChoices:[]},d,[${JSON.stringify(materialValue)}]);
      if(reason)return {error:true,reason};
      if(!d.visible(input)||d.closest(input,'header,nav,[role=navigation],[role=tablist]'))return {error:true,reason:'material_input'};
      const form=input.form||d.closest(input,'form'),scope=form&&watched.every(item=>form.contains(item.node))?form:d.parents(input).find(node=>!['BODY','HTML'].includes(node.tagName)&&watched.every(item=>node.contains(item.node)));
      if(!scope)return {error:true};
      const originalChoices=[...scope.querySelectorAll('input[type=checkbox],input[type=radio],[role=checkbox],[role=radio]')].map(node=>({node,checked:node.checked===true||node.getAttribute?.('aria-checked')==='true'}));
      globalThis.__isolaOptionalMaterial={token:${JSON.stringify(token)},documentKey:String(performance.timeOrigin),input,value:String(input.value||''),watched,originalChoices,scope:null,choice:null};
      return {documentKey:String(performance.timeOrigin)};
    })()`);current();
    if(created?.error||created?.documentKey!==ownership.documentKey)throw fail(undefined,created?.reason||'original_fields');
    installed=true;
    const perform=async(args,phase)=>{
      const actionOptions={...options,onProgress:async({stage}={})=>{
        current();
        const stable=await adapter.control.isolated(tab,`(() => {
          const guard=globalThis.__isolaOptionalMaterial,d=globalThis.__isolaDOM,checked=node=>node.checked===true||node.getAttribute?.('aria-checked')==='true';
          if(!guard||guard.token!==${JSON.stringify(token)}||String(performance.timeOrigin)!==guard.documentKey)return 'original_fields';
          const reason=(${originalFieldsReason.toString()})(guard,d,[guard.value,'']);if(reason)return reason;
          if(${JSON.stringify(stage)}==='verifying')return true;
          if(String(guard.input.value||'')!==guard.value)return 'material_input_changed';
          if(['uncheck','commit'].includes(${JSON.stringify(phase)})){
            const scope=guard.scope,normalize=value=>String(value||'').replace(/\\s+/g,' ').trim(),allowed=node=>!!node?.isConnected&&d.visible(node)&&!d.closest(node,'nav,[role=navigation],[role=tablist]');
            if(!scope?.isConnected||!d.visible(scope)||scope.contains(guard.input)||guard.watched.some(item=>scope.contains(item.node)))return 'picker_scope';
            const selected=${JSON.stringify(phase)}==='uncheck'?[guard.choice,...guard.mirrors]:[],controls=[...scope.querySelectorAll('input,textarea,select,[role=radio],[role=checkbox]')].filter(allowed);
            if(!Array.isArray(guard.optionNodes)||controls.length!==guard.optionNodes.length||controls.some(node=>!guard.optionNodes.includes(node)||!((node.tagName==='INPUT'&&node.type==='checkbox')||node.getAttribute?.('role')==='checkbox')||checked(node)!==selected.includes(node))||guard.optionNodes.some(node=>!allowed(node)||!scope.contains(node)))return 'picker_choices';
            if([guard.choice,...guard.mirrors].some(node=>normalize(d.label(node))!==normalize(guard.value)))return 'picker_choices';
            const groupTitle=(node,label)=>normalize(d.label(node))===label||Array.from(node?.children||[]).some(child=>d.visible(child)&&!child.querySelectorAll('input,textarea,select,button,[role=button],[role=checkbox],[role=radio]').length&&normalize(d.safeText(child,180))===label);
            if(!guard.allGroup?.isConnected||!scope.contains(guard.allGroup)||!guard.allGroup.contains(guard.choice)||!groupTitle(guard.allGroup,'Toutes')||guard.mirrors.length&&(!guard.suggestionGroup?.isConnected||!scope.contains(guard.suggestionGroup)||!groupTitle(guard.suggestionGroup,'Suggestions')||guard.mirrors.some(node=>!guard.suggestionGroup.contains(node))))return 'picker_groups';
            const done=[...scope.querySelectorAll('button,[role=button]')].filter(node=>allowed(node)&&normalize(d.label(node))==='Fait');
            if(done.length!==1||done[0]!==guard.doneButton||guard.doneButton.tagName!=='BUTTON'||guard.doneButton.getAttribute('href')||guard.doneButton.form&&guard.doneButton.type==='submit'||${JSON.stringify(phase)}==='commit'&&d.disabled(guard.doneButton))return 'picker_done';
            const headings=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading],span,p,div')].filter(node=>allowed(node)&&scope.contains(node)&&${JSON.stringify(LABELS)}.includes(normalize(d.safeText(node,180)))&&!node.querySelectorAll('input,textarea,select,button,[role=button],[role=checkbox],[role=radio]').length),leaves=headings.filter(node=>!headings.some(other=>node!==other&&node.contains(other)));
            if(leaves.length!==1||leaves[0]!==guard.titleNode)return 'picker_scope';
            return true;
          }
          return true;
        })()`);current();
        if(stable!==true){const error=fail('操作前商品字段或材质选项已改变，已停止',MATERIAL_REASONS.has(stable)?stable:'original_fields');controller.abort(error);throw error;}
      }};
      try{return await adapter.control.performAction(tab,args,actionOptions);}
      catch(error){if(controller.signal.reason?.code)throw controller.signal.reason;throw error;}
    };
    const check=async(phase)=>{
      page=await adapter.read(profileId,context);current();
      const checkboxes=page.elements.filter(element=>!element.sensitive&&(element.role==='checkbox'||element.tag==='input'&&element.type==='checkbox'));
      const buttons=page.elements.filter(element=>!element.sensitive&&(element.role==='button'||element.tag==='button')&&normalize(element.label)==='Fait');
      const result=await adapter.control.isolated(tab,`(() => {
        const guard=globalThis.__isolaOptionalMaterial,d=globalThis.__isolaDOM,get=id=>globalThis.__isolaElements?.get(id),normalize=value=>String(value||'').replace(/\\s+/g,' ').trim(),labels=${JSON.stringify(LABELS)},phase=${JSON.stringify(phase)};
        const result={documentKey:String(performance.timeOrigin)};
        if(!guard||guard.token!==${JSON.stringify(token)}||guard.documentKey!==result.documentKey)return {...result,error:true,reason:'original_fields'};
        const input=guard.input,allowed=node=>!!node?.isConnected&&d.visible(node)&&!d.closest(node,'nav,[role=navigation],[role=tablist]'),checked=node=>node.checked===true||node.getAttribute?.('aria-checked')==='true';
        const reason=(${originalFieldsReason.toString()})(guard,d,phase==='closed'?[guard.value,'']:[guard.value]);if(reason)return {...result,error:true,reason};
        const boxes=${JSON.stringify(checkboxes.map(element=>element.id))}.map(id=>({id,node:get(id)})).filter(item=>allowed(item.node)),registeredButtons=${JSON.stringify(buttons.map(element=>element.id))}.map(id=>({id,node:get(id)})).filter(item=>allowed(item.node));
        // A disabled Fait can be omitted by the general snapshot's bounded,
        // action-ranked list. Native BUTTON discovery may identify its picker;
        // it never supplies an action id or permits clicking a disabled button.
        const nativeButtons=[...document.querySelectorAll('button')].filter(node=>allowed(node)&&normalize(d.label(node))==='Fait');
        const headings=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading],span,p,div')].filter(node=>allowed(node)&&labels.includes(normalize(d.safeText(node,180)))&&!node.querySelectorAll('input,textarea,select,button,[role=button],[role=checkbox],[role=radio]').length);
        const leaves=headings.filter(node=>!headings.some(other=>node!==other&&node.contains(other))),scopes=[];
        const scopeTitles=new Map(),scopeTitleNodes=new Map();
        for(const title of leaves){const scope=d.parents(title).find(node=>!['BODY','HTML','MAIN','FORM'].includes(node.tagName)&&!node.contains(input)&&guard.watched.every(item=>!node.contains(item.node))&&boxes.some(item=>node.contains(item.node))&&nativeButtons.some(button=>node.contains(button)));if(scope){if(!scopes.includes(scope))scopes.push(scope);scopeTitles.set(scope,(scopeTitles.get(scope)||0)+1);scopeTitleNodes.set(scope,title);}}
        if(phase==='closed')return {...result,open:String(input.value||'')!==''||!!guard.scope?.isConnected&&d.visible(guard.scope)&&([...guard.scope.querySelectorAll('input,textarea,select,button,[role=button],[role=checkbox]')].some(allowed)||!!d.safeText(guard.scope,180).trim())||scopes.length>0};
        if(scopes.length!==1)return phase==='selected'&&!guard.scope&&scopes.length===0?{...result,ready:false,reason:'picker_scope'}:{...result,error:true,reason:'picker_scope'};
        if(scopeTitles.get(scopes[0])!==1||guard.scope&&guard.scope!==scopes[0])return {...result,error:true,reason:'picker_scope'};
        const scope=scopes[0],inside=boxes.filter(item=>scope.contains(item.node)),selected=inside.filter(item=>checked(item.node)),done=nativeButtons.filter(node=>scope.contains(node));
        if(!inside.length||inside.some(item=>!((item.node.tagName==='INPUT'&&item.node.type==='checkbox')||item.node.getAttribute?.('role')==='checkbox'))||[...scope.querySelectorAll('input,textarea,select,[role=radio],[role=checkbox]')].some(node=>allowed(node)&&!inside.some(item=>item.node===node)))return {...result,error:true,reason:'picker_choices'};
        if(done.length!==1)return {...result,error:true,reason:'picker_done'};
        const button=done[0];if(button.tagName!=='BUTTON'||button.getAttribute('href')||button.form&&button.type==='submit'||normalize(d.label(button))!=='Fait'||guard.doneButton&&guard.doneButton!==button)return {...result,error:true,reason:'picker_done'};
        const groupTitle=(node,label)=>normalize(d.label(node))===label||Array.from(node.children||[]).some(child=>d.visible(child)&&!child.querySelectorAll('input,textarea,select,button,[role=button],[role=checkbox],[role=radio]').length&&normalize(d.safeText(child,180))===label);
        const groupFor=(node,label)=>d.parents(node).find(parent=>parent!==scope&&scope.contains(parent)&&!['INPUT','LABEL'].includes(parent.tagName)&&groupTitle(parent,label));
        const groups=[...new Set(inside.map(item=>groupFor(item.node,'Toutes')).filter(Boolean))],suggestions=[...new Set(inside.map(item=>groupFor(item.node,'Suggestions')).filter(Boolean))];
        if(groups.length!==1||suggestions.length>1||inside.some(item=>!groups[0].contains(item.node)&&!suggestions[0]?.contains(item.node)))return {...result,error:true,reason:'picker_groups'};
        const matches=inside.filter(item=>normalize(d.label(item.node))===normalize(guard.value)),canonical=matches.filter(item=>groups[0].contains(item.node)),mirrors=matches.filter(item=>suggestions[0]?.contains(item.node)&&!groups[0].contains(item.node));
        if(canonical.length!==1||mirrors.length>1||matches.length!==canonical.length+mirrors.length||selected.some(item=>!matches.includes(item)))return {...result,error:true,reason:'picker_choices'};
        if(phase==='selected'){
          if(selected.length!==matches.length||!selected.includes(canonical[0])||d.disabled(canonical[0].node))return {...result,error:true,reason:'picker_choices'};
          guard.scope=scope;guard.choice=canonical[0].node;guard.mirrors=mirrors.map(item=>item.node);guard.allGroup=groups[0];guard.suggestionGroup=suggestions[0]||null;guard.doneButton=button;guard.optionNodes=inside.map(item=>item.node);guard.titleNode=scopeTitleNodes.get(scope);
          return {...result,choiceId:canonical[0].id,ready:true};
        }
        if(!guard.choice?.isConnected||canonical[0].node!==guard.choice||groups[0]!==guard.allGroup||(suggestions[0]||null)!==guard.suggestionGroup||mirrors.length!==guard.mirrors.length||mirrors.some((item,index)=>item.node!==guard.mirrors[index]))return {...result,error:true,reason:'picker_choices'};
        if(selected.length>0||d.disabled(button))return {...result,ready:false,reason:selected.length>0?'picker_choices':'picker_done'};
        const registered=registeredButtons.filter(item=>scope.contains(item.node));
        if(registered.length!==1||registered[0].node!==button)return {...result,error:true,reason:'picker_done'};
        return {...result,buttonId:registered[0].id,ready:true};
      })()`);current();
      if(!result||result.documentKey!==ownership.documentKey)throw problem('PAGE_CHANGED','商品页已重新加载，可选材质清理已停止');
      if(result.error)throw fail('可选材质或其他商品字段已改变，未继续清理',result.reason);
      return result;
    };
    let receipt=await perform({action:'click',elementId:material.id},'open');current();
    if(receipt.url!=='https://www.vinted.fr/items/new')throw fail();
    let result=await adapter.waitForMenu(profileId,context,()=>check('selected'),value=>value.ready===true);
    if(!result.ready||!result.choiceId)throw fail('未找到稳定且唯一的材质选择器，未取消任何选项','picker_scope');
    receipt=await perform({action:'click',elementId:result.choiceId},'uncheck');current();
    if(receipt.url!=='https://www.vinted.fr/items/new')throw fail();
    result=await adapter.waitForMenu(profileId,context,()=>check('empty'),value=>value.ready===true);
    if(!result.ready||!result.buttonId)throw fail('清空后的材质选择器无法确认，未点击其他控件',result.reason||'picker_done');
    receipt=await perform({action:'click',elementId:result.buttonId},'commit');current();
    if(receipt.url!=='https://www.vinted.fr/items/new')throw fail();
    result=await adapter.waitForMenu(profileId,context,()=>check('closed'),value=>value.open===false);
    if(result.open!==false)throw fail('材质选择器尚未关闭，未继续后续操作');
    return {verified:true,cleared:true,unchanged:false,published:false,saved:false};
  } finally {
    signal?.removeEventListener('abort',cancel);
    contents?.removeListener?.('did-start-navigation',onChanged);contents?.removeListener?.('render-process-gone',onDestroyed);contents?.removeListener?.('destroyed',onDestroyed);
    if(installed)try{await adapter.control.isolated(tab,`(() => {if(globalThis.__isolaOptionalMaterial?.token===${JSON.stringify(token)})delete globalThis.__isolaOptionalMaterial;})()`);}catch{}
    if(w?.vintedDraftController===controller)w.vintedDraftController=null;
  }
}

module.exports={clearOptionalMaterial};
