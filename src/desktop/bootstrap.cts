import { app } from "electron";

void import("./main.js").catch((error) => {
  console.error(error);
  app.exit(1);
});
