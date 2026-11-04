import { UdcClient } from "@jsudc/core/client";
import {
  createRendererRegistry,
  createUdcQueryClient,
  UdcDataView,
  UdcI18nProvider,
  UdcProvider,
} from "@jsudc/react";
import { kanbanRenderer } from "@jsudc/react/kanban";
import { Toaster, TooltipProvider } from "@jsudc/react/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { type MouseEvent, useMemo } from "react";
import { useNavigate } from "react-router";
import { useSession } from "./session.ts";

const renderers = createRendererRegistry(kanbanRenderer);
const queryClient = createUdcQueryClient();

/** The feed calls this for every new event: whoever changed a ticket, the board catches up. */
export const refreshBoard = () => queryClient.invalidateQueries();

/**
 * The whole board is this one component of `@jsudc/react`: it asks the backend what the `tickets`
 * collection is (`collections/tickets/view.yaml`) and draws it. A drag writes through `udc/mutate`,
 * with `X-User-Id`, and the backend turns it into an event (src/server/drag.ts).
 */
export function Board() {
  const { user, locale } = useSession();
  const navigate = useNavigate();
  const client = useMemo(
    () => new UdcClient({ httpUrl: "", headers: { "X-User-Id": user } }),
    [user],
  );

  // A click on a card opens the ticket's page instead of the board's read-only dialog.
  const openCard = (event: MouseEvent) => {
    const card = (event.target as Element).closest("[data-card-id]");
    if (!card) return;
    event.stopPropagation();
    navigate(`/t/${card.getAttribute("data-card-id")}`);
  };

  return (
    <UdcProvider client={client} renderers={renderers}>
      <QueryClientProvider client={queryClient}>
        <UdcI18nProvider locale={locale}>
          <TooltipProvider>
            <Toaster>
              <div className="board" onClickCapture={openCard}>
                <UdcDataView collection="tickets" />
              </div>
            </Toaster>
          </TooltipProvider>
        </UdcI18nProvider>
      </QueryClientProvider>
    </UdcProvider>
  );
}
