import { useEffect, useRef } from "react";
import { waitForUpdateWrites } from "../update-writes";

type Participant = {
  dirty: () => boolean;
  pending: () => boolean;
  save: () => Promise<void>;
};
const participants = new Set<Participant>();

/** Only fixed, user-facing messages belong in this error. */
export class UpdateSaveError extends Error {}

export function useUpdateSave(
  dirty: boolean,
  save: () => Promise<void>,
  pending = false,
) {
  const current = useRef({ dirty, save, pending });
  current.current = { dirty, save, pending };
  useEffect(() => {
    const participant = {
      dirty: () => current.current.dirty,
      pending: () => current.current.pending,
      save: () => current.current.save(),
    };
    participants.add(participant);
    return () => {
      participants.delete(participant);
    };
  }, []);
}

export function useUpdatePending(pending: boolean) {
  useUpdateSave(false, async () => undefined, pending);
}

export function hasUpdateSaves() {
  return [...participants].some(
    (participant) => participant.dirty() || participant.pending(),
  );
}

export async function saveBeforeUpdate(signal?: AbortSignal) {
  await waitForUpdateWrites();
  // Let completed save handlers publish their latest React state first.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const started = Date.now();
  while ([...participants].some((participant) => participant.pending())) {
    signal?.throwIfAborted();
    if (Date.now() - started > 30_000)
      throw new UpdateSaveError(
        "A change is still being saved. Wait for it to finish, then try updating again.",
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const participant of [...participants]) {
    signal?.throwIfAborted();
    if (participants.has(participant) && participant.dirty()) {
      await participant.save();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  await waitForUpdateWrites();
  signal?.throwIfAborted();
}
