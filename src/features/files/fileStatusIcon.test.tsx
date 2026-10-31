import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FileStatusIcon } from "./components/FileStatusIcon";
it("checkout badge is rendered with the success tone and delete/resolve with danger", () => {
  const edit = renderToStaticMarkup(
    <FileStatusIcon facts={{ state: "openedEdit" }} />,
  );
  expect(edit).toContain('data-badge="edit"');
  expect(edit).toContain('data-tone="success"');
  const del = renderToStaticMarkup(
    <FileStatusIcon facts={{ state: "openedDelete" }} />,
  );
  expect(del).toContain('data-tone="danger"');
  const resolve = renderToStaticMarkup(
    <FileStatusIcon facts={{ state: "conflicted" }} />,
  );
  expect(resolve).toContain('data-badge="resolve"');
  expect(resolve).toContain('data-tone="danger"');
  const lock = renderToStaticMarkup(
    <FileStatusIcon
      facts={{
        status: { primary: "controlled", lockOwnership: "ours" } as never,
      }}
    />,
  );
  expect(lock).toContain('data-tone="warning"');
});
