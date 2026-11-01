import type { FilterNode, Row } from "@jsudc/core";
import type { Source } from "@jsudc/server";
import type { FileEventKind } from "@vola/core";

/**
 * Where a subscription's changes go: the row to put in place, or the id to take out. Both
 * are called synchronously from the source's dispatch, in the order the events arrived.
 */
export interface RowSink {
  upsert(row: Row, event: FileEventKind): void;
  remove(id: string, event: FileEventKind): void;
}

export interface Subscription {
  /** Ends the subscription; the sink is not called afterwards. Idempotent. */
  close(): Promise<void>;
}

/**
 * A source whose rows can be followed live. `@jsudc/server` 0.2 declares the
 * `capabilities.subscribe` flag but no transport for it; this is vola's: `subscribe` takes
 * the filter `list` would be called with (validated the same way) and pushes, through
 * `sink`, every row of the CURRENT tenant that starts or stops matching it — read from the
 * database at dispatch time, under the same masking as `list`. It must be called inside a
 * tenant context (`requireTenant()`), which it captures for the life of the subscription.
 */
export interface SubscribableSource extends Source {
  subscribe(filter: FilterNode | undefined, sink: RowSink): Promise<Subscription>;
}

/** `true` when `source` declares `capabilities.subscribe` and implements `subscribe`. */
export function isSubscribable(source: Source): source is SubscribableSource {
  return (
    source.capabilities.subscribe === true &&
    typeof (source as Partial<SubscribableSource>).subscribe === "function"
  );
}
