import { Channel } from "mygo-runtime";
import { Storage, type Progress } from "./mygo";

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

async function refresh() {
  const conn = await Storage.current();
  $("#status").textContent = conn ? `Connected to ${conn.endpoint} / ${conn.bucket}` : "Not connected";
  if (!conn) return;
  const files = await Storage.list();
  $("#files").replaceChildren(
    ...files.map((f) => Object.assign(document.createElement("li"), { textContent: `${f.key} · ${f.size} bytes` })),
  );
}

$<HTMLFormElement>("#connect").addEventListener("submit", async (e) => {
  e.preventDefault();
  const formEl = e.currentTarget as HTMLFormElement;
  const form = new FormData(formEl);
  const field = (name: string) => String(form.get(name));
  await Storage.connect(field("endpoint"), field("bucket"), field("accessKey"), field("secretKey"));
  formEl.reset();
  await refresh();
});

$("#upload").addEventListener("click", async () => {
  const bar = $<HTMLProgressElement>("#bar");
  const progress = new Channel<Progress>();
  const done = Storage.pickAndUpload(progress);
  for await (const p of progress) {
    bar.max = p.total;
    bar.value = p.sent;
  }
  try {
    const r = await done;
    if (r) $("#result").textContent = `${r.key}: ${r.verified ? "Uploaded ✓" : "Verification failed"}`;
  } catch (err) {
    $("#result").textContent = String(err);
  }
  await refresh();
});

await refresh();
