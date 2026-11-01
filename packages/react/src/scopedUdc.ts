import type { ActionName, ActionRequest, ActionResponse, FilterNode } from "@jsudc/core";
import { type CallOptions, UdcClient } from "@jsudc/core/client";

/**
 * A `UdcClient` whose every `list` of `collection` is ANDed with `scope` — how the file
 * browser pins `<UdcDataView collection="files">` to one instance and one folder while the
 * data view keeps its own search, chips and filter tree on top.
 */
export class ScopedUdcClient extends UdcClient {
  private readonly inner: UdcClient;
  private readonly collection: string;
  private readonly scope: FilterNode;

  constructor(inner: UdcClient, collection: string, scope: FilterNode) {
    super({ httpUrl: inner.httpUrl });
    this.inner = inner;
    this.collection = collection;
    this.scope = scope;
  }

  override call<A extends ActionName>(
    action: A,
    payload: ActionRequest<A>,
    opts?: CallOptions,
  ): Promise<ActionResponse<A>> {
    if (action === "list") {
      const request = payload as ActionRequest<"list">;
      if (request.collection === this.collection) {
        const scoped: ActionRequest<"list"> = {
          ...request,
          filter: request.filter ? { and: [this.scope, request.filter] } : this.scope,
        };
        return this.inner.call(action, scoped as ActionRequest<A>, opts);
      }
    }
    return this.inner.call(action, payload, opts);
  }
}

/** `{instance_type eq, instance_id eq, folder_path eq}` as one `and`. */
export function filesScope(
  instanceType: string,
  instanceId: string,
  folderPath: string,
): FilterNode {
  return {
    and: [
      { field: "instance_type", op: "eq", value: instanceType },
      { field: "instance_id", op: "eq", value: instanceId },
      { field: "folder_path", op: "eq", value: folderPath },
    ],
  };
}
