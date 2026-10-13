const ALIASES={return:'Enter',enter:'Enter',esc:'Escape',escape:'Escape',up:'ArrowUp',arrowup:'ArrowUp',down:'ArrowDown',arrowdown:'ArrowDown',left:'ArrowLeft',arrowleft:'ArrowLeft',right:'ArrowRight',arrowright:'ArrowRight',backspace:'Backspace',deletebackward:'Backspace',delete:'Delete',del:'Delete',deleteforward:'Delete',tab:'Tab',space:'Space',spacebar:'Space',home:'Home',end:'End',pageup:'PageUp',pgup:'PageUp',pagedown:'PageDown',pgdn:'PageDown'};
const CODES={Enter:13,Escape:27,ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39,Backspace:8,Delete:46,Tab:9,Space:32,Home:36,End:35,PageUp:33,PageDown:34};
function parseKeys(raw,platform=process.platform){
 if(Array.isArray(raw))raw=raw.join(',');if(raw==='\n'||raw==='\r')raw='Enter';if(raw==='\t')raw='Tab';if(raw===' ')raw='Space';
 if(typeof raw!=='string'||!raw.trim()||raw.length>200)throw Error('请提供按键，例如 Enter、ArrowDown、Esc、Ctrl+A 或 Shift+Tab');
 const sequence=raw.split(/[,;\n]|\s+then\s+|\s*→\s*/i).map(s=>s.trim()).filter(Boolean);if(sequence.length>8)throw Error('一次最多发送 8 个按键');
 return sequence.map(spec=>{
  let parts=spec.replace(/⌘/g,'Cmd+').replace(/⌃/g,'Ctrl+').replace(/⇧/g,'Shift+').replace(/⌥/g,'Alt+').split(/\s*\+\s*/).filter(Boolean);
  if(parts.length===1&&/^(ctrl|control|cmd|command|meta|shift|alt|option)\s+/i.test(parts[0]))parts=parts[0].split(/\s+/);
  const base=parts.pop().replace(/^[{<]|[}>]$/g,'');let key=ALIASES[base.toLowerCase().replace(/^(keyboard\.|key_)/,'').replace(/[_ -]/g,'')];
  if(!key&&/^(?:Key)?[A-Za-z]$/.test(base))key=base.replace(/^Key/,'').toLowerCase();
  if(!key&&/^(?:Digit)?[0-9]$/.test(base))key=base.replace(/^Digit/,'');
  if(!key)throw Error('不支持按键“'+base+'”。可用 Enter、Esc、方向键、Tab、Delete、Ctrl+A、Shift+Tab 等');
  const modifiers=new Set();for(const token of parts){const t=token.toLowerCase();if(['ctrl','control','primary','mod'].includes(t))modifiers.add(platform==='darwin'?'meta':'control');else if(['cmd','command','meta','super'].includes(t))modifiers.add('meta');else if(['alt','option'].includes(t))modifiers.add('alt');else if(t==='shift')modifiers.add('shift');else throw Error('未知组合键修饰符：'+token);}
  const primary=modifiers.has('meta')||modifiers.has('control');
  if(primary&&!['a','c','x','v','z','y','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Backspace','Delete','Home','End'].includes(key))throw Error('该系统快捷键不在页面编辑范围内');
  let command;if(primary&&['a','c','x','v','z','y'].includes(key))command=({a:'selectAll',c:'copy',x:'cut',v:'paste',z:modifiers.has('shift')?'redo':'undo',y:'redo'})[key];
  return {key,command,modifiers:[...modifiers],virtualKey:CODES[key]||key.toUpperCase().charCodeAt(0),code:key.length===1?(/[0-9]/.test(key)?'Digit'+key:'Key'+key.toUpperCase()):key==='Space'?'Space':key};
 });
}
async function dispatchKey(contents,spec){
 if(spec.command){contents[spec.command]();return;}
 const bits={alt:1,control:2,meta:4,shift:8};const modifiers=spec.modifiers.reduce((n,k)=>n|bits[k],0);
 const printable=!spec.modifiers.includes('meta')&&!spec.modifiers.includes('control')&&!spec.modifiers.includes('alt');
 const text=printable?(spec.key==='Enter'?'\r':spec.key==='Space'?' ':spec.key.length===1?(spec.modifiers.includes('shift')?spec.key.toUpperCase():spec.key):''):'';
 const params={key:spec.key==='Space'?' ':spec.key,code:spec.code,windowsVirtualKeyCode:spec.virtualKey,modifiers};contents.focus();
 await contents.debugger.sendCommand('Input.dispatchKeyEvent',{type:text?'keyDown':'rawKeyDown',...params,...(text?{text,unmodifiedText:text}:{})});
 await contents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',...params});
}
module.exports={parseKeys,dispatchKey};
