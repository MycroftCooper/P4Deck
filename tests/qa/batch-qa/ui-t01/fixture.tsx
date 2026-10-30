// @ts-nocheck
import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {ConnectionProfilesCard} from '../../../../src/features/settings/ConnectionProfilesCard';
import {BranchMappingsPage} from '../../../../src/features/browsers/components/BranchMappingsPage';
import {PendingPage} from '../../../../src/features/changelists/components/PendingPage';
import {CommandBar} from '../../../../src/app/shell/CommandBar';
import {AuditEnvironment} from '../command-stubs';
import {runtime,audit as settingsAudit} from './settings-stubs';
import {runtime as branchRuntime} from '../../preview-audit/branch-stubs';
import {audit as pendingAudit,t01Audit} from './pending-stubs';
import {messages} from '../../../../src/shared/i18n';
import '../../../app/styles/tokens.css';
import '../../../app/styles/workbench.css';
import '../../../app/styles/settings.css';
import '../../../app/styles/dialogs.css';
import '../../../app/styles/branch-mappings.css';
import '../../../app/styles/commands.css';
if('__TAURI_INTERNALS__'in window)throw Error('Native bridge forbidden');
const params=new URLSearchParams(location.search);document.documentElement.dataset.theme=params.get('theme')||'light';
Object.assign(window,{settingsAudit,pendingAudit,t01Audit});
function Toolbar(){const[ui,setUi]=useState({toolbarText:true});document.documentElement.dataset.toolbarText=String(ui.toolbarText);return <AuditEnvironment.Provider value={{preferences:{ui,setUi},openPage:()=>{}}}><CommandBar zh runtime={runtime} connectionKey="synthetic" target={{type:params.get('target')||'pending',id:10,count:1}} targetError="" onBusyChange={()=>{}} onOpenOperations={()=>{}} registerCommand={()=>{}} onNavigate={()=>{}} onFocus={()=>{}} onReview={()=>{}}/><button onClick={()=>setUi(v=>({toolbarText:!v.toolbarText}))}>测试切换文字</button></AuditEnvironment.Provider>;}
const page=params.get('page')||'settings';
createRoot(document.getElementById('root')!).render(page==='settings'?<main className="settings-page" style={{height:'100%'}}><ConnectionProfilesCard runtime={runtime} locale="en-US" onConnection={()=>{}} onRuntime={()=>{}}/></main>:page==='pending'?<PendingPage t={messages['en-US']} clientName="synthetic" connectionKey="t01" demo={false} ready/>:page==='branch'?<BranchMappingsPage runtime={branchRuntime} zh/>:<Toolbar/>);
