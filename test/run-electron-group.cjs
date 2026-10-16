'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const groups={workspace:["commerce-environment-workspace-ui-smoke","commerce-product-cards-ui-smoke","commerce-product-display-ui-smoke","product-image-normalizer-smoke","commerce-deletion-ui-smoke","commerce-plan-archive-ui-smoke","commerce-plan-archive-main-smoke","commerce-plan-resume-ui-smoke","commerce-environment-main-smoke","workspace-shell-smoke","environment-manager-ui-smoke","commerce-smoke","commerce-dashboard-smoke"],listing:['commerce-listing-setup-smoke','commerce-manual-start-ui-smoke','commerce-supplier-photo-reuse-ui-smoke','commerce-supplier-photo-reuse-main-smoke','commerce-manual-main-smoke','vinted-sales-flow-smoke'],accounts:['commerce-accounts-ui-smoke','commerce-account-actions-ui-smoke','vinted-login-smoke','vinted-account-continuity-smoke','vinted-mobile-account-review-smoke','commerce-accounts-integration-smoke']};
const name=process.argv[2],modules=groups[name];if(!modules)throw Error('Choose workspace, listing or accounts');
const root=path.resolve(__dirname,'..'),artifacts=path.join(root,'test-artifacts'),report=path.join(artifacts,name+'-group-report.json');fs.mkdirSync(artifacts,{recursive:true});
(async()=>{const completed=[],checks=[];for(const module of modules){
 const child=spawn(require('electron'),[path.join(__dirname,'focused-electron.cjs'),'--modules='+module],{cwd:root,stdio:'inherit',windowsHide:true});
 const status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
 const result=JSON.parse(fs.readFileSync(path.join(artifacts,'focused-report.json'),'utf8'));fs.writeFileSync(path.join(artifacts,name+'-'+module+'-report.json'),JSON.stringify(result,null,2));
 checks.push(...(result.checks||[]).map(check=>({...check,module})));completed.push({module,ok:status===0&&result.ok===true,checks:(result.checks||[]).length});
 const ok=completed.every(row=>row.ok);fs.writeFileSync(report,JSON.stringify({ok:ok&&completed.length===modules.length,inProgress:ok&&completed.length<modules.length,scope:'Each module uses a fresh isolated Electron process and default sandbox',modules:completed,checks,...(!ok?{error:result.error||'Electron exited with '+status}:{})},null,2));
 if(!ok){process.exitCode=1;return;}
 }console.log('ALL '+name+' CHECKS PASS: '+checks.length);})().catch(error=>{console.error(error);process.exitCode=1;});
