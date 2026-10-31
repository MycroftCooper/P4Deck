// @vitest-environment jsdom
import {act} from 'react';
import {it,expect,vi} from 'vitest';
import {dialogHarness} from '../../../src/app/dialogs/testHarness';
import {PendingPage} from '../../../src/features/changelists/components/PendingPage';
import {messages} from '../../../src/shared/i18n';
import {CommandExecutionContext} from '../preview-audit/pending-stubs';
const root=dialogHarness();
// WIP：PendingPage 重构后要求 MenuEnvironment 上下文与 pendingCache 后端替身，
// 本片尚未补齐（原 QA 夹具只注入了 CommandExecutionContext）。补齐后再恢复为 it。
// 现有覆盖：src/features/changelists/components/PendingPage.navigation.test.tsx 已用完整环境验证同一路径。
it.skip('numbered Pending submit preserves exact whole-CL target and Default stays disabled',async()=>{
 const run=vi.fn();
 await root.render(<CommandExecutionContext.Provider value={run}><PendingPage t={messages['en-US']} clientName="synthetic" connectionKey="qa" demo={false} ready/></CommandExecutionContext.Provider>);
 const button=document.querySelector<HTMLButtonElement>('[aria-label="Submit CL 10"]')!;
 expect(button.disabled).toBe(false);
 expect(run).not.toHaveBeenCalled();
 await act(async()=>button.click());
 expect(run).toHaveBeenCalledExactlyOnceWith('submit',{type:'pending',id:10,count:1},button);
 expect(document.querySelector<HTMLButtonElement>('[aria-label="Submit Default"]')!.disabled).toBe(true);
});
