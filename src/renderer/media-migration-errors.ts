import {
  MINIMAX_RETIRED_PROVIDER,
  MINIMAX_RETIRED_RETRY,
} from "../shared/media-migration-errors.js";
import { t } from "./i18n.js";

export function mediaMigrationError(message: string): string {
  if (message === MINIMAX_RETIRED_PROVIDER)
    return t("api.minimaxRetiredProvider");
  if (message === MINIMAX_RETIRED_RETRY) return t("api.minimaxRetiredRetry");
  return message;
}
