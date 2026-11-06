// Runs in OhMyGame's extension host, a Node process for each project. Only
// the tools and commands the manifest declares can be registered.
export function activate(context) {
  context.registerTool("hello", async (input, options) => {
    options.progress("Saying hello…");
    return { text: `Hello, ${input.name ?? "there"}, from ${context.project?.folder ?? "OhMyGame"}` };
  });
  context.registerCommand("hello", async () => ({ text: `Hello from ${context.project?.folder ?? "OhMyGame"}` }));
}
