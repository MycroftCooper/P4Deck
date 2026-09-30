import { createContext, useContext } from "react";
import type { CommandTarget, CommandId } from "./commandPolicy";
export const CommandContext = createContext<(target: CommandTarget) => void>(
  () => undefined,
);
export const useCommandFocus = () => useContext(CommandContext);
export const CommandExecutionContext = createContext<
  (id: CommandId, target?: CommandTarget, source?: HTMLElement) => void
>(() => undefined);
