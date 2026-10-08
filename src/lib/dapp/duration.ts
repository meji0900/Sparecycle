import { formatDuration } from "@/lib/format";

/** formatDuration without a trailing "0 min" ("6 h" instead of "6 h 0 min"). */
export const durationLabel = (seconds: number | null | undefined) => formatDuration(seconds).replace(/ 0 min$/, "");
