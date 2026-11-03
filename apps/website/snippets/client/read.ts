import { VolaClient } from "@vola/client";

// The examples instance's read-only key, the one its site hands to every visitor.
const baseUrl = "https://examples.stage.vol-a.com/vola";
const config = (await (await fetch(`${baseUrl}/examples/config`)).json()) as {
  api_key: string;
  instance_type: string;
  instance_id: string;
};
const vola = new VolaClient({ baseUrl, apiKey: config.api_key });

const { folder, files } = await vola.folders.list(
  config.instance_type,
  config.instance_id,
  "images",
);
console.log(`${folder?.path}: ${files.length} files`);

const file = files.find((f) => f.filename === "aurora.jpg");
if (!file) throw new Error("no aurora.jpg in the demo pack");
console.log(file.filename, file.size, file.mime_type);

// A Range read: a streaming Response with the 206's headers.
const part = await vola.files.download(config.instance_type, config.instance_id, file.id, {
  range: { start: 0, end: 1023 },
});
console.log(part.status, part.headers.get("content-range"));

// A thumbnail: 202 is not the image, so the client says which one you got.
const thumb = await vola.files.thumb(config.instance_type, config.instance_id, file.id, 256);
console.log(thumb.status, thumb.status === "ready" ? `${thumb.blob.size} bytes` : "try again");
