import { t } from "../../shared/i18n";
import { useState } from "react";
import { ExternalLink, Settings } from "lucide-react";
import { action, unavailable } from "../../app/context-menu/bindings";
import type { MenuAction } from "../../app/context-menu/model";
import type { RuntimeInfo } from "../../shared/contracts";
import {
  buildSwarmLink,
  openSwarmLink,
  type SwarmLinkTarget,
} from "./swarmLinks";

function settings() {
  window.dispatchEvent(new Event("p4deck:open-settings"));
}

export function swarmMenuAction(
  runtime: RuntimeInfo,
  _zh: boolean,
  target: SwarmLinkTarget,
): MenuAction {
  const link = buildSwarmLink(runtime.context.swarmBaseUrl, target);
  if (!link.enabled) {
    if (link.code === "notConfigured")
      return {
        ...action(settings),
        label: t("swarm.configure.swarm"),
      };
    return unavailable(link.reason);
  }
  return action(() => openSwarmLink(runtime, target));
}

export function SwarmAction({
  target,
  runtime,
  zh,
  className,
}: {
  target: SwarmLinkTarget;
  runtime: RuntimeInfo;
  zh: boolean;
  className?: string;
}) {
  const [error, setError] = useState("");
  const link = buildSwarmLink(runtime.context.swarmBaseUrl, target);
  const configure = !link.enabled && link.code === "notConfigured";
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={!link.enabled && !configure}
        title={link.enabled ? undefined : link.reason}
        onClick={() => {
          setError("");
          if (configure) {
            settings();
            return;
          }
          void openSwarmLink(runtime, target).catch(() =>
            setError(
              zh
                ? "未能安全打开 Swarm；连接可能已切换，请重试。"
                : "Swarm was not opened safely. The connection may have changed; retry.",
            ),
          );
        }}
      >
        {configure ? <Settings size={14} /> : <ExternalLink size={14} />}
        {configure
          ? zh
            ? "配置 Swarm"
            : "Configure Swarm"
          : zh
            ? "在 Swarm 中打开"
            : "Open in Swarm"}
      </button>
      {error ? (
        <span role="alert" className="swarm-open-error">
          {error}
        </span>
      ) : null}
    </>
  );
}
