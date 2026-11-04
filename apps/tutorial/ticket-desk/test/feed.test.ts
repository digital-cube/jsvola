import { describe, expect, it } from "vitest";
import { ticketEvents } from "../src/web/feed.ts";

const created = {
  event_type: "TICKET_CREATED",
  instance_type: "tickets",
  instance_id: "t-1",
  payload: { title: "Printer on fire" },
};
const attached = {
  event_type: "TICKET_FILE_ATTACHED",
  instance_type: "tickets",
  instance_id: "t-1",
  payload: { file_id: "f-1", filename: "report.pdf" },
};
const otherTicket = { ...created, instance_id: "t-2" };
const otherAttached = { ...attached, instance_id: "t-2", payload: { file_id: "f-2" } };

describe("ticketEvents", () => {
  it("keeps the ticket's own events and leaves another ticket's out", () => {
    expect(ticketEvents([created, otherTicket], "t-1")).toEqual([created]);
  });

  it("keeps vola's event about a file in the ticket's instance", () => {
    const deleted = {
      event_type: "VOLA_FILE_DELETED",
      instance_type: "vola_file",
      instance_id: "f-1",
      payload: { file_id: "f-1", instance_type: "tickets", instance_id: "t-1" },
    };
    const elsewhere = {
      ...deleted,
      payload: { file_id: "f-2", instance_type: "tickets", instance_id: "t-2" },
    };
    expect(ticketEvents([deleted, elsewhere], "t-1")).toEqual([deleted]);
  });

  it("keeps vola's event about a share of a file attached to the ticket", () => {
    const shared = {
      event_type: "VOLA_SHARE_CREATED",
      instance_type: "vola_share",
      instance_id: "s-1",
      payload: { share_id: "s-1", file_id: "f-1" },
    };
    const sharedElsewhere = { ...shared, payload: { share_id: "s-2", file_id: "f-2" } };
    const events = [shared, sharedElsewhere, attached, otherAttached];
    expect(ticketEvents(events, "t-1")).toEqual([shared, attached]);
  });

  it("leaves out what has nothing to do with any ticket", () => {
    const key = {
      event_type: "VOLA_KEY_CREATED",
      instance_type: "vola_key",
      instance_id: "k-1",
      payload: { key_id: "k-1" },
    };
    expect(ticketEvents([key], "t-1")).toEqual([]);
  });
});
