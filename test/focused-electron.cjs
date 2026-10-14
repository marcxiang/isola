'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
process.env.ISOLA_TEST_DATA=fs.mkdtempSync(path.join(os.tmpdir(),'isola-focused-'));
const {app}=require('electron');
// Hidden fixture windows should not wait for background timer throttling.
app.commandLine.appendSwitch('disable-background-timer-throttling');
const api=require('../src/main.cjs'),checks=[];
const report=path.join(__dirname,'../test-artifacts/focused-report.json');fs.mkdirSync(path.dirname(report),{recursive:true});
const modules=process.argv.find(arg=>arg.startsWith('--modules='))?.slice(10).split(',')||['commerce-smoke','commerce-association-ui-smoke','commerce-association-smoke','vinted-photo-smoke','vinted-form-smoke','vinted-account-smoke','vinted-publication-evidence-smoke','vinted-publish-submit-smoke','navigation-smoke'];
(async()=>{await api.ready;for(const name of modules){if(!/^[a-z0-9-]+$/.test(name))throw Error('Invalid smoke module');await require('./'+name+'.cjs')(api,async(name,work)=>{console.log('START '+name);const value=await work();checks.push({name,ok:true,value});fs.writeFileSync(report,JSON.stringify({ok:false,inProgress:true,checks},null,2));console.log('PASS '+name);});}fs.writeFileSync(report,JSON.stringify({ok:true,checks},null,2));app.exit(0);})().catch(error=>{console.error(error?.stack||String(error));fs.writeFileSync(report,JSON.stringify({ok:false,error:error?.stack||String(error),checks},null,2));app.exit(1);});
