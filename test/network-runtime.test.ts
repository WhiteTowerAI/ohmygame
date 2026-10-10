import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("Node proxy transport", () => {
  it("routes HTTPS, SSE, model SDKs and WebSocket through a proxy while bypassing local IPv4/IPv6", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "ohmygame-proxy-runtime-"),
    );
    // Both ends use real Node: Bun's HTTP compatibility layer does not implement CONNECT.
    const proxy = spawn("node", ["test/fixtures/network/proxy.mjs"], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    try {
      const [ports] = (await once(proxy, "message", {
        signal: AbortSignal.timeout(5_000),
      })) as [{ ipv4: number; ipv6: number; proxy: number }];
      const proxyUrl = `http://127.0.0.1:${ports.proxy}`;
      const script = `
        import assert from 'node:assert/strict';
        import { once } from 'node:events';
        import OpenAI from 'openai';
        import Anthropic from '@anthropic-ai/sdk';
        import { GoogleGenAI } from '@google/genai';
        import { loadEnvironmentFiles } from './src/daemon/environment.ts';
        import { activateNetworkProxy, resolveNetworkProxy } from './src/daemon/proxy.ts';
        import { NetworkSettingsService } from './src/daemon/network-settings.ts';
        loadEnvironmentFiles(${JSON.stringify(directory)}, 'development');
        const service = new NetworkSettingsService(${JSON.stringify(directory)}, { environment: process.env });
        await service.load();
        assert.equal(service.get().active.source, 'environment');
        const dispatcher = activateNetworkProxy(service.get().active);
        assert.equal(await (await fetch('https://model-probe.invalid/fetch')).text(), 'ok');
        assert.equal(await (await fetch('http://127.0.0.1:${ports.ipv4}/local')).text(), 'ok');
        assert.equal(await (await fetch('http://[::1]:${ports.ipv6}/local')).text(), 'ok');
        const openai = new OpenAI({ apiKey: 'probe-only', baseURL: 'https://model-probe.invalid/openai', maxRetries: 0, timeout: 5000 });
        const stream = await openai.chat.completions.create({ model: 'probe', messages: [{ role: 'user', content: 'probe' }], stream: true });
        let text = ''; for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? ''; assert.equal(text, 'ok');
        const anthropic = new Anthropic({ apiKey: 'probe-only', baseURL: 'https://model-probe.invalid/anthropic', maxRetries: 0, timeout: 5000 });
        assert.equal((await anthropic.messages.create({ model: 'probe', max_tokens: 1, messages: [{ role: 'user', content: 'probe' }] })).content[0].text, 'ok');
        const gemini = new GoogleGenAI({ apiKey: 'probe-only', httpOptions: { baseUrl: 'https://model-probe.invalid/gemini', apiVersion: '', timeout: 5000 } });
        assert.equal((await gemini.models.generateContent({ model: 'probe', contents: 'probe' })).text, 'ok');
        const ws = new WebSocket('wss://model-probe.invalid/ws');
        await once(ws, 'open'); const closed = once(ws, 'close'); ws.close(); await closed;
        const diagnostic = await service.test({ mode: 'manual', proxyUrl: ${JSON.stringify(proxyUrl)}, noProxy: '' });
        assert.equal(diagnostic.reachable, true); assert.equal(diagnostic.statusCode, 401);
        assert.equal(service.get().active.source, 'environment');
        const allBypass = activateNetworkProxy(resolveNetworkProxy({ mode: 'manual', proxyUrl: ${JSON.stringify(proxyUrl)}, noProxy: '*' }, {}));
        // The reserved domain cannot resolve directly; an incorrect route would create a proxy tunnel.
        await assert.rejects(fetch('https://all-bypass.invalid/all-bypass', { signal: AbortSignal.timeout(2000) }));
        await allBypass.destroy();
        const direct = activateNetworkProxy({ source: 'direct', noProxy: '127.0.0.1,localhost,::1,[::1]' });
        assert.equal(process.env.HTTP_PROXY, undefined); assert.equal(process.env.https_proxy, undefined);
        assert.equal(await (await fetch('http://127.0.0.1:${ports.ipv4}/direct')).text(), 'ok');
        await dispatcher.destroy(); await direct.destroy();
        console.log('proxy-runtime-ok');
      `;
      await writeFile(
        path.join(directory, ".env.development.local"),
        `HTTP_PROXY=${proxyUrl}\nHTTPS_PROXY=${proxyUrl}\n`,
      );
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_EXTRA_CA_CERTS: path.resolve("test/fixtures/network/cert.pem"),
      };
      for (const key of [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
        "NODE_USE_ENV_PROXY",
      ])
        delete environment[key];
      const result = await run(
        "node",
        ["--import", "tsx", "--input-type=module", "--eval", script],
        { cwd: process.cwd(), env: environment, timeout: 20_000 },
      );
      expect(result.stdout).toContain("proxy-runtime-ok");
      const reportPromise = once(proxy, "message", {
        signal: AbortSignal.timeout(5_000),
      });
      proxy.send("report");
      const [report] = (await reportPromise) as [
        { tunnels: string[]; diagnosticAuthorized: boolean },
      ];
      expect(report.tunnels).toEqual(
        expect.arrayContaining([
          "model-probe.invalid:443",
          "api.openai.com:443",
        ]),
      );
      expect(
        report.tunnels.some(
          (target) =>
            target.startsWith("127.0.0.1") || target.startsWith("[::1]"),
        ),
      ).toBe(false);
      expect(report.tunnels).not.toContain("all-bypass.invalid:443");
      expect(report.diagnosticAuthorized).toBe(false);
    } finally {
      if (proxy.exitCode === null && proxy.signalCode === null) {
        const exited = once(proxy, "exit");
        proxy.kill();
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
