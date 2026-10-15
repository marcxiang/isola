const {randomUUID}=require('node:crypto');
const {problem}=require('./commerce-engine.cjs');

const LABELS=['Matériau (recommandé)','Matériau(recommandé)'];
const normalize=value=>String(value||'').replace(/\s+/g,' ').trim();
const isInvalid=value=>value!==false&&value!=='false'&&value!==null&&value!==undefined;
const isMaterial=element=>element?.tag==='input'&&(LABELS.includes(normalize(element.label))||normalize(element.placeholder)==='Sélectionne un matériau');
const FORM_FIELDS={title:['Titre','Dis aux acheteurs ce que tu vends'],description:['Description','Ajoute des informations utiles'],categoryPath:['Catégorie','Sélectionne une catégorie'],priceCents:['Prix','0,00 €'],condition:['État','Sélectionne un état'],brand:['Marque','Sélectionne une marque'],size:['Taille','Sélectionne une taille'],color:['Couleur','Sélectionne une couleur','Sélectionne 2 couleurs maximum']};
const fieldKey=element=>Object.keys(FORM_FIELDS).find(key=>FORM_FIELDS[key].includes(normalize(element?.label))||FORM_FIELDS[key].includes(normalize(element?.placeholder)));
const fail=message=>problem('OPTIONAL_MATERIAL_UNVERIFIED',message||'可选材质无法安全清空，已停止后续操作');

// This is a narrow, reversible operation authorized by the seller. It never
// grants ownership of an existing form and never writes an input or React state.
async function clearOptionalMaterial(adapter,profileId,{signal}={}) {
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
    if(Object.hasOwn(ownership.fields,'parcel')){
      const parcel=await adapter.parcelOptions(profileId,context);current();
      if(parcel.documentKey!==ownership.documentKey)throw problem('PAGE_CHANGED','商品页已重新加载，可选材质清理已停止');
      const selected=parcel.options?.filter(option=>option.checked===true||option.checked==='true');
      if(parcel.error||selected?.length!==1||selected[0].name!==ownership.fields.parcel)throw problem('EXISTING_DRAFT','包裹规格已改变，未清空可选材质');
    }
    let page=await adapter.read(profileId,context),state=await adapter.values(tab,page);current();
    if(state.documentKey!==ownership.documentKey)throw problem('PAGE_CHANGED','商品页已重新加载，可选材质清理已停止');
    const materials=page.elements.filter(isMaterial);
    if(materials.length>1)throw fail('页面出现多个可选材质控件，未猜测清理目标');
    for(const entry of state.values){
      const descriptor=page.elements.find(element=>element.id===entry.id),key=fieldKey(descriptor);
      if(isMaterial(descriptor))continue;
      if(entry.value!==''&&(!key||ownership.fields[key]!==entry.value)||key&&Object.hasOwn(ownership.fields,key)&&ownership.fields[key]!==entry.value)throw problem('EXISTING_DRAFT','商品内容已被其他操作修改，未清空可选材质');
    }
    for(const key of Object.keys(ownership.fields).filter(key=>key!=='parcel'))if(!state.values.some(entry=>fieldKey(page.elements.find(element=>element.id===entry.id))===key&&entry.value===ownership.fields[key]))throw problem('EXISTING_DRAFT','本次商品字段无法完整核对，未清空可选材质');
    if(!materials.length)return {verified:true,cleared:false,unchanged:true,published:false,saved:false};
    const material=materials[0],materialValue=state.values.find(entry=>entry.id===material.id)?.value;
    if(material.disabled||material.sensitive||material.required===true||material.required==='true'||isInvalid(material.invalid)||material.readOnly!==true||typeof materialValue!=='string')throw fail('材质控件不是已核对的可选选择器，未修改');
    if(materialValue==='')return {verified:true,cleared:false,unchanged:true,published:false,saved:false};
    const watched=state.values.filter(entry=>entry.id!==material.id);
    const created=await adapter.control.isolated(tab,`(() => {
      const d=globalThis.__isolaDOM,get=id=>globalThis.__isolaElements?.get(id),input=get(${JSON.stringify(material.id)}),watched=${JSON.stringify(watched)}.map(item=>({...item,node:get(item.id)}));
      if(!input?.isConnected||!d.visible(input)||input.tagName!=='INPUT'||!input.readOnly||d.disabled(input)||input.required||input.getAttribute('aria-required')==='true'||input.getAttribute('aria-invalid')!==null&&input.getAttribute('aria-invalid')!=='false'||String(input.value||'')!==${JSON.stringify(materialValue)}||d.closest(input,'header,nav,[role=navigation],[role=tablist]')||watched.some(item=>!item.node?.isConnected||String(item.node.value||'')!==item.value))return {error:true};
      const form=input.form||d.closest(input,'form'),scope=form&&watched.every(item=>form.contains(item.node))?form:d.parents(input).find(node=>!['BODY','HTML'].includes(node.tagName)&&watched.every(item=>node.contains(item.node)));
      if(!scope)return {error:true};
      const originalChoices=[...scope.querySelectorAll('input[type=checkbox],input[type=radio],[role=checkbox],[role=radio]')].map(node=>({node,checked:node.checked===true||node.getAttribute?.('aria-checked')==='true'}));
      globalThis.__isolaOptionalMaterial={token:${JSON.stringify(token)},documentKey:String(performance.timeOrigin),input,value:String(input.value||''),watched,originalChoices,scope:null,choice:null};
      return {documentKey:String(performance.timeOrigin)};
    })()`);current();
    if(created?.error||created?.documentKey!==ownership.documentKey)throw fail();
    installed=true;
    const perform=async(args,phase)=>{
      const actionOptions={...options,onProgress:async({stage}={})=>{
        current();
        const stable=await adapter.control.isolated(tab,`(() => {
          const guard=globalThis.__isolaOptionalMaterial,d=globalThis.__isolaDOM,checked=node=>node.checked===true||node.getAttribute?.('aria-checked')==='true';
          if(!guard||guard.token!==${JSON.stringify(token)}||String(performance.timeOrigin)!==guard.documentKey||!guard.input?.isConnected||guard.input.tagName!=='INPUT'||!guard.input.readOnly||d.disabled(guard.input)||guard.input.required||guard.input.getAttribute('aria-required')==='true'||guard.input.getAttribute('aria-invalid')!==null&&guard.input.getAttribute('aria-invalid')!=='false'||guard.watched.some(item=>!item.node?.isConnected||String(item.node.value||'')!==item.value)||guard.originalChoices.some(item=>!item.node?.isConnected||checked(item.node)!==item.checked)||![guard.value,''].includes(String(guard.input.value||'')))return false;
          if(${JSON.stringify(stage)}==='verifying')return true;
          if(String(guard.input.value||'')!==guard.value)return false;
          if(${JSON.stringify(phase)}==='uncheck')return !!guard.scope?.isConnected&&guard.choice?.isConnected&&checked(guard.choice)&&guard.mirrors.every(node=>node?.isConnected&&checked(node));
          if(${JSON.stringify(phase)}==='commit')return !!guard.scope?.isConnected&&guard.choice?.isConnected&&!checked(guard.choice)&&guard.mirrors.every(node=>node?.isConnected&&!checked(node));
          return true;
        })()`);current();
        if(!stable){const error=fail('操作前商品字段或材质选项已改变，已停止');controller.abort(error);throw error;}
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
        if(!guard||guard.token!==${JSON.stringify(token)}||guard.documentKey!==result.documentKey)return {...result,error:true};
        const input=guard.input,allowed=node=>!!node?.isConnected&&d.visible(node)&&!d.closest(node,'header,nav,[role=navigation],[role=tablist]'),checked=node=>node.checked===true||node.getAttribute?.('aria-checked')==='true';
        if(!input?.isConnected||input.tagName!=='INPUT'||!input.readOnly||d.disabled(input)||input.required||input.getAttribute('aria-required')==='true'||input.getAttribute('aria-invalid')!==null&&input.getAttribute('aria-invalid')!=='false'||guard.watched.some(item=>!item.node?.isConnected||String(item.node.value||'')!==item.value)||guard.originalChoices.some(item=>!item.node?.isConnected||checked(item.node)!==item.checked))return {...result,error:true};
        if(!(phase==='closed'?[guard.value,'']:[guard.value]).includes(String(input.value||'')))return {...result,error:true};
        const boxes=${JSON.stringify(checkboxes.map(element=>element.id))}.map(id=>({id,node:get(id)})).filter(item=>allowed(item.node)),buttons=${JSON.stringify(buttons.map(element=>element.id))}.map(id=>({id,node:get(id)})).filter(item=>allowed(item.node));
        const headings=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading],span,p,div')].filter(node=>allowed(node)&&labels.includes(normalize(d.safeText(node,180)))&&!node.querySelectorAll('input,textarea,select,button,[role=button],[role=checkbox],[role=radio]').length);
        const leaves=headings.filter(node=>!headings.some(other=>node!==other&&node.contains(other))),scopes=[];
        for(const title of leaves){const scope=d.parents(title).find(node=>!['BODY','HTML','MAIN','FORM'].includes(node.tagName)&&!node.contains(input)&&guard.watched.every(item=>!node.contains(item.node))&&boxes.some(item=>node.contains(item.node))&&buttons.some(item=>node.contains(item.node)));if(scope&&!scopes.includes(scope))scopes.push(scope);}
        if(phase==='closed')return {...result,open:String(input.value||'')!==''||!!guard.scope?.isConnected&&d.visible(guard.scope)&&([...guard.scope.querySelectorAll('input,textarea,select,button,[role=button],[role=checkbox]')].some(allowed)||!!d.safeText(guard.scope,180).trim())||scopes.length>0};
        if(scopes.length!==1)return phase==='selected'&&!guard.scope?{...result,ready:false}:{...result,error:true};
        if(guard.scope&&guard.scope!==scopes[0])return {...result,error:true};
        const scope=scopes[0],inside=boxes.filter(item=>scope.contains(item.node)),selected=inside.filter(item=>checked(item.node)),done=buttons.filter(item=>scope.contains(item.node));
        if(!inside.length||done.length!==1||inside.some(item=>!((item.node.tagName==='INPUT'&&item.node.type==='checkbox')||item.node.getAttribute?.('role')==='checkbox'))||[...scope.querySelectorAll('input,textarea,select,[role=radio]')].some(node=>allowed(node)&&!inside.some(item=>item.node===node)))return {...result,error:true};
        const button=done[0].node;if(button.tagName!=='BUTTON'||button.getAttribute('href')||button.form&&button.type==='submit'||normalize(d.label(button))!=='Fait')return {...result,error:true};
        const groupTitle=(node,label)=>normalize(d.label(node))===label||Array.from(node.children||[]).some(child=>d.visible(child)&&!child.querySelectorAll('input,textarea,select,button,[role=button],[role=checkbox],[role=radio]').length&&normalize(d.safeText(child,180))===label);
        const groupFor=(node,label)=>d.parents(node).find(parent=>parent!==scope&&scope.contains(parent)&&!['INPUT','LABEL'].includes(parent.tagName)&&groupTitle(parent,label));
        const groups=[...new Set(inside.map(item=>groupFor(item.node,'Toutes')).filter(Boolean))],suggestions=[...new Set(inside.map(item=>groupFor(item.node,'Suggestions')).filter(Boolean))];
        if(groups.length!==1||suggestions.length>1||inside.some(item=>!groups[0].contains(item.node)&&!suggestions[0]?.contains(item.node)))return {...result,error:true};
        const matches=inside.filter(item=>normalize(d.label(item.node))===normalize(guard.value)),canonical=matches.filter(item=>groups[0].contains(item.node)),mirrors=matches.filter(item=>suggestions[0]?.contains(item.node)&&!groups[0].contains(item.node));
        if(canonical.length!==1||mirrors.length>1||matches.length!==canonical.length+mirrors.length||selected.some(item=>!matches.includes(item)))return {...result,error:true};
        if(phase==='selected'){
          if(selected.length!==matches.length||!selected.includes(canonical[0])||d.disabled(canonical[0].node))return {...result,error:true};
          guard.scope=scope;guard.choice=canonical[0].node;guard.mirrors=mirrors.map(item=>item.node);guard.allGroup=groups[0];guard.suggestionGroup=suggestions[0]||null;
          return {...result,choiceId:canonical[0].id,ready:true};
        }
        if(!guard.choice?.isConnected||canonical[0].node!==guard.choice||groups[0]!==guard.allGroup||(suggestions[0]||null)!==guard.suggestionGroup||mirrors.length!==guard.mirrors.length||mirrors.some((item,index)=>item.node!==guard.mirrors[index]))return {...result,error:true};
        return {...result,buttonId:done[0].id,ready:selected.length===0&&!d.disabled(button)};
      })()`);current();
      if(!result||result.documentKey!==ownership.documentKey)throw problem('PAGE_CHANGED','商品页已重新加载，可选材质清理已停止');
      if(result.error)throw fail('可选材质或其他商品字段已改变，未继续清理');
      return result;
    };
    let receipt=await perform({action:'click',elementId:material.id},'open');current();
    if(receipt.url!=='https://www.vinted.fr/items/new')throw fail();
    let result=await adapter.waitForMenu(profileId,context,()=>check('selected'),value=>value.ready===true);
    if(!result.ready||!result.choiceId)throw fail('未找到稳定且唯一的材质选择器，未取消任何选项');
    receipt=await perform({action:'click',elementId:result.choiceId},'uncheck');current();
    if(receipt.url!=='https://www.vinted.fr/items/new')throw fail();
    result=await adapter.waitForMenu(profileId,context,()=>check('empty'),value=>value.ready===true);
    if(!result.ready||!result.buttonId)throw fail('清空后的材质选择器无法确认，未点击其他控件');
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
