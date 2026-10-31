import { useState } from 'react';
import type { ConnectionProfiles, RuntimeInfo } from '../../../src/shared/contracts';
export const context = {server:'synthetic.invalid:1666',user:'fixture',client:'workspace'};
export const profiles = (active=false): ConnectionProfiles => ({schemaVersion:3,revision:1,activeProfileId:active?'a':undefined,profiles:active?[{id:'a',name:'Synthetic',context}]:[]});
export const runtime = (active=false, connected=false): RuntimeInfo => ({mode:'tauri',p4Version:'synthetic',activeProfileId:active?'a':undefined,contextGeneration:active?1:0,context,connection:{state:connected?'connected':'networkError',message:'Synthetic',recovery:'retry',server:context.server}});
export const audit = {stored: profiles(),calls:0,exits:0,cli:0,fail:false};
export const backend = {async listConnectionProfiles(){audit.calls++;await new Promise(r=>setTimeout(r,100));if(audit.fail){audit.fail=false;throw new Error('Synthetic profile load failure');}return audit.stored;}};
export const isTauri=()=>true; // Only renders exit controls; no native bridge is installed.
export const requestGuardedClose=async()=>{audit.exits++;return {accepted:false};};
export const AppControls=()=>null;
export function ConnectionProfilesCard({onRuntime}:{onRuntime(value:RuntimeInfo):void}) {
 const [input,setInput]=useState(''); const [failed,setFailed]=useState(false);
 return <section aria-label="Synthetic settings boundary"><label>合成连接名称<input value={input} onChange={e=>setInput(e.target.value)}/></label><button onClick={()=>audit.cli++}>获取 CLI（模拟）</button><button onClick={()=>{setFailed(true);audit.stored=profiles(true);onRuntime(runtime(true));}}>模拟验证失败</button><button onClick={()=>{audit.stored=profiles(true);onRuntime(runtime(true,true));}}>模拟验证成功</button>{failed&&<p role="alert">合成验证失败，请重试</p>}</section>;
}
