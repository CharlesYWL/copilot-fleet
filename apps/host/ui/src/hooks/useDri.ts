import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DriAvailability,
  DriInvestigation,
  DriPage,
  DriProviderDefinition,
  DriRecord,
  DriRecordKind,
  DriWork,
  Run,
} from "@fleet/protocol";
import { api } from "./useFleet";

export type DriDetail = {
  investigation: DriInvestigation;
  providers: DriProviderDefinition[];
  work: DriWork[];
  run: Run;
  availability?: DriAvailability;
};
export function acceptDriRevision(
  previous: DriDetail | undefined,
  incoming: DriDetail,
): DriDetail {
  if (previous?.investigation.id !== incoming.investigation.id) return incoming;
  const before = previous.investigation,
    next = incoming.investigation;
  return (before.generation ?? 0) > (next.generation ?? 0) ||
    ((before.generation ?? 0) === (next.generation ?? 0) &&
      before.revision > next.revision)
    ? previous
    : incoming;
}
const isFenceConflict = (reason: unknown) =>
  typeof reason === "object" &&
  reason !== null &&
  "status" in reason &&
  reason.status === 412;
type PageRequest = {
  id: string;
  collection: string;
  cursor: number;
  revision?: number | undefined;
  generation?: number | undefined;
};

export function useDri(id: string, collection: DriRecordKind | "overview") {
  const [detail, setDetail] = useState<DriDetail>();
  const [loadedPage, setPage] = useState<{
    id: string;
    collection: string;
    cursor: number;
    data: DriPage<DriRecord>;
  }>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const ticket = useRef(0);
  const inFlight = useRef(false);
  const requested = useRef<PageRequest>({ id: "", collection: "", cursor: 0 });
  // A valid collection snapshot remains visible while a newer head is being collected.
  const page =
    loadedPage?.id === id && loadedPage.collection === collection
      ? loadedPage.data
      : undefined;
  const reload = useCallback(() => setRefresh((value) => value + 1), []);
  const first = useCallback(() => {
    requested.current = { id, collection, cursor: 0 };
    reload();
  }, [id, collection, reload]);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    const request = ++ticket.current;
    const coordinates =
      requested.current.id === id && requested.current.collection === collection
        ? requested.current
        : { id, collection, cursor: 0 };
    inFlight.current = true;
    setLoading(true);
    setError("");

    const fetchPage = async () => {
      if (collection === "overview") return undefined;
      let cursor = coordinates.cursor;
      // One fenced continuation and at most one unpinned restart; never chase a moving head.
      for (let attempt = 0; attempt < 2; attempt++) {
        const fence =
          cursor > 0
            ? `&revision=${coordinates.revision}&generation=${coordinates.generation}`
            : "";
        try {
          const data = await api<DriPage<DriRecord>>(
            `/api/dri/${encodeURIComponent(id)}/${collection}?limit=25&cursor=${cursor}${fence}`,
            { signal: controller.signal },
          );
          if (
            cursor > 0 &&
            (data.revision !== coordinates.revision ||
              data.generation !== coordinates.generation)
          ) {
            cursor = 0;
            continue;
          }
          return { id, collection, cursor, data };
        } catch (reason) {
          if (!isFenceConflict(reason)) throw reason;
          cursor = 0;
        }
      }
      return undefined;
    };

    void Promise.all([
      api<DriDetail>(`/api/dri/${encodeURIComponent(id)}`, { signal: controller.signal }),
      fetchPage(),
    ])
      .then(([next, records]) => {
        if (
          controller.signal.aborted ||
          request !== ticket.current ||
          next.investigation.id !== id
        )
          return;
        setDetail((previous) => acceptDriRevision(previous, next));
        if (records) {
          requested.current = {
            id,
            collection,
            cursor: records.cursor,
            revision: records.data.revision,
            generation: records.data.generation,
          };
          setPage(records);
        } else if (collection === "overview") setPage(undefined);
      })
      .catch((reason: unknown) => {
        if (
          controller.signal.aborted ||
          request !== ticket.current ||
          isFenceConflict(reason)
        )
          return;
        setError(
          reason instanceof Error ? reason.message : "Unable to load investigation",
        );
      })
      .finally(() => {
        if (request === ticket.current) {
          inFlight.current = false;
          if (!controller.signal.aborted) setLoading(false);
        }
      });
    return () => {
      controller.abort();
    };
  }, [id, collection, refresh]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshWhenIdle = () => {
      if (inFlight.current) {
        timer = setTimeout(refreshWhenIdle, 250);
        return;
      }
      timer = undefined;
      first();
    };
    const changed = (event: Event) => {
      if (
        (event as CustomEvent<{ investigationId: string }>).detail.investigationId !==
          id ||
        timer
      )
        return;
      timer = setTimeout(refreshWhenIdle, 250);
    };
    window.addEventListener("fleet:dri-changed", changed);
    return () => {
      window.removeEventListener("fleet:dri-changed", changed);
      clearTimeout(timer);
    };
  }, [id, first]);

  return {
    detail: detail?.investigation.id === id ? detail : undefined,
    page,
    error,
    loading,
    reload: first,
    first,
    next: () => {
      if (page?.nextCursor === null || page?.nextCursor === undefined || inFlight.current)
        return;
      requested.current = {
        id,
        collection,
        cursor: page.nextCursor,
        revision: page.revision,
        generation: page.generation,
      };
      reload();
    },
    atStart:
      !loadedPage ||
      loadedPage.id !== id ||
      loadedPage.collection !== collection ||
      loadedPage.cursor === 0,
  };
}
