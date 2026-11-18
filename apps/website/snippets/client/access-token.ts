import { VolaClient } from "@vol-a/client";

declare const backendKey: string; // your server's API key, with the access:grant scope
declare const userId: string;
declare const messageId: string;
declare const fileId: string;

// On your backend: a token for the row this user may read, five minutes long.
const backend = new VolaClient({ baseUrl: "https://files.example.com/vola", apiKey: backendKey });
const { token } = await backend.accessTokens.create({ file_ids: [fileId], principal: userId });

// In the page: no key, only the token — and where to get the next one.
const vola = new VolaClient({
  baseUrl: "/vola",
  accessToken: token,
  getAccessToken: () => fetch("/api/vola-token").then((r) => r.text()),
});
const photo = await vola.files.download("mail", messageId, fileId);
console.log(photo.status, photo.headers.get("content-type"));
