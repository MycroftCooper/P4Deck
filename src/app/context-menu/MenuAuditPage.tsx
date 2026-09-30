import { useState } from "react";
import { ContextMenuProvider, useContextMenu } from "./ContextMenu";
import { menuCatalog, type MenuObjectId } from "./catalog";
import { action } from "./bindings";

/** Development-only UI harness. No backend, filesystem or application mutations. */
export default function MenuAuditPage() {
  const [zh, setZh] = useState(true);
  const [dark, setDark] = useState(false);
  return (
    <ContextMenuProvider scope={`${zh}:${dark}`} zh={zh}>
      <main className="menu-audit" data-theme={dark ? "dark" : "light"}>
        <h1>右键菜单 UI 验收 / Context menu UI audit</h1>
        <p>
          仅开发环境。所有对象均为测试夹具；没有
          P4、磁盘、窗口修改操作。表格对应设计文档编号。
        </p>
        <button onClick={() => setZh(!zh)}>中文 / English</button>
        <button
          onClick={() => {
            const next = !dark;
            setDark(next);
            document.documentElement.dataset.theme = next ? "dark" : "light";
          }}
        >
          亮色 / 暗色
        </button>
        <AuditObjects />
      </main>
    </ContextMenuProvider>
  );
}
function AuditObjects() {
  const menu = useContextMenu();
  const [last, setLast] = useState("");
  const [bound, setBound] = useState(false);
  return (
    <>
      <label>
        <input
          type="checkbox"
          checked={bound}
          onChange={(event) => setBound(event.target.checked)}
        />
        测试执行分派（仅记录菜单项编号）
      </label>
      <output aria-label="最后执行的菜单项">{last || "未执行"}</output>
      <div className="menu-audit-grid">
        {(Object.keys(menuCatalog) as MenuObjectId[])
          .filter((object) => object !== "U07" && object !== "U08")
          .map((object) => (
            <button
              key={object}
              data-testid={`menu-audit-${object}`}
              {...menu(
                object,
                () =>
                  bound
                    ? Object.fromEntries(
                        menuCatalog[object].items.map((item) => [
                          item.id,
                          action(() => setLast(item.id)),
                        ]),
                      )
                    : {},
                { title: `${object} · ${menuCatalog[object].title}` },
              )}
            >
              <strong>{object}</strong>
              <span>{menuCatalog[object].title}</span>
              <small>{menuCatalog[object].items.length} items</small>
            </button>
          ))}
      </div>
      <input
        aria-label="原生文本菜单测试"
        placeholder="U07：原生输入右键，不应弹出业务菜单"
      />
      <div>U08：纯装饰区域不提供自定义菜单</div>
    </>
  );
}
