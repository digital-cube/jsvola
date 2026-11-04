import { VolaClient } from "@vol-a/client";
import { VolaFileBrowser, VolaProvider, VolaUploadButton } from "@vol-a/react";
import { useMemo } from "react";
import { fileAttached } from "./api.ts";
import { useSession } from "./session.ts";

/**
 * The files of one ticket: the instance `tickets/<id>` in vola. The browser talks to vola itself,
 * with `X-User-Id`. After an upload it tells the backend, which records TICKET_FILE_ATTACHED.
 * Sharing a file with somebody outside is the browser's Share action (`VolaShareDialog`).
 */
export function Files({ ticketId }: { ticketId: string }) {
  const { user, vola_key, locale } = useSession();
  const client = useMemo(
    () => new VolaClient({ baseUrl: "/vola", apiKey: vola_key, userId: user }),
    [vola_key, user],
  );

  return (
    // `key`: another user is another principal, so everything below starts over.
    <VolaProvider key={user} client={client} locale={locale} lockAfterMs={0}>
      <VolaUploadButton
        instanceType="tickets"
        instanceId={ticketId}
        onUploaded={({ fileId }) => {
          fileAttached(ticketId, user, fileId);
        }}
      />
      <VolaFileBrowser
        instanceType="tickets"
        instanceId={ticketId}
        upload={false}
        keyringStatus={false}
        columns={["thumb_url", "filename", "size", "created_at"]}
        actions={["download", "share", "delete"]}
      />
    </VolaProvider>
  );
}
