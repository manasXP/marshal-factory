import type { JobRow } from "../../db/schema";
import { github } from "./github";
import { linear } from "./linear";
import { isRegisteredSource, jobId, SOURCE_SHAPES, type SourceShape } from "./shapes";
import type { Job, JobSource, SourceAdapter } from "./types";

export { jobId } from "./shapes";

// The runner, the panel and the ingest function reach a source only through its adapter, by the
// job's `source`. Adding a source is an adapter and a shape here; nothing outside lib/sources changes.

export const SOURCES: { [S in JobSource]: SourceAdapter<S> } = { linear, github };

export const sourceFor = <S extends JobSource>(source: S): SourceAdapter<S> => {
  const adapter = SOURCES[source];
  if (!adapter) throw new Error(`no source adapter for ${source}`);
  return adapter;
};

export const isJobSource = (name: string): name is JobSource => Object.hasOwn(SOURCES, name);

/** Every registered source, for the work a runner does across them: claiming, stop checks, label sync. */
export const allSources = (): SourceAdapter<JobSource>[] => Object.values(SOURCES);

/** Where the panel uploads images for new jobs, and whose override label groups it syncs. */
const PANEL_SOURCE: JobSource = "linear";
export const panelSource = () => sourceFor(PANEL_SOURCE);

/** A source the panel files new jobs in; throws for one that cannot file. */
export function filingSource(source: JobSource) {
  const adapter = sourceFor(source);
  if (!adapter.file) throw new Error(`the ${source} source cannot file jobs`);
  return { ...adapter, file: adapter.file };
}

/**
 * Adds a source beside the shipped ones. Only regressions call it, with a fake source that proves
 * the runner needs nothing source-specific; a real source is added to SOURCES and SOURCE_SHAPES.
 */
export function registerSource(shape: SourceShape, adapter: Omit<SourceAdapter<JobSource>, "source"> & { source: string }) {
  if (isRegisteredSource(adapter.source)) throw new Error(`source ${adapter.source} is registered already`);
  Object.assign(SOURCE_SHAPES, { [adapter.source]: shape });
  Object.assign(SOURCES, { [adapter.source]: adapter });
}

export function parseJob(row: JobRow): Job {
  if (!isJobSource(row.source)) throw new Error(`jobs row ${row.id} has unknown source ${row.source}`);
  const shapes = SOURCE_SHAPES[row.source];
  const id = jobId(row.source, row.external_id);
  if (row.id !== id) throw new Error(`jobs row ${row.id} should have id ${id}`);
  return {
    ...row,
    id,
    writeback: shapes.writeback.parse(row.writeback),
    source_state: shapes.sourceState.parse(row.source_state),
  };
}

export const parseJobs = (rows: readonly JobRow[]) => rows.map(parseJob);
