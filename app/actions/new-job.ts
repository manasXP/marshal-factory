"use server";

import { auth } from "@/lib/auth/server";
import { createJob as create } from "@/lib/new-job";
import type { NewJob } from "@/lib/new-job-schema";
import { sourceFor } from "@/lib/sources";

export async function createJob(input: NewJob) {
  return create(
    {
      user: async () => (await auth.getSession()).data?.user,
      file: (draft) => sourceFor("linear").file!(draft),
    },
    input,
  );
}
