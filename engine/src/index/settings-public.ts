// Pages settings.json (§4 PublicSettings, D-04): tiers from code, limits, models, versions.
import { CATEGORIES, MAX_FILE_BYTES, PROVISIONAL_BLURB, STAGES, TIERS, type PublicSettings, type PublicStatus, type Settings, type Status } from '@resumearena/shared';

export function publicSettings(settings: Settings, status: Status): PublicSettings {
  return {
    tiers: [...TIERS],
    provisional_blurb: PROVISIONAL_BLURB,
    paused: settings.paused,
    pause_message: settings.pause_message,
    limits: { min_chars: settings.min_text_chars, max_chars: settings.max_text_chars, max_file_bytes: MAX_FILE_BYTES, max_submissions_per_hour: settings.max_submissions_per_hour },
    models: { ...settings.models },
    versions: { ...status.versions },
    categories: [...CATEGORIES],
    stages: [...STAGES],
  };
}

export const publicStatus = (status: Status, deployedAt: string, buildId: string): PublicStatus => ({ ...status, deployed_at: deployedAt, build_id: buildId });
