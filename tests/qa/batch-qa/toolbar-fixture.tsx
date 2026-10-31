// @ts-nocheck
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CommandBar} from '../../../src/app/shell/CommandBar';
import {ActivityBar} from '../../../src/app/shell/ActivityBar';
import {TopBar} from '../../../src/app/shell/TopBar';
import {pageDefinitions} from '../../../src/app/panels';
import {AuditEnvironment} from './command-stubs';
import {runtime} from '../preview-audit/branch-stubs';
import '../../app/styles/tokens.css';
import '../../app/styles/workbench.css';
import '../../app/styles/commands.css';
import '../../app/styles/activity.css';
import '../../app/styles/workspace-switcher.css';
if('__TAURI_INTERNALS__' in window)throw Error('Native bridge forbidden');
function Fixture(){
 const [active,setActive]=useState('files');const [ui,setUi]=useState({toolbarText:true});
 document.documentElement.dataset.toolbarText=String(ui.toolbarText);
 const labels=Object.fromEntries(Object.entries(pageDefinitions).map(([k,v])=>[k,v.zh]));
 const openPage=p=>{window.qaNavigation=p;setActive(p);};
 return <AuditEnvironment.Provider value={{preferences:{ui,setUi},openPage}}><div className="app-shell" data-toolbar-text={ui.toolbarText?'true':'false'}>
 <TopBar runtime={runtime} zh onRuntime={()=>{}} onSettings={()=>openPage('settings')}/>
 <CommandBar zh runtime={runtime} connectionKey="synthetic" target={{type:'pending',id:10,count:1}} targetError="" onBusyChange={()=>{}} onOpenOperations={()=>{}} registerCommand={fn=>{window.qaCommand=fn;}} onNavigate={()=>{}} onFocus={()=>{}} onReview={()=>{}} navigationActions={<ActivityBar zh labels={labels} pages={['files','pending']} active={active} onOpenPage={openPage}/>}/>
 <main><button onClick={()=>setUi(v=>({toolbarText:!v.toolbarText}))}>测试切换文字</button><div data-page={active}>合成页面目标：{active}</div></main>
 </div></AuditEnvironment.Provider>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
