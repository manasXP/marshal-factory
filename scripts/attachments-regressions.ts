import "./test-guard";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { localizeLinearImages } = await import("../lib/sources/linear");

const PNG: Uint8Array<ArrayBuffer> = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const upload = (name: string) => `https://uploads.linear.app/org/${name}`;
type Answer = { status?: number; type?: string; body?: Uint8Array<ArrayBuffer> };

function fakeHost(answers: Record<string, Answer>) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchFake = (async (input: string, init: RequestInit) => {
    calls.push({ url: input, auth: new Headers(init.headers).get("authorization") });
    const answer = answers[input] ?? { status: 404 };
    return new Response(answer.body ?? PNG, { status: answer.status ?? 200, headers: { "content-type": answer.type ?? "image/png" } });
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchFake };
}

const dir = mkdtempSync(join(tmpdir(), "attachments-"));
try {
  {
    const host = fakeHost({});
    const text = "Fix the button. ![chart](https://example.com/chart.png)";
    assert.equal(await localizeLinearImages(text, { apiKey: "key", dir, fetch: host.fetch }), text, "text without Linear uploads is unchanged");
    assert.equal(host.calls.length, 0, "and nothing is fetched");
  }

  {
    const host = fakeHost({ [upload("a")]: { type: "image/png" }, [upload("b")]: { type: "image/jpeg; charset=binary" } });
    const text = [`Before: ![a.png](${upload("a")})`, `After: ![b.jpg](${upload("b")})`, `Again: ![a.png](${upload("a")})`, "Other: ![x](https://example.com/x.png)"].join("\n");
    const out = await localizeLinearImages(text, { apiKey: "linear-key", dir, fetch: host.fetch });
    assert.deepEqual(host.calls.map((c) => c.url).sort(), [upload("a"), upload("b")], "each upload is fetched once");
    assert.ok(host.calls.every((c) => c.auth === "linear-key"), "with the Linear key");
    const files = readdirSync(dir).sort();
    assert.equal(files.length, 2, "and saved");
    assert.deepEqual(files.map((f) => f.split(".")[1]).sort(), ["jpg", "png"], "with the extension of its content type");
    assert.deepEqual(new Uint8Array(readFileSync(join(dir, files.find((f) => f.endsWith(".png"))!))), PNG, "byte for byte");
    assert.ok(!out.includes("uploads.linear.app"), "the private links are gone from the text");
    assert.match(out, new RegExp(`Before: \\[image: ${join(dir, "[0-9a-f]{16}\\.png").replaceAll("/", "\\/")}\\]`), "each link points at its file");
    assert.ok(out.includes("Other: ![x](https://example.com/x.png)"), "an image on another host is left alone");
    assert.match(out, /## Images\n\nThis text refers to 2 images, saved on this machine\. Open each one with the Read tool before you start/, "and the agent is told to open them first");
    assert.equal(out.match(/^- \//gm)?.length, 2, "listing each file once");

    const again = fakeHost({});
    assert.equal(await localizeLinearImages(text, { apiKey: "linear-key", dir, fetch: again.fetch }), out, "a relaunch gives the same text");
    assert.equal(again.calls.length, 0, "from the files already on disk");
  }

  {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    const host = fakeHost({ [upload("gone")]: { status: 404 }, [upload("doc")]: { type: "application/pdf" }, [upload("big")]: { body: big } });
    const text = [upload("gone"), upload("doc"), upload("big")].map((u, i) => `![${i}](${u})`).join("\n");
    const out = await localizeLinearImages(text, { apiKey: "k", dir: join(dir, "failures"), fetch: host.fetch });
    assert.match(out, /!\[0\]\(https:\/\/uploads\.linear\.app\/org\/gone\) \(the factory could not download this image: Linear answered 404\)/, "a missing upload keeps its link with the reason");
    assert.match(out, /could not download this image: not a PNG, JPEG, WebP or GIF image/, "so does a file that is not an image");
    assert.match(out, /could not download this image: larger than 10 MB/, "and one over the size cap");
    assert.ok(!out.includes("## Images"), "with nothing saved, there is no image list");
  }

  {
    const names = Array.from({ length: 12 }, (_, i) => `many-${i}`);
    const host = fakeHost(Object.fromEntries(names.map((n) => [upload(n), {}])));
    await localizeLinearImages(names.map((n) => `![${n}](${upload(n)})`).join("\n"), { apiKey: "k", dir: join(dir, "many"), fetch: host.fetch });
    assert.equal(host.calls.length, 10, "at most 10 images are fetched for one message");
  }

  console.log("attachments regressions passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
