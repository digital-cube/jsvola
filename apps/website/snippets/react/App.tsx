import "@jsudc/react/styles.css";
import "@vol-a/react/styles.css";
import { VolaClient } from "@vol-a/client";
import { VolaFileBrowser, VolaPinGate, VolaProvider } from "@vol-a/react";

// The files of one ticket: folders, thumbnails, uploads, share links, kept live over a WebSocket.
// `/vola` is your own origin, proxied to vola; the key needs `files:read`, the actions their scopes.
export function TicketFiles({ apiKey, ticketId }: { apiKey: string; ticketId: string }) {
  const vola = new VolaClient({ baseUrl: "/vola", apiKey, userId: "user-42" });
  return (
    <VolaProvider client={vola} locale="en">
      <VolaPinGate>
        <VolaFileBrowser instanceType="tickets" instanceId={ticketId} />
      </VolaPinGate>
    </VolaProvider>
  );
}
