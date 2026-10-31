"use server";

import { db } from "@/db/client";
import { auth } from "@/lib/auth/server";
import { changeQueue as change, setPaused as pause, type QueueChange, type QueueDeps } from "@/lib/queue";
import { dequeue } from "@/lib/sources";

const deps: QueueDeps = { db, user: async () => (await auth.getSession()).data?.user, dequeue };

export async function setPaused(paused: boolean) {
  return pause(deps, paused);
}

export async function changeQueue(jobId: string, what: QueueChange) {
  return change(deps, jobId, what);
}
