import { beforeEach } from "vitest";
// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {act} from 'react';
import {it,expect,vi} from 'vitest';
import {dialogHarness} from '../../../src/app/dialogs/testHarness';
import {useCompanySubmitSnapshot} from '../../../src/features/companySubmit/useCompanySubmitSnapshot';
import {CompanySubmitPreview} from '../../../src/features/companySubmit/CompanySubmitPreview';
import {beginSimulation,applySimulation,requestBinding,type PlanRequest,type PlanResult,type ConnectionSnapshot} from '../../../src/features/companySubmit/model';
import { setLocale } from "../../../src/shared/i18n";
const root=dialogHarness();
const golden=JSON.parse(readFileSync('src-tauri/src/app/company_submit_golden_v1.json','utf8')) as {cases:{name:string;request:PlanRequest;expected:PlanResult}[]};
const snapshot:ConnectionSnapshot={profileId:'qa',generation:'18446744073709551615',server:'qa.invalid',user:'fixture',client:'synthetic'};
// The UI translates through the module-level locale.
beforeEach(() => {
  setLocale("en-US");
});

it('exact host identity survives hook, duplicate reads coalesce and obsolete scope cannot restore ready',async()=>{
 let resolve!:(s:ConnectionSnapshot)=>void;
 const read=vi.fn().mockResolvedValueOnce(snapshot).mockImplementationOnce(()=>new Promise<ConnectionSnapshot>(r=>resolve=r)).mockRejectedValueOnce(Error('new scope unavailable'));
 let observed:ReturnType<typeof useCompanySubmitSnapshot>|undefined;
 function Probe({scope}:{scope:string}){observed=useCompanySubmitSnapshot(scope,read);return <pre>{JSON.stringify(observed.state)}</pre>;}
 await root.render(<Probe scope="one"/>);
 expect(observed!.state.status).toBe('ready');
 expect(document.body.textContent).toContain('18446744073709551615');
 await act(async()=>{void observed!.refresh();void observed!.refresh();});expect(read).toHaveBeenCalledTimes(2);
 await root.render(<Probe scope="two"/>);expect(observed!.state.status).toBe('error');
 await act(async()=>resolve(snapshot));expect(observed!.state.status).toBe('error');expect(document.body.textContent).not.toContain('18446744073709551615');
});
for(const name of ['leading-zero','above-js-safe','u64-max','overflow','unc','empty-profile','old-generation','unknown-tool','missing-tool']){
 it('renders BE golden result without replanning: '+name,async()=>{
  const c=golden.cases.find(c=>c.name===name)!;expect(c).toBeDefined();
  await root.render(<CompanySubmitPreview request={c.request} requestId="qa" reply={{requestId:'qa',binding:requestBinding(c.request),result:c.expected}} zh={false}/>);
  const launch=document.querySelector<HTMLButtonElement>('button')!;expect(launch.disabled).toBe(true);
  if(c.expected.ok){expect([...document.querySelectorAll('[aria-label="argv"] li')].map(n=>n.textContent)).toEqual(c.expected.plan.argv);expect(c.expected.plan.realStartAllowed).toBe(false);}
  else{expect(document.querySelector('[role="alert"]')).not.toBeNull();expect(document.querySelector('[aria-label="argv"]')).toBeNull();}
 });
}
it('late plan is not rendered; duplicate and unknown simulation never unlock or announce success',async()=>{
 const c=golden.cases.find(c=>c.name==='plain')!;const s=beginSimulation(undefined,c.request,'first')!;
 expect(beginSimulation(s,c.request,'second')).toBe(s);
 const unknown=applySimulation(s,{requestId:'first',binding:requestBinding(c.request),state:{state:'outcomeUnknown',exitCode:0}});
 expect(beginSimulation(unknown,c.request,'third')).toBe(unknown);
 expect(applySimulation(unknown,{requestId:'first',binding:unknown.binding,state:{state:'running'}})).toBe(unknown);
 const changed={...c.request,connection:{...c.request.connection,generation:'9007199254740993'}};
 await root.render(<CompanySubmitPreview request={changed} requestId="new" reply={{requestId:'first',binding:s.binding,result:c.expected}} simulation={unknown} zh={false}/>);
 expect(document.querySelector('[aria-label="argv"]')).toBeNull();expect(document.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
 expect(document.body.textContent).toContain('switching connection does not unlock');expect(document.body.textContent).not.toContain('submission succeeded');
 await root.render(<CompanySubmitPreview request={c.request} requestId="first" simulation={unknown} zh={false}/>);
 expect(document.body.textContent).toContain('outcome unknown');
});
