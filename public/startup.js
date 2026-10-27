// Keep recovery independent of React and its module graph.
(() => {
  const recovery = document.createElement("section");
  recovery.className = "startup-recovery";
  recovery.hidden = true;
  recovery.setAttribute("role", "alert");
  const title = document.createElement("strong");
  const detail = document.createElement("p");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "重新加载";
  retry.addEventListener("click", () => location.reload());
  recovery.append(title, detail, retry);
  document.body.append(recovery);

  let ready = false;
  function show(message, failed) {
    title.textContent = failed ? "P4Deck 启动失败" : "P4Deck 启动时间较长";
    detail.textContent = message;
    recovery.hidden = false;
  }
  function fail(error) {
    clearTimeout(timeout);
    show(
      error instanceof Error
        ? error.message
        : String(error || "前端模块加载失败，请重新加载。"),
      true,
    );
  }
  function onError(event) {
    if (ready) return;
    if (event instanceof ErrorEvent) fail(event.error || event.message);
    else if (event.target instanceof HTMLScriptElement)
      fail("前端脚本加载失败，请检查开发服务是否仍在运行，然后重新加载。");
  }
  function onRejection(event) {
    if (!ready) fail(event.reason);
  }
  const timeout = setTimeout(() => {
    show("界面尚未加载完成。请检查开发终端是否有报错，或重新加载重试。", false);
  }, 10000);
  window.addEventListener("error", onError, true);
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("p4deck:startup-error", (event) =>
    fail(event.detail),
  );
  // Observe successful mounting, including the development audit pages.
  const observer = new MutationObserver(() => {
    if (
      !document.querySelector("#root .startup-shell") &&
      document.querySelector("#root")?.childElementCount
    ) {
      ready = true;
      clearTimeout(timeout);
      recovery.hidden = true;
      observer.disconnect();
      window.removeEventListener("error", onError, true);
      window.removeEventListener("unhandledrejection", onRejection);
    }
  });
  observer.observe(document.getElementById("root"), {
    childList: true,
    subtree: true,
  });
})();
