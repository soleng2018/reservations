import "server-only";
import raw from "@/db/seed/portal-reset-starting-list.json";
import { StartingList } from "@/lib/portal-reset/starting-list";

// The starting list file, parsed once with the same step schema a Save uses.
// An invalid file throws, so the migrate process fails before the web
// container starts (spec 0022 AC-17). Imported as a module, so the migrate
// bundle carries it and the image needs no extra file.
const cache: { list?: StartingList } = {};

export const startingList = (): StartingList =>
  (cache.list ??= StartingList.parse(raw));
