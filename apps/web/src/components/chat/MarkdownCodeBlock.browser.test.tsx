import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import "../../index.css";

import { ensureClientSettingsHydrated, persistClientSettingsPatch } from "../../hooks/useSettings";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";

const setWordWrap = (wordWrap: boolean) =>
  act(() => persistClientSettingsPatch({ wordWrap }, async () => {}));

it("follows a changed word wrap default while mounted", async () => {
  await ensureClientSettingsHydrated();
  await setWordWrap(false);
  await using screen = await render(
    <MarkdownCodeBlock
      code="a long line"
      language="text"
      fenceTitle={null}
      theme="light"
      isStreaming={false}
    >
      <pre>
        <code>a long line</code>
      </pre>
    </MarkdownCodeBlock>,
    { router: false }, // The code block reads no route state.
  );
  const block = () => screen.container.querySelector(".chat-markdown-codeblock");
  expect(block()?.getAttribute("data-wrap")).toBe("false");

  await setWordWrap(true);
  await expect.element(screen.getByRole("button", { name: "Disable line wrap" })).toBeVisible();
  expect(block()?.getAttribute("data-wrap")).toBe("true");
});

it("copies a fenced command without the fence's closing newline", async () => {
  await ensureClientSettingsHydrated();
  await using screen = await render(
    <MarkdownCodeBlock
      code={"sudo pacman -S patchelf\n"}
      language="bash"
      fenceTitle={null}
      theme="light"
      isStreaming={false}
    >
      <pre>
        <code>sudo pacman -S patchelf</code>
      </pre>
    </MarkdownCodeBlock>,
    { router: false }, // The code block reads no route state.
  );
  using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  await screen.getByRole("button", { name: "Copy code" }).click();
  await vi.waitFor(() => expect(write).toHaveBeenCalledWith("sudo pacman -S patchelf"));
});

it("repeats copy below a long block only while its header is scrolled away", async () => {
  await ensureClientSettingsHydrated();
  const lines = Array.from({ length: 50 }, (_, index) => `line ${index}`);
  await using screen = await render(
    <div data-testid="scroller" style={{ height: 200, overflow: "auto" }}>
      <MarkdownCodeBlock
        code={`${lines.join("\n")}\n`}
        language="text"
        fenceTitle={null}
        theme="light"
        isStreaming={false}
      >
        <pre>
          <code>{lines.join("\n")}</code>
        </pre>
      </MarkdownCodeBlock>
    </div>,
    { router: false }, // The code block reads no route state.
  );
  const copyButtons = screen.getByRole("button", { name: "Copy code" });
  await vi.waitFor(() => expect(copyButtons.elements()).toHaveLength(1));

  const scroller = screen.getByTestId("scroller").element();
  scroller.scrollTop = scroller.scrollHeight;
  await vi.waitFor(() => expect(copyButtons.elements()).toHaveLength(2));

  scroller.scrollTop = 0;
  await vi.waitFor(() => expect(copyButtons.elements()).toHaveLength(1));
});
