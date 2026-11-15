(async () => {
  const { acquireProfileOwnership } =
    await import("../../src/daemon/profile-ownership.ts");
  const { DatabaseSync } = await import("node:sqlite");
  const directories = process.argv.slice(2);
  let release;
  try {
    if (directories[0] === "--reader") {
      const database = new DatabaseSync(directories[1]);
      database.exec("BEGIN; SELECT * FROM sqlite_master");
      release = () => { if (database.isOpen) database.close(); };
    } else {
      const exec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function (sql) {
        if (sql === "BEGIN EXCLUSIVE") process.send({ status: "attempting" });
        return exec.call(this, sql);
      };
      release = acquireProfileOwnership(directories);
    }
    process.send({ status: "owned" });
  } catch (error) {
    process.send({ status: "rejected", message: error.message }, () =>
      process.exit(1),
    );
    return;
  }
  process.on("message", (message) => {
    if (message === "close") {
      release();
      release(); // Release is idempotent.
      process.exit(0);
    }
  });
})().catch((error) => {
  process.send?.({ status: "failed", message: error.message }, () =>
    process.exit(1),
  );
});
