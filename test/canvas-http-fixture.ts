import { vi } from "vitest";

/** Exercise the renderer HTTP client instead of replacing ESM bindings. */
export function installCanvasHttpFixture(
  handlers: Record<string, (...args: any[]) => any>,
): void {
  vi.stubGlobal("window", {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const path = input.replace(/^\/api/, "");
      const parts = path.split("/");
      const id = parts[2];
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      let result: unknown;
      try {
        if (path === "/health") result = { status: "ok" };
        else if (path === "/image-models")
          result = await handlers.listImageModels!();
        else if (path === "/video-models")
          result = await handlers.listVideoModels!();
        else if (path === "/projects" && init.method === "POST")
          result = await handlers.createProject!(body);
        else if (parts.length === 3 && init.method === "DELETE")
          result = await handlers.deleteProject!(id);
        else if (parts[4] === "workspace")
          result = await handlers.getCanvasWorkspace!(id);
        else if (parts[4] === "boards" && parts[6] === "nodes")
          result = await handlers.generateCanvasMedia!(id, parts[5], parts[7]);
        else if (parts[4] === "boards" && init.method === "PUT")
          result = await handlers.saveCanvasBoard!(id, body);
        else if (parts[4] === "boards")
          result = await handlers.getCanvasBoard!(id, parts[5]);
        else
          throw new Error(
            `Unexpected canvas request: ${init.method ?? "GET"} ${path}`,
          );
      } catch (error) {
        const failure = error as Error & { status?: number };
        return Response.json(
          { error: failure.message },
          { status: failure.status ?? 500 },
        );
      }
      return result === undefined
        ? new Response(null, { status: 204 })
        : Response.json(result);
    }),
  );
}
