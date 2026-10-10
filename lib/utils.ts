import { createCn } from "cn/config";

// The Nile theme's own scale names (app/globals.css). Without them the
// merger reads `text-sub` as a color and drops it next to `text-fg3`.
export const cn = createCn({
  extend: {
    theme: {
      text: ["th", "pill", "sub", "cell", "title", "card-title"],
      shadow: ["cta", "blue"],
    },
  },
});
