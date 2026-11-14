(async () => {
  const { acquireProfileOwnership } =
    await import("../../src/daemon/profile-ownership.ts");
  let release;
  try {
    release = acquireProfileOwnership(process.argv.slice(2));
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
