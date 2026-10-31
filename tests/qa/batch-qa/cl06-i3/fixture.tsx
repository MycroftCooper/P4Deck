// @ts-nocheck
import {createRoot} from 'react-dom/client';
import {useRef,useState} from 'react';
import {ConnectionProfilesCard} from '../../../../src/features/settings/ConnectionProfilesCard';
import {PendingPage} from '../../../../src/features/changelists/components/PendingPage';
import {CommandBar} from '../../../../src/app/shell/CommandBar';
import {AuditEnvironment} from '../command-stubs';
import {runtime,audit as settingsAudit} from './settings-stubs';
import {CommandExecutionContext} from '../../preview-audit/pending-stubs';
import {messages} from '../../../../src/shared/i18n';
import '../../../app/styles/tokens.css';
import '../../../app/styles/workbench.css';
import '../../../app/styles/settings.css';
import '../../../app/styles/dialogs.css';
import '../../../app/styles/commands.css';
if('__TAURI_INTERNALS__'in window)throw Error('Native bridge forbidden');
const params=new URLSearchParams(location.search);document.documentElement.dataset.theme=params.get('theme')||'light';
window.settingsAudit=settingsAudit;
function Integrated(){const handler=useRef(()=>{}),[scope,setScope]=useState('fixture'),[ui,setUi]=useState({toolbarText:true});document.documentElement.dataset.toolbarText=String(ui.toolbarText);return <AuditEnvironment.Provider value={{preferences:{ui,setUi},openPage:()=>{}}}><CommandBar zh runtime={runtime} connectionKey={scope} target={{type:'pending',id:10,count:1}} targetError="" onBusyChange={()=>{}} onOpenOperations={()=>{}} registerCommand={h=>handler.current=h} onNavigate={()=>{}} onFocus={()=>{}} onReview={()=>{}}/><CommandExecutionContext.Provider value={(...args)=>handler.current(...args)}><PendingPage t={messages['en-US']} clientName="synthetic" connectionKey={scope} demo={false} ready/></CommandExecutionContext.Provider><button onClick={()=>setScope('switched')}>Synthetic switch</button></AuditEnvironment.Provider>;}
createRoot(document.getElementById('root')!).render(params.get('page')==='settings'?<main className="settings-page"><ConnectionProfilesCard runtime={runtime} locale="en-US" onConnection={()=>{}} onRuntime={()=>{}}/></main>:<Integrated/>);
