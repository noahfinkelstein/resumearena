// manifest.json (§4, §10.2 step 6): written last so a half-built artifact never carries a new build_id.
import { PAGE_SIZE, STAGES, type Category, type Manifest } from '@resumearena/shared';

export const PARTITIONS = ['all', ...STAGES.map((s) => `stage-${s}`)] as const;

export function buildManifest(i: { buildId: string; builtAt: string; dataSha: string; commit: string; resumes: number; rated: Record<Category, number>; matches: number; users: number; pages: Record<Category, number> }): Manifest {
  return {
    schema: 1,
    build_id: i.buildId,
    built_at: i.builtAt,
    data_sha: i.dataSha,
    commit: i.commit,
    counts: { resumes: i.resumes, rated: i.rated, matches: i.matches, users: i.users },
    page_size: PAGE_SIZE,
    partitions: [...PARTITIONS],
    pages: i.pages,
  };
}
